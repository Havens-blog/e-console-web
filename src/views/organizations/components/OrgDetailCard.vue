<script setup lang="ts">
/**
 * OrgDetailCard —— 组织详情卡片（右侧上）
 *
 * 拆分来源：OrgList.vue 原模板 520-575 行 + 样式 .detail-* 段 + 脚本 nodeDepth/detailName。
 * 边界理由：纯展示卡片，数据全部来自 orgList store，唯一出口是三个动作 emit。
 *
 * 数据流：store.selectedNode 决定是否有选中；detailName 优先取 detail（detail 端点回读），
 * 降级用 selectedNode.name；nodeDepth 沿 parentId 上溯（根=1，带上限与环保护）。
 * 权限：三个动作按钮分别按 IAM_DEPARTMENT.ADD/EDIT/DELETE 裁剪（P0 词表口径不变）。
 */
import { computed } from "vue";
import { MAX_ORG_DEPTH, useOrgListStore } from "@/stores/orgList";
import type { OrganizationNode } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_DEPARTMENT } from "@/config/permission-codes";

const store = useOrgListStore();
const { can } = useCan();

const emit = defineEmits<{
  /** 详情面板「新增子组织」（参数为当前选中节点） */
  (e: "create-child", node: OrganizationNode): void;
  /** 详情面板「编辑」 */
  (e: "edit", node: OrganizationNode): void;
  /** 详情面板「删除」 */
  (e: "delete", node: OrganizationNode): void;
}>();

/** 节点深度（沿 parentId 上溯；根=1）—— 详情面板深度展示用 */
function nodeDepth(node: OrganizationNode | null): number {
  if (!node) return 0;
  let depth = 1;
  let cur: OrganizationNode | undefined = node;
  const guard = new Set<number>();
  while (cur?.parentId !== undefined) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    const parent = store.nodeIndex.get(cur.parentId);
    if (!parent) break;
    cur = parent;
    depth++;
    if (depth > MAX_ORG_DEPTH + 2) break;
  }
  return depth;
}

// ---- 详情面板派生 ----
const detailName = computed(() => {
  if (store.detail) return store.detail.name;
  return store.selectedNode?.name ?? "—";
});
</script>

<template>
  <div class="card">
    <div class="card__head">
      <span class="card__title">组织详情</span>
      <span v-if="store.selectedNode" class="muted"
        >深度 {{ nodeDepth(store.selectedNode) }} /
        {{ MAX_ORG_DEPTH }}</span
      >
    </div>
    <div v-if="store.selectedNode" class="card__body">
      <dl class="detail-grid">
        <div class="detail-item">
          <dt>组织名称</dt>
          <dd>{{ detailName }}</dd>
        </div>
        <div class="detail-item">
          <dt>下属组织数</dt>
          <dd>{{ store.selectedChildCount }}</dd>
        </div>
        <div class="detail-item">
          <dt>关联用户数</dt>
          <dd>{{ store.membersTotal }}</dd>
        </div>
      </dl>
      <div class="detail-actions">
        <button
          v-if="can(IAM_DEPARTMENT.ADD)"
          type="button"
          class="btn btn--text"
          :disabled="!store.canAddChild(store.selectedId).allowed"
          :title="store.canAddChild(store.selectedId).reason"
          @click="emit('create-child', store.selectedNode)"
        >
          新增子组织
        </button>
        <button
          v-if="can(IAM_DEPARTMENT.EDIT)"
          type="button"
          class="btn btn--text"
          @click="emit('edit', store.selectedNode)"
        >
          编辑
        </button>
        <button
          v-if="can(IAM_DEPARTMENT.DELETE)"
          type="button"
          class="btn btn--text btn--danger"
          @click="emit('delete', store.selectedNode)"
        >
          删除
        </button>
      </div>
    </div>
    <div v-else class="card__body">
      <p class="muted">请在左侧选择一个组织节点。</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "../styles/shared";

.detail-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin: 0 0 12px;
}

// 窄屏：三列统计收成两列，避免「关联用户数」等标签被挤成竖排
@media (max-width: 560px) {
  .detail-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.detail-item {
  dt {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }
  dd {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--text-primary);
  }
}

.detail-actions {
  display: flex;
  gap: 8px;
}
</style>
