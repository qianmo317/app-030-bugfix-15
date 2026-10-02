/**
 * 量体行校验：数值异常拦截、无效行判定、可能重复行识别（不自动删除）。
 */
import type { AnomalyCode, Gender, Person, PersonStatus, SizeRule } from './types'
import { resolveFit } from './sizeRules'
import { chestWaistDiffCm } from './precision'

export type PersonDraft = {
  name: string
  gender: Gender | null
  orgUnit: string
  batch: string
  heightCm: number | null
  weightKg: number | null
  chestCm: number | null
  waistCm: number | null
  specialFlag: string | null
  note: string
  sourceRow: number | null
  source: 'manual' | 'import'
}

export type AnalyzeOutcome = {
  status: PersonStatus
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  /** 能否按规则归出号型 */
  canMerge: boolean
  messages: string[]
}

const ANOMALY_TEXT: Record<AnomalyCode, string> = {
  height_out_of_range: '身高超出可判定范围',
  chest_out_of_range: '胸围异常',
  missing_chest: '缺少胸围',
  missing_height: '缺少身高',
  missing_waist: '缺少腰围',
  diff_out_of_range: '胸腰差超出型别区间'
}

export function anomalyText(code: AnomalyCode): string {
  return ANOMALY_TEXT[code]
}

/**
 * 校验一行量体数据：
 * - 结构性缺失 / 超范围 → 无效行（不计入有效人数）
 * - 数值可疑但仍可归并（胸围 < 身高一半、胸腰差为负等）→ 待确认，仍计入有效人数
 * - 胸腰差不在任何型别区间 → 待确认且无法归并（需要在归并页人工处理）
 */
export function analyzeDraft(draft: PersonDraft, rule: SizeRule): AnalyzeOutcome {
  const anomaly: AnomalyCode[] = []
  const messages: string[] = []
  let needsConfirm = false

  if (!draft.gender) {
    return {
      status: 'invalid',
      statusReason: '性别无法识别（应为 男/女 或 M/F）',
      anomaly,
      needsConfirm: true,
      canMerge: false,
      messages: ['性别无法识别']
    }
  }
  const gender: Gender = draft.gender

  if (draft.heightCm === null || draft.heightCm <= 0) {
    return {
      status: 'invalid',
      statusReason: '缺少身高',
      anomaly: ['missing_height'],
      needsConfirm: true,
      canMerge: false,
      messages: ['缺少身高']
    }
  }
  if (draft.heightCm < rule.heightRangeCm.minCm || draft.heightCm > rule.heightRangeCm.maxCm) {
    return {
      status: 'invalid',
      statusReason: `身高 ${draft.heightCm}cm 超出 ${rule.heightRangeCm.minCm}~${rule.heightRangeCm.maxCm}cm 可判定范围`,
      anomaly: ['height_out_of_range'],
      needsConfirm: true,
      canMerge: false,
      messages: ['身高明显异常，已拦截为无效行，请复核后重新录入']
    }
  }
  if (draft.chestCm === null || draft.chestCm <= 0) {
    return {
      status: 'invalid',
      statusReason: '缺少胸围（无法判定型别）',
      anomaly: ['missing_chest'],
      needsConfirm: true,
      canMerge: false,
      messages: ['缺少胸围']
    }
  }
  if (draft.waistCm === null || draft.waistCm <= 0) {
    return {
      status: 'invalid',
      statusReason: '缺少腰围（无法计算胸腰差）',
      anomaly: ['missing_waist'],
      needsConfirm: true,
      canMerge: false,
      messages: ['缺少腰围']
    }
  }
  if (draft.chestCm < rule.chestRangeCm.minCm || draft.chestCm > rule.chestRangeCm.maxCm) {
    return {
      status: 'invalid',
      statusReason: `胸围 ${draft.chestCm}cm 超出 ${rule.chestRangeCm.minCm}~${rule.chestRangeCm.maxCm}cm 可判定范围`,
      anomaly: ['chest_out_of_range'],
      needsConfirm: true,
      canMerge: false,
      messages: ['胸围明显异常，已拦截为无效行，请复核后重新录入']
    }
  }

  if (draft.chestCm < draft.heightCm / 2) {
    anomaly.push('chest_out_of_range')
    needsConfirm = true
    messages.push(`胸围 ${draft.chestCm}cm 小于身高一半（${draft.heightCm / 2}cm），请现场复核`)
  }

  const diffCm = chestWaistDiffCm(draft.chestCm, draft.waistCm)
  if (diffCm < 0) {
    anomaly.push('diff_out_of_range')
    needsConfirm = true
    messages.push(`胸腰差为负（胸围 − 腰围 = ${diffCm}cm），胸腰数据可能录反`)
  }

  const fit = resolveFit(rule, gender, diffCm)
  if (!fit) {
    if (!anomaly.includes('diff_out_of_range')) anomaly.push('diff_out_of_range')
    needsConfirm = true
    messages.push(
      `胸腰差 ${diffCm}cm 不在 ${rule.version} 的型别区间内，无法自动归并，请人工确认（标记特殊体型或覆写号型）`
    )
    return { status: 'active', statusReason: '', anomaly, needsConfirm, canMerge: false, messages }
  }

  if (draft.specialFlag) {
    messages.push('已标记特殊体型，将单列进定制清单，不混入常规档')
  }
  return { status: 'active', statusReason: '', anomaly, needsConfirm, canMerge: true, messages }
}

/** 重复行判定键：同名 + 同班级 + 同身高体重（规格书 §8） */
export function duplicateKeyOf(person: Pick<Person, 'name' | 'orgUnit' | 'heightCm' | 'weightKg'>): string {
  return [person.name.trim(), person.orgUnit.trim(), person.heightCm, person.weightKg ?? ''].join('|')
}

export function duplicateKeyOfDraft(draft: PersonDraft): string {
  return [draft.name.trim(), draft.orgUnit.trim(), draft.heightCm ?? '', draft.weightKg ?? ''].join('|')
}

/** 查找可能重复的既有行；只提示不删除 */
export function findDuplicateIds(persons: Person[], draft: PersonDraft, excludeId?: string): string[] {
  const key = duplicateKeyOfDraft(draft)
  if (!draft.name.trim() || !draft.orgUnit.trim()) return []
  return persons
    .filter((person) => person.id !== excludeId && duplicateKeyOf(person) === key)
    .map((person) => person.id)
}

export function makePersonId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `p_${Date.now().toString(36)}_${rand}`
}