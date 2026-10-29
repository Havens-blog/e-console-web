<script setup lang="ts">
/**
 * 用户详情页「直接绑定的策略」区块（feat-user-policies-write）。
 *
 * 为什么需要：三类主体的策略授权此前只补齐了角色与用户组，**用户维度缺失**——
 * 管理员无法给某个用户单独授予策略（不经角色）。这在实际运维里很常见
 * （临时提权、个别用户的特殊许可）。
 *
 * 与「权限来源」（UserPermissionSources）的分工：
 * - 本区块只增删**直接绑定**的策略（policy_assignment: sub_type=user）；
 * - 经角色 / 用户组**继承**来的策略属只读展示，由 UserPermissionSources 回答，
 *   两者不可混淆——删掉这里的一条不会影响继承来的。
 *
 * 键不一致（必须注意）：查询已绑用 **user_id**（数字，ListUserPoliciesReq），
 * 而绑定/解绑用 **username**（subject.code 的注释明确写"用户名或角色代码"）。
 * 因此本组件同时需要 userId 与 username，缺一不可。
 *
 * 权限（OPA 为唯一安全边界，这里只做体验层裁剪）：
 * 查看 view_user_policies；绑定 batch_attach；解绑 detach。
 */
import { computed, ref, watch } from "vue";
import {
  attachPoliciesToUser,
  detachPolicyFromUser,
  listPoliciesForUser,
  listPoliciesPage,
  type PolicyWithMeta,
} from "@/api/policies";
import { ApiError } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_POLICY } from "@/config/permission-codes";

const props = defineProps<{
  userId: number;
  /** 绑定/解绑以用户名为 subject.code，故必须提供 */
  username: string;
}>();

/** 本区块不分页 */
const LIST_LIMIT = 100;

const { can } = useCan();
const canView = computed<boolean>(() => can(IAM_POLICY.VIEW_USER_POLICIES));
const canAttach = computed<boolean>(() => can(IAM_POLICY.BATCH_ATTACH));
const canDetach = computed<boolean>(() => can(IAM_POLICY.DETACH));

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

