<script setup lang="ts">
/**
 * 审计日志页（feat-audit-logs 契约 §2.3）—— 认证审计 / 操作审计双页签，**严格只读**。
 *
 * 结构参照 src/views/invitations/InvitationList.vue：原生元素 + `.page-*` / `.data-table` /
 * `.btn` / `.input` 样式语言，**不使用 Element Plus 组件、不引入新依赖**。两页签各自独立持有
 * 「筛选 / 分页 / 加载 / 错误」状态（切页签不互相污染，与邀请管理同款）。
 *
 * 布局：页头（标题「审计日志」）→ 视图页签（认证审计 / 操作审计）→ 筛选条 → 表格 →
 * 分页（20·50·100）。
 * - 认证表列：用户名 / 认证类型 / 状态 / 失败原因 / 客户端 IP / 时间（契约 §2.3）
 * - 操作表列：操作人 / 服务 / 模块 / 动作 / 状态 / 时间（契约 §2.3）
 * - 时间经 `@/views/tenants/timestamp` 的 formatEpochMs 渲染（Unix 毫秒 + 年份护栏，
 *   不另写一套时间格式化 —— 契约 §1 硬约束）。
 *
 * 权限裁剪（BIZ-auth-001，仅体验层；服务端 OPA 403 才是安全边界）：
 * - 页面级：路由 meta.permissions = [IAM_AUDIT.VIEW_AUTH, IAM_AUDIT.VIEW_OPERATION]（+ requiresAdmin）
 * - 页签级：认证审计 IAM_AUDIT.VIEW_AUTH / 操作审计 IAM_AUDIT.VIEW_OPERATION。
 *   **缺码时页签不渲染、也不发请求**（上一轮邀请管理「缺码要等点开才 403」的教训）：
 *   挂载时只拉当前可见页签，切换页签也只允许进入有码的页签。
 *
 * 筛选（契约 §2.3）：认证 = 用户名 / 认证类型 / 状态 / 时间范围；操作 = 操作人 / 服务 /
 * 模块 / 动作 / 状态。筛选以「查询」提交（Enter 同效），提交时重置回第 1 页并重拉；
 * **空筛选键不进请求体**（api 层同样剔除，见 api/auditLogs.ts buildAuthLogBody）。
 * - 状态用下拉：取值来自 eiam `internal/domain/audit.go:3-14` 的硬常量
 *   （认证 SUCCESS/FAIL/LOCKED、操作 SUCCESS/FAIL），非臆造枚举；
 * - 认证类型用文本输入：eiam 注释列出 password/ldap/oidc/passkey 但非闭集，
 *   用下拉会截断未来类型，故不设枚举；
 * - 时间范围用 `datetime-local`，提交时按浏览器本地时区转 **Unix 毫秒**
 *   （与 start_time / end_time 的单位契约一致）。
 *
 * 只读：本页无任何创建 / 编辑 / 删除 / 导出入口（审计日志不可改，manifest 范围边界）。
 */
import { computed, onMounted, ref } from "vue";
import { listAuthLogs, listOperationLogs } from "@/api/auditLogs";
import type {
  AuthLog,
  AuthLogQuery,
  OperationLog,
  OperationLogQuery,
} from "@/api/auditLogs";
import { ApiError } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_AUDIT } from "@/config/permission-codes";
import { formatEpochMs } from "@/views/tenants/timestamp";

const { can } = useCan();

/** 认证审计页签可见性（缺码 → 不渲染页签，也就不可能触发 auth/list 请求） */
const canViewAuth = computed<boolean>(() => can(IAM_AUDIT.VIEW_AUTH));
/** 操作审计页签可见性（同上） */
const canViewOperation = computed<boolean>(() =>
  can(IAM_AUDIT.VIEW_OPERATION),
);

// ---- 视图页签 ----
type TabKey = "auth" | "operation";
/** 默认落在第一个有码的页签；两个码都没有时停在 auth（两个面板都不会渲染） */
const activeTab = ref<TabKey>(canViewAuth.value ? "auth" : "operation");

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "审计日志加载失败";
}

/** 缺值占位（与本仓其他列表页同口径） */
function text(value?: string): string {
  return value !== undefined && value.trim() !== "" ? value : "—";
}

/**
 * `datetime-local` 值（本地时区）→ Unix 毫秒。
 * 空值 / 非法日期 → undefined（该筛选键不上行）。
 */
