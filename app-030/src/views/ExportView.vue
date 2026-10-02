<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, store } from '../logic/store'
import { buildSummary, conservationText } from '../logic/merge'
import {
  buildOrderSheet,
  detailRows,
  detailWorkbookSheets,
  exportBaseName,
  orderSheetToRows,
  orderWorkbookSheets,
  personStatusLabel,
  specialRows,
  stockAdviceRows,
  summaryRowLabel
} from '../logic/exporter'
import { downloadBlob, downloadText, toCsvText } from '../logic/csv'
import { buildXlsxBlob } from '../logic/xlsx'
import { chestWaistDiffCm, formatCm } from '../logic/precision'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))
const message = ref('')

function context() {
  const current = project.value
  const snapshot = summary.value
  if (!current || !snapshot) return null
  return {
    project: current,
    rule: rule.value,
    summary: snapshot,
    operator: store.operator,
    generatedAt: new Date()
  }
}

const orderSheet = computed(() => {
  const ctx = context()
  return ctx ? buildOrderSheet(ctx) : null
})

const blocked = computed(() => !summary.value?.conserved)

async function prepare(): Promise<boolean> {
  const current = project.value
  if (!current) return false
  ensureMerged(current)
  await flushProject(current)
  return true
}

function notify(text: string): void {
  message.value = text
}

async function exportOrderXlsx(): Promise<void> {
  const ctx = context()
  if (!ctx || blocked.value || !(await prepare())) return
  const sheets = orderWorkbookSheets(ctx)
  const fileName = exportBaseName(ctx, '下单汇总表', 'xlsx')
  downloadBlob(buildXlsxBlob(sheets), fileName)
  notify(`已导出下单汇总表（Excel）：${orderSheetToRows(buildOrderSheet(ctx)).length} 行 → ${fileName}`)
}

async function exportOrderCsv(): Promise<void> {
  const ctx = context()
  if (!ctx || blocked.value || !(await prepare())) return
  const fileName = exportBaseName(ctx, '下单汇总表', 'csv')
  downloadText(toCsvText(orderSheetToRows(buildOrderSheet(ctx))), fileName)
  notify(`已导出下单汇总表（CSV）→ ${fileName}`)
}

async function exportDetailXlsx(): Promise<void> {
  const ctx = context()
  if (!ctx || !(await prepare())) return
  const sheets = detailWorkbookSheets(ctx)
  const fileName = exportBaseName(ctx, '量体明细与特殊体型清单', 'xlsx')
  downloadBlob(buildXlsxBlob(sheets), fileName)
  notify(`已导出量体明细（含号型结果，共 ${project.value?.persons.length ?? 0} 行）与特殊体型清单 → ${fileName}`)
}

async function exportDetailCsv(): Promise<void> {
  const ctx = context()
  if (!ctx || !(await prepare())) return
  const rows = detailRows(ctx)
  const fileName = exportBaseName(ctx, '量体明细', 'csv')
  downloadText(toCsvText(rows), fileName)
  notify(`已导出量体明细（CSV，${rows.length - 1} 条记录，可直接回贴给学校核对）→ ${fileName}`)
}

async function exportSpecialCsv(): Promise<void> {
  const ctx = context()
  if (!ctx || !(await prepare())) return
  const rows = specialRows(ctx)
  const fileName = exportBaseName(ctx, '特殊体型清单', 'csv')
  downloadText(toCsvText(rows), fileName)
  notify(`已导出特殊体型清单（CSV，${rows.length - 1} 条）→ ${fileName}`)
}

async function exportStockCsv(): Promise<void> {
  const ctx = context()
  if (!ctx || !(await prepare())) return
  const fileName = exportBaseName(ctx, '号型分布与备货建议', 'csv')
  downloadText(toCsvText(stockAdviceRows(ctx)), fileName)
  notify(`已导出号型分布与备货建议（CSV）→ ${fileName}`)
}

async function printPreview(): Promise<void> {
  if (blocked.value || !(await prepare())) return
  window.print()
}

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')
</script>

