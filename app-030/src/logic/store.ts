/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 *
 * 落盘策略（定错就会丢最后几条）：
 * - 每条录入先更新内存，再按项目合并防抖（200ms）落盘，连续录入不会每条都开事务；
 * - 导出、导入完成、翻页离开、页面隐藏（pagehide / visibilitychange）前必须立即落盘；
 * - 界面上的“已保存”只在 IDB 事务 oncomplete 后才允许提示，失败必须如实报错。
 *
 * 多标签页：
 * - 项目按 rev 做 compare-and-swap，过期提交不会整包覆盖另一标签页的写入，
 *   而是按 Person.rev 行级合并（人员增删改互不丢失），项目字段 last-writer-wins；
 * - 删除写墓碑（projects + meta 同一事务），旧标签页的迟到写入带墓碑过滤，删了不会复活；
 * - BroadcastChannel 广播变更，其它标签页即时拉取合并。
 */
import { computed, reactive, toRaw } from 'vue'
import type {
  Person,
  PersonTombstone,
  Project,
  ProjectKind,
  ProjectTombstone,
  SizeRule
} from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION } from './sizeRules'
import { runMerge } from './merge'
import {
  META_PERSON_TOMBSTONES,
  META_PROJECT_TOMBSTONES,
  RevisionConflictError,
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
  idbDelete,
  idbDeleteProjectWithTombstones,
  idbGet,
  idbGetAll,
  idbGetMetaJson,
  idbPut,
  idbPutProjectCas,
  type MetaEntry
} from './idb'

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

/** 连续录入时的合并落盘延时：再短的停顿也会被“立即落盘点”提前冲掉 */
const PERSIST_DEBOUNCE_MS = 200
/** 墓碑保留时长：足够覆盖任何标签页的迟到防抖写入（约 7 天），到期自动清理 */
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CHANNEL_NAME = 'app030-uniform-tally-sync'

type ChangeNotice =
  | { kind: 'project'; id: string }
  | { kind: 'project-deleted'; id: string }
  | { kind: 'rules' }
  | { kind: 'meta' }

let channel: BroadcastChannel | null = null
function broadcast(notice: ChangeNotice): void {
  try {
    channel ??= new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage(notice satisfies ChangeNotice)
  } catch {
    // 个别环境不支持 BroadcastChannel 时，退化为重新可见时全量拉取
  }
}

/* ------------------------------- 本机告警条 ------------------------------- */

export type StoreNotice = { id: number; text: string }
export const storeNotices = reactive<{ items: StoreNotice[] }>({ items: [] })
let noticeSeq = 0

/** 存储层发生冲突 / 异常时推一条全局告警，各页面顶部可见 */
export function pushStoreNotice(text: string): void {
  const id = ++noticeSeq
  storeNotices.items.push({ id, text })
  if (storeNotices.items.length > 5) storeNotices.items.shift()
  window.setTimeout(() => dismissStoreNotice(id), 8000)
}

export function dismissStoreNotice(id: number): void {
  const index = storeNotices.items.findIndex((item) => item.id === id)
  if (index >= 0) storeNotices.items.splice(index, 1)
}

/* --------------------------------- 规则 --------------------------------- */

function sortRules(rules: SizeRule[]): SizeRule[] {
  return [...rules].sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.version.localeCompare(b.version)
      : a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
}

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 内置规则合并：内置版本以随应用发布的 JSON 为准（永不丢、刷新/清空后自动补回），
 * 用户自定义版本以本机库为准。清空浏览器数据后首次打开，规则列表不为空。
 */
function mergeRules(stored: SizeRule[]): SizeRule[] {
  const custom = stored.filter((rule) => !rule.builtin)
  return sortRules([...BUILTIN_RULES.map((rule) => ({ ...rule })), ...custom])
}

/* ------------------------------- 墓碑管理 ------------------------------- */

let projectTombstones: ProjectTombstone[] = []
let personTombstones: PersonTombstone[] = []

