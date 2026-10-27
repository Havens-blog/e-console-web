<script setup lang="ts">
/**
 * 403 页（router 守卫链 ③ 裁剪不通过的目标页，tech-design §Architecture 守卫链）。
 *
 * 文案出口走 2.5 文案契约 `forbidden`（逐字渲染「无权限执行该操作」，Hard Rule：零二次映射）。
 * 与请求层 403（forbidden kind → 原地 toast）同口径同契约 key，区别仅在呈现位置：
 * - 请求层 403：当前页 toast（不跳转，tech-design §Error Handling）；
 * - 守卫 403：URL 直入越权页 → 跳本页（承接 Story 3 / Story 5）。
 *
 * P0 增强（与原型一致）：守卫把缺失权限码经 query.required 透传（逗号分隔），
 * 本页列出「所需权限码」，并明示「不会跳转登录页」——403 为本地态，非会话失效。
 *
 * 返回导航：回工作台（守卫放行后可到达的默认页）。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CopyContractText from '@/components/CopyContractText.vue'

const router = useRouter()
const route = useRoute()

/** 缺失权限码（守卫 ③ 透传；is_admin = requiresAdmin 平台管理员双闸） */
const requiredCodes = computed(() =>
  typeof route.query.required === 'string' && route.query.required !== ''
    ? route.query.required.split(',')
    : [],
)
</script>

<template>
  <section class="forbidden-page" role="alert" aria-live="polite">
    <CopyContractText code="forbidden" tag="p" />
    <p v-if="requiredCodes.length" class="forbidden-codes" data-testid="forbidden-required">
      所需权限码：{{ requiredCodes.join(' · ') }}
    </p>
    <p class="forbidden-hint">
      当前页面访问被权限裁剪拦截，不会跳转登录页（403 本地态）；如需访问请向管理员申请授权。
    </p>
    <el-button type="primary" plain @click="router.push('/workbench')">返回工作台</el-button>
  </section>
</template>

<style scoped>
.forbidden-page {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-primary);
  /* 水平内边距：窄屏（≤560）原先段落 0..viewport 全宽贴边、长句折两行；
     全宽度生效不会影响桌面居中（flex 居中 + max-width 兜底），故不加媒体查询 */
  padding: 16px;
  box-sizing: border-box;
}
.forbidden-codes {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
  color: var(--accent-blue);
  text-align: center;
  overflow-wrap: anywhere;
}
.forbidden-hint {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 560px;
  text-align: center;
}
</style>