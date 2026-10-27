<script setup lang="ts">
/**
 * 角色管理列表页（UF-8，task 5.1）。
 *
 * 参照：ui-design UF-8（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces
 * + parity-checklist §2.8/D-3（role/list A 档、policy/list/attached/role 与 user/list/attached/role
 * C 档路径改判、G-6 语义映射）。
 *
 * 布局：页面头（标题 + 新增）→ 搜索栏（关键词）→ 表格 → 分页。
 * - 列：角色名 / 所属租户 / 绑定策略数 / 绑定用户数 / 操作
 * - 绑定策略数/用户数由 roleList store enrichCounts 回填（role/list 不直出计数）
 * - 分页边界 E7 由 roleList store 统一承载
 *
 * 新增 Dialog（AC-2）：
 * - 角色 code（稳定标识，创建后不可改；格式 ^[a-z][a-z0-9_-]{2,31}$，3–32）
 * - 角色名（1–64 字符，租户内唯一，eiam 校验——冲突提示契约 validation.name_exists）
 * - 描述（可选）
 * - 所属租户（只读，当前上下文）
 *
 * 删除被拒（AC-4，E11）：校验无用户绑定，被拒提示绑定用户数（文案契约 delete.blocked_role）。
 *
 * Hard Rules：租户管理员策略绑定下拉仅列 eiam 可绑定策略、无策略定义入口——本列表页无策略入口；
 * 策略绑定在详情子页（/roles/:id）。角色名租户内唯一由 eiam 校验。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useRoleListStore } from "@/stores/roleList";
import { useUserStore } from "@/stores/user";
import { ApiError } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_ROLE } from "@/config/permission-codes";

const router = useRouter();
const store = useRoleListStore();
const userStore = useUserStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）
const { can } = useCan();

// ---- 搜索（切过滤重置 page=1，E7）----
const keywordInput = ref("");

function applySearch(): void {
  store.setKeyword(keywordInput.value.trim());
  void store.fetch();
}

function resetFilters(): void {
  keywordInput.value = "";
  store.setKeyword("");
  void store.fetch();
}

// ---- 分页 ----
const totalPages = computed(() =>
  store.total <= 0 ? 1 : Math.ceil(store.total / store.pageSize),
);

function changePage(p: number): void {
  store.setPage(p);
  void store.fetch();
}

// ---- 列表加载 ----
async function reload(): Promise<void> {
  await store.fetch();
}

onMounted(async () => {
  await store.fetch();
});

// ---- 所属租户展示（当前租户上下文，user store 只读委托）----
const currentTenantName = computed(() => {
  const tid = userStore.currentTenantId;
  const t = userStore.tenants.find((x) => x.id === tid);
  return t?.name ?? (tid ? `租户 ${tid}` : "—");
});

// ---- 新增 Dialog（AC-2）----
const showCreate = ref(false);
const createLoading = ref(false);
const createError = ref<string>("");
const createFieldErrors = ref<Record<string, string>>({});
const createCode = ref("");
const createName = ref("");
const createDesc = ref("");

const CODE_RE = /^[a-z][a-z0-9_-]{2,31}$/;

function validateCode(value: string): string | null {
  if (!value) return "请输入角色 code";
  if (value.length < 3 || value.length > 32) return "code 长度 3–32 字符";
  if (!CODE_RE.test(value))
    return "code 须以小写字母开头，仅含 a-z 0-9 _ -";
  return null;
}

function validateName(value: string): string | null {
  if (!value) return "请输入角色名";
  if (value.length < 1 || value.length > 64) return "角色名长度 1–64 字符";
  return null;
}

function openCreate(): void {
  createCode.value = "";
  createName.value = "";
  createDesc.value = "";
  createError.value = "";
  createFieldErrors.value = {};
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  createError.value = "";
  createFieldErrors.value = {};
  // 格式即时拦截
  const codeErr = validateCode(createCode.value);
  if (codeErr) {
    createFieldErrors.value = { code: codeErr };
    return;
  }
  const nameErr = validateName(createName.value);
  if (nameErr) {
    createFieldErrors.value = { name: nameErr };
    return;
  }
  createLoading.value = true;
  try {
    const id = await store.create({
      name: createName.value,
      code: createCode.value,
      desc: createDesc.value || undefined,
    });
    if (id === null) {
      // store 已归位 error（含写前守卫阻断 / eiam 唯一性反馈）
      createError.value = store.error ?? "新增角色失败";
      return;
    }
    showCreate.value = false;
  } catch (err) {
    // 唯一性冲突（validation.name_exists）：eiam 反馈经 contractText 降级
    createError.value = errorMessage(err);
  } finally {
    createLoading.value = false;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code !== null) {
      const text = contractText(String(err.code));
      if (text) return text;
    }
    return err.message;
  }
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

function closeCreate(): void {
  showCreate.value = false;
}

// ---- 删除确认（AC-4，E11 依赖删除被拒：校验无用户绑定）----
const deleteTarget = ref<{ id: number; name: string; code: string } | null>(null);
const deleteLoading = ref(false);
const deleteBlocked = ref<string>("");

function openDelete(role: { id: number; name: string; code: string }): void {
  deleteTarget.value = role;
  deleteBlocked.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  // 阻断态下确认按钮置灰（deleteBlocked 非空即阻断）
  if (deleteBlocked.value) return;
  deleteLoading.value = true;
  try {
    const ok = await store.remove(deleteTarget.value.id);
    if (ok) {
      deleteTarget.value = null;
    }
  } catch (err) {
    // E11 依赖删除被拒（conflict kind）：弹窗列阻断计数、确认置灰
    if (err instanceof ApiError && err.kind === "conflict") {
      // delete.blocked_role 契约复用（阻断用户数由 eiam 拒绝消息携带）
      deleteBlocked.value = errorMessage(err);
    } else {
      deleteBlocked.value = errorMessage(err);
    }
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteBlocked.value = "";
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const createDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(createDialogRef, { open: showCreate, onClose: closeCreate });
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误删
  initialFocus: "[data-dialog-cancel]",
});

// ---- 编辑跳转（AC-3：跳 /roles/:id 详情/绑定页；:id 实为 role code，eiam detail 按 code）----
function gotoDetail(role: { code: string }): void {
  void router.push(`/roles/${encodeURIComponent(role.code)}`);
}

// ---- 状态迁移渲染辅助 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);

/** 绑定策略数展示（enrichCounts 回填；cap 100 超限显示 100+） */
function policyCount(code: string): string {
  const n = store.policyCounts[code] ?? 0;
  return n >= 100 ? "100+" : String(n);
}

