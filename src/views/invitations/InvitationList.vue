<script setup lang="ts">
/**
 * 邀请管理页（feat-invitation-management 契约 §2.2）。
 *
 * 结构参照 src/views/groups/GroupList.vue：原生元素 + `.page-*` / `.data-table` / `.btn` /
 * `.input` / `.dialog-overlay` 样式语言，**不使用 Element Plus 组件、不引入新依赖**。
 *
 * 布局：页头（标题「邀请管理」+「创建邀请」）→ 视图页签（邀请列表 / 加入申请）→
 * 表格 → 分页（20·50·100）。
 * - 邀请表列：（多选）邀请码（等宽）/ 租户 / 角色 / 用量（used/max）/ 过期时间 / 需审批 / 操作
 * - 过期时间经 `@/views/tenants/timestamp` 的 formatEpochMs 渲染（Unix 毫秒 + 年份护栏，
 *   不另写一套时间格式化 —— 契约 §1 硬约束）；申请时间同源。
 * - 加入申请表**只读**（本切片不含处理申请，见 manifest 范围边界），空态「暂无加入申请」。
 *
 * feat-invitation-complete 增量（契约 §2.2，三处）：
 * 1. 创建弹窗内**角色多选**：候选复用 `@/api/roles` 的 `listRolesPage` 翻页拉齐
 *    （100/页，≤20 页护栏；不重复实现角色列表），提交 `role_codes` 为所选项 code 数组，
 *    **允许空选**（向后兼容：不选角色 = 旧行为）。
 * 2. 邀请表**行多选**（`invitation-select` / 表头 `invitation-select-all`）+ **批量撤回**
 *    （`invitation-batch-revoke`，需 `IAM_INVITATION.BATCH_DELETE`，无选中禁用）→ 二次确认
 *    → `batchRevokeInvitations(codes)` → 成功后清空选中并重拉；被拒原样展示服务端 msg。
 * 3. 「加入申请」页签按 `IAM_INVITATION.VIEW_REQUESTS` 显隐：缺码时**不渲染且不发请求**
 *    （上一轮缺码要等点开才 403，属可避免的失败）。
 *
 * 权限裁剪（BIZ-auth-001，仅体验层；服务端 OPA 403 才是安全边界）：
 * - 页面级：路由 meta.permissions = [IAM_INVITATION.VIEW]（+ requiresAdmin）
 * - 按钮级：创建 IAM_INVITATION.ADD / 撤回 IAM_INVITATION.DELETE /
 *   批量撤回 IAM_INVITATION.BATCH_DELETE / 页签 IAM_INVITATION.VIEW_REQUESTS
 *
 * 状态机（契约 §2.2 状态行）：加载骨架 / 空态 / 错误 + 重试 / 提交中禁用各页签独立。
 * 两个列表互不共享分页与错误态（切页签不互相污染）。
 *
 * 撤回：行内「撤回」→ 二次确认弹窗 → revokeInvitation(code) → 成功后重拉；
 * 被拒（如已被使用）原样展示服务端 msg，弹窗保持打开（可重试或取消）。
 * 批量撤回遵循同一口径：弹窗保持打开、选中不清空、错误原文展示（不谎报部分成功）。
 */
import { computed, onMounted, ref } from "vue";
import {
  batchRevokeInvitations,
  createInvitation,
  handleJoinRequest,
  listInvitations,
  listJoinRequests,
  revokeInvitation,
} from "@/api/invitations";
import type { Invitation, JoinRequest } from "@/api/invitations";
import { listRolesPage } from "@/api/roles";
import { ApiError } from "@/api/types";
import type { Role } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_INVITATION } from "@/config/permission-codes";
import { formatEpochMs } from "@/views/tenants/timestamp";

const { can } = useCan();

/** 「加入申请」页签可见性：缺码时不渲染页签（也就不可能触发 /requests 请求） */
const canViewRequests = computed<boolean>(() =>
  can(IAM_INVITATION.VIEW_REQUESTS),
);

/** 批量撤回能力（无码时不渲染选择列与批量按钮） */
const canBatchRevoke = computed<boolean>(() => can(IAM_INVITATION.BATCH_DELETE));

