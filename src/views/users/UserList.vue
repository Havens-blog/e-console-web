<script setup lang="ts">
/**
 * 用户管理列表页（UF-4，task 4.2）。
 *
 * 参照：ui-design UF-4（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces A 档
 * + parity-checklist Phase 0 实核（G-1/G-2/G-3/G-9 降级）。
 *
 * 布局：页面头（标题 + 新增）→ 搜索栏（关键词 + 角色过滤）→ 表格 → 分页。
 * - 列：用户名 / 所属租户 / 组织 / 登录方式 / 角色 / 状态 / 操作
 * - 状态列用 StatusBadge（4.1）；文案出口用 CopyContractText（2.5）
 * - 分页边界 E7（page 超界回落 / 末页空回退 / 切过滤重置 1）由 userList store 统一承载
 *
 * 降级（Phase 0）：
 * - G-9：状态仅 active/disable/unknown，不展示锁定（StatusBadge 'locked' 占位态不产出）
 * - list 不直出 登录方式/角色/passkeyRegistered：列降级展示 '—'，详情页 enrichment
 * - User.orgRef 无数据源：组织列降级 '—'
 *
 * 新增 Dialog（AC-3）：
 * - 用户名格式即时拦截（^[a-z][a-z0-9_-]{2,31}$，3–32）；唯一性由 eiam 反馈（E10）
 * - 初始密码（设置或生成）展示一次（Hard Rule：不进列表/编辑回显）
 *
 * 删除确认（AC-5）：依赖删除被拒（E11）→ 弹窗列阻断计数、确认置灰（delete.blocked 契约复用）。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useUserListStore } from "@/stores/userList";
import { useUserStore } from "@/stores/user";
import { listRoles } from "@/api/users";
import { ApiError, type RoleRef } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_ROLE, IAM_USER } from "@/config/permission-codes";

const router = useRouter();
const store = useUserListStore();
const userStore = useUserStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）
const { can } = useCan();

// ---- 角色过滤 / 绑定下拉数据源（listRoles A 档）----
const roleOptions = ref<RoleRef[]>([]);
const roleFilterLoading = ref(false);

async function loadRoleOptions(): Promise<void> {
  roleFilterLoading.value = true;
  try {
    const page = await listRoles({ offset: 0, limit: 100, keyword: "" });
    roleOptions.value = page.items;
  } catch {
    roleOptions.value = [];
  } finally {
    roleFilterLoading.value = false;
  }
}

// ---- 搜索 / 过滤（切过滤重置 page=1，E7）----
const keywordInput = ref("");
const roleFilterInput = ref("");

function applySearch(): void {
  store.setKeyword(keywordInput.value.trim());
  void store.fetch();
}

function applyRoleFilter(code: string): void {
  roleFilterInput.value = code;
  store.setRoleFilter(code);
  void store.fetch();
}

function resetFilters(): void {
  keywordInput.value = "";
  roleFilterInput.value = "";
  store.setKeyword("");
  store.setRoleFilter("");
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
  await Promise.all([loadRoleOptions(), store.fetch()]);
});

// ---- 所属租户展示（当前租户上下文，user store 只读委托）----
const currentTenantName = computed(() => {
  const tid = userStore.currentTenantId;
  const t = userStore.tenants.find((x) => x.id === tid);
  return t?.name ?? (tid ? `租户 ${tid}` : "—");
});

// ---- 角色 cell（list 不直出，降级 '—'）----
// list 响应不直出角色；详情页 enrichment 覆盖。降级 '—'。
const rolesCellPlaceholder = "—";

// ---- 新增 Dialog（AC-3）----
const showCreate = ref(false);
const createLoading = ref(false);
const createError = ref<string>("");
const createFieldErrors = ref<Record<string, string>>({});
const createUsername = ref("");
const createPassword = ref("");
const createNickname = ref("");
const createEmail = ref("");
const createPhone = ref("");
const createJobTitle = ref("");
const createStatus = ref<"active" | "disable">("active");
const createRoleCodes = ref<string[]>([]);
/** 创建结果：初始密码一次性展示（Hard Rule：仅展示一次，不进列表/编辑回显） */
const createdInitialPassword = ref<string>("");
const showCreatedResult = ref(false);

const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