/** 绑定用户数展示（enrichCounts 回填 total） */
function userCount(code: string): string {
  const n = store.userCounts[code] ?? 0;
  return String(n);
}
</script>

<template>
  <section class="page-role-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">角色管理</h2>
      <button
        v-if="can(IAM_ROLE.ADD)"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增角色
      </button>
    </header>

    <!-- 搜索栏 -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="搜索角色名"
        data-testid="role-search"
        @keyup.enter="applySearch"
      />
      <button type="button" class="btn btn--ghost" @click="applySearch">
        搜索
      </button>
      <button type="button" class="btn btn--text" @click="resetFilters">
        重置
      </button>
    </div>

    <!-- 表格容器：错误 / 空 / 加载 三态都在容器内替换内容，避免错误时残留空表格框 -->
    <div class="table-wrap">
      <!-- 错误态（重试） -->
      <div v-if="isError" class="state-error" role="alert">
        <CopyContractText code="eiam.unavailable" tag="span" />
        <button type="button" class="btn btn--text" @click="reload">重试</button>
      </div>

      <table v-else-if="store.items.length > 0" class="data-table">
        <thead>
          <tr>
            <th>角色名</th>
            <th>所属租户</th>
            <th>绑定策略数</th>
            <th>绑定用户数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in store.items" :key="r.id">
            <td>{{ r.name }}</td>
            <td>{{ currentTenantName }}</td>
            <td data-testid="role-policy-count">{{ policyCount(r.code) }}</td>
            <td data-testid="role-user-count">{{ userCount(r.code) }}</td>
            <td>
              <button
                v-if="can(IAM_ROLE.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="edit-role"
                @click="gotoDetail(r)"
              >
                编辑
              </button>
              <button
                v-if="can(IAM_ROLE.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="delete-role"
                @click="openDelete(r)"
              >
                删除
              </button>
              <button
                v-if="!can(IAM_ROLE.EDIT) && !can(IAM_ROLE.DELETE)"
                type="button"
                class="btn btn--text"
                data-testid="view-role"
                @click="gotoDetail(r)"
              >
                查看
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态 -->
      <p v-else-if="isEmpty" class="state-empty">暂无角色数据</p>

      <!-- 加载骨架 -->
      <div v-else-if="store.loading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>
    </div>

    <!-- 窄屏横向滚动提示：表格保留可读列宽后不再挤成竖排，需提示可左右滑动 -->
    <p class="table-hint" aria-hidden="true">← 左右滑动查看全部列 →</p>

    <!-- 分页 -->
    <nav v-if="store.total > 0" class="pagination" aria-label="分页">
      <button
        type="button"
        class="btn btn--text"
        :disabled="store.page <= 1"
        @click="changePage(store.page - 1)"
      >
        上一页
      </button>
      <span class="pagination__info"
        >第 {{ store.page }} / {{ totalPages }} 页（共
        {{ store.total }} 条）</span
      >
      <button
        type="button"
        class="btn btn--text"
        :disabled="store.page >= totalPages"
        @click="changePage(store.page + 1)"
      >
        下一页
      </button>
      <select
        :value="store.pageSize"
        class="input pagination__size"
        @change="
          store.setPageSize(Number(($event.target as HTMLSelectElement).value))
        "
      >
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
    </nav>

    <!-- 新增 Dialog（AC-2）-->
    <div v-if="showCreate" class="dialog-overlay" @click.self="closeCreate">
      <div
        ref="createDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新增角色"
      >
        <header class="dialog__head">
          <h3>新增角色</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeCreate"
          >
            ✕
          </button>
        </header>
        <form class="dialog__body" @submit.prevent="submitCreate">
          <p v-if="createError" class="form-error" role="alert">
            <CopyContractText :code="createError" tag="span" />
          </p>
          <label class="field">
            <span class="field__label"
              >角色 code<span class="required">*</span></span
            >
            <input
              v-model="createCode"
              type="text"
              class="input"
              data-testid="create-role-code"
              :aria-describedby="
                createFieldErrors.code ? 'create-code-error' : undefined
              "
              :aria-invalid="!!createFieldErrors.code"
            />
            <span class="muted">稳定标识，创建后不可改；用于绑定与分配</span>
            <span
              v-if="createFieldErrors.code"
              id="create-code-error"
              class="field__error"
              role="alert"
              >{{ createFieldErrors.code }}</span
            >
          </label>
          <label class="field">
            <span class="field__label"
              >角色名<span class="required">*</span></span
            >
            <input
              v-model="createName"
              type="text"
              class="input"
              data-testid="create-role-name"
              :aria-describedby="
                createFieldErrors.name ? 'create-name-error' : undefined
              "
              :aria-invalid="!!createFieldErrors.name"
            />
            <span class="muted">1–64 字符，租户内唯一（eiam 校验）</span>
            <span
              v-if="createFieldErrors.name"
              id="create-name-error"
              class="field__error"
              role="alert"
              >{{ createFieldErrors.name }}</span
            >
          </label>
          <label class="field">
            <span class="field__label">描述</span>
            <textarea
              v-model="createDesc"
              class="input input--textarea"
              rows="2"
            />
          </label>
          <div class="field">
            <span class="field__label">所属租户</span>
            <span class="muted">{{ currentTenantName }}（当前租户上下文）</span>
          </div>
          <div class="dialog__actions">
            <button type="button" class="btn btn--ghost" @click="closeCreate">
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="createLoading"
              data-testid="create-role-submit"
            >
              {{ createLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 删除确认 Dialog（E11 依赖删除被拒 → 阻断计数、确认置灰） -->
    <div v-if="deleteTarget" class="dialog-overlay" @click.self="closeDelete">
      <div
        ref="deleteDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="`删除角色 ${deleteTarget.name}`"
      >
        <header class="dialog__head">
          <h3>删除角色</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeDelete"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p>
            确认删除角色 <strong>{{ deleteTarget.name }}</strong
            >？此操作不可撤销。
          </p>
          <!-- E11 依赖删除被拒：绑定用户数由 eiam 拒绝消息携带 -->
          <p v-if="deleteBlocked" class="delete-blocked" role="alert">
            <CopyContractText :code="deleteBlocked" tag="span" />
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            @click="closeDelete"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="deleteLoading || !!deleteBlocked"
            data-testid="delete-confirm"
            @click="confirmDelete"
          >
            {{ deleteLoading ? "删除中…" : "确认删除" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-role-list {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;

  &__search {
    min-width: 220px;
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
}

.input--textarea {
  height: auto;
  min-height: 60px;
  padding: 8px 10px;
  font-family: inherit;
  resize: vertical;
}

.input:focus {
  outline: none;
  border-color: var(--input-border-focus);
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
  -webkit-overflow-scrolling: touch;
  background: var(--bg-elevated);
  border-radius: 8px;
  min-height: 120px;
}

.data-table {
  width: 100%;
  // 窄屏保留可读最小列宽，超出容器由 .table-wrap 横向滚动；
  // 缺这条时「角色名」「绑定策略数」表头会被压成 4~5 行竖排。
  min-width: 680px;
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

.table-hint {
  display: none;
  margin: 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

@media (max-width: 768px) {
  .table-hint {
    display: block;
  }
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.state-empty,
.state-error {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

// 错误态：文案在上、重试动作在下一行（同行时「…请稍后重试」+「重试」会读成重复）
.state-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.skeleton__row {
  height: 40px;
  margin: 8px 12px;
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

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
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
    margin-top: 8px;
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  &__label {
    font-size: 13px;
    color: var(--text-regular);
  }
  &__error {
    font-size: 12px;
    color: var(--color-danger);
  }
}

.required {
  color: var(--color-danger);
  margin-left: 2px;
}

.form-error,
.delete-blocked {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}
</style>
