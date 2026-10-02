/** 无依赖 CSV 读写、文本指纹与本地下载工具 */

export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const candidates: string[] = [',', '\t', ';', '，']
  let best = ','
  let bestCount = -1
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1
    if (count > bestCount) {
      bestCount = count
      best = candidate
    }
  }
  return best
}

/** 解析 CSV/TSV 文本为二维数组，支持引号包裹、转义引号、CRLF 与 BOM */
export function parseDelimitedText(text: string, delimiter?: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const sep = delimiter ?? detectDelimiter(source)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === sep) {
      row.push(field)
      field = ''
      continue
    }
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += char
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
    .map((cells) => cells.map((cell) => cell.trim()))
    .filter((cells) => cells.some((cell) => cell !== ''))
}

function escapeCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** 生成带 BOM 的 CSV，Excel 双击即正确识别中文 */
export function toCsvText(rows: (string | number | null | undefined)[][]): string {
  return `\uFEFF${rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`
}

/** FNV-1a 文本指纹，用于同一文件重复导入的幂等判定 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function downloadText(text: string, fileName: string, mime = 'text/csv;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type: mime }), fileName)
}

export function todayStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}`
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}