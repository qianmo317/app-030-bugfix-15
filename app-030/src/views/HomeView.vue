<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { createProject, deleteProject, store } from '../logic/store'
import { DEFAULT_RULE_VERSION } from '../logic/sizeRules'
import type { Project, ProjectKind } from '../logic/types'

const router = useRouter()

const form = reactive({
  name: '',
  kind: 'school' as ProjectKind,
  batches: '春装, 秋装',
  ruleVersion: DEFAULT_RULE_VERSION
})

const message = ref('')
const errorText = ref('')

const kindLabel: Record<ProjectKind, string> = {
  school: '学校（校服）',
  factory: '工厂（工装）',
  other: '其它单位'
}

function projectStats(project: Project) {
  let active = 0
  let invalid = 0
  let duplicate = 0
  let special = 0
  for (const person of project.persons) {
    if (person.status === 'active') active += 1
    else if (person.status === 'invalid') invalid += 1
    else duplicate += 1
    if (person.specialFlag && person.status === 'active') special += 1
  }
  return { total: project.persons.length, active, invalid, duplicate, special }
}

const projects = computed(() => store.projects)

function parseBatches(text: string): string[] {
  return text
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

async function submit(): Promise<void> {
  errorText.value = ''
  message.value = ''
  if (!form.name.trim()) {
    errorText.value = '请填写项目名称（如「XX 中学 2026 级校服」）'
    return
  }
  const project = await createProject({
    name: form.name,
    kind: form.kind,
    batches: parseBatches(form.batches),
    ruleVersion: form.ruleVersion
  })
  form.name = ''
  message.value = `项目「${project.name}」已创建，规则版本锁定为 ${project.ruleVersion}`
  await router.push(`/measure/${project.id}`)
}

async function remove(project: Project): Promise<void> {
  if (!window.confirm(`确认删除项目「${project.name}」及其 ${project.persons.length} 条量体数据？此操作不可恢复。`)) {
    return
  }
  await deleteProject(project.id)
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN')
}
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1>项目列表</h1>
        <div class="sub">学校 / 工厂 × 批次；每个项目锁定一个号型规则版本，规则改版不影响既有项目</div>
      </div>
      <div class="spacer"></div>
      <RouterLink class="btn btn-sm" to="/rules">配置号型规则</RouterLink>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>新建项目</h2>
        <div class="spacer"></div>
        <span class="hint">数据只写入本机浏览器，不会上传</span>
      </div>
      <div class="card-body">
        <form class="form-grid" @submit.prevent="submit">
          <label class="field">
            <span class="field-label">项目名称 <b class="req">*</b></span>
            <input v-model="form.name" class="input" type="text" placeholder="如：XX 中学 2026 级校服" />
          </label>
          <label class="field">
            <span class="field-label">类型</span>
            <select v-model="form.kind" class="select">
              <option value="school">学校（校服）</option>
              <option value="factory">工厂（工装）</option>
              <option value="other">其它单位</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">批次（多批次用逗号分隔，可留空）</span>
            <input v-model="form.batches" class="input" type="text" placeholder="春装, 秋装" />
          </label>
          <label class="field">
            <span class="field-label">号型规则版本</span>
            <select v-model="form.ruleVersion" class="select">
              <option v-for="rule in store.rules" :key="rule.version" :value="rule.version">
                {{ rule.version }} ｜ {{ rule.label }}
              </option>
            </select>
          </label>
          <div class="field" style="justify-content: flex-end">
            <button class="btn btn-primary" type="submit">创建并开始录入</button>
          </div>
        </form>
        <p v-if="errorText" class="notice notice-error" style="margin-top: 10px">{{ errorText }}</p>
        <p v-if="message" class="notice notice-ok" style="margin-top: 10px">{{ message }}</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>已有项目（{{ projects.length }}）</h2>
      </div>
      <div v-if="projects.length === 0" class="empty">
        还没有项目。先在上方新建一个项目，再进入「量体录入」或「批量导入」。
      </div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>项目名称</th>
              <th>类型</th>
              <th>规则版本</th>
              <th>批次</th>
              <th class="num">总录入</th>
              <th class="num">有效</th>
              <th class="num">无效</th>
              <th class="num">重复</th>
              <th class="num">特殊</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="project in projects" :key="project.id">
              <td>{{ project.name }}</td>
              <td>{{ kindLabel[project.kind] }}</td>
              <td><span class="badge badge-info">{{ project.ruleVersion }}</span></td>
              <td>{{ project.batches.length ? project.batches.join(' / ') : '—' }}</td>
              <td class="num">{{ projectStats(project).total }}</td>
              <td class="num">{{ projectStats(project).active }}</td>
              <td class="num">{{ projectStats(project).invalid }}</td>
              <td class="num">{{ projectStats(project).duplicate }}</td>
              <td class="num">{{ projectStats(project).special }}</td>
              <td>{{ formatTime(project.updatedAt) }}</td>
              <td>
                <div class="toolbar">
                  <RouterLink class="btn btn-sm" :to="`/measure/${project.id}`">录入</RouterLink>
                  <RouterLink class="btn btn-sm" :to="`/import/${project.id}`">导入</RouterLink>
                  <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">归并</RouterLink>
                  <RouterLink class="btn btn-sm" :to="`/summary/${project.id}`">汇总</RouterLink>
                  <RouterLink class="btn btn-sm btn-primary" :to="`/export/${project.id}`">导出</RouterLink>
                  <button class="btn btn-sm btn-danger" type="button" @click="remove(project)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>使用流程</h3></div>
      <div class="card-body tight">
        <p>① 在「号型规则」确认或新建规则版本（身高档位、胸腰差型别、边界规则）→ ② 新建项目并录入 / 导入量体数据 →
          ③ 「归并结果」自动归并并可人工覆写 → ④ 「汇总与守恒」校验 <code>常规 + 特殊 = 有效人数</code> →
          ⑤ 守恒通过后「导出下单表」（Excel / CSV / 打印成 PDF）。</p>
        <p class="hint">
          隐私承诺：量体数据（姓名 + 身体尺寸）只保存在本机 IndexedDB，应用不发起任何网络请求，也没有后端与上传接口。
        </p>
      </div>
    </div>
  </section>
</template>