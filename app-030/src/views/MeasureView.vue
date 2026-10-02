<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { flushProject, getProject, getRule, persistProject, store } from '../logic/store'
import { analyzeDraft, findDuplicateIds, makePersonId, type PersonDraft } from '../logic/analyze'
import { estimateInitialSize, type EstimateResult } from '../logic/estimate'
import { formatCm, parseLengthCm, parseWeightKg } from '../logic/precision'
import { downloadText, toCsvText } from '../logic/csv'
import { runMerge } from '../logic/merge'
import { detailRows } from '../logic/exporter'
import type { Gender, Person } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

const formRef = ref<HTMLFormElement | null>(null)
const heightRef = ref<HTMLInputElement | null>(null)

const form = reactive({
  name: '',
  gender: 'male' as Gender,
  orgUnit: '',
  batch: '',
  heightCm: '',
  weightKg: '',
  chestCm: '',
  waistCm: '',
  specialFlag: '',
  note: ''
})

const sticky = reactive({ orgUnit: '', gender: 'male' as Gender, batch: '' })
const notice = ref('')
const warnText = ref('')
const savedCount = ref(0)
const saving = ref(false)

watch(
  project,
  (value) => {
    if (!value) return
    sticky.batch = sticky.batch || value.batches[0] || ''
    form.batch = sticky.batch
  },
  { immediate: true }
)

const duplicateIds = computed(() => {
  if (!project.value) return []
  const heightCm = parseLengthCm(form.heightCm)
  const weightKg = parseWeightKg(form.weightKg)
  return findDuplicateIds(
    project.value.persons,
    {
      name: form.name,
      gender: form.gender,
      orgUnit: form.orgUnit,
      batch: form.batch,
      heightCm,
      weightKg,
      chestCm: null,
      waistCm: null,
      specialFlag: null,
      note: '',
      sourceRow: null,
      source: 'manual'
    },
    undefined
  )
})

const duplicateNames = computed(() =>
  duplicateIds.value
    .map((id) => project.value?.persons.find((person) => person.id === id)?.name ?? '')
    .filter((name) => name !== '')
)

const estimate = computed<EstimateResult | null>(() => {
  const heightCm = parseLengthCm(form.heightCm)
  const weightKg = parseWeightKg(form.weightKg)
  return estimateInitialSize(rule.value, form.gender, heightCm, weightKg)
})

const recent = computed<Person[]>(() => {
  const persons = project.value?.persons ?? []
  return [...persons].slice(-6).reverse()
})

function resetForm(): void {
  form.name = ''
  form.heightCm = ''
  form.weightKg = ''
  form.chestCm = ''
  form.waistCm = ''
  form.note = ''
  form.specialFlag = ''
  form.orgUnit = sticky.orgUnit
  form.gender = sticky.gender
  form.batch = sticky.batch
}

function onEnter(event: KeyboardEvent): void {
  const element = event.target as HTMLElement
  const isTextarea = element.tagName === 'TEXTAREA'
  if (isTextarea && event.shiftKey) return
  event.preventDefault()
  const container = formRef.value
  if (!container) return
  const fields = Array.from(container.querySelectorAll<HTMLElement>('[data-field]'))
  const index = fields.indexOf(element)
  if (index >= 0 && index < fields.length - 1) {
    fields[index + 1].focus()
    return
  }
  void save()
}