const policies = ref<PolicyWithMeta[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");
let requestSeq = 0;

const attachOpen = ref<boolean>(false);
const candidates = ref<PolicyWithMeta[]>([]);
const selected = ref<string[]>([]);
const attachLoading = ref<boolean>(false);
const attachError = ref<string>("");
const submitting = ref<boolean>(false);

const detachingCode = ref<string>("");
const actionError = ref<string>("");

const boundCodes = computed<Set<string>>(() => new Set(policies.value.map((p) => p.code)));

async function load(): Promise<void> {
  if (!canView.value || props.userId <= 0) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    // 必须显式传 limit：eiam 对 limit<=0 回落 10（policy/handler.go 实核）
    const page = await listPoliciesForUser(props.userId, {
      offset: 0,
      limit: LIST_LIMIT,
      keyword: "",
    });
    if (seq !== requestSeq) return;
    policies.value = page.items;
  } catch (err) {
    if (seq !== requestSeq) return;
    policies.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(() => props.userId, load, { immediate: true });

function openAttach(): void {
  attachOpen.value = true;
  selected.value = [];
  attachError.value = "";
  void loadCandidates();
}

async function loadCandidates(): Promise<void> {
  attachLoading.value = true;
  try {
    const page = await listPoliciesPage({ offset: 0, limit: 100, keyword: "" });
    candidates.value = page.items.filter((p) => !boundCodes.value.has(p.code));
  } catch (err) {
    candidates.value = [];
    attachError.value = errorMessage(err);
  } finally {
    attachLoading.value = false;
  }
}

function closeAttach(): void {
  if (submitting.value) return;
  attachOpen.value = false;
  attachError.value = "";
}

function toggle(code: string): void {
  selected.value = selected.value.includes(code)
    ? selected.value.filter((c) => c !== code)
    : [...selected.value, code];
}

async function submitAttach(): Promise<void> {
  if (selected.value.length === 0) {
    attachError.value = "请至少选择一条策略";
    return;
  }
  submitting.value = true;
  attachError.value = "";
  try {
    await attachPoliciesToUser(props.username, selected.value);
    attachOpen.value = false;
    selected.value = [];
    await load();
  } catch (err) {
    attachError.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

async function detach(policyCode: string): Promise<void> {
  actionError.value = "";
  detachingCode.value = policyCode;
  try {
    await detachPolicyFromUser(props.username, policyCode);
    await load();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    detachingCode.value = "";
  }
}
</script>

<template>
  <section v-if="canView" class="section" data-testid="user-policies">
    <header class="section__head">
      <h3 class="section__title">直接绑定的策略</h3>
      <div class="section__actions">
        <button
          v-if="canAttach"
          type="button"
          class="btn btn--primary"
          data-testid="user-policy-attach-open"
          @click="openAttach"
        >
          绑定策略
        </button>
        <button type="button" class="btn btn--text" data-testid="user-policies-refresh" @click="load">
          刷新
        </button>
      </div>
    </header>

    <p class="muted">
      仅列出<strong>直接绑定</strong>到该用户的策略；经角色/用户组继承来的策略见上方「权限来源」。
    </p>

    <p v-if="loading" class="muted" data-testid="user-policies-loading">正在加载…</p>
    <p v-else-if="error" class="state-error" role="alert" data-testid="user-policies-error">
      {{ error }}
      <button type="button" class="btn btn--text" data-testid="user-policies-retry" @click="load">
        重试
      </button>
    </p>
    <p v-else-if="policies.length === 0" class="muted" data-testid="user-policies-empty">
      该用户没有被直接绑定的策略。
    </p>
    <ul v-else class="policy-list">
      <li v-for="p in policies" :key="p.code" class="policy-row" data-testid="user-policy-row">
        <span class="policy-name">{{ p.name || "—" }}</span>
        <code class="policy-code mono">{{ p.code }}</code>
        <button
          v-if="canDetach"
          type="button"
          class="btn btn--text btn--danger"
          :disabled="detachingCode === p.code"
          data-testid="user-policy-detach"
          @click="detach(p.code)"
        >
          {{ detachingCode === p.code ? "解绑中…" : "解绑" }}
        </button>
      </li>
    </ul>

    <p v-if="actionError" class="state-error" role="alert" data-testid="user-policies-action-error">
      {{ actionError }}
    </p>

    <div
      v-if="attachOpen"
      class="dialog-overlay"
      data-testid="user-policy-attach-dialog"
      @click.self="closeAttach"
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="up-attach-title">
        <h3 id="up-attach-title" class="dialog__title">为该用户绑定策略</h3>
        <p class="muted">已绑定的策略不会出现在下方列表中。</p>

        <p v-if="attachLoading" class="muted" data-testid="up-attach-loading">正在加载候选策略…</p>
        <p v-else-if="candidates.length === 0" class="muted" data-testid="up-attach-empty">
          没有可绑定的策略。
        </p>
        <ul v-else class="cand-list">
          <li v-for="c in candidates" :key="c.code" class="cand-row">
            <label class="cand-label">
              <input
                type="checkbox"
                :checked="selected.includes(c.code)"
                :data-testid="`up-attach-cand-${c.code}`"
                @change="toggle(c.code)"
              />
              <span class="policy-name">{{ c.name || "—" }}</span>
              <code class="policy-code mono">{{ c.code }}</code>
            </label>
          </li>
        </ul>

        <p v-if="attachError" class="state-error" role="alert" data-testid="up-attach-error">
          {{ attachError }}
        </p>

        <div class="form-actions">
          <button
            type="button"
            class="btn btn--text"
            :disabled="submitting"
            data-testid="up-attach-cancel"
            @click="closeAttach"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="submitting || attachLoading"
            data-testid="up-attach-confirm"
            @click="submitAttach"
          >
            {{ submitting ? "绑定中…" : `绑定所选（${selected.length}）` }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.section {
  margin-top: 24px;
}

.section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.section__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.section__actions {
  display: flex;
  gap: 8px;
}

.policy-list,
.cand-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.policy-row,
.cand-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  min-width: 0;
}

.cand-label {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  cursor: pointer;
}

.policy-name {
  flex: 0 1 auto;
  font-weight: 500;
  min-width: 0;
  overflow-wrap: anywhere;
}

.policy-code {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
}
</style>
