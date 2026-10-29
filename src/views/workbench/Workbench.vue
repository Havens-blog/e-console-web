<script setup lang="ts">
// 工作台（UF-3）—— 欢迎横幅 + 我的信息 + 统计概览 + 快捷操作 + 应用导航 + 公告。
//
// 参照：ui-design UF-3 + tech-design §Architecture（视图 → store → api 单向数据流）+ Linear 规格
// （theme-variables.scss 已落地 Linear token：暗色近黑画布 + 蓝紫唯一强调色 + 半透明白边框）。
//
// 三态（ui-design UF-3 States）：
// - Default：欢迎 + 我的信息 + 统计/快捷/应用/公告全渲染；
// - 受限视图（零租户 E3，!isAdmin && tenants.length===0）：仅欢迎 + 我的信息；
//   应用卡片禁用（不隐藏）；统计/快捷按权限码过滤（零租户无码 → 自动隐藏）；管理菜单不渲染；
// - eiam 不可用（E12）：静态内容（欢迎 + 我的信息）仍渲染 + 顶部降级提示；卡片跳转禁用。
//
// 我的信息四字段（ui-design Data Binding）：数据源 = user store profile，无需额外端点（Hard Rule）。
//
// 统计概览（新增，best-effort）：数据源 = eiam 既有 list 端点（user/list、role/list、tenant/list、
// department/list），limit=1 取 total。按权限码过滤（can(code)），单项失败静默降级为「—」，
// 不阻断工作台主内容渲染（Promise.allSettled 容错）。
//
// 快捷操作（新增）：本地穷举枚举（与 AppSwitcher CONSOLE_ENTRIES 同口径），按权限码 + adminOnly
// 双闸过滤，站内 router.push 跳转。
//
// 公告（新增）：静态穷举（后端暂无公告端点，本地占位，后续可接配置源）。
import { computed, onMounted, ref, type Component } from "vue";
import { useRouter } from "vue-router";
import {
  Bell,
  Connection,
  Document,
  Grid,
  Lock,
  Monitor,
  OfficeBuilding,
  ChatDotRound,
  User,
  UserFilled,
} from "@element-plus/icons-vue";
import { useUserStore } from "@/stores/user";
import { useCan } from "@/composables/useCan";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { inferRoleFromCodes, type MenuRole } from "@/components/layout/menuConfig";
import { listUsers } from "@/api/users";
import { listRolesPage } from "@/api/roles";
import { listTenants } from "@/api/tenants";
import { listOrganizationTree } from "@/api/organizations";
import type { OrganizationNode } from "@/api/types";
import {
  IAM_DEPARTMENT,
  IAM_IDENTITY_SOURCE,
  IAM_PERMISSION,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
} from "@/config/permission-codes";

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
  /** 卡片图标（element-plus icon 组件） */
  icon: Component;
}

/**
 * 穷举本地枚举：「云管」（e-cam-web）+「CMDB」（e-cmdb-web）+「运维 Agent」（opsagent-web）+「WatchAlert」（监控告警）。
 * Hard Rule：不做运行时注册；后续应用增列在此常量逐条登记。与 AppSwitcher APPS 同口径。
 */
const APPS: readonly AppEntry[] = [
  {
    key: "cam",
    label: "云管",
    desc: "多云资源管理",
    url: import.meta.env.VITE_APP_CAM_BASE ?? "/cam/",
    icon: Monitor,
  },
  {
    key: "cmdb",
    label: "CMDB",
    desc: "资源模型与拓扑",
    url: import.meta.env.VITE_APP_CMDB_BASE ?? "/cmdb/",
    icon: Grid,
  },
  {
    key: "opsagent",
    label: "运维 Agent",
    desc: "对话式排障编排",
    url: import.meta.env.VITE_APP_OPSAGENT_BASE ?? "/opsagent/",
    icon: ChatDotRound,
  },
  {
    key: "watchalert",
    label: "WatchAlert",
    desc: "监控告警",
    url: import.meta.env.VITE_APP_WATCHALERT_BASE ?? "/watchalert/",
    icon: Bell,
  },
];

const userStore = useUserStore();
const router = useRouter();
const { can } = useCan();

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

/** 时段问候（丰富欢迎横幅；不干扰「欢迎，昵称」主标题） */
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
});

