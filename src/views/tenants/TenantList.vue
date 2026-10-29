<script setup lang="ts">
/**
 * 租户管理列表页（UF-6，task 4.4）。
 *
 * 参照：ui-design UF-6（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces
 * A/C 档 + parity-checklist §3.2（G-4 降级）。
 *
 * 布局：页面头（标题 + 新增）→ 表格 → 分页。仅平台管理员可见（route meta.requiresAdmin）。
 * - 列：租户名 / 状态（启用/禁用 StatusBadge）/ 活跃会话数 / 操作
 * - 分页边界 E7（page 超界回落 / 末页空回退 / 切过滤重置 1）由 tenantList store 承载
 * - 文案出口用 CopyContractText（2.5）；状态徽章用 StatusBadge（4.1）
 *
 * 禁用前置 G-4 降级（Hard Rule + tech-design Data Models 注释 + parity §3.2 line 324）：
 * - eiam 无会话计数端点 → 活跃会话数列无 list 数据源，降级展示 '—'；
 * - 禁用直接提交 update(status=disable)，被 eiam 拒绝时从拒绝消息提取 active_session_count，
 *   渲染 tenant.disable_blocked 契约（{n}=active_session_count，与列同源）。
 *
 * 新增/编辑（AC-4）：租户名 1–64 字符 + 全局唯一（冲突提示 validation.name_exists）。
 * 删除：依赖删除由 eiam 服务端拒绝（msg 透传）。
 */
import { computed, onMounted, ref } from "vue";
import { useTenantListStore } from "@/stores/tenantList";
import { ApiError } from "@/api/types";
import type { Tenant } from "@/api/types";
import type { TenantGovernancePayload } from "@/api/tenants";
import { contractText, formatContractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_TENANT } from "@/config/permission-codes";
import { useUserStore } from "@/stores/user";
import TenantMembersDrawer from "./TenantMembersDrawer.vue";
import TenantDetailDrawer from "./TenantDetailDrawer.vue";
import {
  OVER_QUOTA_TEXT,
  governanceSegments,
  governanceSummary,
} from "./usage";

const store = useTenantListStore();
const userStore = useUserStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径；
// 页面级由 requiresAdmin + iam:tenant:view 双闸，按钮级再细分 add/edit/delete）
const { can } = useCan();

// ---- 搜索（切过滤重置 page=1，E7）----
const keywordInput = ref("");

function applySearch(): void {
  store.setKeyword(keywordInput.value.trim());
  void store.fetch();
}

/**
 * 状态筛选（feat-tenant-status-filter 契约 §4.3）：原生 select，change 即生效。
 * 0=全部 / 1=启用 / 2=禁用；setStatus 内部重置 page=1（与 keyword 同口径）。
 * 后端未提供 status 参数时：0 不传该键，选择「全部」不会报错（优雅降级）。
 */
function changeStatus(event: Event): void {
  const raw = Number((event.target as HTMLSelectElement).value);
  store.setStatus(Number.isFinite(raw) ? raw : 0);
  void store.fetch();
}

