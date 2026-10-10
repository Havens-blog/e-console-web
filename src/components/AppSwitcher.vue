<script setup lang="ts">
/**
 * 平台导航面板（v2，task 3.1 升级，UF-2 应用切换优化）。
 *
 * 参照 e-cam-web PlatformNav（e-cam-web/src/components/PlatformNav/index.vue）：
 * 居中面板 + 左侧「我的收藏」列 + 分组入口列，每条入口 ☆/★ 收藏切换、
 * 收藏列条目悬停 ✕ 移除、localStorage 持久化（shape {key,title,desc,path,external}）。
 *
 * 域模型：
 * - CONSOLE group：控制台内部模块（router.push 站内跳转），面板入口按 P0 权限码过滤
 *   （与菜单/路由守卫同口径，越权不渲染入口）；
 * - CAM group：云管（e-cam-web）深链入口（/cam/* 新标签打开，共享 cookie 免重复登录；
 *   e-cam-web history 路由 base /cam，深链形 /cam/<route path>，nginx 同域形态）；
 * - 收藏：跨应用条目（console 站内 / cam 新标签），默认预置 4 条常用入口。
 *
 * 零租户受限态（!isAdmin && tenants.length===0）隐藏组件（UF-2 受限视图，v1 口径不变）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  ArrowDown,
  Bell,
  Coin,
  Connection,
  Document,
  Grid,
  Lock,
  Monitor,
  OfficeBuilding,
  SetUp,
  User,
  UserFilled,
} from "@element-plus/icons-vue";
import { useUserStore } from "@/stores/user";
import { useCan } from "@/composables/useCan";
import {
  IAM_DEPARTMENT,
  IAM_IDENTITY_SOURCE,
  IAM_PERMISSION,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
} from "@/config/permission-codes";

// ---- 数据集（穷举枚举：新增平台应用在此登记）----

interface NavEntry {
  /** 全局唯一 key（收藏键） */
  key: string;
  /** 入口名 */
  title: string;
  /** 副标题（收藏列展示） */
  desc: string;
  /** element-plus icon 组件（面板图标位） */
  icon: unknown;
  /** 目标路径：console 站内路由 / cam 深链（含 /cam 前缀） */
  to: string;
  /** true = 新标签打开（跨应用） */
  external: boolean;
  /** P0 权限码过滤（缺省放行；平台身份面），console 组限定 */
  code?: string;
  /** 平台管理员仅见（requiresAdmin 同口径），console 组限定 */
  adminOnly?: boolean;
}

/** 分组（面板列） */
interface NavGroup {
  key: string;
  title: string;
  /** 组头圆点色 */
  dot: string;
  /** 组内子区块标题（氚头，pnav-sub 同款）；子区块间切分 */
  sub?: string;
  entries: NavEntry[];
}

/**
 * 控制台组（站内跳转；策略/租户 requiresAdmin 双闸；按钮级过滤与菜单同口径）。
 * 控制台模块全集：工作台/用户/组织/身份源/角色/授权/策略/租户。
 */
const CONSOLE_ENTRIES: readonly NavEntry[] = [
  { key: "console-workbench", title: "工作台", desc: "权限概览", icon: Monitor, to: "/workbench", external: false },
  { key: "console-users", title: "用户管理", desc: "身份主体", icon: User, to: "/users", external: false, code: IAM_USER.VIEW },
  { key: "console-orgs", title: "组织架构", desc: "部门治理", icon: OfficeBuilding, to: "/organizations", external: false, code: IAM_DEPARTMENT.VIEW },
  { key: "console-idps", title: "身份源", desc: "LDAP/OIDC", icon: Connection, to: "/identity-sources", external: false, code: IAM_IDENTITY_SOURCE.VIEW },
  { key: "console-roles", title: "角色管理", desc: "角色与绑定", icon: UserFilled, to: "/roles", external: false, code: IAM_ROLE.VIEW },
  { key: "console-authz", title: "授权治理", desc: "绑定关系清单", icon: Lock, to: "/authorizations", external: false, code: IAM_PERMISSION.VIEW_AUTHORIZATIONS },
  { key: "console-policies", title: "策略管理", desc: "策略定义", icon: Document, to: "/policies", external: false, code: IAM_POLICY.VIEW, adminOnly: true },
  { key: "console-tenants", title: "租户管理", desc: "租户治理", icon: Grid, to: "/tenants", external: false, code: IAM_TENANT.VIEW, adminOnly: true },
];

