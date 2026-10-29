<script setup lang="ts">
/**
 * 用户组角色弹窗（feat-group-roles 契约 §2.2）。
 *
 * 入口：GroupList 行内「角色」按钮（权限 `iam:group:roles`）。
 * 结构：遮罩 + **居中弹窗**（非抽屉）；沿用既有 `.dialog-overlay` / `.dialog` / `.btn` /
 * `.input` 样式语言（`GroupMembersDrawer.vue` / `TenantMembersDrawer.vue` 同款），
 * **不使用 Element Plus 组件、不引入新依赖**。
 *
 * 数据流（契约 §1 / §2.2）：
 * - group 非 null（打开）→ listGroupRoles(group.code)（**GET + path 参数**，data 是完整
 *   Role VO 数组，不是 code 列表、不是分页信封）；
 * - 分配 → 候选 = listRolesPage({offset, limit, keyword:""}) 的全量角色**排除已绑定**
 *   （复用 `@/api/roles`，不重复实现）→ 选中 + 确认 → assignGroupRole(group_code, role_code)
 *   → 成功 emit('changed') 并重拉已绑列表（候选按已绑集合动态过滤，无需重拉角色）；
 * - 解绑 → 行内「解绑」→ 二次确认 → removeGroupRole → 成功 emit('changed') 并重拉；
 *   被拒 → 原样展示 ApiError.message（eiam msg 原文，不得改写）；
 * - 时间列统一经 `@/views/tenants/timestamp` 的 `formatEpochMs`（Unix 毫秒 + 年份护栏），
 *   **不另写时间格式化**。
 *
 * 关闭（group 变 null）只作废在途响应，不再发起新请求；请求序号保证迟到响应不写回 state。
 */
import { computed, ref, watch } from "vue";
import {
  assignGroupRole,
  listGroupRoles,
  removeGroupRole,
} from "@/api/groups";
import type { TenantGroupRole } from "@/api/groups";
import { listRolesPage } from "@/api/roles";
import { ApiError, type Role } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_GROUP } from "@/config/permission-codes";
import { formatEpochMs } from "@/views/tenants/timestamp";

const props = defineProps<{
  /** 目标用户组；null = 弹窗关闭。只带角色端点需要的 code 与渲染标题用的 name。 */
  group: { code: string; name: string } | null;
}>();

const emit = defineEmits<{
  /** 关闭弹窗（父级把 group 置 null） */
  close: [];
  /** 角色分配 / 解绑成功（父级按契约 §2.3 可忽略 —— 角色不影响组字段） */
  changed: [];
}>();

// 分配 / 解绑按钮权限（词表 IAM_GROUP.ASSIGN_ROLE / REMOVE_ROLE）
const { can } = useCan();

const isOpen = computed(() => props.group !== null);

// ---- 弹窗焦点 / Escape（关闭路径统一走 requestClose，先收内层确认）----
// 焦点陷阱挂在**最外层遮罩**而非卡片上：解绑二次确认是卡片的兄弟节点，
// 挂在卡片上会让 Tab 走不出到确认按钮（键盘用户无法确认解绑）。
const overlayRef = ref<HTMLElement | null>(null);
useDialogA11y(overlayRef, { open: isOpen, onClose: () => requestClose() });

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