/** 今日日期（zh-CN 长格式，横幅副文案） */
const todayLabel = computed(() =>
  new Date().toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }),
);

/** 应用卡片点击：新标签打开（共享 cookie SSO）；禁用态拦截 */
function openApp(app: AppEntry): void {
  if (cardsDisabled.value) return;
  // noopener 防新标签操作旧页面（target=_blank 反劫持，与 AppSwitcher 同款）
  window.open(app.url, "_blank", "noopener");
}

// ---- 统计概览（best-effort，eiam 既有 list 端点 total）----

/** 统计卡片条目 */
interface StatCard {
  key: string;
  label: string;
  icon: Component;
  /** 数值；null = 加载中/加载失败（渲染「—」） */
  count: number | null;
  /** 是否有权限查看（按权限码过滤，无权限不渲染该卡） */
  visible: boolean;
}

const userCount = ref<number | null>(null);
const roleCount = ref<number | null>(null);
const tenantCount = ref<number | null>(null);
const orgCount = ref<number | null>(null);

/** 组织树节点计数（department/list 返回嵌套树，递归累计） */
function countOrgNodes(nodes: readonly OrganizationNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n += 1;
    if (node.children && node.children.length > 0) {
      n += countOrgNodes(node.children);
    }
  }
  return n;
}

/** 有权限则拉取对应统计数（单项失败静默降级 null → 渲染「—」） */
async function loadStats(): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (can(IAM_USER.VIEW)) {
    jobs.push(
      listUsers({ offset: 0, limit: 1, keyword: "" })
        .then((p) => {
          userCount.value = p.total;
        })
        .catch(() => {}),
    );
  }
  if (can(IAM_ROLE.VIEW)) {
    jobs.push(
      listRolesPage({ offset: 0, limit: 1, keyword: "" })
        .then((p) => {
          roleCount.value = p.total;
        })
        .catch(() => {}),
    );
  }
  if (can(IAM_TENANT.VIEW) && userStore.isAdmin) {
    jobs.push(
      listTenants({ offset: 0, limit: 1, keyword: "" })
        .then((p) => {
          tenantCount.value = p.total;
        })
        .catch(() => {}),
    );
  }
  if (can(IAM_DEPARTMENT.VIEW)) {
    jobs.push(
      listOrganizationTree()
        .then((nodes) => {
          orgCount.value = countOrgNodes(nodes);
        })
        .catch(() => {}),
    );
  }
  await Promise.allSettled(jobs);
}

/** 统计卡片列表（权限过滤后） */
const statCards = computed<StatCard[]>(() =>
  [
    { key: "users", label: "用户", icon: User, count: userCount.value, visible: can(IAM_USER.VIEW) },
    { key: "roles", label: "角色", icon: UserFilled, count: roleCount.value, visible: can(IAM_ROLE.VIEW) },
    { key: "tenants", label: "租户", icon: Grid, count: tenantCount.value, visible: can(IAM_TENANT.VIEW) && userStore.isAdmin },
    { key: "orgs", label: "组织", icon: OfficeBuilding, count: orgCount.value, visible: can(IAM_DEPARTMENT.VIEW) },
  ].filter((s) => s.visible),
);

// ---- 快捷操作（本地穷举，与 AppSwitcher CONSOLE_ENTRIES 同口径）----

/** 快捷操作条目 */
interface QuickAction {
  key: string;
  label: string;
  desc: string;
  icon: Component;
  to: string;
  /** 权限码（缺省放行） */
  code?: string;
  /** 平台管理员仅见 */
  adminOnly?: boolean;
}

/** 控制台快捷操作全集（站内跳转；策略/租户 requiresAdmin 双闸） */
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: "users", label: "用户管理", desc: "身份主体", icon: User, to: "/users", code: IAM_USER.VIEW },
  { key: "orgs", label: "组织架构", desc: "部门治理", icon: OfficeBuilding, to: "/organizations", code: IAM_DEPARTMENT.VIEW },
  { key: "roles", label: "角色管理", desc: "角色与绑定", icon: UserFilled, to: "/roles", code: IAM_ROLE.VIEW },
  { key: "authz", label: "授权治理", desc: "绑定关系", icon: Lock, to: "/authorizations", code: IAM_PERMISSION.VIEW_AUTHORIZATIONS },
  { key: "idps", label: "身份源", desc: "LDAP/OIDC", icon: Connection, to: "/identity-sources", code: IAM_IDENTITY_SOURCE.VIEW },
  { key: "policies", label: "策略管理", desc: "策略定义", icon: Document, to: "/policies", code: IAM_POLICY.VIEW, adminOnly: true },
  { key: "tenants", label: "租户管理", desc: "租户治理", icon: Grid, to: "/tenants", code: IAM_TENANT.VIEW, adminOnly: true },
];