/**
 * 云管与 CMDB 深链组：
 * - /cam/*  → e-cam-web 云管（router history base /cam）；
 * - /cmdb/* → e-cmdb-web 独立前端（router history base /cmdb），承载资源模型/实例/关系/
 *   服务树/拓扑（CMDB 域已从云管拆出为独立子模块）。
 * 覆盖高频入口：资源·主机 / 网络 / 数据与中间件 / 服务树 / FinOps / 平台管理 / CMDB。
 */
const CAM_GROUPS: readonly NavGroup[] = [
  {
    key: "cam-ecs",
    title: "资源 · 主机",
    dot: "#34d399",
    entries: [
      { key: "cam-vm", title: "虚拟机", desc: "ECS / EC2 / CVM", icon: Monitor, to: "/cam/compute/ecs", external: true },
      { key: "cam-disk", title: "云盘", desc: "块存储", icon: Document, to: "/cam/compute/disk", external: true },
      { key: "cam-sg", title: "安全组", desc: "网络安全", icon: Lock, to: "/cam/compute/security-group", external: true },
    ],
  },
  {
    key: "cam-net",
    title: "资源 · 网络",
    dot: "#34d399",
    entries: [
      { key: "cam-vpc", title: "VPC", desc: "私有网络", icon: Connection, to: "/cam/network/vpc", external: true },
      { key: "cam-cdn", title: "CDN 加速", desc: "内容分发", icon: Connection, to: "/cam/network/cdn", external: true },
      { key: "cam-rds", title: "RDS 云数据库", desc: "关系型数据库", icon: Grid, to: "/cam/databases/rds", external: true },
    ],
  },
  {
    key: "cmdb-svc",
    title: "服务树 · 任务",
    dot: "#34d399",
    entries: [
      { key: "cmdb-svc-tree", title: "服务树总览", desc: "服务治理", icon: SetUp, to: "/cmdb/service-tree", external: true },
      { key: "cmdb-env", title: "环境管理", desc: "环境治理", icon: Grid, to: "/cmdb/service-tree/environments", external: true },
    ],
  },
  {
    key: "cam-fin",
    title: "FINOPS",
    dot: "#fbbf24",
    entries: [
      { key: "cam-cost", title: "成本概览", desc: "成本可视化", icon: Coin, to: "/cam/finops/cost", external: true },
      { key: "cam-alloc", title: "成本分摊", desc: "分摊规则", icon: Coin, to: "/cam/finops/allocation", external: true },
    ],
  },
  {
    key: "cam-platform",
    title: "平台管理",
    dot: "#a78bfa",
    entries: [
      { key: "cam-alert", title: "告警事件", desc: "告警中心", icon: Bell, to: "/cam/alert/events", external: true },
      { key: "cmdb-model", title: "资源模型", desc: "CMDB", icon: SetUp, to: "/cmdb/models", external: true },
      { key: "cmdb-topology", title: "资源拓扑", desc: "链路拓扑", icon: Connection, to: "/cmdb/topology", external: true },
      { key: "cam-account", title: "云账号管理", desc: "多云账号接入", icon: User, to: "/cam/accounts", external: true },
    ],
  },
];

/** 云管深链分区块（导航面板列；跨应用新标签打开） */

// ---- 收藏（localStorage；shape 与 e-cam-web 同构，key 隔离）----

