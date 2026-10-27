<script setup lang="ts">
/**
 * 授权管理列表页（UF-9，task 5.2）。
 *
 * 参照：ui-design UF-9（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces
 * + parity-checklist §2.9/G-5/G-6/D-4（permission/authorizations C 档 D-4 二元绑定模型、
 * G-5 资源/动作词表缺口降级静态、G-6 三元组 create/revoke 语义映射降级）。
 *
 * 布局：页面头（标题 + 新增）→ 搜索栏（关键词）→ 表格 → 分页。
 * - 列：主体 / 资源 / 动作 / 操作
 * - 分页边界 E7 由 authorizationList store 统一承载
 *
 * 新增 Dialog（AC）：
 * - 主体/资源/动作三下拉枚举（非自由文本，Hard Rule；词表自 eiam 端点，G-5 降级为静态词表标注来源版本）；
 * - 三元组唯一性前端预检（grant.duplicate）+ eiam 服务端兜底拒绝。
 *
 * 撤销（AC）：
 * - 确认弹窗 → 行进入 pending 态（行内徽标「生效中」+ 操作禁用）→ 生效（≤30s）后刷新移除该行；
 * - pending 态经 aria-live="polite" 播报（时变信息不以纯视觉传达）。
 *
 * G-6 语义映射降级：三元组（subject, resource, action）经 api 层映射为 eiam 二元绑定
 * （action=assign → role/batch_assign；action=attach → policy/batch-attach），撤销落解绑端点。
 * 模型语义差异经 parity-checklist 登记，待业务 owner 书面确认。
 */
import { computed, onMounted, ref } from "vue";
import { useAuthorizationListStore } from "@/stores/authorizationList";
import { ApiError } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_POLICY, IAM_ROLE } from "@/config/permission-codes";

const store = useAuthorizationListStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）。
// G-6 语义映射：新增/撤销授权落二元绑定端点 → 按动作映射到 role/policy 的批量绑定码：
//   assign → iam:role:batch_assign（撤销 batch_unassign）；attach → iam:policy:batch_attach（撤销 batch_detach）。
const { can, canSome } = useCan();

/** 新增授权：持有任一绑定动作码即可进入（具体动作单选在 Dialog 内） */
const canCreateAuth = computed(() =>
  canSome([IAM_ROLE.BATCH_ASSIGN, IAM_POLICY.BATCH_ATTACH]),
);

/** 行级撤销：按行的绑定语义（action）查对应解绑码 */
function canRevoke(action: string): boolean {
  if (action === "assign") return can(IAM_ROLE.BATCH_UNASSIGN);
  if (action === "attach") return can(IAM_POLICY.BATCH_DETACH);
  return false;
}

// ---- 搜索（切过滤重置 page=1，E7）----
const keywordInput = ref("");

function applySearch(): void {
  store.setKeyword(keywordInput.value.trim());
  void store.fetch();
}

function resetFilters(): void {
  keywordInput.value = "";
  store.setKeyword("");
  void store.fetch();
}

// ---- 分页 ----
const totalPages = computed(() =>
  store.total <= 0 ? 1 : Math.ceil(store.total / store.pageSize),
);

function changePage(p: number): void {
  store.setPage(p);
  void store.fetch();
}

/**
 * 切换每页条数：store.setPageSize 只改状态、不发起请求，
 * 只调它的话选择器变了但列表不动（用户/角色/策略三页同样存在该问题，本轮一并修）。
 */
function changePageSize(size: number): void {
  store.setPageSize(size);
  void store.fetch();
}

// ---- 列表加载 ----
async function reload(): Promise<void> {
  await Promise.all([store.fetchVocab(), store.fetch()]);
}

onMounted(async () => {
  await reload();
});

// ---- 新增 Dialog ----
const showCreate = ref(false);
const createLoading = ref(false);
const createError = ref<string>("");
const createSubject = ref("");
const createResource = ref("");
const createAction = ref("");

