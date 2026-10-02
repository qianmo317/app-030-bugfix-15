<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { flushProject, getProject, getRule, store } from '../logic/store'
import {
  EMPTY_MAPPING,
  IMPORT_FIELDS,
  IMPORT_TEMPLATE_HEADER,
  IMPORT_TEMPLATE_SAMPLE,
  applyImport,
  buildDryRun,
  detectHeaderRow,
  guessMapping,
  mappedCount,
  type ColumnMapping,
  type DryRun
} from '../logic/importPlan'
import { fnv1a, parseDelimitedText, readFileAsText, downloadText, toCsvText } from '../logic/csv'
import { isXlsxFile, readXlsxRows } from '../logic/xlsx'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileSize = ref(0)
const fingerprint = ref('')
const rawRows = ref<string[][]>([])
const headerIndex = ref(-1)
const mapping = ref<ColumnMapping>({ ...EMPTY_MAPPING })
const previewStale = ref(false)
const dryRun = ref<DryRun | null>(null)
const parseMs = ref(0)
const fileError = ref('')
const resultText = ref('')
const dragActive = ref(false)
const filterKind = ref<'all' | 'new' | 'update' | 'invalid' | 'error' | 'duplicate'>('all')
const showAll = ref(false)

const RENDER_LIMIT = 200

const dataRowCount = computed(() => {
  if (headerIndex.value < 0) return 0
  return Math.max(0, rawRows.value.length - headerIndex.value - 1)
})

const requiredMissing = computed(() =>
  IMPORT_FIELDS.filter((field) => field.required && mapping.value[field.key] === null).map((field) => field.label)
)

const headerCells = computed(() =>
  headerIndex.value >= 0 ? rawRows.value[headerIndex.value] ?? [] : rawRows.value[0] ?? []
)

const rawPreview = computed(() => {
  if (headerIndex.value < 0) return []
  return rawRows.value.slice(headerIndex.value, headerIndex.value + 6)
})

const alreadyImported = computed(() => {
  if (!project.value || !fingerprint.value) return false
  return project.value.imports.some((record) => record.fingerprint === fingerprint.value)
})

const importableCount = computed(() => {
  if (!dryRun.value) return 0
  return dryRun.value.counts.new + dryRun.value.counts.update + dryRun.value.counts.invalid
})

const filteredRows = computed(() => {
  const rows = dryRun.value?.rows ?? []
  const filtered = rows.filter((row) => {
    if (filterKind.value === 'all') return true
    if (filterKind.value === 'duplicate') return row.duplicateOf !== null
    return row.kind === filterKind.value
  })
  return showAll.value ? filtered : filtered.slice(0, RENDER_LIMIT)
})

const hiddenCount = computed(() => {
  const rows = dryRun.value?.rows ?? []
  const filtered = rows.filter((row) => {
    if (filterKind.value === 'all') return true
    if (filterKind.value === 'duplicate') return row.duplicateOf !== null
    return row.kind === filterKind.value
  })
  return showAll.value ? 0 : Math.max(0, filtered.length - RENDER_LIMIT)
})

watch(mapping, () => {
  if (dryRun.value) previewStale.value = true
})

function resetAll(): void {
  rawRows.value = []
  headerIndex.value = -1
  mapping.value = { ...EMPTY_MAPPING }
  dryRun.value = null
  previewStale.value = false
  fileName.value = ''
  fileSize.value = 0
  fingerprint.value = ''
  parseMs.value = 0
  fileError.value = ''
  resultText.value = ''
  filterKind.value = 'all'
  showAll.value = false
}