function epochFromLocal(value: string): number | undefined {
  if (value === "") return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

// ---- 认证审计 ----
/** 筛选草稿（输入即改，点「查询」才生效 —— 避免每次击键都打请求） */
interface AuthFilterDraft {
  username: string;
  authType: string;
  status: string;
  start: string;
  end: string;
}

function emptyAuthDraft(): AuthFilterDraft {
  return { username: "", authType: "", status: "", start: "", end: "" };
}

const authDraft = ref<AuthFilterDraft>(emptyAuthDraft());
/** 已生效的筛选（「查询」时从草稿快照，翻页沿用） */
const authFilter = ref<AuthFilterDraft>(emptyAuthDraft());

const authLogs = ref<AuthLog[]>([]);
const authTotal = ref<number>(0);
const authPage = ref<number>(1);
const authPageSize = ref<number>(20);
const authLoading = ref<boolean>(false);
const authError = ref<string>("");

/** 在途请求序号（重拉 / 切页签后旧响应一律丢弃） */
let authSeq = 0;

const authTotalPages = computed(() =>
  authTotal.value <= 0 ? 1 : Math.ceil(authTotal.value / authPageSize.value),
);

/** 由「已生效筛选 + 当前页」构造查询；空筛选键不放进对象（api 层亦剔除） */
function buildAuthQuery(): AuthLogQuery {
  const f = authFilter.value;
  const q: AuthLogQuery = {
    offset: (authPage.value - 1) * authPageSize.value,
    limit: authPageSize.value,
  };
  const username = f.username.trim();
  if (username !== "") q.username = username;
  const authType = f.authType.trim();
  if (authType !== "") q.authType = authType;
  if (f.status !== "") q.status = f.status;
  const startTime = epochFromLocal(f.start);
  if (startTime !== undefined) q.startTime = startTime;
  const endTime = epochFromLocal(f.end);
  if (endTime !== undefined) q.endTime = endTime;
  return q;
}

/** 拉取认证审计（当前页）。 */
async function loadAuthLogs(): Promise<void> {
  const seq = ++authSeq;
  authLoading.value = true;
  authError.value = "";
  try {
    const page = await listAuthLogs(buildAuthQuery());
    if (seq !== authSeq) return;
    authLogs.value = page.items;
    authTotal.value = page.total;
    // page 超界（如末页记录被清理）→ 回落最后页重查
    const last = authTotalPages.value;
    if (authPage.value > last && authTotal.value > 0) {
      authPage.value = last;
      await loadAuthLogs();
    }
  } catch (err) {
    if (seq !== authSeq) return;
    authLogs.value = [];
    authTotal.value = 0;
    authError.value = errorMessage(err);
  } finally {
    if (seq === authSeq) authLoading.value = false;
  }
}

/** 提交认证筛选：快照草稿 → 回第 1 页 → 重拉 */
function searchAuth(): void {
  authFilter.value = { ...authDraft.value };
  authPage.value = 1;
  void loadAuthLogs();
}

/** 重置认证筛选：清空草稿与已生效筛选 → 回第 1 页 → 重拉 */
function resetAuthFilters(): void {
  authDraft.value = emptyAuthDraft();
  authFilter.value = emptyAuthDraft();
  authPage.value = 1;
  void loadAuthLogs();
}

function changeAuthPage(p: number): void {
  authPage.value = p < 1 ? 1 : p;
  void loadAuthLogs();
}

function changeAuthPageSize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value);
  authPageSize.value = Number.isFinite(size) && size > 0 ? size : 20;
  authPage.value = 1;
  void loadAuthLogs();
}

// ---- 操作审计 ----
interface OperationFilterDraft {
  operatorName: string;
  service: string;
  module: string;
  action: string;
  status: string;
}

function emptyOperationDraft(): OperationFilterDraft {
  return { operatorName: "", service: "", module: "", action: "", status: "" };
}

const opDraft = ref<OperationFilterDraft>(emptyOperationDraft());
const opFilter = ref<OperationFilterDraft>(emptyOperationDraft());

const opLogs = ref<OperationLog[]>([]);
const opTotal = ref<number>(0);
const opPage = ref<number>(1);
const opPageSize = ref<number>(20);
const opLoading = ref<boolean>(false);
const opError = ref<string>("");

let opSeq = 0;

const opTotalPages = computed(() =>
  opTotal.value <= 0 ? 1 : Math.ceil(opTotal.value / opPageSize.value),
);