interface FavItem {
  key: string;
  title: string;
  desc: string;
  path: string;
  external: boolean;
}

const FAV_KEY = "haven-platform-nav-favorites";

/** 默认收藏（首次无存储时）：控制台常用 ×2 + 云管常用 ×2 */
const DEFAULT_FAVS: readonly FavItem[] = [
  { key: "console-workbench", title: "工作台", desc: "控制台 · 权限概览", path: "/workbench", external: false },
  { key: "console-policies", title: "策略管理", desc: "控制台 · 策略定义", path: "/policies", external: false },
  { key: "cam-vm", title: "虚拟机", desc: "云管 · 资源", path: "/cam/compute/ecs", external: true },
  { key: "cam-cost", title: "成本概览", desc: "云管 · FinOps", path: "/cam/finops/cost", external: true },
];

function loadFavorites(): FavItem[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (f): f is FavItem =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as FavItem).key === "string" &&
            typeof (f as FavItem).path === "string",
        );
      }
    }
  } catch {
    /* 损坏回退默认 */
  }
  return [...DEFAULT_FAVS];
}

// ---- 组件态 ----

const userStore = useUserStore();
const router = useRouter();
const { can } = useCan();

const open = ref(false);
const favs = ref<FavItem[]>(loadFavorites());
const panelEl = ref<HTMLElement | null>(null);

/** 零租户受限态（与 v1 及 AppHeader UF-2 受限视图同口径）：非 admin 且无租户 → 隐藏 */
const isRestricted = computed(
  () => !userStore.isAdmin && userStore.tenants.length === 0,
);

/** 控制台组可见入口（P0 权限码过滤，与菜单裁剪同口径；策略/租户额外 requiresAdmin） */
const visibleConsoleEntries = computed(() =>
  CONSOLE_ENTRIES.filter(
    (e) =>
      (!e.code || can(e.code)) && (!e.adminOnly || userStore.isAdmin),
  ),
);

function isFav(key: string): boolean {
  return favs.value.some((f) => f.key === key);
}

function toggleFav(e: NavEntry): void {
  const idx = favs.value.findIndex((f) => f.key === e.key);
  if (idx >= 0) {
    favs.value.splice(idx, 1);
  } else {
    favs.value.push({ key: e.key, title: e.title, desc: e.desc, path: e.to, external: e.external });
  }
  persist();
}

function removeFav(key: string): void {
  favs.value = favs.value.filter((f) => f.key !== key);
  persist();
}

function persist(): void {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favs.value));
  } catch {
    /* 存储不可用静默（收藏为体验层功能） */
  }
}

function go(entry: NavEntry | FavItem): void {
  const path = "to" in entry ? entry.to : entry.path;
  close();
  if (entry.external && (path.startsWith("/cam/") || path.startsWith("/cmdb/"))) {
    // 跨应用深链：新标签打开 /cam/<path> 或 /cmdb/<path>
    // （共享 cookie 免重复登录；noopener 反劫持）
    window.open(path, "_blank", "noopener");
    return;
  }
  // 站内导航（收藏缺省 path 均为站内 router 路径）
  void router.push(path);
}

function close(): void {
  open.value = false;
}

function togglePanel(): void {
  open.value = !open.value;
}

// 面板外点击关闭（overlay 承接）+ Esc 关闭
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && open.value) close();
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
});

// 面板打开后焦点移入第一个收藏（可访问性）；无收藏则首列首入口
function focusPanel(): void {
  void nextTick(() => {
    panelEl.value?.querySelector<HTMLElement>("[data-nav-item]")?.focus();
  });
}

function onTogglePanel(): void {
  togglePanel();
  if (open.value) focusPanel();
}
</script>