async function handleFile(file: File): Promise<void> {
  resetAll()
  fileName.value = file.name
  fileSize.value = file.size
  const started = performance.now()
  try {
    let rows: string[][]
    let contentKey = ''
    if (isXlsxFile(file)) {
      rows = await readXlsxRows(file)
      contentKey = rows.map((row) => row.join('\u0001')).join('\u0002')
    } else {
      const text = await readFileAsText(file)
      rows = parseDelimitedText(text)
      contentKey = text
    }
    if (rows.length === 0) {
      fileError.value = '文件里没有可识别的数据行'
      return
    }
    rawRows.value = rows
    fingerprint.value = `${file.name}|${file.size}|${fnv1a(contentKey)}`
    const detected = detectHeaderRow(rows)
    if (detected < 0) {
      fileError.value = '未能识别表头行（前 8 行未找到姓名/性别/身高/胸围/腰围等列名），请检查文件或改用导入模板'
      return
    }
    headerIndex.value = detected
    mapping.value = guessMapping(rows[detected])
    parseMs.value = Math.round((performance.now() - started) * 100) / 100
  } catch (error) {
    fileError.value = error instanceof Error ? error.message : String(error)
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void handleFile(file)
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void handleFile(file)
}

function buildPreview(): void {
  resultText.value = ''
  fileError.value = ''
  if (!project.value) return
  if (headerIndex.value < 0) {
    fileError.value = '请先选择文件'
    return
  }
  if (requiredMissing.value.length > 0) {
    fileError.value = `必填列未映射：${requiredMissing.value.join('、')}`
    return
  }
  const started = performance.now()
  const rows = rawRows.value
    .slice(headerIndex.value + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex.value + index + 2 }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
  dryRun.value = buildDryRun(rows, mapping.value, project.value, rule.value, fileName.value, fingerprint.value)
  parseMs.value = Math.round((performance.now() - started) * 100) / 100
  previewStale.value = false
  showAll.value = false
}

async function confirmImport(): Promise<void> {
  const current = project.value
  const preview = dryRun.value
  if (!current || !preview) return
  if (alreadyImported.value) {
    fileError.value = '该文件指纹已导入过，为避免重复写入已阻止（同一文件幂等）'
    return
  }
  const applied = applyImport(current, preview, rule.value)
  current.perf = {
    ...(current.perf ?? {}),
    importParseMs: preview.durationMs,
    importRows: preview.counts.total
  }
  await flushProject(current)
  resultText.value = `导入完成：新增 ${applied.added} 条、更新 ${applied.updated} 条、无效（待确认）${applied.invalid} 条、跳过错误行 ${applied.skipped} 条；文件指纹 ${preview.fingerprint} 已登记，重传同一文件不会重复写入。`
  dryRun.value = null
}

function downloadTemplate(): void {
  downloadText(toCsvText([IMPORT_TEMPLATE_HEADER, ...IMPORT_TEMPLATE_SAMPLE]), '量体导入模板.csv')
  resultText.value = '模板已下载：表头为 姓名 / 性别 / 班级 / 批次 / 身高(cm) / 体重(kg) / 胸围(cm) / 腰围(cm) / 特殊体型 / 备注'
}

function kindLabel(kind: string): string {
  if (kind === 'new') return '新增'
  if (kind === 'update') return '更新'
  if (kind === 'invalid') return '无效（待确认）'
  return '错误（跳过）'
}

function kindBadge(kind: string): string {
  if (kind === 'new') return 'badge-ok'
  if (kind === 'update') return 'badge-info'
  if (kind === 'invalid') return 'badge-warn'
  return 'badge-danger'
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 批量导入</h1>
        <div class="sub">
          两步式 dry_run：先预览（新增 / 更新 / 无效 / 错误行），再正式导入；同一文件指纹幂等，重传不会重复
        </div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-sm" type="button" @click="downloadTemplate">下载导入模板 CSV</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>第一步：选择文件（CSV / TSV / Excel .xlsx）</h2>
        <div class="spacer"></div>
        <span v-if="fileName" class="badge badge-info">{{ fileName }}（{{ formatSize(fileSize) }}）</span>
      </div>
      <div class="card-body">
        <div
          style="border: 1px dashed var(--line); border-radius: 10px; padding: 18px; text-align: center"
          :style="dragActive ? 'border-color: var(--brand); background: #f4f8fc' : ''"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          <p>把量体表拖到这里，或</p>
          <input ref="fileInput" type="file" accept=".csv,.txt,.tsv,.xlsx" style="display: none" @change="onFileChange" />
          <button class="btn btn-primary" type="button" @click="fileInput?.click()">选择文件</button>
          <p class="hint" style="margin-top: 8px">
            文件在本机解析，不会上传；列名支持模糊匹配（身高 / height、胸围 / chest、班级 / 车间…）
          </p>
        </div>

        <p v-if="fileError" class="notice notice-error" style="margin-top: 12px">{{ fileError }}</p>
        <p v-if="resultText" class="notice notice-ok" style="margin-top: 12px">{{ resultText }}</p>

        <div v-if="headerIndex >= 0" style="margin-top: 12px">
          <div class="stat-row">
            <div class="stat">
              <div class="stat-label">识别表头行</div>
              <div class="stat-value">第 {{ headerIndex + 1 }} 行</div>
            </div>
            <div class="stat">
              <div class="stat-label">数据行数</div>
              <div class="stat-value">{{ dataRowCount }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">已映射列</div>
              <div class="stat-value">{{ mappedCount(mapping) }}/{{ IMPORT_FIELDS.length }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">解析耗时</div>
              <div class="stat-value">{{ parseMs }} ms</div>
            </div>
          </div>

          <h4 style="margin-top: 12px">列映射（请确认后生成预览）</h4>
          <div class="form-grid">
            <label v-for="field in IMPORT_FIELDS" :key="field.key" class="field">
              <span class="field-label">
                {{ field.label }}
                <b v-if="field.required" class="req">*</b>
              </span>
              <select v-model.number="mapping[field.key]" class="select" :class="{ error: field.required && mapping[field.key] === null }">
                <option :value="null">（忽略此列）</option>
                <option v-for="(cell, index) in headerCells" :key="index" :value="index">
                  第 {{ index + 1 }} 列：{{ cell || '(空列名)' }}
                </option>
              </select>
            </label>
          </div>

          <div class="table-wrap" style="margin-top: 12px">
            <table class="data-table">
              <thead>
                <tr>
                  <th>原始行</th>
                  <th v-for="(cell, index) in headerCells" :key="index">{{ cell || `第${index + 1}列` }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in rawPreview" :key="rowIndex">
                  <td>{{ headerIndex + rowIndex + 1 }}</td>
                  <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-primary" type="button" @click="buildPreview">确认映射并生成 dry_run 预览</button>
            <span v-if="requiredMissing.length" class="hint">必填列未映射：{{ requiredMissing.join('、') }}</span>
            <span v-else-if="previewStale" class="hint">列映射已修改，请重新生成预览</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="dryRun" class="card">
      <div class="card-head">
        <h2>第二步：dry_run 预览（未写入）</h2>
        <div class="spacer"></div>
        <span class="badge">指纹 {{ dryRun.fingerprint }}</span>
        <span class="badge">{{ dryRun.durationMs }} ms</span>
      </div>
      <div class="card-body">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">总行数</div><div class="stat-value">{{ dryRun.counts.total }}</div></div>
          <div class="stat"><div class="stat-label">新增</div><div class="stat-value ok">{{ dryRun.counts.new }}</div></div>
          <div class="stat"><div class="stat-label">更新</div><div class="stat-value">{{ dryRun.counts.update }}</div></div>
          <div class="stat"><div class="stat-label">无效（待确认）</div><div class="stat-value">{{ dryRun.counts.invalid }}</div></div>
          <div class="stat"><div class="stat-label">错误（跳过）</div><div class="stat-value bad">{{ dryRun.counts.error }}</div></div>
          <div class="stat"><div class="stat-label">可能重复</div><div class="stat-value">{{ dryRun.counts.duplicate }}</div></div>
        </div>

        <p v-if="dryRun.counts.error > 0" class="notice notice-error" style="margin-top: 12px">
          {{ dryRun.counts.error }} 条错误行已精确定位（见下表行号与原因），正式导入时会跳过；请修正后重传。
        </p>
        <p v-if="dryRun.counts.duplicate > 0" class="notice notice-warn" style="margin-top: 12px">
          {{ dryRun.counts.duplicate }} 条疑似重复行（同名 + 同班级 + 同身高体重）只做提示，不会自动删除，导入后可在归并页处理。
        </p>
        <p v-if="alreadyImported" class="notice notice-warn" style="margin-top: 12px">
          该文件指纹此前已导入过，正式导入已被阻止（同一文件幂等，避免重复写入）。
        </p>

        <div class="toolbar" style="margin-top: 12px">
          <label class="field" style="max-width: 220px">
            <span class="field-label">筛选</span>
            <select v-model="filterKind" class="select">
              <option value="all">全部行</option>
              <option value="new">仅新增</option>
              <option value="update">仅更新</option>
              <option value="invalid">仅无效（待确认）</option>
              <option value="error">仅错误行</option>
              <option value="duplicate">仅可能重复</option>
            </select>
          </label>
          <button class="btn btn-primary" type="button" :disabled="alreadyImported || importableCount === 0" @click="confirmImport">
            确认导入（{{ importableCount }} 条）
          </button>
          <span v-if="hiddenCount" class="hint">为保持流畅仅显示前 {{ RENDER_LIMIT }} 行</span>
          <button v-if="hiddenCount" class="btn btn-sm" type="button" @click="showAll = true">显示全部 {{ dryRun.rows.length }} 行</button>
          <div class="spacer"></div>
          <span class="hint">更新规则：「姓名 + 班级/车间」相同的既有记录会被更新，不会新增重复人</span>
        </div>

        <div class="table-scroll" style="margin-top: 10px">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">行号</th>
                <th>类型</th>
                <th>姓名</th>
                <th>性别</th>
                <th>班级/车间</th>
                <th class="num">身高</th>
                <th class="num">胸围</th>
                <th class="num">腰围</th>
                <th>原因 / 提示</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.lineNo" :class="row.kind === 'error' ? 'row-invalid' : ''">
                <td class="num">{{ row.lineNo }}</td>
                <td>
                  <span class="badge" :class="kindBadge(row.kind)">{{ kindLabel(row.kind) }}</span>
                  <span v-if="row.duplicateOf" class="badge badge-warn" style="margin-left: 4px">可能重复</span>
                </td>
                <td>{{ row.draft ? row.draft.name : row.raw[0] }}</td>
                <td>{{ row.draft?.gender === 'male' ? '男' : row.draft?.gender === 'female' ? '女' : '—' }}</td>
                <td>{{ row.draft?.orgUnit || '—' }}</td>
                <td class="num">{{ row.draft?.heightCm ?? '—' }}</td>
                <td class="num">{{ row.draft?.chestCm ?? '—' }}</td>
                <td class="num">{{ row.draft?.waistCm ?? '—' }}</td>
                <td>
                  {{ row.reason }}
                  <span v-if="row.duplicateOf" style="color: var(--warn)">（与 {{ row.duplicateOf }} 可能重复）</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>导入记录（指纹幂等台账）</h3></div>
      <div v-if="project.imports.length === 0" class="empty">还没有导入记录</div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>文件</th>
              <th>指纹</th>
              <th class="num">行数</th>
              <th class="num">新增</th>
              <th class="num">更新</th>
              <th class="num">无效</th>
              <th class="num">跳过</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in [...project.imports].reverse()" :key="record.fingerprint + record.at">
              <td>{{ record.fileName }}</td>
              <td><code>{{ record.fingerprint }}</code></td>
              <td class="num">{{ record.rows }}</td>
              <td class="num">{{ record.added }}</td>
              <td class="num">{{ record.updated }}</td>
              <td class="num">{{ record.invalid }}</td>
              <td class="num">{{ record.skipped }}</td>
              <td>{{ new Date(record.at).toLocaleString('zh-CN') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>