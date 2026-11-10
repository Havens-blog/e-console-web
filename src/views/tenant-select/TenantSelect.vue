<script setup lang="ts">
// 租户选择页（UF-11）—— task 3.2。
//
// 认证通过后按所属租户数分流（判定源 = user store mustSelectTenant / tenants）：
//   0 个 → 受限工作台（仅欢迎 + 我的信息）；平台管理员豁免由 3.3 工作台自处理受限态
//   1 个 → 自动选定唯一租户 + toast 短暂提示 → 直达工作台
//   ≥2 个 → 渲染单选列表（复用 3.1 TenantSelector 组件）→ 选租户 → tenant/switch → 整页 reload
//
// Hard Rule：租户列表仅来自 eiam 返回的所属租户，禁止自由输入任意 tenant_id；
//            未选定前不进入管理页（守卫 ② 已保证，本页 0/1 分流自动跳转 /workbench）。
// 切租户路径与 3.1 组件同款：tenant store switchTenant → POST /api/iam/tenant/switch +
// X-Active-Tenant-ID 头 → 整页 location.replace（Integration 6，杜绝 SPA 内只换 store）。
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { useUserStore } from "@/stores/user";
import { useTenantStore } from "@/stores/tenant";
import TenantSelector from "@/components/TenantSelector.vue";

const userStore = useUserStore();
const tenantStore = useTenantStore();
const router = useRouter();

const tenants = computed(() => userStore.tenants);
const loading = computed(() => userStore.loading);
const error = computed(() => userStore.error);
/** 多租户分流信号（F-1：前端自算 tenants.length > 1） */
const mustSelectTenant = computed(() => userStore.mustSelectTenant);

/** 已执行分流标记（防重复跳转/切换；watch + onMounted 多入口触发） */
const dispatched = ref(false);

onMounted(async () => {
  // 守卫 ① 已拉取 profile（含 tenants）后才放行至此；防御性：直接 URL 进入且 profile
  // 缺失（理论态）时补拉一次，使 Loading/Error 态可由本页驱动。
  if (!userStore.profile && !userStore.loading) {
    await userStore.fetchProfile();
  }
  dispatch();
});

// loading / error 结束后（含 retry 后）尝试分流
watch([loading, error], () => {
  if (!loading.value && !error.value) dispatch();
});

/**
 * 0/1 分流（≥2 由模板渲染列表，不在此跳转）。
 * - 0 → router.replace /workbench（3.3 按 admin 豁免自处理受限态）
 * - 1 → toast 提示 +（currentTenantId 已定则跳工作台，否则 switchTenant 写 session）
 */
