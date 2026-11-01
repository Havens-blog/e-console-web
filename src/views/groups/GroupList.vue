<script setup lang="ts">
/**
 * 用户组管理列表页（feat-group-management 契约 §2.3）。
 *
 * 结构参照 src/views/tenants/TenantList.vue：原生元素 + `.page-*` / `.data-table` / `.btn` /
 * `.input` / `.dialog-overlay` 样式语言，**不使用 Element Plus 组件**。
 *
 * 布局：页头（标题 + 新建）→ 工具条（关键词搜索 / 重置）→ 表格 → 分页。
 * - 列：名称 / 标识码 / 描述 / 创建时间 / 操作
 * - 创建时间经 `@/views/tenants/timestamp` 的 formatEpochMs 渲染（Unix 毫秒 + 年份护栏，
 *   不另写一套时间格式化 —— 契约 §1 硬约束）
 * - 分页边界 E7（page 超界回落 / 末页空回退 / 切过滤重置 1）由 groupList store 承载
 *
 * 权限裁剪（BIZ-auth-001，仅体验层；服务端 OPA 403 才是安全边界）：
 * - 页面级：路由 meta.permissions = [IAM_GROUP.VIEW]（+ requiresAdmin）
 * - 按钮级：新建 IAM_GROUP.ADD / 编辑 IAM_GROUP.EDIT / 删除 IAM_GROUP.DELETE /
 *   成员 IAM_GROUP.MEMBERS（feat-group-members 契约 §2.3）/ 角色 IAM_GROUP.ROLES
 *   （feat-group-roles 契约 §2.3）
 *
 * 成员抽屉（feat-group-members）：行内「成员」按钮 → GroupMembersDrawer（按行的 groupCode
 * 自拉成员列表）；抽屉 emit('changed') → store.fetch()（组列表本身不含成员数，刷新是保持一致性）。
 *
 * 角色弹窗（feat-group-roles）：行内「角色」按钮 → GroupRolesDialog（按行的 groupCode 自拉
 * 已绑角色 + 候选排除已绑定）；契约 §2.3：角色不影响组字段，emit('changed') 无需刷新组列表。
 *
 * 策略弹窗（feat-group-policies 契约 §2.3）：行内「策略」按钮（IAM_POLICY.VIEW_GROUP_POLICIES）
 * → GroupPoliciesDialog（按行的 groupCode 只读反查该组直接绑定的策略）；**纯只读**，
 * 弹窗内无绑定 / 解绑 / 提交入口，故无 changed 事件。
 *
 * 标识码只读（契约 §2.3 硬约束）：eiam UpdateGroupReq 不含 code 字段，编辑态标识码
 * 以 readonly 展示且不进入更新载荷 —— 否则会出现「界面改了但服务端没改」的假成功。
 */
import { computed, onMounted, ref } from "vue";
import { ApiError } from "@/api/types";
import type { TenantGroup } from "@/api/types";
import { useGroupListStore } from "@/stores/groupList";
import {
  GROUP_CODE_MAX,
  GROUP_DESC_MAX,
  GROUP_NAME_MAX,
} from "@/stores/groupList";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_GROUP, IAM_POLICY } from "@/config/permission-codes";
import { formatEpochMs } from "@/views/tenants/timestamp";
import GroupMembersDrawer from "./GroupMembersDrawer.vue";
import GroupPoliciesDialog from "./GroupPoliciesDialog.vue";
import GroupRolesDialog from "./GroupRolesDialog.vue";
import { useUrlKeyword } from "@/composables/useUrlKeyword";

const store = useGroupListStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts，与菜单 & 路由守卫同口径）
const { can } = useCan();

// ---- 搜索（当前页内即时筛选）----
// 事实依据：eiam `POST /iam/group/list` 的请求体只有 offset/limit（见
// `internal/web/group/vo.go` 的 ListGroupRequest），**服务端不支持 keyword**。
// 因此若把关键词发给服务端，输入会被静默忽略（"假搜索"）。这里改为对**当前页已加载数据**
// 做即时筛选，并在界面上如实标注范围（placeholder / 提示文案），避免误导。
const keywordInput = ref("");

// 关键词筛选同步 URL（iter136）：此前 URL 不携带条件，「进详情/切走→返回」后筛选被清空。
useUrlKeyword(keywordInput);
const filterText = ref("");

function applySearch(): void {
  filterText.value = keywordInput.value.trim();
}

