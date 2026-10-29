<script setup lang="ts">
/**
 * 角色详情页「已绑定策略」区块（feat-role-policies）。
 *
 * 为什么该区块存在：策略中心的核心动作是「把策略授给主体」。此前控制台**完全没有**
 * 策略绑定/解绑能力（`policies.ts` 只有查询与增删改），管理员只能建策略、无法授权。
 * 后端 `batch-attach` / `batch-detach` / `list/attached/role` 均已存在，`iam:policy:detach`
 * 权限码却在词表里零引用 —— 本区块把它用起来。
 *
 * 数据流：
 * - roleCode 变化 → listPoliciesForRole(roleCode, {offset:0, limit:100, keyword:""})；
 * - 绑定成功 / 解绑成功 → **重新拉取**（不本地增删），保证页面与后端一致；
 * - 请求序号丢弃迟到响应（换角色后旧响应不回写），沿用 RoleBoundGroupsCard 范式。
 *
 * 权限（OPA 为唯一安全边界，这里只做体验层裁剪）：
 * - 查看：IAM_POLICY.VIEW_ROLE_POLICIES，缺码整块不渲染且不发请求；
 * - 绑定：IAM_POLICY.BATCH_ATTACH，缺码隐藏「绑定策略」；
 * - 解绑：IAM_POLICY.DETACH，缺码隐藏每行「解绑」。
 *
 * 契约陷阱（roles.ts 头注释已核验，勿改）：attached/role 的载荷**不得传 type**，
 * 该字段在 eiam 是 uint8，传字符串会 400（历史"编辑角色 400"事故）。
 */
import { computed, ref, watch } from "vue";
import {
  attachPoliciesToRole,
  detachPolicyFromRole,
  listPoliciesPage,
  listPoliciesForRole,
  type PolicyWithMeta,
} from "@/api/policies";
import { ApiError } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_POLICY } from "@/config/permission-codes";

const props = defineProps<{
  /** 目标角色 code（attached/role 端点以 code 为键，非 id） */
  roleCode: string;
}>();

/** 本区块不做分页：按接口上限取前若干条 */
const LIST_LIMIT = 100;

const { can } = useCan();
const canView = computed<boolean>(() => can(IAM_POLICY.VIEW_ROLE_POLICIES));
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

// ---- 绑定弹层 ----
const attachOpen = ref<boolean>(false);
const candidates = ref<PolicyWithMeta[]>([]);
const selected = ref<string[]>([]);
const attachLoading = ref<boolean>(false);
const attachError = ref<string>("");
const submitting = ref<boolean>(false);

// ---- 解绑 ----
const detachingCode = ref<string>("");
const actionError = ref<string>("");

async function load(): Promise<void> {
  if (!canView.value || props.roleCode === "") return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const page = await listPoliciesForRole(props.roleCode, {
      offset: 0,
      limit: LIST_LIMIT,
      keyword: "",
    });
    if (seq !== requestSeq) return; // 迟到响应丢弃
    policies.value = page.items;
  } catch (err) {
    if (seq !== requestSeq) return;
    policies.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(() => props.roleCode, load, { immediate: true });

const boundCodes = computed<Set<string>>(
  () => new Set(policies.value.map((p) => p.code)),
);

/** 打开绑定弹层：拉全量策略作为候选，并排除已绑的 */
async function openAttach(): Promise<void> {
  attachOpen.value = true;
  selected.value = [];
  attachError.value = "";
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
    await attachPoliciesToRole(props.roleCode, selected.value);
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
    await detachPolicyFromRole(props.roleCode, policyCode);
    await load();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    detachingCode.value = "";
  }
}
</script>

<template>
  <section v-if="canView" class="card" data-testid="role-policies">
    <header class="card__head">
      <h3 class="card__title">已绑定策略</h3>
      <div class="card__actions">
        <button
          v-if="canAttach"
          type="button"
          class="btn btn--primary"
          data-testid="policy-attach-open"
          @click="openAttach"
        >
          绑定策略
        </button>
        <button
          type="button"
          class="btn btn--text"
          data-testid="policies-refresh"
          @click="load"
        >
          刷新
        </button>
      </div>
    </header>

    <p v-if="loading" class="muted" data-testid="policies-loading">正在加载已绑定策略…</p>

    <p v-else-if="error" class="state-error" role="alert" data-testid="policies-error">
      {{ error }}
      <button type="button" class="btn btn--text" data-testid="policies-retry" @click="load">
        重试
      </button>
    </p>

    <p v-else-if="policies.length === 0" class="muted" data-testid="policies-empty">
      该角色尚未绑定任何策略。
    </p>

    <ul v-else class="policy-list">
      <li
        v-for="p in policies"
        :key="p.code"
        class="policy-row"
        data-testid="policy-bound-row"
      >
        <span class="policy-name">{{ p.name }}</span>
        <code class="policy-code mono">{{ p.code }}</code>
        <button
          v-if="canDetach"
          type="button"
          class="btn btn--text btn--danger"
          :disabled="detachingCode === p.code"
          data-testid="policy-detach"
          @click="detach(p.code)"
        >
          {{ detachingCode === p.code ? "解绑中…" : "解绑" }}
        </button>
      </li>
    </ul>

    <p v-if="actionError" class="state-error" role="alert" data-testid="policies-action-error">
      {{ actionError }}
    </p>

    <!-- 绑定弹层 -->
    <div
      v-if="attachOpen"
      class="dialog-overlay"
      data-testid="policy-attach-dialog"
      @click.self="closeAttach"
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="attach-title">
        <h3 id="attach-title" class="dialog__title">为该角色绑定策略</h3>
        <p class="muted">已绑定的策略不会出现在下方列表中。</p>

        <p v-if="attachLoading" class="muted" data-testid="attach-loading">正在加载候选策略…</p>
        <p v-else-if="candidates.length === 0" class="muted" data-testid="attach-candidates-empty">
          没有可绑定的策略（可能已全部绑定，或尚未创建策略）。
        </p>
        <ul v-else class="cand-list">
          <li v-for="c in candidates" :key="c.code" class="cand-row">
            <label class="cand-label">
              <input
                type="checkbox"
                :checked="selected.includes(c.code)"
                :data-testid="`attach-cand-${c.code}`"
                @change="toggle(c.code)"
              />
              <span class="policy-name">{{ c.name }}</span>
              <code class="policy-code mono">{{ c.code }}</code>
            </label>
          </li>
        </ul>

        <p v-if="attachError" class="state-error" role="alert" data-testid="attach-error">
          {{ attachError }}
        </p>

        <div class="form-actions">
          <button
            type="button"
            class="btn btn--text"
            :disabled="submitting"
            data-testid="policy-attach-cancel"
            @click="closeAttach"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="submitting || attachLoading"
            data-testid="policy-attach-confirm"
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
.card {
  margin-top: 24px;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.card__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.card__actions {
  display: flex;
  gap: 8px;
}

.policy-list,
.cand-list {
  list-style: none;
  margin: 0;
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