function dispatch(): void {
  if (dispatched.value) return;
  if (loading.value || error.value) return;
  // ≥2 且已选定（switch+reload 而来，currentTenantId 已非 0）：直达工作台。
  // mustSelectTenant（tenants.length>1）选后恒真，须以 currentTenantId 区分，
  // 否则 switchTenant 整页 reload 回本页后死循环在选租户列表。
  if (mustSelectTenant.value && userStore.currentTenantId !== 0) {
    dispatched.value = true;
    void router.replace("/workbench");
    return;
  }
  if (mustSelectTenant.value) return; // ≥2 → 渲染列表，等用户选择
  const list = tenants.value;
  if (list.length === 0) {
    dispatched.value = true;
    // 受限工作台复用 3.3 工作台的受限视图组件（admin 豁免由 3.3 自处理）
    void router.replace("/workbench");
    return;
  }
  // 单租户：自动选定 + toast 短暂提示 → 工作台
  dispatched.value = true;
  const t = list[0]!;
  ElMessage.success(`已选择租户「${t.name || `租户 #${t.id}`}」`);
  if (userStore.currentTenantId === t.id) {
    // 已是当前租户（eiam 预定）→ 直达工作台
    void router.replace("/workbench");
  } else {
    // 写 session tenant_id → tenant/switch → 整页 reload（3.1 组件同款路径）
    void tenantStore.switchTenant(t.id);
  }
}

/** 重试：重置分发标记后重新拉取 profile（返回 Loading 态，再由 watch 触发分流） */
async function retry(): Promise<void> {
  dispatched.value = false;
  await userStore.fetchProfile();
  dispatch();
}
</script>

<template>
  <section class="page-tenant-select" data-testid="tenant-select">
    <div class="ts-card">
      <h2 class="ts-title">选择租户</h2>

      <!-- Loading: skeleton（查询所属租户中） -->
      <div
        v-if="loading"
        class="ts-loading"
        data-testid="ts-loading"
        aria-busy="true"
        aria-live="polite"
      >
        正在查询所属租户…
      </div>

      <!-- Error: 错误提示 + 重试按钮 -->
      <div v-else-if="error" class="ts-error-block" data-testid="ts-error">
        <p class="ts-error-msg" role="alert">{{ error }}</p>
        <el-button type="primary" data-testid="ts-retry" @click="retry"
          >重试</el-button
        >
      </div>

      <!-- ≥2: 渲染单选列表（复用 3.1 TenantSelector 组件） -->
      <div v-else-if="mustSelectTenant" class="ts-list" data-testid="ts-list">
        <p class="ts-hint">请选择要进入的租户</p>
        <!-- Hard Rule：列表仅来自 eiam 所属租户，TenantSelector 不可自由输入 tenant_id -->
        <TenantSelector width="100%" size="default" placeholder="选择租户" />
      </div>

      <!-- 0/1: 分流中（自动跳转过渡态） -->
      <div v-else class="ts-dispatching" data-testid="ts-dispatching">
        <p class="ts-hint">正在跳转…</p>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-tenant-select {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--bg-base, #f5f5f7);
}

.ts-card {
  width: 100%;
  max-width: 420px;
  padding: 32px 28px;
  border-radius: 12px;
  background: var(--bg-elevated, #fff);
  box-shadow: 0 2px 16px rgba(0, 0, 0, 0.06);
}

.ts-title {
  margin: 0 0 20px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary, #1d1d1f);
  text-align: center;
}

.ts-loading {
  padding: 24px 0;
  text-align: center;
  color: var(--text-secondary, #6e6e73);
  font-size: 14px;
}

.ts-error-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

/**
 * 错误提示（iter309 / R14「错误态主题不一致」）。
 *
 * 缺陷：原先写的是 `background: var(--bg-danger-subtle, #fef0f0)` 与
 * `color: var(--text-danger, #c45656)` —— **这两个变量在全仓都没有定义**，
 * 于是永远落到兜底值：**浅粉底 #fef0f0 + 固定红字 #c45656**，
 * 在深色主题（默认态，页面底 #0f1115 系）下是一块突兀的浅色砖，与其它页面错误态不一致。
 *
 * 现改为：底色取 `--color-danger` 12% 透明的「软着色」（与 `StatusBadge` /
 * `PolicyStatementsEditor` 同款），文字色按主题分两档 ——
 * **因为 `#ef4444` 无论怎么混黑/混白都无法同时满足两主题的 4.5:1**：
 * 原色 vs 深底 #0f1011 = 5.06（够）、vs 白底 = 3.76（不够）；混 85% 黑则反过来（3.81 / 4.99）。
 * 所以深色偏亮一档、浅色偏暗一档，两个都实测达标（见 PR 证据）。
 *
 * 两处选型踩坑（都验过才定）：
 * ① `--status-danger` 看似更合适（它本就按主题给了两套值），但它定义在
 *    `console-tokens.scss` —— **该文件全仓从未被 import**，运行时变量不存在，
 *    实测 `color-mix` 退成 `transparent`、`color` 退成继承黑，深色下对比度只剩 **1.10:1**。
 * ② scoped 里的 `:global(:root.light) …`（两种写法都试过）**不会被编译进产物**，
 *    改用后代选择器 `:root.light .ts-error-msg` 才生效（`.light` 挂在 html 上，属祖先）。
 */
.ts-error-msg {
  margin: 0;
  padding: 12px 16px;
  width: 100%;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  /* 深色（默认）：亮一档，与 #0f1011 底达 AA */
  color: color-mix(in srgb, var(--color-danger) 82%, white);
  font-size: 14px;
  text-align: center;
}

/* 浅色：暗一档，与白底达 AA */
:root.light .ts-error-msg {
  color: color-mix(in srgb, var(--color-danger) 72%, black);
}

.ts-hint {
  margin: 0 0 16px;
  color: var(--text-secondary, #6e6e73);
  font-size: 14px;
  text-align: center;
}

.ts-list {
  display: flex;
  flex-direction: column;
}

.ts-dispatching {
  padding: 24px 0;
  text-align: center;
}
</style>
