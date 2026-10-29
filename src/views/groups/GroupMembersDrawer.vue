<script setup lang="ts">
/**
 * 用户组成员管理抽屉（feat-group-members 契约 §2.2）。
 *
 * 入口：GroupList 行内「成员」按钮（权限 iam:group:members）。
 * 结构：遮罩 + 右侧抽屉；沿用 `TenantMembersDrawer.vue` 的原生元素样式语言
 * （dialog-overlay / drawer / btn / input / picker，**不使用 Element Plus 组件**）。
 *
 * 数据流（契约 §1）：
 * - group 非 null（打开）→ listGroupMembers(group.code, {offset, limit, keyword})；
 *   该端点**服务端真支持 keyword**，故搜索直接上行，不做本页假筛选；
 * - 移除 → 行内「移除」→ 二次确认 → removeGroupMembers(group.code, [username])：
 *   成功 emit('changed')（父页 store.fetch() 保持一致）并重拉当前页；
 *   被拒 → 展示 ApiError.message（eiam msg 原文，不得改写）；
 * - 添加 → 二层选择器：打开即 listUsers({offset:0, limit, keyword})（复用 @/api/users，
 *   不重复实现）；候选**多选复选框**，按当前成员集合的 username 判定「已在组内」→ 置灰不可选；
 *   确认 → assignGroupMembers(group.code, 选中 username 数组)（**传 username，不是 id**）：
 *   成功关闭选择器、emit('changed')、重拉成员列表；被拒 → 选择器内展示 msg 原文。
 *
 * 分页口径与用户组列表一致（20/50/100）；搜索 / 重置 / 切页大小均重置到第 1 页。
 * 关闭（group 变 null）只作废在途响应，不再发起新请求；请求序号保证迟到响应不写回 state。
 */
import { computed, ref, watch } from "vue";
import {
  assignGroupMembers,
  listGroupMembers,
  removeGroupMembers,
} from "@/api/groups";
import type { GroupMember } from "@/api/groups";
import { listUsers } from "@/api/users";
import { ApiError, type User } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_GROUP } from "@/config/permission-codes";

const props = defineProps<{
  /**
   * 目标用户组；null = 抽屉关闭。
   * 只带成员端点需要的 code（成员增删均以 group_code 定位）与渲染标题用的 name。
   */
  group: { code: string; name: string } | null;
}>();

const emit = defineEmits<{
  /** 关闭抽屉（父级把 group 置 null） */
  close: [];
  /** 成员增删成功（父级 store.fetch()，组列表本身无成员数，刷新是保持一致性） */
  changed: [];
}>();

// 添加/移除按钮权限（词表 IAM_GROUP.ASSIGN_MEMBERS / REMOVE_MEMBERS）
const { can } = useCan();

const isOpen = computed(() => props.group !== null);

// ---- 抽屉焦点 / Escape（关闭路径统一走 requestClose）----
const drawerRef = ref<HTMLElement | null>(null);
useDialogA11y(drawerRef, { open: isOpen, onClose: () => requestClose() });

// ---- 列表 state（与用户组列表同口径：默认 20，20/50/100）----
const PAGE_SIZES = [20, 50, 100] as const;

const items = ref<GroupMember[]>([]);
const total = ref<number>(0);
const page = ref<number>(1);
const pageSize = ref<number>(20);
/** 已生效的搜索关键词（空串 = 不过滤） */
const keyword = ref<string>("");
/** 输入框草稿（点搜索 / 回车才生效） */
const keywordInput = ref<string>("");
const loading = ref<boolean>(false);
const error = ref<string>("");

/**
 * 当前成员集合的 username（契约 §1：增删都以 username 为参数）。
 * 候选列表据此判定「已在组内」；确认添加前再校验一次，避免把已在组内的用户提交上去。
 * 口径与租户成员抽屉一致：以抽屉当前页已加载集合为准，不额外拉全量。
 */
const memberUsernames = computed<Set<string>>(
  () => new Set(items.value.map((m) => m.username)),
);

function isMember(username: string): boolean {
  return memberUsernames.value.has(username);
}