async function save(): Promise<void> {
  const current = project.value
  if (!current || saving.value) return
  notice.value = ''
  warnText.value = ''
  if (form.name.trim() === '') {
    warnText.value = '请先填写姓名，姓名用于量体明细回贴核对'
    return
  }
  saving.value = true
  const draft: PersonDraft = {
    name: form.name,
    gender: form.gender,
    orgUnit: form.orgUnit,
    batch: form.batch || current.batches[0] || '未分批',
    heightCm: parseLengthCm(form.heightCm),
    weightKg: parseWeightKg(form.weightKg),
    chestCm: parseLengthCm(form.chestCm),
    waistCm: parseLengthCm(form.waistCm),
    specialFlag: form.specialFlag || null,
    note: form.note,
    sourceRow: current.persons.length + 1,
    source: 'manual'
  }
  const outcome = analyzeDraft(draft, rule.value)
  const duplicated = findDuplicateIds(current.persons, draft)
  const person: Person = {
    id: makePersonId(),
    name: draft.name.trim(),
    gender: draft.gender ?? 'male',
    orgUnit: draft.orgUnit.trim(),
    batch: draft.batch,
    heightCm: draft.heightCm ?? 0,
    weightKg: draft.weightKg,
    chestCm: draft.chestCm ?? 0,
    waistCm: draft.waistCm ?? 0,
    specialFlag: draft.specialFlag,
    note: draft.note,
    status: outcome.status,
    statusReason: outcome.statusReason,
    anomaly: outcome.anomaly,
    needsConfirm: outcome.needsConfirm || duplicated.length > 0,
    possibleDuplicateOf: duplicated.length > 0 ? `既有行「${duplicated[0]}」` : null,
    sourceRow: draft.sourceRow,
    source: 'manual',
    result: null,
    createdAt: Date.now()
  }
  current.persons.push(person)
  sticky.orgUnit = person.orgUnit
  sticky.gender = person.gender
  sticky.batch = person.batch
  savedCount.value += 1
  resetForm()
  persistProject(current, true)
  saving.value = false
  notice.value = `第 ${current.persons.length} 条（${person.name}）已保存到本机 IndexedDB，断网也不丢`
  if (outcome.status === 'invalid') {
    warnText.value = `已拦截：${outcome.statusReason}；该行记为无效行，不计入有效人数，可在归并页复核`
  } else if (outcome.messages.length > 0) {
    warnText.value = outcome.messages.join('；')
  } else if (duplicated.length > 0) {
    warnText.value = `可能与「${duplicated[0]}」重复（同名 + 同班级 + 同身高体重），已保留并标记，未自动删除`
  }
  await nextTick()
  heightRef.value?.focus()
}

async function removePerson(person: Person): Promise<void> {
  const current = project.value
  if (!current) return
  current.persons = current.persons.filter((item) => item.id !== person.id)
  persistProject(current, true)
  notice.value = `已删除「${person.name}」`
}

async function exportFallbackCsv(): Promise<void> {
  const current = project.value
  if (!current) return
  runMerge(current, rule.value)
  await flushProject(current)
  const rows = detailRows({ project: current, rule: rule.value })
  downloadText(
    toCsvText(rows),
    `${current.name.replace(/[\\/:*?"<>|\s]/g, '_')}-量体明细-离线兜底.csv`
  )
  notice.value = '已导出本地 CSV（兜底），可直接交给办公室汇总'
}

function focusHeight(): void {
  heightRef.value?.focus()
}