function resetSearch(): void {
  keywordInput.value = "";
  filterText.value = "";
}

/** 当前页筛选结果（匹配 名称 / 标识码 / 描述，大小写不敏感） */
const filteredItems = computed(() => {
  const kw = filterText.value.trim().toLowerCase();
  if (!kw) return store.items;
  return store.items.filter((g) =>
    [g.name, g.code, g.desc].some((v) => String(v ?? "").toLowerCase().includes(kw)),
  );
});

// ---- 分页 ----
const totalPages = computed(() =>
  store.total <= 0 ? 1 : Math.ceil(store.total / store.pageSize),
);

function changePage(p: number): void {
  store.setPage(p);
  void store.fetch();
}

function changePageSize(event: Event): void {
  store.setPageSize(Number((event.target as HTMLSelectElement).value));
  void store.fetch();
}

// ---- 列表加载 ----
async function reload(): Promise<void> {
  await store.fetch();
}

onMounted(async () => {
  // 从 ?search= 恢复的关键词要先落到 store，再取数（否则页面显示的筛选与数据不一致）
  if (keywordInput.value) {
    filterText.value = keywordInput.value;
  }
  await store.fetch();
});

// ---- 新建/编辑 Dialog ----
const showForm = ref(false);
const formMode = ref<"create" | "edit">("create");
const formLoading = ref(false);
const formError = ref<string>("");
const formFieldErrors = ref<Record<string, string>>({});
const formId = ref<number>(0);
const formName = ref("");
const formCode = ref("");
const formDesc = ref("");

/** 标识码编辑态只读（eiam update 载荷无 code） */
const codeReadonly = computed(() => formMode.value === "edit");

function validateName(value: string): string | null {
  const v = value.trim();
  if (!v) return "请输入用户组名称";
  if (v.length < 1 || v.length > GROUP_NAME_MAX)
    return `名称长度 1–${GROUP_NAME_MAX} 字符`;
  return null;
}

function validateCode(value: string): string | null {
  const v = value.trim();
  if (!v) return "请输入标识码";
  if (v.length > GROUP_CODE_MAX) return `标识码长度 ≤${GROUP_CODE_MAX}`;
  return null;
}

function validateDesc(value: string): string | null {
  if (value.length > GROUP_DESC_MAX) return `描述长度 ≤${GROUP_DESC_MAX}`;
  return null;
}

function openCreate(): void {
  formMode.value = "create";
  formId.value = 0;
  formName.value = "";
  formCode.value = "";
  formDesc.value = "";
  formError.value = "";
  formFieldErrors.value = {};
  showForm.value = true;
}

function openEdit(g: TenantGroup): void {
  formMode.value = "edit";
  formId.value = g.id;
  formName.value = g.name;
  formCode.value = g.code;
  formDesc.value = g.desc;
  formError.value = "";
  formFieldErrors.value = {};
  showForm.value = true;
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // 服务端拒绝原因原样展示（契约 §2.3 删除确认一行；表单同样只展示 eiam 原文）
    return err.message;
  }
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

async function submitForm(): Promise<void> {
  formError.value = "";
  formFieldErrors.value = {};
  const nameErr = validateName(formName.value);
  const codeErr = validateCode(formCode.value);
  const descErr = validateDesc(formDesc.value);
  if (nameErr) formFieldErrors.value.name = nameErr;
  if (codeErr) formFieldErrors.value.code = codeErr;
  if (descErr) formFieldErrors.value.desc = descErr;
  if (nameErr || codeErr || descErr) return;

  formLoading.value = true;
  try {
    if (formMode.value === "create") {
      const ok = await store.create({
        name: formName.value.trim(),
        code: formCode.value.trim(),
        desc: formDesc.value,
      });
      if (!ok) {
        formError.value = store.error ?? "新建用户组失败";
        return;
      }
    } else {
      // 编辑：载荷无 code（eiam UpdateGroupReq 不含该字段），标识码只读
      const ok = await store.update({
        id: formId.value,
        name: formName.value.trim(),
        desc: formDesc.value,
      });
      if (!ok) {
        formError.value = store.error ?? "保存失败";
        return;
      }
    }
    showForm.value = false;
  } catch (err) {
    formError.value = errorMessage(err);
  } finally {
    formLoading.value = false;
  }
}

function closeForm(): void {
  showForm.value = false;
}

