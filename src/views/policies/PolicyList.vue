<script setup lang="ts">
/**
 * 策略管理列表页（UF-10，task 5.3）。
 *
 * 参照：ui-design UF-10（Layout/States/校验失败标红/Interactions/Data Binding）+
 * tech-design §Interfaces C 档 policy 端点 + §Data Models Policy/PolicyStatement +
 * parity-checklist §2.10/D-5（eiam 原生 Statement 数组、单数键归一、assignment_count E11 数据源）。
 *
 * 布局：页面头（标题 + 新增）→ 搜索栏（关键词）→ 表格 → 分页。
 * - 列：策略名 / Effect / 绑定对象数 / 操作
 * - 绑定对象数 = assignment_count（policy/list 响应直出，无需 enrichment）
 * - Effect 列：一条策略可含多条 Statement（Allow 与 Deny 混合）→ 去重展示
 *
 * 编辑 Dialog（AC-2/AC-3）：
 * - 策略 code（稳定标识，创建后不可改；格式 ^[a-z][a-z0-9_-]{2,31}$）—— 仅新增可编辑
 * - 策略名（1–64 字符，唯一，eiam 校验——冲突提示契约 validation.name_exists）
 * - Statement JSON 文本框（规范复数形：[{effect,actions,resources,condition?}]）
 *   前端 JSON 语法 + 结构校验（parseStatementsJson）→ 失败字段标红 + 阻止保存；
 *   再 eiam 服务端 schema 校验 → validation kind 失败标红对应字段。
 *
 * 删除被拒（AC-4，E11）：策略已绑定角色 → delete.blocked_policy 契约文案（{n} = assignmentCount）。
 *
 * Hard Rules：策略定义仅平台管理员可增删改（route meta.requiresAdmin；菜单 + 守卫双重口径，
 * 租户管理员与只读/审计入口不渲染）—— /policies 路由 meta.requiresAdmin + meta.permissions
 * 已在 router 2.6·P0 落地，守卫 ③ 越权 → /forbidden。本页按 P0 三层裁剪再叠加按钮级权限码
 * （iam:policy:add/edit/delete）：adminOnly 挡角色，权限码挡更细的授权粒度。
 */