// ---- 已绑角色列表 ----
const roles = ref<TenantGroupRole[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");

/** 已绑角色的 code 集合（候选据此排除；也用于提交前二次校验） */
const boundCodes = computed<Set<string>>(
  () => new Set(roles.value.map((r) => r.code)),
);

/** 请求序号：关闭弹窗 / 新请求发起后，旧响应一律丢弃 */
let requestSeq = 0;

/** 拉取已绑角色（按当前 group.code）。 */
async function load(): Promise<void> {
  const group = props.group;
  if (!group) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const list = await listGroupRoles(group.code);
    // 迟到的旧响应 / 弹窗已关闭 → 丢弃，不写 state
    if (seq !== requestSeq || !props.group) return;
    roles.value = list;
    // 选中项若已被绑定（例如上一次分配刚成功）→ 复位选择器
    if (selectedRoleCode.value !== "" && boundCodes.value.has(selectedRoleCode.value)) {
      selectedRoleCode.value = "";
    }
  } catch (err) {
    if (seq !== requestSeq || !props.group) return;
    roles.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

// ---- 分配（候选 = 全量角色 - 已绑定）----
/** 候选角色分页拉取条数（listRolesPage 是分页接口，需翻页凑齐全量） */
const CANDIDATE_PAGE_SIZE = 100;
/** 翻页上限（防御服务端 total 异常导致的死循环） */
const CANDIDATE_MAX_PAGES = 50;

/** 全量角色（候选源；已绑定项由 candidates 计算属性排除） */
const allRoles = ref<Role[]>([]);
const candidatesLoading = ref<boolean>(false);
const candidateError = ref<string>("");
const selectedRoleCode = ref<string>("");
const assigning = ref<boolean>(false);
/** 分配被拒原因（服务端 msg 原文，不改写） */
const assignError = ref<string>("");

/** 候选请求序号：关闭 / 重开时作废旧响应 */
let candidateSeq = 0;

const canAssign = computed<boolean>(() => can(IAM_GROUP.ASSIGN_ROLE));
const canRemove = computed<boolean>(() => can(IAM_GROUP.REMOVE_ROLE));

/** 候选：全量角色中**未绑定**的部分（契约 §2.2 核心语义） */
const candidates = computed<Role[]>(() =>
  allRoles.value.filter(
    (r) => r.code !== "" && !boundCodes.value.has(r.code),
  ),
);

/** 确认分配可用性：未选 / 提交中 / 无候选 → 禁用（防重复点击） */
const canConfirmAssign = computed<boolean>(
  () => selectedRoleCode.value !== "" && !assigning.value,
);

/** 翻页拉取全量角色（listRolesPage 复用，不重复实现角色列表）。 */
async function fetchAllRoles(): Promise<Role[]> {
  const all: Role[] = [];
  for (let page = 0; page < CANDIDATE_MAX_PAGES; page++) {
    const result = await listRolesPage({
      offset: all.length,
      limit: CANDIDATE_PAGE_SIZE,
      keyword: "",
    });
    if (result.items.length === 0) break;
    all.push(...result.items);
    if (all.length >= result.total) break;
  }
  return all;
}

/** 拉取候选源（无 ASSIGN_ROLE 权限则不请求 —— 不渲染选择器，避免无谓请求）。 */
async function loadCandidates(): Promise<void> {
  if (!props.group || !canAssign.value) return;
  const seq = ++candidateSeq;
  candidatesLoading.value = true;
  candidateError.value = "";
  try {
    const all = await fetchAllRoles();
    if (seq !== candidateSeq || !props.group) return;
    allRoles.value = all;
  } catch (err) {
    if (seq !== candidateSeq || !props.group) return;
    allRoles.value = [];
    candidateError.value = errorMessage(err);
  } finally {
    if (seq === candidateSeq) candidatesLoading.value = false;
  }
}

/**
 * 确认分配：成功 → emit('changed') 并重拉已绑列表（候选自动排除新绑定项）；
 * 被拒 → 原样展示服务端 msg，弹窗保持打开。
 */
async function confirmAssign(): Promise<void> {
  const group = props.group;
  const roleCode = selectedRoleCode.value;
  if (!group || roleCode === "" || assigning.value) return;
  // 提交前二次校验：不把「界面上看着可选、实际已绑定」的角色提交上去
  if (boundCodes.value.has(roleCode)) return;
  assigning.value = true;
  assignError.value = "";
  try {
    await assignGroupRole(group.code, roleCode);
    selectedRoleCode.value = "";
    emit("changed");
    await load();
  } catch (err) {
    // 被拒（重复绑定 / 无权限 / 角色不存在等）→ 原样展示服务端 msg
    assignError.value = errorMessage(err);
  } finally {
    assigning.value = false;
  }
}

// ---- 解绑（行内 + 二次确认）----
const removeTarget = ref<TenantGroupRole | null>(null);
const removeError = ref<string>("");
const removing = ref<boolean>(false);

function openRemove(role: TenantGroupRole): void {
  removeTarget.value = role;
  removeError.value = "";
  removing.value = false;
}

function cancelRemove(): void {
  if (removing.value) return;
  removeTarget.value = null;
  removeError.value = "";
}

async function confirmRemove(): Promise<void> {
  const group = props.group;
  const target = removeTarget.value;
  if (!group || !target || removing.value) return;
  removing.value = true;
  removeError.value = "";
  try {
    // 契约 §1：解绑载荷 {group_code, role_code}，两者均为 code（非 id）
    await removeGroupRole(group.code, target.code);
    removeTarget.value = null;
    emit("changed");
    await load();
  } catch (err) {
    // 被拒（未绑定 / 无权限等）→ 原样展示服务端 msg，确认弹窗保持打开
    removeError.value = errorMessage(err);
  } finally {
    removing.value = false;
  }
}

// ---- 交互关闭（内层确认先收；再关整个弹窗）----
function requestClose(): void {
  if (removeTarget.value) {
    cancelRemove();
    return;
  }
  emit("close");
}

// ---- 打开即拉取 / 关闭清理（group.code 是唯一开关）----
// 只观察 code（字符串）而非对象身份：父页每次重渲染都会新建 props 对象。
watch(
  () => props.group?.code ?? null,
  (code) => {
    if (code !== null) {
      roles.value = [];
      error.value = "";
      allRoles.value = [];
      candidateError.value = "";
      selectedRoleCode.value = "";
      assignError.value = "";
      assigning.value = false;
      removeTarget.value = null;
      removeError.value = "";
      removing.value = false;
      void load();
      void loadCandidates();
    } else {
      // 关闭：作废在途请求、清空状态；不发起任何新请求
      requestSeq++;
      candidateSeq++;
      loading.value = false;
      candidatesLoading.value = false;
      roles.value = [];
      error.value = "";
      allRoles.value = [];
      candidateError.value = "";
      selectedRoleCode.value = "";
      assignError.value = "";
      assigning.value = false;
      removeTarget.value = null;
      removeError.value = "";
      removing.value = false;
    }
  },
  { immediate: true },
);

const groupName = computed(() => props.group?.name ?? "");
</script>

<template>
  <div
    v-if="group"
    ref="overlayRef"
    class="dialog-overlay"
    data-testid="group-roles-dialog"
    @click.self="requestClose"
  >
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`${groupName} · 角色`"
    >
      <header class="dialog__head">
        <h3 class="dialog__title">{{ groupName }} · 角色</h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭角色弹窗"
          data-testid="group-roles-close"
          @click="requestClose"
        >
          ✕
        </button>
      </header>

      <div class="dialog__body">
        <!-- 分配区：仅 iam:group:assign_role；候选已排除已绑定角色 -->
        <div v-if="canAssign" class="assign">
          <select
            v-model="selectedRoleCode"
            class="input assign__select"
            aria-label="选择要分配的角色"
            data-testid="group-role-assign-select"
            :disabled="assigning || candidatesLoading"
          >
            <option value="">
              {{ candidatesLoading ? "加载候选角色…" : "选择角色" }}
            </option>
            <option v-for="r in candidates" :key="r.code" :value="r.code">
              {{ r.name }}（{{ r.code }}）
            </option>
          </select>
          <button
            type="button"
            class="btn btn--primary"
            data-testid="group-role-assign-confirm"
            :disabled="!canConfirmAssign"
            @click="confirmAssign"
          >
            {{ assigning ? "分配中…" : "确认分配" }}
          </button>
        </div>

        <!-- 候选全被绑定（或本就没有角色）时的说明 -->
        <p
          v-if="canAssign && !candidatesLoading && !candidateError && candidates.length === 0"
          class="muted"
          data-testid="group-role-assign-empty"
        >
          没有可分配的角色（全部已绑定）
        </p>

        <!-- 分配被拒：eiam msg 原文 -->
        <p
          v-if="assignError"
          class="form-error"
          role="alert"
          data-testid="group-role-assign-error"
        >
          {{ assignError }}
        </p>

        <!-- 候选加载失败：原文 + 重试 -->
        <p
          v-if="candidateError"
          class="form-error"
          role="alert"
          data-testid="group-role-candidates-error"
        >
          {{ candidateError }}
          <button type="button" class="btn btn--text" @click="loadCandidates">
            重试
          </button>
        </p>

        <!-- 加载态 -->
        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="i in 3" :key="i" class="skeleton__row" />
        </div>

        <!-- 已绑角色表 -->
        <div v-else-if="roles.length > 0" class="table-wrap">
          <table class="data-table">
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
                v-for="r in roles"
                :key="r.id"
                data-testid="group-role-row"
                :data-role-code="r.code"
              >
                <td>{{ r.name || "—" }}</td>
                <td class="mono">{{ r.code || "—" }}</td>
                <td class="muted desc-cell" :title="r.desc">
                  {{ r.desc || "—" }}
                </td>
                <td class="muted">{{ formatEpochMs(r.ctime) }}</td>
                <td>
                  <button
                    v-if="canRemove"
                    type="button"
                    class="btn btn--text btn--danger"
                    data-testid="group-role-remove"
                    @click="openRemove(r)"
                  >
                    解绑
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
          data-testid="group-roles-empty"
        >
          <p>该用户组暂无角色</p>
          <p v-if="canAssign" class="muted">
            可用上方选择器为该组分配一个角色。
          </p>
        </div>

        <!-- 错误态：服务端 msg 原文 + 重试 -->
        <p
          v-if="error"
          class="state-error"
          role="alert"
          data-testid="group-roles-error"
        >
          {{ error }}
          <button type="button" class="btn btn--text" @click="load">重试</button>
        </p>
      </div>
    </div>

    <!-- 解绑二次确认（弹窗内二层确认，与成员抽屉同款） -->
    <div v-if="removeTarget" class="dialog-overlay" @click.self="cancelRemove">
      <div
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="解绑角色"
        data-testid="group-role-remove-dialog"
      >
        <header class="dialog__head">
          <h3>解绑角色</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭解绑确认"
            @click="cancelRemove"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p>
            确认将角色
            <strong>{{ removeTarget.name || removeTarget.code }}</strong>
            从用户组 <strong>{{ groupName }}</strong> 解绑？
          </p>
          <!-- 被拒原因：eiam msg 原文 -->
          <p
            v-if="removeError"
            class="form-error"
            role="alert"
            data-testid="group-role-remove-error"
          >
            {{ removeError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="removing"
            data-testid="group-role-remove-cancel"
            @click="cancelRemove"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="removing"
            data-testid="group-role-remove-confirm"
            @click="confirmRemove"
          >
            {{ removing ? "解绑中…" : "确认解绑" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
/* 遮罩：沿用用户组列表 .dialog-overlay 语言；弹窗居中（非抽屉） */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;

  /* 二层确认叠在弹窗之上 */
  .dialog-overlay {
    z-index: 1100;
  }
}

.dialog {
  width: 100%;
  max-width: 640px;
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

  &__title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__body {
    padding: 16px 20px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 0 20px 20px;
  }
}

.assign {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;

  &__select {
    flex: 1 1 240px;
    min-width: 0;
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
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
  min-width: 480px;
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
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
  margin: 0;
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

.state-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.skeleton__row {
  height: 40px;
  margin: 8px 0;
  background: var(--tag-bg);
  border-radius: 6px;
}

.form-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

/* 窄屏：弹窗贴边留白，操作区换行，表格在容器内横向滚动 */
@media (max-width: 480px) {
  .dialog-overlay {
    padding: 12px;
  }

  .dialog {
    max-height: 92vh;

    &__head,
    &__body,
    &__actions {
      padding-left: 12px;
      padding-right: 12px;
    }
  }
}
</style>