function genderText(gender: Gender): string {
  return gender === 'male' ? '男' : '女'
}
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 量体录入</h1>
        <div class="sub">
          规则版本 {{ project.ruleVersion }} ｜ 已录入 {{ project.persons.length }} 条 ｜
          本机离线保存，回办公室可一次性导出
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/import/${project.id}`">批量导入</RouterLink>
        <button class="btn btn-sm" type="button" @click="exportFallbackCsv">导出 CSV（兜底）</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>连续录入（回车即存下一条）</h2>
        <div class="spacer"></div>
        <span class="hint">光标自动回到身高；同班级数据只需改动身高体重胸腰围</span>
      </div>
      <div class="card-body">
        <form ref="formRef" @submit.prevent="save" @keydown.enter="onEnter">
          <div class="measure-grid">
            <label class="field span-2">
              <span class="field-label">姓名 <b class="req">*</b></span>
              <input v-model="form.name" class="input" data-field type="text" placeholder="张三" autocomplete="off" />
            </label>

            <div class="field">
              <span class="field-label">性别</span>
              <div class="gender-switch">
                <button
                  class="btn"
                  :class="{ active: form.gender === 'male' }"
                  type="button"
                  @click="form.gender = 'male'"
                >
                  男
                </button>
                <button
                  class="btn"
                  :class="{ active: form.gender === 'female' }"
                  type="button"
                  @click="form.gender = 'female'"
                >
                  女
                </button>
              </div>
            </div>

            <label class="field">
              <span class="field-label">班级 / 车间</span>
              <input v-model="form.orgUnit" class="input" data-field type="text" placeholder="高一(3)班" />
            </label>

            <label class="field">
              <span class="field-label">身高 (cm) <b class="req">*</b></span>
              <input
                ref="heightRef"
                v-model="form.heightCm"
                class="input measure-input"
                data-field
                type="text"
                inputmode="decimal"
                placeholder="170"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span class="field-label">体重 (kg)</span>
              <input
                v-model="form.weightKg"
                class="input measure-input"
                data-field
                type="text"
                inputmode="decimal"
                placeholder="65"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span class="field-label">胸围 (cm) <b class="req">*</b></span>
              <input
                v-model="form.chestCm"
                class="input measure-input"
                data-field
                type="text"
                inputmode="decimal"
                placeholder="88"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span class="field-label">腰围 (cm) <b class="req">*</b></span>
              <input
                v-model="form.waistCm"
                class="input measure-input"
                data-field
                type="text"
                inputmode="decimal"
                placeholder="72"
                autocomplete="off"
              />
            </label>

            <label class="field">
              <span class="field-label">批次</span>
              <select v-model="form.batch" class="select" data-field>
                <option value="">未分批</option>
                <option v-for="batch in project.batches" :key="batch" :value="batch">{{ batch }}</option>
              </select>
            </label>

            <label class="field">
              <span class="field-label">特殊体型标记</span>
              <select v-model="form.specialFlag" class="select" data-field>
                <option value="">无（常规档）</option>
                <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">
                  {{ flag.label }}
                </option>
              </select>
            </label>

            <label class="field span-2">
              <span class="field-label">备注（Shift + 回车换行）</span>
              <textarea v-model="form.note" class="textarea" data-field placeholder="如：左肩略低、需留量 2cm" />
            </label>
          </div>

          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-primary btn-accent" type="submit">保存并录入下一条（回车）</button>
            <button class="btn" type="button" @click="focusHeight">回到身高</button>
            <span class="hint">身高 / 胸围 / 腰围按 0.5cm 精度存储与判定</span>
          </div>
        </form>

        <p v-if="notice" class="notice notice-ok" style="margin-top: 12px">{{ notice }}</p>
        <p v-if="warnText" class="notice notice-warn" style="margin-top: 12px">{{ warnText }}</p>
        <p v-if="duplicateNames.length" class="notice notice-warn" style="margin-top: 12px">
          检测到可能重复：同名 + 同班级 + 同身高体重 的既有记录「{{ duplicateNames.join('、') }}」。重复行只提示、
          不自动删除，保存后可在归并页标记排除。
        </p>

        <div v-if="estimate" class="estimate-box" style="margin-top: 12px">
          <div>
            建议初始号型 <span class="estimate-code">{{ estimate.sizeCode }}</span>
            （型别 {{ estimate.fit }}，估算胸围 {{ estimate.estimatedChestCm }}cm / 腰围 {{ estimate.estimatedWaistCm }}cm）
          </div>
          <div class="hint">{{ estimate.basis }}</div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <h3>最近保存（本机离线数据）</h3>
          <div class="spacer"></div>
          <span class="badge badge-ok">本次会话新增 {{ savedCount }} 条</span>
        </div>
        <div v-if="recent.length === 0" class="empty">还没有录入数据</div>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>性别</th>
                <th class="num">身高</th>
                <th class="num">胸围</th>
                <th class="num">腰围</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="person in recent" :key="person.id" :class="person.status === 'active' ? '' : 'row-invalid'">
                <td>{{ person.name }}</td>
                <td>{{ genderText(person.gender) }}</td>
                <td class="num">{{ formatCm(person.heightCm) }}</td>
                <td class="num">{{ formatCm(person.chestCm) }}</td>
                <td class="num">{{ formatCm(person.waistCm) }}</td>
                <td>
                  <span class="badge" :class="person.status === 'active' ? 'badge-ok' : 'badge-danger'">
                    {{ person.status === 'active' ? '有效' : '无效' }}
                  </span>
                </td>
                <td>
                  <button class="btn btn-sm btn-danger" type="button" @click="removePerson(person)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>现场录入要点</h3></div>
        <div class="card-body tight">
          <p>· 回车即保存并自动聚焦身高，适合一人接一人连续录入。</p>
          <p>· 班级 / 性别 / 批次会沿用上一条，同班录入只需改数值。</p>
          <p>· 身高 80cm、胸围小于身高一半、胸腰差为负等异常会即时提示，并标记为待确认或无效行。</p>
          <p>· 特殊体型（加肥加大 / 特体定制 / 超高定制）请选择标记，将单列进定制清单，不混入常规档。</p>
          <p>· 无网也能录入：数据写入本机 IndexedDB，随时可用「导出 CSV（兜底）」带出。</p>
        </div>
      </div>
    </div>
  </section>
</template>