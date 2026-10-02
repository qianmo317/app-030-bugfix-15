/**
 * 0.5cm 精度工具。
 * 规格书 §8 精度要求：身高 / 胸围 / 腰围 按 0.5cm 精度存储，
 * 判定时统一换算成「半厘米整数」再比较，避免浮点相等带来的误差。
 */

export function roundToHalfCm(value: number): number {
  return Math.round(value * 2) / 2
}

export function cmToHalfUnits(cm: number): number {
  return Math.round(cm * 2)
}

export function halfUnitsToCm(units: number): number {
  return units / 2
}

/** 把半厘米整数格式化成展示文本：336 → "168"、335 → "167.5" */
export function formatHalfUnits(units: number): string {
  const cm = halfUnitsToCm(units)
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1)
}

export function formatCm(cm: number | null | undefined): string {
  if (cm === null || cm === undefined || !Number.isFinite(cm)) return ''
  return Number.isInteger(cm) ? String(cm) : cm.toFixed(1)
}

/** 把可能带单位（cm/厘米/公分）的输入解析为 0.5cm 精度数值 */
export function parseLengthCm(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? roundToHalfCm(raw) : null
  const text = raw
    .trim()
    .replace(/[ｃmCM厘米公分]/g, '')
    .replace(/[,，]/g, '.')
    .replace(/[^0-9.\-]/g, '')
  if (text === '' || text === '-' || text === '.') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return roundToHalfCm(value)
}

/** 体重按 0.1kg 精度解析（仅用于建议号型参考） */
export function parseWeightKg(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 10) / 10 : null
  const text = raw
    .trim()
    .replace(/[kKｇgG公斤千克]/g, '')
    .replace(/[,，]/g, '.')
    .replace(/[^0-9.\-]/g, '')
  if (text === '' || text === '-' || text === '.') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return Math.round(value * 10) / 10
}

/** 身高体重派生值：胸腰差（cm），用半厘米整数相减后换算，保证精确 */
export function chestWaistDiffCm(chestCm: number, waistCm: number): number {
  return (cmToHalfUnits(chestCm) - cmToHalfUnits(waistCm)) / 2
}