/** 快捷操作可见列表（权限码 + adminOnly 双闸，与菜单/路由守卫同口径） */
const quickActions = computed<QuickAction[]>(() =>
  QUICK_ACTIONS.filter(
    (a) => (!a.code || can(a.code)) && (!a.adminOnly || userStore.isAdmin),
  ),
);

/** 快捷操作点击：站内 router.push（控制台内部模块） */
function goQuick(action: QuickAction): void {
  if (isRestricted.value) return;
  void router.push(action.to);
}

// ---- 公告（静态穷举占位，后端暂无公告端点）----

/** 公告条目 */
interface Notice {
  id: string;
  title: string;
  tag: string;
  date: string;
}

const notices: readonly Notice[] = [
  {
    id: "n1",
    title: "平台运行环境已切回旧仓构建，控制台/云管/运维 Agent 统一由本地编排脚本启动",
    tag: "系统",
    date: "2026-10-12",
  },
  {
    id: "n2",
    title: "工作台新增统计概览与快捷操作，治理入口一屏直达",
    tag: "功能",
    date: "2026-10-12",
  },
  {
    id: "n3",
    title: "云管 / 运维 Agent / WatchAlert 三大应用已接入统一身份登录",
    tag: "功能",
    date: "2026-10-10",
  },
];

onMounted(() => {
  // 统计概览 best-effort 拉取（权限过滤 + allSettled 容错，失败不阻断主内容）
  void loadStats();
});
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
      <header class="workbench-hero">
        <div class="hero-main">
          <p class="hero-greeting">{{ greeting }} · {{ todayLabel }}</p>
          <!-- 工作台是本模块的落地页：主标题用 h1（此前是 h2，导致整页无 h1） -->
          <h1 class="hero-title">
            欢迎{{ welcomeName ? "，" + welcomeName : "" }}
          </h1>

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
        </div>

        <div class="hero-avatar" aria-hidden="true">
          <span class="hero-avatar-text">{{ (welcomeName || "?").slice(0, 1) }}</span>
        </div>
      </header>

      <!-- 统计概览（按权限过滤；无权限则不渲染该区块） -->
      <section
        v-if="statCards.length > 0"
        class="workbench-stats"
        aria-label="统计概览"
        data-testid="workbench-stats"
      >
        <div
          v-for="s in statCards"
          :key="s.key"
          class="stat-card"
          :data-testid="`stat-card-${s.key}`"
        >
          <span class="stat-icon" aria-hidden="true">
            <el-icon :size="18"><component :is="s.icon" /></el-icon>
          </span>
          <span class="stat-count">{{ s.count === null ? "—" : s.count }}</span>
          <span class="stat-label">{{ s.label }}</span>
        </div>
      </section>

      <!-- 快捷操作（按权限过滤；无权限则不渲染该区块） -->
      <section
        v-if="quickActions.length > 0"
        class="workbench-quick"
        aria-label="快捷操作"
        data-testid="workbench-quick"
      >
        <h2 class="section-title">快捷操作</h2>
        <ul class="quick-grid">
          <li v-for="a in quickActions" :key="a.key" class="quick-wrap">
            <button
              type="button"
              class="quick-item"
              :data-testid="`quick-${a.key}`"
              @click="goQuick(a)"
            >
              <el-icon :size="16" class="quick-icon" aria-hidden="true">
                <component :is="a.icon" />
              </el-icon>
              <span class="quick-text">
                <span class="quick-label">{{ a.label }}</span>
                <span class="quick-desc">{{ a.desc }}</span>
              </span>
            </button>
          </li>
        </ul>
      </section>

      <!-- 应用快捷导航卡片组（列数定死：1280–1599px 2 列、≥1600px 3 列） -->
      <section
        class="workbench-apps"
        :class="{ 'is-disabled': cardsDisabled }"
        aria-label="应用快捷导航"
        data-testid="workbench-apps"
      >
        <h2 class="section-title">应用导航</h2>
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
              <span class="workbench-app-card-icon" aria-hidden="true">
                <el-icon :size="20"><component :is="app.icon" /></el-icon>
              </span>
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

      <!-- 公告（静态占位） -->
      <section class="workbench-notices" aria-label="公告" data-testid="workbench-notices">
        <h2 class="section-title">公告</h2>
        <ul class="notice-list">
          <li v-for="n in notices" :key="n.id" class="notice-item">
            <span class="notice-tag">{{ n.tag }}</span>
            <span class="notice-title">{{ n.title }}</span>
            <span class="notice-date">{{ n.date }}</span>
          </li>
        </ul>
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
  padding: 24px;
}

