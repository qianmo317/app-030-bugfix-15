/**
 * 无第三方依赖的 XLSX 读写（规格书禁用表格库）。
 * 写：自建 ZIP（stored 方式）+ SpreadsheetML 最小部件。
 * 读：解析 ZIP 中央目录 + DecompressionStream('deflate-raw') 解压 + DOMParser 解析。
 */

export type CellValue = string | number | null
export type Sheet = { name: string; rows: CellValue[][] }

/* ------------------------------- CRC32 / ZIP 写入 ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true)
}

type ZipFile = { name: Uint8Array; content: Uint8Array; crc: number; offset: number }

/** 打包为 ZIP（stored，不压缩），用于生成 xlsx */
function buildZip(files: { name: string; content: string | Uint8Array }[]): Blob {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const entries: ZipFile[] = []
  let offset = 0
  const now = new Date()
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const file of files) {
    const name = encoder.encode(file.name)
    const content = typeof file.content === 'string' ? encoder.encode(file.content) : file.content
    const crc = crc32(content)
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    writeUint32(view, 0, 0x04034b50)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x0800, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, dosTime, true)
    view.setUint16(12, dosDate, true)
    writeUint32(view, 14, crc)
    writeUint32(view, 18, content.length)
    writeUint32(view, 22, content.length)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    header.set(name, 30)
    parts.push(header, content)
    entries.push({ name, content, crc, offset })
    offset += header.length + content.length
  }

  const centralParts: Uint8Array[] = []
  let centralSize = 0
  for (const entry of entries) {
    const record = new Uint8Array(46 + entry.name.length)
    const view = new DataView(record.buffer)
    writeUint32(view, 0, 0x02014b50)
    view.setUint16(4, 20, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, 0x0800, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, dosTime, true)
    view.setUint16(14, dosDate, true)
    writeUint32(view, 16, entry.crc)
    writeUint32(view, 20, entry.content.length)
    writeUint32(view, 24, entry.content.length)
    view.setUint16(28, entry.name.length, true)
    view.setUint16(30, 0, true)
    view.setUint16(32, 0, true)
    view.setUint16(34, 0, true)
    view.setUint16(36, 0, true)
    writeUint32(view, 38, 0)
    writeUint32(view, 42, entry.offset)
    record.set(entry.name, 46)
    centralParts.push(record)
    centralSize += record.length
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  writeUint32(endView, 0, 0x06054b50)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  writeUint32(endView, 12, centralSize)
  writeUint32(endView, 16, offset)
  endView.setUint16(20, 0, true)

  return new Blob([...parts, ...centralParts, end], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
}

/* ------------------------------- 生成 XLSX ------------------------------- */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function columnName(index: number): string {
  let name = ''
  let value = index
  while (value >= 0) {
    name = String.fromCharCode((value % 26) + 65) + name
    value = Math.floor(value / 26) - 1
  }
  return name
}

function sheetXml(rows: CellValue[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          if (cell === null || cell === undefined || cell === '') return ''
          const ref = `${columnName(cellIndex)}${rowIndex + 1}`
          if (typeof cell === 'number' && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(cell))}</t></is></c>`
        })
        .join('')
      return cells ? `<row r="${rowIndex + 1}">${cells}</row>` : ''
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

function safeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim()
  return (cleaned || `Sheet${index + 1}`).slice(0, 31)
}

export function buildXlsxBlob(sheets: Sheet[]): Blob {
  const used: string[] = []
  const sheetEntries = sheets.map((sheet, index) => {
    let name = safeSheetName(sheet.name, index)
    while (used.includes(name)) name = `${name.slice(0, 28)}_${index + 1}`
    used.push(name)
    return { name, rows: sheet.rows }
  })

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetEntries
    .map(
      (_entry, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('')}</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries
    .map((entry, index) => `<sheet name="${escapeXml(entry.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')}</sheets></workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries
    .map(
      (_entry, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join('')}</Relationships>`

  const files: { name: string; content: string }[] = [
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    ...sheetEntries.map((entry, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(entry.rows)
    }))
  ]

  return buildZip(files)
}

/* ------------------------------- 读取 XLSX ------------------------------- */

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number }

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

function readZipEntries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocd = -1
  for (let index = data.length - 22; index >= 0 && index >= data.length - 66000; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('文件不是有效的 xlsx（未找到 ZIP 结束标记）')
  const total = view.getUint16(eocd + 10, true)
  let pointer = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  for (let index = 0; index < total; index += 1) {
    if (view.getUint32(pointer, true) !== 0x02014b50) break
    const method = view.getUint16(pointer + 10, true)
    const compressedSize = view.getUint32(pointer + 20, true)
    const nameLength = view.getUint16(pointer + 28, true)
    const extraLength = view.getUint16(pointer + 30, true)
    const commentLength = view.getUint16(pointer + 32, true)
    const localOffset = view.getUint32(pointer + 42, true)
    const name = decodeName(data.subarray(pointer + 46, pointer + 46 + nameLength))
    entries.push({ name, method, compressedSize, localOffset })
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

async function readZipEntryData(data: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) {
    throw new Error(`xlsx 内部结构异常：${entry.name}`)
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true)
  const extraLength = view.getUint16(entry.localOffset + 28, true)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const raw = data.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRaw(raw)
  throw new Error(`不支持的压缩方式（method=${entry.method}），请另存为 CSV 后导入`)
}

async function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const ctor = (
    globalThis as unknown as {
      DecompressionStream?: new (format: string) => {
        readable: ReadableStream<Uint8Array>
        writable: WritableStream<Uint8Array>
      }
    }
  ).DecompressionStream
  if (!ctor) {
    throw new Error('当前浏览器不支持直接解析 xlsx，请在 Excel 中另存为 CSV 后再导入')
  }
  const stream = new Blob([raw]).stream().pipeThrough(new ctor('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

function tagText(element: Element | null): string {
  return element ? (element.textContent ?? '') : ''
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return []
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const items = doc.getElementsByTagNameNS('*', 'si')
  const result: string[] = []
  for (let index = 0; index < items.length; index += 1) {
    const texts = items[index].getElementsByTagNameNS('*', 't')
    let value = ''
    for (let textIndex = 0; textIndex < texts.length; textIndex += 1) {
      value += tagText(texts[textIndex])
    }
    result.push(value)
  }
  return result
}

function columnIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase()
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return Math.max(0, index - 1)
}

function parseSheetRows(xml: string, sharedStrings: string[]): string[][] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const rowElements = doc.getElementsByTagNameNS('*', 'row')
  const rows: string[][] = []
  for (let rowIndex = 0; rowIndex < rowElements.length; rowIndex += 1) {
    const rowElement = rowElements[rowIndex]
    const cellElements = rowElement.getElementsByTagNameNS('*', 'c')
    const cells: string[] = []
    let cursor = 0
    for (let cellIndex = 0; cellIndex < cellElements.length; cellIndex += 1) {
      const cell = cellElements[cellIndex]
      const ref = cell.getAttribute('r')
      const position = ref ? columnIndex(ref) : cursor
      cursor = position + 1
      const type = cell.getAttribute('t')
      let value = ''
      if (type === 'inlineStr') {
        value = tagText(cell.getElementsByTagNameNS('*', 'is')[0])
      } else if (type === 's') {
        const raw = tagText(cell.getElementsByTagNameNS('*', 'v')[0])
        value = sharedStrings[Number(raw)] ?? ''
      } else {
        value = tagText(cell.getElementsByTagNameNS('*', 'v')[0])
      }
      while (cells.length < position) cells.push('')
      cells[position] = value
    }
    rows.push(cells)
  }
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) rows.pop()
  return rows
}

/** 从 xlsx 首个工作表读取二维文本（空单元格补空串） */
export async function readXlsxRows(file: File): Promise<string[][]> {
  const data = new Uint8Array(await file.arrayBuffer())
  const entries = readZipEntries(data)
  const find = (path: string) => entries.find((entry) => entry.name === path)
  const bySuffix = (suffix: string) => entries.find((entry) => entry.name.endsWith(suffix))

  const workbookEntry = find('xl/workbook.xml') ?? bySuffix('workbook.xml')
  let sheetPath = 'xl/worksheets/sheet1.xml'
  if (workbookEntry) {
    const workbookXml = decodeName(await readZipEntryData(data, workbookEntry))
    const doc = new DOMParser().parseFromString(workbookXml, 'application/xml')
    const sheetElement = doc.getElementsByTagNameNS('*', 'sheet')[0]
    const relId = sheetElement?.getAttribute('r:id') ?? sheetElement?.getAttributeNS('*', 'id')
    const relsEntry = bySuffix('workbook.xml.rels')
    if (relId && relsEntry) {
      const relsXml = decodeName(await readZipEntryData(data, relsEntry))
      const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml')
      const relationships = relsDoc.getElementsByTagNameNS('*', 'Relationship')
      for (let index = 0; index < relationships.length; index += 1) {
        if (relationships[index].getAttribute('Id') === relId) {
          const target = relationships[index].getAttribute('Target') ?? ''
          sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
        }
      }
    }
  }

  const sheetEntry = find(sheetPath) ?? bySuffix('worksheets/sheet1.xml') ?? bySuffix('sheet1.xml')
  if (!sheetEntry) throw new Error('xlsx 中没有找到工作表，请在 Excel 中确认后重试')

  const stringsEntry = find('xl/sharedStrings.xml') ?? bySuffix('sharedStrings.xml')
  const sharedStrings = stringsEntry
    ? parseSharedStrings(decodeName(await readZipEntryData(data, stringsEntry)))
    : []
  const sheetXml = decodeName(await readZipEntryData(data, sheetEntry))
  return parseSheetRows(sheetXml, sharedStrings)
}

export function isXlsxFile(file: File): boolean {
  return /\.xlsx$/i.test(file.name) || file.type.includes('spreadsheetml')
}