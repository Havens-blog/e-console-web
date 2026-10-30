<script setup lang="ts">
// 顶部 header（task 2.8，UF-2）：折叠按钮 + 面包屑 + 平台导航 + 主题切换 + 用户头像下拉（登出）。
//
// 左 = 折叠按钮 + 面包屑（首页 / 当前页，当前页取自侧边栏 active 项文案）+ 平台导航触发
//     器（邻接面包屑）右 = 租户选择器占位 + 主题切换（月/日）+ 用户头像（渐变）+ 用户名
//
// 注入说明（task 3.1 / 6.1）：租户选择器（TenantSelector 共享组件）由 MainLayout 经
// #header-actions slot 注入；平台导航（AppSwitcher v2 面板触发器）由 MainLayout 经
// **#header-nav slot**（面包屑右侧）注入。零租户受限态由各组件自处理：TenantSelector
// 显示契约 tenant.none 禁用占位、AppSwitcher v-if 隐藏（UF-2 受限视图）。
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Expand, Fold, Moon, Sunny } from "@element-plus/icons-vue";
import { logout } from "@/api/auth";
import { useUserStore } from "@/stores/user";
import { useThemeStore } from "@/stores/theme";
import { findMenuItemByPath } from "./menuConfig";

const props = defineProps<{
  /** 侧边栏折叠态（折叠按钮图标随态切换） */
  collapsed: boolean;
}>();

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();
const themeStore = useThemeStore();

const emit = defineEmits<{
  /** 点击折叠按钮（父 MainLayout 切 collapsed / drawerOpen） */
  (e: "toggle-collapse"): void;
}>();

/** 当前页文案（取自侧边栏 active 项文案；非菜单页回退 route.meta title 或路径段） */
const currentPageLabel = computed(() => {
  const item = findMenuItemByPath(route.path);
  if (item) return item.label;
  if (route.path === "/login") return "登录";
  if (route.name === "forbidden") return "无权限";
  return "当前页";
});

/** 显示名（nickname 缺失回退 username，与 user store displayName 同款） */
const displayName = computed(() => userStore.profile?.displayName ?? "未登录");

/** 用户名（username，头像旁副文案） */
const username = computed(() => userStore.profile?.username ?? "");

/** 主题图标随主题互换：dark → 月（点切日），light → 日（点切月） */
const themeIcon = computed(() => (themeStore.theme === "dark" ? Moon : Sunny));
const themeLabel = computed(() =>
  themeStore.theme === "dark" ? "切换为浅色主题" : "切换为深色主题",
);

async function onLogout(): Promise<void> {
  // 登出：销毁共享 Redis session（POST /api/iam/user/logout）。
  // 不论 API 是否成功，复位本地会话态 + SPA 跳 /login（与请求层 401 收敛同向）。
  try {
    await logout();
  } catch {
    // 网络失败不阻断登出流程：本地复位 + 跳登录，下次请求自然 401 收敛
  } finally {
    userStore.resetState();
    router.push("/login");
  }
}

function onToggleCollapse(): void {
  emit("toggle-collapse");
}
</script>

<template>
  <header class="app-header" role="banner">
    <!-- 左：折叠按钮 + 面包屑 -->
    <div class="header-left">
      <button
        type="button"
        class="header-collapse-btn"
        :aria-label="props.collapsed ? '展开侧边栏' : '折叠侧边栏'"
        :aria-expanded="!props.collapsed"
        @click="onToggleCollapse"
      >
        <el-icon :size="18" aria-hidden="true">
          <component :is="props.collapsed ? Expand : Fold" />
        </el-icon>
      </button>
      <nav class="header-breadcrumb" aria-label="面包屑">
        <ol>
          <li class="breadcrumb-home">
            <router-link to="/workbench">首页</router-link>
          </li>
          <li class="breadcrumb-sep" aria-hidden="true">/</li>
          <li class="breadcrumb-current" aria-current="page">
            {{ currentPageLabel }}
          </li>
        </ol>
      </nav>
      <!-- 平台导航（AppSwitcher v2 面板触发器，MainLayout 经 #header-nav slot 注入，
           置于面包屑旁，task 6.1 位置决策） -->
      <slot name="header-nav" />
    </div>

    <!-- 右：租户选择器（MainLayout 经 #header-actions slot 注入，task 3.1） + 主题切换 + 用户头像下拉 -->
    <div class="header-right">
      <div class="header-actions">
        <slot name="header-actions" />
      </div>

      <!-- 主题切换（月/日，html 根节点切 light class） -->
      <button
        type="button"
        class="header-icon-btn"
        :aria-label="themeLabel"
        @click="themeStore.toggleTheme()"
      >
        <el-icon :size="18" aria-hidden="true">
          <component :is="themeIcon" />
        </el-icon>
      </button>

      <!-- 用户头像下拉（accent-blue → accent-purple 渐变 32px + 用户名 + 登出） -->
      <el-dropdown trigger="click" placement="bottom-end" @command="onLogout">
        <button
          type="button"
          class="header-user-trigger"
          aria-label="用户菜单"
          aria-haspopup="menu"
        >
          <span class="header-avatar" aria-hidden="true">
            {{ displayName.charAt(0).toUpperCase() }}
          </span>
          <span class="header-username">{{ displayName }}</span>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item disabled>{{ username }}</el-dropdown-item>
            <el-dropdown-item divided command="logout"> 登出 </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </header>
</template>

<style scoped lang="scss">
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
  padding: 0 20px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.header-collapse-btn,
.header-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-regular);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.header-collapse-btn:hover,
.header-icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.header-collapse-btn:focus-visible,
.header-icon-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.header-breadcrumb ol {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 13px;
}

.breadcrumb-home a {
  color: var(--text-secondary);
  text-decoration: none;
}

.breadcrumb-home a:hover {
  color: var(--text-primary);
}

.breadcrumb-sep {
  color: var(--text-tertiary);
}

.breadcrumb-current {
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.header-user-trigger {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 0 4px;
  color: var(--text-regular);
}

.header-user-trigger:hover {
  color: var(--text-primary);
}

.header-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  // accent-blue → accent-purple 渐变（UF-2）
  background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}

.header-username {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 手机窄屏（≤560）：顶栏放不下「折叠钮 + 面包屑 + 平台导航 + 租户选择器 + 主题 + 用户」。
   390 视口实测：.header-left 需要 187px 却只分到 139px，导致「平台导航」被压到 13px 宽、
   中文逐字竖排成 68px 高的竖条；租户选择器更被压到 20px，等于不可用。
   取舍：窄屏隐藏面包屑（当前页标题在正文 h1 里已有）与租户选择器
   （工作台的「我的信息」卡里有租户，且 /tenant-select 是独立页），
   保留折叠钮、平台导航、主题切换、用户菜单这四项真正需要随时可达的操作。 */
@media (max-width: 560px) {
  .header-left,
  .header-right {
    gap: 8px;
  }

  .header-breadcrumb,
  .header-actions {
    display: none;
  }
}
</style>
