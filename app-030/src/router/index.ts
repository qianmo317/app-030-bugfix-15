import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('../views/HomeView.vue') },
    { path: '/rules', name: 'rules', component: () => import('../views/RulesView.vue') },
    { path: '/measure/:id', name: 'measure', component: () => import('../views/MeasureView.vue') },
    { path: '/import/:id', name: 'import', component: () => import('../views/ImportView.vue') },
    { path: '/merge/:id', name: 'merge', component: () => import('../views/MergeView.vue') },
    { path: '/summary/:id', name: 'summary', component: () => import('../views/SummaryView.vue') },
    { path: '/export/:id', name: 'export', component: () => import('../views/ExportView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router