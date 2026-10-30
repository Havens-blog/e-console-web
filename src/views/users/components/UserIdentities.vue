<!--
  用户外部身份绑定区块（feat-user-identity-unbind）

  用户场景：管理员发现某员工绑定了错误的 OIDC / 微信 / 飞书 / passkey 身份，
  需要先看到绑定关系（provider + identity_id）再解绑。

  为什么单独成组件：与本页既有 UserPermissionSources 保持同一形态（独立加载/降级/重试），
  既有的表单与保存逻辑零改动，避免动到已验证的编辑路径。

  权限：查看走 iam:user:get（随详情页），解绑按钮单独受 iam:user:unbind_identity 门控。
-->
<template>
  <section class="section" data-testid="user-identities">
    <header class="section__head">
      <h3 class="section__title">外部身份</h3>
      <button
        type="button"
        class="btn btn--text"
        data-testid="identities-refresh"
        @click="load"
      >
        刷新
      </button>
      <!-- 治理外部身份（IAM_USER.MANAGE_IDENTITY）：缺码不渲染入口、不发请求 -->
      <button
        v-if="canManage"
        type="button"
        class="btn btn--text"
        data-testid="identity-manage-open"
        @click="openManage"
      >
        治理外部身份
      </button>
    </header>

    <p v-if="loading" class="muted" data-testid="identities-loading">正在加载外部身份…</p>

    <p v-else-if="error" class="state-error" role="alert" data-testid="identities-error">
      {{ error }}
      <button type="button" class="btn btn--text" data-testid="identities-retry" @click="load">
        重试
      </button>
    </p>

    <p v-else-if="identities.length === 0" class="muted" data-testid="identities-empty">
      该用户尚未绑定任何外部身份。
    </p>

    <ul v-else class="identity-list">
      <li
        v-for="item in identities"
        :key="`${item.provider}:${item.identityId}`"
        class="identity-row"
        data-testid="identity-row"
      >
        <span class="identity-provider">{{ item.provider }}</span>
        <code class="identity-id">{{ item.identityId }}</code>
        <button
          v-if="canUnbind"
          type="button"
          class="btn btn--text btn--danger"
          :disabled="unbinding === keyOf(item)"
          data-testid="identity-unbind"
          @click="unbind(item)"
        >
          {{ unbinding === keyOf(item) ? "解绑中…" : "解绑" }}
        </button>
      </li>
    </ul>

    <p v-if="actionError" class="state-error" role="alert" data-testid="identities-action-error">
      {{ actionError }}
    </p>
    <div v-if="manageOpen" class="dialog-overlay" data-testid="identity-manage-dialog">
      <div class="dialog dialog--sm" role="dialog" aria-modal="true" aria-label="治理外部身份">
        <header class="dialog__head">
          <h3>治理外部身份</h3>
          <button type="button" class="btn btn--text" aria-label="关闭" @click="closeManage">✕</button>
        </header>
        <div class="dialog__body">
          <p class="muted">仅填写需要绑定的字段；<strong>未填写的 provider 不会被改动</strong>（精确解绑请用行内「解绑」）。</p>
          <label class="field">
            <span class="field__label">LDAP DN</span>
            <input v-model="formLdapDN" class="input" type="text" data-testid="identity-manage-ldap-dn" placeholder="uid=alice,dc=example,dc=com" />
          </label>
          <label class="field">
            <span class="field__label">微信 UserID</span>
            <input v-model="formWechatID" class="input" type="text" data-testid="identity-manage-wechat-id" placeholder="wx-user-id" />
          </label>
          <label class="field">
            <span class="field__label">飞书 UserID</span>
            <input v-model="formFeishuID" class="input" type="text" data-testid="identity-manage-feishu-id" placeholder="fs-user-id" />
          </label>
          <p v-if="manageError" class="state-error" role="alert" data-testid="identity-manage-error">{{ manageError }}</p>
        </div>
        <div class="dialog__actions">
          <button type="button" class="btn btn--ghost" data-testid="identity-manage-cancel" @click="closeManage">取消</button>
          <button type="button" class="btn" :disabled="managing || !hasManageInput" data-testid="identity-manage-submit" @click="submitManage">
            {{ managing ? "提交中…" : "提交" }}
          </button>
        </div>
      </div>
    </div>
    </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { manageUserIdentity } from "@/api/users";
import {
  listUserIdentities,
  unbindUserIdentity,
  type UserIdentity,
} from "@/api/users";
import { ApiError } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_USER } from "@/config/permission-codes";

const props = defineProps<{ userId: number }>();

const { can } = useCan();
const canUnbind = computed(() => can(IAM_USER.UNBIND_IDENTITY));

const loading = ref(false);
const error = ref("");
const actionError = ref("");
const identities = ref<UserIdentity[]>([]);
const unbinding = ref("");

const keyOf = (i: UserIdentity): string => `${i.provider}:${i.identityId}`;

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    identities.value = await listUserIdentities(props.userId);
  } catch (e) {
    // 失败时保留 error 以便用户重试；不清空既有数据以外的东西（此时本就为空）
    error.value =
      e instanceof ApiError ? e.message : "加载外部身份失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

async function unbind(item: UserIdentity): Promise<void> {
  actionError.value = "";
  unbinding.value = keyOf(item);
  try {
    await unbindUserIdentity(props.userId, item.provider, item.identityId);
    // 成功后重新拉取，确保页面与后端一致（而非本地删一条造成假象）
    await load();
  } catch (e) {
    actionError.value =
      e instanceof ApiError ? e.message : "解绑失败，请稍后重试";
  } finally {
    unbinding.value = "";
  }
}

onMounted(load);
// ---- 治理外部身份（feat-user-identity-manage）----
/** 能力门控：缺码不渲染入口、不发请求 */
const canManage = computed<boolean>(() => can(IAM_USER.MANAGE_IDENTITY));
const manageOpen = ref(false);
const managing = ref(false);
const manageError = ref("");
const formLdapDN = ref("");
const formWechatID = ref("");
const formFeishuID = ref("");
/** 至少填一个字段才允许提交（空提交是无意义的 no-op） */
const hasManageInput = computed<boolean>(
  () =>
    formLdapDN.value.trim() !== "" ||
    formWechatID.value.trim() !== "" ||
    formFeishuID.value.trim() !== "",
);

function openManage(): void {
  manageError.value = "";
  manageOpen.value = true;
}
function closeManage(): void {
  manageOpen.value = false;
  manageError.value = "";
}
async function submitManage(): Promise<void> {
  managing.value = true;
  manageError.value = "";
  try {
    await manageUserIdentity(props.userId, {
      ldapDN: formLdapDN.value.trim() || undefined,
      wechatUserID: formWechatID.value.trim() || undefined,
      feishuUserID: formFeishuID.value.trim() || undefined,
    });
    formLdapDN.value = "";
    formWechatID.value = "";
    formFeishuID.value = "";
    closeManage();
    await load();
  } catch (err) {
    manageError.value = err instanceof Error ? err.message : "治理外部身份失败";
  } finally {
    managing.value = false;
  }
}
</script>

<style scoped lang="scss">
.section {
  margin-top: 24px;
}

.section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.identity-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.identity-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  min-width: 0;
}

.identity-provider {
  flex: 0 0 auto;
  font-weight: 500;
}

.identity-id {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
}
</style>