/**
 * 处理加入申请的能力（iam:invitation:handle_request）。
 *
 * 为什么在此门控：后端已实现 /requests/handle 且声明了该能力码，但 console 侧此前
 * 既无 api 函数也无视图调用 —— 管理员看不到"通过/拒绝"入口。缺码时整列不渲染，也就不发请求。
 */
const canHandleRequest = computed<boolean>(() =>
  can(IAM_INVITATION.HANDLE_REQUEST),
);

/** 正在处理的申请 id：非空即禁用该行按钮，杜绝重复提交（后端会拒绝重复处理） */
const handlingId = ref<number | null>(null);
/** 处理失败文案（eiam msg 原文；不吞掉可处置信息） */
const handleError = ref<string>("");

/**
 * 处理加入申请：approve=true 通过、false 拒绝。
 *
 * 成功后重拉列表（后端不回传逐条结果，且列表里该项应消失）；
 * 失败归位 handleError，**不谎报成功**、不清列表。
 */
async function handleRequest(r: JoinRequest, approve: boolean): Promise<void> {
  if (handlingId.value !== null) return;
  handlingId.value = r.id;
  handleError.value = "";
  try {
    await handleJoinRequest(r.id, approve);
    await loadRequests();
  } catch (err) {
    handleError.value = errorMessage(err);
  } finally {
    handlingId.value = null;
  }
}

// ---- 视图页签 ----
type TabKey = "list" | "requests";
const activeTab = ref<TabKey>("list");

// ---- 邀请列表 ----
const invitations = ref<Invitation[]>([]);
const invTotal = ref<number>(0);
const invPage = ref<number>(1);
const invPageSize = ref<number>(20);
const invLoading = ref<boolean>(false);
const invError = ref<string>("");

/** 在途请求序号（切页签 / 重拉后旧响应一律丢弃） */
let invSeq = 0;

// ---- 行多选（批量撤回的选中集；与列表重拉收敛）----
const selectedCodes = ref<string[]>([]);

/** 当前页是否全选（表头复选框双向绑定：勾选补齐全页，取消移除本页） */
const allSelected = computed<boolean>({
  get: () =>
    invitations.value.length > 0
    && invitations.value.every((inv) => selectedCodes.value.includes(inv.code)),
  set: (checked: boolean) => {
    if (checked) {
      const next = new Set(selectedCodes.value);
      for (const inv of invitations.value) next.add(inv.code);
      selectedCodes.value = [...next];
    } else {
      const visible = new Set(invitations.value.map((inv) => inv.code));
      selectedCodes.value = selectedCodes.value.filter((c) => !visible.has(c));
    }
  },
});

const invTotalPages = computed(() =>
  invTotal.value <= 0 ? 1 : Math.ceil(invTotal.value / invPageSize.value),
);

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

/** 拉取邀请列表（当前页）。 */
async function loadInvitations(): Promise<void> {
  const seq = ++invSeq;
  invLoading.value = true;
  invError.value = "";
  try {
    const page = await listInvitations({
      offset: (invPage.value - 1) * invPageSize.value,
      limit: invPageSize.value,
      keyword: "",
    });
    if (seq !== invSeq) return;
    invitations.value = page.items;
    invTotal.value = page.total;
    // 选中集随列表收敛：已不在当前页的邀请码不再参与批量撤回（避免撤回看不见的行）
    const visibleCodes = new Set(page.items.map((inv) => inv.code));
    selectedCodes.value = selectedCodes.value.filter((c) =>
      visibleCodes.has(c),
    );
    // page 超界（如末页记录被删）→ 回落最后页重查
    const last = invTotalPages.value;
    if (invPage.value > last && invTotal.value > 0) {
      invPage.value = last;
      await loadInvitations();
    }
  } catch (err) {
    if (seq !== invSeq) return;
    invitations.value = [];
    invTotal.value = 0;
    selectedCodes.value = [];
    invError.value = errorMessage(err);
  } finally {
    if (seq === invSeq) invLoading.value = false;
  }
}

function changeInvPage(p: number): void {
  invPage.value = p < 1 ? 1 : p;
  void loadInvitations();
}

function changeInvPageSize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value);
  invPageSize.value = Number.isFinite(size) && size > 0 ? size : 20;
  invPage.value = 1;
  void loadInvitations();
}

