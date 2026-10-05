/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 *
 * 落盘策略（定清楚“什么时候必须存”）：
 * - 连续录入的每一条都走 immediate 提交（不等防抖），但“已保存”提示以 IndexedDB
 *   事务 oncomplete 为准，不允许请求刚发出就报成功；
 * - 其它编辑（覆写、状态变更、删人）做 200ms 短合并，减少高频落盘；
 * - 下列时机必须立刻同步落盘：导出 / 打印前、批量导入完成后、路由切走前、
 *   页面隐藏（visibilitychange）或关闭 / 刷新（pagehide、beforeunload）前。
 * - 写失败（事务 abort / 配额满等）绝不提示成功：调用方按失败处理，
 *   内存里乐观加上的内容要回滚，保证“提示”与“刷新后读回”一致。
 * - 两个标签页同时改：提交带 rev 乐观锁，纯新增（连续录入）自动合并重试一次，
 *   其余冲突读回磁盘真相并报冲突；删除写墓碑，旧写不能复活已删项目。
 */
import { computed, reactive, toRaw } from 'vue'
import type { Project, ProjectKind, SizeRule } from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION, ruleByVersion } from './sizeRules'
import { runMerge } from './merge'
import {
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
  StorageConflictError,
  idbCommitDoc,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  type MetaEntry
} from './idb'
import { makeClientId, openSyncBus, type SyncBus, type SyncMessage } from './sync'

export type AppStore = {
  ready: boolean
  error: string
  projects: Project[]
  rules: SizeRule[]
  operator: string
}

export const store = reactive<AppStore>({
  ready: false,
  error: '',
  projects: [],
  rules: [...BUILTIN_RULES],
  operator: '现场录入员'
})

export const ruleVersions = computed(() => store.rules.map((rule) => rule.version))

/** 连续编辑的短合并时长；只有非 immediate 的编辑走这个窗口 */
const COALESCE_MS = 200

const clientId = makeClientId()
let bus: SyncBus | null = null

/** 各项目最近一次“磁盘真相”的 rev，提交时作为乐观锁期望值 */
const baseRev = new Map<string, number>()
/** 各项目最近一次磁盘真相里的人员 / 导入指纹，用于判断本地改动是否纯新增 */
const basePersonsFp = new Map<string, Map<string, string>>()
const baseImportsFp = new Map<string, Map<string, string>>()

type Waiter = { resolve: () => void; reject: (error: unknown) => void }

type Pending = {
  /** 有未落盘改动（含在途提交期间又发生的编辑） */
  dirty: boolean
  timer: number | null
  inFlight: boolean
  /** 在途提交期间又有编辑到达，本回合结束后要立刻开下一回合 */
  followup: boolean
  /** 下一个回合是否立即提交（否则走 200ms 合并） */
  nextImmediate: boolean
  waiters: Waiter[]
  dead: boolean
}

const pending = new Map<string, Pending>()

function getPending(id: string): Pending {
  let state = pending.get(id)
  if (!state) {
    state = { dirty: false, timer: null, inFlight: false, followup: false, nextImmediate: false, waiters: [], dead: false }
    pending.set(id, state)
  }
  return state
}

