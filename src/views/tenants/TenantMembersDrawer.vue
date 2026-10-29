<script setup lang="ts">
/**
 * 租户成员管理抽屉（feat-tenant-members-ui 契约 §2.2 + feat-tenant-assign-member §2.2）。
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
 * - 添加（feat-tenant-assign-member）→ 抽屉内二层选择器：
 *   打开即 listUsers({offset:0, limit, keyword})（复用 @/api/users，不重复实现）；
 *   候选按**当前成员集合的 id** 判定「已在租户」→ 置灰不可选、确认禁用；
 *   确认 → assignTenantMember(tenant.id, user.id)：
 *   成功关闭选择器、重拉成员列表、emit('assigned')（父级刷新用量）；
 *   被拒 → 选择器内展示 ApiError.message 原文（不改写）。
 *
 * feat-tenant-members-batch 增量（契约 §2.2）：
 * - 选择器改为**多选**（复选框 + 行点击切换，跨搜索保留），显示「已选 N 人」，
 *   0 选中时确认禁用；确认时选中 ≥2 人走 batchAssignTenantMembers(tenant.id, ids)
 *   （`tenant_ids` 固定 `[当前租户]`，符合后端「单维度批量」约束），
 *   选中恰 1 人沿用既有单条 assignTenantMember —— 既有单条路径与其权限口径不回归；
 * - 成员表多选：行复选框 `member-select` + 表头全选 `member-select-all`（**仅本页**）；
 * - 批量移除 `member-batch-remove`（需 iam:tenant:batch_unassign，无选中禁用，
 *   显示「移除已选 N 人」）→ 二次确认 → batchUnassignTenantMembers：
 *   成功清空选中 + 重拉 + emit('changed')（并 emit('removed') 让父级刷新租户用量）；
 *   被拒 → `member-batch-remove-error` 展示服务端 msg 原文，弹窗保持、选中不清空。
 *
 * 分页口径与租户列表一致（20/50/100）；搜索 / 重置 / 切页大小均重置到第 1 页。
 * 关闭（tenant 变 null）只丢弃在途响应，不再发起新请求（M9 不产生残留请求）。
 */
import { computed, ref, watch } from "vue";
import {
  assignTenantMember,
  batchAssignTenantMembers,
  batchUnassignTenantMembers,
  listTenantMembers,
  removeTenantMember,
  type ListTenantMembersQuery,
} from "@/api/tenantMembers";
import { listUsers } from "@/api/users";
import { ApiError, type TenantMember, type User } from "@/api/types";
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
  /** 成员添加成功（父级刷新租户列表，刷新用量列） */
  assigned: [];
  /**
   * 批量加入 / 批量移除成功（feat-tenant-members-batch 契约 §2.2）。
   * 父级可据此刷新租户列表；既有 removed / assigned 仍按原语义同时发出，
   * 保证既有父级监听不失效。
   */
  changed: [];
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

/**
 * 当前成员集合的 id（契约 §2.2「已在租户」判定：以抽屉当前成员集合为准，不新增接口）。
 * 候选行据此置灰；确认前再校验一次选中项，避免把已在租户的用户提交上去。
 */
const memberIds = computed<Set<number>>(
  () => new Set(items.value.map((m) => m.id)),
);

function isMember(userId: number): boolean {
  return memberIds.value.has(userId);
}

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

// ---- 成员多选 + 批量移除（feat-tenant-members-batch 契约 §2.2）----
/**
 * 批量移除能力：无 `iam:tenant:batch_unassign` 时不渲染多选列与批量按钮
 * （既有单条「移除」仍由 `iam:tenant:unassign` 独立门控）。
 */
const canBatchUnassign = computed<boolean>(() => can(IAM_TENANT.BATCH_UNASSIGN));

/** 选中集（成员 id；**仅本页**，与角色列表同口径，不含跨页选中） */
const selectedIds = ref<number[]>([]);