function pruneTombstones<T extends { at: number }>(list: T[], now: number): T[] {
  return list.filter((item) => now - item.at < TOMBSTONE_TTL_MS)
}

function filterTombstoned(project: Project): void {
  const dead = new Set(
    personTombstones.filter((item) => item.projectId === project.id).map((item) => item.personId)
  )
  if (dead.size > 0) project.persons = project.persons.filter((person) => !dead.has(person.id))
}

/* ------------------------------ 项目内存状态 ------------------------------ */

type ProjectRuntime = {
  /** 内存版本所基于的库内 rev（用于 CAS 期望修订号） */
  baseRev: number
  /** 内存相对库内版本是否有尚未提交的修改 */
  dirty: boolean
  /** 合并落盘定时器 */
  timer: number | null
  /** 串行化本项目的写库 Promise，避免同页连续写乱序 */
  chain: Promise<void>
  /** 等待当前防抖提交完成的回调（flush 取消定时器时要把它们接到立即提交上） */
  pending: { resolve: () => void; reject: (error: unknown) => void } | null
}

const runtime = new Map<string, ProjectRuntime>()

function runtimeOf(id: string): ProjectRuntime {
  let entry = runtime.get(id)
  if (!entry) {
    entry = { baseRev: 0, dirty: false, timer: null, chain: Promise.resolve(), pending: null }
    runtime.set(id, entry)
  }
  return entry
}

function clearTimer(entry: ProjectRuntime): void {
  if (entry.timer !== null) {
    window.clearTimeout(entry.timer)
    entry.timer = null
  }
}

/** 把一次提交结果通知给正在 await 防抖落盘的调用方（如录入页） */
function settlePending(entry: ProjectRuntime, promise: Promise<void>): void {
  const waiter = entry.pending
  entry.pending = null
  if (!waiter) return
  promise.then(waiter.resolve, waiter.reject)
}

/* --------------------------------- 初始化 --------------------------------- */

export async function initStore(): Promise<void> {
  try {
    const [projects, rules, meta, pTombs, prjTombs] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetAll<SizeRule>(STORE_RULES),
      idbGetAll<MetaEntry>(STORE_META),
      idbGetMetaJson<PersonTombstone[]>(META_PERSON_TOMBSTONES, []),
      idbGetMetaJson<ProjectTombstone[]>(META_PROJECT_TOMBSTONES, [])
    ])
    personTombstones = pruneTombstones(pTombs, Date.now())
    projectTombstones = pruneTombstones(prjTombs, Date.now())
    const deadProjects = new Set(projectTombstones.map((item) => item.projectId))

    store.rules = mergeRules(rules)
    store.projects = []
    for (const project of projects) {
      if (deadProjects.has(project.id)) continue
      filterTombstoned(project)
      runtimeOf(project.id).baseRev = project.rev ?? 0
      store.projects.push(project)
    }
    sortProjects()

    const operator = meta.find((entry) => entry.key === 'operator')
    if (operator) store.operator = operator.value
    store.ready = true

    // 把内置规则补写入库，使“号型规则”页在清空数据后也能看到完整版本列表；
    // 补写失败不阻断使用（内存里已有），只提示。
    void seedBuiltinRules(rules)

    setupCrossTabSync()
    setupLifecycleFlush()
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    store.ready = true
  }
}

