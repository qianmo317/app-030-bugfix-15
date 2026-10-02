<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { getRule, projectsUsingRule, saveRule, store } from '../logic/store'
import { alignToStep } from '../logic/sizeRules'
import { cmToHalfUnits, formatHalfUnits } from '../logic/precision'
import type { FitRange, Gender, SizeRule } from '../logic/types'

function cloneRule(rule: SizeRule): SizeRule {
  return JSON.parse(JSON.stringify(rule)) as SizeRule
}

const selectedVersion = ref(store.rules[0]?.version ?? '')
const form = ref<SizeRule>(cloneRule(getRule(selectedVersion.value)))

const newVersion = reactive({ version: '', label: '', effectiveFrom: '' })
const errorText = ref('')
const okText = ref('')

const currentRule = computed(() => getRule(selectedVersion.value))
const usedBy = computed(() => projectsUsingRule(selectedVersion.value))
const canOverwrite = computed(() => !currentRule.value.builtin && usedBy.value.length === 0)

watch(selectedVersion, (version) => {
  form.value = cloneRule(getRule(version))
  const latest = getRule(version)
  newVersion.version = ''
  newVersion.label = ''
  newVersion.effectiveFrom = latest.effectiveFrom
  errorText.value = ''
  okText.value = ''
})

const genderLabel: Record<Gender, string> = { male: '男装', female: '女装' }

function rangesOf(gender: Gender): FitRange[] {
  return form.value.fitByChestWaistDiff.find((group) => group.gender === gender)?.ranges ?? []
}

/** 边界示例由当前表单里的规则实时算出，用于核对「167.5 归哪档」 */
const alignExamples = computed(() => {
  const rule = form.value
  const samples = [167, 167.5, 168, 182, 182.5, 183]
  return samples.map((cm) => {
    const height = formatHalfUnits(
      alignToStep(cmToHalfUnits(cm), cmToHalfUnits(rule.heightAnchor), cmToHalfUnits(rule.heightStepCm), rule.boundaryRule)
    )
    const chest = formatHalfUnits(
      alignToStep(cmToHalfUnits(86), cmToHalfUnits(rule.chestAnchor), cmToHalfUnits(rule.chestStepCm), rule.boundaryRule)
    )
    return { cm, height, chest }
  })
})

function fitText(gender: Gender): string {
  return rangesOf(gender)
    .map((range) => `${range.fit} ${range.minCm}~${range.maxCm}`)
    .join(' ｜ ')
}

function validate(): string {
  const rule = form.value
  if (rule.heightStepCm <= 0) return '身高档位步长必须大于 0'
  if (rule.chestStepCm <= 0) return '胸围档位步长必须大于 0'
  if (rule.heightRangeCm.minCm >= rule.heightRangeCm.maxCm) return '身高可判定范围的下限必须小于上限'
  if (rule.chestRangeCm.minCm >= rule.chestRangeCm.maxCm) return '胸围可判定范围的下限必须小于上限'
  for (const group of rule.fitByChestWaistDiff) {
    for (const range of group.ranges) {
      if (range.minCm > range.maxCm) return `${genderLabel[group.gender]} ${range.fit} 型区间下限大于上限`
    }
    const sorted = [...group.ranges].sort((a, b) => a.minCm - b.minCm)
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].minCm <= sorted[index - 1].maxCm) {
        return `${genderLabel[group.gender]} ${sorted[index - 1].fit} 与 ${sorted[index].fit} 区间重叠`
      }
    }
  }
  return ''
}

async function overwrite(): Promise<void> {
  errorText.value = ''
  okText.value = ''
  const invalid = validate()
  if (invalid) {
    errorText.value = invalid
    return
  }
  await saveRule({ ...cloneRule(form.value), builtin: false })
  okText.value = `已保存到 ${form.value.version}（该版本未被任何项目引用，可直接修改）`
}

