<script setup lang="ts">
/**
 * OrgMembersCard —— 成员列表卡片（右侧下）
 *
 * 拆分来源：OrgList.vue 原模板 578-673 行 + 样式 .toolbar/.table-wrap/.data-table/.truncate/
 * .pagination 段 + 脚本成员分页与搜索逻辑。
 * 边界理由：纯展示 + 局部输入态（搜索框），对外无事件，故无 props/emits。
 *
 * 数据流：全部读写 orgList store 的成员二级态；membersKeywordInput 为本组件局部输入缓冲，
 * 回车或点击「搜索」时经 setMembersKeyword 落到 store（并复位到第 1 页）后重新拉取。
 */
import { computed, ref } from "vue";
import { useOrgListStore } from "@/stores/orgList";
import CopyContractText from "@/components/CopyContractText.vue";

const store = useOrgListStore();

// ---- 成员分页 ----
const membersTotalPages = computed(() =>
  store.membersTotal <= 0
    ? 1
    : Math.ceil(store.membersTotal / store.membersPageSize),
);

function changeMembersPage(p: number): void {
  store.setMembersPage(p);
  if (store.selectedId !== null) {
    void store.fetchMembers(store.selectedId);
  }
}

const membersKeywordInput = ref("");

function applyMembersSearch(): void {
  store.setMembersKeyword(membersKeywordInput.value.trim());
  if (store.selectedId !== null) {
    void store.fetchMembers(store.selectedId);
  }
}
</script>

<template>
  <div class="card">
    <div class="card__head">
      <span class="card__title">成员列表</span>
      <span v-if="store.selectedId !== null" class="muted"
        >共 {{ store.membersTotal }} 人</span
      >
    </div>
    <div class="card__body">
      <div v-if="store.selectedId !== null" class="members">
        <div class="toolbar">
          <input
            v-model="membersKeywordInput"
            type="text"
            class="input toolbar__search"
            placeholder="搜索成员"
            data-testid="members-search"
            @keyup.enter="applyMembersSearch"
          />
          <button
            type="button"
            class="btn btn--ghost"
            @click="applyMembersSearch"
          >
            搜索
          </button>
        </div>

        <p v-if="store.membersError" class="state-error" role="alert">
          <CopyContractText code="eiam.unavailable" tag="span" />
          <button
            type="button"
            class="btn btn--text"
            @click="store.fetchMembers(store.selectedId ?? 0)"
          >
            重试
          </button>
        </p>

        <div class="table-wrap">
          <table v-if="store.members.length > 0" class="data-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>昵称</th>
                <th>邮箱</th>
                <th>手机</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in store.members" :key="m.id">
                <td>{{ m.username }}</td>
                <td>{{ m.displayName }}</td>
                <td class="truncate">{{ m.email || "—" }}</td>
                <td class="truncate">{{ m.phone || "—" }}</td>
              </tr>
            </tbody>
          </table>
          <div
            v-else-if="store.membersLoading"
            class="skeleton"
            aria-hidden="true"
          >
            <div v-for="i in 3" :key="i" class="skeleton__row" />
          </div>
          <p v-else class="state-empty">该组织暂无成员</p>
        </div>

        <nav
          v-if="store.membersTotal > store.membersPageSize"
          class="pagination"
          aria-label="成员分页"
        >
          <button
            type="button"
            class="btn btn--text"
            :disabled="store.membersPage <= 1"
            @click="changeMembersPage(store.membersPage - 1)"
          >
            上一页
          </button>
          <span class="pagination__info"
            >第 {{ store.membersPage }} / {{ membersTotalPages }} 页</span
          >
          <button
            type="button"
            class="btn btn--text"
            :disabled="store.membersPage >= membersTotalPages"
            @click="changeMembersPage(store.membersPage + 1)"
          >
            下一页
          </button>
        </nav>
      </div>
      <p v-else class="muted">请在左侧选择一个组织节点。</p>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "../styles/shared";
@use "../styles/form";

.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;

  &__search {
    min-width: 200px;
    // 允许输入框在窄屏收缩，避免「搜索」按钮被挤成竖排两行
    flex: 1 1 200px;
  }
}

@media (max-width: 560px) {
  .toolbar__search {
    min-width: 0;
    flex-basis: 160px;
  }
}

.table-wrap {
  overflow-x: auto;
  min-height: 80px;
}

.data-table {
  width: 100%;
  // 与列表页一致：窄屏保留可读列宽，超出容器横向滚动，避免逐字竖排
  min-width: 480px;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 8px 10px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
    white-space: nowrap;
  }
  th {
    color: var(--text-secondary);
    font-weight: 500;
  }
  td {
    color: var(--text-regular);
  }
}

.truncate {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;

  &__info {
    color: var(--text-regular);
    font-size: 13px;
  }
}
</style>
