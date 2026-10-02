/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 */
import { computed, reactive, toRaw } from 'vue'
import type { Project, ProjectKind, SizeRule } from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION, ruleByVersion } from './sizeRules'
import { runMerge } from './merge'
import {
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
  idbDelete,
  idbGetAll,
  idbPut,
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

const persistTimers = new Map<string, number>()

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function initStore(): Promise<void> {
  try {
    const [projects, rules, meta] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetAll<SizeRule>(STORE_RULES),
      idbGetAll<MetaEntry>(STORE_META)
    ])
    store.rules = rules
    store.projects = projects
    sortProjects()
    const operator = meta.find((entry) => entry.key === 'operator')
    if (operator) store.operator = operator.value
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
    updatedAt: now
  }
  store.projects.unshift(project)
  await idbPut(STORE_PROJECTS, toRaw(project))
  return project
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

/** 保存项目：默认合并短时间内的连续写入，避免连续录入时频繁落盘 */
export function persistProject(project: Project, immediate = false): void {
  project.updatedAt = Date.now()
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
  if (immediate) {
    void idbPut(STORE_PROJECTS, toRaw(project))
    return
  }
  window.setTimeout(() => {
    void idbPut(STORE_PROJECTS, toRaw(project))
  }, 180)
}

/** 立即落盘（导出、离开页面前调用），保证离线数据完整 */
export async function flushProject(project: Project): Promise<void> {
  const pending = persistTimers.get(project.id)
  if (pending) {
    window.clearTimeout(pending)
    persistTimers.delete(project.id)
  }
  project.updatedAt = Date.now()
  await idbPut(STORE_PROJECTS, toRaw(project))
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
}

export async function deleteProject(id: string): Promise<void> {
  store.projects = store.projects.filter((project) => project.id !== id)
}

export async function saveRule(rule: SizeRule): Promise<void> {
  const index = store.rules.findIndex((item) => item.version === rule.version)
  if (index >= 0) store.rules[index] = rule
  else store.rules.push(rule)
  store.rules.sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.version.localeCompare(b.version)
      : a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
  await idbPut(STORE_RULES, toRaw(rule))
}

export async function deleteRule(version: string): Promise<void> {
  store.rules = store.rules.filter((rule) => rule.version !== version)
  await idbDelete(STORE_RULES, version)
}

export async function setOperator(name: string): Promise<void> {
  store.operator = name
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
}