/** 由「已生效筛选 + 当前页」构造查询；空筛选键不放进对象（api 层亦剔除） */
function buildOperationQuery(): OperationLogQuery {
  const f = opFilter.value;
  const q: OperationLogQuery = {
    offset: (opPage.value - 1) * opPageSize.value,
    limit: opPageSize.value,
  };
  const operatorName = f.operatorName.trim();
  if (operatorName !== "") q.operatorName = operatorName;
  const service = f.service.trim();
  if (service !== "") q.service = service;
  const module = f.module.trim();
  if (module !== "") q.module = module;
  const action = f.action.trim();
  if (action !== "") q.action = action;
  if (f.status !== "") q.status = f.status;
  return q;
}

/** 拉取操作审计（当前页）。 */
async function loadOperationLogs(): Promise<void> {
  const seq = ++opSeq;
  opLoading.value = true;
  opError.value = "";
  try {
    const page = await listOperationLogs(buildOperationQuery());
    if (seq !== opSeq) return;
    opLogs.value = page.items;
    opTotal.value = page.total;
    const last = opTotalPages.value;
    if (opPage.value > last && opTotal.value > 0) {
      opPage.value = last;
      await loadOperationLogs();
    }
  } catch (err) {
    if (seq !== opSeq) return;
    opLogs.value = [];
    opTotal.value = 0;
    opError.value = errorMessage(err);
  } finally {
    if (seq === opSeq) opLoading.value = false;
  }
}

/** 提交操作筛选：快照草稿 → 回第 1 页 → 重拉 */
function searchOperation(): void {
  opFilter.value = { ...opDraft.value };
  opPage.value = 1;
  void loadOperationLogs();
}

/** 重置操作筛选：清空草稿与已生效筛选 → 回第 1 页 → 重拉 */
function resetOperationFilters(): void {
  opDraft.value = emptyOperationDraft();
  opFilter.value = emptyOperationDraft();
  opPage.value = 1;
  void loadOperationLogs();
}

function changeOpPage(p: number): void {
  opPage.value = p < 1 ? 1 : p;
  void loadOperationLogs();
}

function changeOpPageSize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value);
  opPageSize.value = Number.isFinite(size) && size > 0 ? size : 20;
  opPage.value = 1;
  void loadOperationLogs();
}

// ---- 页签切换 ----
/**
 * 切换页签：进入哪个页签就（重新）拉哪个列表；缺码的页签拒绝进入（不发请求）。
 * 两个列表各自独立分页 / 筛选 / 错误态，切页签不重置对方状态（与邀请管理同款）。
 */
async function switchTab(tab: TabKey): Promise<void> {
  if (activeTab.value === tab) return;
  if (tab === "auth" && !canViewAuth.value) return;
  if (tab === "operation" && !canViewOperation.value) return;
  activeTab.value = tab;
  if (tab === "auth") {
    await loadAuthLogs();
  } else {
    await loadOperationLogs();
  }
}

onMounted(async () => {
  // 只拉当前可见页签；缺码则一律不发请求（契约 §2.3「缺码不渲染且不请求」）
  if (activeTab.value === "auth" && canViewAuth.value) {
    await loadAuthLogs();
  } else if (activeTab.value === "operation" && canViewOperation.value) {
    await loadOperationLogs();
  }
});
</script>