async function saveAsNew(): Promise<void> {
  errorText.value = ''
  okText.value = ''
  const invalid = validate()
  if (invalid) {
    errorText.value = invalid
    return
  }
  const version = newVersion.version.trim()
  if (!version) {
    errorText.value = '请填写新版本号，如 v2.0.0'
    return
  }
  if (store.rules.some((rule) => rule.version === version)) {
    errorText.value = `版本号 ${version} 已存在，请换一个`
    return
  }
  const created: SizeRule = {
    ...cloneRule(form.value),
    version,
    label: newVersion.label.trim() || '自定义修订版本',
    builtin: false,
    effectiveFrom: newVersion.effectiveFrom || form.value.effectiveFrom
  }
  await saveRule(created)
  selectedVersion.value = version
  okText.value = `已新建版本 ${version}；既有项目仍按各自锁定的版本解释，结果不变`
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>号型规则配置（版本化）</h1>
        <div class="sub">身高档位、胸腰差型别、边界规则全部显式配置；规则改版后旧项目仍按旧版本解释</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>规则版本列表（{{ store.rules.length }}）</h2>
        <div class="spacer"></div>
        <span class="hint">内置版本为只读，改规则请「另存为新版本」</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>版本</th>
              <th>说明</th>
              <th>生效日期</th>
              <th>号档</th>
              <th>型档</th>
              <th>边界规则</th>
              <th>男装型别</th>
              <th>女装型别</th>
              <th>引用项目</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="rule in store.rules" :key="rule.version">
              <td>
                <input v-model="selectedVersion" type="radio" :value="rule.version" name="rule-version" />
              </td>
              <td><b>{{ rule.version }}</b></td>
              <td>{{ rule.label }}</td>
              <td>{{ rule.effectiveFrom }}</td>
              <td>{{ rule.heightStepCm }}cm（锚点 {{ rule.heightAnchor }}）</td>
              <td>{{ rule.chestStepCm }}cm（锚点 {{ rule.chestAnchor }}）</td>
              <td>
                <span class="badge" :class="rule.boundaryRule === 'round_up' ? 'badge-info' : 'badge-warn'">
                  {{ rule.boundaryRule === 'round_up' ? '边界归上' : '就近归下' }}
                </span>
              </td>
              <td>{{ (rule.fitByChestWaistDiff.find((g) => g.gender === 'male')?.ranges ?? []).map((r) => `${r.fit} ${r.minCm}~${r.maxCm}`).join(' ') }}</td>
              <td>{{ (rule.fitByChestWaistDiff.find((g) => g.gender === 'female')?.ranges ?? []).map((r) => `${r.fit} ${r.minCm}~${r.maxCm}`).join(' ') }}</td>
              <td>
                <span class="badge" :class="projectsUsingRule(rule.version).length ? 'badge-warn' : ''">
                  {{ projectsUsingRule(rule.version).length }} 个
                </span>
              </td>
              <td>{{ rule.builtin ? '内置' : '自定义' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>当前版本 {{ form.version }} 的判定规则说明（写进界面的显式规则）</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">型号代码 = 号(身高档) / 型(胸围档) + 型别，如 170/88A</span>
      </div>
      <div class="card-body tight">
        <p>
          <b>身高档：</b>档位 = {{ form.heightAnchor }} + {{ form.heightStepCm }} × round((身高 − {{ form.heightAnchor }}) / {{ form.heightStepCm }})，
          边界规则 = {{ form.boundaryRule === 'round_up' ? '边界归上（167.5 归 170）' : '就近归下（167.5 归 165）' }}。
        </p>
        <p>
          <b>型别（胸腰差 = 胸围 − 腰围）：</b>男装 {{ fitText('male') }}；女装 {{ fitText('female') }}。
          负值或不合理值按异常拦截，超出上述区间的按待确认处理，不做自动归并。
        </p>
        <p>
          <b>胸围档：</b>锚点 {{ form.chestAnchor }}、步长 {{ form.chestStepCm }}，边界规则同身高档。
          <b>身高可判定范围：</b>{{ form.heightRangeCm.minCm }}~{{ form.heightRangeCm.maxCm }}cm（超出判为无效行）；
          <b>胸围可判定范围：</b>{{ form.chestRangeCm.minCm }}~{{ form.chestRangeCm.maxCm }}cm。
        </p>
        <div class="table-wrap">
          <table class="data-table" style="max-width: 620px">
            <thead>
              <tr>
                <th>实测值</th>
                <th>身高归入档位</th>
                <th>胸围 86cm 归入档位</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in alignExamples" :key="item.cm">
                <td>{{ item.cm }}cm</td>
                <td>{{ item.height }}</td>
                <td>{{ item.chest }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="hint">
          特殊体型标记：{{ form.specialFlags.map((flag) => `${flag.label}(${flag.code})`).join('、') }} —— 命中特殊标记的行单列进定制清单，不混入常规档。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>编辑参数（修改后用于「另存为新版本」）</h3>
        <div class="spacer"></div>
        <span v-if="usedBy.length" class="badge badge-warn">
          该版本被 {{ usedBy.length }} 个项目引用（{{ usedBy.map((p) => p.name).join('、') }}），不可覆盖
        </span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">身高档位步长 (cm)</span>
            <input v-model.number="form.heightStepCm" class="input" type="number" min="1" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">身高档位锚点 (cm)</span>
            <input v-model.number="form.heightAnchor" class="input" type="number" min="100" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">胸围档位步长 (cm)</span>
            <input v-model.number="form.chestStepCm" class="input" type="number" min="1" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">胸围档位锚点 (cm)</span>
            <input v-model.number="form.chestAnchor" class="input" type="number" min="40" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">边界规则</span>
            <select v-model="form.boundaryRule" class="select">
              <option value="round_up">边界归上（167.5 → 170）</option>
              <option value="nearest">就近归下（167.5 → 165）</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">身高可判定下限 (cm)</span>
            <input v-model.number="form.heightRangeCm.minCm" class="input" type="number" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">身高可判定上限 (cm)</span>
            <input v-model.number="form.heightRangeCm.maxCm" class="input" type="number" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">胸围可判定下限 (cm)</span>
            <input v-model.number="form.chestRangeCm.minCm" class="input" type="number" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">胸围可判定上限 (cm)</span>
            <input v-model.number="form.chestRangeCm.maxCm" class="input" type="number" step="0.5" />
          </label>
          <label class="field">
            <span class="field-label">版本说明</span>
            <input v-model="form.label" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field-label">生效日期</span>
            <input v-model="form.effectiveFrom" class="input" type="date" />
          </label>
          <label class="field">
            <span class="field-label">备注说明</span>
            <input v-model="form.note" class="input" type="text" />
          </label>
        </div>

        <div class="grid-2" style="margin-top: 12px">
          <div v-for="group in form.fitByChestWaistDiff" :key="group.gender">
            <h4>{{ genderLabel[group.gender] }}型别区间（胸腰差 cm，闭区间）</h4>
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>型别</th>
                    <th>下限</th>
                    <th>上限</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="range in group.ranges" :key="range.fit">
                    <td><b>{{ range.fit }}</b></td>
                    <td><input v-model.number="range.minCm" class="input" type="number" step="1" /></td>
                    <td><input v-model.number="range.maxCm" class="input" type="number" step="1" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <p v-if="errorText" class="notice notice-error" style="margin-top: 12px">{{ errorText }}</p>
        <p v-if="okText" class="notice notice-ok" style="margin-top: 12px">{{ okText }}</p>

        <div class="toolbar" style="margin-top: 12px">
          <button class="btn" type="button" :disabled="!canOverwrite" @click="overwrite">
            覆盖保存当前版本
          </button>
          <span class="hint">
            {{ canOverwrite ? '该版本未被项目引用、且非内置，可直接覆盖保存' : '内置版本或被项目引用的版本不可覆盖，请另存为新版本' }}
          </span>
        </div>

        <div class="card" style="margin-top: 12px; box-shadow: none">
          <div class="card-head"><h4>另存为新版本</h4></div>
          <div class="card-body">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">新版本号 <b class="req">*</b></span>
                <input v-model="newVersion.version" class="input" type="text" placeholder="如 v2.0.0" />
              </label>
              <label class="field">
                <span class="field-label">新版本说明</span>
                <input v-model="newVersion.label" class="input" type="text" placeholder="如：边界改为就近归下" />
              </label>
              <label class="field">
                <span class="field-label">生效日期</span>
                <input v-model="newVersion.effectiveFrom" class="input" type="date" />
              </label>
              <div class="field" style="justify-content: flex-end">
                <button class="btn btn-primary" type="button" @click="saveAsNew">另存为新版本</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>