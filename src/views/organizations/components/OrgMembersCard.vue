<script setup lang="ts">
/**
 * OrgMembersCard —— 成员列表卡片（右侧下）
 *
 * 拆分来源：OrgList.vue 原模板 578-673 行 + 样式 .toolbar/.table-wrap/.data-table/.truncate/
 * .pagination 段 + 脚本成员分页与搜索逻辑。
 * 边界理由：纯展示 + 局部输入态（搜索框/选择器/移除确认），对外无事件，故无 props/emits。
 *
 * 数据流：全部读写 orgList store 的成员二级态；membersKeywordInput 为本组件局部输入缓冲，
 * 回车或点击「搜索」时经 setMembersKeyword 落到 store（并复位到第 1 页）后重新拉取。
 *
 * 成员增删（feat-dept-members-mutation 契约 §2.2，本轮新增）：
 * - 添加：卡片头部「添加成员」（`can(IAM_DEPARTMENT.ASSIGN)`，未选部门禁用）→ 二层多选选择器：
 *   打开即 listUsers({offset:0, limit, keyword})（**复用 @/api/users，不重复实现**），候选按
 *   **当前已加载成员 id 集合**判定「已在部门」→ 置灰不可选；确认 → assignOrganizationMembers(
 *   deptId, ids[])（**传数字 id 数组，不是 username**）→ 关闭选择器 → 回第 1 页重拉成员。
 * - 移除：成员行内「移除」（`can(IAM_DEPARTMENT.REMOVE)`）→ 二次确认 → removeOrganizationMembers(
 *   deptId, [id]) → 回第 1 页重拉成员。
 * - 提交中禁用确认按钮（防重复提交）；分配 / 移除被拒各自原位展示服务端 msg 原文（不改写）。
 *
 * 交互写法照搬上一轮 `views/groups/GroupMembersDrawer.vue`（多选 / 已在集合内置灰 /
 * 二次确认 / 错误原文 / 请求序号丢弃迟到响应），未引入组件库。
 */
import { computed, ref, watch } from "vue";
import { useOrgListStore } from "@/stores/orgList";
import CopyContractText from "@/components/CopyContractText.vue";
import { useCan } from "@/composables/useCan";
import { IAM_DEPARTMENT } from "@/config/permission-codes";
import {
  assignOrganizationMembers,
  removeOrganizationMembers,
  type DeptMember,
} from "@/api/organizations";
import { listUsers } from "@/api/users";
import { ApiError, type User } from "@/api/types";

const store = useOrgListStore();

// 添加/移除入口的按钮级裁剪（词表 IAM_DEPARTMENT.ASSIGN / REMOVE，仅体验层）
const { can } = useCan();

/**
 * 成员列表可见性（iam:department:members）。
 *
 * 为什么必须裁剪：`/department/members` 由该能力码在服务端强制校验；
 * 缺码用户若能进到本卡片，只会得到 403 + 一个"加载失败"的成员区（无法处置）。
 */
const canViewMembers = computed<boolean>(() => can(IAM_DEPARTMENT.MEMBERS));

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

/** 当前部门名（移除确认文案用；detail 未就绪时回退树节点名） */
const deptName = computed(
  () => store.detail?.name ?? store.selectedNode?.name ?? "当前部门",
);

/**
 * 错误 → 文案：**服务端 msg 原文优先**（契约 §2.2「失败不做二次改写」），
 * 仅在非 ApiError 时回退 message / 兜底文案。
 */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

/** 成功后重拉成员：回第 1 页（契约 §2.2「保持搜索/分页状态合理」），关键词保留 */
async function reloadMembers(deptId: number): Promise<void> {
  store.setMembersPage(1);
  await store.fetchMembers(deptId);
}

// ---- 添加成员（二层多选选择器，契约 §2.2）----
/** 候选用户单页条数（选择器内不分页；搜索即重查，与 GroupMembersDrawer 同口径） */
const PICKER_PAGE_SIZE = 20;

const pickerOpen = ref(false);
const pickerUsers = ref<User[]>([]);
const pickerLoading = ref(false);
/** 候选加载失败（服务端 msg 原文） */
const pickerLoadError = ref("");
/** 已生效的关键词（草稿经 Enter / 搜索按钮生效） */
const pickerKeyword = ref("");
const pickerKeywordInput = ref("");
/** 已勾选用户 id（**多选**；数字数组，提交时原样上行） */
const pickerSelected = ref<number[]>([]);
const assigning = ref(false);
/** 添加被拒原因（服务端 msg 原文，不改写） */
const assignError = ref("");

/** 候选请求序号：搜索 / 关闭后旧响应一律丢弃 */
let pickerSeq = 0;

/**
 * 当前部门成员 id 集合（判定候选「已在部门」）。
 * 口径与 GroupMembersDrawer 一致：以成员卡片当前已加载集合为准，不额外拉全量。
 */
const memberIds = computed<Set<number>>(
  () => new Set(store.members.map((m) => m.id)),
);

function isMember(id: number): boolean {
  return memberIds.value.has(id);
}