// ---- 加入申请列表（只读）----
const requests = ref<JoinRequest[]>([]);
const reqTotal = ref<number>(0);
const reqPage = ref<number>(1);
const reqPageSize = ref<number>(20);
const reqLoading = ref<boolean>(false);
const reqError = ref<string>("");

let reqSeq = 0;

const reqTotalPages = computed(() =>
  reqTotal.value <= 0 ? 1 : Math.ceil(reqTotal.value / reqPageSize.value),
);

/** 拉取加入申请（当前页）；只读，无任何写操作入口。 */
async function loadRequests(): Promise<void> {
  const seq = ++reqSeq;
  reqLoading.value = true;
  reqError.value = "";
  try {
    const page = await listJoinRequests({
      offset: (reqPage.value - 1) * reqPageSize.value,
      limit: reqPageSize.value,
      keyword: "",
    });
    if (seq !== reqSeq) return;
    requests.value = page.items;
    reqTotal.value = page.total;
    const last = reqTotalPages.value;
    if (reqPage.value > last && reqTotal.value > 0) {
      reqPage.value = last;
      await loadRequests();
    }
  } catch (err) {
    if (seq !== reqSeq) return;
    requests.value = [];
    reqTotal.value = 0;
    reqError.value = errorMessage(err);
  } finally {
    if (seq === reqSeq) reqLoading.value = false;
  }
}

function changeReqPage(p: number): void {
  reqPage.value = p < 1 ? 1 : p;
  void loadRequests();
}

function changeReqPageSize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value);
  reqPageSize.value = Number.isFinite(size) && size > 0 ? size : 20;
  reqPage.value = 1;
  void loadRequests();
}

/** 切换页签：进入哪个页签就（重新）拉哪个列表。缺 VIEW_REQUESTS 时拒绝进入申请页签（不发请求）。 */
async function switchTab(tab: TabKey): Promise<void> {
  if (activeTab.value === tab) return;
  if (tab === "requests" && !canViewRequests.value) return;
  activeTab.value = tab;
  if (tab === "list") {
    await loadInvitations();
  } else {
    await loadRequests();
  }
}

onMounted(async () => {
  await loadInvitations();
});

// ---- 角色候选（创建弹窗的角色多选数据源）----
/**
 * 候选分页条数 / 翻页上限：`listRolesPage` 是分页接口（A 档 `{total, roles}`），
 * 需翻页凑齐全量；≤20 页护栏防服务端 total 异常导致死循环（契约 §2.2「100/页拉齐，≤20 页」）。
 */
const ROLE_PAGE_SIZE = 100;
const ROLE_MAX_PAGES = 20;

const roleOptions = ref<Role[]>([]);
const rolesLoading = ref<boolean>(false);
const rolesError = ref<string>("");

/** 角色候选请求序号（关闭 / 重开弹窗时作废旧响应） */
let roleSeq = 0;