<template>
  <section class="page-audit" :aria-busy="authLoading || opLoading" data-testid="page-audit">
    <header class="page-head">
      <h2 class="page-title">审计日志</h2>
      <p class="page-subtitle">认证与操作留痕，只读（不可编辑 / 删除）</p>
    </header>

    <!-- 视图切换：认证审计 / 操作审计（各自按权限码显隐） -->
    <div class="tabs" role="tablist" aria-label="审计视图">
      <button
        v-if="canViewAuth"
        type="button"
        class="btn btn--tab"
        role="tab"
        :aria-selected="activeTab === 'auth'"
        data-testid="audit-tab-auth"
        @click="switchTab('auth')"
      >
        认证审计
      </button>
      <button
        v-if="canViewOperation"
        type="button"
        class="btn btn--tab"
        role="tab"
        :aria-selected="activeTab === 'operation'"
        data-testid="audit-tab-operation"
        @click="switchTab('operation')"
      >
        操作审计
      </button>
    </div>

    <!-- ===== 认证审计 ===== -->
    <div
      v-if="activeTab === 'auth' && canViewAuth"
      class="panel"
      data-testid="audit-panel-auth"
    >
      <form class="filter-bar" @submit.prevent="searchAuth">
        <label class="field field--inline">
          <span class="field__label">用户名</span>
          <input
            v-model="authDraft.username"
            type="text"
            class="input"
            placeholder="按用户名筛选"
            data-testid="audit-filter-username"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">认证类型</span>
          <input
            v-model="authDraft.authType"
            type="text"
            class="input"
            placeholder="如 password / ldap"
            data-testid="audit-filter-auth-type"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">状态</span>
          <select
            v-model="authDraft.status"
            class="input"
            data-testid="audit-filter-status"
          >
            <option value="">全部</option>
            <option value="SUCCESS">SUCCESS（成功）</option>
            <option value="FAIL">FAIL（失败）</option>
            <option value="LOCKED">LOCKED（锁定）</option>
          </select>
        </label>
        <label class="field field--inline">
          <span class="field__label">开始时间</span>
          <input
            v-model="authDraft.start"
            type="datetime-local"
            class="input"
            data-testid="audit-filter-start"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">结束时间</span>
          <input
            v-model="authDraft.end"
            type="datetime-local"
            class="input"
            data-testid="audit-filter-end"
          />
        </label>
        <div class="filter-bar__actions">
          <button
            type="submit"
            class="btn btn--primary"
            data-testid="audit-auth-search"
          >
            查询
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            data-testid="audit-auth-reset"
            @click="resetAuthFilters"
          >
            重置
          </button>
        </div>
      </form>

      <div class="table-wrap">
        <div
          v-if="authError"
          class="state-error"
          role="alert"
          data-testid="audit-auth-error"
        >
          <span>{{ authError }}</span>
          <button
            type="button"
            class="btn btn--text"
            data-testid="audit-auth-retry"
            @click="loadAuthLogs"
          >
            重试
          </button>
        </div>

        <table v-else-if="authLogs.length > 0" class="data-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>认证类型</th>
              <th>状态</th>
              <th>失败原因</th>
              <th>客户端 IP</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="log in authLogs"
              :key="log.id"
              data-testid="audit-auth-row"
              :data-log-id="log.id"
            >
              <td>{{ text(log.username) }}</td>
              <td class="mono">{{ text(log.authType) }}</td>
              <td>{{ text(log.status) }}</td>
              <td class="muted">{{ text(log.failReason) }}</td>
              <td class="mono">{{ text(log.clientIp) }}</td>
              <td class="muted">{{ formatEpochMs(log.ctime) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-else-if="authLoading" class="skeleton" aria-hidden="true">
          <div v-for="i in 5" :key="i" class="skeleton__row" />
        </div>

        <div
          v-else
          class="state-empty"
          data-testid="audit-auth-empty"
        >
          <p class="state-empty__text">暂无认证审计日志</p>
        </div>
      </div>

      <nav
        v-if="authTotal > 0"
        class="pagination"
        aria-label="认证审计分页"
      >
        <button
          type="button"
          class="btn btn--text"
          :disabled="authPage <= 1"
          data-testid="audit-auth-page-prev"
          @click="changeAuthPage(authPage - 1)"
        >
          上一页
        </button>
        <span class="pagination__info"
          >第 {{ authPage }} / {{ authTotalPages }} 页（共
          {{ authTotal }} 条）</span
        >
        <button
          type="button"
          class="btn btn--text"
          :disabled="authPage >= authTotalPages"
          data-testid="audit-auth-page-next"
          @click="changeAuthPage(authPage + 1)"
        >
          下一页
        </button>
        <select
          :value="authPageSize"
          class="input pagination__size"
          aria-label="每页条数"
          data-testid="audit-auth-page-size"
          @change="changeAuthPageSize"
        >
          <option :value="20">20 条/页</option>
          <option :value="50">50 条/页</option>
          <option :value="100">100 条/页</option>
        </select>
      </nav>
    </div>

    <!-- ===== 操作审计 ===== -->
    <div
      v-else-if="activeTab === 'operation' && canViewOperation"
      class="panel"
      data-testid="audit-panel-operation"
    >
      <form class="filter-bar" @submit.prevent="searchOperation">
        <label class="field field--inline">
          <span class="field__label">操作人</span>
          <input
            v-model="opDraft.operatorName"
            type="text"
            class="input"
            placeholder="按操作人筛选"
            data-testid="audit-filter-operator"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">服务</span>
          <input
            v-model="opDraft.service"
            type="text"
            class="input"
            placeholder="如 eiam / ecmdb"
            data-testid="audit-filter-service"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">模块</span>
          <input
            v-model="opDraft.module"
            type="text"
            class="input"
            placeholder="如 user / role"
            data-testid="audit-filter-module"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">动作</span>
          <input
            v-model="opDraft.action"
            type="text"
            class="input"
            placeholder="如 create / delete"
            data-testid="audit-filter-action"
          />
        </label>
        <label class="field field--inline">
          <span class="field__label">状态</span>
          <select
            v-model="opDraft.status"
            class="input"
            data-testid="audit-filter-status"
          >
            <option value="">全部</option>
            <option value="SUCCESS">SUCCESS（成功）</option>
            <option value="FAIL">FAIL（失败）</option>
          </select>
        </label>
        <div class="filter-bar__actions">
          <button
            type="submit"
            class="btn btn--primary"
            data-testid="audit-operation-search"
          >
            查询
          </button>
          <button
            type="button"
            class="btn btn--ghost"
            data-testid="audit-operation-reset"
            @click="resetOperationFilters"
          >
            重置
          </button>
        </div>
      </form>

      <div class="table-wrap">
        <div
          v-if="opError"
          class="state-error"
          role="alert"
          data-testid="audit-operation-error"
        >
          <span>{{ opError }}</span>
          <button
            type="button"
            class="btn btn--text"
            data-testid="audit-operation-retry"
            @click="loadOperationLogs"
          >
            重试
          </button>
        </div>

        <table v-else-if="opLogs.length > 0" class="data-table">
          <thead>
            <tr>
              <th>操作人</th>
              <th>服务</th>
              <th>模块</th>
              <th>动作</th>
              <th>状态</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="log in opLogs"
              :key="log.id"
              data-testid="audit-operation-row"
              :data-log-id="log.id"
            >
              <td>{{ text(log.operatorName) }}</td>
              <td class="mono">{{ text(log.service) }}</td>
              <td class="mono">{{ text(log.module) }}</td>
              <td class="mono">{{ text(log.action) }}</td>
              <td>{{ text(log.status) }}</td>
              <td class="muted">{{ formatEpochMs(log.ctime) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-else-if="opLoading" class="skeleton" aria-hidden="true">
          <div v-for="i in 5" :key="i" class="skeleton__row" />
        </div>

        <div
          v-else
          class="state-empty"
          data-testid="audit-operation-empty"
        >
          <p class="state-empty__text">暂无操作审计日志</p>
        </div>
      </div>

      <nav
        v-if="opTotal > 0"
        class="pagination"
        aria-label="操作审计分页"
      >
        <button
          type="button"
          class="btn btn--text"
          :disabled="opPage <= 1"
          data-testid="audit-operation-page-prev"
          @click="changeOpPage(opPage - 1)"
        >
          上一页
        </button>
        <span class="pagination__info"
          >第 {{ opPage }} / {{ opTotalPages }} 页（共
          {{ opTotal }} 条）</span
        >
        <button
          type="button"
          class="btn btn--text"
          :disabled="opPage >= opTotalPages"
          data-testid="audit-operation-page-next"
          @click="changeOpPage(opPage + 1)"
        >
          下一页
        </button>
        <select
          :value="opPageSize"
          class="input pagination__size"
          aria-label="每页条数"
          data-testid="audit-operation-page-size"
          @change="changeOpPageSize"
        >
          <option :value="20">20 条/页</option>
          <option :value="50">50 条/页</option>
          <option :value="100">100 条/页</option>
        </select>
      </nav>
    </div>

    <!-- 两个码都没有：不渲染任何页签/面板，也不发任何请求（守卫正常会先拦到 /forbidden） -->
    <div
      v-if="!canViewAuth && !canViewOperation"
      class="state-empty"
      data-testid="audit-no-permission"
    >
      <p class="state-empty__text">无权查看审计日志</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.page-audit {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.page-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.page-subtitle {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.tabs {
  display: flex;
  gap: 8px;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 筛选条：换行布局，窄屏不挤压 */
.filter-bar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;

  &__actions {
    display: flex;
    gap: 8px;
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
  &--tab {
    background: transparent;
    color: var(--text-secondary);
    border-radius: 8px 8px 0 0;
    padding: 8px 16px;
    height: auto;
  }
  &--tab[aria-selected="true"] {
    color: var(--accent-blue);
    border-bottom: 2px solid var(--accent-blue);
    font-weight: 600;
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
  min-height: 120px;
}

.data-table {
  width: 100%;
  min-width: 760px;
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
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
}

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

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;

  &--inline {
    min-width: 160px;
  }

  &__label {
    font-size: 13px;
    color: var(--text-regular);
  }
}
</style>
