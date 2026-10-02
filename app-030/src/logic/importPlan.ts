/**
 * 批量导入：表头模糊匹配 + 两步式 dry_run 预览（新增 / 更新 / 无效 / 错误行）。
 * 严格校验：数值范围、性别值（男/女/M/F）、重复行（同名 + 同班级 + 同身高体重，只提示不删除）。
 */
import type { Gender, Person, Project, SizeRule } from './types'
import { analyzeDraft, makePersonId, duplicateKeyOf, type PersonDraft } from './analyze'
import { parseLengthCm, parseWeightKg } from './precision'

export type ImportFieldKey =
  | 'name'
  | 'gender'
  | 'orgUnit'
  | 'batch'
  | 'heightCm'
  | 'weightKg'
  | 'chestCm'
  | 'waistCm'
  | 'specialFlag'
  | 'note'

export type ImportField = {
  key: ImportFieldKey
  label: string
  required: boolean
  patterns: RegExp[]
}

export const IMPORT_FIELDS: ImportField[] = [
  { key: 'name', label: '姓名', required: true, patterns: [/姓名/, /名字/, /^name$/i, /学生/, /员工/] },
  { key: 'gender', label: '性别', required: true, patterns: [/性别/, /^sex$/i, /^gender$/i] },
  { key: 'orgUnit', label: '班级/车间', required: false, patterns: [/班级/, /车间/, /部门/, /单位/, /^org/i, /班组/, /科室/] },
  { key: 'batch', label: '批次', required: false, patterns: [/批次/, /^batch$/i, /季节/] },
  { key: 'heightCm', label: '身高(cm)', required: true, patterns: [/身高/, /^height/i, /^h$/i] },
  { key: 'weightKg', label: '体重(kg)', required: false, patterns: [/体重/, /^weight/i] },
  { key: 'chestCm', label: '胸围(cm)', required: true, patterns: [/胸围/, /^chest/i, /^bust/i] },
  { key: 'waistCm', label: '腰围(cm)', required: true, patterns: [/腰围/, /^waist/i] },
  { key: 'specialFlag', label: '特殊体型', required: false, patterns: [/特殊/, /特体/, /定制/, /^special/i] },
  { key: 'note', label: '备注', required: false, patterns: [/备注/, /说明/, /^note/i, /remark/i] }
]

export type ColumnMapping = Record<ImportFieldKey, number | null>

export const EMPTY_MAPPING: ColumnMapping = {
  name: null,
  gender: null,
  orgUnit: null,
  batch: null,
  heightCm: null,
  weightKg: null,
  chestCm: null,
  waistCm: null,
  specialFlag: null,
  note: null
}

function normalizeHeader(text: string): string {
  return text.replace(/[\s（）()：:_\-/]/g, '').toLowerCase()
}

export function guessMapping(header: string[]): ColumnMapping {
  const mapping: ColumnMapping = { ...EMPTY_MAPPING }
  const used = new Set<number>()
  for (const field of IMPORT_FIELDS) {
    for (let index = 0; index < header.length; index += 1) {
      if (used.has(index)) continue
      const normalized = normalizeHeader(header[index] ?? '')
      if (normalized === '') continue
      if (field.patterns.some((pattern) => pattern.test(normalized) || pattern.test(header[index] ?? ''))) {
        mapping[field.key] = index
        used.add(index)
        break
      }
    }
  }
  return mapping
}

export function mappedCount(mapping: ColumnMapping): number {
  return IMPORT_FIELDS.filter((field) => mapping[field.key] !== null).length
}

