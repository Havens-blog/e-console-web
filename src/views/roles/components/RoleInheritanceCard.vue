<script setup lang="ts">
/**
 * 角色继承关系卡片（feat-role-inheritance 契约 §2.2）。
 *
 * 入口：角色详情页（`src/views/roles/RoleDetail.vue`）新增的独立区块 —— 查看该角色的父角色
 * （直接/间接、是否不可移除）、添加父角色、移除父角色。后端零改动（三个端点已存在）。
 *
 * 数据流（契约 §1 / §2.2）：
 * - roleCode 变化（打开）→ 并行拉取：
 *   ① listParentRoles(roleCode)：`/role/parents` 的 data 是**数组**（非分页信封），
 *      **只有 code 不含名称** → 名称由 ② 的全量角色本地映射，查不到回退展示 code；
 *   ② listRolesPage 翻页拉齐全量角色（复用既有列表接口，不重复实现）——既是名称来源，
 *      也是添加候选源。
 * - 添加：候选 = 全量角色**排除自身与已有父角色** → 选中 + 确认 → addParentRole(roleCode,
 *   parentRoleCode) → 成功后**重拉父角色列表**（候选按父角色集合动态过滤）；
 *   被拒（成环 / 重复 / 无权限）→ 原位展示 ApiError.message **原文**，不改写。
 * - 移除：行内「移除」→ 二次确认（`role-inheritance-remove-dialog`）→ removeParentRole →
 *   成功后重拉父角色列表；被拒 → 确认框内展示服务端 msg 原文。
 * - `is_immutable=true` 的行：移除按钮**禁用**（不是隐藏，让用户看见为何不能动），
 *   提交函数内再做一次兜底判断，绝不把不可移除项提交给服务端。
 *
 * 权限（词表 `config/permission-codes.ts`，仅体验层裁剪，服务端 OPA 为唯一安全边界）：
 * - 添加区（选择器 + 确认）需 `iam:role:add_parent`，缺失则不渲染；
 * - 行内移除需 `iam:role:remove_parent`，缺失则不渲染。
 * 整卡是否渲染由详情页按 `iam:role:view_parents` 决定。
 *
 * 本区块**无时间字段**，不引入任何时间格式化。交互写法照搬上一轮
 * `views/groups/GroupRolesDialog.vue`（候选排除 / 二次确认 / 被拒原文 / 请求序号丢弃迟到响应），
 * 原生元素，**不使用 Element Plus 组件、不引入新依赖**。
 */
import { computed, ref, watch } from "vue";
import {
  addParentRole,
  listParentRoles,
  listRolesPage,
  removeParentRole,
  type RoleInheritance,
} from "@/api/roles";
import { ApiError, type Role } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_ROLE } from "@/config/permission-codes";

const props = defineProps<{
  /** 当前角色 code（继承端点以 code 为键，非 id） */
  roleCode: string;
  /** 当前角色名（移除确认文案展示；缺省回退 roleCode） */
  roleName?: string;
}>();

// 添加 / 移除入口的按钮级裁剪（词表 IAM_ROLE.ADD_PARENT / REMOVE_PARENT）
const { can } = useCan();
const canAdd = computed<boolean>(() => can(IAM_ROLE.ADD_PARENT));
const canRemove = computed<boolean>(() => can(IAM_ROLE.REMOVE_PARENT));

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案、不做二次改写
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