function rememberBase(project: Project): void {
  baseRev.set(project.id, project.rev ?? 0)
  const personFp = new Map<string, string>()
  for (const person of project.persons) personFp.set(person.id, fingerprint(person))
  const importFp = new Map<string, string>()
  for (const record of project.imports) importFp.set(record.fingerprint, fingerprint(record))
  basePersonsFp.set(project.id, personFp)
  baseImportsFp.set(project.id, importFp)
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

function sortRules(): void {
  store.rules.sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.version.localeCompare(b.version)
      : a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
}

function cloneDoc<T>(value: T): T {
  // 逐层解掉响应式代理再结构化克隆，避免把 Proxy 交给 IndexedDB
  return JSON.parse(JSON.stringify(toRaw(value))) as T
}

/** 用磁盘读到的文档整体替换内存中的项目（保持列表响应式） */
function replaceProjectInMemory(fresh: Project): void {
  const index = store.projects.findIndex((item) => item.id === fresh.id)
  if (index >= 0) store.projects[index] = fresh
  else store.projects.push(fresh)
  sortProjects()
}

async function initStoreData(): Promise<void> {
  const [projects, rules, meta] = await Promise.all([
    idbGetAll<Project>(STORE_PROJECTS),
    idbGetAll<SizeRule>(STORE_RULES),
    idbGetAll<MetaEntry>(STORE_META)
  ])
  store.projects = projects
  sortProjects()
  for (const project of projects) rememberBase(project)

  // 内置规则永远可用：IDB 里只存用户自定义版本，清空站点数据后内置规则仍在
  const builtinVersions = new Set(BUILTIN_RULES.map((rule) => rule.version))
  const customRules = rules.filter((rule) => !builtinVersions.has(rule.version))
  store.rules = [...BUILTIN_RULES, ...customRules]
  sortRules()

  const operator = meta.find((entry) => entry.key === 'operator')
  if (operator) store.operator = operator.value
}

export async function initStore(): Promise<void> {
  try {
    await initStoreData()
    bus = openSyncBus(handleSyncMessage, clientId)
    registerLifecycleFlush()
    store.ready = true
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    store.ready = true
  }
}

export function getProject(id: string | string[]): Project | undefined {
  const key = Array.isArray(id) ? id[0] : id
  return store.projects.find((project) => project.id === key)
}

export function getRule(version: string): SizeRule {
  return ruleByVersion(store.rules, version)
}

export function projectsUsingRule(version: string): Project[] {
  return store.projects.filter((project) => project.ruleVersion === version)
}

export function isRuleInUse(version: string): boolean {
  return projectsUsingRule(version).length > 0
}

export function makeProjectId(): string {
  return `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export async function createProject(input: {
  name: string
  kind: ProjectKind
  batches: string[]
  ruleVersion: string
}): Promise<Project> {
  const now = Date.now()
  const project: Project = {
    id: makeProjectId(),
    name: input.name.trim(),
    kind: input.kind,
    ruleVersion: input.ruleVersion || DEFAULT_RULE_VERSION,
    batches: input.batches.length > 0 ? input.batches : [],
    persons: [],
    imports: [],
    createdAt: now,
    updatedAt: now,
    rev: 0
  }
  store.projects.unshift(project)
  try {
    // 新文档期望 rev 为 0；失败（如配额满）必须把乐观插入的项目撤掉
    const rev = await idbCommitDoc<Project>(STORE_PROJECTS, cloneDoc(project), project.id, 0)
    project.rev = rev
    rememberBase(project)
    bus?.post({ kind: 'project-committed', id: project.id, rev, clientId })
    return project
  } catch (error) {
    store.projects = store.projects.filter((item) => item.id !== project.id)
    throw error
  }
}

/**
 * 归并前的准备：按项目锁定版本执行归并（幂等），并记录本次耗时。
 * 结果始终来自项目锁定的规则版本，规则改版不会改变既有项目结果。
 */
export function ensureMerged(project: Project): number {
  const rule = getRule(project.ruleVersion)
  const result = runMerge(project, rule)
  project.perf = { ...(project.perf ?? {}), mergeMs: result.durationMs, mergeCount: project.persons.length }
  return result.durationMs
}

function enqueueWaiter(state: Pending): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    state.waiters.push({ resolve, reject })
  })
}

function settleWaiters(state: Pending, error?: unknown): void {
  const waiters = state.waiters.splice(0)
  for (const waiter of waiters) {
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}

/**
 * 保存项目。
 * @param immediate true = 不等 200ms 合并，立即开写（连续录入每条都用它）；
 *                  提示成功前必须 await 返回的 Promise。
 */
export function persistProject(project: Project, immediate = false): Promise<void> {
  project.updatedAt = Date.now()
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()

  const state = getPending(project.id)
  if (state.dead) return Promise.resolve()
  const promise = enqueueWaiter(state)

  if (state.inFlight) {
    // 本回合快照已取，编辑进下一回合；任一调用方要求立即，下一回合就立即
    state.dirty = true
    state.followup = true
    state.nextImmediate = state.nextImmediate || immediate
    return promise
  }

  state.dirty = true
  if (state.timer !== null) {
    window.clearTimeout(state.timer)
    state.timer = null
  }
  if (immediate) {
    void runFlush(project.id)
  } else {
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runFlush(project.id)
    }, COALESCE_MS)
  }
  return promise
}

/** 立即落盘（导出、离开页面、导入完成前调用），保证离线数据完整 */
export async function flushProject(project: Project): Promise<void> {
  const state = getPending(project.id)
  if (state.dead) return
  // 强制视为有改动：ensureMerged 等可能绕过 persist 直接改过文档（如导出前重算号型），
  // 此时也要把当前内存状态立刻落盘
  state.dirty = true
  const promise = enqueueWaiter(state)
  if (state.timer !== null) {
    window.clearTimeout(state.timer)
    state.timer = null
    void runFlush(project.id)
  } else if (state.inFlight) {
    // 等本回合结束后立即补一个回合，不拖到防抖窗口
    state.followup = true
    state.nextImmediate = true
  } else {
    void runFlush(project.id)
  }
  await promise
}

/** 页面隐藏 / 关闭 / 切路由前调用：把所有挂起的改动立即提交 */
export function flushAllDirty(): Promise<void> {
  const tasks: Promise<void>[] = []
  for (const [id, state] of pending) {
    if (state.dead) continue
    if (!state.dirty && !state.inFlight && state.timer === null) continue
    tasks.push(enqueueWaiter(state))
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
      state.timer = null
      void runFlush(id)
    } else if (state.inFlight) {
      state.followup = true
      state.nextImmediate = true
    } else {
      void runFlush(id)
    }
  }
  return Promise.allSettled(tasks).then(() => undefined)
}

/**
 * 执行一次落盘。冲突处理：
 * - 纯新增（典型：两个标签页各自连续录入）→ 以磁盘为底追加本地新行，自动重试一次；
 * - 含修改 / 删除的冲突 → 内存回滚到磁盘真相，reject，由界面提示而不是假装成功。
 */
async function runFlush(id: string): Promise<void> {
  const state = getPending(id)
  if (state.inFlight || state.dead) return
  const local = store.projects.find((item) => item.id === id)
  if (!local || !state.dirty) {
    afterRound(id, state)
    return
  }
  state.inFlight = true
  state.dirty = false

  const snapshot = cloneDoc(local)
  const expected = baseRev.get(id) ?? 0
  try {
    const rev = await idbCommitDoc<Project>(STORE_PROJECTS, snapshot, id, expected)
    local.rev = rev
    rememberBase(local)
    bus?.post({ kind: 'project-committed', id, rev, clientId })
    afterRound(id, state)
  } catch (error) {
    if (error instanceof StorageConflictError) {
      await resolveConflict(id, state, snapshot).then(
        () => afterRound(id, state),
        (finalError) => {
          state.inFlight = false
          settleWaiters(state, finalError)
          if (state.dead) pending.delete(id)
          else scheduleFollowup(id, state)
        }
      )
      return
    }
    // 事务 abort / 配额满：磁盘没有这笔写，恢复脏状态并稍后自动重试，
    // 本回合调用方收到 reject，不能提示保存成功；导出 / 关页前还会再强制落盘。
    state.inFlight = false
    state.dirty = true
    settleWaiters(state, error)
    scheduleFollowup(id, state)
  }
}

function afterRound(id: string, state: Pending): void {
  state.inFlight = false
  settleWaiters(state)
  if (state.dead) {
    pending.delete(id)
    return
  }
  scheduleFollowup(id, state)
}

function scheduleFollowup(id: string, state: Pending): void {
  if (!state.followup && !state.dirty && state.timer !== null) return
  if (!state.followup && !state.dirty) return
  const immediate = state.followup && state.nextImmediate
  state.followup = false
  state.nextImmediate = false
  if (!state.dirty) return
  if (immediate) {
    void runFlush(id)
  } else if (state.timer === null) {
    state.timer = window.setTimeout(() => {
      state.timer = null
      void runFlush(id)
    }, COALESCE_MS)
  }
}

/** 冲突合并：纯新增自动重试；非纯新增回滚内存到磁盘并抛冲突 */
async function resolveConflict(id: string, state: Pending, localSnapshot: Project): Promise<void> {
  const fresh = await idbGet<Project>(STORE_PROJECTS, id)
  if (!fresh) {
    // 已在其它标签页被删除（墓碑 / 文档不存在）：内存对齐为“已删除”
    state.dead = true
    store.projects = store.projects.filter((item) => item.id !== id)
    baseRev.delete(id)
    basePersonsFp.delete(id)
    baseImportsFp.delete(id)
    bus?.post({ kind: 'project-deleted', id, clientId })
    throw new StorageConflictError('该项目已在另一个标签页中被删除，本页已同步移除')
  }

  const basePersonFp = basePersonsFp.get(id) ?? new Map<string, string>()
  const baseImportFp = baseImportsFp.get(id) ?? new Map<string, string>()

  const addedPersons = localSnapshot.persons.filter((person) => !basePersonFp.has(person.id))
  const removedPersons = [...basePersonFp.keys()].filter(
    (personId) => !localSnapshot.persons.some((person) => person.id === personId)
  )
  const modifiedPersons = localSnapshot.persons.filter((person) => {
    const base = basePersonFp.get(person.id)
    return base !== undefined && base !== fingerprint(person)
  })
  const addedImports = localSnapshot.imports.filter((record) => !baseImportFp.has(record.fingerprint))
  const removedImports = [...baseImportFp.keys()].filter(
    (fingerprintValue) => !localSnapshot.imports.some((record) => record.fingerprint === fingerprintValue)
  )

  const additiveOnly =
    removedPersons.length === 0 && modifiedPersons.length === 0 && removedImports.length === 0

  if (!additiveOnly) {
    // 不是纯新增：不能拿本页的旧底本覆盖另一页的修改，读回磁盘真相
    replaceProjectInMemory(fresh)
    rememberBase(fresh)
    state.dirty = false
    state.followup = false
    state.nextImmediate = false
    throw new StorageConflictError('该项目刚在另一个标签页被修改，本页已刷新为最新内容，请在最新内容上重试本次操作')
  }

  // 纯新增（两个标签页都在连续录入）：以磁盘为底，把本页新增的人员 / 导入追加进去。
  // 元数据（名称、类型、批次）以磁盘为准，避免把另一页刚做的非人员修改悄悄改回去。
  const merged: Project = {
    ...fresh,
    persons: [...fresh.persons],
    imports: [...fresh.imports],
    perf: localSnapshot.perf ?? fresh.perf,
    updatedAt: Math.max(fresh.updatedAt, localSnapshot.updatedAt)
  }
  for (const person of addedPersons) {
    if (!merged.persons.some((item) => item.id === person.id)) merged.persons.push(person)
  }
  for (const record of addedImports) {
    if (!merged.imports.some((item) => item.fingerprint === record.fingerprint)) merged.imports.push(record)
  }
  merged.perf = { ...(merged.perf ?? {}), mergeCount: merged.persons.length }
  const mergedClone = cloneDoc(merged)
  const rev = await idbCommitDoc<Project>(STORE_PROJECTS, mergedClone, id, fresh.rev ?? 0)
  replaceProjectInMemory(merged)
  merged.rev = rev
  rememberBase(merged)
  bus?.post({ kind: 'project-committed', id, rev, clientId })
}

export async function deleteProject(id: string): Promise<void> {
  const state = pending.get(id)
  if (state) {
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
    state.dirty = false
    state.followup = false
    // 先等在途提交结束再写删除，否则排队顺序可能让旧写晚于删除落盘
    if (state.inFlight) {
      await new Promise<void>((resolve) => {
        state.waiters.push({
          resolve,
          reject: () => resolve() // 上一笔落盘失败也继续走删除
        })
      })
    }
    state.dead = true
    settleWaiters(state)
    pending.delete(id)
  }
  // 墓碑写入失败就不更新内存、不提示删除成功，刷新后仍能看到该项目
  await idbDelete(STORE_PROJECTS, id)
  store.projects = store.projects.filter((project) => project.id !== id)
  baseRev.delete(id)
  basePersonsFp.delete(id)
  baseImportsFp.delete(id)
  bus?.post({ kind: 'project-deleted', id, clientId })
}

export async function saveRule(rule: SizeRule): Promise<void> {
  if (BUILTIN_RULES.some((builtin) => builtin.version === rule.version)) {
    throw new Error('内置规则版本不可覆盖，请另存为新版本')
  }
  const existing = store.rules.find((item) => item.version === rule.version)
  const expected = existing?.rev ?? 0
  const rev = await idbCommitDoc<SizeRule>(STORE_RULES, cloneDoc(rule), rule.version, expected)
  const saved = { ...rule, rev }
  const index = store.rules.findIndex((item) => item.version === rule.version)
  if (index >= 0) store.rules[index] = saved
  else store.rules.push(saved)
  sortRules()
  bus?.post({ kind: 'rule-committed', version: rule.version, rev, clientId })
}

export async function deleteRule(version: string): Promise<void> {
  if (BUILTIN_RULES.some((builtin) => builtin.version === version)) {
    throw new Error('内置规则版本不可删除')
  }
  await idbDelete(STORE_RULES, version)
  store.rules = store.rules.filter((rule) => rule.version !== version)
  bus?.post({ kind: 'rule-deleted', version, clientId })
}

export async function setOperator(name: string): Promise<void> {
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
  store.operator = name
  bus?.post({ kind: 'operator-changed', value: name, clientId })
}

/* ------------------------------ 跨标签页对齐 ------------------------------ */

async function reloadProjectFromDisk(id: string): Promise<void> {
  const fresh = await idbGet<Project>(STORE_PROJECTS, id)
  if (!fresh) {
    store.projects = store.projects.filter((item) => item.id !== id)
    return
  }
  replaceProjectInMemory(fresh)
  rememberBase(fresh)
}

async function reloadRuleFromDisk(version: string): Promise<void> {
  const fresh = await idbGet<SizeRule>(STORE_RULES, version)
  if (!fresh) {
    store.rules = store.rules.filter((rule) => rule.version !== version || BUILTIN_RULES.some((b) => b.version === version))
    return
  }
  const index = store.rules.findIndex((item) => item.version === version)
  if (index >= 0) store.rules[index] = fresh
  else store.rules.push(fresh)
  sortRules()
}

function handleSyncMessage(message: SyncMessage): void {
  switch (message.kind) {
    case 'project-committed': {
      const state = pending.get(message.id)
      // 本页有未落盘的改动时不覆盖：提交时的乐观锁 / 合并会负责收敛
      if (state && (state.dirty || state.inFlight || state.followup)) return
      void reloadProjectFromDisk(message.id).catch(() => undefined)
      break
    }
    case 'project-deleted': {
      const state = pending.get(message.id)
      if (state) {
        if (state.timer !== null) window.clearTimeout(state.timer)
        state.dead = true
        pending.delete(message.id)
      }
      store.projects = store.projects.filter((item) => item.id !== message.id)
      break
    }
    case 'rule-committed':
      void reloadRuleFromDisk(message.version).catch(() => undefined)
      break
    case 'rule-deleted':
      store.rules = store.rules.filter(
        (rule) => rule.version !== message.version || BUILTIN_RULES.some((builtin) => builtin.version === rule.version)
      )
      break
    case 'operator-changed':
      // 正在编辑操作人输入框时不抢焦点内容
      if (document.activeElement?.tagName !== 'INPUT') store.operator = message.value
      break
  }
}

/* --------------------------- 页面隐藏 / 关闭前强存 --------------------------- */

let lifecycleRegistered = false

function registerLifecycleFlush(): void {
  if (lifecycleRegistered || typeof window === 'undefined') return
  lifecycleRegistered = true
  // visibilitychange 是移动端 / 桌面端切后台最可靠的时机，此时事件回调仍可异步执行
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAllDirty()
  })
  // 桌面浏览器关闭 / 刷新
  window.addEventListener('pagehide', () => {
    void flushAllDirty()
  })
  window.addEventListener('beforeunload', () => {
    void flushAllDirty()
  })
}
