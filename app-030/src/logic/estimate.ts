/**
 * 身高体重 → 建议初始号型（规格书 §5 进阶功能）。
 * 仅作录入参考，最终以实测胸腰围为准。
 */
import type { Gender, SizeRule } from './types'
import { buildSizeCode, chestCodeUnits, heightCodeUnits } from './sizeRules'
import { formatHalfUnits } from './precision'

export type EstimateResult = {
  sizeCode: string
  heightText: string
  chestText: string
  fit: string
  estimatedChestCm: number
  estimatedWaistCm: number
  basis: string
}

export function estimateInitialSize(
  rule: SizeRule,
  gender: Gender,
  heightCm: number | null,
  weightKg: number | null
): EstimateResult | null {
  if (heightCm === null || heightCm <= 0) return null
  const cfg = rule.estimate
  const heightM = heightCm / 100
  const bmi = weightKg && weightKg > 0 ? weightKg / (heightM * heightM) : null
  const refBmi = gender === 'male' ? cfg.maleBmiRef : cfg.femaleBmiRef
  const ratio = gender === 'male' ? cfg.maleChestRatio : cfg.femaleChestRatio
  const defaultDiff = gender === 'male' ? cfg.maleDefaultDiffCm : cfg.femaleDefaultDiffCm
  const effectiveBmi = bmi ?? refBmi
  const estimatedChestCm = Math.max(60, heightCm * ratio + (effectiveBmi - refBmi) * cfg.bmiChestFactor)
  const estimatedWaistCm = estimatedChestCm - defaultDiff
  const built = buildSizeCode(rule, gender, heightCm, estimatedChestCm, estimatedWaistCm)
  const heightText = formatHalfUnits(heightCodeUnits(rule, heightCm))
  const chestText = formatHalfUnits(chestCodeUnits(rule, estimatedChestCm))
  const weightNote = weightKg ? `实测体重 ${weightKg}kg（BMI ${effectiveBmi.toFixed(1)}）` : '未填体重，按标准体型估算'
  return {
    sizeCode: built?.sizeCode ?? `${heightText}/${chestText}?`,
    heightText,
    chestText,
    fit: built?.fit ?? '—',
    estimatedChestCm: Math.round(estimatedChestCm * 10) / 10,
    estimatedWaistCm: Math.round(estimatedWaistCm * 10) / 10,
    basis: `按身高 ${heightCm}cm 与${weightNote}估算胸围约 ${estimatedChestCm.toFixed(1)}cm、腰围约 ${estimatedWaistCm.toFixed(1)}cm，仅供录入参考，最终以实测胸腰围为准。`
  }
}