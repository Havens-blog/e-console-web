<script setup lang="ts">
// 工作台（UF-3）—— 欢迎横幅 + 我的信息 + 应用快捷导航（task 3.3）。
//
// 参照：ui-design UF-3（Layout/States/Interactions/Data Binding）+ tech-design §Architecture
// （视图 → store → api 单向数据流；工作台消费 user store）+ §Data Models（profile 形状）。
//
// 三态（ui-design UF-3 States）：
// - Default：欢迎 + 我的信息四字段只读 + 应用卡片可跳转；
// - 受限视图（零租户 E3，!isAdmin && tenants.length===0）：仅欢迎 + 我的信息；
//   应用卡片禁用（不隐藏）；管理菜单不渲染（P0：menuConfig visibleMenuItems restricted → 无码项）；
// - eiam 不可用（E12）：静态内容（欢迎 + 我的信息）仍渲染 + 顶部降级提示
//   （eiam.unavailable 契约文案），卡片跳转禁用。
//
// 我的信息四字段（ui-design Data Binding：profile {username, display_name, tenant_name,
// roles[]}）数据源 = 2.7 user store，无需额外端点（Hard Rule）：
//   - 用户名 → profile.username
//   - 昵称 → profile.displayName（nickname 缺失回退 username，user store 同款）
//   - 所属租户 → tenants[currentTenantId].name；零租户受限态显示 tenant.none 契约文案
//   - 角色 → 由权限码词表派生（P0：inferRoleFromCodes；parity §6.1.4：eiam profile 无 roles
//     字段；Hard Rule 不加端点；与 menuConfig/路由守卫/按钮裁剪同信号源）
//
// 应用卡片：本地穷举枚举（「云管」+「运维 Agent」两项，与 AppSwitcher 同源；Hard Rule
// 不做运行时注册。运维 Agent = 独立子项目 opsagent-web，宿主 nginx /opsagent/ 同域
// （records/6.2-opsagent-standalone 归属调整，控制台不承载其代码））。
import { computed } from "vue";
import { useUserStore } from "@/stores/user";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { inferRoleFromCodes, type MenuRole } from "@/components/layout/menuConfig";

/** 应用卡片条目（本地穷举枚举，与 AppSwitcher APPS 同源；后续增列在此登记） */
interface AppEntry {
  /** 唯一 key（穷举枚举标识） */
  key: string;
  /** 卡片标题 */
  label: string;
  /** 卡片描述 */
  desc: string;
  /** 打开 URL（build 期 env 注入，默认 /cam/ —— nginx 同域 e-cam-web 入口） */
  url: string;
}

/**
 * 穷举本地枚举：「云管」（e-cam-web）+「运维 Agent」（opsagent-web）。
 * Hard Rule：不做运行时注册；后续应用增列在此常量逐条登记。
 * 与 AppSwitcher APPS 同口径（tech-design §Integration Specs 2 SSO）。
 */
const APPS: readonly AppEntry[] = [
  {
    key: "cam",
    label: "云管",
    desc: "多云资源管理",
    url: import.meta.env.VITE_APP_CAM_BASE ?? "/cam/",
  },
  {
    key: "opsagent",
    label: "运维 Agent",
    desc: "对话式排障编排",
    url: import.meta.env.VITE_APP_OPSAGENT_BASE ?? "/opsagent/",
  },
  {
    key: "watchalert",
    label: "WatchAlert",
    desc: "监控告警",
    url: import.meta.env.VITE_APP_WATCHALERT_BASE ?? "/watchalert/",
  },
];

const userStore = useUserStore();

/** profile 引用（可能为 null —— 守卫放行后非 null，但防御性渲染避免白屏） */
const profile = computed(() => userStore.profile);

/**
 * 受限视图（零租户 E3）：!isAdmin && tenants.length===0。
 * 平台管理员豁免（isAdmin → 即使零租户亦非受限，ui-design UF-3）。
 */