// ---- 删除确认（二次确认 + 服务端拒绝 msg 透传）----
const deleteTarget = ref<TenantGroup | null>(null);
const deleteLoading = ref(false);
const deleteError = ref<string>("");

function openDelete(g: TenantGroup): void {
  deleteTarget.value = g;
  deleteError.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleteLoading.value = true;
  deleteError.value = "";
  try {
    await store.remove(deleteTarget.value.id);
    deleteTarget.value = null;
  } catch (err) {
    // 服务端拒绝（如组内仍有成员）→ 原样展示 msg，弹窗保持打开
    deleteError.value = errorMessage(err);
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteError.value = "";
}

// ---- 成员抽屉（feat-group-members 契约 §2.3）----
// 行内「成员」按钮仅对持有 iam:group:members 的用户渲染；打开后抽屉按该行 groupCode
// 自拉成员列表（group 端点按会话租户隔离，无需跨租户 Header）。
// 只存 code + name：父页每次重渲染都新建 props 对象，抽屉按 code（字符串）观察开关。
const membersGroup = ref<{ code: string; name: string } | null>(null);

function openMembers(g: TenantGroup): void {
  membersGroup.value = { code: g.code, name: g.name };
}

function closeMembers(): void {
  membersGroup.value = null;
}

/** 成员增删成功 → 刷新用户组列表（保持与后端一致；列表本身不含成员数） */
function onMembersChanged(): void {
  void store.fetch();
}

// ---- 角色弹窗（feat-group-roles 契约 §2.3）----
// 行内「角色」按钮仅对持有 iam:group:roles 的用户渲染；打开后弹窗按该行 groupCode 自拉
// 已绑角色（GET /api/iam/group/roles/:code），候选角色排除已绑定项。
const rolesGroup = ref<{ code: string; name: string } | null>(null);

function openRoles(g: TenantGroup): void {
  rolesGroup.value = { code: g.code, name: g.name };
}

function closeRoles(): void {
  rolesGroup.value = null;
}

/**
 * 角色变更成功 → 契约 §2.3：角色不影响组字段（列表无角色列），故**不刷新组列表**；
 * 保留 emit('changed') 接线是为与成员抽屉的事件契约一致（事件已收到）。
 */
function onRolesChanged(): void {
  // 刻意留空：角色分配 / 解绑不改变组列表任何字段
}

// ---- 策略弹窗（feat-group-policies 契约 §2.3）----
// 行内「策略」按钮仅对持有 iam:policy:view_group_policies 的用户渲染；打开后弹窗按该行
// groupCode 只读反查该组**直接绑定**的策略（POST /api/iam/policy/list/attached/group）。
// 纯只读：弹窗内没有任何绑定 / 解绑入口，也没有 changed 事件（策略不是组字段）。
const policiesGroup = ref<{ code: string; name: string } | null>(null);

function openPolicies(g: TenantGroup): void {
  policiesGroup.value = { code: g.code, name: g.name };
}

function closePolicies(): void {
  policiesGroup.value = null;
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const formDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(formDialogRef, { open: showForm, onClose: closeForm });
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误删
  initialFocus: "[data-dialog-cancel]",
});

// ---- 状态判别 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);
/** 是否存在生效中的筛选（本地即时筛选，与服务端无关） */
const hasActiveFilters = computed(() => filterText.value.trim() !== "");
/** 有数据但当前页筛不出结果 */
const isNoMatch = computed(
  () =>
    !store.loading
    && store.error === null
    && store.items.length > 0
    && filteredItems.value.length === 0,
);

/** 创建时间列（Unix 毫秒 → 本地时间；缺失 / 越界 → '—'） */
function createdText(g: TenantGroup): string {
  return formatEpochMs(g.ctime);
}
</script>