<template>
  <div v-if="!isRestricted" class="app-switcher">
    <button
      type="button"
      class="app-switcher-trigger"
      aria-label="平台导航"
      aria-haspopup="dialog"
      :aria-expanded="open"
      data-testid="platform-nav-trigger"
      @click="onTogglePanel"
    >
      <span class="app-switcher-label">平台导航</span>
      <el-icon :size="12" aria-hidden="true">
        <ArrowDown />
      </el-icon>
    </button>

    <!-- 遮罩（面板下方区域） + 居中面板（平台导航 v2） -->
    <Teleport to="body">
      <Transition name="pnav-fade">
        <div v-if="open" class="pnav-overlay" @click="close" />
      </Transition>
      <Transition name="pnav-slide">
        <div v-if="open" ref="panelEl" class="pnav-panel" role="dialog" aria-label="平台导航">
          <div class="pnav-inner">
            <!-- 我的收藏 -->
            <div class="pnav-fav">
              <div class="pnav-fav-hd mine">★ 我的收藏</div>
              <div
                v-for="f in favs"
                :key="f.key"
                class="pnav-fi"
                tabindex="0"
                data-nav-item
                data-testid="platform-nav-fav"
                @click="go(f)"
                @keydown.enter="go(f)"
              >
                <div class="pnav-fi-info">
                  <div class="pnav-fi-name">{{ f.title }}</div>
                  <div class="pnav-fi-desc">{{ f.desc }}</div>
                </div>
                <span
                  class="pnav-fi-rm"
                  role="button"
                  :aria-label="`取消收藏 ${f.title}`"
                  data-testid="platform-nav-fav-remove"
                  @click.stop="removeFav(f.key)"
                >✕</span>
              </div>
              <div v-if="!favs.length" class="pnav-fi-empty">
                点击右侧 ☆ 收藏常用入口
              </div>
            </div>

            <!-- 控制台 -->
            <div class="pnav-col">
              <div class="pnav-hd"><span class="pnav-dot" style="background: #60a5fa" />控制台 · 统一身份与访问</div>
              <div
                v-for="e in visibleConsoleEntries"
                :key="e.key"
                class="pnav-it"
                tabindex="0"
                data-nav-item
                @click="go(e)"
                @keydown.enter="go(e)"
              >
                <el-icon :size="16" class="pnav-icon" aria-hidden="true">
                  <component :is="e.icon" />
                </el-icon>
                <span>{{ e.title }}</span>
                <i
                  :class="{ on: isFav(e.key) }"
                  role="button"
                  :aria-label="isFav(e.key) ? `取消收藏 ${e.title}` : `收藏 ${e.title}`"
                  :data-testid="`platform-nav-star-${e.key}`"
                  @click.stop="toggleFav(e)"
                >{{ isFav(e.key) ? "★" : "☆" }}</i>
              </div>
            </div>

            <!-- 云管（分组子区块，参照 e-cam-web PlatformNav 布局） -->
            <div
              v-for="g in CAM_GROUPS"
              :key="g.key"
              class="pnav-col"
              :class="{ 'pnav-col-sm': g.entries.length <= 3 }"
            >
              <div class="pnav-hd"><span class="pnav-dot" :style="{ background: g.dot }" />{{ g.title }}</div>
              <div
                v-for="e in g.entries"
                :key="e.key"
                class="pnav-it"
                tabindex="0"
                data-nav-item
                @click="go(e)"
                @keydown.enter="go(e)"
              >
                <el-icon :size="16" class="pnav-icon" aria-hidden="true">
                  <component :is="e.icon" />
                </el-icon>
                <span>{{ e.title }}</span>
                <i
                  :class="{ on: isFav(e.key) }"
                  role="button"
                  :aria-label="isFav(e.key) ? `取消收藏 ${e.title}` : `收藏 ${e.title}`"
                  :data-testid="`platform-nav-star-${e.key}`"
                  @click.stop="toggleFav(e)"
                >{{ isFav(e.key) ? "★" : "☆" }}</i>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped lang="scss">
.app-switcher {
  display: inline-flex;
  align-items: center;
}

.app-switcher-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: transparent;
  color: var(--text-regular);
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.app-switcher-trigger:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.app-switcher-trigger:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