// ---- 欢迎横幅（Linear hero：半透明表面 + 蓝紫微妙渐变）----
.workbench-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 28px 32px;
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
  background:
    radial-gradient(900px 320px at 0% 0%, rgba(94, 106, 210, 0.16), transparent 60%),
    radial-gradient(700px 280px at 100% 100%, rgba(113, 112, 255, 0.12), transparent 55%),
    var(--bg-surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.hero-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.hero-greeting {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
  letter-spacing: 0.2px;
}

.hero-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 26px;
  font-weight: 590;
  letter-spacing: -0.4px;
  line-height: 1.2;
}

.hero-avatar {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-blue));
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-base);
}

.hero-avatar-text {
  color: #ffffff;
  font-size: 22px;
  font-weight: 590;
  line-height: 1;
}

// 我的信息四字段（只读）
.workbench-profile {
  margin: 12px 0 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px 24px;
}

.workbench-profile-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.workbench-profile-label {
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 400;
}

.workbench-profile-value {
  margin: 0;
  color: var(--text-regular);
  font-size: 14px;
  font-weight: 510;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// ---- 区块标题 ----
.section-title {
  margin: 0 0 14px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.1px;
}

// ---- 统计概览（Linear surface 卡片：半透明白 + 白边框）----
.workbench-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  box-shadow: var(--shadow-sm);
  transition: border-color 120ms ease, transform 120ms ease;
}

.stat-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.stat-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
}

.stat-count {
  color: var(--text-primary);
  font-size: 26px;
  font-weight: 590;
  letter-spacing: -0.5px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 400;
  margin-left: auto;
}

// ---- 快捷操作（ghost 按钮式卡片）----
.quick-grid {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.quick-wrap {
  min-width: 0;
}

.quick-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-regular);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.quick-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-base);
}

.quick-item:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.quick-icon {
  flex-shrink: 0;
  color: var(--accent-blue);
}

.quick-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.quick-label {
  color: var(--text-regular);
  font-size: 13.5px;
  font-weight: 510;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.quick-desc {
  color: var(--text-tertiary);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

// ---- 应用导航卡片 ----
.workbench-app-cards {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.workbench-app-card {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  grid-template-areas:
    "icon label"
    "icon desc";
  column-gap: 14px;
  align-items: center;
  width: 100%;
  padding: 18px 20px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    transform 120ms ease;
}

.workbench-app-card:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-base);
  transform: translateY(-1px);
}

.workbench-app-card:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.workbench-app-card:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.workbench-app-card-icon {
  grid-area: icon;
  align-self: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
}

.workbench-app-card-label {
  grid-area: label;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 590;
}

.workbench-app-card-desc {
  grid-area: desc;
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

// ---- 公告 ----
.notice-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--bg-surface);
  overflow: hidden;
}

.notice-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.notice-item:last-child {
  border-bottom: none;
}

.notice-tag {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 9999px;
  border: 1px solid var(--border-base);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 510;
}

.notice-title {
  flex: 1;
  min-width: 0;
  color: var(--text-regular);
  font-size: 13px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notice-date {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

// 窄屏（< 1024px）：我的信息单列；卡片保持 2 列（不另引入断点）
@media (max-width: 1023px) {
  .workbench-profile {
    grid-template-columns: 1fr;
  }

  .workbench-hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .hero-avatar {
    position: absolute;
    top: 24px;
    right: 24px;
  }
}
</style>