function resetSearch(): void {
  keywordInput.value = "";
  store.setKeyword("");
  // 重置同时清空状态筛选（契约 §4.3：回到全部 + 第 1 页）
  store.setStatus(0);
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

// ---- 活跃会话数列（G-4：无 list 数据源，降级 '—'）----
const sessionPlaceholder = "—";

// ---- 新增/编辑 Dialog（AC-4）----
const showForm = ref(false);
const formMode = ref<"create" | "edit">("create");
const formLoading = ref(false);
const formError = ref<string>("");
const formFieldErrors = ref<Record<string, string>>({});
const formId = ref<number>(0);
const formName = ref("");
const formCode = ref("");
const formDomain = ref("");
const formStatus = ref<"active" | "disable">("active");

// ---- 三类治理配置（tenant-management spec 需求 2/6/7）----
// 语义（eiam vo.go 注释）：配额 0 或负数 = 不限制；白名单空 = 允许全部厂商；
// 开关空表 = 未启用差异化开关。UI 只提供「设置/取消设置」，不在此处做强制拦截
// （R6 的操作侧拦截属 eiam 后端 feature，前端不臆造）。
const formMaxAccounts = ref<number>(0);
const formMaxUsers = ref<number>(0);
const formMaxUserGroups = ref<number>(0);
const formVendors = ref<string[]>([]);
/** 功能开关行编辑（eiam 为自由 map[string]bool，无预定义键集，故用键 + 布尔行） */
const formSwitches = ref<Array<{ key: string; on: boolean }>>([]);

/** 云厂商候选（与平台 CloudProvider 词表同口径：e-cam-web constants.ts / Workbench PROVIDER_LABELS） */
const VENDOR_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "aliyun", label: "阿里云" },
  { key: "aws", label: "AWS" },
  { key: "azure", label: "Microsoft Azure" },
  { key: "tencent", label: "腾讯云" },
  { key: "huawei", label: "华为云" },
  { key: "volcano", label: "火山引擎" },
];

/** 输入框数值 → 配额 int（空/NaN/负数一律归 0 = 不限制） */
function toQuota(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

/** 开关行 → map（去空键、trim、后者覆盖前者，避免重复键歧义） */
function switchesToMap(rows: Array<{ key: string; on: boolean }>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (k) out[k] = row.on;
  }
  return out;
}

/** map → 开关行（保持稳定顺序：键名字典序，回显可预期） */
function mapToSwitches(map: Record<string, boolean> | undefined): Array<{ key: string; on: boolean }> {
  return Object.keys(map ?? {})
    .sort()
    .map((k) => ({ key: k, on: map?.[k] === true }));
}

function addSwitch(): void {
  formSwitches.value.push({ key: "", on: true });
}

function removeSwitch(index: number): void {
  formSwitches.value.splice(index, 1);
}

/** 表单 → 治理配置载荷（create/update 共用） */
function governancePayload(): TenantGovernancePayload {
  return {
    maxAccounts: toQuota(formMaxAccounts.value),
    maxUsers: toQuota(formMaxUsers.value),
    maxUserGroups: toQuota(formMaxUserGroups.value),
    featureSwitch: switchesToMap(formSwitches.value),
    allowedVendors: [...formVendors.value],
  };
}

const TENANT_NAME_MAX = 64;
const TENANT_CODE_MAX = 32;

function validateName(value: string): string | null {
  if (!value) return "请输入租户名";
  if (value.length < 1 || value.length > TENANT_NAME_MAX)
    return `租户名长度 1–${TENANT_NAME_MAX} 字符`;
  return null;
}

function validateCode(value: string): string | null {
  if (!value) return "请输入租户 code";
  if (value.length > TENANT_CODE_MAX) return `code 长度 ≤${TENANT_CODE_MAX}`;
  return null;
}

/** 治理配置区重置（新增态：全为零值 = 无约束） */
function resetGovernance(): void {
  formMaxAccounts.value = 0;
  formMaxUsers.value = 0;
  formMaxUserGroups.value = 0;
  formVendors.value = [];
  formSwitches.value = [];
}

function openCreate(): void {
  formMode.value = "create";
  formId.value = 0;
  formName.value = "";
  formCode.value = "";
  formDomain.value = "";
  formStatus.value = "active";
  resetGovernance();
  formError.value = "";
  formFieldErrors.value = {};
  store.clearDisableBlocked();
  showForm.value = true;
}