<template>
  <section class="page-group-list" :aria-busy="store.loading">
    <header class="page-head">
      <!-- 页面主标题用 h1（原为 h2，导致整页没有 h1）；.page-title 已显式定义 20px/600/margin:0，视觉不变 -->
      <h1 class="page-title">用户组管理</h1>
      <button
        v-if="can(IAM_GROUP.ADD)"
        type="button"
        class="btn btn--primary"
        data-testid="group-create"
        @click="openCreate"
      >
        新建用户组
      </button>
    </header>

    <!-- 工具条：当前页即时筛选（服务端 list 不支持 keyword，故不重查） -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="筛选当前页：名称 / 标识码 / 描述"
        aria-label="筛选当前页的用户组"
        data-testid="group-search"
        @keyup.enter="applySearch"
      />
      <button
        type="button"
        class="btn btn--ghost"
        data-testid="group-search-submit"
        @click="applySearch"
      >
        搜索
      </button>
      <button
        type="button"
        class="btn btn--text"
        data-testid="group-search-reset"
        @click="resetSearch"
      >
        重置
      </button>
    </div>

    <!-- 表格容器：错误 / 空 / 加载 三态都在容器内替换内容，避免错误态下方残留空表格框 -->
    <div class="table-wrap">
      <div v-if="isError" class="state-error" role="alert">
        <span>{{ store.error }}</span>
        <button type="button" class="btn btn--text" @click="reload">重试</button>
      </div>

      <table v-else-if="filteredItems.length > 0" class="data-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>标识码</th>
            <th>描述</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="g in filteredItems"
            :key="g.id"
            data-testid="group-row"
            :data-group-id="g.id"
          >
            <td>{{ g.name }}</td>
            <td class="mono">{{ g.code }}</td>
            <td class="muted desc-cell" :title="g.desc">
              {{ g.desc || "—" }}
            </td>
            <td class="muted">{{ createdText(g) }}</td>
            <td>
              <button
                v-if="can(IAM_GROUP.ROLES)"
                type="button"
                class="btn btn--text"
                data-testid="group-roles"
                @click="openRoles(g)"
              >
                角色
              </button>
              <button
                v-if="can(IAM_POLICY.VIEW_GROUP_POLICIES)"
                type="button"
                class="btn btn--text"
                data-testid="group-policies"
                @click="openPolicies(g)"
              >
                策略
              </button>
              <button
                v-if="can(IAM_GROUP.MEMBERS)"
                type="button"
                class="btn btn--text"
                data-testid="group-members"
                @click="openMembers(g)"
              >
                成员
              </button>
              <button
                v-if="can(IAM_GROUP.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="group-edit"
                @click="openEdit(g)"
              >
                编辑
              </button>
              <button
                v-if="can(IAM_GROUP.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="group-delete"
                @click="openDelete(g)"
              >
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态：区分「筛不出结果」「本来无数据」「当前页无匹配」 -->
      <div v-else-if="isEmpty" class="state-empty">
        <template v-if="hasActiveFilters">
          <p class="state-empty__text">没有匹配的用户组，试试更换关键词</p>
          <button
            type="button"
            class="btn btn--text"
            data-testid="group-clear-filters"
            @click="resetSearch"
          >
            清除筛选
          </button>
        </template>
        <p v-else class="state-empty__text">暂无用户组</p>
      </div>

      <!-- 有数据但当前页筛不出结果 -->
      <div v-else-if="isNoMatch" class="state-empty">
        <p class="state-empty__text">当前页没有匹配的用户组（筛选仅作用于本页）</p>
        <button
          type="button"
          class="btn btn--text"
          data-testid="group-clear-filters"
          @click="resetSearch"
        >
          清除筛选
        </button>
      </div>

      <!-- 加载骨架 -->
      <div v-else-if="store.loading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>
    </div>

    <!-- 分页（20 / 50 / 100） -->
    <nav v-if="store.total > 0" class="pagination" aria-label="分页">
      <button
        type="button"
        class="btn btn--text"
        :disabled="store.page <= 1"
        data-testid="group-page-prev"
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
        data-testid="group-page-next"
        @click="changePage(store.page + 1)"
      >
        下一页
      </button>
      <select
        :value="store.pageSize"
        class="input pagination__size"
        aria-label="每页条数"
        data-testid="group-page-size"
        @change="changePageSize"
      >
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
    </nav>

    <!-- 新建/编辑 Dialog -->
    <div v-if="showForm" class="dialog-overlay" @click.self="closeForm">
      <div
        ref="formDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        data-testid="group-form"
        :aria-label="formMode === 'create' ? '新建用户组' : '编辑用户组'"
      >
        <header class="dialog__head">
          <h3>{{ formMode === "create" ? "新建用户组" : "编辑用户组" }}</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeForm"
          >
            ✕
          </button>
        </header>
        <form class="dialog__body" @submit.prevent="submitForm">
          <p v-if="formError" class="form-error" role="alert">
            {{ formError }}
          </p>
          <label class="field">
            <span class="field__label"
              >名称<span class="required">*</span></span
            >
            <input
              v-model="formName"
              type="text"
              class="input"
              data-testid="group-form-name"
              :maxlength="GROUP_NAME_MAX"
              :aria-invalid="!!formFieldErrors.name"
              :aria-describedby="
                formFieldErrors.name ? 'group-form-name-error' : undefined
              "
            />
            <span
              v-if="formFieldErrors.name"
              id="group-form-name-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.name }}</span
            >
            <span class="muted">1–{{ GROUP_NAME_MAX }} 字符</span>
          </label>
          <label class="field">
            <span class="field__label"
              >标识码<span class="required">*</span></span
            >
            <input
              v-model="formCode"
              type="text"
              class="input"
              data-testid="group-form-code"
              :readonly="codeReadonly"
              :maxlength="GROUP_CODE_MAX"
              :aria-invalid="!!formFieldErrors.code"
              :aria-describedby="
                formFieldErrors.code ? 'group-form-code-error' : undefined
              "
            />
            <span
              v-if="formFieldErrors.code"
              id="group-form-code-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.code }}</span
            >
            <span v-if="codeReadonly" class="muted"
              >标识码创建后不可修改</span
            >
            <span v-else class="muted">≤{{ GROUP_CODE_MAX }} 字符</span>
          </label>
          <label class="field">
            <span class="field__label">描述</span>
            <textarea
              v-model="formDesc"
              class="input textarea"
              rows="3"
              data-testid="group-form-desc"
              :maxlength="GROUP_DESC_MAX"
              :aria-invalid="!!formFieldErrors.desc"
              :aria-describedby="
                formFieldErrors.desc ? 'group-form-desc-error' : undefined
              "
            />
            <span
              v-if="formFieldErrors.desc"
              id="group-form-desc-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.desc }}</span
            >
            <span class="muted">≤{{ GROUP_DESC_MAX }} 字符</span>
          </label>

          <div class="dialog__actions">
            <button
              type="button"
              class="btn btn--ghost"
              data-dialog-cancel
              @click="closeForm"
            >
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="formLoading"
              data-testid="group-form-submit"
            >
              {{ formLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 删除二次确认 Dialog -->
    <div
      v-if="deleteTarget"
      class="dialog-overlay"
      @click.self="closeDelete"
    >
      <div
        ref="deleteDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="group-delete-desc"
        data-testid="group-delete-confirm"
        :aria-label="`删除用户组 ${deleteTarget.name}`"
      >
        <header class="dialog__head">
          <h3>删除用户组</h3>
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
          <p id="group-delete-desc">
            确认删除用户组 <strong>{{ deleteTarget.name }}</strong
            >？此操作不可撤销。
          </p>
          <!-- 服务端拒绝原因原样展示（契约 §2.3） -->
          <p
            v-if="deleteError"
            class="delete-blocked"
            role="alert"
            data-testid="group-delete-error"
          >
            {{ deleteError }}
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
            :disabled="deleteLoading"
            data-testid="group-delete-submit"
            @click="confirmDelete"
          >
            {{ deleteLoading ? "删除中…" : "确认删除" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 组成员抽屉（feat-group-members 契约 §2.3） -->
    <GroupMembersDrawer
      :group="membersGroup"
      @close="closeMembers"
      @changed="onMembersChanged"
    />

    <!-- 组角色弹窗（feat-group-roles 契约 §2.3） -->
    <GroupRolesDialog
      :group="rolesGroup"
      @close="closeRoles"
      @changed="onRolesChanged"
    />

    <!-- 组直接策略弹窗（feat-group-policies 契约 §2.3；纯只读，无 changed） -->
    <GroupPoliciesDialog :group="policiesGroup" @close="closePolicies" />
  </section>
</template>

<style scoped lang="scss">
.page-group-list {
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
    min-width: 240px;
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

.textarea {
  height: auto;
  padding: 8px 10px;
  line-height: 1.5;
  resize: vertical;
  font-family: inherit;
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
  min-height: 120px;
}

.data-table {
  width: 100%;
  // 窄屏保留可读最小列宽，超出容器由 .table-wrap 横向滚动承担
  min-width: 760px;
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

/* 描述列可截断（长文本不撑破表格；完整文本经 title 可读） */
.desc-cell {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
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

// 错误态：说明在上、重试动作在下一行（同行时「…重试」+「重试」会读成「重试重试」）
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
    // 弹窗内部滚动时标题与 ✕ 吸顶，避免滚出可视区后无关闭入口
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
</style>
