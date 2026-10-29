<script setup lang="ts">
/**
 * 用户组直接策略弹窗（feat-group-policies 契约 §2.2）。
 *
 * 入口：GroupList 行内「策略」按钮（权限 `iam:policy:view_group_policies`）。
 * 结构照上一轮 `GroupRolesDialog.vue`：遮罩 + **居中弹窗**（非抽屉）+ 空态 + 错误重试 +
 * 关闭，沿用既有 `.dialog-overlay` / `.dialog` / `.data-table` / `.btn` 样式语言
 * （`GroupMembersDrawer.vue` / `TenantMembersDrawer.vue` 同款），
 * **不使用 Element Plus 组件、不引入新依赖**。
 *
 * **写能力（2026-10-29 扩展，偏离旧契约 §2.2，理由见下）**：
 * 旧契约声明"策略绑定/解绑仍走策略域（弹窗内另有说明文案指路）"，只读。
 * 但实际情况是：**策略域并不具备该能力** —— 策略页只有增删改查，
 * 且后端**没有**"策略 → 已授权主体"的反查端点（service 层有 ListAssignments，
 * web 层未暴露），所以"去策略页操作"是条死路，原说明文案属误导。
 *
 * 因此本弹窗承担用户组维度的授权：绑定（batch-attach, type=group）与解绑
 * （batch-detach, sub_type=group）。选择在此处而非策略页的依据是：
 * 这里**数据完整**——已绑清单端点（list/attached/group）与写端点都是现成的，
 * 用户能看到"当前绑了什么"再决定增删；而策略页缺反查端点，只能盲授权。
 *
 * 权限：查看 view_group_policies；绑定 batch_attach；解绑 detach（三档独立裁剪）。
 *
 * 数据流（契约 §1 / §2.1）：
 * - group 非 null（打开）→ `listPoliciesForGroup(group.code, {offset:0, limit:100, keyword:""})`
 *   —— manifest：本弹窗不做分页，取前 100 条；
 * - 服务端 msg **原文**展示（不套通用文案、不做二次改写），错误态可原地重试（只重拉本弹窗）；
 * - 请求序号：关闭 / 换组后旧响应一律丢弃，不写回 state。
 *
 * 标题为「组名 · 策略」；条目展示 策略名 / 标识码（等宽）/ 描述（空 → `—`）。
 */
import { computed, ref, watch } from "vue";
import {
  attachPoliciesToGroup,
  detachPolicyFromGroup,
  listPoliciesForGroup,
  listPoliciesPage,
  type PolicyWithMeta,
} from "@/api/policies";
import { ApiError } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_POLICY } from "@/config/permission-codes";

const props = defineProps<{
  /** 目标用户组；null = 弹窗关闭。只带策略反查需要的 code 与渲染标题用的 name。 */
  group: { code: string; name: string } | null;
}>();

const emit = defineEmits<{
  /** 关闭弹窗（父级把 group 置 null） */
  close: [];
}>();

/** 本弹窗不做分页（manifest 范围）：按接口上限取前若干条 */
const LIST_LIMIT = 100;

const isOpen = computed(() => props.group !== null);

// ---- 弹窗焦点 / Escape（关闭路径统一走 requestClose）----
const overlayRef = ref<HTMLElement | null>(null);
useDialogA11y(overlayRef, { open: isOpen, onClose: () => requestClose() });

/** 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案 */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

