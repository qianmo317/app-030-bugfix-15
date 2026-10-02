/**
 * 号型归并与守恒汇总（规格书 §4.2 / §4.5 / §8 核心）。
 * 归并规则全部来自 SizeRule；守恒等式：Σ常规档 + Σ特殊单列 = 有效人数。
 */
import type { Gender, Person, Project, SizeRule, SummaryRow } from './types'
import { buildSizeCode } from './sizeRules'
import { anomalyText } from './analyze'

export type MergeResult = { durationMs: number }

/** 按规则计算单人号型；数据不完整或胸腰差不在区间内返回 null（未归并） */
export function computeRuleSize(rule: SizeRule, person: Person): { sizeCode: string; fit: 'Y' | 'A' | 'B' | 'C' } | null {
  if (!person.heightCm || !person.chestCm || !person.waistCm) return null
  const built = buildSizeCode(rule, person.gender, person.heightCm, person.chestCm, person.waistCm)
  return built ? { sizeCode: built.sizeCode, fit: built.fit } : null
}

/**
 * 归并整个项目（幂等）：结果始终按项目锁定的规则版本解释，
 * 规则改版不会改变既有项目的归并结果。
 */
export function runMerge(project: Project, rule: SizeRule): MergeResult {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  for (const person of project.persons) {
    if (person.status !== 'active') {
      person.result = null
      continue
    }
    const built = computeRuleSize(rule, person)
    const override = person.result?.manualOverride
    if (override) {
      person.result = {
        sizeCode: override.sizeCode,
        ruleSizeCode: built?.sizeCode ?? '',
        fit: built?.fit ?? null,
        ruleVersion: rule.version,
        // 逐字段重建为普通对象：override 读自响应式代理，直接嵌套会让 IndexedDB 落盘时无法结构化克隆
        manualOverride: {
          sizeCode: override.sizeCode,
          by: override.by,
          reason: override.reason,
          at: override.at
        }
      }
    } else if (built) {
      person.result = {
        sizeCode: built.sizeCode,
        ruleSizeCode: built.sizeCode,
        fit: built.fit,
        ruleVersion: rule.version
      }
    } else {
      person.result = null
    }
  }
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return { durationMs: Math.round((ended - started) * 100) / 100 }
}

export type SummaryDiff = {
  personId: string
  name: string
  orgUnit: string
  sourceRow: number | null
  reason: string
}

export type SummaryTotals = {
  totalRows: number
  invalidRows: number
  duplicateRows: number
  validRows: number
  regularQty: number
  specialQty: number
  accountedQty: number
  overrideCount: number
  ruleResolvedCount: number
  pendingConfirmCount: number
  specialPersonCount: number
}

export type OrgUnitGroup = {
  orgUnit: string
  validCount: number
  invalidCount: number
  regularQty: number
  specialQty: number
  rows: SummaryRow[]
}

export type BatchGroup = {
  batch: string
  validCount: number
  regularQty: number
  specialQty: number
  rows: SummaryRow[]
}

export type DistributionRow = {
  sizeCode: string
  gender: Gender
  qty: number
  isSpecial: boolean
  ratio: number
  marginRatio: number
  suggestion: number
}

export type Summary = {
  ruleVersion: string
  regularRows: SummaryRow[]
  specialRows: SummaryRow[]
  allRows: SummaryRow[]
  totals: SummaryTotals
  byOrgUnit: OrgUnitGroup[]
  byBatch: BatchGroup[]
  unmerged: SummaryDiff[]
  conserved: boolean
  distribution: DistributionRow[]
}

function parseCode(code: string): { height: number; chest: number; fit: number } | null {
  const matched = /^(\d+(?:\.5)?)\/(\d+(?:\.5)?)([YABC])$/.exec(code)
  if (!matched) return null
  const fitOrder = ['Y', 'A', 'B', 'C']
  return {
    height: Number(matched[1]),
    chest: Number(matched[2]),
    fit: fitOrder.indexOf(matched[3])
  }
}

/** 同一号型的行号规则：男装在前，再按号 / 型 / 型别排序，特殊档排最后 */
function compareRows(a: SummaryRow, b: SummaryRow): number {
  if (a.isSpecial !== b.isSpecial) return a.isSpecial ? 1 : -1
  if (a.gender !== b.gender) return a.gender === 'male' ? -1 : 1
  const pa = parseCode(a.sizeCode)
  const pb = parseCode(b.sizeCode)
  if (!pa || !pb) return a.sizeCode.localeCompare(b.sizeCode)
  if (pa.height !== pb.height) return pa.height - pb.height
  if (pa.chest !== pb.chest) return pa.chest - pb.chest
  return pa.fit - pb.fit
}

function accumulate(
  map: Map<string, SummaryRow>,
  sizeCode: string,
  gender: Gender,
  isSpecial: boolean
): void {
  const key = `${isSpecial ? 'S' : 'R'}|${sizeCode}|${gender}`
  const existing = map.get(key)
  if (existing) existing.qty += 1
  else map.set(key, { sizeCode, gender, qty: 1, isSpecial })
}

function groupRows(rows: SummaryRow[]): SummaryRow[] {
  return [...rows].sort(compareRows)
}

