<script setup lang="ts">
/**
 * 404 页（未匹配路由的兜底目标页）。
 *
 * 为什么需要它：console 的路由表原先**没有 catch-all**，任何未登记路径
 * （手输错地址、过期书签、被删页面的旧链接、第三方文档里的旧 URL）
 * 都会命中 vue-router 的「无匹配」分支 —— `router-view` 什么都不渲染，
 * `#app` 里只剩一个注释节点，用户看到的是**完全白屏、零提示**。
 * 实测（iter338）：`/console/idp` → `bodyTextLen: 0`、`#app` innerHTML 仅 7 字符，
 * 且**没有任何 4xx 请求**，控制台也无报错 —— 用户无从判断是自己错了还是系统坏了。
 *
 * 与 Forbidden.vue 的分工（二者不要混）：
 * - **403**（`/forbidden`）：路由**存在**、但守卫链裁剪不通过 → 「无权限执行该操作」+ 所需权限码；
 * - **404**（本页）：路由**不存在** → 「页面不存在」+ 回工作台。
 *   不能把未知路径也送去 /forbidden —— 那会让用户以为自己权限不够、去申请一个根本不存在的权限。
 *
 * 设计对齐（不新造第二套视觉）：完全复用 Forbidden.vue 的版式与 token ——
 * `min-height: 100vh` + `var(--bg-base)` 背景、`role="alert"`、语义 `h1`、
 * `--text-primary` / `--text-secondary` / `--accent-blue`。
 * 本页渲染在应用外壳（MainLayout）之外，不继承其 background，故必须自带背景，
 * 否则会落成浏览器默认白底（Forbidden 早期正是踩过这个坑，实测对比度仅 1.06:1）。
 *
 * 返回目标是工作台：与 Forbidden 一致，都是守卫放行后可到达的默认页。
 */
import { useRoute, useRouter } from 'vue-router'

const router = useRouter()
const route = useRoute()
</script>

<template>
  <section class="not-found-page" role="alert" aria-live="polite" aria-labelledby="not-found-title">
    <p class="not-found-code" aria-hidden="true">404</p>
    <h1 id="not-found-title" class="not-found-title">页面不存在</h1>
    <!-- 把用户实际访问的路径回显出来：便于用户自查拼写，也便于反馈问题时定位 -->
    <p v-if="route.fullPath" class="not-found-path">
      {{ route.fullPath }}
    </p>
    <p class="not-found-hint">
      你访问的页面不存在或已被移除，请检查地址是否正确；也可以返回工作台继续操作。
    </p>
    <el-button type="primary" plain @click="router.push('/workbench')">返回工作台</el-button>
  </section>
</template>

<style scoped>
/* 与 Forbidden.vue 同一套版式（见其注释：本页在外壳之外，必须自带背景 + 100vh 铺满） */
.not-found-page {
  min-height: 100vh;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-primary);
  padding: 16px;
  box-sizing: border-box;
}
.not-found-code {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 56px;
  font-weight: 700;
  line-height: 1;
  color: var(--text-secondary);
  letter-spacing: 2px;
}
.not-found-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}
.not-found-path {
  margin: 0;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 13px;
  color: var(--accent-blue);
  text-align: center;
  overflow-wrap: anywhere;
  max-width: 560px;
}
.not-found-hint {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 560px;
  text-align: center;
}
</style>
