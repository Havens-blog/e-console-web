<script setup lang="ts">
// 全局搜索命令面板（P2 驾驶舱增强）—— Ctrl/⌘ + K 唤起，模糊搜索控制台可达目的地并键盘直达。
//
// 设计约束（与侧边栏同口径，守 Hard Rule）：
// - 候选集 = groupedVisibleMenu(权限可见菜单项)，即路由守卫同源的权限码裁剪结果；
//   不注入外部应用（云管/CMDB 等走 AppSwitcher 新标签打开，不混入控制台路由导航）。
// - 零租户受限态自然收敛：groupedVisibleMenu 的 restricted 分支仅留工作台。
//
// 唤起方式：
// - 全局 Ctrl/⌘ + K 切换开合（捕获阶段 preventDefault，避免浏览器默认行为）；
// - 顶部搜索入口按钮派发 window 事件 'hc:open-command-palette'（松耦合，仿 hc:forbidden）。
//
// 交互：输入过滤 + ↑/↓ 移动高亮 + Enter 直达 + Esc 关闭 + 点击遮罩关闭；打开即聚焦输入框。
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Search } from "@element-plus/icons-vue";
import { useUserStore } from "@/stores/user";
import { groupedVisibleMenu, type MenuItem } from "./menuConfig";

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

const open = ref(false);
const query = ref("");
const activeIndex = ref(0);
const inputRef = ref<HTMLInputElement | null>(null);

/** 候选目的地（含所属组标题，权限码裁剪后；与侧边栏同源） */
interface Destination extends MenuItem {
  groupTitle: string;
}

const destinations = computed<Destination[]>(() => {
  const groups = groupedVisibleMenu({
    codes: userStore.permissions,
    isAdmin: userStore.isAdmin,
    restricted: !userStore.isAdmin && userStore.tenants.length === 0,
  });
  return groups.flatMap((g) =>
    g.items.map((i) => ({ ...i, groupTitle: g.group.title })),
  );
});

/**
 * 最近访问路径（会话内内存，最近优先，去重，最多 5 条）。
 * Hard Rule：persistedstate 仅 theme store 独占——此处不落 localStorage，仅会话内有效，
 * 硬刷新重置。数据来源是用户真实导航历史（watch route.path），不伪造。
 */
const recentPaths = ref<string[]>([]);
const RECENT_MAX = 5;

watch(
  () => route.path,
  (path) => {
    // 仅记录当前权限可达的目的地（避免记录 403/登录等非菜单路径）
    if (!destinations.value.some((d) => d.path === path)) return;
    recentPaths.value = [
      path,
      ...recentPaths.value.filter((p) => p !== path),
    ].slice(0, RECENT_MAX);
  },
  { immediate: true },
);

/** 某目的地是否在最近访问中（用于徽标 + 排序） */
function recentRank(path: string): number {
  const i = recentPaths.value.indexOf(path);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** 是否最近访问过（模板徽标用，避免模板内引用 Number 常量） */
function isRecent(path: string): boolean {
  return recentPaths.value.includes(path);
}

/** 空查询时的排序：最近访问优先（当前页本身也在列，便于快速回跳其他页） */
const orderedDestinations = computed<Destination[]>(() => {
  return [...destinations.value].sort(
    (a, b) => recentRank(a.path) - recentRank(b.path),
  );
});

/** 过滤结果（标题/组名大小写不敏感子串匹配；空查询按最近访问优先排序） */
const filtered = computed<Destination[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return orderedDestinations.value;
  return destinations.value.filter(
    (d) =>
      d.label.toLowerCase().includes(q) ||
      d.groupTitle.toLowerCase().includes(q),
  );
});

// 过滤变化时高亮回到首项（避免越界）
watch(filtered, () => {
  activeIndex.value = 0;
});

function openPalette(): void {
  open.value = true;
  query.value = "";
  activeIndex.value = 0;
  void nextTick(() => inputRef.value?.focus());
}

function closePalette(): void {
  open.value = false;
}

function togglePalette(): void {
  if (open.value) closePalette();
  else openPalette();
}

/** 直达目的地（当前页则仅关闭，不重复 push） */
function go(dest: Destination | undefined): void {
  if (!dest) return;
  closePalette();
  if (route.path !== dest.path) void router.push(dest.path);
}

function onInputKeydown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (filtered.value.length > 0) {
      activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
    }
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (filtered.value.length > 0) {
      activeIndex.value =
        (activeIndex.value - 1 + filtered.value.length) % filtered.value.length;
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    go(filtered.value[activeIndex.value]);
  }
}

// 全局快捷键：Ctrl/⌘ + K 切换；Esc 关闭（面板打开时）
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    togglePalette();
    return;
  }
  if (open.value && e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
}

function onOpenEvent(): void {
  openPalette();
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown, { capture: true });
  window.addEventListener("hc:open-command-palette", onOpenEvent);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown, { capture: true });
  window.removeEventListener("hc:open-command-palette", onOpenEvent);
});

defineExpose({ openPalette, closePalette });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="cmdk-overlay"
      data-testid="command-palette"
      @click.self="closePalette"
    >
      <div
        class="cmdk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <div class="cmdk-input-row">
          <el-icon :size="18" class="cmdk-input-icon" aria-hidden="true">
            <component :is="Search" />
          </el-icon>
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            class="cmdk-input"
            placeholder="搜索页面…（↑↓ 选择，Enter 直达，Esc 关闭）"
            data-testid="command-palette-input"
            autocomplete="off"
            spellcheck="false"
            @keydown="onInputKeydown"
          />
          <kbd class="cmdk-kbd">Esc</kbd>
        </div>

        <ul v-if="filtered.length > 0" class="cmdk-list" role="listbox">
          <li
            v-for="(d, i) in filtered"
            :key="d.key"
            class="cmdk-item"
            :class="{ 'is-active': i === activeIndex }"
            role="option"
            :aria-selected="i === activeIndex"
            :data-testid="`cmdk-item-${d.key}`"
            @click="go(d)"
            @mousemove="activeIndex = i"
          >
            <span class="cmdk-item-icon" aria-hidden="true">
              <el-icon :size="16"><component :is="d.icon" /></el-icon>
            </span>
            <span class="cmdk-item-label">{{ d.label }}</span>
            <span
              v-if="!query.trim() && isRecent(d.path)"
              class="cmdk-item-recent"
              data-testid="cmdk-recent-badge"
            >最近</span>
            <span class="cmdk-item-group">{{ d.groupTitle }}</span>
          </li>
        </ul>

        <div v-else class="cmdk-empty" data-testid="command-palette-empty">
          未找到匹配的页面
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
.cmdk-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.cmdk-dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--border-strong);
  background: var(--bg-overlay);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.cmdk-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.cmdk-input-icon {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.cmdk-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 15px;
  font-family: inherit;
  outline: none;

  &::placeholder {
    color: var(--text-tertiary);
  }
}

.cmdk-kbd {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--border-base);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-tertiary);
  font-size: 11px;
  font-family: var(--font-mono);
}

.cmdk-list {
  margin: 0;
  padding: 6px;
  list-style: none;
  overflow-y: auto;
}

.cmdk-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-regular);
}

.cmdk-item.is-active {
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  color: var(--accent-blue);
}

.cmdk-item-icon {
  flex-shrink: 0;
  color: inherit;
}

.cmdk-item-label {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 510;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cmdk-item-recent {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  color: var(--accent-blue);
  font-size: 11px;
  font-weight: 510;
}

.cmdk-item-group {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

.cmdk-empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