const totalPages = computed(() =>
  total.value <= 0 ? 1 : Math.ceil(total.value / pageSize.value),
);

/**
 * 请求序号：关闭抽屉 / 新请求发起后，旧响应一律丢弃 ——
 * 避免「关闭后迟到响应把已清空的列表写回来」。
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
  const group = props.group;
  if (!group) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const result = await listGroupMembers(group.code, {
      offset: (page.value - 1) * pageSize.value,
      limit: pageSize.value,
      keyword: keyword.value,
    });
    // 迟到的旧响应 / 抽屉已关闭 → 丢弃，不写 state
    if (seq !== requestSeq || !props.group) return;
    items.value = result.items;
    total.value = result.total;
    // 末页因移除变空 → 回退最后一页重查（与租户成员抽屉同口径）
    if (items.value.length === 0 && total.value > 0 && page.value > 1) {
      page.value = totalPages.value;
      await load();
    }
  } catch (err) {
    if (seq !== requestSeq || !props.group) return;
    items.value = [];
    total.value = 0;
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

/** 搜索：关键词 trim 后生效并重置到第 1 页（服务端搜索，真支持 keyword） */
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
const removeTarget = ref<GroupMember | null>(null);
const removeError = ref<string>("");
const removing = ref<boolean>(false);

function openRemove(member: GroupMember): void {
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
  const group = props.group;
  const target = removeTarget.value;
  if (!group || !target || removing.value) return;
  removing.value = true;
  removeError.value = "";
  try {
    // 契约 §1：移除载荷是 username 数组（不是 id）
    await removeGroupMembers(group.code, [target.username]);
    removeTarget.value = null;
    // 通知父级刷新用户组列表
    emit("changed");
    await load();
  } catch (err) {
    // 被拒（无权限 / 成员不存在 / 其他）→ 原样展示服务端 msg，弹窗保持打开
    removeError.value = errorMessage(err);
  } finally {
    removing.value = false;
  }
}

// ---- 添加成员（二层多选选择器，契约 §2.2）----
/** 候选用户单页条数（选择器内不分页 —— manifest「不包含批量选择分页」；搜索即重查） */
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
/** 已勾选的 username（**多选**；顺序为用户勾选顺序，提交时原样上行） */
const pickerSelected = ref<string[]>([]);
const assigning = ref<boolean>(false);
/** 添加被拒原因（服务端 msg 原文，不改写） */
const assignError = ref<string>("");

/** 候选请求序号：搜索 / 关闭后旧响应一律丢弃（与成员列表同款处理） */
let pickerSeq = 0;

/** 确认按钮可用性：未选任何候选 / 提交中 → 禁用 */
const canConfirm = computed<boolean>(
  () => pickerSelected.value.length > 0 && !assigning.value,
);

/** 是否已勾选 */
function isSelected(username: string): boolean {
  return pickerSelected.value.includes(username);
}

/**
 * 勾选 / 取消勾选一行。
 * 已在组内的候选不可选（checkbox 已 disabled，此处再兜一层）。
 * 选择**跨搜索保留**（便于多次搜索后一次提交），提交前会过滤掉已在组内的项。
 */
function toggleUser(user: User): void {
  if (assigning.value || isMember(user.username)) return;
  assignError.value = "";
  const idx = pickerSelected.value.indexOf(user.username);
  if (idx >= 0) pickerSelected.value.splice(idx, 1);
  else pickerSelected.value.push(user.username);
}