function openEdit(t: Tenant): void {
  formMode.value = "edit";
  formId.value = t.id;
  formName.value = t.name;
  formCode.value = t.code;
  formDomain.value = t.domain;
  formStatus.value = (t.status ?? "active") === "disable" ? "disable" : "active";
  // 回显现有治理配置（eiam 已出参；缺省按无约束处理）
  formMaxAccounts.value = t.maxAccounts ?? 0;
  formMaxUsers.value = t.maxUsers ?? 0;
  formMaxUserGroups.value = t.maxUserGroups ?? 0;
  formVendors.value = [...(t.allowedVendors ?? [])];
  formSwitches.value = mapToSwitches(t.featureSwitch);
  formError.value = "";
  formFieldErrors.value = {};
  store.clearDisableBlocked();
  showForm.value = true;
}

async function submitForm(): Promise<void> {
  formError.value = "";
  formFieldErrors.value = {};
  const nameErr = validateName(formName.value);
  if (nameErr) {
    formFieldErrors.value = { name: nameErr };
    return;
  }
  const codeErr = validateCode(formCode.value);
  if (codeErr) {
    formFieldErrors.value = { code: codeErr };
    return;
  }
  formLoading.value = true;
  try {
    if (formMode.value === "create") {
      const id = await store.create({
        name: formName.value,
        code: formCode.value,
        domain: formDomain.value || undefined,
        ...governancePayload(),
      });
      if (id === null) {
        formError.value = store.error ?? "新增租户失败";
        return;
      }
    } else {
      const ok = await store.update({
        id: formId.value,
        name: formName.value,
        code: formCode.value,
        domain: formDomain.value || undefined,
        status: formStatus.value,
        ...governancePayload(),
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

function closeForm(): void {
  showForm.value = false;
}

// ---- 禁用确认（AC-3，G-4 降级）----
const disableTarget = ref<{ id: number; name: string } | null>(null);
const disableLoading = ref(false);

function openDisable(id: number, name: string): void {
  disableTarget.value = { id, name };
  store.clearDisableBlocked();
  disableLoading.value = false;
}

async function confirmDisable(): Promise<void> {
  if (!disableTarget.value) return;
  disableLoading.value = true;
  try {
    const ok = await store.disable(disableTarget.value.id);
    if (ok) {
      disableTarget.value = null;
    }
    // 失败：disableBlocked 已由 store 写入，模板渲染 tenant.disable_blocked
  } finally {
    disableLoading.value = false;
  }
}

function closeDisable(): void {
  disableTarget.value = null;
  store.clearDisableBlocked();
}

/** 禁用被拒文案：tenant.disable_blocked 契约 + {n}=活跃会话数（提取到时），否则 eiam 原文 */
const disableBlockedText = computed(() => {
  const blocked = store.disableBlocked;
  if (!blocked) return "";
  const template = contractText("tenant.disable_blocked");
  if (template && blocked.count > 0) {
    return formatContractText(template, { n: blocked.count });
  }
  // 提取不到计数 → 渲染 eiam 拒绝原文（不伪造计数）
  return blocked.message;
});

// ---- 启用（无前置校验，直接提交）----
async function enableTenant(id: number): Promise<void> {
  await store.enable(id);
}

// ---- 设为默认登录租户（当前登录用户偏好，下次登录直接落入）----
const settingDefault = ref(false);

/** 当前行是否为当前用户的默认登录租户（据此渲染标记 + 按钮置灰） */
function isDefaultTenant(id: number): boolean {
  return userStore.defaultTenantId === id && id > 0;
}

async function setDefaultTenant(id: number): Promise<void> {
  if (settingDefault.value || isDefaultTenant(id)) return;
  settingDefault.value = true;
  try {
    await store.setDefault(id);
  } finally {
    settingDefault.value = false;
  }
}

// ---- 成员抽屉（feat-tenant-members-ui 契约 §2.3）----
// 行内「成员」按钮仅对持有 iam:tenant:view_members 的管理员渲染；
// 打开后抽屉自拉成员列表（api 层固定注入 X-Active-Tenant-ID）。
const membersTenant = ref<{ id: number; name: string } | null>(null);

function openMembers(t: Tenant): void {
  membersTenant.value = { id: t.id, name: t.name };
}

function closeMembers(): void {
  membersTenant.value = null;
}

/** 成员移除成功 → 刷新租户列表（用量列 userCount 随之更新） */
function onMembersRemoved(): void {
  void store.fetch();
}

/** 成员添加成功 → 同样刷新租户列表（用量列 +1，与移除同口径；feat-tenant-assign-member §2.3） */
function onMembersAssigned(): void {
  void store.fetch();
}

// ---- 详情抽屉（feat-tenant-detail-ui 契约 §2.4）----
// 行内「详情」按钮仅对持有 iam:tenant:get 的管理员渲染；打开后抽屉自拉详情（只读）。
const detailTenant = ref<{ id: number; name: string } | null>(null);

function openDetail(t: Tenant): void {
  detailTenant.value = { id: t.id, name: t.name };
}

function closeDetail(): void {
  detailTenant.value = null;
}

// ---- 删除确认（依赖删除由 eiam 拒绝，msg 透传）----
// feat-tenant-delete-guard（需求 3 AC4/AC5）：eiam 现在会校验从属资源并拒绝删除。
// 打开弹窗时用列表已有计数提前告知并禁用确认，避免管理员点了才被拒。
const deleteTarget = ref<{
  id: number;
  name: string;
  userCount?: number;
  userGroupCount?: number;
} | null>(null);
const deleteLoading = ref(false);
const deleteBlocked = ref<string>("");

/**
 * 前置提示文案：仅当**已知**存在从属资源时返回提示（undefined = 统计不可用）。
 *
 * 为什么不把 undefined 当 0：统计不可用时前端无法判断，若据此禁用按钮会造成"永远删不掉"。
 * 该情况交给服务端 fail-closed 兜底（服务端拒绝 → deleteBlocked 渲染原文）。
 */
const deleteResourceHint = computed(() => {
  const t = deleteTarget.value;
  if (!t) return "";
  const u = t.userCount;
  const g = t.userGroupCount;
  if (typeof u !== "number" && typeof g !== "number") return "";
  const parts: string[] = [];
  if (typeof u === "number" && u > 0) parts.push(`${u} 个用户`);
  if (typeof g === "number" && g > 0) parts.push(`${g} 个用户组`);
  if (parts.length === 0) return "";
  return `该租户仍有 ${parts.join("、")}，需先移除后才能删除。`;
});

function openDelete(t: Tenant): void {
  deleteTarget.value = {
    id: t.id,
    name: t.name,
    userCount: t.userCount,
    userGroupCount: t.userGroupCount,
  };
  deleteBlocked.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  if (deleteBlocked.value) return;
  // 已知有从属资源时不发请求（服务端同样会拒，省一次往返）
  if (deleteResourceHint.value) return;
  deleteLoading.value = true;
  try {
    const ok = await store.remove(deleteTarget.value.id);
    if (ok) {
      deleteTarget.value = null;
    }
  } catch (err) {
    deleteBlocked.value = errorMessage(err);
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteBlocked.value = "";
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const formDialogRef = ref<HTMLElement | null>(null);
const disableDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(formDialogRef, { open: showForm, onClose: closeForm });
useDialogA11y(disableDialogRef, {
  open: computed(() => disableTarget.value !== null),
  onClose: closeDisable,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误禁用
  initialFocus: "[data-dialog-cancel]",
});
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  initialFocus: "[data-dialog-cancel]",
});

// ---- 状态迁移渲染辅助 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);
/** 是否存在生效中的筛选（关键词或状态；空态区分「筛选无结果」与「本来无数据」用） */
const hasActiveFilters = computed(
  () => store.keyword !== "" || store.status !== 0,
);
</script>

<template>
  <section class="page-tenant-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">租户管理</h2>
      <button
        v-if="can(IAM_TENANT.ADD)"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增租户
      </button>
    </header>

    <!-- 搜索栏：关键词 + 状态筛选（原生元素风格，不引入组件库） -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="搜索租户名"
        data-testid="tenant-search"
        @keyup.enter="applySearch"
      />
      <!-- 状态筛选（契约 §4.3）：0=全部 / 1=启用 / 2=禁用；change 即重置 page=1 并重查 -->
      <select
        class="input toolbar__status"
        data-testid="tenant-status-filter"
        aria-label="按状态筛选"
        :value="store.status"
        @change="changeStatus"
      >
        <option :value="0">全部</option>
        <option :value="1">启用</option>
        <option :value="2">禁用</option>
      </select>
      <button type="button" class="btn btn--ghost" @click="applySearch">
        搜索
      </button>
      <button type="button" class="btn btn--text" @click="resetSearch">
        重置
      </button>
    </div>

    <!-- 表格容器：错误 / 空 / 加载 三态都在容器内替换内容，
         避免错误态下方残留一个空表格框（原实现错误文案在框外，框内无内容） -->
    <div class="table-wrap">
      <!-- 错误态（重试）：说明在上、动作在下一行，避免「…请稍后重试」与「重试」连读 -->
      <div v-if="isError" class="state-error" role="alert">
        <CopyContractText code="eiam.unavailable" tag="span" />
        <button type="button" class="btn btn--text" @click="reload">重试</button>
      </div>

      <table v-else-if="store.items.length > 0" class="data-table">
        <thead>
          <tr>
            <th>租户名</th>
            <th>状态</th>
            <th>治理配置</th>
            <th>活跃会话数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in store.items" :key="t.id">
            <td>
              {{ t.name }}
              <span
                v-if="isDefaultTenant(t.id)"
                class="default-badge"
                data-testid="default-tenant-badge"
                >默认</span
              >
            </td>
            <td>
              <StatusBadge :status="t.status ?? 'unknown'" size="sm" />
            </td>
            <!--
              治理配置摘要（配额 / 用量·上限 / 白名单 / 开关；tenant-management 需求 2/6/7
              + feat-tenant-usage-stats 需求 5）：用量段超限时加 .is-over + 「超出配额」标记。
              整行纯文本见 ./usage 的 governanceSummary（此处作 title 兜底可读全文）。
            -->
            <td
              class="muted governance-cell"
              data-testid="tenant-governance"
              :title="governanceSummary(t)"
            >
              <template v-for="(seg, i) in governanceSegments(t)" :key="seg.key">
                <span v-if="i > 0" class="governance-cell__sep"> · </span>
                <span
                  class="governance-cell__seg"
                  :class="{ 'is-over': seg.over }"
                  :data-testid="`tenant-usage-${seg.key}`"
                  >{{ seg.text
                  }}<template v-if="seg.over"
                    >&nbsp;<span class="governance-cell__over">{{
                      OVER_QUOTA_TEXT
                    }}</span></template
                  ></span
                >
              </template>
            </td>
            <!-- G-4：无 list 数据源，活跃会话数列降级 '—'；计数仅在禁用被拒时从拒绝消息提取展示 -->
            <td class="muted">{{ sessionPlaceholder }}</td>
            <td>
              <!-- 详情入口（只读；权限 iam:tenant:get，无权限不渲染） -->
              <button
                v-if="can(IAM_TENANT.GET)"
                type="button"
                class="btn btn--text"
                data-testid="tenant-detail"
                @click="openDetail(t)"
              >
                详情
              </button>
              <button
                v-if="can(IAM_TENANT.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="edit-tenant"
                @click="openEdit(t)"
              >
                编辑
              </button>
              <button
                v-if="
                  can(IAM_TENANT.EDIT) && (t.status ?? 'unknown') === 'active'
                "
                type="button"
                class="btn btn--text btn--danger"
                data-testid="disable-tenant"
                @click="openDisable(t.id, t.name)"
              >
                禁用
              </button>
              <button
                v-else-if="can(IAM_TENANT.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="enable-tenant"
                @click="enableTenant(t.id)"
              >
                启用
              </button>
              <button
                v-if="can(IAM_TENANT.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="delete-tenant"
                @click="openDelete(t)"
              >
                删除
              </button>
              <!-- 成员入口（权限 iam:tenant:view_members；无权限不渲染，不靠点击后报错） -->
              <button
                v-if="can(IAM_TENANT.VIEW_MEMBERS)"
                type="button"
                class="btn btn--text"
                data-testid="tenant-members"
                @click="openMembers(t)"
              >
                成员
              </button>
              <button
                v-if="!isDefaultTenant(t.id)"
                type="button"
                class="btn btn--text"
                :disabled="settingDefault"
                data-testid="set-default-tenant"
                @click="setDefaultTenant(t.id)"
              >
                {{ settingDefault ? "设置中…" : "设为默认" }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态：区分「筛选无结果」与「本来就没有数据」，前者给一键清除筛选出口 -->
      <div v-else-if="isEmpty" class="state-empty">
        <template v-if="hasActiveFilters">
          <p class="state-empty__text">没有匹配的租户，试试更换关键词或状态筛选</p>
          <button
            type="button"
            class="btn btn--text"
            data-testid="clear-filters"
            @click="resetSearch"
          >
            清除筛选
          </button>
        </template>
        <p v-else class="state-empty__text">暂无租户数据</p>
      </div>

      <!-- 加载骨架 -->
      <div v-else-if="store.loading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>
    </div>

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

    <!-- 新增/编辑 Dialog（AC-4）-->
    <div v-if="showForm" class="dialog-overlay" @click.self="closeForm">
      <div
        ref="formDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="formMode === 'create' ? '新增租户' : '编辑租户'"
      >
        <header class="dialog__head">
          <h3>{{ formMode === "create" ? "新增租户" : "编辑租户" }}</h3>
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
            <CopyContractText :code="formError" tag="span" />
          </p>
          <label class="field">
            <span class="field__label"
              >租户名<span class="required">*</span></span
            >
            <input
              v-model="formName"
              type="text"
              class="input"
              data-testid="form-name"
              :maxlength="TENANT_NAME_MAX"
              :aria-describedby="
                formFieldErrors.name ? 'form-name-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.name"
            />
            <span
              v-if="formFieldErrors.name"
              id="form-name-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.name }}</span
            >
          </label>
          <label class="field">
            <span class="field__label"
              >租户 Code<span class="required">*</span></span
            >
            <input
              v-model="formCode"
              type="text"
              class="input"
              data-testid="form-code"
              :maxlength="TENANT_CODE_MAX"
              :aria-describedby="
                formFieldErrors.code ? 'form-code-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.code"
            />
            <span
              v-if="formFieldErrors.code"
              id="form-code-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.code }}</span
            >
            <span class="muted">eiam 必填，max {{ TENANT_CODE_MAX }} 字符</span>
          </label>
          <label class="field">
            <span class="field__label">域名</span>
            <input v-model="formDomain" type="text" class="input" />
          </label>
          <label v-if="formMode === 'edit'" class="field">
            <span class="field__label">状态</span>
            <select v-model="formStatus" class="input">
              <option value="active">启用</option>
              <option value="disable">禁用</option>
            </select>
          </label>

          <!-- 三类治理配置（tenant-management spec 需求 2 配额 / 需求 7 云厂商 / 需求 6 功能开关） -->
          <fieldset class="fieldset" data-testid="governance-section">
            <legend class="fieldset__legend">治理配置</legend>
            <p class="muted fieldset__hint">
              配额留空或 0 = 不限制；白名单不勾选 = 允许全部云厂商；开关留空 =
              不启用差异化开关。强制拦截在云资源创建侧由服务端执行。
            </p>

            <div class="quota-grid">
              <label class="field">
                <span class="field__label">最大云账号数</span>
                <input
                  v-model.number="formMaxAccounts"
                  type="number"
                  min="0"
                  class="input"
                  data-testid="form-max-accounts"
                />
              </label>
              <label class="field">
                <span class="field__label">最大用户数</span>
                <input
                  v-model.number="formMaxUsers"
                  type="number"
                  min="0"
                  class="input"
                  data-testid="form-max-users"
                />
              </label>
              <label class="field">
                <span class="field__label">最大用户组数</span>
                <input
                  v-model.number="formMaxUserGroups"
                  type="number"
                  min="0"
                  class="input"
                  data-testid="form-max-user-groups"
                />
              </label>
            </div>

            <div class="field">
              <span class="field__label">云厂商白名单</span>
              <div class="vendor-grid">
                <label
                  v-for="v in VENDOR_OPTIONS"
                  :key="v.key"
                  class="vendor-option"
                >
                  <input
                    v-model="formVendors"
                    type="checkbox"
                    :value="v.key"
                    :data-testid="`form-vendor-${v.key}`"
                  />
                  <span>{{ v.label }}</span>
                </label>
              </div>
            </div>

            <div class="field">
              <span class="field__label">功能开关</span>
              <p v-if="formSwitches.length === 0" class="muted">
                暂无开关（空表 = 不启用任何差异化开关）
              </p>
              <div
                v-for="(sw, i) in formSwitches"
                :key="i"
                class="switch-row"
              >
                <input
                  v-model="sw.key"
                  type="text"
                  class="input switch-row__key"
                  placeholder="开关键，如 cdn"
                  :data-testid="`form-switch-key-${i}`"
                />
                <label class="switch-row__toggle">
                  <input
                    v-model="sw.on"
                    type="checkbox"
                    :data-testid="`form-switch-on-${i}`"
                  />
                  <span>{{ sw.on ? "启用" : "禁用" }}</span>
                </label>
                <button
                  type="button"
                  class="btn btn--text btn--danger"
                  :data-testid="`form-switch-remove-${i}`"
                  @click="removeSwitch(i)"
                >
                  删除
                </button>
              </div>
              <div>
                <button
                  type="button"
                  class="btn btn--text"
                  data-testid="form-switch-add"
                  @click="addSwitch"
                >
                  ＋ 添加开关
                </button>
              </div>
            </div>
          </fieldset>

          <div class="dialog__actions">
            <button type="button" class="btn btn--ghost" @click="closeForm">
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="formLoading"
              data-testid="form-submit"
            >
              {{ formLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 禁用确认 Dialog（AC-3，G-4 降级：被拒显示活跃会话数）-->
    <div v-if="disableTarget" class="dialog-overlay" @click.self="closeDisable">
      <div
        ref="disableDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="disable-tenant-desc"
        :aria-label="`禁用租户 ${disableTarget.name}`"
      >
        <header class="dialog__head">
          <h3>禁用租户</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeDisable"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p id="disable-tenant-desc">
            确认禁用租户 <strong>{{ disableTarget.name }}</strong
            >？禁用后该租户用户将无法登录。
          </p>
          <!-- G-4 降级：被 eiam 拒绝时从拒绝消息提取活跃会话数，渲染 tenant.disable_blocked 契约 -->
          <p
            v-if="store.disableBlocked"
            class="delete-blocked"
            role="alert"
            data-testid="disable-blocked"
          >
            {{ disableBlockedText }}
          </p>
          <p
            v-if="store.disableBlocked && store.disableBlocked.count === 0"
            class="muted"
          >
            （eiam
            拒绝消息未携带结构化计数，已展示原文；活跃会话数列无列表数据源）
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            @click="closeDisable"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="disableLoading || !!store.disableBlocked"
            data-testid="disable-confirm"
            @click="confirmDisable"
          >
            {{ disableLoading ? "禁用中…" : "确认禁用" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认 Dialog（依赖删除由 eiam 拒绝，msg 透传）-->
    <div v-if="deleteTarget" class="dialog-overlay" @click.self="closeDelete">
      <div
        ref="deleteDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="delete-tenant-desc"
        :aria-label="`删除租户 ${deleteTarget.name}`"
      >
        <header class="dialog__head">
          <h3>删除租户</h3>
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
          <p id="delete-tenant-desc">
            确认删除租户 <strong>{{ deleteTarget.name }}</strong
            >？此操作不可撤销。
          </p>
          <!-- 前置提示：已知仍有从属资源时直接拦住（feat-tenant-delete-guard，需求 3 AC4/AC5） -->
          <p
            v-if="deleteResourceHint"
            class="delete-blocked"
            role="alert"
            data-testid="delete-resource-hint"
          >
            {{ deleteResourceHint }}
          </p>
          <p v-if="deleteBlocked" class="delete-blocked" role="alert">
            {{ deleteBlocked }}
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
            :disabled="deleteLoading || !!deleteBlocked || !!deleteResourceHint"
            data-testid="delete-confirm"
            @click="confirmDelete"
          >
            {{ deleteLoading ? "删除中…" : "确认删除" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 租户成员抽屉（feat-tenant-members-ui 契约 §2.3）-->
    <TenantMembersDrawer
      :tenant="membersTenant"
      @close="closeMembers"
      @removed="onMembersRemoved"
      @assigned="onMembersAssigned"
    />

    <!-- 租户详情抽屉（feat-tenant-detail-ui 契约 §2.4；只读）-->
    <TenantDetailDrawer :tenant="detailTenant" @close="closeDetail" />
  </section>
</template>

<style scoped lang="scss">
.page-tenant-list {
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
  /* 状态筛选下拉（原生 select，与 input 同高同风格） */
  &__status {
    min-width: 110px;
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
  // 窄屏保留可读最小列宽，超出容器由 .table-wrap 横向滚动承担。
  // 缺这条时 390 下「活跃会话数」列被压到 37px，中文逐字竖排（表头 106px、行高 243px），
  // 且 5 个操作按钮被拆成一字一行、操作列初始滚出可视区。
  min-width: 880px;
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

/* ---- 治理配置列：用量 / 上限（feat-tenant-usage-stats 需求 5，契约 §4.2）----
 * 单个指标一段（账号 / 用户 / 组 / 厂商 / 开关），段间 ' · '、用量与上限间 ' / '；
 * 超限段（用量 > 配额 > 0）整段危险色 + 「超出配额」徽标。
 */
.governance-cell {
  &__sep {
    color: var(--text-secondary);
  }

  &__seg {
    white-space: nowrap;

    &.is-over {
      color: var(--color-danger);
      font-weight: 600;
    }
  }

  &__over {
    margin-left: 4px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.6;
    background: var(--color-danger);
    color: #fff;
  }
}

.state-empty,
.state-error {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

// 错误态：说明在上、重试动作在下一行（同行时「…请稍后重试」+「重试」会读成「重试重试」）
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

/* ---- 治理配置区（tenant-management spec 需求 2/6/7）---- */
.fieldset {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;

  &__legend {
    padding: 0 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-regular);
  }

  &__hint {
    margin: 0;
    line-height: 1.6;
  }
}

.quota-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.vendor-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}

.vendor-option {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text-regular);
  cursor: pointer;
  white-space: nowrap;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  min-width: 0;

  &__key {
    flex: 1 1 auto;
    min-width: 0;
  }

  &__toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--text-regular);
    white-space: nowrap;
    cursor: pointer;
  }
}

/* 窄屏：配额三列并排会挤压，降为单列（弹窗本身 max-width 520px，375px 视口下可用） */
@media (max-width: 480px) {
  .quota-grid {
    grid-template-columns: 1fr;
  }
}

.form-error,
.delete-blocked {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

/* 默认登录租户标记徽章 */
.default-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  background: color-mix(in srgb, var(--accent-primary, #5e6ad2) 16%, transparent);
  color: var(--accent-primary, #5e6ad2);
}
</style>