/** 翻页拉取全量角色（复用 api/roles 的 listRolesPage，**不重复实现**角色列表）。 */
async function fetchAllRoles(): Promise<Role[]> {
  const all: Role[] = [];
  for (let page = 0; page < ROLE_MAX_PAGES; page++) {
    const result = await listRolesPage({
      offset: all.length,
      limit: ROLE_PAGE_SIZE,
      keyword: "",
    });
    if (result.items.length === 0) break;
    all.push(...result.items);
    if (all.length >= result.total) break;
  }
  // 去重 + 丢弃无 code 项（code 是提交值，空 code 不可选）
  const seen = new Set<string>();
  return all.filter((r) => {
    if (r.code === "" || seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });
}

/** 拉取角色候选（创建弹窗打开时调用）。 */
async function loadRoleOptions(): Promise<void> {
  const seq = ++roleSeq;
  rolesLoading.value = true;
  rolesError.value = "";
  try {
    const all = await fetchAllRoles();
    if (seq !== roleSeq) return;
    roleOptions.value = all;
  } catch (err) {
    if (seq !== roleSeq) return;
    roleOptions.value = [];
    rolesError.value = errorMessage(err);
  } finally {
    if (seq === roleSeq) rolesLoading.value = false;
  }
}

// ---- 创建邀请弹窗 ----
const showForm = ref<boolean>(false);
// v-model 在 type="number" 输入上自动做数值转换（Vue 内置 .number 语义），
// 故 ref 类型同时容纳 string（空输入）与 number（已输入整数）。
const formMaxUses = ref<string | number>("1");
const formExpiryDays = ref<string | number>("7");
const formRequireApproval = ref<boolean>(false);
/** 选中的角色 code 列表（允许空选 —— 契约 §2.2 向后兼容） */
const formRoleCodes = ref<string[]>([]);
const formLoading = ref<boolean>(false);
const formError = ref<string>("");
const formFieldErrors = ref<Record<string, string>>({});

/** 契约 §2.2：max_uses 为整数 ≥1（默认 1） */
const MAX_USES_MIN = 1;
/** 契约 §2.2：expiry 1–365（默认 7） */
const EXPIRY_DAYS_MIN = 1;
const EXPIRY_DAYS_MAX = 365;

/** 表单数值归一：number → 十进制字符串；string 去空白；其余 → 空串（视为缺失） */
function numericText(raw: string | number): string {
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : "";
  return typeof raw === "string" ? raw.trim() : "";
}

function validateMaxUses(raw: string | number): string | null {
  const text = numericText(raw);
  const n = Number(text);
  if (text === "" || !Number.isInteger(n) || n < MAX_USES_MIN)
    return `最大使用次数须为 ≥${MAX_USES_MIN} 的整数`;
  return null;
}

function validateExpiryDays(raw: string | number): string | null {
  const text = numericText(raw);
  const n = Number(text);
  if (
    text === ""
    || !Number.isInteger(n)
    || n < EXPIRY_DAYS_MIN
    || n > EXPIRY_DAYS_MAX
  )
    return `有效天数须为 ${EXPIRY_DAYS_MIN}–${EXPIRY_DAYS_MAX} 的整数`;
  return null;
}

function openCreate(): void {
  formMaxUses.value = "1";
  formExpiryDays.value = "7";
  formRequireApproval.value = false;
  formRoleCodes.value = [];
  formError.value = "";
  formFieldErrors.value = {};
  showForm.value = true;
  // 角色候选在打开时拉取（弹窗由 ADD 权限按钮触发；候选不随页面挂载预取，避免无谓请求）
  void loadRoleOptions();
}

function closeForm(): void {
  if (formLoading.value) return;
  showForm.value = false;
}

/**
 * 提交创建：成功 → 关弹窗 + 回第 1 页重拉（新记录是否落首页由服务端排序决定，前端不臆造）；
 * 被拒 → 弹窗内原样展示服务端 msg。
 *
 * `role_codes` = 角色多选所选的 code 数组（**允许空数组**：不选角色即旧行为，契约 §2.2）。
 */
async function submitForm(): Promise<void> {
  if (formLoading.value) return;
  formError.value = "";
  formFieldErrors.value = {};
  const maxErr = validateMaxUses(formMaxUses.value);
  const expiryErr = validateExpiryDays(formExpiryDays.value);
  if (maxErr) formFieldErrors.value.maxUses = maxErr;
  if (expiryErr) formFieldErrors.value.expiryDays = expiryErr;
  if (maxErr || expiryErr) return;

  formLoading.value = true;
  try {
    await createInvitation({
      maxUses: Number(formMaxUses.value),
      expiryDays: Number(formExpiryDays.value),
      roleCodes: [...formRoleCodes.value],
      requireApproval: formRequireApproval.value,
    });
    showForm.value = false;
    invPage.value = 1;
    activeTab.value = "list";
    await loadInvitations();
  } catch (err) {
    formError.value = errorMessage(err);
  } finally {
    formLoading.value = false;
  }
}

// ---- 撤回二次确认 ----
const revokeTarget = ref<Invitation | null>(null);
const revokeLoading = ref<boolean>(false);
const revokeError = ref<string>("");

function openRevoke(inv: Invitation): void {
  revokeTarget.value = inv;
  revokeError.value = "";
  revokeLoading.value = false;
}

function closeRevoke(): void {
  if (revokeLoading.value) return;
  revokeTarget.value = null;
  revokeError.value = "";
}

async function confirmRevoke(): Promise<void> {
  const target = revokeTarget.value;
  if (!target || revokeLoading.value) return;
  revokeLoading.value = true;
  revokeError.value = "";
  try {
    await revokeInvitation(target.code);
    revokeTarget.value = null;
    await loadInvitations();
  } catch (err) {
    // 被拒 → 原样展示服务端 msg，弹窗保持打开
    revokeError.value = errorMessage(err);
  } finally {
    revokeLoading.value = false;
  }
}

// ---- 批量撤回（行多选 → 二次确认 → batch_revoke）----
/** 二次确认弹窗开关 */
const showBatchRevoke = ref<boolean>(false);
/** 本次待撤回的 code 快照（确认后即使选中集被并发改变也按快照提交） */
const batchCodes = ref<string[]>([]);
const batchLoading = ref<boolean>(false);
const batchError = ref<string>("");

function openBatchRevoke(): void {
  if (selectedCodes.value.length === 0) return;
  batchCodes.value = [...selectedCodes.value];
  batchError.value = "";
  batchLoading.value = false;
  showBatchRevoke.value = true;
}

function closeBatchRevoke(): void {
  if (batchLoading.value) return;
  showBatchRevoke.value = false;
  batchCodes.value = [];
  batchError.value = "";
}

/**
 * 确认批量撤回：成功 → 关弹窗 + **清空选中** + 重拉；
 * 被拒 / 部分失败 → 原样展示服务端 msg（`invitation-batch-revoke-error`），弹窗保持打开、
 * 选中不清空 —— 不把未撤回的邀请谎报成「已撤回」，用户可重试或取消。
 */
async function confirmBatchRevoke(): Promise<void> {
  if (batchLoading.value || batchCodes.value.length === 0) return;
  batchLoading.value = true;
  batchError.value = "";
  const codes = [...batchCodes.value];
  try {
    await batchRevokeInvitations(codes);
    showBatchRevoke.value = false;
    batchCodes.value = [];
    selectedCodes.value = [];
    await loadInvitations();
  } catch (err) {
    batchError.value = errorMessage(err);
  } finally {
    batchLoading.value = false;
  }
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const formDialogRef = ref<HTMLElement | null>(null);
const revokeDialogRef = ref<HTMLElement | null>(null);
const batchDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(formDialogRef, { open: showForm, onClose: closeForm });
useDialogA11y(revokeDialogRef, {
  open: computed(() => revokeTarget.value !== null),
  onClose: closeRevoke,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误撤回
  initialFocus: "[data-dialog-cancel]",
});
useDialogA11y(batchDialogRef, {
  open: showBatchRevoke,
  onClose: closeBatchRevoke,
  initialFocus: "[data-dialog-cancel]",
});

// ---- 展示辅助 ----
function rolesText(roleCodes: string[]): string {
  return roleCodes.length > 0 ? roleCodes.join(", ") : "—";
}

function usageText(inv: Invitation): string {
  return `${inv.usedCount}/${inv.maxUses}`;
}

function applicantText(r: JoinRequest): string {
  const name = r.nickname || r.username;
  return name !== "" ? name : "—";
}
</script>

<template>
  <section class="page-invitation-list" :aria-busy="invLoading || reqLoading">
    <header class="page-head">
      <!-- 页面主标题用 h1（原为 h2，导致整页没有 h1）；.page-title 已显式定义 20px/600/margin:0，视觉不变 -->
      <h1 class="page-title">邀请管理</h1>
      <button
        v-if="can(IAM_INVITATION.ADD)"
        type="button"
        class="btn btn--primary"
        data-testid="invitation-create"
        @click="openCreate"
      >
        创建邀请
      </button>
    </header>

    <!-- 视图切换：邀请列表 / 加入申请 -->
    <div class="tabs" role="tablist" aria-label="邀请视图">
      <button
        type="button"
        class="btn btn--tab"
        role="tab"
        :aria-selected="activeTab === 'list'"
        data-testid="invitation-tab-list"
        @click="switchTab('list')"
      >
        邀请列表
      </button>
      <button
        v-if="canViewRequests"
        type="button"
        class="btn btn--tab"
        role="tab"
        :aria-selected="activeTab === 'requests'"
        data-testid="invitation-tab-requests"
        @click="switchTab('requests')"
      >
        加入申请
      </button>
    </div>

    <!-- ===== 邀请列表 ===== -->
    <div v-if="activeTab === 'list'" class="table-wrap" data-testid="invitation-panel-list">
      <!-- 批量撤回工具条：需 BATCH_DELETE；无选中 / 错误态禁用或不渲染 -->
      <div
        v-if="canBatchRevoke && !invError && invitations.length > 0"
        class="table-toolbar"
      >
        <span class="table-toolbar__info">已选 {{ selectedCodes.length }} 条</span>
        <button
          type="button"
          class="btn btn--danger"
          data-testid="invitation-batch-revoke"
          :disabled="selectedCodes.length === 0 || batchLoading"
          @click="openBatchRevoke"
        >
          批量撤回
        </button>
      </div>

      <div v-if="invError" class="state-error" role="alert">
        <span>{{ invError }}</span>
        <button type="button" class="btn btn--text" @click="loadInvitations">
          重试
        </button>
      </div>

      <table v-else-if="invitations.length > 0" class="data-table">
        <thead>
          <tr>
            <th v-if="canBatchRevoke" class="col-select">
              <input
                v-model="allSelected"
                type="checkbox"
                data-testid="invitation-select-all"
                aria-label="全选本页邀请"
              />
            </th>
            <th>邀请码</th>
            <th>租户</th>
            <th>角色</th>
            <th>用量</th>
            <th>过期时间</th>
            <th>需审批</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="inv in invitations"
            :key="inv.code"
            data-testid="invitation-row"
            :data-invitation-code="inv.code"
          >
            <td v-if="canBatchRevoke" class="col-select">
              <input
                v-model="selectedCodes"
                type="checkbox"
                data-testid="invitation-select"
                :value="inv.code"
                :aria-label="`选择邀请 ${inv.code}`"
              />
            </td>
            <td class="mono">{{ inv.code }}</td>
            <td>{{ inv.tenantName || "—" }}</td>
            <td class="muted">{{ rolesText(inv.roleCodes) }}</td>
            <td class="mono">{{ usageText(inv) }}</td>
            <td class="muted">{{ formatEpochMs(inv.expireAt) }}</td>
            <td>{{ inv.requireApproval ? "是" : "否" }}</td>
            <td>
              <button
                v-if="can(IAM_INVITATION.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="invitation-revoke"
                @click="openRevoke(inv)"
              >
                撤回
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-else-if="invLoading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>

      <div v-else class="state-empty" data-testid="invitation-empty">
        <p class="state-empty__text">暂无邀请</p>
      </div>
    </div>

    <!-- ===== 加入申请（只读；缺 VIEW_REQUESTS 时整个页签与面板都不渲染）===== -->
    <div
      v-else-if="canViewRequests"
      class="table-wrap"
      data-testid="invitation-panel-requests"
    >
      <div v-if="reqError" class="state-error" role="alert">
        <span>{{ reqError }}</span>
        <button type="button" class="btn btn--text" @click="loadRequests">
          重试
        </button>
      </div>

      <table v-else-if="requests.length > 0" class="data-table">
        <thead>
          <tr>
            <th>申请人</th>
            <th>邀请码</th>
            <th>角色</th>
            <th>申请时间</th>
            <!-- 处理能力（IAM_INVITATION.HANDLE_REQUEST）：缺码时整列不渲染，也不会发请求 -->
            <th v-if="canHandleRequest">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in requests"
            :key="r.id"
            data-testid="join-request-row"
            :data-request-id="r.id"
          >
            <td>
              {{ applicantText(r) }}
              <span v-if="r.username" class="muted mono">{{ r.username }}</span>
            </td>
            <td class="mono">{{ r.invitationCode || "—" }}</td>
            <td class="muted">{{ rolesText(r.roleCodes) }}</td>
            <td class="muted">{{ formatEpochMs(r.ctime) }}</td>
            <td v-if="canHandleRequest">
              <button
                type="button"
                class="btn btn--text"
                data-testid="join-request-approve"
                :disabled="handlingId === r.id"
                @click="handleRequest(r, true)"
              >
                通过
              </button>
              <button
                type="button"
                class="btn btn--text btn--danger"
                data-testid="join-request-reject"
                :disabled="handlingId === r.id"
                @click="handleRequest(r, false)"
              >
                拒绝
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 处理失败：展示 eiam 业务文案原文（可处置信息，不吞掉） -->
      <p
        v-if="handleError"
        class="state-error"
        role="alert"
        data-testid="join-request-handle-error"
      >
        {{ handleError }}
      </p>

      <div v-else-if="reqLoading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>

      <div v-else class="state-empty" data-testid="join-request-empty">
        <p class="state-empty__text">暂无加入申请</p>
      </div>
    </div>

    <!-- 分页（20 / 50 / 100）—— 两个页签各自独立 -->
    <nav
      v-if="activeTab === 'list' && invTotal > 0"
      class="pagination"
      aria-label="邀请列表分页"
    >
      <button
        type="button"
        class="btn btn--text"
        :disabled="invPage <= 1"
        data-testid="invitation-page-prev"
        @click="changeInvPage(invPage - 1)"
      >
        上一页
      </button>
      <span class="pagination__info"
        >第 {{ invPage }} / {{ invTotalPages }} 页（共
        {{ invTotal }} 条）</span
      >
      <button
        type="button"
        class="btn btn--text"
        :disabled="invPage >= invTotalPages"
        data-testid="invitation-page-next"
        @click="changeInvPage(invPage + 1)"
      >
        下一页
      </button>
      <select
        :value="invPageSize"
        class="input pagination__size"
        aria-label="每页条数"
        data-testid="invitation-page-size"
        @change="changeInvPageSize"
      >
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
    </nav>

    <nav
      v-if="activeTab === 'requests' && reqTotal > 0"
      class="pagination"
      aria-label="加入申请分页"
    >
      <button
        type="button"
        class="btn btn--text"
        :disabled="reqPage <= 1"
        data-testid="join-request-page-prev"
        @click="changeReqPage(reqPage - 1)"
      >
        上一页
      </button>
      <span class="pagination__info"
        >第 {{ reqPage }} / {{ reqTotalPages }} 页（共
        {{ reqTotal }} 条）</span
      >
      <button
        type="button"
        class="btn btn--text"
        :disabled="reqPage >= reqTotalPages"
        data-testid="join-request-page-next"
        @click="changeReqPage(reqPage + 1)"
      >
        下一页
      </button>
      <select
        :value="reqPageSize"
        class="input pagination__size"
        aria-label="每页条数"
        data-testid="join-request-page-size"
        @change="changeReqPageSize"
      >
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
    </nav>

    <!-- 创建邀请 Dialog -->
    <div v-if="showForm" class="dialog-overlay" @click.self="closeForm">
      <div
        ref="formDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="创建邀请"
        data-testid="invitation-form"
      >
        <header class="dialog__head">
          <h3>创建邀请</h3>
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
              >最大使用次数<span class="required">*</span></span
            >
            <input
              v-model="formMaxUses"
              type="number"
              class="input"
              min="1"
              step="1"
              data-testid="invitation-form-max-uses"
              :aria-invalid="!!formFieldErrors.maxUses"
              :aria-describedby="
                formFieldErrors.maxUses ? 'invitation-max-uses-error' : undefined
              "
            />
            <span
              v-if="formFieldErrors.maxUses"
              id="invitation-max-uses-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.maxUses }}</span
            >
            <span class="muted">整数 ≥1（默认 1）</span>
          </label>
          <label class="field">
            <span class="field__label"
              >有效天数<span class="required">*</span></span
            >
            <input
              v-model="formExpiryDays"
              type="number"
              class="input"
              min="1"
              max="365"
              step="1"
              data-testid="invitation-form-expiry-days"
              :aria-invalid="!!formFieldErrors.expiryDays"
              :aria-describedby="
                formFieldErrors.expiryDays
                  ? 'invitation-expiry-days-error'
                  : undefined
              "
            />
            <span
              v-if="formFieldErrors.expiryDays"
              id="invitation-expiry-days-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.expiryDays }}</span
            >
            <span class="muted">1–365 天（默认 7）</span>
          </label>
          <fieldset class="roles-field" data-testid="invitation-form-roles">
            <legend class="field__label">角色（可多选，可不选）</legend>
            <p v-if="rolesLoading" class="muted">角色加载中…</p>
            <p v-else-if="rolesError" class="field__error" role="alert">
              {{ rolesError }}
            </p>
            <p v-else-if="roleOptions.length === 0" class="muted">
              暂无可选角色
            </p>
            <div v-else class="role-options">
              <label
                v-for="role in roleOptions"
                :key="role.code"
                class="field field--checkbox"
              >
                <input
                  v-model="formRoleCodes"
                  type="checkbox"
                  data-testid="invitation-form-role-option"
                  :value="role.code"
                />
                <span class="field__label">{{ role.name }}</span>
                <span class="muted mono">{{ role.code }}</span>
              </label>
            </div>
          </fieldset>
          <label class="field field--checkbox">
            <input
              v-model="formRequireApproval"
              type="checkbox"
              data-testid="invitation-form-require-approval"
            />
            <span class="field__label">加入需审批</span>
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
              data-testid="invitation-form-submit"
            >
              {{ formLoading ? "提交中…" : "创建" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 撤回二次确认 Dialog -->
    <div v-if="revokeTarget" class="dialog-overlay" @click.self="closeRevoke">
      <div
        ref="revokeDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="invitation-revoke-desc"
        aria-label="撤回邀请"
        data-testid="invitation-revoke-dialog"
      >
        <header class="dialog__head">
          <h3>撤回邀请</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeRevoke"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p id="invitation-revoke-desc">
            确认撤回邀请码
            <strong class="mono">{{ revokeTarget.code }}</strong>？撤回后该邀请码立即失效。
          </p>
          <!-- 服务端拒绝原因原样展示（eiam msg，不得改写） -->
          <p
            v-if="revokeError"
            class="delete-blocked"
            role="alert"
            data-testid="invitation-revoke-error"
          >
            {{ revokeError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            :disabled="revokeLoading"
            data-testid="invitation-revoke-cancel"
            @click="closeRevoke"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="revokeLoading"
            data-testid="invitation-revoke-confirm"
            @click="confirmRevoke"
          >
            {{ revokeLoading ? "撤回中…" : "确认撤回" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 批量撤回二次确认 Dialog -->
    <div
      v-if="showBatchRevoke"
      class="dialog-overlay"
      @click.self="closeBatchRevoke"
    >
      <div
        ref="batchDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="invitation-batch-revoke-desc"
        aria-label="批量撤回邀请"
        data-testid="invitation-batch-revoke-dialog"
      >
        <header class="dialog__head">
          <h3>批量撤回</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeBatchRevoke"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p id="invitation-batch-revoke-desc">
            确认撤回选中的
            <strong>{{ batchCodes.length }}</strong>
            条邀请？撤回后这些邀请码立即失效。
          </p>
          <ul class="code-list mono">
            <li v-for="code in batchCodes" :key="code">{{ code }}</li>
          </ul>
          <!-- 服务端拒绝原因原样展示（含部分失败，eiam msg，不得改写） -->
          <p
            v-if="batchError"
            class="delete-blocked"
            role="alert"
            data-testid="invitation-batch-revoke-error"
          >
            {{ batchError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            :disabled="batchLoading"
            data-testid="invitation-batch-revoke-cancel"
            @click="closeBatchRevoke"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="batchLoading"
            data-testid="invitation-batch-revoke-confirm"
            @click="confirmBatchRevoke"
          >
            {{ batchLoading ? "撤回中…" : "确认撤回" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-invitation-list {
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

.tabs {
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
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
  &--tab {
    background: transparent;
    color: var(--text-secondary);
    border-radius: 8px 8px 0 0;
    padding: 8px 16px;
    height: auto;
  }
  &--tab[aria-selected="true"] {
    color: var(--accent-blue);
    border-bottom: 2px solid var(--accent-blue);
    font-weight: 600;
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

.table-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);

  &__info {
    color: var(--text-secondary);
    font-size: 13px;
  }
}

/** 多选列：窄列 + 不换行（复选框列无需等宽字体） */
.col-select {
  width: 40px;
  white-space: nowrap;
  text-align: center;
  font-family: inherit;

  input {
    cursor: pointer;
  }
}

/** 角色多选容器：fieldset 边框 + 纵向滚动列表（候选可能很多，限高避免撑爆弹窗） */
.roles-field {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 8px 12px 10px;
  margin: 0;

  legend {
    padding: 0 4px;
    font-size: 13px;
    color: var(--text-regular);
  }
}

.role-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  padding: 4px 2px;
}

.code-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-regular);
  font-size: 12px;
  max-height: 120px;
  overflow-y: auto;
}

.data-table {
  width: 100%;
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

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
  margin-left: 4px;
}

.state-empty,
.state-error {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

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

  &--checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
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