/* 遮罩 / 面板（teleport body，fixed 定位；视觉对齐 e-cam-web PlatformNav） */
:global(.pnav-overlay) {
  position: fixed;
  top: 56px;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 9990;
}

:global(.pnav-panel) {
  position: fixed;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  width: 960px;
  max-width: calc(100vw - 40px);
  background: var(--bg-elevated);
  border: 1px solid var(--border-base);
  border-radius: 0 0 12px 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  z-index: 9991;
}

:global(.pnav-inner) {
  display: flex;
  padding: 18px 20px;
  gap: 0;
  width: 100%;
  max-height: 480px;
  overflow-y: auto;
}

/* 收藏列 */
:global(.pnav-fav) {
  width: 180px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-subtle);
  padding-right: 16px;
  margin-right: 16px;
}
:global(.pnav-fav-hd) {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
}
:global(.pnav-fav-hd.mine) {
  color: #fbbf24;
}
:global(.pnav-fi) {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 5px;
  cursor: pointer;
  outline: none;
  transition: background 120ms;
}
:global(.pnav-fi:hover),
:global(.pnav-fi:focus-visible) {
  background: var(--bg-hover);
}
:global(.pnav-fi:hover .pnav-fi-rm) {
  opacity: 0.5;
}
:global(.pnav-fi-info) {
  flex: 1;
  min-width: 0;
}
:global(.pnav-fi-name) {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
:global(.pnav-fi-desc) {
  font-size: 10px;
  color: var(--text-secondary);
}
:global(.pnav-fi-rm) {
  opacity: 0;
  color: var(--text-secondary);
  font-size: 9px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 120ms;
  font-style: normal;
}
:global(.pnav-fi-rm:hover) {
  opacity: 1 !important;
  color: var(--color-danger);
}
:global(.pnav-fi-empty) {
  padding: 10px 4px;
  font-size: 11px;
  color: var(--text-secondary);
  text-align: center;
}

/* 列 */
:global(.pnav-col) {
  padding: 0 14px;
  border-right: 1px solid var(--border-subtle);
  flex: 1;
  min-width: 0;
}
:global(.pnav-col:last-child) {
  border-right: none;
}
:global(.pnav-col-sm) {
  flex: 0.8;
}
:global(.pnav-hd) {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 6px;
  letter-spacing: 0.3px;
}
:global(.pnav-dot) {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* 导航项 */
:global(.pnav-it) {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px;
  border-radius: 5px;
  cursor: pointer;
  outline: none;
  transition: background 120ms;
  font-size: 12.5px;
  color: var(--text-primary);
  font-weight: 400;
}
:global(.pnav-it:hover),
:global(.pnav-it:focus-visible) {
  background: var(--bg-hover);
}
:global(.pnav-icon) {
  flex-shrink: 0;
  color: var(--text-secondary);
}
:global(.pnav-it > span) {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
:global(.pnav-it > i) {
  opacity: 0;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 120ms;
  font-style: normal;
}
:global(.pnav-it:hover > i) {
  opacity: 0.5;
}
:global(.pnav-it > i:hover) {
  opacity: 1 !important;
  color: #fbbf24;
}
:global(.pnav-it > i.on) {
  opacity: 1;
  color: #fbbf24;
}

/* 动画 */
:global(.pnav-fade-enter-active),
:global(.pnav-fade-leave-active) {
  transition: opacity 0.2s;
}
:global(.pnav-fade-enter-from),
:global(.pnav-fade-leave-to) {
  opacity: 0;
}
:global(.pnav-slide-enter-active),
:global(.pnav-slide-leave-active) {
  transition: all 0.25s ease;
}
:global(.pnav-slide-enter-from),
:global(.pnav-slide-leave-to) {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
}
:global(.pnav-slide-enter-to),
:global(.pnav-slide-leave-from) {
  opacity: 1;
  max-height: 600px;
}
</style>