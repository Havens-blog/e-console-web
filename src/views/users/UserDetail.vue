<script setup lang="ts">
/**
 * 用户详情/编辑子页（UF-4，task 4.2）—— 路由 /users/:id。
 *
 * 参照：ui-design UF-4 Secondary Page（Layout/Interactions/Data Binding）+ tech-design §Interfaces。
 *
 * 布局：页头（返回 + 用户名 + 保存）→ 表单（用户名只读/登录方式/角色绑定多选/所属租户组织/状态）
 * → passkey 注册引导区块。
 *
 * 数据：getUserDetail（C 档）+ listRolesForUser（A 档，角色回显）+ listRoles（A 档，绑定多选源）。
 *
 * 保存（AC-4）：updateUser + 角色 diff（batch_assign/unassign）→ userList store.update（写前守卫
 * + fetch 刷新）→ 返回 /users，列表 ≤2s 刷新（store.update 内部已 fetch）。
 *
 * 降级（Phase 0）：
 * - 用户名只读（稳定标识，不可改）
 * - 登录方式：list/detail 不直出，缺省 'password'（只读展示）
 * - 所属组织：User.orgRef 无数据源（G 类缺口）→ '—'，不可编辑
 * - G-2/G-3：passkey 仅展示绑定态（bound-state display），管理员代发起注册/撤销不可用，
 *   引导用户走 eiam 自助注册流程；passkey 唯一登录方式且回收走 reset_password（E1，G-1 待排期）。
 * - G-9：状态仅 active/disable/unknown（无 locked）。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessageBox } from "element-plus";
import { useUserListStore } from "@/stores/userList";
import { useUserStore } from "@/stores/user";
import { getUserDetail, listRoles } from "@/api/users";
import { ApiError, type RoleRef, type User } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import StatusBadge from "@/components/StatusBadge.vue";
import { useCan } from "@/composables/useCan";
import { useErrorReveal } from "@/composables/useErrorReveal";
import { IAM_ROLE, IAM_USER } from "@/config/permission-codes";

const route = useRoute();
const router = useRouter();
const store = useUserListStore();
const userStore = useUserStore();

// P0 权限码裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）：
// 编辑域（基本信息 + 状态）→ iam:user:edit；角色绑定域 → iam:role:batch_assign|batch_unassign。
const { can, canSome } = useCan();
const canEditUser = computed(() => can(IAM_USER.EDIT));
const canManageRoleBind = computed(() =>
  canSome([IAM_ROLE.BATCH_ASSIGN, IAM_ROLE.BATCH_UNASSIGN]),
);
/** 只读回显：已选角色名（无绑定码时替代勾选组展示） */
const boundRoleNames = computed(() =>
  selectedRoleCodes.value
    .map((c) => roleOptions.value.find((o) => o.code === c)?.name ?? c)
    .join("、"),
);

const userId = computed(() => Number(route.params.id));

// ---- 表单态 ----
const loading = ref(false);
const error = ref<string>("");
const saving = ref(false);
const saveError = ref<string>("");
const user = ref<User | null>(null);
const originalRoleCodes = ref<string[]>([]);
const selectedRoleCodes = ref<string[]>([]);
const roleOptions = ref<RoleRef[]>([]);

// 可编辑字段（username 只读）
const nickname = ref("");
const email = ref("");
const phone = ref("");
const jobTitle = ref("");
const status = ref<"active" | "disable">("active");

// ---- 所属租户展示 ----
const tenantName = computed(() => {
  const tid = user.value?.tenantId || userStore.currentTenantId;
  const t = userStore.tenants.find((x) => x.id === tid);
  return t?.name ?? (tid ? `租户 ${tid}` : "—");
});

// ---- 角色 diff（保存时计算 added/removed）----
const roleDelta = computed(() => {
  const from = new Set(originalRoleCodes.value);
  const to = new Set(selectedRoleCodes.value);
  return {
    added: selectedRoleCodes.value.filter((c) => !from.has(c)),
    removed: originalRoleCodes.value.filter((c) => !to.has(c)),
  };
});

const hasChanges = computed(() => {
  if (roleDelta.value.added.length > 0 || roleDelta.value.removed.length > 0)
    return true;
  if (!user.value) return false;
  return (
    nickname.value !== (user.value.displayName ?? "") ||
    email.value !== "" ||
    phone.value !== "" ||
    jobTitle.value !== "" ||
    status.value !== (user.value.status === "active" ? "active" : "disable")
  );
});

