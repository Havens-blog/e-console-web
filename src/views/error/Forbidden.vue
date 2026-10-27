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
 * 本页列出「所需权限码」，并说明「登录状态仍然有效」——403 为本地态，非会话失效。
 *
 * 可访问性：页面必须有语义标题，否则读屏用户按标题导航时找不到本页结构；
 * 标题直接用契约文案（不新造第二套措辞），保证文案出口仍然唯一。
 * 面客文案不使用「权限裁剪」「403 本地态」这类实现术语（内部语汇留在本注释里）。
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
  <section class="forbidden-page" role="alert" aria-live="polite" aria-labelledby="forbidden-title">
    <!-- 标题即契约文案本身（不新造第二套措辞）：403 页原先没有任何 h1/h2，
         读屏用户按标题导航时找不到这一页的结构。 -->
    <h1 id="forbidden-title" class="forbidden-title">
      <CopyContractText code="forbidden" tag="span" />
    </h1>
    <p v-if="requiredCodes.length" class="forbidden-codes" data-testid="forbidden-required">
      所需权限码：{{ requiredCodes.join(' · ') }}
    </p>
    <p class="forbidden-hint">
      你的账号没有访问该页面所需的权限，登录状态仍然有效；如需访问请联系管理员申请授权。
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
/* 标题承接契约文案：字号对齐页面标题层级，居中保持原视觉重心 */
.forbidden-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}
.forbidden-hint {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 560px;
  text-align: center;
}
</style>