const isRestricted = computed(
  () => !userStore.isAdmin && userStore.tenants.length === 0,
);

/**
 * eiam 不可用（E12）：user store error 置位（profile 拉取/再取失败）。
 * 守卫首次 profile 失败 → 跳登录，故 workbench 上 error 置位时 profile 多为已加载的陈旧
 * 值（静态内容仍可渲染）；防御性处理 profile===null 亦不白屏。
 */
const eiamUnavailable = computed(() => !!userStore.error);

/** 应用卡片禁用：受限视图或 eiam 不可用 */
const cardsDisabled = computed(
  () => isRestricted.value || eiamUnavailable.value,
);

/** 角色档位 → 展示标签（P0 词表驱动：与菜单/路由/按钮裁剪同信号源，parity §5 已定稿） */
const ROLE_LABELS: Record<MenuRole, string> = {
  platform_admin: "平台管理员",
  readonly_audit: "只读/审计",
  tenant_admin: "租户管理员",
  normal: "普通用户",
};

/** 我的信息·角色字段：由权限码词表派生（P0；profile 无 roles 字段，Hard Rule 不加端点） */
const roleLabel = computed(() => {
  const role = inferRoleFromCodes({
    codes: userStore.permissions,
    isAdmin: userStore.isAdmin,
    restricted: isRestricted.value,
  });
  return ROLE_LABELS[role] ?? "普通用户";
});

/** 我的信息·所属租户字段：当前租户名；受限态/未选中 → tenant.none 契约文案 */
const currentTenantName = computed(() => {
  if (isRestricted.value) return contractText("tenant.none") ?? "无所属租户";
  const tid = userStore.currentTenantId;
  if (!tid) return contractText("tenant.none") ?? "无所属租户";
  const tenant = userStore.tenants.find((t) => t.id === tid);
  return tenant?.name || (contractText("tenant.none") ?? "无所属租户");
});

/** 欢迎语称呼：昵称优先，缺失回退用户名（与 user store displayName 同款） */
const welcomeName = computed(() => {
  if (profile.value) return profile.value.displayName || profile.value.username;
  return "";
});

/** 应用卡片点击：新标签打开（共享 cookie SSO）；禁用态拦截 */
function openApp(app: AppEntry): void {
  if (cardsDisabled.value) return;
  // noopener 防新标签操作旧页面（target=_blank 反劫持，与 AppSwitcher 同款）
  window.open(app.url, "_blank", "noopener");
}
</script>