/** 当前页是否全选（表头复选框：勾选补齐全页 id，取消移除本页 id） */
const allSelected = computed<boolean>({
  get: () =>
    items.value.length > 0 &&
    items.value.every((m) => selectedIds.value.includes(m.id)),
  set: (checked: boolean) => {
    if (checked) {
      const next = new Set(selectedIds.value);
      for (const m of items.value) next.add(m.id);
      selectedIds.value = [...next];
    } else {
      const visible = new Set(items.value.map((m) => m.id));
      selectedIds.value = selectedIds.value.filter((id) => !visible.has(id));
    }
  },
});

/**
 * 选中集随列表收敛：重拉 / 翻页 / 搜索后，不在当前页的成员 id 移出选中集
 * —— 避免「移除看不见的行」（契约：全选仅本页）。
 */
watch(items, (list) => {
  if (selectedIds.value.length === 0) return;
  const visible = new Set(list.map((m) => m.id));
  selectedIds.value = selectedIds.value.filter((id) => visible.has(id));
});

// ---- 批量移除二次确认 ----
const batchRemoveOpen = ref<boolean>(false);
/** 本次待移除 id 快照（确认后按快照提交，弹窗文本取自打开时的列表） */
const batchRemoveIds = ref<number[]>([]);
const batchRemoveNames = ref<string[]>([]);
const batchRemoving = ref<boolean>(false);
/** 被拒原因（服务端 msg 原文，不改写） */
const batchRemoveError = ref<string>("");

function openBatchRemove(): void {
  if (selectedIds.value.length === 0 || batchRemoving.value) return;
  const ids = [...selectedIds.value];
  batchRemoveIds.value = ids;
  batchRemoveNames.value = items.value
    .filter((m) => ids.includes(m.id))
    .map((m) => m.username);
  batchRemoveError.value = "";
  batchRemoving.value = false;
  batchRemoveOpen.value = true;
}

function cancelBatchRemove(): void {
  if (batchRemoving.value) return;
  batchRemoveOpen.value = false;
  batchRemoveIds.value = [];
  batchRemoveNames.value = [];
  batchRemoveError.value = "";
}

/**
 * 确认批量移除：成功 → 关弹窗 + **清空选中** + 重拉 + emit('changed')；
 * 被拒 → 原样展示服务端 msg（`member-batch-remove-error`），弹窗保持打开、
 * **选中不清空** —— 不把未移除的成员谎报成「已移除」，用户可重试或取消。
 */
async function confirmBatchRemove(): Promise<void> {
  const tenant = props.tenant;
  const ids = batchRemoveIds.value;
  if (!tenant || ids.length === 0 || batchRemoving.value) return;
  batchRemoving.value = true;
  batchRemoveError.value = "";
  try {
    await batchUnassignTenantMembers(tenant.id, ids);
    batchRemoveOpen.value = false;
    batchRemoveIds.value = [];
    batchRemoveNames.value = [];
    selectedIds.value = [];
    // 契约 §2.2：成功 emit('changed')；removed 供既有父级刷新租户用量列
    emit("changed");
    emit("removed");
    await load();
  } catch (err) {
    // 被拒（禁止移除自己 / admin / 权限不足 / 其他）→ 原文展示，选中与弹窗保留
    batchRemoveError.value = errorMessage(err);
  } finally {
    batchRemoving.value = false;
  }
}

// ---- 添加成员（二层选择器，feat-tenant-assign-member 契约 §2.2）----
/** 候选用户单页条数（选择器内不分页：搜索即重置到第 1 页，与抽屉成员搜索同口径） */
const PICKER_PAGE_SIZE = 20;