import { computed, onMounted, ref } from "vue";
import { usePolicyListStore } from "@/stores/policyList";
import {
  parseStatementsJson,
  serializeStatementsJson,
  type CreatePolicyPayload,
  type PolicyWithMeta,
  type UpdatePolicyPayload,
} from "@/api/policies";
import { ApiError, type PolicyStatement } from "@/api/types";
import { contractText, formatContractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import PolicyStatementsEditor from "@/components/policies/PolicyStatementsEditor.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_POLICY } from "@/config/permission-codes";

const store = usePolicyListStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）
const { can } = useCan();

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
 * 原先模板里直接调它 → 选择器看起来变了但列表没变（实测 0 次请求）。
 */
function changePageSize(size: number): void {
  store.setPageSize(size);
  void store.fetch();
}

// ---- 列表加载 ----
async function reload(): Promise<void> {
  await store.fetch();
}

onMounted(async () => {
  await store.fetch();
});

// ---- Effect 列展示（去重，Allow/Deny 混合时两者并列）----
function effectDisplay(statements: { effect: string }[]): string {
  const effects = Array.from(new Set(statements.map((s) => s.effect)));
  if (effects.length === 0) return "—";
  return effects.join(" / ");
}

// ---- 编辑/新增 Dialog（AC-2/AC-3）----
const showEdit = ref(false);
const editMode = ref<"create" | "update">("create");
const editLoading = ref(false);
const editError = ref<string>("");
const editFieldErrors = ref<Record<string, string>>({});
const editCode = ref("");
const editName = ref("");
const editDesc = ref("");
const editStatements = ref(""); // JSON 文本（规范复数形）
/** 编辑态原策略（update 时回填 code 不可改） */
const editTarget = ref<{ code: string; assignmentCount?: number } | null>(null);

const CODE_RE = /^[a-z][a-z0-9_-]{2,31}$/;

function validateCode(value: string): string | null {
  if (!value) return "请输入策略 code";
  if (value.length < 3 || value.length > 32) return "code 长度 3–32 字符";
  if (!CODE_RE.test(value)) return "code 须以小写字母开头，仅含 a-z 0-9 _ -";
  return null;
}

function validateName(value: string): string | null {
  if (!value) return "请输入策略名";
  if (value.length < 1 || value.length > 64) return "策略名长度 1–64 字符";
  return null;
}

function defaultStatementsJson(): string {
  return serializeStatementsJson([
    {
      effect: "Allow",
      actions: ["cam:cert:Get"],
      resources: ["cert/*"],
    },
  ]);
}

function openCreate(): void {
  editMode.value = "create";
  editCode.value = "";
  editName.value = "";
  editDesc.value = "";
  editStatements.value = defaultStatementsJson();
  editError.value = "";
  editFieldErrors.value = {};
  editTarget.value = null;
  showEdit.value = true;
}

function openUpdate(policy: PolicyWithMeta): void {
  editMode.value = "update";
  editCode.value = policy.code;
  editName.value = policy.name;
  editDesc.value = policy.desc ?? "";
  editStatements.value = serializeStatementsJson(policy.statements);
  editError.value = "";
  editFieldErrors.value = {};
  editTarget.value = {
    code: policy.code,
    assignmentCount: policy.assignmentCount,
  };
  showEdit.value = true;
}

async function submitEdit(): Promise<void> {
  editError.value = "";
  editFieldErrors.value = {};

  // 格式即时拦截（前端层校验）
  const errors: Record<string, string> = {};
  if (editMode.value === "create") {
    const codeErr = validateCode(editCode.value);
    if (codeErr) errors.code = codeErr;
  }
  const nameErr = validateName(editName.value);
  if (nameErr) errors.name = nameErr;

  // 前端 JSON 语法 + 结构校验（AC-3 第一层）—— 失败标红 statements + 阻止保存
  const parsed = parseStatementsJson(editStatements.value);
  let statements: PolicyStatement[] | null = null;
  if (parsed.ok) {
    statements = parsed.statements;
  } else {
    errors.statements = parsed.error;
  }

  if (Object.keys(errors).length > 0 || statements === null) {
    editFieldErrors.value = errors;
    return;
  }

  editLoading.value = true;
  try {
    if (editMode.value === "create") {
      const payload: CreatePolicyPayload = {
        name: editName.value,
        code: editCode.value,
        desc: editDesc.value || undefined,
        statements,
      };
      const ok = await store.create(payload);
      if (!ok) {
        // store 已归位 error（含写前守卫阻断 / eiam schema 校验失败）
        editError.value = store.error ?? "新增策略失败";
        // eiam validation kind → 标红对应字段（schema 校验失败，AC-3 第二层）
        markValidationFieldErrors();
        return;
      }
    } else {
      const payload: UpdatePolicyPayload = {
        name: editName.value,
        code: editCode.value,
        desc: editDesc.value || undefined,
        statements,
      };
      const ok = await store.update(payload);
      if (!ok) {
        editError.value = store.error ?? "更新策略失败";
        markValidationFieldErrors();
        return;
      }
    }
    showEdit.value = false;
  } catch (err) {
    // 唯一性冲突（validation.name_exists）/ eiam schema 校验失败：经 contractText 降级
    editError.value = errorMessage(err);
    markValidationFieldErrors();
  } finally {
    editLoading.value = false;
  }
}

/**
 * eiam 服务端 schema 校验失败（validation kind）→ 标红对应字段（AC-3 第二层）。
 * eiam 错误经 ApiError.message 原值透传；validation.name_exists 契约命中 → 标红 name。
 * 字段级 schema 错误 eiam 不结构化返回，统一落到 statements 字段就近提示。
 */
function markValidationFieldErrors(): void {
  // store.error 已被 errorMessage 归一（contractText(code) 命中即契约文案）
  const msg = store.error ?? editError.value;
  if (!msg) return;
  const nameExists = contractText("validation.name_exists");
  // validation.name_exists 契约文案前缀（"名称已存在："）命中 → 标红 name 字段
  const namePrefix = nameExists ? (nameExists.split("{")[0] ?? "") : "";
  if (namePrefix !== "" && msg.startsWith(namePrefix)) {
    editFieldErrors.value = { ...editFieldErrors.value, name: msg };
    editError.value = "";
    return;
  }
  // 其余 validation 错误就近落到 statements 字段（无结构化字段映射时的降级口径）
  editFieldErrors.value = { ...editFieldErrors.value, statements: msg };
  editError.value = "";
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

function closeEdit(): void {
  showEdit.value = false;
}

// ---- 删除确认（AC-4，E11 依赖删除被拒：策略已绑定角色）----
const deleteTarget = ref<{
  code: string;
  name: string;
  assignmentCount?: number;
} | null>(null);
const deleteLoading = ref(false);
const deleteBlocked = ref<string>("");

function openDelete(policy: {
  code: string;
  name: string;
  assignmentCount?: number;
}): void {
  deleteTarget.value = policy;
  deleteBlocked.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  if (deleteBlocked.value) return;
  deleteLoading.value = true;
  try {
    const ok = await store.remove(target.code);
    if (ok) {
      deleteTarget.value = null;
    }
  } catch (err) {
    // E11 依赖删除被拒（conflict kind）：绑定角色数取 list 响应 assignmentCount
    const template = contractText("delete.blocked_policy");
    if (
      err instanceof ApiError &&
      err.kind === "conflict" &&
      template &&
      target.assignmentCount !== undefined &&
      target.assignmentCount > 0
    ) {
      deleteBlocked.value = formatContractText(template, {
        n: target.assignmentCount,
      });
    } else {
      deleteBlocked.value = errorMessage(err);
    }
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteBlocked.value = "";
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const editDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(editDialogRef, { open: showEdit, onClose: closeEdit });
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误删
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
  <section class="page-policy-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">策略管理</h2>
      <button
        v-if="can(IAM_POLICY.ADD)"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增策略
      </button>
    </header>

    <!-- 读屏播报：初次加载、搜索/翻页刷新都经此常驻区域播报（视觉不可见）。
         原先只有 aria-busy 变化，且骨架带 aria-hidden，读屏得不到「正在加载」信息。 -->
    <p class="sr-only" role="status" aria-live="polite">
      {{ store.loading ? "正在加载策略列表…" : "" }}
    </p>

    <!-- 搜索栏 -->
    <div class="toolbar">
      <input
        v-model="keywordInput"
        type="text"
        class="input toolbar__search"
        placeholder="搜索策略名"
        data-testid="policy-search"
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
            <th>策略名</th>
            <th>Effect</th>
            <th>绑定对象数</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in store.items" :key="p.code">
            <td>{{ p.name }}</td>
            <td data-testid="policy-effect">
              {{ effectDisplay(p.statements) }}
            </td>
            <td data-testid="policy-bound-count">
              {{ p.assignmentCount ?? 0 }}
            </td>
            <td>
              <button
                v-if="can(IAM_POLICY.EDIT)"
                type="button"
                class="btn btn--text"
                data-testid="edit-policy"
                @click="openUpdate(p)"
              >
                编辑
              </button>
              <button
                v-if="can(IAM_POLICY.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="delete-policy"
                @click="openDelete(p)"
              >
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态 -->
      <!-- 空态：区分「筛选无结果」与「本来就没有数据」，前者给一键清除筛选出口。
           真无数据时只显示文案——页头已有「新增策略」，重复同名按钮会让
           读屏与测试选择器出现歧义（与 users/roles 的空态约定保持一致）。 -->
      <div v-else-if="isEmpty" class="state-empty">
        <template v-if="hasActiveFilters">
          <p class="state-empty__text">没有匹配的策略，试试更换策略名关键词</p>
          <button
            type="button"
            class="btn btn--text"
            data-testid="clear-filters"
            @click="resetFilters"
          >
            清除筛选
          </button>
        </template>
        <p v-else class="state-empty__text">暂无策略数据</p>
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
      <select
        :value="store.pageSize"
        class="input pagination__size"
        data-testid="policy-page-size"
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

    <!-- 新增/编辑 Dialog（AC-2/AC-3）-->
    <div v-if="showEdit" class="dialog-overlay" @click.self="closeEdit">
      <div
        ref="editDialogRef"
        class="dialog dialog--wide"
        role="dialog"
        aria-modal="true"
        :aria-label="editMode === 'create' ? '新增策略' : '编辑策略'"
      >
        <header class="dialog__head">
          <h3>{{ editMode === "create" ? "新增策略" : "编辑策略" }}</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeEdit"
          >
            ✕
          </button>
        </header>
        <form class="dialog__body" @submit.prevent="submitEdit">
          <p v-if="editError" class="form-error" role="alert">
            <CopyContractText :code="editError" tag="span" />
          </p>
          <label v-if="editMode === 'create'" class="field">
            <span class="field__label"
              >策略 code<span class="required">*</span></span
            >
            <input
              v-model="editCode"
              type="text"
              class="input"
              data-testid="edit-policy-code"
              :aria-describedby="
                editFieldErrors.code ? 'edit-code-error' : undefined
              "
              :aria-invalid="!!editFieldErrors.code"
            />
            <span class="muted"
              >稳定标识，创建后不可改；用于 detail/delete（eiam 以 code
              为键）</span
            >
            <span
              v-if="editFieldErrors.code"
              id="edit-code-error"
              class="field__error"
              role="alert"
              >{{ editFieldErrors.code }}</span
            >
          </label>
          <div v-else class="field">
            <span class="field__label">策略 code</span>
            <span class="muted">{{ editCode }}（创建后不可改）</span>
          </div>
          <label class="field">
            <span class="field__label"
              >策略名<span class="required">*</span></span
            >
            <input
              v-model="editName"
              type="text"
              class="input"
              data-testid="edit-policy-name"
              :aria-describedby="
                editFieldErrors.name ? 'edit-name-error' : undefined
              "
              :aria-invalid="!!editFieldErrors.name"
            />
            <span class="muted">1–64 字符，唯一（eiam 校验）</span>
            <span
              v-if="editFieldErrors.name"
              id="edit-name-error"
              class="field__error"
              role="alert"
              >{{ editFieldErrors.name }}</span
            >
          </label>
          <label class="field">
            <span class="field__label">描述</span>
            <textarea
              v-model="editDesc"
              class="input input--textarea"
              rows="2"
            />
          </label>
          <!-- Statement 编辑器（task 6.2）：图形化编排 / JSON 双模式双向同步，
               单一事实源仍为 editStatements JSON 文本（submitEdit 校验口径不变） -->
          <PolicyStatementsEditor
            v-model="editStatements"
            :error="editFieldErrors.statements"
          />
          <div class="dialog__actions">
            <button type="button" class="btn btn--ghost" @click="closeEdit">
              取消
            </button>
            <button
              type="submit"
              class="btn btn--primary"
              :disabled="editLoading"
              data-testid="edit-policy-submit"
            >
              {{ editLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 删除确认 Dialog（E11 依赖删除被拒 → 绑定角色数提示、确认置灰） -->
    <div v-if="deleteTarget" class="dialog-overlay" @click.self="closeDelete">
      <div
        ref="deleteDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="delete-policy-desc"
        :aria-label="`删除策略 ${deleteTarget.name}`"
      >
        <header class="dialog__head">
          <h3>删除策略</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeDelete"
          >
            ✕
          </button>
        </header>
        <div class="dialog__body">
          <p id="delete-policy-desc">
            确认删除策略 <strong>{{ deleteTarget.name }}</strong
            >？此操作不可撤销。
          </p>
          <!-- E11 依赖删除被拒：绑定角色数取 list 响应 assignmentCount -->
          <p v-if="deleteBlocked" class="delete-blocked" role="alert">
            <CopyContractText :code="deleteBlocked" tag="span" />
          </p>
        </div>
        <div class="dialog__actions">
          <button
            type="button"
            class="btn btn--ghost"
            data-dialog-cancel
            @click="closeDelete"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn--danger"
            :disabled="deleteLoading || !!deleteBlocked"
            data-testid="delete-confirm"
            @click="confirmDelete"
          >
            {{ deleteLoading ? "删除中…" : "确认删除" }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-policy-list {
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
}

.input--textarea {
  height: auto;
  min-height: 60px;
  padding: 8px 10px;
  font-family: inherit;
  resize: vertical;
}

.input--code {
  height: auto;
  min-height: 240px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  resize: vertical;
  white-space: pre;
  overflow: auto;
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
  min-height: 120px;
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
  &--wide {
    max-width: 640px;
  }
  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
    // 弹窗内部滚动时标题与 ✕ 吸顶（策略表单较长，1440 下也要滚才能看到保存）
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
  }
  &__error {
    font-size: 12px;
    color: var(--color-danger);
  }
}

.required {
  color: var(--color-danger);
  margin-left: 2px;
}

.form-error,
.delete-blocked {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}
</style>
