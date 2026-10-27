<script setup lang="ts">
/**
 * 角色详情/绑定子页（UF-8，task 5.1）—— 路由 /roles/:id。
 *
 * 参照：ui-design UF-8 Secondary Page（Layout/Interactions/Data Binding）+ tech-design §Interfaces
 * + parity-checklist §2.8/D-3/G-6。
 *
 * 布局：页头（返回 + 角色名 + 保存）→ 角色名/所属租户 → 策略绑定多选 + 用户绑定多选（支持搜索）。
 * 双多选在整页承载（避免 Dialog 内可用性问题，ui-design 明示）。
 *
 * 数据（AC-5：单条角色按 code 查询填充子页）：
 * - getRoleDetail(code)（C 档，按 code 查询——eiam role/detail/:code）；
 * - listPoliciesForRole(code)（C 档 D-3 改判路径：policy/list/attached/role，已绑策略回显）；
 * - listBindablePolicies(q)（C 档：policy/list，**仅列 eiam 可绑定策略，无策略定义入口**——Hard Rule）；
 * - listUsersByRole(code)（A 档：user/list/attached/role，已绑用户回显）；
 * - listUsers(q)（A 档：user/list，用户绑定多选搜索源）。
 *
 * 保存（AC-3/AC-5）：
 * - updateRole（name/desc）→ roleList store.update（写前守卫 + fetch 刷新）；
 * - 策略 diff：attachPoliciesToRole / detachPoliciesFromRole（D-3：policy 侧承载）；
 * - 用户 diff：assignUsersToRole / unassignUsersFromRole（A 档：role/batch_assign，以 code 为准）。
 * 保存成功 → 返回 /roles，列表 ≤2s 刷新（store.update/fetch 已刷新）。
 *
 * Hard Rules：
 * - 策略绑定多选仅列 eiam 可绑定策略，无新建/编辑/删除策略入口（本页仅绑定，不定义策略）；
 * - 角色 code 创建后不可改（update 只读回传原 code）。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter, onBeforeRouteLeave } from "vue-router";
import { ElMessageBox } from "element-plus";
import { useRoleListStore } from "@/stores/roleList";
import { useUserStore } from "@/stores/user";
import {
  getRoleDetail,
  listBindablePolicies,
  listPoliciesForRole,
  type PolicyRef,
} from "@/api/roles";
import { listUsers, listUsersByRole } from "@/api/users";
import { ApiError, type Role, type User } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { useCan } from "@/composables/useCan";
import { useErrorReveal } from "@/composables/useErrorReveal";
import { IAM_POLICY, IAM_ROLE } from "@/config/permission-codes";

const route = useRoute();
const router = useRouter();
const store = useRoleListStore();
const userStore = useUserStore();

// P0 权限码裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）：
// 基本信息 → iam:role:edit；策略绑定 → iam:policy:batch_attach|batch_detach；
// 用户绑定 → iam:role:batch_assign|batch_unassign。
const { can, canSome } = useCan();
const canEditRole = computed(() => can(IAM_ROLE.EDIT));
const canManagePolicyBind = computed(() =>
  canSome([IAM_POLICY.BATCH_ATTACH, IAM_POLICY.BATCH_DETACH]),
);
const canManageUserBind = computed(() =>
  canSome([IAM_ROLE.BATCH_ASSIGN, IAM_ROLE.BATCH_UNASSIGN]),
);

// 路由 :id 实为角色 code（eiam role/detail 按 code 查询，非 id）
const roleCode = computed(() => decodeURIComponent(String(route.params.id)));

// ---- 表单态 ----
const loading = ref(false);
const error = ref<string>("");
const saving = ref(false);
const saveError = ref<string>("");
const role = ref<Role | null>(null);

// 可编辑字段（code 只读）
const roleName = ref("");
const roleDesc = ref("");

// ---- 策略绑定 ----
const policyOptions = ref<PolicyRef[]>([]);
const originalPolicyCodes = ref<string[]>([]);
const selectedPolicyCodes = ref<string[]>([]);

// ---- 用户绑定 ----
const boundUsers = ref<User[]>([]);
const originalUsernames = ref<string[]>([]);
const selectedUsernames = ref<string[]>([]);
const userSearchKeyword = ref("");
const userSearchLoading = ref(false);
const userSearchResults = ref<User[]>([]);

// ---- 所属租户展示 ----
const tenantName = computed(() => {
  const tid = role.value?.tenantId || userStore.currentTenantId;
  const t = userStore.tenants.find((x) => x.id === tid);
  return t?.name ?? (tid ? `租户 ${tid}` : "—");
});

// ---- diff 计算 ----
const policyDelta = computed(() => {
  const from = new Set(originalPolicyCodes.value);
  const to = new Set(selectedPolicyCodes.value);
  return {
    added: selectedPolicyCodes.value.filter((c) => !from.has(c)),
    removed: originalPolicyCodes.value.filter((c) => !to.has(c)),
  };
});

const userDelta = computed(() => {
  const from = new Set(originalUsernames.value);
  const to = new Set(selectedUsernames.value);
  return {
    added: selectedUsernames.value.filter((u) => !from.has(u)),
    removed: originalUsernames.value.filter((u) => !to.has(u)),
  };
});

const hasChanges = computed(() => {
  if (policyDelta.value.added.length > 0 || policyDelta.value.removed.length > 0)
    return true;
  if (userDelta.value.added.length > 0 || userDelta.value.removed.length > 0)
    return true;
  if (!role.value) return false;
  return (
    roleName.value !== role.value.name || roleDesc.value !== role.value.desc
  );
});

function togglePolicy(code: string): void {
  const idx = selectedPolicyCodes.value.indexOf(code);
  if (idx >= 0) selectedPolicyCodes.value.splice(idx, 1);
  else selectedPolicyCodes.value.push(code);
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

// ---- 加载详情 + 回显 + 选项 ----
async function loadDetail(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [detail, policies, bound, policiesPage] = await Promise.all([
      getRoleDetail(roleCode.value),
      listPoliciesForRole(roleCode.value),
      listUsersByRole(roleCode.value, { offset: 0, limit: 100, keyword: "" }),
      listBindablePolicies({ offset: 0, limit: 100, keyword: "" }),
    ]);
    policyOptions.value = policiesPage.items;
    if (!detail) {
      error.value = "角色不存在或已删除";
      return;
    }
    role.value = detail;
    roleName.value = detail.name;
    roleDesc.value = detail.desc;
    // 策略回显
    originalPolicyCodes.value = policies.map((p) => p.code);
    selectedPolicyCodes.value = [...originalPolicyCodes.value];
    // 用户回显（Ref 形 {id, name}；name 为 username）
    boundUsers.value = bound.items;
    originalUsernames.value = bound.items.map((u) => u.username);
    selectedUsernames.value = [...originalUsernames.value];
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

// ---- 用户搜索（绑定多选支持搜索，AC-3）----
async function searchUsers(): Promise<void> {
  const kw = userSearchKeyword.value.trim();
  userSearchLoading.value = true;
  try {
    const result = await listUsers({
      offset: 0,
      limit: 50,
      keyword: kw,
    });
    // 排除已选中用户
    const selected = new Set(selectedUsernames.value);
    userSearchResults.value = result.items.filter((u) => !selected.has(u.username));
  } catch {
    userSearchResults.value = [];
  } finally {
    userSearchLoading.value = false;
  }
}

function addSearchedUser(u: User): void {
  if (!selectedUsernames.value.includes(u.username)) {
    selectedUsernames.value.push(u.username);
    boundUsers.value.push(u);
  }
  userSearchKeyword.value = "";
  userSearchResults.value = [];
}

function removeBoundUser(username: string): void {
  const idx = selectedUsernames.value.indexOf(username);
  if (idx >= 0) selectedUsernames.value.splice(idx, 1);
}

onMounted(loadDetail);

// ---- 保存（AC-3/AC-5：保存返回列表 ≤2s 刷新）----
async function save(): Promise<void> {
  if (!role.value) return;
  saveError.value = "";
  saving.value = true;
  try {
    // 1. 更新角色基本信息（写前守卫 + fetch）
    const ok = await store.update({
      id: role.value.id,
      name: roleName.value,
      code: role.value.code,
      desc: roleDesc.value || undefined,
    });
    if (!ok) {
      saveError.value = store.error ?? "保存失败";
      return;
    }
    // 2. 策略 diff（D-3：policy 侧承载，写前守卫）
    if (policyDelta.value.added.length > 0 || policyDelta.value.removed.length > 0) {
      const pok = await store.applyPolicyDelta(
        role.value.code,
        policyDelta.value.added,
        policyDelta.value.removed,
      );
      if (!pok) {
        saveError.value = store.error ?? "策略绑定失败";
        return;
      }
    }
    // 3. 用户 diff（A 档：role/batch_assign，以 code 为准，写前守卫）
    if (userDelta.value.added.length > 0 || userDelta.value.removed.length > 0) {
      const uok = await store.applyUserDelta(
        role.value.code,
        userDelta.value.added,
        userDelta.value.removed,
      );
      if (!uok) {
        saveError.value = store.error ?? "用户绑定失败";
        return;
      }
    }
    // 保存成功 → 返回列表（store.update/fetch 已刷新，列表 ≤2s 刷新）
    allowLeave.value = true; // 保存成功是合法离开，跳过未保存拦截
    void router.push("/roles");
  } catch (err) {
    saveError.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

function back(): void {
  void router.push("/roles");
}

/**
 * 未保存离开拦截（唯一入口，覆盖四条路径）：
 * 「取消」按钮、「返回角色列表」、侧栏跳转、浏览器后退——最终都走路由跳转，
 * 故用 onBeforeRouteLeave 一处覆盖。原先四条路径全部静默丢弃编辑（审计实测）。
 * 保存成功后先置 allowLeave，避免「保存→返回列表」被自己的守卫拦住。
 */