const pickerOpen = ref<boolean>(false);
/** 候选用户列表（复用 @/api/users 的 listUsers 归一结果，不重复实现） */
const pickerUsers = ref<User[]>([]);
const pickerLoading = ref<boolean>(false);
/** 候选加载失败（服务端 msg 原文） */
const pickerLoadError = ref<string>("");
/** 已生效的关键词（草稿经 Enter / 搜索按钮生效） */
const pickerKeyword = ref<string>("");
const pickerKeywordInput = ref<string>("");
/**
 * 已勾选的用户 id（**多选**，契约 §2.2）。
 * 顺序为勾选顺序，提交时原样上行；选择跨搜索保留（便于多次搜索后一次提交），
 * 提交前再过滤一次「已在租户」的项。
 */
const pickerSelected = ref<number[]>([]);
const assigning = ref<boolean>(false);
/** 添加被拒原因（服务端 msg 原文，不改写） */
const assignError = ref<string>("");

/** 候选请求序号：搜索/关闭后旧响应一律丢弃（与成员列表同款处理） */
let pickerSeq = 0;

/** 确认按钮可用性：未选中任何候选 / 提交中 → 禁用（契约 §2.2） */
const canConfirm = computed<boolean>(
  () => pickerSelected.value.length > 0 && !assigning.value,
);

/** 候选行是否已勾选 */
function isPickerSelected(userId: number): boolean {
  return pickerSelected.value.includes(userId);
}

/** 拉取候选用户（关键词已生效，固定第 1 页） */
async function loadPickerUsers(): Promise<void> {
  if (!props.tenant || !pickerOpen.value) return;
  const seq = ++pickerSeq;
  pickerLoading.value = true;
  pickerLoadError.value = "";
  try {
    const result = await listUsers({
      offset: 0,
      limit: PICKER_PAGE_SIZE,
      keyword: pickerKeyword.value,
    });
    if (seq !== pickerSeq || !pickerOpen.value) return;
    pickerUsers.value = result.items;
  } catch (err) {
    if (seq !== pickerSeq || !pickerOpen.value) return;
    pickerUsers.value = [];
    pickerLoadError.value = errorMessage(err);
  } finally {
    if (seq === pickerSeq) pickerLoading.value = false;
  }
}

/** 打开选择器：清空上一次残留状态并立即拉取候选用户 */
function openPicker(): void {
  if (!props.tenant) return;
  pickerOpen.value = true;
  pickerKeyword.value = "";
  pickerKeywordInput.value = "";
  pickerUsers.value = [];
  pickerLoadError.value = "";
  pickerSelected.value = [];
  assignError.value = "";
  assigning.value = false;
  void loadPickerUsers();
}

/** 清空选择器状态并收起弹层（作废在途候选请求；不发任何新请求） */
function resetPicker(): void {
  pickerOpen.value = false;
  pickerSeq++;
  pickerLoading.value = false;
  pickerUsers.value = [];
  pickerLoadError.value = "";
  pickerSelected.value = [];
  assignError.value = "";
}

/** 关闭选择器：作废在途请求、清空状态；不发请求 */
function cancelPicker(): void {
  if (assigning.value) return;
  resetPicker();
}

/** 搜索候选：关键词 trim 后生效并重置分页（已勾选项跨搜索保留，提交前再校验） */
function applyPickerSearch(): void {
  pickerKeyword.value = pickerKeywordInput.value.trim();
  assignError.value = "";
  void loadPickerUsers();
}

/**
 * 勾选 / 取消勾选一行（多选，契约 §2.2）。
 * 已在租户的行不可选（复选框与按钮均已 disabled，此处再兜一层）。
 */
function toggleUser(user: User): void {
  if (assigning.value || isMember(user.id)) return;
  assignError.value = "";
  const idx = pickerSelected.value.indexOf(user.id);
  if (idx >= 0) pickerSelected.value.splice(idx, 1);
  else pickerSelected.value.push(user.id);
}

