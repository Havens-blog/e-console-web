<script setup lang="ts">
/**
 * OrgTree —— 组织树（左侧 2/5 栏）
 *
 * 拆分来源：src/views/organizations/OrgList.vue（原模板 400-515 行 + 样式 .org-tree/.tree-* 段）。
 * 边界理由：树是页面内唯一「自持交互状态（展开态 / 键盘焦点）」的区块，与右侧详情、成员
 * 列表及三个对话框之间没有数据往来；独立后页面也不必再为树的内部状态做 prop 透传。
 *
 * 数据流：
 * - 直接读 orgList store（items/loading/total/selectedId/canAddChild/loadDetail）——store 是
 *   全局单例，子组件直读可免去纯透传的 props；
 * - 展开态 / 焦点 / 键盘导航由 useTreeNavigation 自持；
 * - 行内「＋ / 编辑 / 删除」三个动作 emit 给页面，由页面转交 OrgDialogs（对话框归属页面）。
 *
 * 对外暴露 expandAndSelectFirst：页面 onMounted 在 store.fetch() 之后调用，复现拆分前
 * 「默认展开并选中首个根节点」的行为。
 */
import { computed } from "vue";
import { MAX_ORG_NODES, useOrgListStore } from "@/stores/orgList";
import type { OrganizationNode } from "@/api/types";
import { useTreeNavigation } from "../composables/useTreeNavigation";

const store = useOrgListStore();

const {
  expanded,
  visibleRows,
  focusIndex,
  toggleExpand,
  selectNode,
  onTreeKeydown,
  expandAndSelectFirst,
} = useTreeNavigation(store);

const emit = defineEmits<{
  /** 行内「＋」：新增子组织（参数为父节点） */
  (e: "create-child", node: OrganizationNode): void;
  /** 行内「编辑」 */
  (e: "edit", node: OrganizationNode): void;
  /** 行内「删除」 */
  (e: "delete", node: OrganizationNode): void;
}>();

/** 空态：非加载中、无节点、且无错误（错误态由页面整页接管，见 OrgList.vue 的 isError） */
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);

// 供页面在数据加载完成后调用（替代拆分前页面直接改写 expanded/focusIndex）
defineExpose({ expandAndSelectFirst });
</script>

<template>
  <aside class="org-tree" aria-label="组织树">
    <div class="card">
      <div class="card__head">
        <span class="card__title">组织树</span>
        <span class="muted"
          >{{ store.total }} / {{ MAX_ORG_NODES }} 节点</span
        >
      </div>
      <div
        class="tree-body"
        role="tree"
        tabindex="0"
        aria-label="组织树，使用方向键导航"
        @keydown="onTreeKeydown"
      >
        <!-- 加载骨架 -->
        <div
          v-if="store.loading && store.items.length === 0"
          class="skeleton"
          aria-hidden="true"
        >
          <div v-for="i in 4" :key="i" class="skeleton__row" />
        </div>
        <!-- 空态 -->
        <p v-else-if="isEmpty" class="state-empty">暂无组织</p>
        <!-- 树（扁平可见行） -->
        <ul v-else class="tree-root" role="group">
          <li
            v-for="(row, idx) in visibleRows"
            :key="row.node.id"
            class="tree-node"
          >
            <div
              class="tree__row"
              :class="{ 'tree__row--focus': idx === focusIndex }"
              :data-node-id="row.node.id"
              role="treeitem"
              :aria-selected="store.selectedId === row.node.id"
              :aria-expanded="
                row.node.children.length > 0
                  ? expanded.has(row.node.id)
                  : undefined
              "
              :aria-level="row.depth"
              :tabindex="idx === focusIndex ? 0 : -1"
              :style="{ paddingLeft: `${(row.depth - 1) * 16 + 8}px` }"
              @click="selectNode(row.node.id)"
            >
              <button
                type="button"
                class="tree__toggle"
                :class="{
                  'tree__toggle--leaf': row.node.children.length === 0,
                }"
                :aria-label="
                  row.node.children.length === 0
                    ? ''
                    : expanded.has(row.node.id)
                      ? '折叠'
                      : '展开'
                "
                tabindex="-1"
                @click.stop="toggleExpand(row.node.id)"
              >
                {{
                  row.node.children.length === 0
                    ? ""
                    : expanded.has(row.node.id)
                      ? "▾"
                      : "▸"
                }}
              </button>
              <span
                class="tree__label"
                :class="{
                  'tree__label--selected': store.selectedId === row.node.id,
                }"
                :title="row.node.name"
                >{{ row.node.name }}</span
              >
              <span class="tree__actions">
                <button
                  type="button"
                  class="btn btn--text btn--sm"
                  :disabled="!store.canAddChild(row.node.id).allowed"
                  :title="
                    store.canAddChild(row.node.id).reason || '新增子组织'
                  "
                  aria-label="新增子组织"
                  @click.stop="emit('create-child', row.node)"
                >
                  ＋
                </button>
                <button
                  type="button"
                  class="btn btn--text btn--sm"
                  @click.stop="emit('edit', row.node)"
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="btn btn--text btn--sm btn--danger"
                  @click.stop="emit('delete', row.node)"
                >
                  删除
                </button>
              </span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </aside>
</template>

<style scoped lang="scss">
@use "../styles/shared";

.org-tree {
  min-width: 280px;
}

// 窄屏：解除 280px 下限，让组织树与右侧详情单栏堆叠时能随视口收窄
@media (max-width: 900px) {
  .org-tree {
    min-width: 0;
  }
}

.tree-body {
  max-height: 70vh;
  overflow-y: auto;
  padding: 8px;
  outline: none;

  &:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent-blue);
  }
}

.tree-root {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-node {
  list-style: none;
}

.tree__row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-regular);

  &:hover {
    background: var(--bg-hover);
  }
  &--focus {
    box-shadow: inset 0 0 0 2px var(--accent-blue);
  }
}

.tree__toggle {
  width: 16px;
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 10px;
  text-align: center;

  &--leaf {
    cursor: default;
  }
}

.tree__label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &--selected {
    color: var(--accent-blue);
    font-weight: 500;
  }
}

.tree__actions {
  // 常驻占位 + 透明，而非 display:none：
  // display:none 会让按钮脱离 Tab 序，键盘用户无法打开「＋/编辑/删除」，
  // 且弹窗关闭时焦点无法归还（目标不可聚焦 → 落到 body）。
  display: inline-flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
}

// 鼠标悬停或键盘焦点进入该行时显形（聚焦到按钮本身也会触发 :focus-within）
.tree__row:hover .tree__actions,
.tree__row:focus-within .tree__actions {
  opacity: 1;
}
</style>