function toggleRole(code: string): void {
  const idx = selectedRoleCodes.value.indexOf(code);
  if (idx >= 0) selectedRoleCodes.value.splice(idx, 1);
  else selectedRoleCodes.value.push(code);
}

/**
 * 状态切换：切到「禁用」前必须二次确认。
 *
 * 原先 `<select v-model="status">` 一选「禁用」即改本地状态，保存后账号直接不可登录，
 * 既无确认也无影响说明——与列表页「危险操作先确认」的约定不一致（审计实测：零提示）。
 * 这里拦截 change：确认才落地，取消则把 DOM 里的选中值回滚到原状态。
 */
async function onStatusChange(event: Event): Promise<void> {
  const el = event.target as HTMLSelectElement;
  const next = el.value as "active" | "disable";
  if (next !== "disable") {
    status.value = next;
    return;
  }
  const username = user.value?.username ?? "";
  try {
    await ElMessageBox.confirm(
      `禁用后「${username}」将无法登录，且其已建立的会话会在下次鉴权时失效。确认禁用？`,
      "确认禁用账号",
      {
        type: "warning",
        // 措辞显式写明动作，配合上方后果说明降低误确认风险
        confirmButtonText: "确认禁用",
        cancelButtonText: "取消",
        distinguishCancelAndClose: true,
      },
    );
    status.value = "disable";
  } catch {
    // 取消 / 关闭：回滚 DOM 选中值，本地状态保持原值
    el.value = status.value;
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

// ---- 加载详情 + 角色回显 + 角色选项 ----
async function loadDetail(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [detail, rolesPage] = await Promise.all([
      getUserDetail(userId.value),
      listRoles({ offset: 0, limit: 100, keyword: "" }),
    ]);
    roleOptions.value = rolesPage.items;
    if (!detail) {
      error.value = "用户不存在或已删除";
      return;
    }
    user.value = detail;
    nickname.value = detail.displayName ?? "";
    email.value = "";
    phone.value = "";
    jobTitle.value = "";
    status.value = detail.status === "disable" ? "disable" : "active";
    // 角色回显（listRolesForUser 读路径，不经写前守卫）
    const roles = await store.loadUserRoles(detail.id);
    originalRoleCodes.value = roles.map((r) => r.code);
    selectedRoleCodes.value = [...originalRoleCodes.value];
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
}

onMounted(loadDetail);

// ---- 保存（AC-4：保存返回列表 ≤2s 刷新）----
async function save(): Promise<void> {
  if (!user.value) return;
  saveError.value = "";
  saving.value = true;
  try {
    const ok = await store.update(
      {
        id: user.value.id,
        nickname: nickname.value || undefined,
        email: email.value || undefined,
        phone: phone.value || undefined,
        jobTitle: jobTitle.value || undefined,
        status: status.value,
      },
      user.value.username,
      roleDelta.value,
    );
    if (!ok) {
      // store 已归位 error（含写前守卫阻断）
      saveError.value = store.error ?? "保存失败";
      return;
    }
    // 保存成功 → 返回列表（store.update 内部已 fetch，列表 ≤2s 刷新）
    void router.push("/users");
  } catch (err) {
    saveError.value = errorMessage(err);
  } finally {
    saving.value = false;
  }
}

function back(): void {
  void router.push("/users");
}

// ---- passkey 绑定态展示（G-2/G-3 降级：bound-state display）----
const passkeyBound = computed(() => user.value?.passkeyRegistered ?? false);

// ---- 保存失败必须被看见：滚入视口 + 聚焦（窄屏滚到底提交时，提示原先在视口外）----
const saveErrorRef = ref<HTMLElement | null>(null);
useErrorReveal(saveError, saveErrorRef);
</script>

<template>
  <section class="page-user-detail" :aria-busy="loading">
    <header class="detail-head">
      <button type="button" class="btn btn--text" @click="back">
        ← 返回用户列表
      </button>
      <h2 class="detail-title">{{ user?.username ?? "用户详情" }}</h2>
      <button
        v-if="canEditUser"
        type="button"
        class="btn btn--primary"
        :disabled="loading || saving || !hasChanges"
        data-testid="save-user"
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

    <form v-else-if="user" class="detail-form" @submit.prevent="save">
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
          <span class="field__label">用户名</span>
          <input
            :value="user.username"
            type="text"
            class="input"
            readonly
            data-testid="detail-username"
          />
          <span class="muted">用户名只读（稳定标识，不可改）</span>
        </label>
        <label class="field">
          <span class="field__label">登录方式</span>
          <input :value="user.loginMethod" type="text" class="input" readonly />
          <span class="muted">当前账号的登录方式；通行密钥绑定状态见下方</span>
        </label>
        <label class="field">
          <span class="field__label">状态</span>
          <select
            :value="status"
            class="input"
            data-testid="detail-status"
            :disabled="!canEditUser"
            @change="onStatusChange"
          >
            <option value="active">启用</option>
            <option value="disable">禁用</option>
          </select>
        </label>
        <label class="field">
          <span class="field__label">昵称</span>
          <input
            v-model="nickname"
            type="text"
            class="input"
            :disabled="!canEditUser"
          />
        </label>
        <label class="field">
          <span class="field__label">邮箱</span>
          <input
            v-model="email"
            type="email"
            class="input"
            :disabled="!canEditUser"
          />
        </label>
        <label class="field">
          <span class="field__label">手机</span>
          <input
            v-model="phone"
            type="tel"
            class="input"
            :disabled="!canEditUser"
          />
        </label>
        <label class="field">
          <span class="field__label">职位</span>
          <input
            v-model="jobTitle"
            type="text"
            class="input"
            :disabled="!canEditUser"
          />
        </label>
      </fieldset>

      <fieldset class="form-section">
        <legend>角色绑定</legend>
        <div v-if="canManageRoleBind" class="checkbox-group">
          <label v-for="r in roleOptions" :key="r.code" class="checkbox-item">
            <input
              type="checkbox"
              :value="r.code"
              :checked="selectedRoleCodes.includes(r.code)"
              data-testid="role-bind"
              @change="toggleRole(r.code)"
            />
            {{ r.name }}
          </label>
          <span v-if="roleOptions.length === 0" class="muted">无可选角色</span>
        </div>
        <p v-else class="muted">
          当前角色：{{ boundRoleNames || "无" }}（绑定变更需持有
          iam:role:batch_assign / batch_unassign）
        </p>
        <p
          v-if="
            canManageRoleBind &&
            (roleDelta.added.length || roleDelta.removed.length)
          "
          class="muted"
        >
          待应用：新增 {{ roleDelta.added.length }} 项 / 移除
          {{ roleDelta.removed.length }} 项
        </p>
      </fieldset>

      <fieldset class="form-section">
        <legend>所属租户 / 组织</legend>
        <div class="field">
          <span class="field__label">所属租户</span>
          <span class="muted">{{ tenantName }}</span>
        </div>
        <div class="field">
          <span class="field__label">所属组织</span>
          <span class="muted">—（组织信息暂未接入用户详情）</span>
        </div>
      </fieldset>

      <!-- passkey 注册引导区块（G-2/G-3 降级：bound-state display） -->
      <fieldset class="form-section">
        <legend>Passkey 注册引导</legend>
        <div class="passkey-block" data-testid="passkey-block">
          <div class="passkey-status">
            <span class="field__label">绑定状态</span>
            <StatusBadge
              :status="passkeyBound ? 'active' : 'disabled'"
              size="sm"
            />
            <span class="muted">{{
              passkeyBound ? "已绑定 passkey" : "未绑定 passkey"
            }}</span>
          </div>
          <p class="muted passkey-hint">
            管理员暂不能代用户发起通行密钥的注册或撤销，请引导用户在其本人账号下完成自助绑定。
          </p>
          <p class="muted passkey-hint">
            设备丢失需重绑时：由用户先撤销原绑定再重新引导；若通行密钥是唯一登录方式，
            可通过管理员重置密码恢复账号访问。
          </p>
        </div>
      </fieldset>

      <div class="form-actions">
        <button type="button" class="btn btn--ghost" @click="back">取消</button>
        <button
          v-if="canEditUser"
          type="submit"
          class="btn btn--primary"
          :disabled="saving || !hasChanges"
        >
          {{ saving ? "保存中…" : "保存" }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped lang="scss">
.page-user-detail {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;

  .detail-title {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    flex: 1;
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

.input[readonly] {
  background: var(--tag-bg);
  color: var(--text-secondary);
}

.btn {
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;

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
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.detail-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 640px;
}

.form-section {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;

  legend {
    padding: 0 8px;
    color: var(--text-secondary);
    font-size: 13px;
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

.muted {
  color: var(--text-secondary);
  font-size: 12px;
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

.form-error,
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

.passkey-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.passkey-status {
  display: flex;
  align-items: center;
  gap: 8px;
}

.passkey-hint {
  margin: 0;
  line-height: 1.5;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