function validateUsername(value: string): string | null {
  if (!value) return "请输入用户名";
  if (value.length < 3 || value.length > 32) return "用户名长度 3–32 字符";
  if (!USERNAME_RE.test(value))
    return "用户名须以小写字母开头，仅含 a-z 0-9 _ -";
  return null;
}

/** 生成随机初始密码（12 位，字母+数字） */
function generatePassword(): void {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pwd = "";
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 12; i++) pwd += chars[arr[i]! % chars.length];
  createPassword.value = pwd;
}

function openCreate(): void {
  createUsername.value = "";
  createPassword.value = "";
  createNickname.value = "";
  createEmail.value = "";
  createPhone.value = "";
  createJobTitle.value = "";
  createStatus.value = "active";
  createRoleCodes.value = [];
  createError.value = "";
  createFieldErrors.value = {};
  createdInitialPassword.value = "";
  showCreatedResult.value = false;
  showCreate.value = true;
}

async function submitCreate(): Promise<void> {
  createError.value = "";
  createFieldErrors.value = {};
  // 用户名格式即时拦截（AC-3，前端 hard 拦截）
  const usernameErr = validateUsername(createUsername.value);
  if (usernameErr) {
    createFieldErrors.value = { username: usernameErr };
    return;
  }
  if (!createPassword.value) {
    createFieldErrors.value = { password: "请设置初始密码或点击生成" };
    return;
  }
  createLoading.value = true;
  try {
    const result = await store.create(
      {
        username: createUsername.value,
        password: createPassword.value,
        nickname: createNickname.value || undefined,
        email: createEmail.value || undefined,
        phone: createPhone.value || undefined,
        jobTitle: createJobTitle.value || undefined,
        status: createStatus.value,
      },
      createRoleCodes.value,
    );
    if (!result) {
      // store 已归位 error（含写前守卫阻断 / eiam 唯一性反馈）
      createError.value = store.error ?? "新增用户失败";
      return;
    }
    // 初始密码展示一次（Hard Rule）
    createdInitialPassword.value = result.initialPassword;
    showCreatedResult.value = true;
  } catch (err) {
    // 唯一性冲突（E10）：eiam 反馈经 contractText/validation 降级
    createError.value = errorMessage(err);
  } finally {
    createLoading.value = false;
  }
}

/** 切换角色多选（createRoleCodes 增删） */
function toggleRoleCode(code: string, list: string[]): void {
  const idx = list.indexOf(code);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(code);
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

// ---- 删除确认（AC-5，E11 依赖删除被拒）----
const deleteTarget = ref<{ id: number; username: string } | null>(null);
const deleteLoading = ref(false);
const deleteBlocked = ref<string>("");

function openDelete(id: number, username: string): void {
  deleteTarget.value = { id, username };
  deleteBlocked.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  // 阻断态下确认按钮置灰（不可确认）—— deleteBlocked 非空即阻断
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
      // delete.blocked 契约复用（阻断计数由 eiam 拒绝消息携带）
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

// ---- 编辑跳转（AC-4）----
function gotoDetail(id: number): void {
  void router.push(`/users/${id}`);
}

// ---- 状态迁移渲染辅助 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);
/** 是否存在生效中的筛选（空态区分「筛选无结果」与「本来无数据」用） */
const hasActiveFilters = computed(
  () => store.keyword !== "" || store.roleFilter !== "",
);

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const createDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(createDialogRef, { open: showCreate, onClose: closeCreate });
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  initialFocus: "[data-dialog-cancel]",
});
</script>

