// 本机存储冒烟测试：用 fake-indexeddb 在 Node 中驱动真实的 IndexedDB 事务。
import { IDBFactory } from 'fake-indexeddb'

const idbFactory = new IDBFactory()
globalThis.indexedDB = idbFactory as unknown as typeof indexedDB

const g = globalThis as unknown as Record<string, unknown>
g.window = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
  addEventListener: () => undefined,
  localStorage: undefined
}
g.document = { addEventListener: () => undefined, visibilityState: 'visible', activeElement: null }

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok - ${name}`)
  } else {
    failed += 1
    console.error(`  FAIL - ${name} ${detail}`)
  }
}

const storeModule = await import('../src/logic/store.ts')
const idbModule = await import('../src/logic/idb.ts')

// ---------- 场景 1：清空数据后内置规则仍在 ----------
{
  await new Promise<void>((resolve, reject) => {
    const req = idbFactory.deleteDatabase('app030-uniform-tally')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
  await storeModule.initStore()
  check('清空浏览器数据后规则列表不为空', storeModule.store.rules.length > 0)
  check('内置规则 v1.0.0 永远存在', storeModule.store.rules.some((r: { version: string }) => r.version === 'v1.0.0'))
  check('新建项目可选到规则版本 v1.0.0', storeModule.ruleVersions.value.includes('v1.0.0'))
}

// ---------- 场景 2：项目与连续录入落盘，刷新（重新初始化）后读回一致 ----------
let projectId = ''
{
  const project = await storeModule.createProject({
    name: '测试中学',
    kind: 'school',
    batches: ['春装'],
    ruleVersion: 'v1.0.0'
  })
  projectId = project.id
  const makePerson = (index: number) => ({
    id: `p_${index}`,
    name: `学生${index}`,
    gender: 'male' as const,
    orgUnit: '高一(3)班',
    batch: '春装',
    heightCm: 170 + index,
    weightKg: 60,
    chestCm: 88,
    waistCm: 74,
    specialFlag: null,
    note: '',
    status: 'active' as const,
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: index,
    source: 'manual' as const,
    result: null,
    createdAt: Date.now()
  })
  for (let i = 1; i <= 5; i++) {
    project.persons.push(makePerson(i))
    // 每条立即保存，并等待“真正落盘”的 Promise
    await storeModule.persistProject(project, true)
  }
  // 模拟刷新：丢掉内存状态，重新从 IDB 初始化
  await storeModule.initStore()
  const reloaded = storeModule.getProject(projectId)
  check('刷新后项目仍在', !!reloaded)
  check('连续录入 5 条一条不少', reloaded?.persons.length === 5, `实际 ${reloaded?.persons.length}`)
  check('项目锁定规则版本读回正确', reloaded?.ruleVersion === 'v1.0.0')
  check('项目文档带有 rev', typeof reloaded?.rev === 'number' && (reloaded?.rev ?? 0) >= 1)
}

// ---------- 场景 3：导出前立即保存能保住最后一条 ----------
{
  const project = storeModule.getProject(projectId)
  project.persons.push({
    id: 'p_export_last',
    name: '最后一条',
    gender: 'female',
    orgUnit: '高一(3)班',
    batch: '春装',
    heightCm: 160,
    weightKg: 50,
    chestCm: 84,
    waistCm: 72,
    specialFlag: null,
    note: '',
    status: 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: 99,
    source: 'manual',
    result: null,
    createdAt: Date.now()
  })
  await storeModule.flushProject(project)
  await storeModule.initStore()
  const reloaded = storeModule.getProject(projectId)
  check('导出前 flush 保住最后录入的一条', reloaded?.persons.some((p: { id: string }) => p.id === 'p_export_last') === true)
}

// ---------- 场景 4：删除项目真正落盘，刷新不复活 ----------
{
  await storeModule.deleteProject(projectId)
  await storeModule.initStore()
  check('删除后刷新项目不复活', storeModule.getProject(projectId) === undefined)
  check('删除后列表计数为 0', storeModule.store.projects.length === 0)
}

// ---------- 场景 5：rev 乐观锁——旧 rev 提交被拒 ----------
{
  const project = await storeModule.createProject({
    name: '并发测试项目',
    kind: 'factory',
    batches: [],
    ruleVersion: 'v1.0.0'
  })
  const rev1 = project.rev
  // 别的页面先提交了一版（rev 推进）
  const fromDisk = await idbModule.idbGet<Record<string, unknown>>(idbModule.STORE_PROJECTS, project.id)
  await idbModule.idbCommitDoc(idbModule.STORE_PROJECTS, { ...fromDisk, persons: [] }, project.id, rev1 as number)
  // 本页仍拿旧 rev 提交 → 必须冲突，不能静默覆盖
  let threw = false
  try {
    await idbModule.idbCommitDoc(idbModule.STORE_PROJECTS, { ...fromDisk }, project.id, rev1 as number)
  } catch (error) {
    threw = error instanceof idbModule.StorageConflictError
  }
  check('旧 rev 提交抛 StorageConflictError', threw)
  projectId = project.id
}

// ---------- 场景 6：删除（墓碑）之后排队的旧写不能复活文档 ----------
{
  const staleRevBeforeDelete = (await idbModule.idbGet<{ rev: number }>(idbModule.STORE_PROJECTS, projectId))?.rev ?? 1
  await storeModule.deleteProject(projectId)
  const stale = {
    id: projectId,
    name: '并发测试项目',
    kind: 'factory',
    ruleVersion: 'v1.0.0',
    batches: [],
    persons: [],
    imports: [],
    createdAt: 1,
    updatedAt: 1,
    rev: staleRevBeforeDelete
  }
  let threw = false
  try {
    // 在途提交拿着删除前的旧 rev → 必须被墓碑拦下
    await idbModule.idbCommitDoc(idbModule.STORE_PROJECTS, stale, projectId, staleRevBeforeDelete)
  } catch (error) {
    threw = error instanceof idbModule.StorageConflictError
  }
  check('墓碑阻止已删项目被旧写复活', threw)
  const back = await idbModule.idbGet(idbModule.STORE_PROJECTS, projectId)
  check('被删项目确实不在库里', back === undefined)

  // 但用同主键全新创建（expectedRev=0）应放行，墓碑随之清除
  const recreatedRev = await idbModule.idbCommitDoc(idbModule.STORE_PROJECTS, stale, projectId, 0)
  check('同主键新建（删后重建）不被自己的墓碑挡住', recreatedRev === 1)
  await storeModule.deleteProject(projectId)
}

// ---------- 场景 7：自定义规则清空数据后不影响内置规则 ----------
{
  await storeModule.saveRule({
    version: 'v9.9.9',
    label: '自定义',
    builtin: false,
    heightStepCm: 5,
    heightAnchor: 155,
    chestStepCm: 4,
    chestAnchor: 84,
    boundaryRule: 'nearest',
    fitByChestWaistDiff: [],
    specialFlags: [],
    heightRangeCm: { minCm: 100, maxCm: 220 },
    chestRangeCm: { minCm: 50, maxCm: 150 },
    estimate: {
      standardWeightBaseCm: 160,
      maleWeightFactor: 0.7,
      femaleWeightFactor: 0.6,
      maleChestRatio: 0.55,
      femaleChestRatio: 0.5,
      maleBmiRef: 22,
      femaleBmiRef: 21,
      bmiChestFactor: 0.6,
      maleDefaultDiffCm: 12,
      femaleDefaultDiffCm: 14
    },
    effectiveFrom: '2026-01-01',
    note: ''
  })
  check('自定义规则保存后出现在列表', storeModule.store.rules.some((r: { version: string }) => r.version === 'v9.9.9'))
  await storeModule.deleteRule('v9.9.9')
  check('自定义规则可删除', !storeModule.store.rules.some((r: { version: string }) => r.version === 'v9.9.9'))
}

// ---------- 场景 8：两个标签页同时连续录入（纯新增）→ 自动合并，两边人的都在 ----------
{
  const project = await storeModule.createProject({
    name: '双标签页项目',
    kind: 'school',
    batches: [],
    ruleVersion: 'v1.0.0'
  })
  const basePerson = (id: string, name: string) => ({
    id,
    name,
    gender: 'male' as const,
    orgUnit: '一班',
    batch: '',
    heightCm: 170,
    weightKg: 60,
    chestCm: 88,
    waistCm: 74,
    specialFlag: null,
    note: '',
    status: 'active' as const,
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: 1,
    source: 'manual' as const,
    result: null,
    createdAt: Date.now()
  })

  // 本页先加 a1 并落盘（store 的 base 停在 {a1} / rev2）
  project.persons.push(basePerson('a1', '甲页第一条'))
  await storeModule.persistProject(project, true)

  // 模拟另一个标签页直接在磁盘上追加 a2（rev3）
  const disk = await idbModule.idbGet<Record<string, unknown>>(idbModule.STORE_PROJECTS, project.id)
  await idbModule.idbCommitDoc(
    idbModule.STORE_PROJECTS,
    { ...disk, persons: [...(disk as { persons: unknown[] }).persons, basePerson('a2', '甲页第二条')] },
    project.id,
    (disk as { rev: number }).rev
  )

  // 本页在旧底本 {a1} 上继续加 b1 并提交 → 冲突，但属于纯新增，应自动合并成功
  project.persons.push(basePerson('b1', '乙页第一条'))
  await storeModule.persistProject(project, true)

  const merged = await idbModule.idbGet<{ persons: Array<{ id: string }> }>(idbModule.STORE_PROJECTS, project.id)
  const ids = merged?.persons.map((p) => p.id) ?? []
  check('两页都录入时另一页的人不丢', ids.includes('a1') && ids.includes('a2'))
  check('两页都录入时本页的人也在', ids.includes('b1'))
  check('合并后没有重复行', ids.length === 3, `实际 ${ids.length}`)
  // 合并后本页内存也对齐
  check('合并后本页列表包含全部 3 人', storeModule.getProject(project.id)?.persons.length === 3)

  await storeModule.deleteProject(project.id)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