/** 表头行识别：前 8 行内命中字段最多的那一行 */
export function detectHeaderRow(rows: string[][]): number {
  let bestIndex = -1
  let bestScore = 0
  const limit = Math.min(rows.length, 8)
  for (let index = 0; index < limit; index += 1) {
    const score = mappedCount(guessMapping(rows[index]))
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestScore >= 3 ? bestIndex : -1
}

export type DryRunKind = 'new' | 'update' | 'invalid' | 'error'

export type DryRunRow = {
  lineNo: number
  kind: DryRunKind
  reason: string
  draft: PersonDraft | null
  duplicateOf: string | null
  raw: string[]
}

export type DryRunCounts = {
  new: number
  update: number
  invalid: number
  error: number
  duplicate: number
  total: number
}

export type DryRun = {
  fileName: string
  fingerprint: string
  header: string[]
  mapping: ColumnMapping
  rows: DryRunRow[]
  counts: DryRunCounts
  durationMs: number
}

export function parseGenderValue(raw: string): Gender | null {
  const text = raw.trim()
  if (text === '') return null
  if (/^(男|男性|男生|m|male|M|1|boy)$/i.test(text)) return 'male'
  if (/^(女|女性|女生|f|female|F|0|2|girl)$/i.test(text)) return 'female'
  return null
}

function resolveSflag(raw: string, rule: SizeRule): { code: string | null; warning: string } {
  const text = raw.trim()
  if (text === '' || /^(无|否|no|none|-)$/i.test(text)) return { code: null, warning: '' }
  const byCode = rule.specialFlags.find((flag) => flag.code.toLowerCase() === text.toLowerCase())
  if (byCode) return { code: byCode.code, warning: '' }
  const byLabel = rule.specialFlags.find((flag) => flag.label === text || text.includes(flag.label))
  if (byLabel) return { code: byLabel.code, warning: '' }
  return { code: null, warning: `特殊体型标记「${text}」不在 ${rule.version} 规则中，已按普通行处理` }
}

function cellAt(cells: string[], index: number | null): string {
  if (index === null) return ''
  return (cells[index] ?? '').trim()
}

export function buildDraftFromRow(
  cells: string[],
  mapping: ColumnMapping,
  rule: SizeRule,
  defaultBatch: string,
  lineNo: number
): { draft: PersonDraft | null; error: string; warning: string } {
  const name = cellAt(cells, mapping.name)
  if (name === '') return { draft: null, error: '缺少姓名', warning: '' }

  const genderRaw = cellAt(cells, mapping.gender)
  const gender = parseGenderValue(genderRaw)
  if (!gender) {
    return { draft: null, error: `性别「${genderRaw || '空'}」无法识别（应为 男/女/M/F）`, warning: '' }
  }

  const heightRaw = cellAt(cells, mapping.heightCm)
  const heightCm = parseLengthCm(heightRaw)
  if (heightRaw !== '' && heightCm === null) return { draft: null, error: `身高「${heightRaw}」不是有效数字`, warning: '' }

  const chestRaw = cellAt(cells, mapping.chestCm)
  const chestCm = parseLengthCm(chestRaw)
  if (chestRaw !== '' && chestCm === null) return { draft: null, error: `胸围「${chestRaw}」不是有效数字`, warning: '' }

  const waistRaw = cellAt(cells, mapping.waistCm)
  const waistCm = parseLengthCm(waistRaw)
  if (waistRaw !== '' && waistCm === null) return { draft: null, error: `腰围「${waistRaw}」不是有效数字`, warning: '' }

  const weightRaw = cellAt(cells, mapping.weightKg)
  const weightKg = parseWeightKg(weightRaw)
  if (weightRaw !== '' && weightKg === null) return { draft: null, error: `体重「${weightRaw}」不是有效数字`, warning: '' }

  const flag = resolveSflag(cellAt(cells, mapping.specialFlag), rule)
  const noteParts = [cellAt(cells, mapping.note)]
  if (flag.warning) noteParts.push(flag.warning)

  return {
    draft: {
      name,
      gender,
      orgUnit: cellAt(cells, mapping.orgUnit),
      batch: cellAt(cells, mapping.batch) || defaultBatch,
      heightCm,
      weightKg,
      chestCm,
      waistCm,
      specialFlag: flag.code,
      note: noteParts.filter((part) => part !== '').join('；'),
      sourceRow: lineNo,
      source: 'import'
    },
    error: '',
    warning: flag.warning
  }
}

export function buildDryRun(
  dataRows: { cells: string[]; lineNo: number }[],
  mapping: ColumnMapping,
  project: Project,
  rule: SizeRule,
  fileName: string,
  fingerprint: string
): DryRun {
  const started = performance.now()
  const existingByKey = new Map<string, Person>()
  const duplicateKeys = new Map<string, string>()
  for (const person of project.persons) {
    const key = `${person.name.trim()}|${person.orgUnit.trim()}|${person.gender}`
    if (!existingByKey.has(key)) existingByKey.set(key, person)
    const dupKey = duplicateKeyOf(person)
    if (!duplicateKeys.has(dupKey)) duplicateKeys.set(dupKey, `既有行「${person.name}」`)
  }

  const rows: DryRunRow[] = []
  const counts: DryRunCounts = { new: 0, update: 0, invalid: 0, error: 0, duplicate: 0, total: dataRows.length }
  const batchDefault = project.batches[0] ?? '未分批'
  const fileDuplicateKeys = new Map<string, number>()

  for (const row of dataRows) {
    const parsed = buildDraftFromRow(row.cells, mapping, rule, batchDefault, row.lineNo)
    if (!parsed.draft) {
      counts.error += 1
      rows.push({ lineNo: row.lineNo, kind: 'error', reason: parsed.error, draft: null, duplicateOf: null, raw: row.cells })
      continue
    }
    const draft = parsed.draft
    const outcome = analyzeDraft(draft, rule)
    const key = `${draft.name.trim()}|${draft.orgUnit.trim()}|${draft.gender}`
    const existing = existingByKey.get(key)

    const dupKey = [draft.name.trim(), draft.orgUnit.trim(), draft.heightCm ?? '', draft.weightKg ?? ''].join('|')
    let duplicateOf: string | null = duplicateKeys.get(dupKey) ?? null
    const earlierLine = fileDuplicateKeys.get(dupKey)
    if (!duplicateOf && earlierLine !== undefined) duplicateOf = `本文件第 ${earlierLine} 行`
    if (!fileDuplicateKeys.has(dupKey)) fileDuplicateKeys.set(dupKey, row.lineNo)
    if (duplicateOf) counts.duplicate += 1

    if (outcome.status === 'invalid') {
      counts.invalid += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'invalid',
        reason: outcome.statusReason,
        draft,
        duplicateOf,
        raw: row.cells
      })
      continue
    }

    if (existing) {
      counts.update += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'update',
        reason: `按「姓名 + 班级」匹配到既有记录（第 ${existing.sourceRow ?? '—'} 行），将更新其量体数据`,
        draft,
        duplicateOf,
        raw: row.cells
      })
    } else {
      counts.new += 1
      rows.push({
        lineNo: row.lineNo,
        kind: 'new',
        reason: parsed.warning || '新增量体记录',
        draft,
        duplicateOf,
        raw: row.cells
      })
    }
  }

  return {
    fileName,
    fingerprint,
    header: [],
    mapping,
    rows,
    counts,
    durationMs: Math.round((performance.now() - started) * 100) / 100
  }
}