/** 确认按钮可用性：未选任何候选 / 提交中 → 禁用 */
const canConfirm = computed<boolean>(
  () => pickerSelected.value.length > 0 && !assigning.value,
);

function isSelected(id: number): boolean {
  return pickerSelected.value.includes(id);
}

/** 勾选 / 取消勾选一行（已在部门内的候选不可选，checkbox 已 disabled，此处再兜一层） */
function toggleUser(user: User): void {
  if (assigning.value || isMember(user.id)) return;
  assignError.value = "";
  const idx = pickerSelected.value.indexOf(user.id);
  if (idx >= 0) pickerSelected.value.splice(idx, 1);
  else pickerSelected.value.push(user.id);
}

/** 拉取候选用户（复用 listUsers；关键词已生效，固定第 1 页） */
async function loadPickerUsers(): Promise<void> {
  const deptId = store.selectedId;
  if (deptId === null || !pickerOpen.value) return;
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

/** 清空选择器状态并作废在途请求（不发请求） */
function closePicker(): void {
  pickerOpen.value = false;
  pickerSeq++;
  pickerLoading.value = false;
  pickerUsers.value = [];
  pickerLoadError.value = "";
  pickerSelected.value = [];
  assignError.value = "";
}

/** 打开选择器：清空上一次残留状态并立即拉取候选用户 */
function openPicker(): void {
  if (store.selectedId === null) return;
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

function cancelPicker(): void {
  if (assigning.value) return;
  closePicker();
}

/** 搜索候选：关键词 trim 后生效并重置到第 1 页（已勾选项跨搜索保留） */
function applyPickerSearch(): void {
  pickerKeyword.value = pickerKeywordInput.value.trim();
  assignError.value = "";
  void loadPickerUsers();
}

/**
 * 确认添加：成功 → 关闭选择器 + 重拉成员（第 1 页）；
 * 被拒 → 原样展示服务端 msg，选择器保持打开。
 */
async function confirmAssign(): Promise<void> {
  const deptId = store.selectedId;
  if (deptId === null || assigning.value) return;
  // 提交前二次校验：过滤掉已在部门内 / 非法 id，避免把「看着已置灰的行」提交上去
  const userIds = pickerSelected.value.filter((id) => id > 0 && !isMember(id));
  if (userIds.length === 0) return;
  assigning.value = true;
  assignError.value = "";
  try {
    // 契约 §1：载荷是数字 user_ids 数组（不是 username）
    await assignOrganizationMembers(deptId, userIds);
    closePicker();
    await reloadMembers(deptId);
  } catch (err) {
    // 被拒（重复加入 / 无权限 / 用户不存在等）→ 原样展示服务端 msg
    assignError.value = errorMessage(err);
  } finally {
    assigning.value = false;
  }
}

// ---- 移除成员（行内 + 二次确认，契约 §2.2）----
const removeTarget = ref<DeptMember | null>(null);
const removeError = ref("");
const removing = ref(false);

function openRemove(member: DeptMember): void {
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
  const deptId = store.selectedId;
  const target = removeTarget.value;
  if (deptId === null || !target || removing.value) return;
  removing.value = true;
  removeError.value = "";
  try {
    // 契约 §1：载荷是数字 user_ids 数组
    await removeOrganizationMembers(deptId, [target.id]);
    removeTarget.value = null;
    await reloadMembers(deptId);
  } catch (err) {
    // 被拒（无权限 / 成员不存在等）→ 原样展示服务端 msg，弹窗保持打开
    removeError.value = errorMessage(err);
  } finally {
    removing.value = false;
  }
}

// 切换部门：收起悬浮层并作废在途请求（不发新请求，成员重拉由父级选择流程负责）
watch(
  () => store.selectedId,
  () => {
    closePicker();
    removeTarget.value = null;
    removeError.value = "";
    removing.value = false;
  },
);
</script>

<template>
  <!-- 成员列表可见性（IAM_DEPARTMENT.MEMBERS）：
       成员端点由该能力码强制校验，缺码时若照常渲染，用户只会看到一个永远加载失败的卡片
       （且白发一次必然 403 的请求）—— 故整卡按码裁剪，与词表"三级裁剪"口径一致。 -->
  <div v-if="canViewMembers" class="card">
    <div class="card__head">
      <span class="card__title">成员列表</span>
      <div class="card__head-actions">
        <span v-if="store.selectedId !== null" class="muted"
          >共 {{ store.membersTotal }} 人</span
        >
        <!-- 产权限：iam:department:assign；未选部门时禁用（契约 §2.2） -->
        <button
          v-if="can(IAM_DEPARTMENT.ASSIGN)"
          type="button"
          class="btn btn--primary btn--sm"
          data-testid="dept-member-add"
          :disabled="store.selectedId === null"
          :title="store.selectedId === null ? '请先在左侧选择部门' : undefined"
          @click="openPicker"
        >
          添加成员
        </button>
      </div>
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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in store.members"
                :key="m.id"
                data-testid="dept-member-row"
              >
                <td>{{ m.username }}</td>
                <td>{{ m.displayName }}</td>
                <td class="truncate">{{ m.email || "—" }}</td>
                <td class="truncate">{{ m.phone || "—" }}</td>
                <td>
                  <!-- 产权限：iam:department:remove -->
                  <button
                    v-if="can(IAM_DEPARTMENT.REMOVE)"
                    type="button"
                    class="btn btn--text btn--danger"
                    data-testid="dept-member-remove"
                    @click="openRemove(m)"
                  >
                    移除
                  </button>
                </td>
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

    <!-- 添加成员：卡片内二层多选选择器（原生元素，不引入组件库） -->
    <div v-if="pickerOpen" class="picker-overlay" @click.self="cancelPicker">
      <div
        class="picker"
        role="dialog"
        aria-modal="true"
        aria-label="添加成员"
        data-testid="dept-member-picker"
      >
        <header class="picker__head">
          <h3 class="picker__title">添加成员</h3>
        </header>

        <div class="picker__body">
          <div class="picker__search-row">
            <input
              v-model="pickerKeywordInput"
              type="text"
              class="input picker__search"
              placeholder="搜索用户名 / 昵称"
              aria-label="搜索候选用户"
              data-testid="dept-member-picker-search"
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

          <!-- 添加被拒：服务端 msg 原文（不二次改写） -->
          <p
            v-if="assignError"
            class="form-error"
            role="alert"
            data-testid="dept-member-picker-error"
          >
            {{ assignError }}
          </p>

          <!-- 候选加载失败：原文 + 重试 -->
          <p
            v-if="pickerLoadError"
            class="form-error"
            role="alert"
            data-testid="dept-member-picker-load-error"
          >
            {{ pickerLoadError }}
            <button
              type="button"
              class="btn btn--text"
              @click="loadPickerUsers"
            >
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
              data-testid="dept-member-picker-empty"
            >
              未找到用户
            </p>

            <ul v-else-if="pickerUsers.length > 0" class="picker__rows">
              <li v-for="u in pickerUsers" :key="u.id">
                <label
                  class="picker__row"
                  :class="{
                    'is-selected': isSelected(u.id),
                    'is-in-group': isMember(u.id),
                  }"
                  data-testid="dept-member-picker-row"
                >
                  <input
                    type="checkbox"
                    class="picker__checkbox"
                    :checked="isSelected(u.id)"
                    :disabled="isMember(u.id)"
                    :aria-label="`选择 ${u.username}`"
                    @change="toggleUser(u)"
                  />
                  <span class="picker__row-name">{{
                    u.displayName || u.username
                  }}</span>
                  <span class="picker__row-username muted">{{
                    u.username
                  }}</span>
                  <span v-if="isMember(u.id)" class="picker__row-badge"
                    >已在部门</span
                  >
                </label>
              </li>
            </ul>
          </div>

          <p v-if="pickerSelected.length > 0" class="picker__count muted">
            已选 {{ pickerSelected.length }} 人
          </p>
        </div>

        <footer class="picker__foot">
          <button
            type="button"
            class="btn btn--ghost"
            data-testid="dept-member-picker-cancel"
            @click="cancelPicker"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--primary"
            data-testid="dept-member-picker-confirm"
            :disabled="!canConfirm"
            @click="confirmAssign"
          >
            {{ assigning ? "添加中…" : "确认添加" }}
          </button>
        </footer>
      </div>
    </div>

    <!-- 移除二次确认 -->
    <div v-if="removeTarget" class="dialog-overlay" @click.self="cancelRemove">
      <div
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="移除成员"
        data-testid="dept-member-remove-dialog"
      >
        <header class="dialog__head">
          <h3>移除成员</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭移除确认"
            @click="cancelRemove"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p>
            确认将 <strong>{{ removeTarget.username }}</strong> 从部门
            <strong>{{ deptName }}</strong> 中移除？
          </p>
          <!-- 被拒原因：服务端 msg 原文 -->
          <p
            v-if="removeError"
            class="form-error"
            role="alert"
            data-testid="dept-member-remove-error"
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
            data-testid="dept-member-remove-confirm"
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
@use "../styles/shared";
@use "../styles/form";
@use "../styles/dialog";

.card__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

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

/* ---- 添加成员选择器（卡片上二层弹层，多选；样式同 GroupMembersDrawer）---- */
.picker-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
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

  &__row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 8px;
    border-bottom: 1px solid var(--border-subtle);
    border-radius: 6px;
    background: transparent;
    color: var(--text-regular);
    font-size: 14px;
    text-align: left;
    cursor: pointer;

    &:hover:not(.is-in-group) {
      background: var(--tag-bg);
    }

    &.is-selected {
      background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
      color: var(--text-primary);
      font-weight: 600;
    }

    /* 已在部门：整行不可选（置灰） */
    &.is-in-group {
      opacity: 0.55;
      cursor: not-allowed;
    }
  }

  &__checkbox {
    flex: 0 0 auto;
    margin: 0;
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
</style>