<template>
  <section v-if="!project || !summary || !orderSheet" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head no-print">
      <div>
        <h1>{{ project.name }} · 下单表与明细导出</h1>
        <div class="sub">
          依据规则版本 <b>{{ project.ruleVersion }}</b>（{{ rule.label }}）｜ 总录入 {{ summary.totals.totalRows }} ｜
          有效 {{ summary.totals.validRows }} ｜ 总套数 {{ summary.totals.accountedQty }}
        </div>
      </div>
    </div>

    <div v-if="blocked" class="card card-accent-danger no-print">
      <div class="card-head">
        <h2>守恒校验未通过，导出已被阻止</h2>
        <div class="spacer"></div>
        <span class="badge badge-danger">{{ summary.unmerged.length }} 行未归并</span>
      </div>
      <div class="card-body">
        <p class="notice notice-error">{{ conservationText(summary) }} —— 汇总表数量与有效人数不一致，服装厂无法接单。</p>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">行号</th>
                <th>姓名</th>
                <th>班级/车间</th>
                <th>未归并原因</th>
                <th>跳转处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="diff in summary.unmerged" :key="diff.personId">
                <td class="num">{{ diff.sourceRow ?? '—' }}</td>
                <td>{{ diff.name }}</td>
                <td>{{ diff.orgUnit || '—' }}</td>
                <td>{{ diff.reason }}</td>
                <td>
                  <RouterLink
                    class="clickable"
                    :to="{ path: `/merge/${project.id}`, query: diff.sourceRow ? { row: String(diff.sourceRow) } : {} }"
                  >
                    去归并页处理
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-head">
        <h2>导出（守恒通过才允许导出下单表）</h2>
        <div class="spacer"></div>
        <span class="badge" :class="summary.conserved ? 'badge-ok' : 'badge-danger'">
          {{ summary.conserved ? '守恒通过' : '不守恒 · 按钮已禁用' }}
        </span>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <button class="btn btn-primary" type="button" :disabled="blocked" @click="exportOrderXlsx">
            下单汇总表（Excel）
          </button>
          <button class="btn" type="button" :disabled="blocked" @click="exportOrderCsv">下单汇总表（CSV）</button>
          <button class="btn btn-accent" type="button" :disabled="blocked" @click="printPreview">
            打印预览 / 另存为 PDF
          </button>
          <div class="spacer"></div>
          <button class="btn" type="button" @click="exportDetailXlsx">量体明细（Excel）</button>
          <button class="btn" type="button" @click="exportDetailCsv">量体明细（CSV，可回贴核对）</button>
          <button class="btn" type="button" @click="exportSpecialCsv">特殊体型清单（CSV）</button>
          <button class="btn" type="button" @click="exportStockCsv">号型分布与备货建议（CSV）</button>
        </div>
        <p v-if="message" class="notice notice-ok" style="margin-top: 10px">{{ message }}</p>
        <p class="hint" style="margin-top: 8px">
          导出的下单汇总表与下方「与导出一致的明细」逐行相同；量体明细含号型结果与覆写留痕，可直接打印回贴给学校核对。
        </p>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-head">
        <h3>导出文件内容预览（与导出的 Excel / CSV 逐行一致）</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">常规 {{ summary.totals.regularQty }} + 特殊 {{ summary.totals.specialQty }} = {{ summary.totals.accountedQty }}</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">序号</th>
              <th>号型</th>
              <th>性别</th>
              <th>类型</th>
              <th class="num">数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in orderSheet.items" :key="item.index">
              <td class="num">{{ item.index }}</td>
              <td>{{ item.sizeLabel }}</td>
              <td>{{ item.gender }}</td>
              <td>{{ item.kind }}</td>
              <td class="num">{{ item.qty }}</td>
            </tr>
            <tr class="row-subtotal">
              <td colspan="4">合计（有效人数 {{ orderSheet.totalPeople }}）</td>
              <td class="num">{{ orderSheet.totalQty }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-head">
        <h3>人工覆写与归并方式说明</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">按规则归并 {{ summary.totals.ruleResolvedCount }} 条</span>
        <span class="badge badge-warn">人工覆写 {{ summary.totals.overrideCount }} 条</span>
      </div>
      <div class="card-body tight">
        <div v-if="summary.totals.overrideCount === 0" class="hint">本次没有人工覆写，全部号型均由规则自动归并。</div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">行号</th>
                <th>姓名</th>
                <th>按规则归并</th>
                <th>覆写后</th>
                <th>操作人</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="person in project.persons.filter((item) => item.result?.manualOverride)" :key="person.id">
                <td class="num">{{ person.sourceRow ?? '—' }}</td>
                <td>{{ person.name }}</td>
                <td>{{ person.result?.ruleSizeCode || '规则未覆盖' }}</td>
                <td><b>{{ person.result?.sizeCode }}</b></td>
                <td>{{ person.result?.manualOverride?.by }}</td>
                <td>{{ person.result?.manualOverride?.reason }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-head">
        <h3>特殊体型清单（{{ summary.totals.specialQty }} 套 · {{ summary.totals.specialPersonCount }} 人）</h3>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>性别</th>
              <th>班级/车间</th>
              <th class="num">身高</th>
              <th class="num">胸围</th>
              <th class="num">腰围</th>
              <th class="num">胸腰差</th>
              <th>标记</th>
              <th>规则号型</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in project.persons.filter((item) => item.specialFlag)" :key="person.id">
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ genderText(person.gender) }}</td>
              <td>{{ person.orgUnit || '—' }}</td>
              <td class="num">{{ formatCm(person.heightCm) }}</td>
              <td class="num">{{ formatCm(person.chestCm) }}</td>
              <td class="num">{{ formatCm(person.waistCm) }}</td>
              <td class="num">
                {{ person.chestCm > 0 && person.waistCm > 0 ? formatCm(chestWaistDiffCm(person.chestCm, person.waistCm)) : '—' }}
              </td>
              <td>{{ summaryRowLabel(rule, { sizeCode: person.specialFlag ?? '', gender: person.gender, qty: 1, isSpecial: true }) }}</td>
              <td>{{ person.result?.sizeCode || '规则未覆盖' }}</td>
            </tr>
            <tr v-if="summary.totals.specialPersonCount === 0">
              <td colspan="10">没有特殊体型记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card no-print">
      <div class="card-head">
        <h3>量体明细前 30 行（导出文件包含全部 {{ project.persons.length }} 行）</h3>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>性别</th>
              <th>班级/车间</th>
              <th class="num">身高</th>
              <th class="num">胸围</th>
              <th class="num">腰围</th>
              <th>规则号型</th>
              <th>生效号型</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in project.persons.slice(0, 30)" :key="person.id">
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ genderText(person.gender) }}</td>
              <td>{{ person.orgUnit || '—' }}</td>
              <td class="num">{{ formatCm(person.heightCm) }}</td>
              <td class="num">{{ formatCm(person.chestCm) }}</td>
              <td class="num">{{ formatCm(person.waistCm) }}</td>
              <td>{{ person.result?.ruleSizeCode || '未归并' }}</td>
              <td>{{ person.result?.sizeCode || '—' }}</td>
              <td>{{ personStatusLabel(person) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>打印预览（A4 · 下单汇总表）</h3>
        <div class="spacer"></div>
        <span class="hint no-print">点「打印预览 / 另存为 PDF」后，浏览器打印对话框里选择「另存为 PDF」即可生成 PDF</span>
      </div>
      <div class="card-body">
        <div class="print-sheet">
          <h2>服装量体下单汇总表</h2>
          <div class="print-sub">
            项目：{{ project.name }} ｜ 号型规则版本：{{ rule.version }} ｜ 打印时间：{{ new Date().toLocaleString('zh-CN') }}
          </div>
          <div class="print-meta">
            <div>录入 / 导出人：{{ store.operator || '—' }}</div>
            <div>守恒校验：{{ conservationText(summary) }}</div>
            <div>总录入：{{ summary.totals.totalRows }} 人</div>
            <div>有效人数：{{ summary.totals.validRows }} 人（无效 {{ summary.totals.invalidRows }} / 重复 {{ summary.totals.duplicateRows }}）</div>
            <div>常规档合计：{{ summary.totals.regularQty }} 套</div>
            <div>特殊单列合计：{{ summary.totals.specialQty }} 套</div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 48px">序号</th>
                <th>号型</th>
                <th style="width: 64px">性别</th>
                <th style="width: 84px">类型</th>
                <th style="width: 72px">数量</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in orderSheet.items" :key="item.index">
                <td>{{ item.index }}</td>
                <td>{{ item.sizeLabel }}</td>
                <td>{{ item.gender }}</td>
                <td>{{ item.kind }}</td>
                <td class="num">{{ item.qty }}</td>
              </tr>
              <tr>
                <td colspan="4">合计（有效人数 {{ orderSheet.totalPeople }}）</td>
                <td class="num">{{ orderSheet.totalQty }}</td>
              </tr>
            </tbody>
          </table>
          <div class="print-sign">
            <span>制表：{{ store.operator || '—' }}</span>
            <span>厂方确认：________________</span>
            <span>日期：{{ new Date().toLocaleDateString('zh-CN') }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>