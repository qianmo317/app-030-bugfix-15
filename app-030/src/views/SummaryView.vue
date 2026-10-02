<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, getProject, getRule, store } from '../logic/store'
import { buildSummary, conservationText } from '../logic/merge'
import { exportBaseName, stockAdviceRows, summaryRowLabel } from '../logic/exporter'
import { downloadText, toCsvText } from '../logic/csv'
import type { Gender } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

const expandedUnits = ref<string[]>([])
const showAllRows = ref(false)

function toggleUnit(orgUnit: string): void {
  if (expandedUnits.value.includes(orgUnit)) {
    expandedUnits.value = expandedUnits.value.filter((item) => item !== orgUnit)
  } else {
    expandedUnits.value = [...expandedUnits.value, orgUnit]
  }
}

const genderText = (gender: Gender | string): string => (gender === 'male' ? '男' : '女')

const totalQty = computed(() => summary.value?.totals.accountedQty ?? 0)

const rowLimit = 80
const visibleRows = computed(() => {
  const rows = summary.value?.allRows ?? []
  return showAllRows.value ? rows : rows.slice(0, rowLimit)
})

function exportStockAdvice(): void {
  const current = project.value
  const snapshot = summary.value
  if (!current || !snapshot) return
  const context = {
    project: current,
    rule: rule.value,
    summary: snapshot,
    operator: store.operator,
    generatedAt: new Date()
  }
  downloadText(toCsvText(stockAdviceRows(context)), exportBaseName(context, '号型分布与备货建议', 'csv'))
}
</script>