<template>
  <section class="page-workbench" data-testid="workbench">
    <!-- E12 顶部降级提示（eiam 不可用：静态内容仍渲染 + 降级条） -->
    <div
      v-if="eiamUnavailable"
      class="workbench-degradation"
      role="alert"
      data-testid="workbench-degradation"
    >
      <CopyContractText code="eiam.unavailable" tag="span" />
    </div>

    <div class="workbench-container">
      <!-- 欢迎横幅 + 我的信息（四字段只读） -->
      <header class="workbench-welcome">
        <h2 class="workbench-welcome-title">
          欢迎{{ welcomeName ? "，" + welcomeName : "" }}
        </h2>

        <dl class="workbench-profile" data-testid="workbench-profile">
          <div class="workbench-profile-field">
            <dt class="workbench-profile-label">用户名</dt>
            <dd class="workbench-profile-value" data-testid="profile-username">
              {{ profile?.username || "—" }}
            </dd>
          </div>
          <div class="workbench-profile-field">
            <dt class="workbench-profile-label">昵称</dt>
            <dd class="workbench-profile-value" data-testid="profile-nickname">
              {{ profile?.displayName || "—" }}
            </dd>
          </div>
          <div class="workbench-profile-field">
            <dt class="workbench-profile-label">所属租户</dt>
            <dd
              class="workbench-profile-value"
              data-testid="profile-tenant"
              :data-restricted="isRestricted ? 'true' : undefined"
            >
              {{ currentTenantName }}
            </dd>
          </div>
          <div class="workbench-profile-field">
            <dt class="workbench-profile-label">角色</dt>
            <dd class="workbench-profile-value" data-testid="profile-role">
              {{ roleLabel }}
            </dd>
          </div>
        </dl>
      </header>

      <!-- 应用快捷导航卡片组（列数定死：1280–1599px 2 列、≥1600px 3 列） -->
      <section
        class="workbench-apps"
        :class="{ 'is-disabled': cardsDisabled }"
        aria-label="应用快捷导航"
        data-testid="workbench-apps"
      >
        <h3 class="workbench-apps-title">应用快捷导航</h3>
        <ul
          class="workbench-app-cards"
          :data-disabled="cardsDisabled ? 'true' : undefined"
        >
          <li
            v-for="app in APPS"
            :key="app.key"
            class="workbench-app-card-wrap"
          >
            <button
              type="button"
              class="workbench-app-card"
              :disabled="cardsDisabled"
              :aria-label="`打开${app.label}`"
              :data-testid="`app-card-${app.key}`"
              @click="openApp(app)"
            >
              <span class="workbench-app-card-icon" aria-hidden="true">◆</span>
              <span class="workbench-app-card-label">{{ app.label }}</span>
              <span class="workbench-app-card-desc">{{ app.desc }}</span>
            </button>
          </li>
        </ul>

        <!-- 受限视图提示（零租户 E3）：tenant.none 契约文案，不白屏 -->
        <p
          v-if="isRestricted"
          class="workbench-restricted-notice"
          role="status"
          data-testid="workbench-restricted-notice"
        >
          <CopyContractText code="tenant.none" tag="span" />
        </p>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-workbench {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 100%;
  background: var(--bg-base);
}

// E12 降级条（顶部，eiam.unavailable 契约文案）
.workbench-degradation {
  padding: 10px 16px;
  border-radius: 0;
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  color: var(--color-warning);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}

.workbench-container {
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

// 欢迎横幅 + 我的信息
.workbench-welcome {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 24px;
  box-shadow: var(--shadow-sm);
}

.workbench-welcome-title {
  margin: 0 0 20px;
  color: var(--text-primary);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.3;
}

.workbench-profile {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px 24px;
  margin: 0;
}

.workbench-profile-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.workbench-profile-label {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.workbench-profile-value {
  margin: 0;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

// 应用快捷导航卡片组
.workbench-apps {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.workbench-apps-title {
  margin: 0;
  color: var(--text-regular);
  font-size: 16px;
  font-weight: 600;
}

// 卡片网格：列数定死两断点（ui-design §布局骨架与响应式）
// 默认 2 列（覆盖 1280–1599px）；≥1600px 升 3 列。v1 不另引入断点。
.workbench-app-cards {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  list-style: none;
  margin: 0;
  padding: 0;
}

@media (min-width: 1600px) {
  .workbench-app-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.workbench-app-card-wrap {
  margin: 0;
  padding: 0;
}

.workbench-app-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 20px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background-color 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.workbench-app-card:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-base);
  box-shadow: var(--shadow-base);
}

.workbench-app-card:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 2px;
}

.workbench-app-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.workbench-app-card-icon {
  color: var(--accent-primary);
  font-size: 20px;
  line-height: 1;
}

.workbench-app-card-label {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}

.workbench-app-card-desc {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.4;
}

// 受限视图提示（零租户 E3，tenant.none 契约文案）
.workbench-restricted-notice {
  margin: 4px 0 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-warning) 10%, transparent);
  color: var(--color-warning);
  font-size: 13px;
}

// 窄屏（< 1024px）：我的信息单列；卡片保持 2 列（不另引入断点）
@media (max-width: 1023px) {
  .workbench-profile {
    grid-template-columns: 1fr;
  }
}
</style>
