<script setup lang="ts">
/**
 * 租户成员管理抽屉（feat-tenant-members-ui 契约 §2.2）。
 *
 * 入口：TenantList 行内「成员」按钮（权限 iam:tenant:view_members）。
 * 结构：遮罩 + 右侧抽屉；沿用 tenants 目录既有 dialog-overlay / btn / input / field
 * 原生元素样式语言（不引入 Element Plus 组件）。
 *
 * 数据流（契约 §1.1/§1.2/§1.3）：
 * - tenant 非 null（打开）→ listTenantMembers(tenant.id, {offset, limit, keyword})，
 *   api 层固定注入 `X-Active-Tenant-ID`；
 * - 移除 → 二次确认 → removeTenantMember(tenant.id, member.id)：
 *   成功 emit('removed')（父级刷新租户列表用量）并重拉当前页；
 *   被拒 → 展示 ApiError.message（eiam msg 原文，不得改写）。
 *
 * 分页口径与租户列表一致（20/50/100）；搜索 / 重置 / 切页大小均重置到第 1 页。
 * 关闭（tenant 变 null）只丢弃在途响应，不再发起新请求（M9 不产生残留请求）。
 */
import { computed, ref, watch } from "vue";
import {
  listTenantMembers,
  removeTenantMember,
  type ListTenantMembersQuery,
} from "@/api/tenantMembers";
import { ApiError, type TenantMember } from "@/api/types";
import StatusBadge from "@/components/StatusBadge.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_TENANT } from "@/config/permission-codes";
import { formatEpochMs } from "./timestamp";

const props = defineProps<{
  /** 目标租户；null = 抽屉关闭 */
  tenant: { id: number; name: string } | null;
}>();

const emit = defineEmits<{
  /** 关闭抽屉（父级把 tenant 置 null） */
  close: [];
  /** 成员移除成功（父级刷新租户列表，刷新用量列） */
  removed: [];
}>();

// 移除按钮权限（契约 §2.4：无 iam:tenant:unassign 不渲染）
const { can } = useCan();

const isOpen = computed(() => props.tenant !== null);

// ---- 抽屉焦点 / Escape（关闭路径统一走 requestClose）----
const drawerRef = ref<HTMLElement | null>(null);
useDialogA11y(drawerRef, { open: isOpen, onClose: () => requestClose() });

// ---- 列表 state（与租户列表同口径：默认 20，20/50/100）----
const PAGE_SIZES = [20, 50, 100] as const;

const items = ref<TenantMember[]>([]);
const total = ref<number>(0);
const page = ref<number>(1);
const pageSize = ref<number>(20);
/** 已生效的搜索关键词（空串 = 不过滤） */
const keyword = ref<string>("");
/** 输入框草稿（点搜索/回车才生效） */
const keywordInput = ref<string>("");
const loading = ref<boolean>(false);
const error = ref<string>("");

const totalPages = computed(() =>
  total.value <= 0 ? 1 : Math.ceil(total.value / pageSize.value),
);

/**
 * 请求序号：关闭抽屉 / 新请求发起后，旧响应一律丢弃 ——
 * 避免「关闭后迟到响应把已清空的列表写回来」（M9 焦点与列表状态正常）。
 */
let requestSeq = 0;

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