/**
 * 确认添加：**多选**提交（feat-tenant-members-batch 契约 §2.2）。
 *
 * - 选中恰好 1 人 → 沿用既有单条 assignTenantMember（单条路径与 iam:tenant:assign
 *   权限口径不回归，契约 §2.2「既有单条加入保留可用」）；
 * - 选中 ≥2 人 → batchAssignTenantMembers(tenant.id, ids)（`tenant_ids` 单元素，
 *   满足后端「两个数组不能同时 >1」的单维度约束）。
 *
 * 成功 → 关闭选择器 + emit('assigned')（父级刷新用量）+ 重拉成员；
 * 批量路径另发 emit('changed')（契约 §2.2）；
 * 被拒 → 原样展示服务端 msg，选择器保持打开。
 */
async function confirmAssign(): Promise<void> {
  const tenant = props.tenant;
  if (!tenant || assigning.value) return;
  // 提交前二次校验：过滤掉已在租户的项（可视行之外的残留选中也不提交）
  const ids = [...new Set(pickerSelected.value)].filter((id) => !isMember(id));
  if (ids.length === 0) return;
  assigning.value = true;
  assignError.value = "";
  const batch = ids.length > 1;
  try {
    if (batch) {
      await batchAssignTenantMembers(tenant.id, ids);
    } else {
      await assignTenantMember(tenant.id, ids[0]!);
    }
    resetPicker();
    // 通知父级刷新租户列表（用量列随之更新），并重拉当前页成员
    emit("assigned");
    if (batch) emit("changed");
    await load();
  } catch (err) {
    // 被拒（重复加入 / 无权限 / 其他）→ 原样展示服务端 msg，选择器保持打开
    assignError.value = errorMessage(err);
  } finally {
    assigning.value = false;
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
      // 换租户：选中集与批量弹窗不得跨租户残留
      selectedIds.value = [];
      batchRemoveOpen.value = false;
      batchRemoveIds.value = [];
      batchRemoveNames.value = [];
      batchRemoveError.value = "";
      batchRemoving.value = false;
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
      selectedIds.value = [];
      batchRemoveOpen.value = false;
      batchRemoveIds.value = [];
      batchRemoveNames.value = [];
      batchRemoveError.value = "";
      batchRemoving.value = false;
      // 二层选择器同步收起（关闭抽屉不应留下悬浮层）
      pickerOpen.value = false;
      pickerSeq++;
      pickerLoading.value = false;
      pickerUsers.value = [];
      pickerLoadError.value = "";
      pickerSelected.value = [];
      assignError.value = "";
      assigning.value = false;
    }
  },
  { immediate: true },
);

