<script setup lang="ts">
// 侧边栏（task 2.8，UF-2）：logo 区 + 分组菜单 + 折叠/抽屉态。
//
// - 220px ↔ 64px 折叠（300ms 过渡）；< 1024px 转抽屉（点折叠按钮开合）
// - 分组菜单 3 组 8 项，按权限码裁剪（P0：menuConfig.groupedVisibleMenu(codes)，
//   替代原 inferRole 两档；tenant_admin 档由码自然得出）
// - active = accent-primary 15% 底 + accent-blue 文字/图标；hover = bg-hover
// - 折叠态仅图标，组标题隐藏，el-tooltip + aria-label 兜底
// - logo 区点击回工作台（/workbench）
//
// 折叠/抽屉状态由父 MainLayout 持一（header 折叠按钮与侧边栏共用），经 props 下发。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { groupedVisibleMenu, type MenuVisibility } from './menuConfig'

const props = defineProps<{
  /** 折叠态（true = 64px 仅图标） */
  collapsed: boolean
  /** 抽屉态（< 1024px 时折叠按钮转抽屉开合，true = 抽屉打开覆盖层） */
  drawerOpen: boolean
}>()

const emit = defineEmits<{
  /** 点击 logo 区回工作台 */
  (e: 'logo-click'): void
}>()

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()

/**
 * 菜单可见性信号（P0 权限码驱动，与路由守卫 ③ / 按钮 v-if 同口径）：
 * - codes = profile.permissions（eiam 权威）
 * - restricted = 零租户受限态（!isAdmin && 无所属租户）→ 仅工作台（UF-2 受限视图）
 */
const menuVisibility = computed<MenuVisibility>(() => ({
  codes: userStore.permissions,
  isAdmin: userStore.isAdmin,
  restricted: !userStore.isAdmin && userStore.tenants.length === 0,
}))

const groups = computed(() => groupedVisibleMenu(menuVisibility.value))

/** 当前 active 菜单项（按 route.path 前缀匹配） */
const activeKey = computed(() => {
  const segments = groups.value.flatMap((g) => g.items)
  // 精确优先
  const exact = segments.find((i) => i.path === route.path)
  if (exact) return exact.key
  // 前缀匹配（详情页 /users/:id → users）
  const prefix = segments
    .filter((i) => route.path.startsWith(i.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return prefix?.key ?? ''
})

function go(path: string): void {
  router.push(path)
  emit('logo-click')
}
</script>

<template>
  <aside
    class="sidebar"
    :class="{ 'is-collapsed': props.collapsed, 'is-drawer': props.drawerOpen }"
    aria-label="主导航"
  >
    <!-- logo 区 56px（靛紫 logo 图标 + 产品名「Platform」，点击回工作台） -->
    <button
      type="button"
      class="sidebar-logo"
      :aria-label="props.collapsed ? 'Platform，点击回工作台' : 'Platform'"
      :title="props.collapsed ? '回工作台' : undefined"
      @click="go('/workbench')"
    >
      <span class="sidebar-logo-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span v-show="!props.collapsed" class="sidebar-logo-text">Platform</span>
    </button>

    <!-- 分组菜单 -->
    <nav
      class="sidebar-nav"
      :aria-label="props.collapsed ? '折叠菜单' : '分组菜单'"
    >
      <div v-for="entry in groups" :key="entry.group.id" class="sidebar-group">
        <div
          v-show="!props.collapsed"
          class="sidebar-group-title"
          role="heading"
          aria-level="2"
        >
          {{ entry.group.title }}
        </div>
        <!-- 折叠态组间分隔线（组标题隐藏后以细线区隔） -->
        <div
          v-if="props.collapsed"
          class="sidebar-group-divider"
          aria-hidden="true"
        />

        <!-- 折叠态用 el-tooltip 包裹（悬浮提示菜单文案） -->
        <template v-for="item in entry.items" :key="item.key">
          <el-tooltip
            v-if="props.collapsed"
            :content="item.label"
            placement="right"
            :show-after="200"
          >
            <a
              class="sidebar-item"
              :class="{ 'is-active': activeKey === item.key }"
              :href="`#${item.path}`"
              role="menuitem"
              :aria-label="item.label"
              :aria-current="activeKey === item.key ? 'page' : undefined"
              @click.prevent="go(item.path)"
            >
              <el-icon class="sidebar-item-icon" :size="18" aria-hidden="true">
                <component :is="item.icon" />
              </el-icon>
            </a>
          </el-tooltip>
          <a
            v-else
            class="sidebar-item"
            :class="{ 'is-active': activeKey === item.key }"
            :href="`#${item.path}`"
            role="menuitem"
            :aria-label="item.label"
            :aria-current="activeKey === item.key ? 'page' : undefined"
            :title="item.label"
            @click.prevent="go(item.path)"
          >
            <el-icon class="sidebar-item-icon" :size="18" aria-hidden="true">
              <component :is="item.icon" />
            </el-icon>
            <span class="sidebar-item-label">{{ item.label }}</span>
          </a>
        </template>
      </div>
    </nav>
  </aside>
</template>

<style scoped lang="scss">
.sidebar {
  display: flex;
  flex-direction: column;
  width: 220px;
  height: 100%;
  background: var(--bg-surface);
  border-right: 1px solid var(--border-subtle);
  transition: width 300ms ease;
  overflow: hidden;
}

.sidebar.is-collapsed {
  width: 64px;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 16px;
  border: none;
  background: transparent;
  color: var(--accent-primary);
  cursor: pointer;
  flex-shrink: 0;
  width: 100%;
  text-align: left;
}

.sidebar-logo:hover {
  background: var(--bg-hover);
}

.sidebar-logo-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent-blue);
}

.sidebar.is-collapsed .sidebar-logo {
  justify-content: center;
  padding: 0;
}

.sidebar-logo-text {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.sidebar-group {
  display: flex;
  flex-direction: column;
}

.sidebar-group-title {
  padding: 12px 20px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  /* 原用 --text-tertiary，在侧栏底上仅 3.02:1（AA 需 4.5）→ 次文字色，实测 5.36:1 */
  color: var(--text-secondary);
  white-space: nowrap;
}

.sidebar-group-divider {
  margin: 8px 16px;
  height: 1px;
  background: var(--border-subtle);
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 40px;
  padding: 0 20px;
  color: var(--text-regular);
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.sidebar.is-collapsed .sidebar-item {
  justify-content: center;
  padding: 0;
}

.sidebar-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.sidebar-item.is-active {
  // active = color-mix(accent-primary 15%, transparent) 底 + accent-blue 文字/图标（UF-2）
  background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
  color: var(--accent-blue);
}

.sidebar-item.is-active .sidebar-item-icon {
  color: var(--accent-blue);
}

.sidebar-item-icon {
  flex-shrink: 0;
}

.sidebar-item-label {
  font-size: 14px;
  line-height: 1;
}
</style>
