<script setup lang="ts">
// 主布局壳（task 2.8，UF-2）：左侧边栏 + 顶部 header + 内容区 router-view outlet。
//
// .layout 100vh 两栏：左侧边栏（自身滚动）+ 右侧 .main-area（header + 内容 outlet 各自滚动）。
//
// 折叠/抽屉态（UF-2 States）：
//   - 桌面（>= 1024px）：折叠按钮切 220px ↔ 64px（300ms 过渡），仅图标 + tooltip
//   - 窄屏（< 1024px）：折叠按钮转抽屉开合，抽屉打开时覆盖层 + 点击空白关闭
//
// 三态收敛（UF-2 States）：
//   - 403 原地 toast（请求层 ApiError kind=forbidden → ElMessage 契约文案 forbidden）
//   - 401 跳登录（请求层 eiamAxios 响应拦截器 redirectToLogin，守卫链 ① 同向）
//   - 零租户受限态：侧边栏仅工作台（P0 权限码裁剪口径 restricted → 无码项）+ header
//     租户选择器禁用占位 + 平台导航隐藏（AppSwitcher isRestricted，task 6.1）
//
// 注：租户选择器为 3.1 TenantSelector 共享组件，**由本布局经 AppHeader 的
// #header-actions slot 注入**；平台导航 AppSwitcher（6.1）经 AppHeader 的
// **#header-nav slot**（面包屑旁）注入。
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage } from "element-plus";
import AppHeader from "@/components/layout/AppHeader.vue";
import SidebarMenu from "@/components/layout/SidebarMenu.vue";
import TenantSelector from "@/components/TenantSelector.vue";
import AppSwitcher from "@/components/AppSwitcher.vue";

/** 折叠态（桌面 64px / 展开 220px） */
const collapsed = ref(false);
/** 抽屉打开（窄屏 < 1024px 时折叠按钮转抽屉开合） */
const drawerOpen = ref(false);
/** 是否窄屏（< 1024px 侧边栏转抽屉，UF-2 响应式） */
const isNarrow = ref(false);

const NARROW_BREAKPOINT = 1024;

function updateBreakpoint(): void {
  isNarrow.value = window.innerWidth < NARROW_BREAKPOINT;
  // 进入窄屏：收起折叠态（抽屉默认关闭）；离开窄屏：恢复桌面折叠态
  if (isNarrow.value) {
    collapsed.value = false;
    drawerOpen.value = false;
  }
}

let mediaQuery: MediaQueryList | null = null;
function onMediaChange(e: MediaQueryListEvent): void {
  isNarrow.value = !e.matches;
  if (isNarrow.value) {
    collapsed.value = false;
    drawerOpen.value = false;
  }
}

onMounted(() => {
  updateBreakpoint();
  mediaQuery = window.matchMedia(`(min-width: ${NARROW_BREAKPOINT}px)`);
  mediaQuery.addEventListener("change", onMediaChange);
});

onUnmounted(() => {
  mediaQuery?.removeEventListener("change", onMediaChange);
});

/** 折叠按钮：桌面切折叠态，窄屏切抽屉开合 */
function onToggleCollapse(): void {
  if (isNarrow.value) {
    drawerOpen.value = !drawerOpen.value;
  } else {
    collapsed.value = !collapsed.value;
  }
}

/** 抽屉覆盖层点击关闭 */
function onDrawerOverlayClick(): void {
  drawerOpen.value = false;
}

/** logo 点击：窄屏下顺手关抽屉（桌面态回工作台由 SidebarMenu 自身 router.push 处理） */
function onLogoClick(): void {
  if (isNarrow.value) drawerOpen.value = false;
}

/** 传给 AppHeader 的 collapsed：桌面态用 collapsed，窄屏抽屉打开时视作展开 */
const headerCollapsed = computed(() =>
  isNarrow.value ? !drawerOpen.value : collapsed.value,
);

// 403 原地 toast：监听 window 自定义事件 'hc:forbidden'（请求层 / store catch 可派发）。
// 文案出口走契约 forbidden（逐字「无权限执行该操作」，Hard Rule 零二次映射）。
// 请求层 eiam.ts 为拷贝面（shared-hashes.json 锁定），不在本任务改其拦截器；
// store catch 路径由 4.x/5.x 落地时派发此事件，布局侧提供 toast 承接。
function onForbidden(): void {
  ElMessage({
    message: "无权限执行该操作",
    type: "warning",
    duration: 3000,
    grouping: true,
  });
}

onMounted(() => {
  window.addEventListener("hc:forbidden", onForbidden as EventListener);
});

onUnmounted(() => {
  window.removeEventListener("hc:forbidden", onForbidden as EventListener);
});
</script>

<template>
  <div class="layout">
    <!-- 桌面态侧边栏（抽屉态时改为 fixed 覆盖层） -->
    <!--
      inert（iter307）：窄屏抽屉收起时，侧栏只是被 transform 平移到视口外（x=-221），
      DOM 仍可见、10 个可聚焦元素仍在 Tab 序列里 —— 实测按 Tab 8 次全部落在视口外的菜单项上，
      键盘用户会以为键盘失灵。加 inert 一并阻止聚焦与读屏播报；抽屉打开时（drawerOpen）恢复。
    -->
    <SidebarMenu
      :class="{ 'is-drawer-mounted': isNarrow }"
      :collapsed="isNarrow ? false : collapsed"
      :drawer-open="drawerOpen"
      :inert="isNarrow && !drawerOpen"
      @logo-click="onLogoClick"
    />
    <!-- 窄屏抽屉覆盖层（点击关闭） -->
    <div
      v-if="isNarrow && drawerOpen"
      class="layout-drawer-overlay"
      aria-hidden="true"
      @click="onDrawerOverlayClick"
    />

    <div class="main-area">
      <AppHeader
        :collapsed="headerCollapsed"
        @toggle-collapse="onToggleCollapse"
      >
        <template #header-nav>
          <AppSwitcher />
        </template>
        <template #header-actions>
          <TenantSelector />
        </template>
      </AppHeader>
      <main class="layout-content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped lang="scss">
.layout {
  display: flex;
  height: 100vh;
  width: 100%;
  background: var(--bg-base);
  overflow: hidden;
}

// 窄屏抽屉：侧边栏脱离流式定位，fixed 覆盖
:deep(.sidebar.is-drawer-mounted) {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 1000;
  transform: translateX(-100%);
  transition: transform 300ms ease;
}

:deep(.sidebar.is-drawer-mounted.is-drawer) {
  // is-drawer class 由 SidebarMenu drawerOpen prop 触发（见 SidebarMenu 根 class 绑定）
  transform: translateX(0);
}

.layout-drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 999;
}

.main-area {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  height: 100vh;
  overflow: hidden;
}

.layout-content {
  flex: 1;
  padding: 24px;
  background: var(--bg-base);
  overflow-y: auto;
  min-width: 0;
}
</style>