// ---- 父角色列表 ----
const parents = ref<RoleInheritance[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");
/** 请求序号：角色切换后，旧响应一律丢弃（迟到响应不写回 state） */
let requestSeq = 0;

/** 父角色 code 集合（候选据此排除；提交前二次校验也用） */
const parentCodes = computed<Set<string>>(
  () => new Set(parents.value.map((p) => p.code)),
);

async function loadParents(): Promise<void> {
  if (props.roleCode === "") return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const list = await listParentRoles(props.roleCode);
    if (seq !== requestSeq) return;
    parents.value = list;
  } catch (err) {
    if (seq !== requestSeq) return;
    parents.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

// ---- 全量角色（名称映射 + 添加候选源）----
/** 候选角色分页拉取条数（listRolesPage 是分页接口，需翻页凑齐全量） */
const CANDIDATE_PAGE_SIZE = 100;
/** 翻页上限（防御服务端 total 异常导致的死循环） */
const CANDIDATE_MAX_PAGES = 50;

const allRoles = ref<Role[]>([]);
const candidatesLoading = ref<boolean>(false);
/** 候选/名称源加载失败（服务端 msg 原文；不阻断父角色列表展示，名称回退 code） */
const candidatesError = ref<string>("");
let rolesSeq = 0;

/** code → 角色名（查不到回退 code，契约 §1） */
const roleNames = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const r of allRoles.value) {
    if (r.code !== "") map.set(r.code, r.name || r.code);
  }
  return map;
});

function nameOf(code: string): string {
  return roleNames.value.get(code) ?? code;
}

/** 翻页拉取全量角色（复用 listRolesPage，不重复实现角色列表） */
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

async function loadRoles(): Promise<void> {
  if (props.roleCode === "") return;
  const seq = ++rolesSeq;
  candidatesLoading.value = true;
  candidatesError.value = "";
  try {
    const all = await fetchAllRoles();
    if (seq !== rolesSeq) return;
    allRoles.value = all;
  } catch (err) {
    if (seq !== rolesSeq) return;
    allRoles.value = [];
    candidatesError.value = errorMessage(err);
  } finally {
    if (seq === rolesSeq) candidatesLoading.value = false;
  }
}

/** 候选：全量角色中**排除自身与已有父角色**的部分（契约 §2.2 核心语义） */
const candidates = computed<Role[]>(() =>
  allRoles.value.filter(
    (r) =>
      r.code !== "" &&
      r.code !== props.roleCode &&
      !parentCodes.value.has(r.code),
  ),
);

// ---- 添加父角色 ----
const selectedParentCode = ref<string>("");
const adding = ref<boolean>(false);
/** 添加被拒原因（服务端 msg 原文，不改写） */
const addError = ref<string>("");

/** 确认按钮可用性：未选 / 提交中 → 禁用（防重复点击） */
const canConfirmAdd = computed<boolean>(
  () => selectedParentCode.value !== "" && !adding.value,
);

/**
 * 确认添加：成功 → 清空选择并**重拉父角色列表**（候选自动排除新父角色）；
 * 被拒 → 原样展示服务端 msg，选择保留以便用户改选。
 */
async function confirmAdd(): Promise<void> {
  const parentCode = selectedParentCode.value;
  if (props.roleCode === "" || parentCode === "" || adding.value) return;
  // 提交前二次校验：不把「界面上看着可选、实际已合法」的父角色提交上去
  if (parentCode === props.roleCode || parentCodes.value.has(parentCode)) return;
  adding.value = true;
  addError.value = "";
  try {
    await addParentRole(props.roleCode, parentCode);
    selectedParentCode.value = "";
    await loadParents();
  } catch (err) {
    // 被拒（成环 / 重复 / 无权限等）→ 原样展示服务端 msg
    addError.value = errorMessage(err);
  } finally {
    adding.value = false;
  }
}

// ---- 移除父角色（行内 + 二次确认）----
const removeTarget = ref<RoleInheritance | null>(null);
const removeError = ref<string>("");
const removing = ref<boolean>(false);

const removeTargetName = computed(() =>
  removeTarget.value ? nameOf(removeTarget.value.code) : "",
);

// 二次确认的键盘 / 焦点（Escape 关闭、Tab 不出框）；关闭路径统一走 cancelRemove
const removeDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(removeDialogRef, {
  open: computed(() => removeTarget.value !== null),
  onClose: () => cancelRemove(),
});

function openRemove(parent: RoleInheritance): void {
  // 不可移除项：按钮已 disabled，此处再兜一层（防御编程触发路径）
  if (parent.isImmutable) return;
  removeTarget.value = parent;
  removeError.value = "";
  removing.value = false;
}

