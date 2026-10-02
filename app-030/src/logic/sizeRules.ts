/**
 * 号型规则引擎：档位对齐、型别判定、号型代码生成。
 * 规格书 §8 要求：档位与型别阈值一律从 SizeRule 读取，组件里不得硬编码。
 */
import rawBuiltinRules from '../data/size-rules.json'
import type { BoundaryRule, FitRange, Gender, PatternFit, SizeRule } from './types'
import { cmToHalfUnits, formatHalfUnits, halfUnitsToCm } from './precision'

export const BUILTIN_RULES = rawBuiltinRules as unknown as SizeRule[]
export const DEFAULT_RULE_VERSION = BUILTIN_RULES[0]?.version ?? 'v1.0.0'

/**
 * 档位对齐：档位 = 锚点 + 步长 × round((值 − 锚点) / 步长)
 * boundaryRule = round_up → 167.5 归 170（半数向上）
 * boundaryRule = nearest  → 167.5 归 165（半数向下）
 * 全部用半厘米整数运算，避免浮点比较。
 */
export function alignToStep(
  units: number,
  anchorUnits: number,
  stepUnits: number,
  boundary: BoundaryRule
): number {
  if (stepUnits <= 0) return units
  const delta = units - anchorUnits
  const k =
    boundary === 'round_up'
      ? Math.floor((2 * delta + stepUnits) / (2 * stepUnits))
      : Math.ceil((2 * delta - stepUnits) / (2 * stepUnits))
  return anchorUnits + stepUnits * k
}

export function heightCodeUnits(rule: SizeRule, heightCm: number): number {
  return alignToStep(
    cmToHalfUnits(heightCm),
    cmToHalfUnits(rule.heightAnchor),
    cmToHalfUnits(rule.heightStepCm),
    rule.boundaryRule
  )
}

export function chestCodeUnits(rule: SizeRule, chestCm: number): number {
  return alignToStep(
    cmToHalfUnits(chestCm),
    cmToHalfUnits(rule.chestAnchor),
    cmToHalfUnits(rule.chestStepCm),
    rule.boundaryRule
  )
}

export function rangesFor(rule: SizeRule, gender: Gender): FitRange[] {
  return rule.fitByChestWaistDiff.find((item) => item.gender === gender)?.ranges ?? []
}

/** 型别判定：胸腰差落在哪个区间（区间端点为闭区间，来自 SizeRule） */
export function resolveFit(
  rule: SizeRule,
  gender: Gender,
  diffCm: number
): { fit: PatternFit; range: FitRange } | null {
  const ranges = rangesFor(rule, gender)
  for (const range of ranges) {
    if (diffCm >= range.minCm && diffCm <= range.maxCm) return { fit: range.fit, range }
  }
  return null
}

export function makeSizeCode(heightUnits: number, chestUnits: number, fit: PatternFit): string {
  return `${formatHalfUnits(heightUnits)}/${formatHalfUnits(chestUnits)}${fit}`
}

/** 由身高 / 胸围 / 性别生成号型代码，胸腰差不在任何区间内时返回 null（未归并） */
export function buildSizeCode(
  rule: SizeRule,
  gender: Gender,
  heightCm: number,
  chestCm: number,
  waistCm: number
): { sizeCode: string; fit: PatternFit; heightCode: number; chestCode: number; diffCm: number } | null {
  const diffCm = (cmToHalfUnits(chestCm) - cmToHalfUnits(waistCm)) / 2
  const matched = resolveFit(rule, gender, diffCm)
  if (!matched) return null
  const hUnits = heightCodeUnits(rule, heightCm)
  const cUnits = chestCodeUnits(rule, chestCm)
  return {
    sizeCode: makeSizeCode(hUnits, cUnits, matched.fit),
    fit: matched.fit,
    heightCode: halfUnitsToCm(hUnits),
    chestCode: halfUnitsToCm(cUnits),
    diffCm
  }
}

/** 人工覆写号型的格式校验：170/88A、175/96.5B 之类 */
export function normalizeSizeCodeInput(input: string): string {
  return input.replace(/\s+/g, '').replace(/[／]/g, '/').replace(/，/g, '/').toUpperCase()
}

export function isSizeCodeValid(rule: SizeRule, input: string): boolean {
  const code = normalizeSizeCodeInput(input)
  if (!/^\d+(\.5)?\/\d+(\.5)?[YABC]$/.test(code)) return false
  const fit = code.slice(-1)
  return rule.fitByChestWaistDiff.some((group) => group.ranges.some((range) => range.fit === fit))
}

export function specialFlagLabel(rule: SizeRule, code: string | null): string {
  if (!code) return ''
  return rule.specialFlags.find((flag) => flag.code === code)?.label ?? code
}

export function ruleByVersion(rules: SizeRule[], version: string): SizeRule {
  return rules.find((rule) => rule.version === version) ?? rules[0] ?? BUILTIN_RULES[0]
}

export function fitRangeText(range: FitRange): string {
  return `${range.fit} ${range.minCm}~${range.maxCm}`
}

/** 拼接规则的文字说明，供 UI 展示（不硬编码数字，全部来自规则） */
export function describeAlign(rule: SizeRule, cm: number, kind: 'height' | 'chest'): string {
  const units = kind === 'height' ? heightCodeUnits(rule, cm) : chestCodeUnits(rule, cm)
  return `${formatHalfUnits(units)}`
}

/** 号码档位可对齐的候选值（用于 UI 说明与覆写建议） */
export function stepCandidates(anchor: number, step: number, min: number, max: number): number[] {
  const list: number[] = []
  for (let value = anchor; value <= max; value += step) if (value >= min) list.push(value)
  for (let value = anchor - step; value >= min; value -= step) list.unshift(value)
  return list.map((value) => Math.round(value * 10) / 10)
}