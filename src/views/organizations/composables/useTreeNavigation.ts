/**
 * useTreeNavigation —— 组织树展开态 + 键盘导航（自 OrgList.vue 拆出，逻辑逐字搬迁）
 *
 * 抽出理由：树所需的「展开态 / 可见行 / 键盘焦点」是一组内聚的 UI 状态，与页面其余逻辑
 * （对话框、成员分页）无耦合。抽出后 OrgTree.vue 自持该状态，页面无需为其做无谓的
 * prop 透传；同时保留「页面挂载后默认展开并选中首个根节点」的能力（expandAndSelectFirst，
 * 由页面 onMounted 在 store.fetch() 之后经模板 ref 调用）。
 *
 * 关键语义（搬迁时保持不变）：
 * - visibleRows = 展开节点的子孙按深度优先顺序的扁平行，depth 驱动缩进与 aria-level；
 * - 键盘 ↑↓ 移动焦点行、←→ 折叠/展开、Enter 选中（ui-design Accessibility）；
 * - 焦点滚动入视野依赖模板上的 data-node-id 属性（位于 OrgTree.vue）。
 */
import { computed, nextTick, ref, type ComputedRef, type Ref } from "vue";
import type { OrganizationNode } from "@/api/types";
import type { useOrgListStore } from "@/stores/orgList";

/** 可见行 = 展开节点的子孙按深度优先顺序；{node, depth} 驱动缩进与键盘遍历 */
export interface VisibleRow {
  node: OrganizationNode;
  depth: number;
}

/** useTreeNavigation 对外 API */
export interface TreeNavigationApi {
  /** 展开态（id → expanded） */
  expanded: Ref<Set<number>>;
  /** 可见行（扁平，深度优先） */
  visibleRows: ComputedRef<VisibleRow[]>;
  /** 当前键盘焦点行索引 */
  focusIndex: Ref<number>;
  /** 焦点节点 id（由 focusIndex 经 visibleRows 推导） */
  focusId: ComputedRef<number | null>;
  toggleExpand: (id: number) => void;
  selectNode: (id: number) => void;
  onTreeKeydown: (e: KeyboardEvent) => void;
  /** 默认展开并选中首个根节点（页面 onMounted 调用） */
  expandAndSelectFirst: () => void;
}

export function useTreeNavigation(
  store: ReturnType<typeof useOrgListStore>,
): TreeNavigationApi {
// ---- 树展开态（id → expanded）----
const expanded = ref<Set<number>>(new Set());

const visibleRows = computed<VisibleRow[]>(() => {
  const out: VisibleRow[] = [];
  const walk = (list: OrganizationNode[], depth: number): void => {
    for (const n of list) {
      out.push({ node: n, depth });
      if (expanded.value.has(n.id) && n.children.length > 0) {
        walk(n.children, depth + 1);
      }
    }
  };
  walk(store.items, 1);
  return out;
});

/** 当前键盘焦点行索引（树导航焦点环） */
const focusIndex = ref<number>(0);

function toggleExpand(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function selectNode(id: number): void {
  void store.loadDetail(id);
}

/** 焦点节点 id（由 focusIndex 经 visibleRows 推导） */
const focusId = computed<number | null>(() => {
  const row = visibleRows.value[focusIndex.value];
  return row ? row.node.id : null;
});

// ---- 键盘树导航（ui-design Accessibility：↑↓ 移动、←→ 折叠/展开、Enter 选中）----
function onTreeKeydown(e: KeyboardEvent): void {
  const rows = visibleRows.value;
  if (rows.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusIndex.value = Math.min(focusIndex.value + 1, rows.length - 1);
    void scrollFocusIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focusIndex.value = Math.max(focusIndex.value - 1, 0);
    void scrollFocusIntoView();
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    const row = rows[focusIndex.value];
    if (
      row &&
      row.node.children.length > 0 &&
      !expanded.value.has(row.node.id)
    ) {
      toggleExpand(row.node.id);
    }
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    const row = rows[focusIndex.value];
    if (row && expanded.value.has(row.node.id)) {
      toggleExpand(row.node.id);
    }
  } else if (e.key === "Enter") {
    e.preventDefault();
    const row = rows[focusIndex.value];
    if (row) selectNode(row.node.id);
  }
}

async function scrollFocusIntoView(): Promise<void> {
  await nextTick();
  const el = document.querySelector(`[data-node-id="${focusId.value}"]`);
  el?.scrollIntoView({ block: "nearest" });
}

  /** 默认展开首个根节点并选中（自 OrgList.vue onMounted 拆出，执行顺序不变） */
  function expandAndSelectFirst(): void {
    const first = store.items[0];
    if (!first) return;
    expanded.value = new Set([first.id]);
    selectNode(first.id);
    focusIndex.value = 0;
  }

  return {
    expanded,
    visibleRows,
    focusIndex,
    focusId,
    toggleExpand,
    selectNode,
    onTreeKeydown,
    expandAndSelectFirst,
  };
}