const allowLeave = ref(false);
onBeforeRouteLeave(async () => {
  if (allowLeave.value || !hasChanges.value) return true;
  try {
    await ElMessageBox.confirm(
      "当前修改尚未保存，离开将丢失这些改动。",
      "有未保存的修改",
      {
        type: "warning",
        confirmButtonText: "放弃修改并离开",
        cancelButtonText: "继续编辑",
        distinguishCancelAndClose: true,
      },
    );
    return true;
  } catch {
    // 取消 / 关闭：留在当前页继续编辑
    return false;
  }
});

// ---- 保存失败必须被看见：滚入视口 + 聚焦（窄屏滚到底提交时，提示原先在视口外）----
const saveErrorRef = ref<HTMLElement | null>(null);
useErrorReveal(saveError, saveErrorRef);
</script>

<template>
  <section class="page-role-detail" :aria-busy="loading">
    <header class="detail-head">
      <button type="button" class="btn btn--text" @click="back">
        ← 返回角色列表
      </button>
      <h2 class="detail-title">{{ role?.name ?? "角色详情" }}</h2>
      <button
        v-if="canEditRole"
        type="button"
        class="btn btn--primary"
        :disabled="loading || saving || !hasChanges"
        data-testid="save-role"
        @click="save"
      >
        {{ saving ? "保存中…" : "保存" }}
      </button>
    </header>

    <p v-if="error" class="state-error" role="alert">
      <CopyContractText :code="error" tag="span" />
      <button type="button" class="btn btn--text" @click="back">
        返回列表
      </button>
    </p>

    <div v-else-if="loading" class="skeleton" aria-hidden="true">
      <div v-for="i in 6" :key="i" class="skeleton__row" />
    </div>

    <form v-else-if="role" class="detail-form" @submit.prevent="save">
      <p
        v-if="saveError"
        ref="saveErrorRef"
        class="form-error"
        role="alert"
        tabindex="-1"
        data-testid="save-error"
      >
        <CopyContractText :code="saveError" tag="span" />
      </p>

      <fieldset class="form-section">
        <legend>基本信息</legend>
        <label class="field">
          <span class="field__label">角色 code</span>
          <input
            :value="role.code"
            type="text"
            class="input"
            readonly
            data-testid="detail-role-code"
          />
          <span class="muted">稳定标识，创建后不可改</span>
        </label>
        <label class="field">
          <span class="field__label">角色名</span>
          <input
            v-model="roleName"
            type="text"
            class="input"
            data-testid="detail-role-name"
            :disabled="!canEditRole"
          />
          <span class="muted">1–64 字符，租户内唯一（eiam 校验）</span>
        </label>
        <label class="field">
          <span class="field__label">描述</span>
          <textarea
            v-model="roleDesc"
            class="input input--textarea"
            rows="2"
            :disabled="!canEditRole"
          />
        </label>
        <div class="field">
          <span class="field__label">所属租户</span>
          <span class="muted">{{ tenantName }}</span>
        </div>
      </fieldset>

      <!-- 策略绑定多选（Hard Rule：仅列 eiam 可绑定策略，无策略定义入口）-->
      <fieldset class="form-section">
        <legend>策略绑定</legend>
        <p class="muted">
          仅列 eiam 返回的可绑定策略；本页不提供策略新建/编辑/删除入口。
          绑定变更需持有 iam:policy:batch_attach / batch_detach。
        </p>
        <div v-if="canManagePolicyBind" class="checkbox-group">
          <label
            v-for="p in policyOptions"
            :key="p.code"
            class="checkbox-item"
          >
            <input
              type="checkbox"
              :value="p.code"
              :checked="selectedPolicyCodes.includes(p.code)"
              data-testid="policy-bind"
              @change="togglePolicy(p.code)"
            />
            {{ p.name }}
          </label>
          <span v-if="policyOptions.length === 0" class="muted"
            >无可绑定策略</span
          >
        </div>
        <p v-else class="muted">
          当前绑定：{{ selectedPolicyCodes.join("、") || "无" }}（只读，缺绑定码）
        </p>
        <p
          v-if="
            canManagePolicyBind &&
            (policyDelta.added.length || policyDelta.removed.length)
          "
          class="muted"
        >
          待应用：新增 {{ policyDelta.added.length }} 项 / 移除
          {{ policyDelta.removed.length }} 项
        </p>
      </fieldset>

      <!-- 用户绑定多选（支持搜索，AC-3 整页承载）-->
      <fieldset class="form-section">
        <legend>用户绑定</legend>
        <p class="muted">
          已绑用户（{{ selectedUsernames.length }}）；绑定变更需持有
          iam:role:batch_assign / batch_unassign。
        </p>
        <ul class="bound-list">
          <li
            v-for="username in selectedUsernames"
            :key="username"
            class="bound-item"
          >
            <span>{{ username }}</span>
            <button
              v-if="canManageUserBind"
              type="button"
              class="btn btn--text btn--danger btn--sm"
              :data-testid="`unbind-user-${username}`"
              @click="removeBoundUser(username)"
            >
              移除
            </button>
          </li>
          <li v-if="selectedUsernames.length === 0" class="muted">
            暂无绑定用户
          </li>
        </ul>

        <!-- 用户搜索（绑定多选支持搜索）-->
        <template v-if="canManageUserBind">
          <div class="user-search">
            <input
              v-model="userSearchKeyword"
              type="text"
              class="input"
              placeholder="搜索用户名添加"
              data-testid="user-search-input"
              @keyup.enter="searchUsers"
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              :disabled="userSearchLoading"
              @click="searchUsers"
            >
              {{ userSearchLoading ? "搜索中…" : "搜索" }}
            </button>
          </div>
          <ul v-if="userSearchResults.length > 0" class="search-results">
            <li
              v-for="u in userSearchResults"
              :key="u.id"
              class="search-item"
            >
              <span>{{ u.username }}</span>
              <button
                type="button"
                class="btn btn--text btn--sm"
                :data-testid="`add-user-${u.username}`"
                @click="addSearchedUser(u)"
              >
                添加
              </button>
            </li>
          </ul>
        </template>
        <p
          v-if="
            canManageUserBind &&
            (userDelta.added.length || userDelta.removed.length)
          "
          class="muted"
        >
          待应用：新增 {{ userDelta.added.length }} 项 / 移除
          {{ userDelta.removed.length }} 项
        </p>
      </fieldset>

      <div class="detail-actions">
        <button type="button" class="btn btn--ghost" @click="back">
          取消
        </button>
        <button
          v-if="canEditRole"
          type="submit"
          class="btn btn--primary"
          :disabled="saving || !hasChanges"
          data-testid="save-role-submit"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped lang="scss">
.page-role-detail {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  flex: 1;
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

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

// 错误态：与「用户详情」统一为红色告警条（原先只有一行居中小灰字，夹在表单中间几乎看不见）
.state-error {
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

.skeleton__row {
  height: 40px;
  margin: 8px 0;
  background: var(--tag-bg);
  border-radius: 6px;
}

.form-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

.detail-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
  // 长表单收窄阅读宽度：原先通栏（1440 下 input 宽 1081px），长句跨整屏难读。
  // 用户详情是 640px；角色详情含「绑定策略/已绑用户」列表，略放宽到 860px。
  max-width: 860px;
}

.form-section {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px 20px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;

  legend {
    padding: 0 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-regular);
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

.bound-list,
.search-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bound-item,
.search-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-regular);
}

.user-search {
  display: flex;
  gap: 8px;
  align-items: center;
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