function cancelRemove(): void {
  if (removing.value) return;
  removeTarget.value = null;
  removeError.value = "";
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value;
  if (props.roleCode === "" || !target || removing.value) return;
  if (target.isImmutable) return;
  removing.value = true;
  removeError.value = "";
  try {
    await removeParentRole(props.roleCode, target.code);
    removeTarget.value = null;
    await loadParents();
  } catch (err) {
    // 被拒（不可移除 / 未绑定 / 无权限等）→ 原样展示服务端 msg，确认框保持打开
    removeError.value = errorMessage(err);
  } finally {
    removing.value = false;
  }
}

// ---- 打开即拉取 / 换角色重拉（roleCode 是唯一开关）----
// 只观察 code（字符串）而非对象身份，避免父页重渲染造成无意义重拉。
watch(
  () => props.roleCode,
  (code) => {
    parents.value = [];
    error.value = "";
    loading.value = false;
    allRoles.value = [];
    candidatesError.value = "";
    candidatesLoading.value = false;
    selectedParentCode.value = "";
    addError.value = "";
    adding.value = false;
    removeTarget.value = null;
    removeError.value = "";
    removing.value = false;
    if (code === "") {
      requestSeq++;
      rolesSeq++;
      return;
    }
    void loadParents();
    void loadRoles();
  },
  { immediate: true },
);
</script>