<template>
  <section v-if="!project || !summary" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 汇总表与守恒校验</h1>
        <div class="sub">
          依据规则版本 <b>{{ project.ruleVersion }}</b>（{{ rule.label }}）｜ 号型 × 性别 × 数量，含班级/车间小计与批次合计
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <button class="btn btn-sm" type="button" @click="exportStockAdvice">导出分布与备货建议 CSV</button>
        <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">返回归并</RouterLink>
        <RouterLink class="btn btn-sm btn-primary" :to="`/export/${project.id}`">去导出</RouterLink>
      </div>
    </div>

    <div class="card" :class="summary.conserved ? 'card-accent-ok' : 'card-accent-danger'">
      <div class="card-head">
        <h2>守恒校验</h2>
        <div class="spacer"></div>
        <span class="badge" :class="summary.conserved ? 'badge-ok' : 'badge-danger'">
          {{ summary.conserved ? '通过：可以导出下单表' : '不通过：禁止导出下单表' }}
        </span>
      </div>
      <div class="card-body">
        <div class="equation" :class="summary.conserved ? 'equation-ok' : 'equation-bad'">
          {{ conservationText(summary) }}
        </div>
        <p class="hint" style="margin-top: 8px">
          等式说明：有效人数 = 总录入 {{ summary.totals.totalRows }} − 无效行 {{ summary.totals.invalidRows }} − 重复行
          {{ summary.totals.duplicateRows }} = <b>{{ summary.totals.validRows }}</b>；常规档 {{ summary.totals.regularQty }} +
          特殊单列 {{ summary.totals.specialQty }} = <b>{{ summary.totals.accountedQty }}</b>
        </p>

        <div v-if="!summary.conserved" style="margin-top: 10px">
          <h4>差异明细（{{ summary.unmerged.length }} 行未归并）</h4>
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
                      跳到归并页处理
                    </RouterLink>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><div class="stat-label">总录入行数</div><div class="stat-value">{{ summary.totals.totalRows }}</div></div>
          <div class="stat"><div class="stat-label">有效人数</div><div class="stat-value">{{ summary.totals.validRows }}</div></div>
          <div class="stat"><div class="stat-label">总套数（常规+特殊）</div><div class="stat-value">{{ totalQty }}</div></div>
          <div class="stat"><div class="stat-label">无效行</div><div class="stat-value">{{ summary.totals.invalidRows }}</div></div>
          <div class="stat"><div class="stat-label">重复行</div><div class="stat-value">{{ summary.totals.duplicateRows }}</div></div>
          <div class="stat"><div class="stat-label">按规则归并</div><div class="stat-value">{{ summary.totals.ruleResolvedCount }}</div></div>
          <div class="stat"><div class="stat-label">人工覆写</div><div class="stat-value">{{ summary.totals.overrideCount }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列</div><div class="stat-value">{{ summary.totals.specialQty }}</div></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>下单汇总表（号型 × 性别 × 数量）</h2>
        <div class="spacer"></div>
        <span class="badge badge-info">共 {{ summary.allRows.length }} 个号型档</span>
        <span v-if="!showAllRows && summary.allRows.length > rowLimit" class="badge">
          已显示前 {{ rowLimit }} 档
        </span>
        <button v-if="!showAllRows && summary.allRows.length > rowLimit" class="btn btn-sm" type="button" @click="showAllRows = true">
          显示全部
        </button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>号型</th>
              <th>性别</th>
              <th>类型</th>
              <th class="num">数量</th>
              <th class="num">占比</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="`${row.isSpecial}-${row.sizeCode}-${row.gender}`">
              <td><b>{{ summaryRowLabel(rule, row) }}</b></td>
              <td>{{ genderText(row.gender) }}</td>
              <td>
                <span class="badge" :class="row.isSpecial ? 'badge-warn' : 'badge-info'">
                  {{ row.isSpecial ? '特殊单列' : '常规档' }}
                </span>
              </td>
              <td class="num">{{ row.qty }}</td>
              <td class="num">{{ totalQty > 0 ? ((row.qty / totalQty) * 100).toFixed(1) : '0.0' }}%</td>
            </tr>
            <tr class="row-subtotal">
              <td colspan="3">合计（常规 {{ summary.totals.regularQty }} + 特殊 {{ summary.totals.specialQty }}）</td>
              <td class="num">{{ totalQty }}</td>
              <td class="num">100.0%</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>按班级 / 车间小计（点击展开该单位的号型明细）</h3>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>班级/车间</th>
              <th class="num">有效人数</th>
              <th class="num">无效/排除</th>
              <th class="num">常规档</th>
              <th class="num">特殊单列</th>
              <th class="num">小计</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="group in summary.byOrgUnit" :key="group.orgUnit">
              <tr>
                <td>{{ group.orgUnit }}</td>
                <td class="num">{{ group.validCount }}</td>
                <td class="num">{{ group.invalidCount }}</td>
                <td class="num">{{ group.regularQty }}</td>
                <td class="num">{{ group.specialQty }}</td>
                <td class="num"><b>{{ group.regularQty + group.specialQty }}</b></td>
                <td>
                  <button class="btn btn-sm" type="button" @click="toggleUnit(group.orgUnit)">
                    {{ expandedUnits.includes(group.orgUnit) ? '收起' : '展开' }}
                  </button>
                </td>
              </tr>
              <tr v-if="expandedUnits.includes(group.orgUnit)">
                <td colspan="7">
                  <div class="pill-list">
                    <span v-for="row in group.rows" :key="`${row.sizeCode}-${row.gender}`" class="badge">
                      {{ summaryRowLabel(rule, row) }} / {{ genderText(row.gender) }}：{{ row.qty }}
                    </span>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="summary.byOrgUnit.length === 0" class="row-subtotal">
              <td colspan="7">暂无数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="project.batches.length > 1" class="card">
      <div class="card-head">
        <h3>多批次分别归并与合计</h3>
        <div class="spacer"></div>
        <span class="hint">春装 / 秋装两批分别归并，合计仍与守恒等式一致</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>批次</th>
              <th class="num">有效人数</th>
              <th class="num">常规档</th>
              <th class="num">特殊单列</th>
              <th class="num">小计</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="group in summary.byBatch" :key="group.batch">
              <td>{{ group.batch }}</td>
              <td class="num">{{ group.validCount }}</td>
              <td class="num">{{ group.regularQty }}</td>
              <td class="num">{{ group.specialQty }}</td>
              <td class="num">{{ group.regularQty + group.specialQty }}</td>
            </tr>
            <tr class="row-subtotal">
              <td>合计</td>
              <td class="num">{{ summary.totals.validRows }}</td>
              <td class="num">{{ summary.totals.regularQty }}</td>
              <td class="num">{{ summary.totals.specialQty }}</td>
              <td class="num">{{ totalQty }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>号型分布与备货建议（仅数据，不做可视化看板）</h3>
        <div class="spacer"></div>
        <span class="hint">建议备货 = 实际数量 × 比例（常规档 +5%，特殊单列 +10%），向上取整且不少于 1 套</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">排名</th>
              <th>号型</th>
              <th>性别</th>
              <th class="num">实际数量</th>
              <th class="num">占比</th>
              <th class="num">建议比例</th>
              <th class="num">建议备货</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in summary.distribution" :key="`${row.sizeCode}-${row.gender}-${index}`">
              <td class="num">{{ index + 1 }}</td>
              <td>{{ summaryRowLabel(rule, row) }}</td>
              <td>{{ genderText(row.gender) }}</td>
              <td class="num">{{ row.qty }}</td>
              <td class="num">{{ (row.ratio * 100).toFixed(1) }}%</td>
              <td class="num">{{ Math.round((1 + row.marginRatio) * 100) }}%</td>
              <td class="num">{{ row.suggestion }}</td>
            </tr>
            <tr v-if="summary.distribution.length === 0" class="row-subtotal">
              <td colspan="7">暂无数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>