/** 拉取成员列表（当前 page / pageSize / keyword）。 */
async function load(): Promise<void> {
  const tenant = props.tenant;
  if (!tenant) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const query: ListTenantMembersQuery = {
      offset: (page.value - 1) * pageSize.value,
      limit: pageSize.value,
      keyword: keyword.value,
    };
    const result = await listTenantMembers(tenant.id, query);
    // 迟到的旧响应 / 抽屉已关闭 → 丢弃，不写 state
    if (seq !== requestSeq || !props.tenant) return;
    items.value = result.items;
    total.value = result.total;
    // 末页因移除变空 → 回退最后一页重查（与租户列表 E7 同口径）
    if (items.value.length === 0 && total.value > 0 && page.value > 1) {
      page.value = totalPages.value;
      await load();
    }
  } catch (err) {
    if (seq !== requestSeq || !props.tenant) return;
    items.value = [];
    total.value = 0;
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

/** 搜索：关键词生效并重置到第 1 页 */
function applySearch(): void {
  keyword.value = keywordInput.value.trim();
  page.value = 1;
  void load();
}

/** 重置：清空关键词并重置到第 1 页 */
function resetSearch(): void {
  keywordInput.value = "";
  keyword.value = "";
  page.value = 1;
  void load();
}

function changePage(next: number): void {
  if (next < 1 || next > totalPages.value) return;
  page.value = next;
  void load();
}

function changePageSize(event: Event): void {
  const raw = Number((event.target as HTMLSelectElement).value);
  pageSize.value = Number.isFinite(raw) && raw > 0 ? raw : 20;
  page.value = 1;
  void load();
}

// ---- 移除（二次确认，契约 §2.2）----
const removeTarget = ref<TenantMember | null>(null);
const removeError = ref<string>("");
const removing = ref<boolean>(false);

function openRemove(member: TenantMember): void {
  removeTarget.value = member;
  removeError.value = "";
  removing.value = false;
}

function cancelRemove(): void {
  if (removing.value) return;
  removeTarget.value = null;
  removeError.value = "";
}

async function confirmRemove(): Promise<void> {
  const tenant = props.tenant;
  const target = removeTarget.value;
  if (!tenant || !target || removing.value) return;
  removing.value = true;
  removeError.value = "";
  try {
    await removeTenantMember(tenant.id, target.id);
    removeTarget.value = null;
    // 通知父级刷新租户列表（用量列随之更新）
    emit("removed");
    await load();
  } catch (err) {
    // 被拒（禁止移除自己 / admin / 其他）→ 原样展示服务端 msg，弹窗保持打开
    removeError.value = errorMessage(err);
  } finally {
    removing.value = false;
  }
}

// ---- 打开即拉取 / 关闭清理（tenant 是唯一开关）----
// 放在移除 state 声明之后：immediate 回调会在 setup 期间同步执行，先声明再引用避免 TDZ。
watch(
  () => props.tenant,
  (tenant) => {
    if (tenant) {
      items.value = [];
      total.value = 0;
      page.value = 1;
      keyword.value = "";
      keywordInput.value = "";
      error.value = "";
      void load();
    } else {
      // 关闭：作废在途请求、清空列表；不发起任何新请求
      requestSeq++;
      loading.value = false;
      items.value = [];
      total.value = 0;
      error.value = "";
      removeTarget.value = null;
      removeError.value = "";
    }
  },
  { immediate: true },
);

// ---- 交互关闭（确认弹窗打开时 Escape / 点遮罩只取消确认，不连带关抽屉）----
function requestClose(): void {
  if (removeTarget.value) {
    cancelRemove();
    return;
  }
  emit("close");
}

function close(): void {
  emit("close");
}

// ---- 展示辅助 ----
/** 最近登录：eiam last_login_at 为 Unix 毫秒（见 ./timestamp.ts 说明）；缺失/异常 → '—' */
const formatTimestamp = (ms: number | undefined): string => formatEpochMs(ms, false);
</script>

<template>
  <div
    v-if="tenant"
    class="dialog-overlay dialog-overlay--drawer"
    data-testid="tenant-members-drawer"
    @click.self="requestClose"
  >
    <aside
      ref="drawerRef"
      class="drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="`${tenant.name} · 成员`"
    >
      <header class="drawer__head">
        <h3 class="drawer__title">{{ tenant.name }} · 成员</h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭成员抽屉"
          data-testid="member-close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <!-- 工具条：关键词 + 搜索/重置 -->
      <div class="drawer__toolbar">
        <input
          v-model="keywordInput"
          type="text"
          class="input drawer__search"
          placeholder="搜索用户名 / 昵称"
          data-testid="member-search"
          @keyup.enter="applySearch"
        />
        <button type="button" class="btn btn--ghost" @click="applySearch">
          搜索
        </button>
        <button type="button" class="btn btn--text" @click="resetSearch">
          重置
        </button>
      </div>

      <p class="drawer__hint muted">
        创建者与 admin 账号无法被移除（由服务端校验；被拒时展示原因）。
      </p>

      <!-- 错误态：服务端 msg 原文 + 重试 -->
      <p
        v-if="error"
        class="state-error"
        role="alert"
        data-testid="member-error"
      >
        {{ error }}
        <button type="button" class="btn btn--text" @click="load">重试</button>
      </p>

      <div class="drawer__body">
        <!-- 加载态 -->
        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="i in 4" :key="i" class="skeleton__row" />
        </div>

        <!-- 成员表 -->
        <div v-else-if="items.length > 0" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>昵称</th>
                <th>邮箱</th>
                <th>状态</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in items"
                :key="m.id"
                data-testid="member-row"
              >
                <td>{{ m.username }}</td>
                <td>{{ m.nickname || "—" }}</td>
                <td>{{ m.email || "—" }}</td>
                <td>
                  <StatusBadge :status="m.status ?? 'unknown'" size="sm" />
                </td>
                <td class="muted">{{ formatTimestamp(m.lastLoginAt) }}</td>
                <td>
                  <button
                    v-if="can(IAM_TENANT.UNASSIGN)"
                    type="button"
                    class="btn btn--text btn--danger"
                    data-testid="member-remove"
                    @click="openRemove(m)"
                  >
                    移除
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 空态 -->
        <div
          v-else-if="!error"
          class="state-empty"
          data-testid="member-empty"
        >
          <p>该租户暂无成员</p>
          <p class="muted">可直接删除该租户。</p>
        </div>
      </div>

      <!-- 分页（与租户列表同口径） -->
      <footer v-if="total > 0" class="drawer__foot">
        <nav
          class="pagination"
          data-testid="member-pagination"
          aria-label="成员分页"
        >
          <button
            type="button"
            class="btn btn--text"
            data-testid="member-prev"
            :disabled="page <= 1"
            @click="changePage(page - 1)"
          >
            上一页
          </button>
          <span class="pagination__info"
            >第 {{ page }} / {{ totalPages }} 页（共 {{ total }} 条）</span
          >
          <button
            type="button"
            class="btn btn--text"
            data-testid="member-next"
            :disabled="page >= totalPages"
            @click="changePage(page + 1)"
          >
            下一页
          </button>
          <select
            class="input pagination__size"
            aria-label="每页条数"
            :value="pageSize"
            @change="changePageSize"
          >
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">
              {{ size }} 条/页
            </option>
          </select>
        </nav>
      </footer>
    </aside>

    <!-- 移除二次确认 -->
    <div
      v-if="removeTarget"
      class="dialog-overlay"
      @click.self="cancelRemove"
    >
      <div
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="移除成员"
      >
        <header class="dialog__head">
          <h3>移除成员</h3>
          <button type="button" class="btn btn--text" @click="cancelRemove">
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p>
            确认将 <strong>{{ removeTarget.username }}</strong> 从租户
            <strong>{{ tenant.name }}</strong> 中移除？
          </p>
          <!-- 被拒原因：eiam msg 原文 -->
          <p
            v-if="removeError"
            class="form-error"
            role="alert"
            data-testid="member-remove-error"
          >
            {{ removeError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="removing"
            @click="cancelRemove"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="removing"
            data-testid="member-remove-confirm"
            @click="confirmRemove"
          >
            {{ removing ? "移除中…" : "确认移除" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 遮罩：沿用租户列表 .dialog-overlay 语言，抽屉贴右 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;

  &--drawer {
    justify-content: flex-end;
  }
}

.drawer {
  width: min(760px, 100%);
  height: 100%;
  max-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-base);
  min-width: 0;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  &__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 20px 0;
  }

  &__search {
    flex: 1 1 200px;
    min-width: 0;
  }

  &__hint {
    margin: 8px 20px 0;
    line-height: 1.6;
  }

  &__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 20px;
  }

  &__foot {
    padding: 10px 20px 16px;
    border-top: 1px solid var(--border-subtle);
  }
}

.input {
  height: 36px;
  padding: 0 10px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;

  &:focus {
    outline: none;
    border-color: var(--input-border-focus);
  }
}

.btn {
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &--primary {
    background: var(--accent-primary);
    color: #fff;
  }
  &--ghost {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-regular);
  }
  &--text {
    background: transparent;
    color: var(--accent-blue);
    height: auto;
    padding: 4px 8px;
  }
  &--danger {
    background: var(--color-danger);
    color: #fff;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.btn--text.btn--danger {
  color: var(--color-danger);
  background: transparent;
}

.table-wrap {
  overflow-x: auto;
  background: var(--bg-elevated);
  border-radius: 8px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 10px 12px;
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

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.state-empty,
.state-error {
  padding: 28px 8px;
  text-align: center;
  color: var(--text-secondary);

  p {
    margin: 4px 0;
  }
}

.skeleton__row {
  height: 40px;
  margin: 8px 0;
  background: var(--tag-bg);
  border-radius: 6px;
}

.pagination {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;

  &__info {
    color: var(--text-regular);
    font-size: 13px;
  }
  &__size {
    width: auto;
    height: 32px;
  }
}

.dialog {
  width: 100%;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  background: var(--bg-elevated);
  border-radius: 8px;
  box-shadow: var(--shadow-base);

  &--sm {
    max-width: 400px;
  }
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
    h3 {
      margin: 0;
      font-size: 16px;
    }
  }
  &__body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 20px 20px;
  }
}

.form-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

/* 窄屏 375px：抽屉占满视口，工具条与分页换行，表格在容器内横向滚动（M8 不破版） */
@media (max-width: 480px) {
  .drawer {
    width: 100%;

    &__head,
    &__toolbar,
    &__hint,
    &__body,
    &__foot {
      padding-left: 12px;
      padding-right: 12px;
    }

    &__hint {
      margin-left: 12px;
      margin-right: 12px;
    }
  }
}
</style>
