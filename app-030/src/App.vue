<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { getProject, initStore, setOperator, store } from './logic/store'

const route = useRoute()
const operatorDraft = ref(store.operator)

onMounted(async () => {
  await initStore()
})

watch(
  () => store.operator,
  (value) => {
    operatorDraft.value = value
  }
)

const projectId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const project = computed(() => (projectId.value ? getProject(projectId.value) : undefined))

const tabs = computed(() => {
  if (!projectId.value) return []
  return [
    { to: `/measure/${projectId.value}`, label: '量体录入' },
    { to: `/import/${projectId.value}`, label: '批量导入' },
    { to: `/merge/${projectId.value}`, label: '归并结果' },
    { to: `/summary/${projectId.value}`, label: '汇总与守恒' },
    { to: `/export/${projectId.value}`, label: '导出下单表' }
  ]
})

async function commitOperator(): Promise<void> {
  const name = operatorDraft.value.trim() || '现场录入员'
  operatorDraft.value = name
  if (name !== store.operator) await setOperator(name)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header no-print">
      <div class="app-header-inner">
        <RouterLink class="brand" to="/">
          <strong>服装量体号型归并与下单汇总</strong>
          <span>Uniform Size Tally Studio</span>
        </RouterLink>
        <nav class="nav">
          <RouterLink to="/">项目列表</RouterLink>
          <RouterLink to="/rules">号型规则</RouterLink>
          <span class="privacy-pill">数据不出本地 · 无任何上传</span>
          <label class="operator-box">
            操作人
            <input
              v-model="operatorDraft"
              type="text"
              maxlength="16"
              placeholder="现场录入员"
              @change="commitOperator"
              @blur="commitOperator"
            />
          </label>
        </nav>
      </div>
    </header>

    <div v-if="tabs.length" class="tab-nav no-print">
      <div class="tab-nav-inner">
        <RouterLink v-for="tab in tabs" :key="tab.to" :to="tab.to">{{ tab.label }}</RouterLink>
        <span v-if="project" class="badge badge-info" style="align-self: center; margin-left: auto">
          规则 {{ project.ruleVersion }} ｜ 已录入 {{ project.persons.length }} 条
        </span>
      </div>
    </div>

    <main class="container">
      <div v-if="!store.ready" class="empty">正在读取本机数据…</div>
      <template v-else>
        <p v-if="store.error" class="notice notice-error">
          本机存储不可用：{{ store.error }}（数据将无法离线保存，请检查浏览器隐私设置）
        </p>
        <RouterView />
      </template>
    </main>

    <footer class="app-footer no-print">
      纯前端应用 · 量体数据只保存在本机浏览器（IndexedDB）· 不联网、不上传、无后端服务
    </footer>
  </div>
</template>