function openCreate(): void {
  createSubject.value = "";
  createResource.value = "";
  createAction.value = store.vocab?.actions[0] ?? "assign";
  createError.value = "";
  showCreate.value = true;
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

async function submitCreate(): Promise<void> {
  createError.value = "";
  if (!createSubject.value || !createResource.value || !createAction.value) {
    createError.value = "请选择主体、资源、动作";
    return;
  }
  createLoading.value = true;
  try {
    const subjectEntry = store.vocab?.subjects.find(
      (s) => s.code === createSubject.value,
    );
    const ok = await store.create({
      subject: createSubject.value,
      subType: subjectEntry?.subType,
      resource: createResource.value,
      action: createAction.value,
    });
    if (!ok) {
      // store 已归位 error（含唯一性预检 grant.duplicate / eiam 兜底）
      createError.value = store.error ?? "新增授权失败";
      return;
    }
    showCreate.value = false;
  } catch (err) {
    createError.value = errorMessage(err);
  } finally {
    createLoading.value = false;
  }
}

function closeCreate(): void {
  showCreate.value = false;
}

// ---- 撤销确认（pending ≤30s aria-live 播报）----
const revokeTarget = ref<{ subject: string; resource: string; action: string } | null>(null);
const revokeLoading = ref(false);
const revokeError = ref<string>("");

function openRevoke(
  auth: { subject: string; resource: string; action: string },
): void {
  revokeTarget.value = auth;
  revokeError.value = "";
  revokeLoading.value = false;
}

async function confirmRevoke(): Promise<void> {
  const target = revokeTarget.value;
  if (!target) return;
  revokeLoading.value = true;
  try {
    const subjectEntry = store.vocab?.subjects.find(
      (s) => s.code === target.subject,
    );
    const ok = await store.remove({
      subject: target.subject,
      subType: subjectEntry?.subType,
      resource: target.resource,
      action: target.action,
    });
    if (!ok) {
      revokeError.value = store.error ?? "撤销授权失败";
      return;
    }
    revokeTarget.value = null;
  } catch (err) {
    revokeError.value = errorMessage(err);
  } finally {
    revokeLoading.value = false;
  }
}

function closeRevoke(): void {
  revokeTarget.value = null;
  revokeError.value = "";
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const createDialogRef = ref<HTMLElement | null>(null);
const revokeDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(createDialogRef, { open: showCreate, onClose: closeCreate });
useDialogA11y(revokeDialogRef, {
  open: computed(() => revokeTarget.value !== null),
  onClose: closeRevoke,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误触撤销
  initialFocus: "[data-dialog-cancel]",
});

// ---- 状态迁移渲染辅助 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);
const isEmpty = computed(
  () => !store.loading && store.items.length === 0 && store.error === null,
);
/** 是否存在生效中的筛选（空态区分「筛选无结果」与「本来无数据」用） */
const hasActiveFilters = computed(() => store.keyword !== "");
</script>

<template>
  <section class="page-authorization-list" :aria-busy="store.loading">
    <header class="page-head">
      <!-- 页面主标题用 h1：全站此前没有任何 h1，读屏按标题导航缺「这一页是什么」的锚点 -->
      <h1 class="page-title">授权管理</h1>
      <button
        v-if="canCreateAuth"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增授权
      </button>
    </header>

    <!-- 读屏播报：加载中 / 空结果 / 结果条数都经此常驻区域播报（视觉不可见）。
         只播「正在加载」不够——加载结束后读屏拿不到「回来几条」「是否没搜到」。 -->
    <p class="sr-only" role="status" aria-live="polite">
      {{
        store.loading
          ? "正在加载授权列表…"
          : isEmpty
            ? hasActiveFilters
              ? "没有匹配的授权，已保留当前筛选条件"
              : "暂无授权数据"
            : `共 ${store.total} 条`
      }}
    </p>

    <!-- 词表来源版本标注（G-5 降级）-->
    <p v-if="store.vocab" class="muted vocab-source">
      词表来源：{{ store.vocab.source }}
    </p>

    <!-- 搜索栏 -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="搜索主体"
        data-testid="auth-search"
        @keyup.enter="applySearch"
      />
      <button type="button" class="btn btn--ghost" @click="applySearch">
        搜索
      </button>
      <button type="button" class="btn btn--text" @click="resetFilters">
        重置
      </button>
    </div>

    <!-- 表格容器：错误 / 空 / 加载 三态都在容器内替换内容，
         避免错误态下方残留一个空表格框（原实现错误文案在框外，框内无内容） -->
    <div class="table-wrap">
      <!-- 错误态（重试）：说明在上、动作在下一行，避免「…请稍后重试」与「重试」连读 -->
      <div v-if="isError" class="state-error" role="alert">
        <CopyContractText code="eiam.unavailable" tag="span" />
        <button type="button" class="btn btn--text" @click="reload">重试</button>
      </div>

      <table v-else-if="store.items.length > 0" class="data-table">
        <thead>
          <tr>
            <th>主体</th>
            <th>资源</th>
            <th>动作</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(auth, idx) in store.items"
            :key="`${auth.subject}|${auth.resource}|${auth.action}`"
            :data-testid="`auth-row-${idx}`"
          >
            <td>{{ auth.subject }}</td>
            <td>{{ auth.resource }}</td>
            <td>{{ auth.action }}</td>
            <td>
              <!-- 撤销 pending 态：行内徽标「生效中」+ 操作禁用 -->
              <span
                v-if="store.isPending(auth)"
                class="badge badge--pending"
                data-testid="auth-pending-badge"
                >生效中</span
              >
              <button
                v-else-if="canRevoke(auth.action)"
                type="button"
                class="btn btn--text btn--danger"
                :data-testid="`revoke-auth-${idx}`"
                :aria-label="`撤销 ${auth.subject} 对 ${auth.resource} 的 ${auth.action} 授权`"
                @click="openRevoke(auth)"
              >
                撤销
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态：区分「筛选无结果」与「本来就没有数据」，前者给一键清除筛选出口 -->
      <div v-else-if="isEmpty" class="state-empty">
        <template v-if="hasActiveFilters">
          <p class="state-empty__text">没有匹配的授权，试试更换主体关键词</p>
          <button
            type="button"
            class="btn btn--text"
            data-testid="clear-filters"
            @click="resetFilters"
          >
            清除筛选
          </button>
        </template>
        <p v-else class="state-empty__text">暂无授权数据</p>
      </div>

      <!-- 加载骨架 -->
      <div v-else-if="store.loading" class="skeleton" aria-hidden="true">
        <div v-for="i in 5" :key="i" class="skeleton__row" />
      </div>
    </div>

    <!-- 分页 -->
    <nav v-if="store.total > 0" class="pagination" aria-label="分页">
      <button
        type="button"
        class="btn btn--text"
        :disabled="store.page <= 1"
        @click="changePage(store.page - 1)"
      >
        上一页
      </button>
      <span class="pagination__info"
        >第 {{ store.page }} / {{ totalPages }} 页（共
        {{ store.total }} 条）</span
      >
      <button
        type="button"
        class="btn btn--text"
        :disabled="store.page >= totalPages"
        @click="changePage(store.page + 1)"
      >
        下一页
      </button>
      <!-- 页大小：与其余列表页（用户/角色/策略）保持一致；缺它时本页只能 20 条一页 -->
      <select
        :value="store.pageSize"
        class="input pagination__size"
        data-testid="auth-page-size"
        aria-label="每页条数"
        @change="
          changePageSize(Number(($event.target as HTMLSelectElement).value))
        "
      >
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
        <option :value="100">100 条/页</option>
      </select>
    </nav>

    <!-- aria-live 播报区（撤销 pending 时变信息；时变信息不以纯视觉传达） -->
    <div
      class="sr-only"
      aria-live="polite"
      aria-atomic="true"
      data-testid="auth-revoke-announce"
    >
      {{ store.revokeAnnouncement }}
    </div>

    <!-- 新增 Dialog（三下拉枚举 + 唯一性预检） -->
    <div v-if="showCreate" class="dialog-overlay" @click.self="closeCreate">
      <div
        ref="createDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新增授权"
      >
        <header class="dialog__head">
          <h3>新增授权</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeCreate"
          >
            ✕
          </button>
        </header>
        <form class="dialog__body" @submit.prevent="submitCreate">
          <p v-if="createError" class="form-error" role="alert">
            <CopyContractText :code="createError" tag="span" />
          </p>
          <!-- 主体下拉（非自由文本；词表自 eiam subjects/search，G-5 降级） -->
          <label class="field">
            <span class="field__label">主体<span class="required">*</span></span>
            <select
              v-model="createSubject"
              class="input"
              data-testid="create-auth-subject"
            >
              <option value="" disabled>请选择主体</option>
              <option
                v-for="s in store.vocab?.subjects ?? []"
                :key="s.code"
                :value="s.code"
              >
                {{ s.name ? `${s.name} (${s.code})` : s.code }}
              </option>
            </select>
          </label>
          <!-- 资源下拉（非自由文本；词表自 role/list + policy/list，G-5 降级） -->
          <label class="field">
            <span class="field__label">资源<span class="required">*</span></span>
            <select
              v-model="createResource"
              class="input"
              data-testid="create-auth-resource"
            >
              <option value="" disabled>请选择资源</option>
              <option
                v-for="r in store.vocab?.resources ?? []"
                :key="r"
                :value="r"
              >
                {{ r }}
              </option>
            </select>
          </label>
          <!-- 动作下拉（非自由文本；G-5 静态词表 assign/attach） -->
          <label class="field">
            <span class="field__label">动作<span class="required">*</span></span>
            <select
              v-model="createAction"
              class="input"
              data-testid="create-auth-action"
            >
              <option value="" disabled>请选择动作</option>
              <option
                v-for="a in store.vocab?.actions ?? []"
                :key="a"
                :value="a"
              >
                {{ a }}
              </option>
            </select>
          </label>
          <div class="dialog__actions">
            <button type="button" class="btn btn--ghost" @click="closeCreate">
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="createLoading"
              data-testid="create-auth-submit"
            >
              {{ createLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 撤销确认 Dialog -->
    <div
      v-if="revokeTarget"
      class="dialog-overlay"
      @click.self="closeRevoke"
    >
      <div
        ref="revokeDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="revoke-auth-desc"
        :aria-label="`撤销授权 ${revokeTarget.subject}`"
      >
        <header class="dialog__head">
          <h3>撤销授权</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeRevoke"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p id="revoke-auth-desc">
            确认撤销授权
            <strong>{{ revokeTarget.subject }}</strong> →
            <strong>{{ revokeTarget.resource }}</strong
            >（{{ revokeTarget.action }}）？此操作不可撤销，生效延迟 ≤30s。
          </p>
          <p v-if="revokeError" class="form-error" role="alert">
            <CopyContractText :code="revokeError" tag="span" />
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            @click="closeRevoke"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="revokeLoading"
            data-testid="revoke-confirm"
            @click="confirmRevoke"
          >
            {{ revokeLoading ? "撤销中…" : "确认撤销" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-authorization-list {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

/* 仅供读屏的隐藏文本（视觉不可见但保留在无障碍树中） */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.vocab-source {
  font-size: 12px;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;

  &__search {
    min-width: 220px;
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
  /* 与骨架实测高度（5 行 ≈ 248px）对齐：加载中/小数据量两态同高，避免整页跳动 */
  min-height: 248px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;

  th,
  td {
    padding: 10px 12px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
  }
  th {
    color: var(--text-secondary);
    font-weight: 500;
  }
  td {
    color: var(--text-regular);
  }
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.state-empty,
.state-error {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

// 错误态：说明在上、重试动作在下一行（同行时「…请稍后重试」+「重试」会读成重复）
.state-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.state-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;

  &__text {
    margin: 0;
  }
}

.skeleton__row {
  height: 40px;
  margin: 8px 12px;
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

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;

  &--pending {
    background: color-mix(in srgb, var(--color-warning) 15%, transparent);
    color: var(--color-warning);
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

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
    // 弹窗内部滚动时标题与 ✕ 吸顶，避免滚出可视区后无关闭入口
    position: sticky;
    top: 0;
    background: var(--bg-elevated);
    z-index: 1;
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
    margin-top: 8px;
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  &__label {
    font-size: 13px;
    color: var(--text-regular);
  text-align: left;
  }
}

.required {
  color: var(--color-danger);
  margin-left: 2px;
}

.form-error {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}
</style>