<template>
  <section
    class="inheritance-card"
    data-testid="role-inheritance"
    :aria-busy="loading"
  >
    <header class="inheritance-card__head">
      <h3 class="inheritance-card__title">继承关系</h3>
      <p class="muted inheritance-card__hint">
        父角色的权限会被当前角色继承；「间接」为继承链上游，「不可移除」由系统维护。
      </p>
    </header>

    <!-- 添加父角色：仅 iam:role:add_parent；候选已排除自身与已有父角色 -->
    <div v-if="canAdd" class="inheritance-add">
      <select
        v-model="selectedParentCode"
        class="input inheritance-add__select"
        aria-label="选择要添加的父角色"
        data-testid="role-inheritance-add-select"
        :disabled="adding || candidatesLoading || candidates.length === 0"
      >
        <option value="">
          {{ candidatesLoading ? "加载候选角色…" : "选择父角色" }}
        </option>
        <option v-for="r in candidates" :key="r.code" :value="r.code">
          {{ r.name }}（{{ r.code }}）
        </option>
      </select>
      <button
        type="button"
        class="btn btn--primary"
        data-testid="role-inheritance-add-confirm"
        :disabled="!canConfirmAdd"
        @click="confirmAdd"
      >
        {{ adding ? "添加中…" : "添加父角色" }}
      </button>
    </div>

    <!-- 候选全被排除（或本就没有其他角色）时的说明 -->
    <p
      v-if="canAdd && !candidatesLoading && !candidatesError && candidates.length === 0"
      class="muted"
      data-testid="role-inheritance-add-empty"
    >
      没有可添加的父角色（已排除自身与已有父角色）
    </p>

    <!-- 候选 / 名称源加载失败：原文 + 重试（不阻断父角色列表，名称回退 code）。
         仅对可添加的用户展示重试条：纯查看用户拿不到角色列表时，名称回退 code 已足够，
         不必为一个「他本来也不能用」的请求显示报错。 -->
    <p
      v-if="canAdd && candidatesError"
      class="form-error"
      role="alert"
      data-testid="role-inheritance-candidates-error"
    >
      {{ candidatesError }}
      <button type="button" class="btn btn--text" @click="loadRoles">
        重试
      </button>
    </p>

    <!-- 添加被拒：eiam msg 原文 -->
    <p
      v-if="addError"
      class="form-error"
      role="alert"
      data-testid="role-inheritance-add-error"
    >
      {{ addError }}
    </p>

    <!-- 加载态 -->
    <div v-if="loading" class="skeleton" aria-hidden="true">
      <div v-for="i in 3" :key="i" class="skeleton__row" />
    </div>

    <!-- 父角色列表 -->
    <ul v-else-if="parents.length > 0" class="inheritance-list">
      <li
        v-for="p in parents"
        :key="p.code"
        class="inheritance-row"
        data-testid="role-inheritance-row"
        :data-role-code="p.code"
      >
        <span class="inheritance-row__name">{{ nameOf(p.code) }}</span>
        <span class="inheritance-row__code mono">{{ p.code }}</span>
        <span class="badge">{{ p.isDirect ? "直接" : "间接" }}</span>
        <span v-if="p.isImmutable" class="badge badge--locked">
          不可移除
        </span>
        <button
          v-if="canRemove"
          type="button"
          class="btn btn--text btn--danger inheritance-row__remove"
          data-testid="role-inheritance-remove"
          :disabled="p.isImmutable"
          :title="p.isImmutable ? '该父角色由系统维护，不可手动移除' : undefined"
          @click="openRemove(p)"
        >
          移除
        </button>
      </li>
    </ul>

    <!-- 空态 -->
    <div
      v-else-if="!error"
      class="state-empty"
      data-testid="role-inheritance-empty"
    >
      <p>该角色暂无父角色</p>
      <p v-if="canAdd" class="muted">可用上方选择器为其添加一个父角色。</p>
    </div>

    <!-- 加载错误：服务端 msg 原文 + 重试 -->
    <p
      v-if="error"
      class="state-error"
      role="alert"
      data-testid="role-inheritance-error"
    >
      {{ error }}
      <button type="button" class="btn btn--text" @click="loadParents">
        重试
      </button>
    </p>

    <!-- 移除二次确认 -->
    <div
      v-if="removeTarget"
      ref="removeDialogRef"
      class="dialog-overlay"
      @click.self="cancelRemove"
    >
      <div
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label="移除父角色"
        data-testid="role-inheritance-remove-dialog"
      >
        <header class="dialog__head">
          <h3>移除父角色</h3>
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
            确认将父角色
            <strong>{{ removeTargetName }}</strong>
            从角色 <strong>{{ roleName || roleCode }}</strong> 的继承关系中移除？
          </p>
          <!-- 被拒原因：eiam msg 原文 -->
          <p
            v-if="removeError"
            class="form-error"
            role="alert"
            data-testid="role-inheritance-remove-error"
          >
            {{ removeError }}
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="removing"
            data-testid="role-inheritance-remove-cancel"
            @click="cancelRemove"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="removing"
            data-testid="role-inheritance-remove-confirm"
            @click="confirmRemove"
          >
            {{ removing ? "移除中…" : "确认移除" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.inheritance-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text-primary);
}

.inheritance-card__head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.inheritance-card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-regular);
}

.inheritance-card__hint {
  margin: 0;
}

.inheritance-add {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.inheritance-add__select {
  flex: 1 1 240px;
  min-width: 0;
}

.inheritance-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inheritance-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-regular);

  &__name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__code {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 移除按钮靠右，标记紧邻名称 */
  &__remove {
    margin-left: auto;
  }
}

.badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.8;
  white-space: nowrap;

  &--locked {
    color: var(--color-warning, var(--color-danger));
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

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.state-empty,
.state-error {
  padding: 16px 8px;
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
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

.skeleton__row {
  height: 36px;
  margin: 6px 0;
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

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.dialog {
  width: 100%;
  max-width: 400px;
  max-height: 85vh;
  overflow-y: auto;
  background: var(--bg-elevated);
  border-radius: 8px;
  box-shadow: var(--shadow-base);

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

/* 窄屏：选择器与确认按钮换行，行内标记换行不挤压 */
@media (max-width: 480px) {
  .inheritance-card {
    padding: 12px;
  }

  .inheritance-add__select {
    flex-basis: 100%;
  }

  .inheritance-row {
    flex-wrap: wrap;
  }
}
</style>