/** 汇总 + 守恒校验。调用前请先 runMerge（结果幂等） */
export function buildSummary(project: Project, rule: SizeRule): Summary {
  const regularMap = new Map<string, SummaryRow>()
  const specialMap = new Map<string, SummaryRow>()
  const orgMap = new Map<string, { persons: Person[]; rows: Map<string, SummaryRow> }>()
  const batchMap = new Map<string, { persons: Person[]; rows: Map<string, SummaryRow> }>()

  let invalidRows = 0
  let duplicateRows = 0
  let validRows = 0
  let overrideCount = 0
  let pendingConfirmCount = 0
  let specialPersonCount = 0
  const unmerged: SummaryDiff[] = []

  for (const person of project.persons) {
    if (person.status === 'invalid') invalidRows += 1
    else if (person.status === 'duplicate') duplicateRows += 1
    else validRows += 1

    const orgKey = person.orgUnit || '未填班级/车间'
    const batchKey = person.batch || '未分批'
    if (!orgMap.has(orgKey)) orgMap.set(orgKey, { persons: [], rows: new Map() })
    if (!batchMap.has(batchKey)) batchMap.set(batchKey, { persons: [], rows: new Map() })
    orgMap.get(orgKey)!.persons.push(person)
    batchMap.get(batchKey)!.persons.push(person)

    if (person.anomaly.length > 0) pendingConfirmCount += 1

    if (person.status !== 'active') continue
    if (person.result?.manualOverride) overrideCount += 1

    if (person.specialFlag) {
      specialPersonCount += 1
      // 特殊体型统一用标记码入桶，展示时再映射成中文标签
      accumulate(specialMap, person.specialFlag, person.gender, true)
      accumulate(orgMap.get(orgKey)!.rows, person.specialFlag, person.gender, true)
      accumulate(batchMap.get(batchKey)!.rows, person.specialFlag, person.gender, true)
      continue
    }

    if (person.result) {
      accumulate(regularMap, person.result.sizeCode, person.gender, false)
      accumulate(orgMap.get(orgKey)!.rows, person.result.sizeCode, person.gender, false)
      accumulate(batchMap.get(batchKey)!.rows, person.result.sizeCode, person.gender, false)
      continue
    }

    const reasons: string[] = []
    if (person.anomaly.includes('diff_out_of_range')) {
      reasons.push('胸腰差不在型别区间内，未自动归并')
    }
    for (const code of person.anomaly) {
      const text = anomalyText(code)
      if (!reasons.includes(text)) reasons.push(text)
    }
    unmerged.push({
      personId: person.id,
      name: person.name,
      orgUnit: person.orgUnit,
      sourceRow: person.sourceRow,
      reason: reasons.length > 0 ? reasons.join('；') : '未归并（数据不完整）'
    })
  }

  const regularRows = groupRows([...regularMap.values()])
  const specialRows = groupRows([...specialMap.values()])
  const allRows = [...regularRows, ...specialRows]
  const regularQty = regularRows.reduce((sum, row) => sum + row.qty, 0)
  const specialQty = specialRows.reduce((sum, row) => sum + row.qty, 0)
  const accountedQty = regularQty + specialQty

  const byOrgUnit: OrgUnitGroup[] = [...orgMap.entries()]
    .map(([orgUnit, group]) => {
      const active = group.persons.filter((person) => person.status === 'active')
      const rows = groupRows([...group.rows.values()])
      return {
        orgUnit,
        validCount: active.length,
        invalidCount: group.persons.length - active.length,
        regularQty: rows.filter((row) => !row.isSpecial).reduce((sum, row) => sum + row.qty, 0),
        specialQty: rows.filter((row) => row.isSpecial).reduce((sum, row) => sum + row.qty, 0),
        rows
      }
    })
    .sort((a, b) => a.orgUnit.localeCompare(b.orgUnit, 'zh-Hans-CN'))

  const byBatch: BatchGroup[] = [...batchMap.entries()]
    .map(([batch, group]) => {
      const active = group.persons.filter((person) => person.status === 'active')
      const rows = groupRows([...group.rows.values()])
      return {
        batch,
        validCount: active.length,
        regularQty: rows.filter((row) => !row.isSpecial).reduce((sum, row) => sum + row.qty, 0),
        specialQty: rows.filter((row) => row.isSpecial).reduce((sum, row) => sum + row.qty, 0),
        rows
      }
    })
    .sort((a, b) => a.batch.localeCompare(b.batch, 'zh-Hans-CN'))

  const distribution: DistributionRow[] = [...allRows]
    .sort((a, b) => b.qty - a.qty || compareRows(a, b))
    .map((row) => {
      const marginRatio = row.isSpecial ? 0.1 : 0.05
      return {
        sizeCode: row.sizeCode,
        gender: row.gender,
        qty: row.qty,
        isSpecial: row.isSpecial,
        ratio: accountedQty > 0 ? row.qty / accountedQty : 0,
        marginRatio,
        suggestion: Math.max(1, Math.ceil(row.qty * (1 + marginRatio)))
      }
    })

  return {
    ruleVersion: rule.version,
    regularRows,
    specialRows,
    allRows,
    totals: {
      totalRows: project.persons.length,
      invalidRows,
      duplicateRows,
      validRows,
      regularQty,
      specialQty,
      accountedQty,
      overrideCount,
      ruleResolvedCount: validRows - overrideCount,
      pendingConfirmCount,
      specialPersonCount
    },
    byOrgUnit,
    byBatch,
    unmerged,
    conserved: unmerged.length === 0 && accountedQty === validRows,
    distribution
  }
}

/** 守恒等式文本（页面与导出共用，保证逐行一致） */
export function conservationText(summary: Summary): string {
  const { totals } = summary
  return `常规 ${totals.regularQty} + 特殊 ${totals.specialQty} = 有效 ${totals.validRows} / 总录入 ${totals.totalRows}`
}