/** 拉取候选用户（关键词已生效，固定第 1 页） */
async function loadPickerUsers(): Promise<void> {
  if (!props.group || !pickerOpen.value) return;
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
  if (!props.group) return;
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

/** 关闭选择器：作废在途请求、清空状态；不发请求 */
function cancelPicker(): void {
  if (assigning.value) return;
  pickerOpen.value = false;
  pickerSeq++;
  pickerLoading.value = false;
  pickerUsers.value = [];
  pickerLoadError.value = "";
  pickerSelected.value = [];
  assignError.value = "";
}

/** 搜索候选：关键词 trim 后生效并重置到第 1 页（已勾选项跨搜索保留） */
function applyPickerSearch(): void {
  pickerKeyword.value = pickerKeywordInput.value.trim();
  assignError.value = "";
  void loadPickerUsers();
}

/**
 * 确认添加：成功 → 关闭选择器 + emit changed + 重拉成员；
 * 被拒 → 原样展示服务端 msg，选择器保持打开。
 */
async function confirmAssign(): Promise<void> {
  const group = props.group;
  if (!group || assigning.value) return;
  // 提交前二次校验：过滤掉已在组内 / 空用户名，避免把「看着已置灰的行」提交上去
  const usernames = pickerSelected.value.filter(
    (name) => name !== "" && !isMember(name),
  );
  if (usernames.length === 0) return;
  assigning.value = true;
  assignError.value = "";
  try {
    // 契约 §1：添加载荷是 username 数组（不是 id 数组）
    await assignGroupMembers(group.code, usernames);
    pickerOpen.value = false;
    pickerSeq++;
    pickerLoading.value = false;
    pickerUsers.value = [];
    pickerSelected.value = [];
    // 通知父级刷新用户组列表，并重拉当前页成员
    emit("changed");
    await load();
  } catch (err) {
    // 被拒（重复加入 / 无权限 / 用户不存在等）→ 原样展示服务端 msg
    assignError.value = errorMessage(err);
  } finally {
    assigning.value = false;
  }
}

// ---- 打开即拉取 / 关闭清理（group.code 是唯一开关）----
// 只观察 code（字符串）而非对象身份：父页每次重渲染都会新建 props 对象，
// 按身份观察会造成「无意义重拉」。
watch(
  () => props.group?.code ?? null,
  (code) => {
    if (code !== null) {
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
  if (removeTarget.value) {
    cancelRemove();
    return;
  }
  emit("close");
}

function close(): void {
  emit("close");
}

const groupName = computed(() => props.group?.name ?? "");
</script>

<template>
  <div
    v-if="group"
    class="dialog-overlay dialog-overlay--drawer"
    data-testid="group-members-drawer"
    @click.self="requestClose"
  >
    <aside
      ref="drawerRef"
      class="drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="`${groupName} · 成员`"
    >
      <header class="drawer__head">
        <h3 class="drawer__title">{{ groupName }} · 成员</h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭成员抽屉"
          data-testid="group-members-close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <!-- 工具条：关键词（服务端搜索）+ 搜索/重置；右侧「添加成员」（权限 iam:group:assign_members） -->
      <div class="drawer__toolbar">
        <input
          v-model="keywordInput"
          type="text"
          class="input drawer__search"
          placeholder="搜索用户名 / 昵称"
          aria-label="搜索组成员"
          data-testid="group-member-search"
          @keyup.enter="applySearch"
        />
        <button type="button" class="btn btn--ghost" @click="applySearch">
          搜索
        </button>
        <button type="button" class="btn btn--text" @click="resetSearch">
          重置
        </button>
        <button
          v-if="can(IAM_GROUP.ASSIGN_MEMBERS)"
          type="button"
          class="btn btn--primary drawer__add"
          data-testid="group-member-add"
          @click="openPicker"
        >
          添加成员
        </button>
      </div>

      <p class="drawer__hint muted">
        成员变更即时生效；添加或移除被服务端拒绝时，此处展示原始原因。
      </p>

      <!-- 错误态：服务端 msg 原文 + 重试 -->
      <p
        v-if="error"
        class="state-error"
        role="alert"
        data-testid="group-member-error"
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
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in items"
                :key="m.id"
                data-testid="group-member-row"
              >
                <td class="mono">{{ m.username }}</td>
                <td>{{ m.nickname || "—" }}</td>
                <td>{{ m.email || "—" }}</td>
                <td>
                  <button
                    v-if="can(IAM_GROUP.REMOVE_MEMBERS)"
                    type="button"
                    class="btn btn--text btn--danger"
                    data-testid="group-member-remove"
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
          data-testid="group-member-empty"
        >
          <p>{{ keyword ? "没有匹配的成员" : "该用户组暂无成员" }}</p>
          <p v-if="keyword" class="muted">试试更换关键词</p>
          <p v-else class="muted">可用「添加成员」把用户加入该组。</p>
        </div>
      </div>

      <!-- 分页（与用户组列表同口径：20 / 50 / 100） -->
      <footer v-if="total > 0" class="drawer__foot">
        <nav
          class="pagination"
          data-testid="group-member-pagination"
          aria-label="成员分页"
        >
          <button
            type="button"
            class="btn btn--text"
            data-testid="group-member-prev"
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
            data-testid="group-member-next"
            :disabled="page >= totalPages"
            @click="changePage(page + 1)"
          >
            下一页
          </button>
          <select
            class="input pagination__size"
            aria-label="每页条数"
            data-testid="group-member-page-size"
            :value="pageSize"
            @change="changePageSize"
          >
            <option v-for="size in PAGE_SIZES" :key="size" :value="size">
              {{ size }} 条/页
            </option>
          </select>
        </nav>
      </footer>

      <!-- 添加成员：抽屉内二层多选选择器（原生元素，不引入组件库） -->
      <div v-if="pickerOpen" class="picker-overlay" @click.self="cancelPicker">
        <div
          class="picker"
          role="dialog"
          aria-modal="true"
          aria-label="添加成员"
          data-testid="group-member-picker"
        >
          <header class="picker__head">
            <h3 class="picker__title">添加成员</h3>
          </header>

          <div class="picker__body">
            <!-- 搜索：Enter / 「搜索」触发 -->
            <div class="picker__search-row">
              <input
                v-model="pickerKeywordInput"
                type="text"
                class="input picker__search"
                placeholder="搜索用户名 / 昵称"
                aria-label="搜索候选用户"
                data-testid="group-member-picker-search"
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
              data-testid="group-member-picker-error"
            >
              {{ assignError }}
            </p>

            <!-- 候选加载失败：原文 + 重试 -->
            <p
              v-if="pickerLoadError"
              class="form-error"
              role="alert"
              data-testid="group-member-picker-load-error"
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
                data-testid="group-member-picker-empty"
              >
                未找到用户
              </p>

              <ul v-else-if="pickerUsers.length > 0" class="picker__rows">
                <li v-for="u in pickerUsers" :key="u.id">
                  <label
                    class="picker__row"
                    :class="{
                      'is-selected': isSelected(u.username),
                      'is-in-group': isMember(u.username),
                    }"
                    data-testid="group-member-picker-row"
                  >
                    <input
                      type="checkbox"
                      class="picker__checkbox"
                      :checked="isSelected(u.username)"
                      :disabled="isMember(u.username)"
                      :aria-label="`选择 ${u.username}`"
                      @change="toggleUser(u)"
                    />
                    <span class="picker__row-name">{{
                      u.displayName || u.username
                    }}</span>
                    <span class="picker__row-username muted">{{
                      u.username
                    }}</span>
                    <span v-if="isMember(u.username)" class="picker__row-badge"
                      >已在组内</span
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
              data-testid="group-member-picker-cancel"
              @click="cancelPicker"
            >
              取消
            </button>
            <button
              type="button"
              class="btn btn--primary"
              data-testid="group-member-picker-confirm"
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
        data-testid="group-member-remove-dialog"
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
            确认将 <strong>{{ removeTarget.username }}</strong> 从用户组
            <strong>{{ groupName }}</strong> 中移除？
          </p>
          <!-- 被拒原因：eiam msg 原文 -->
          <p
            v-if="removeError"
            class="form-error"
            role="alert"
            data-testid="group-member-remove-error"
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
            data-testid="group-member-remove-confirm"
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
/* 遮罩：沿用用户组列表 .dialog-overlay 语言，抽屉贴右 */
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
  width: min(720px, 100%);
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

  /* 「添加成员」靠工具条右侧 */
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
  min-width: 520px;
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

/* ---- 添加成员选择器（抽屉内二层弹层，多选）---- */
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

    /* 已在组内：整行不可选（置灰） */
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

/* 窄屏 375px：抽屉占满视口，工具条与分页换行，表格在容器内横向滚动 */
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