<template>
  <section class="page-user-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">用户管理</h2>
      <button
        v-if="can(IAM_USER.ADD)"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增用户
      </button>
    </header>

    <!-- 搜索栏：关键词 + 角色过滤 -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="搜索用户名"
        data-testid="user-search"
        @keyup.enter="applySearch"
      />
      <select
        v-model="roleFilterInput"
        class="input toolbar__filter"
        data-testid="role-filter"
        :disabled="roleFilterLoading"
        @change="applyRoleFilter(roleFilterInput)"
      >
        <option value="">全部角色</option>
        <option v-for="r in roleOptions" :key="r.code" :value="r.code">
          {{ r.name }}
        </option>
      </select>
      <button type="button" class="btn btn--ghost" @click="applySearch">
        搜索
      </button>
      <button type="button" class="btn btn--text" @click="resetFilters">
        重置
      </button>
    </div>

    <!-- 表格容器：错误 / 空 / 加载 三态都在容器内替换内容，
         避免错误态下方残留一个空表格框（原实现错误文案在框外，框内无内容） -->
    <div class="table-wrap">
      <!-- 错误态（重试）：说明文案在上、动作在下一行，避免「…请稍后重试」与「重试」连读 -->
      <div v-if="isError" class="state-error" role="alert">
        <CopyContractText code="eiam.unavailable" tag="span" />
        <button type="button" class="btn btn--text" @click="reload">重试</button>
      </div>

      <table v-else-if="store.items.length > 0" class="data-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>所属租户</th>
            <th>组织</th>
            <th>登录方式</th>
            <th>角色</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in store.items" :key="u.id">
            <td>{{ u.username }}</td>
            <td>{{ currentTenantName }}</td>
            <td class="muted">—</td>
            <td class="muted">{{ u.loginMethod }}</td>
            <td class="muted">{{ rolesCellPlaceholder }}</td>
            <td>
              <StatusBadge :status="u.status" size="sm" />
            </td>
            <td>
              <button
                v-if="can(IAM_USER.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="edit-user"
                @click="gotoDetail(u.id)"
              >
                编辑
              </button>
              <button
                v-if="can(IAM_USER.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="delete-user"
                @click="openDelete(u.id, u.username)"
              >
                删除
              </button>
              <button
                v-if="!can(IAM_USER.EDIT) && !can(IAM_USER.DELETE)"
                type="button"
                class="btn btn--text"
                data-testid="view-user"
                @click="gotoDetail(u.id)"
              >
                查看
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态：区分「筛选无结果」与「本来就没有数据」，前者给一键清除筛选出口 -->
      <div v-else-if="isEmpty" class="state-empty">
        <template v-if="hasActiveFilters">
          <p class="state-empty__text">没有匹配的用户，试试更换关键词或角色</p>
          <button
            type="button"
            class="btn btn--text"
            data-testid="clear-filters"
            @click="resetFilters"
          >
            清除筛选
          </button>
        </template>
        <p v-else class="state-empty__text">暂无用户数据</p>
      </div>

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

    <!-- 新增 Dialog -->
    <div v-if="showCreate" class="dialog-overlay" @click.self="closeCreate">
      <div
        ref="createDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新增用户"
      >
        <header class="dialog__head">
          <h3>新增用户</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeCreate"
          >
            ✕
          </button>
        </header>

        <!-- 创建结果：初始密码展示一次（Hard Rule） -->
        <div v-if="showCreatedResult" class="dialog__body">
          <p class="create-result" role="alert">
            用户
            <strong>{{ createUsername }}</strong>
            创建成功。请妥善保管初始密码（仅展示本次）：
          </p>
          <code class="initial-password" data-testid="initial-password">{{
            createdInitialPassword
          }}</code>
          <p class="muted">
            首次登录后将强制修改密码（E1）。该密码不会再次展示。
          </p>
          <!-- 成功面板主按钮用「完成」而非「关闭」：
               与右上 ✕ 的 aria-label「关闭」区分，避免同一弹窗出现两个同名动作
               （读屏与自动化选择器都会因此产生歧义）。 -->
          <button type="button" class="btn btn--primary" @click="closeCreate">
            完成
          </button>
        </div>

        <form v-else class="dialog__body" @submit.prevent="submitCreate">
          <p v-if="createError" class="form-error" role="alert">
            <CopyContractText :code="createError" tag="span" />
          </p>
          <label class="field">
            <span class="field__label"
              >用户名<span class="required">*</span></span
            >
            <input
              v-model="createUsername"
              type="text"
              class="input"
              data-testid="create-username"
              :aria-describedby="
                createFieldErrors.username ? 'create-username-error' : undefined
              "
              :aria-invalid="!!createFieldErrors.username"
            />
            <span
              v-if="createFieldErrors.username"
              id="create-username-error"
              class="field__error"
              role="alert"
              >{{ createFieldErrors.username }}</span
            >
          </label>
          <label class="field">
            <span class="field__label"
              >初始密码<span class="required">*</span></span
            >
            <input
              v-model="createPassword"
              type="text"
              class="input"
              data-testid="create-password"
              :aria-describedby="
                createFieldErrors.password ? 'create-password-error' : undefined
              "
              :aria-invalid="!!createFieldErrors.password"
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              @click="generatePassword"
            >
              生成
            </button>
            <span
              v-if="createFieldErrors.password"
              id="create-password-error"
              class="field__error"
              role="alert"
              >{{ createFieldErrors.password }}</span
            >
            <span class="muted">设置或生成；仅展示一次，不进列表/编辑回显</span>
          </label>
          <label class="field">
            <span class="field__label">昵称</span>
            <input v-model="createNickname" type="text" class="input" />
          </label>
          <label class="field">
            <span class="field__label">邮箱</span>
            <input v-model="createEmail" type="email" class="input" />
          </label>
          <label class="field">
            <span class="field__label">手机</span>
            <input v-model="createPhone" type="tel" class="input" />
          </label>
          <label class="field">
            <span class="field__label">职位</span>
            <input v-model="createJobTitle" type="text" class="input" />
          </label>
          <label class="field">
            <span class="field__label">状态</span>
            <select v-model="createStatus" class="input">
              <option value="active">启用</option>
              <option value="disable">禁用</option>
            </select>
          </label>
          <div class="field">
            <span class="field__label">角色绑定</span>
            <div v-if="can(IAM_ROLE.BATCH_ASSIGN)" class="checkbox-group">
              <label
                v-for="r in roleOptions"
                :key="r.code"
                class="checkbox-item"
              >
                <input
                  type="checkbox"
                  :value="r.code"
                  :checked="createRoleCodes.includes(r.code)"
                  @change="toggleRoleCode(r.code, createRoleCodes)"
                />
                {{ r.name }}
              </label>
              <span v-if="roleOptions.length === 0" class="muted"
                >无可选角色</span
              >
            </div>
            <span v-else class="muted"
              >创建时绑定角色需持有 iam:role:batch_assign（当前未持有，跳过绑定）</span
            >
          </div>
          <div class="field">
            <span class="field__label">所属租户</span>
            <span class="muted">{{ currentTenantName }}（当前租户上下文）</span>
          </div>
          <div class="field">
            <span class="field__label">组织</span>
            <span class="muted">—（新建时暂不支持指定组织，可在用户详情中查看）</span>
          </div>
          <div class="dialog__actions">
            <button type="button" class="btn btn--ghost" @click="closeCreate">
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="createLoading"
              data-testid="create-submit"
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
        aria-describedby="delete-user-desc"
        :aria-label="`删除用户 ${deleteTarget.username}`"
      >
        <header class="dialog__head">
          <h3>删除用户</h3>
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
          <p id="delete-user-desc">
            确认删除用户 <strong>{{ deleteTarget.username }}</strong
            >？此操作不可撤销。
          </p>
          <!-- E11 依赖删除被拒：阻断计数由 eiam 拒绝消息携带 -->
          <p v-if="deleteBlocked" class="delete-blocked" role="alert">
            <CopyContractText :code="deleteBlocked" tag="span" />
          </p>
        </div>
        <div class="dialog__actions">
          <!-- 危险操作弹窗：初始焦点落在「取消」而非「确认删除」，避免回车误删 -->
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
.page-user-list {
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
  &--sm {
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
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
  // 窄屏（≤768）不用把列压扁：保留可读最小宽度，交给 .table-wrap 横向滚动。
  // 缺这条时「所属租户」会被压到 37px，中文按字换行成竖排，一行行高 90px+。
  min-width: 720px;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
    // 禁止逐字竖排（中文单元格在窄列里会一列一字）
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

// 错误态：文案在上、重试动作在下一行。
// 同处一行时文案「…请稍后重试」与紧邻的「重试」按钮会被读成「…重试重试」，
// 上下列排后语义清晰（消息 = 说明，按钮 = 动作）。
.state-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.state-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;

  &__text {
    margin: 0;
  }
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
    // 内容超过 85vh 时弹窗内部滚动，标题与 ✕ 吸顶，避免滚出可视区后无关闭入口
    position: sticky;
    top: 0;
    background: var(--bg-elevated);
    z-index: 1;
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

.create-result {
  color: var(--text-regular);
  font-size: 13px;
}

.initial-password {
  display: inline-block;
  padding: 8px 12px;
  background: var(--tag-bg);
  border-radius: 6px;
  font-family: monospace;
  font-size: 16px;
  color: var(--accent-primary);
  user-select: all;
}

.checkbox-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
}

.checkbox-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-regular);
  cursor: pointer;
}
</style>