// ---- 交互关闭（确认弹窗 / 选择器打开时 Escape / 点遮罩只收起当前层，不连带关抽屉）----
function requestClose(): void {
  if (pickerOpen.value) {
    cancelPicker();
    return;
  }
  if (batchRemoveOpen.value) {
    cancelBatchRemove();
    return;
  }
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

      <!-- 工具条：关键词 + 搜索/重置；右侧「添加成员」（权限 iam:tenant:assign） -->
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
        <button
          v-if="can(IAM_TENANT.ASSIGN)"
          type="button"
          class="btn btn--primary drawer__add"
          data-testid="member-add"
          @click="openPicker"
        >
          添加成员
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

        <!-- 成员表（feat-tenant-members-batch：多选列 + 批量移除工具条） -->
        <div v-else-if="items.length > 0">
          <!-- 批量移除：需 iam:tenant:batch_unassign；无选中禁用 -->
          <div v-if="canBatchUnassign" class="drawer__bulk">
            <button
              type="button"
              class="btn btn--danger"
              data-testid="member-batch-remove"
              :disabled="selectedIds.length === 0 || batchRemoving"
              @click="openBatchRemove"
            >
              移除已选 {{ selectedIds.length }} 人
            </button>
          </div>

          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <!-- 表头全选：仅本页 -->
                  <th v-if="canBatchUnassign" class="col-select">
                    <input
                      v-model="allSelected"
                      type="checkbox"
                      data-testid="member-select-all"
                      aria-label="全选本页成员"
                    />
                  </th>
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
                  <td v-if="canBatchUnassign" class="col-select">
                    <input
                      v-model="selectedIds"
                      type="checkbox"
                      data-testid="member-select"
                      :value="m.id"
                      :aria-label="`选择成员 ${m.username}`"
                    />
                  </td>
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

      <!-- 添加成员：抽屉内二层选择器（原生元素，不引入组件库） -->
      <div v-if="pickerOpen" class="picker-overlay" @click.self="cancelPicker">
        <div
          class="picker"
          role="dialog"
          aria-modal="true"
          aria-label="添加成员"
          data-testid="member-picker"
        >
          <header class="picker__head">
            <h3 class="picker__title">添加成员</h3>
          </header>

          <div class="picker__body">
            <!-- 搜索：Enter / 「搜索」触发，重置到第 1 页 -->
            <div class="picker__search-row">
              <input
                v-model="pickerKeywordInput"
                type="text"
                class="input picker__search"
                placeholder="搜索用户名 / 昵称"
                data-testid="member-picker-search"
                @keyup.enter="applyPickerSearch"
              />
              <button
                type="button"
                class="btn btn--ghost"
                @click="applyPickerSearch"
              >
                搜索
              </button>
            </div>

            <!-- 添加被拒：eiam msg 原文（不二次改写） -->
            <p
              v-if="assignError"
              class="form-error"
              role="alert"
              data-testid="member-picker-error"
            >
              {{ assignError }}
            </p>

            <!-- 候选加载失败：原文 + 重试 -->
            <p
              v-if="pickerLoadError"
              class="form-error"
              role="alert"
              data-testid="member-picker-load-error"
            >
              {{ pickerLoadError }}
              <button type="button" class="btn btn--text" @click="loadPickerUsers">
                重试
              </button>
            </p>

            <div class="picker__list">
              <div v-if="pickerLoading" class="skeleton" aria-hidden="true">
                <div v-for="i in 3" :key="i" class="skeleton__row" />
              </div>

              <p
                v-else-if="pickerUsers.length === 0 && !pickerLoadError"
                class="state-empty"
                data-testid="member-picker-empty"
              >
                未找到用户
              </p>

              <ul v-else-if="pickerUsers.length > 0" class="picker__rows">
                <li v-for="u in pickerUsers" :key="u.id" class="picker__item">
                  <!-- 多选：复选框与整行点击都能切换选中态（已在租户的行不可选） -->
                  <input
                    type="checkbox"
                    class="picker__checkbox"
                    :checked="isPickerSelected(u.id)"
                    :disabled="isMember(u.id)"
                    :aria-label="`选择 ${u.username}`"
                    data-testid="member-picker-check"
                    @change="toggleUser(u)"
                  />
                  <button
                    type="button"
                    class="picker__row"
                    :class="{
                      'is-selected': isPickerSelected(u.id),
                      'is-in-tenant': isMember(u.id),
                    }"
                    :disabled="isMember(u.id)"
                    :aria-disabled="isMember(u.id)"
                    :aria-pressed="isPickerSelected(u.id)"
                    data-testid="member-picker-row"
                    @click="toggleUser(u)"
                  >
                    <span class="picker__row-name">{{
                      u.displayName || u.username
                    }}</span>
                    <span class="picker__row-username muted">{{
                      u.username
                    }}</span>
                    <span v-if="isMember(u.id)" class="picker__row-badge"
                      >已在租户</span
                    >
                  </button>
                </li>
              </ul>
            </div>

            <!-- 已选计数（0 选中时确认按钮禁用） -->
            <p v-if="pickerSelected.length > 0" class="picker__count muted">
              已选 {{ pickerSelected.length }} 人
            </p>
          </div>

          <footer class="picker__foot">
            <button
              type="button"
              class="btn btn--ghost"
              data-testid="member-picker-cancel"
              @click="cancelPicker"
            >
              取消
            </button>
            <button
              type="button"
              class="btn btn--primary"
              data-testid="member-picker-confirm"
              :disabled="!canConfirm"
              @click="confirmAssign"
            >
              {{ assigning ? "添加中…" : "确认添加" }}
            </button>
          </footer>
        </div>
      </div>
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

    <!-- 批量移除二次确认（成功清空选中并重拉；被拒展示服务端 msg 原文、弹窗与选中保留） -->
    <div
      v-if="batchRemoveOpen"
      class="dialog-overlay"
      @click.self="cancelBatchRemove"
    >
      <div
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="批量移除成员"
        data-testid="member-batch-remove-dialog"
      >
        <header class="dialog__head">
          <h3>批量移除成员</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭批量移除确认"
            @click="cancelBatchRemove"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p>
            确认将选中的 <strong>{{ batchRemoveIds.length }}</strong> 名成员从租户
            <strong>{{ tenant.name }}</strong> 中移除？
          </p>
          <ul class="member-list">
            <li v-for="name in batchRemoveNames" :key="name">{{ name }}</li>
          </ul>
          <!-- 被拒原因：eiam msg 原文（不二次改写；选中不清空） -->
          <p
            v-if="batchRemoveError"
            class="form-error"
            role="alert"
            data-testid="member-batch-remove-error"
          >
            {{ batchRemoveError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="batchRemoving"
            data-testid="member-batch-remove-cancel"
            @click="cancelBatchRemove"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="batchRemoving"
            data-testid="member-batch-remove-confirm"
            @click="confirmBatchRemove"
          >
            {{ batchRemoving ? "移除中…" : "确认移除" }}
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

  /* 「添加成员」靠工具条右侧（契约 §2.2：工具栏右侧） */
  &__add {
    margin-left: auto;
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

/* 批量移除工具条（仅持有 iam:tenant:batch_unassign 且列表非空时渲染） */
.drawer__bulk {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 2px 10px;
}

/* 多选列：窄列 + 居中（复选框列无需等宽字体） */
.col-select {
  width: 40px;
  text-align: center;
  font-family: inherit;

  input {
    cursor: pointer;
  }
}

/* 待移除成员名清单（弹窗内逐条列出，限高避免撑爆弹窗） */
.member-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-regular);
  font-size: 13px;
  max-height: 120px;
  overflow-y: auto;
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

/* ---- 添加成员选择器（抽屉内二层弹层）---- */
.picker-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  // 高于抽屉自身的遮罩层（1000），形成抽屉之上的第二层
  z-index: 1100;
  background: rgba(0, 0, 0, 0.45);
}

.picker {
  width: 100%;
  max-width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border-radius: 8px;
  box-shadow: var(--shadow-base);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  &__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  &__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 12px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  &__search-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__search {
    flex: 1 1 auto;
    min-width: 0;
  }

  &__list {
    min-height: 120px;
  }

  &__rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  /* 候选行 = 复选框 + 行按钮（复选框独立于按钮，避免嵌套可交互元素） */
  &__item {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__checkbox {
    flex: 0 0 auto;
    margin: 0;
    cursor: pointer;

    &:disabled {
      cursor: not-allowed;
    }
  }

  &__row {
    width: 100%;
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px;
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: var(--text-regular);
    font-size: 14px;
    text-align: left;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: var(--tag-bg);
    }

    &.is-selected {
      background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
      color: var(--text-primary);
      font-weight: 600;
    }

    /* 已在租户：整行不可选（置灰） */
    &.is-in-tenant,
    &:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
  }

  &__row-name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__row-username {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__row-badge {
    flex: 0 0 auto;
    padding: 0 6px;
    border-radius: 4px;
    background: var(--tag-bg);
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.7;
  }

  &__count {
    margin: 0;
  }

  &__foot {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border-subtle);
  }
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