export function createPersonFromDraft(draft: PersonDraft, rule: SizeRule, duplicateOf: string | null): Person {
  const outcome = analyzeDraft(draft, rule)
  return {
    id: makePersonId(),
    name: draft.name.trim(),
    gender: draft.gender ?? 'male',
    orgUnit: draft.orgUnit.trim(),
    batch: draft.batch,
    heightCm: draft.heightCm ?? 0,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm ?? 0,
    waistCm: draft.waistCm ?? 0,
    specialFlag: draft.specialFlag,
    note: draft.note,
    status: outcome.status,
    statusReason: outcome.statusReason,
    anomaly: outcome.anomaly,
    needsConfirm: outcome.needsConfirm || Boolean(duplicateOf),
    possibleDuplicateOf: duplicateOf,
    sourceRow: draft.sourceRow,
    source: draft.source,
    result: null,
    createdAt: Date.now()
  }
}

export type ApplyResult = { added: number; updated: number; invalid: number; skipped: number }

/** 正式导入：写入项目（重复行只提示、不自动删除；同一文件指纹幂等由调用方先校验） */
export function applyImport(project: Project, dryRun: DryRun, rule: SizeRule): ApplyResult {
  const existingByKey = new Map<string, Person>()
  for (const person of project.persons) {
    const key = `${person.name.trim()}|${person.orgUnit.trim()}|${person.gender}`
    if (!existingByKey.has(key)) existingByKey.set(key, person)
  }
  const result: ApplyResult = { added: 0, updated: 0, invalid: 0, skipped: 0 }
  for (const row of dryRun.rows) {
    if (row.kind === 'error' || !row.draft) {
      result.skipped += 1
      continue
    }
    const draft = row.draft
    const key = `${draft.name.trim()}|${draft.orgUnit.trim()}|${draft.gender}`
    const created = createPersonFromDraft(draft, rule, row.duplicateOf)
    if (row.kind === 'update') {
      const existing = existingByKey.get(key)
      if (existing) {
        existing.heightCm = created.heightCm
        existing.weightKg = created.weightKg
        existing.chestCm = created.chestCm
        existing.waistCm = created.waistCm
        existing.specialFlag = created.specialFlag
        existing.note = created.note
        existing.status = created.status
        existing.statusReason = created.statusReason
        existing.anomaly = created.anomaly
        existing.needsConfirm = created.needsConfirm
        existing.possibleDuplicateOf = created.possibleDuplicateOf
        existing.sourceRow = created.sourceRow
        existing.result = null
        result.updated += 1
        continue
      }
    }
    project.persons.push(created)
    existingByKey.set(key, created)
    if (row.kind === 'invalid') result.invalid += 1
    else result.added += 1
  }
  project.imports.push({
    fingerprint: dryRun.fingerprint,
    fileName: dryRun.fileName,
    at: Date.now(),
    rows: dryRun.counts.total,
    added: result.added,
    updated: result.updated,
    invalid: result.invalid,
    skipped: result.skipped
  })
  return result
}

export const IMPORT_TEMPLATE_HEADER = [
  '姓名',
  '性别',
  '班级',
  '批次',
  '身高(cm)',
  '体重(kg)',
  '胸围(cm)',
  '腰围(cm)',
  '特殊体型',
  '备注'
]

export const IMPORT_TEMPLATE_SAMPLE: string[][] = [
  ['示例·张三', '男', '高一(3)班', '春装', '170', '65', '88', '72', '', '第一排'],
  ['示例·李四', '女', '高一(3)班', '春装', '160', '52', '84', '68', '', '——']
]