async function seedBuiltinRules(stored: SizeRule[]): Promise<void> {
  const storedVersions = new Set(stored.map((rule) => rule.version))
  const missing = BUILTIN_RULES.filter((rule) => !storedVersions.has(rule.version))
  if (missing.length === 0) return
  try {
    for (const rule of missing) await idbPut(STORE_RULES, toRaw(rule))
  } catch (error) {
    pushStoreNotice(
      `内置号型规则补写到本机失败（功能仍可用，但清空数据后可能再次缺失）：${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/* ------------------------------- 跨标签同步 ------------------------------- */

function setupCrossTabSync(): void {
  try {
    channel ??= new BroadcastChannel(CHANNEL_NAME)
    channel.onmessage = (event: MessageEvent<ChangeNotice>) => {
      const notice = event.data
      if (!notice || typeof notice !== 'object') return
      if (notice.kind === 'rules') {
        void reloadRules()
      } else if (notice.kind === 'meta') {
        void reloadMeta()
      } else if (notice.kind === 'project') {
        void pullRemoteProject(notice.id)
      } else if (notice.kind === 'project-deleted') {
        void pullRemoteProject(notice.id)
      }
    }
  } catch {
    // 无 BroadcastChannel：依赖 visibilitychange 全量兜底
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void refreshFromDisk()
    } else {
      void flushAllDirty()
    }
  })
}

/** 从库内拉取一个项目并与本地内存做行级合并；本地无未提交修改时直接以库内为准 */
async function pullRemoteProject(id: string): Promise<void> {
  try {
    const [remote, tombs] = await Promise.all([
      idbGet<Project>(STORE_PROJECTS, id),
      idbGetMetaJson<PersonTombstone[]>(META_PERSON_TOMBSTONES, [])
    ])
    personTombstones = pruneTombstones(tombs, Date.now())

    const localIndex = store.projects.findIndex((project) => project.id === id)
    const local = localIndex >= 0 ? store.projects[localIndex] : undefined
    const entry = runtimeOf(id)

    // 远端已删除
    const remoteDeleted =
      !remote || projectTombstones.some((item) => item.projectId === id)
    if (remoteDeleted) {
      if (local && !entry.dirty) {
        if (localIndex >= 0) store.projects.splice(localIndex, 1)
        runtime.delete(id)
      }
      // 本地有未提交修改则保留内存，交由下一次 CAS 合并/墓碑逻辑处理
      return
    }

    const remoteProject = remote as Project
    filterTombstoned(remoteProject)

    if (!local) {
      entry.baseRev = remoteProject.rev ?? 0
      entry.dirty = false
      store.projects.push(remoteProject)
      sortProjects()
      return
    }

    if (!entry.dirty) {
      // 本地干净：整包采用远端，但保留 Vue 响应式对象身份（页面 computed 不断线）
      replaceProjectContent(local, remoteProject)
      entry.baseRev = remoteProject.rev ?? 0
      return
    }

    // 本地脏：按人员行级合并，双方增删改都不丢
    const merged = mergeProjectBodies(local, remoteProject)
    replaceProjectContent(local, merged)
    entry.baseRev = remoteProject.rev ?? 0
    // merged 同时含双方内容，基于远端 rev 再立即提交一次（经统一入口，取消在途防抖）
    entry.dirty = true
    try {
      await flushProject(local)
    } catch (error) {
      pushStoreNotice(`合并其它标签页的修改后重新保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  } catch (error) {
    pushStoreNotice(`同步其它标签页的修改失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function refreshFromDisk(): Promise<void> {
  try {
    const [projects, tombs, prjTombs] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetMetaJson<PersonTombstone[]>(META_PERSON_TOMBSTONES, []),
      idbGetMetaJson<ProjectTombstone[]>(META_PROJECT_TOMBSTONES, [])
    ])
    personTombstones = pruneTombstones(tombs, Date.now())
    projectTombstones = pruneTombstones(prjTombs, Date.now())
    const remoteById = new Map(projects.map((project) => [project.id, project]))
    for (const project of [...store.projects]) {
      await pullRemoteProject(project.id)
    }
    for (const remote of remoteById.values()) {
      if (!store.projects.some((item) => item.id === remote.id)) {
        await pullRemoteProject(remote.id)
      }
    }
  } catch {
    // 后台静默同步失败不打扰，下一次操作仍有 CAS 兜底
  }
}

async function reloadRules(): Promise<void> {
  try {
    const rules = await idbGetAll<SizeRule>(STORE_RULES)
    store.rules = mergeRules(rules)
  } catch (error) {
    pushStoreNotice(`读取号型规则失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function reloadMeta(): Promise<void> {
  try {
    const meta = await idbGetAll<MetaEntry>(STORE_META)
    const operator = meta.find((entry) => entry.key === 'operator')
    if (operator) store.operator = operator.value
  } catch {
    // 元数据同步失败不影响主流程
  }
}

/* ------------------------------ 行级合并规则 ------------------------------ */

/**
 * 两个版本的同一项目合并：
 * - persons 按 Person.rev 取较新（行级 last-writer-wins），并集保留；
 * - 人员删除以墓碑为准（commit 前已 filter）；
 * - imports / perf / batches / name / kind / ruleVersion 等项目字段取 updatedAt 较新者。
 */
function mergeProjectBodies(local: Project, remote: Project): Project {
  const personById = new Map<string, Person>()
  for (const person of remote.persons) personById.set(person.id, person)
  for (const person of local.persons) {
    const existing = personById.get(person.id)
    if (!existing || (person.rev ?? 0) >= (existing.rev ?? 0)) personById.set(person.id, person)
  }
  const dead = new Set(
    personTombstones.filter((item) => item.projectId === local.id).map((item) => item.personId)
  )
  const persons = [...personById.values()].filter((person) => !dead.has(person.id))
  // 行序：以远端顺序为底，追加仅本地有的新行；对象必须取 personById 里按 rev 胜出者，
  // 不能直接引用 remote.persons，否则会丢掉本地对同一人员的更新。
  const ordered: Person[] = []
  const orderedIds = new Set<string>()
  for (const person of remote.persons) {
    const winner = personById.get(person.id)
    if (winner && !dead.has(winner.id)) {
      ordered.push(winner)
      orderedIds.add(winner.id)
    }
  }
  for (const person of persons) if (!orderedIds.has(person.id)) ordered.push(person)

  const localWins = (local.updatedAt ?? 0) >= (remote.updatedAt ?? 0)
  const winner = localWins ? local : remote
  const loser = localWins ? remote : local
  return {
    ...winner,
    // 名称 / 锁定规则等字段以最后修改的一方为准，但保留另一方可能更新过的批次
    name: winner.name,
    ruleVersion: winner.ruleVersion,
    kind: winner.kind,
    batches: winner.batches.length >= loser.batches.length ? winner.batches : loser.batches,
    persons: ordered,
    imports: winner.imports.length >= loser.imports.length ? winner.imports : loser.imports,
    perf: (local.updatedAt ?? 0) >= (remote.updatedAt ?? 0) ? local.perf ?? winner.perf : remote.perf ?? winner.perf
  }
}

/** 用 source 的内容就地替换 target 的字段，保持 target 的 Vue 响应式代理身份不变 */
function replaceProjectContent(target: Project, source: Project): void {
  target.name = source.name
  target.kind = source.kind
  target.ruleVersion = source.ruleVersion
  target.batches = source.batches
  target.persons = source.persons
  target.imports = source.imports
  target.perf = source.perf
  target.createdAt = source.createdAt
  target.updatedAt = source.updatedAt
  target.rev = source.rev
}

/* ------------------------------ 生命周期落盘 ------------------------------ */

let lifecycleBound = false
function setupLifecycleFlush(): void {
  if (lifecycleBound) return
  lifecycleBound = true
  // pagehide 是标签页关闭 / 刷新时最后一次可靠落盘机会
  window.addEventListener('pagehide', () => {
    void flushAllDirty()
  })
  window.addEventListener('beforeunload', () => {
    void flushAllDirty()
  })
}

async function flushAllDirty(): Promise<void> {
  const targets = [...runtime.entries()].filter(([, entry]) => entry.dirty).map(([id]) => id)
  await Promise.all(
    targets.map((id) => {
      const project = store.projects.find((item) => item.id === id)
      return project ? scheduleCommit(project, runtimeOf(id), true) : Promise.resolve()
    })
  )
}

/* --------------------------------- 查询 --------------------------------- */

export function getProject(id: string | string[]): Project | undefined {
  const key = Array.isArray(id) ? id[0] : id
  return store.projects.find((project) => project.id === key)
}

export function getRule(version: string | undefined): SizeRule {
  if (version) {
    const found = store.rules.find((rule) => rule.version === version)
    if (found) return found
  }
  // 项目锁定版本缺失时绝不静默换成别的版本去归并——返回内置初版兜底，
  // 界面依据 isRuleAvailable 给出醒目提示，不会假装版本正确。
  return store.rules[0] ?? BUILTIN_RULES[0]
}

/** 项目锁定的规则版本在本机是否可用（不可用时界面要明确提示，而不是偷偷换版本） */
export function isRuleAvailable(version: string): boolean {
  return store.rules.some((rule) => rule.version === version)
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

/* --------------------------------- 写入 --------------------------------- */

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
    updatedAt: now
  }
  store.projects.unshift(project)
  const entry = runtimeOf(project.id)
  entry.baseRev = 0
  entry.dirty = true
  await commitProject(project, true)
  return project
}

/**
 * 登记一次项目修改并安排落盘。
 * @param immediate true = 立即落盘并等待提交完成（导出、导入、删除人等关键节点）；
 *                  false = 合并 200ms 内的连续修改（连续录入默认路径）。
 * 返回的 Promise 在数据真正写入本机后 resolve；失败会 reject，调用方必须据此提示。
 */
export function persistProject(project: Project, immediate = false): Promise<void> {
  project.updatedAt = Date.now()
  const local = store.projects.some((item) => item.id === project.id)
  if (!local) store.projects.unshift(project)
  sortProjects()
  const entry = runtimeOf(project.id)
  entry.dirty = true
  return scheduleCommit(project, entry, immediate)
}

/** 立即落盘（导出、导入完成、离开页面前调用），保证最后几条不丢 */
export function flushProject(project: Project): Promise<void> {
  const entry = runtimeOf(project.id)
  return scheduleCommit(project, entry, true)
}

/** 人员级修订号 +1：跨标签行级合并按它判定谁更新 */
export function bumpPersonRev(person: Person): void {
  person.rev = (person.rev ?? 0) + 1
}

function scheduleCommit(project: Project, entry: ProjectRuntime, immediate: boolean): Promise<void> {
  if (immediate) {
    // 关键节点（导出、导入、删人、删项目前）：取消排队中的防抖提交，立即落盘。
    // 正在 await 防抖的调用方（如连续录入）一并等这次立即提交，不会悬空。
    clearTimer(entry)
    const promise = commitProject(project, true)
    settlePending(entry, promise)
    return promise
  }
  if (entry.timer === null) {
    return new Promise<void>((resolve, reject) => {
      entry.pending = { resolve, reject }
      entry.timer = window.setTimeout(() => {
        entry.timer = null
        const promise = commitProject(project, false)
        settlePending(entry, promise)
      }, PERSIST_DEBOUNCE_MS)
    })
  }
  // 已在防抖窗口内：复用同一个等待对象
  return new Promise<void>((resolve, reject) => {
    const previous = entry.pending
    entry.pending = {
      resolve: () => {
        previous?.resolve()
        resolve()
      },
      reject: (error: unknown) => {
        previous?.reject(error)
        reject(error)
      }
    }
  })
}

/**
 * 实际写库：串行队列 + compare-and-swap + 冲突行级合并重试。
 * 只有事务 oncomplete 后才 resolve；任何失败都 reject 给界面。
 */
function commitProject(project: Project, immediate: boolean): Promise<void> {
  const entry = runtimeOf(project.id)
  const run = entry.chain.then(async () => {
    // 若已被本标签页删除，则丢弃一切迟到写入（删除不复活的第一道闸）
    if (isLocallyDeleted(project.id)) return
    const expectedRev = entry.baseRev
    const nextRev = expectedRev + 1
    // 本次提交涉及的人员墓碑随快照一起在同一 CAS 事务里落库
    const tombstonesValue = personTombstones
    const snapshot = toRaw({
      ...project,
      persons: project.persons.map((person) => toRaw(person)),
      imports: project.imports.map((record) => ({ ...record })),
      batches: [...project.batches],
      rev: nextRev
    }) as Project
    // 墓碑过滤：即便内存对象来自旧引用，也不允许把已删除的人写回去
    const dead = new Set(
      tombstonesValue.filter((item) => item.projectId === project.id).map((item) => item.personId)
    )
    if (dead.size > 0) snapshot.persons = snapshot.persons.filter((person) => !dead.has(person.id))

    const sideWrites = (metaStore: IDBObjectStore): void => {
      metaStore.put({ key: META_PERSON_TOMBSTONES, value: tombstonesValue })
    }

    try {
      await idbPutProjectCas(snapshot, expectedRev, sideWrites)
      entry.baseRev = nextRev
      entry.dirty = false
      broadcast({ kind: 'project', id: project.id })
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        await resolveConflict(project, entry, snapshot, error.actualRev, tombstonesValue)
      } else {
        // 真失败（配额 / IO / 中止）：保留内存与 dirty，明确抛出，界面提示重试
        throw error
      }
    }
  })
  // 让链不因单次失败而中断后续可重试动作，但本次失败继续向外抛
  entry.chain = run.then(
    () => undefined,
    () => undefined
  )
  if (!immediate) {
    // 防抖超时触发时错误已无法回传给具体调用，走全局告警，保留内存待下次提交重试
    run.catch((error: unknown) => {
      pushStoreNotice(
        `自动保存失败，数据仍保留在当前页面，请稍后继续编辑或点导出重试：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    })
  }
  return run
}

const locallyDeletedProjects = new Set<string>()
function isLocallyDeleted(id: string): boolean {
  return locallyDeletedProjects.has(id)
}

/** CAS 冲突：读取库内最新版本，行级合并后以最新 rev 重新提交 */
async function resolveConflict(
  project: Project,
  entry: ProjectRuntime,
  attempted: Project,
  actualRev: number,
  tombstonesValue: PersonTombstone[]
): Promise<void> {
  const [remote, tombs] = await Promise.all([
    idbGet<Project>(STORE_PROJECTS, project.id),
    idbGetMetaJson<PersonTombstone[]>(META_PERSON_TOMBSTONES, [])
  ])
  personTombstones = pruneTombstones(tombs, Date.now())
  const knownTombs = pruneTombstones(tombstonesValue, Date.now())

  if (projectTombstones.some((item) => item.projectId === project.id) || !remote) {
    // 另一标签页已删除该项目：本地若仍有未提交内容，不擅自复活，交界面裁决
    entry.baseRev = actualRev
    throw new Error('该项目已在其它标签页被删除，当前修改未写入；如确需保留请重新新建项目')
  }

  // 合并双方墓碑：本标签页刚删的人与其它标签页删的人都要在最终快照里缺席
  const allTombs = dedupeTombstones([...personTombstones, ...knownTombs])
  personTombstones = allTombs

  const merged = mergeProjectBodies(attempted, remote as Project)
  merged.updatedAt = Math.max(attempted.updatedAt, (remote as Project).updatedAt)
  merged.rev = actualRev + 1
  const dead = new Set(
    allTombs.filter((item) => item.projectId === project.id).map((item) => item.personId)
  )
  merged.persons = merged.persons.filter((person) => !dead.has(person.id))

  await idbPutProjectCas(
    toRaw(merged) as Project,
    actualRev,
    (metaStore) => {
      metaStore.put({ key: META_PERSON_TOMBSTONES, value: allTombs })
    }
  )
  entry.baseRev = merged.rev
  entry.dirty = false
  // 把合并结果回写内存（保持响应式对象身份）
  replaceProjectContent(project, merged)
  pushStoreNotice('检测到该项目在其它标签页也被修改，已自动合并双方内容，未丢失任何记录')
  broadcast({ kind: 'project', id: project.id })
}

function dedupeTombstones(list: PersonTombstone[]): PersonTombstone[] {
  const map = new Map<string, PersonTombstone>()
  for (const item of pruneTombstones(list, Date.now())) {
    const key = `${item.projectId}/${item.personId}`
    const existing = map.get(key)
    if (!existing || item.at > existing.at) map.set(key, item)
  }
  return [...map.values()]
}

/* --------------------------------- 删除 --------------------------------- */

export async function deleteProject(id: string): Promise<void> {
  const entry = runtimeOf(id)
  clearTimer(entry)
  const previousIndex = store.projects.findIndex((project) => project.id === id)
  const previousProject = previousIndex >= 0 ? store.projects[previousIndex] : undefined
  locallyDeletedProjects.add(id)
  if (previousIndex >= 0) store.projects.splice(previousIndex, 1)

  const now = Date.now()
  // 该项目的墓碑与项目记录删除放在同一原子事务：要么一起生效，要么一起失败
  const nextProjectTombs = pruneTombstones(
    [
      ...projectTombstones.filter((item) => item.projectId !== id),
      { projectId: id, at: now }
    ],
    now
  )
  const nextPersonTombs = dedupeTombstones([
    ...personTombstones,
    ...(previousProject?.persons ?? []).map((person) => ({
      personId: person.id,
      projectId: id,
      at: now
    }))
  ])

  // 排进同一串行链：必须等所有在途提交结束后再删，
  // 链上排在后面的提交会被 isLocallyDeleted 拦下，删除绝不被旧写覆盖。
  const run = entry.chain.then(async () => {
    await idbDeleteProjectWithTombstones(id, nextProjectTombs, nextPersonTombs)
    projectTombstones = nextProjectTombs
    personTombstones = nextPersonTombs
    broadcast({ kind: 'project-deleted', id })
  })
  entry.chain = run.then(
    () => undefined,
    () => undefined
  )
  try {
    await run
    runtime.delete(id)
  } catch (error) {
    // 删除失败必须回滚内存，否则会出现“列表没了、刷新又回来”的镜像错觉
    locallyDeletedProjects.delete(id)
    if (previousProject && !store.projects.some((item) => item.id === id)) {
      store.projects.push(previousProject)
      sortProjects()
    }
    throw error
  }
}

/**
 * 删除一条人员记录：墓碑与更新后的项目快照在同一个 CAS 事务里提交，
 * 任何标签页持有的旧快照都无法把该人员写回来（复活防护第二道闸）。
 * 返回 Promise 等事务真正落盘后才 resolve。
 */
export function deletePerson(project: Project, personId: string): Promise<void> {
  const now = Date.now()
  personTombstones = dedupeTombstones([
    ...personTombstones,
    { personId, projectId: project.id, at: now }
  ])
  project.persons = project.persons.filter((person) => person.id !== personId)
  const entry = runtimeOf(project.id)
  entry.dirty = true
  return scheduleCommit(project, entry, true)
}

/* ------------------------------ 归并辅助 ------------------------------ */

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

/* --------------------------------- 规则 --------------------------------- */

export async function saveRule(rule: SizeRule): Promise<void> {
  const index = store.rules.findIndex((item) => item.version === rule.version)
  if (index >= 0) store.rules[index] = rule
  else store.rules.push(rule)
  store.rules = sortRules(store.rules)
  await idbPut(STORE_RULES, toRaw(rule))
  broadcast({ kind: 'rules' })
}

export async function deleteRule(version: string): Promise<void> {
  store.rules = store.rules.filter((rule) => rule.version !== version)
  await idbDelete(STORE_RULES, version)
  broadcast({ kind: 'rules' })
}

export async function setOperator(name: string): Promise<void> {
  store.operator = name
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
  broadcast({ kind: 'meta' })
}