// ---- 已绑策略列表 ----
const policies = ref<PolicyWithMeta[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");

/** 请求序号：关闭弹窗 / 换组 / 重复重试后，旧响应一律丢弃 */
let requestSeq = 0;

// ---- 写操作权限门（OPA 为唯一安全边界，这里只做体验层裁剪）----
const { can } = useCan();
const canAttach = computed<boolean>(() => can(IAM_POLICY.BATCH_ATTACH));
const canDetach = computed<boolean>(() => can(IAM_POLICY.DETACH));

// ---- 绑定弹层：候选策略（排除已绑）----
const attachOpen = ref<boolean>(false);
const candidates = ref<PolicyWithMeta[]>([]);
const selected = ref<string[]>([]);
const attachLoading = ref<boolean>(false);
const attachError = ref<string>("");
const submitting = ref<boolean>(false);

// ---- 解绑 ----
const detachingCode = ref<string>("");
const actionError = ref<string>("");

const boundCodes = computed<Set<string>>(
  () => new Set(policies.value.map((p) => p.code)),
);

function openAttach(): void {
  attachOpen.value = true;
  selected.value = [];
  attachError.value = "";
  void loadCandidates();
}

async function loadCandidates(): Promise<void> {
  attachLoading.value = true;
  attachError.value = "";
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
  const group = props.group;
  if (!group) return;
  if (selected.value.length === 0) {
    attachError.value = "请至少选择一条策略";
    return;
  }
  submitting.value = true;
  attachError.value = "";
  try {
    await attachPoliciesToGroup(group.code, selected.value);
    attachOpen.value = false;
    selected.value = [];
    await load(); // 重新拉取，保证与后端一致
  } catch (err) {
    attachError.value = errorMessage(err);
  } finally {
    submitting.value = false;
  }
}

async function detach(policyCode: string): Promise<void> {
  const group = props.group;
  if (!group) return;
  actionError.value = "";
  detachingCode.value = policyCode;
  try {
    await detachPolicyFromGroup(group.code, policyCode);
    await load();
  } catch (err) {
    actionError.value = errorMessage(err);
  } finally {
    detachingCode.value = "";
  }
}

/** 拉取该组直接绑定的策略（按当前 group.code）。 */
async function load(): Promise<void> {
  const group = props.group;
  if (!group) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const page = await listPoliciesForGroup(group.code, {
      offset: 0,
      limit: LIST_LIMIT,
      keyword: "",
    });
    // 迟到的旧响应 / 弹窗已关闭 → 丢弃，不写 state
    if (seq !== requestSeq || !props.group) return;
    policies.value = page.items;
  } catch (err) {
    if (seq !== requestSeq || !props.group) return;
    policies.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

// ---- 关闭 ----
function requestClose(): void {
  emit("close");
}

// ---- 打开即拉取 / 关闭清理（group.code 是唯一开关）----
// 只观察 code（字符串）而非对象身份：父页每次重渲染都会新建 props 对象。
watch(
  () => props.group?.code ?? null,
  (code) => {
    if (code !== null) {
      policies.value = [];
      error.value = "";
      void load();
    } else {
      // 关闭：作废在途请求、清空状态；不发起任何新请求
      requestSeq++;
      loading.value = false;
      policies.value = [];
      error.value = "";
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
    data-testid="group-policies-dialog"
    @click.self="requestClose"
  >
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="`${groupName} · 策略`"
      :aria-busy="loading"
    >
      <header class="dialog__head">
        <h3 class="dialog__title">{{ groupName }} · 策略</h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭策略弹窗"
          data-testid="group-policies-close"
          @click="requestClose"
        >
          ✕
        </button>
      </header>

      <div class="dialog__body">
        <!-- 说明 + 绑定入口（2026-10-29 起本弹窗可写，理由见 script 头注释） -->
        <div class="head-row">
          <p class="muted">该用户组<strong>直接绑定</strong>的策略。</p>
          <button
            v-if="canAttach"
            type="button"
            class="btn btn--primary"
            data-testid="group-policy-attach-open"
            @click="openAttach"
          >
            绑定策略
          </button>
        </div>

        <!-- 加载态 -->
        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="i in 3" :key="i" class="skeleton__row" />
        </div>

        <!-- 已绑策略表：策略名 / 标识码（等宽）/ 描述 -->
        <div v-else-if="policies.length > 0" class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>策略名</th>
                <th>标识码</th>
                <th>描述</th>
                <th v-if="canDetach">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="p in policies"
                :key="p.code"
                data-testid="group-policy-row"
                :data-policy-code="p.code"
              >
                <td>{{ p.name || "—" }}</td>
                <td class="mono">{{ p.code || "—" }}</td>
                <td class="muted desc-cell" :title="p.desc">
                  {{ p.desc || "—" }}
                </td>
                <td v-if="canDetach">
                  <button
                    type="button"
                    class="btn btn--text btn--danger"
                    :disabled="detachingCode === p.code"
                    data-testid="group-policy-detach"
                    @click="detach(p.code)"
                  >
                    {{ detachingCode === p.code ? "解绑中…" : "解绑" }}
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
          data-testid="group-policies-empty"
        >
          <p>该用户组未直接绑定策略</p>
        </div>

        <!-- 错误态：服务端 msg 原文 + 重试 -->
        <p
          v-if="error"
          class="state-error"
          role="alert"
          data-testid="group-policies-error"
        >
          {{ error }}
          <button
            type="button"
            class="btn btn--text"
            data-testid="group-policies-retry"
            @click="load"
          >
            重试
          </button>
        </p>

        <!-- 操作失败（绑定 / 解绑）：服务端原文 -->
        <p
          v-if="actionError"
          class="state-error"
          role="alert"
          data-testid="group-policies-action-error"
        >
          {{ actionError }}
        </p>
      </div>

      <!-- 绑定策略子弹层 -->
      <div
        v-if="attachOpen"
        class="sub-overlay"
        data-testid="group-policy-attach-dialog"
        @click.self="closeAttach"
      >
        <div class="sub-dialog" role="dialog" aria-modal="true" aria-labelledby="gp-attach-title">
          <h3 id="gp-attach-title" class="sub-dialog__title">为该用户组绑定策略</h3>
          <p class="muted">已绑定的策略不会出现在下方列表中。</p>

          <p v-if="attachLoading" class="muted" data-testid="gp-attach-loading">正在加载候选策略…</p>
          <p v-else-if="candidates.length === 0" class="muted" data-testid="gp-attach-empty">
            没有可绑定的策略（可能已全部绑定，或尚未创建策略）。
          </p>
          <ul v-else class="cand-list">
            <li v-for="c in candidates" :key="c.code" class="cand-row">
              <label class="cand-label">
                <input
                  type="checkbox"
                  :checked="selected.includes(c.code)"
                  :data-testid="`gp-attach-cand-${c.code}`"
                  @change="toggle(c.code)"
                />
                <span class="cand-name">{{ c.name || "—" }}</span>
                <code class="mono">{{ c.code }}</code>
              </label>
            </li>
          </ul>

          <p v-if="attachError" class="state-error" role="alert" data-testid="gp-attach-error">
            {{ attachError }}
          </p>

          <div class="sub-dialog__actions">
            <button
              type="button"
              class="btn btn--text"
              :disabled="submitting"
              data-testid="gp-attach-cancel"
              @click="closeAttach"
            >
              取消
            </button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="submitting || attachLoading"
              data-testid="gp-attach-confirm"
              @click="submitAttach"
            >
              {{ submitting ? "绑定中…" : `绑定所选（${selected.length}）` }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.sub-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.sub-dialog {
  width: 100%;
  max-width: 520px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg-elevated);
  border-radius: 8px;
  box-shadow: var(--shadow-base);
  padding: 20px;
}

.sub-dialog__title {
  margin: 0 0 8px;
  font-size: 16px;
}

.sub-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.cand-list {
  list-style: none;
  margin: 12px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cand-row {
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 8px 10px;
}

.cand-label {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  min-width: 0;
}

.cand-name {
  font-weight: 500;
}
/* 遮罩：沿用用户组列表 .dialog-overlay 语言；弹窗居中（非抽屉） */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  width: 100%;
  max-width: 640px;
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

/* 窄屏：弹窗贴边留白，表格在容器内横向滚动 */
@media (max-width: 480px) {
  .dialog-overlay {
    padding: 12px;
  }

  .dialog {
    max-height: 92vh;

    &__head,
    &__body {
      padding-left: 12px;
      padding-right: 12px;
    }
  }
}
</style>
