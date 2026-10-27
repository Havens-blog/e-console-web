<script setup lang="ts">
/**
 * 身份源管理列表页（UF-7，task 4.5）。
 *
 * 参照：ui-design UF-7（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces C 档
 * + parity-checklist §2.7 / §3.2 D-2 + eiam identity_source/handler.go·vo.go·dao.go 核验固化。
 *
 * 布局：页面头（标题 + 新增）→ 表格（名称/类型/启用/操作）。身份源数量少（v1 仅 ldap），
 * eiam list 非分页全量返回 → 不渲染分页控件（store 仍守 page/pageSize 契约形）。
 *
 * 6 字段连接参数 Dialog（AC-2/AC-3）：
 * 1. 连接地址（ldap(s)://host:port，端口 1–65535 校验）
 * 2. Bind DN（必填）
 * 3. Bind 密码（type=password，**仅写入/掩码/不回显已存明文**，编辑态留空=不修改 —— Hard Rule）
 * 4. Base DN（必填）
 * 5. 用户属性映射（用户名属性必填；邮箱属性可选）
 * 6. 超时（1–30s，默认 5；D-2 仅本地校验，不入 eiam 载荷）
 *
 * save 为 upsert（嵌套 ldap 对象，D-2）；启停走真实 toggle 路径（toggle/:id，非 update 承载）。
 * test 连接：保存前可测试，成功/失败提示（AC：测试响应类型化）。
 * 启用维持开关形态不套徽章（ui-design 状态徽章映射 §：「UF-7 启用维持开关形态不套徽章」）。
 *
 * 文案出口用 CopyContractText（2.5）。
 */
import { computed, onMounted, ref } from "vue";
import { useIdpListStore } from "@/stores/idpList";
import { ApiError, type IdentitySource } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { useCan } from "@/composables/useCan";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { IAM_IDENTITY_SOURCE } from "@/config/permission-codes";

const store = useIdpListStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径；
// save 为新增/编辑共用 upsert，test/toggle/delete 各自独立动词）
const { can } = useCan();

// ---- 列表加载 ----
async function reload(): Promise<void> {
  await store.fetch();
}

onMounted(async () => {
  await store.fetch();
});

// ---- 新增/编辑 Dialog（6 字段连接参数表单，AC-2/AC-3）----
const showForm = ref(false);
const formMode = ref<"create" | "edit">("create");
const formLoading = ref(false);
const formError = ref<string>("");
const formFieldErrors = ref<Record<string, string>>({});
const formId = ref<number>(0);
const formName = ref("");
const formEnabled = ref<boolean>(true);
// 6 字段连接参数
const formUrl = ref(""); // ldap(s)://host:port
const formBindDn = ref("");
const formPassword = ref(""); // type=password，仅写入；编辑态留空=不修改
const formBaseDn = ref("");
const formUsernameAttr = ref("");
const formEmailAttr = ref("");
const formTimeout = ref<number>(5); // 1–30s 默认 5（D-2 仅本地校验）

// Bind 密码占位提示（编辑态）：eiam toVo 固定不回显，留空=不修改
const PASSWORD_PLACEHOLDER = "留空不修改";
const DEFAULT_TIMEOUT = 5;

/** URL 校验：ldap(s)://host:port，端口 1–65535（AC-3） */
function validateUrl(value: string): string | null {
  if (!value) return "请输入连接地址";
  const m = value.match(/^(ldaps?):\/\/([^:/]+)(?::(\d+))?(?:\/.*)?$/i);
  if (!m) return "地址格式应为 ldap(s)://host:port";
  const portStr = m[3];
  if (portStr === undefined) return "请指定端口（1–65535）";
  const p = Number(portStr);
  if (!Number.isFinite(p) || p < 1 || p > 65535) return "端口范围 1–65535";
  return null;
}

function validateBindDn(value: string): string | null {
  if (!value) return "请输入 Bind DN";
  return null;
}

function validateBaseDn(value: string): string | null {
  if (!value) return "请输入 Base DN";
  return null;
}

function validateUsernameAttr(value: string): string | null {
  if (!value) return "请输入用户名属性";
  return null;
}

function validateTimeout(value: number): string | null {
  if (!Number.isFinite(value) || value < 1 || value > 30)
    return "超时范围 1–30 秒";
  return null;
}

function openCreate(): void {
  formMode.value = "create";
  formId.value = 0;
  formName.value = "";
  formEnabled.value = true;
  formUrl.value = "";
  formBindDn.value = "";
  formPassword.value = "";
  formBaseDn.value = "";
  formUsernameAttr.value = "";
  formEmailAttr.value = "";
  formTimeout.value = DEFAULT_TIMEOUT;
  formError.value = "";
  formFieldErrors.value = {};
  showForm.value = true;
}

function openEdit(src: IdentitySource): void {
  formMode.value = "edit";
  formId.value = src.id;
  formName.value = src.name;
  formEnabled.value = src.enabled;
  formUrl.value = src.conn.url;
  formBindDn.value = src.conn.bindDn;
  formPassword.value = ""; // Hard Rule：不回显已存明文，留空=不修改
  formBaseDn.value = src.conn.baseDn;
  formUsernameAttr.value = src.conn.attrMap.username;
  formEmailAttr.value = src.conn.attrMap.email ?? "";
  formTimeout.value = src.conn.timeoutSec || DEFAULT_TIMEOUT;
  formError.value = "";
  formFieldErrors.value = {};
  showForm.value = true;
}

/** 当前表单 → IdentitySource 规范形（save 为 upsert，嵌套 ldap 由 api 层组装） */
function formToSource(): IdentitySource {
  return {
    id: formId.value,
    name: formName.value,
    type: "ldap",
    conn: {
      url: formUrl.value.trim(),
      port: parsePort(formUrl.value),
      bindDn: formBindDn.value.trim(),
      password: formPassword.value, // "" = 不修改（Hard Rule）
      baseDn: formBaseDn.value.trim(),
      attrMap: {
        username: formUsernameAttr.value.trim(),
        email: formEmailAttr.value.trim() || undefined,
      },
      timeoutSec: formTimeout.value,
    },
    enabled: formEnabled.value,
  };
}

function parsePort(url: string): number {
  const m = url.match(/:(\d+)(?:\/|$)/);
  if (!m) return 0;
  const p = Number(m[1]);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

function validateForm(): boolean {
  const errs: Record<string, string> = {};
  const urlErr = validateUrl(formUrl.value.trim());
  if (urlErr) errs.url = urlErr;
  if (!formName.value.trim()) errs.name = "请输入名称";
  const bindDnErr = validateBindDn(formBindDn.value.trim());
  if (bindDnErr) errs.bindDn = bindDnErr;
  // create 时密码必填（首建需凭据）；edit 时留空=不修改（不校验必填）
  if (formMode.value === "create" && !formPassword.value) {
    errs.password = "请输入 Bind 密码";
  }
  const baseDnErr = validateBaseDn(formBaseDn.value.trim());
  if (baseDnErr) errs.baseDn = baseDnErr;
  const usernameErr = validateUsernameAttr(formUsernameAttr.value.trim());
  if (usernameErr) errs.usernameAttr = usernameErr;
  const timeoutErr = validateTimeout(formTimeout.value);
  if (timeoutErr) errs.timeout = timeoutErr;
  formFieldErrors.value = errs;
  return Object.keys(errs).length === 0;
}

async function submitForm(): Promise<void> {
  formError.value = "";
  if (!validateForm()) return;
  formLoading.value = true;
  try {
    const source = formToSource();
    if (formMode.value === "create") {
      const id = await store.create(source);
      if (id === null) {
        formError.value = store.error ?? "新增身份源失败";
        return;
      }
    } else {
      const ok = await store.update(source);
      if (!ok) {
        formError.value = store.error ?? "保存失败";
        return;
      }
    }
    showForm.value = false;
  } catch (err) {
    formError.value = errorMessage(err);
  } finally {
    formLoading.value = false;
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

function closeForm(): void {
  showForm.value = false;
}

// ---- 测试连接（保存前可测试，AC：成功/失败提示）----
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

async function runTest(): Promise<void> {
  testResult.value = null;
  // 测试前做同样校验（地址/必填项须有效才发测试请求）
  if (!validateForm()) return;
  testing.value = true;
  try {
    const msg = await store.test(formToSource());
    testResult.value = { ok: true, message: msg };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : typeof err === "string" ? err : "测试失败";
    testResult.value = { ok: false, message: msg };
  } finally {
    testing.value = false;
  }
}

// ---- 启停 toggle（真实路径，开关形态不套徽章，AC）----
async function onToggle(src: IdentitySource): Promise<void> {
  await store.toggle(src.id);
}

// ---- 删除确认 ----
const deleteTarget = ref<{ id: number; name: string } | null>(null);
const deleteLoading = ref(false);
const deleteBlocked = ref<string>("");

function openDelete(id: number, name: string): void {
  deleteTarget.value = { id, name };
  deleteBlocked.value = "";
  deleteLoading.value = false;
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  if (deleteBlocked.value) return;
  deleteLoading.value = true;
  try {
    const ok = await store.remove(deleteTarget.value.id);
    if (ok) {
      deleteTarget.value = null;
    }
  } catch (err) {
    deleteBlocked.value = errorMessage(err);
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteBlocked.value = "";
}

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const formDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(formDialogRef, { open: showForm, onClose: closeForm });
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
</script>

<template>
  <section class="page-idp-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">身份源管理</h2>
      <button
        v-if="can(IAM_IDENTITY_SOURCE.SAVE)"
        type="button"
        class="btn btn--primary"
        @click="openCreate"
      >
        新增身份源
      </button>
    </header>

    <!-- 读屏播报：加载中 / 空结果 / 结果条数都经此常驻区域播报（视觉不可见）。
         本页无筛选条件，空态固定为「暂无身份源配置」。 -->
    <p class="sr-only" role="status" aria-live="polite">
      {{
        store.loading
          ? "正在加载身份源列表…"
          : isEmpty
            ? "暂无身份源配置"
            : `共 ${store.total} 条`
      }}
    </p>

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
            <th>名称</th>
            <th>类型</th>
            <th>启用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="src in store.items" :key="src.id">
            <td>{{ src.name }}</td>
            <td>{{ src.type.toUpperCase() }}</td>
            <!-- 启用维持开关形态不套徽章（ui-design 状态徽章映射 §） -->
            <td>
              <label class="switch">
                <input
                  type="checkbox"
                  class="switch__input"
                  :checked="src.enabled"
                  :disabled="!can(IAM_IDENTITY_SOURCE.TOGGLE)"
                  data-testid="toggle-enabled"
                  @change="onToggle(src)"
                />
                <span class="switch__track" aria-hidden="true" />
              </label>
            </td>
            <td>
              <button
                v-if="can(IAM_IDENTITY_SOURCE.SAVE)"
                type="button"
                class="btn btn--text"
                data-testid="edit-idp"
                @click="openEdit(src)"
              >
                编辑
              </button>
              <button
                v-if="can(IAM_IDENTITY_SOURCE.DELETE)"
                type="button"
                class="btn btn--text btn--danger"
                data-testid="delete-idp"
                @click="openDelete(src.id, src.name)"
              >
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 空态 -->
      <!-- 空态：本页无关键词筛选，空即「尚未配置」。
           不在此加「新增身份源」按钮——页头已有同名按钮，重复会让读屏与
           测试选择器（strict mode）产生歧义，与 users/roles 的空态约定一致。 -->
      <div v-else-if="isEmpty" class="state-empty">
        <p class="state-empty__text">暂无身份源配置</p>
      </div>

      <!-- 加载骨架 -->
      <div v-else-if="store.loading" class="skeleton" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="skeleton__row" />
      </div>
    </div>

    <!-- 新增/编辑 Dialog（6 字段连接参数表单） -->
    <div v-if="showForm" class="dialog-overlay" @click.self="closeForm">
      <div
        ref="formDialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="formMode === 'create' ? '新增身份源' : '编辑身份源'"
      >
        <header class="dialog__head">
          <h3>{{ formMode === "create" ? "新增身份源" : "编辑身份源" }}</h3>
          <button
            type="button"
            class="btn btn--text"
            aria-label="关闭"
            @click="closeForm"
          >
            ✕
          </button>
        </header>
        <form class="dialog__body" @submit.prevent="submitForm">
          <p v-if="formError" class="form-error" role="alert">
            <CopyContractText :code="formError" tag="span" />
          </p>
          <label class="field">
            <span class="field__label">名称<span class="required">*</span></span>
            <input
              v-model="formName"
              type="text"
              class="input"
              data-testid="form-name"
              :aria-describedby="
                formFieldErrors.name ? 'form-name-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.name"
            />
            <span
              v-if="formFieldErrors.name"
              id="form-name-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.name }}</span
            >
          </label>
          <label class="field">
            <span class="field__label"
              >连接地址<span class="required">*</span></span
            >
            <input
              v-model="formUrl"
              type="text"
              class="input"
              data-testid="form-url"
              placeholder="ldap(s)://host:port"
              :aria-describedby="
                formFieldErrors.url ? 'form-url-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.url"
            />
            <span
              v-if="formFieldErrors.url"
              id="form-url-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.url }}</span
            >
            <span class="muted">格式 ldap(s)://host:port，端口 1–65535</span>
          </label>
          <label class="field">
            <span class="field__label">Bind DN<span class="required">*</span></span>
            <input
              v-model="formBindDn"
              type="text"
              class="input"
              data-testid="form-bind-dn"
              :aria-describedby="
                formFieldErrors.bindDn ? 'form-bind-dn-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.bindDn"
            />
            <span
              v-if="formFieldErrors.bindDn"
              id="form-bind-dn-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.bindDn }}</span
            >
          </label>
          <label class="field">
            <span class="field__label">
              Bind 密码<span v-if="formMode === 'create'" class="required">*</span>
            </span>
            <input
              v-model="formPassword"
              type="password"
              class="input"
              data-testid="form-password"
              autocomplete="new-password"
              :placeholder="formMode === 'edit' ? PASSWORD_PLACEHOLDER : ''"
              :aria-describedby="
                formFieldErrors.password ? 'form-password-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.password"
            />
            <span
              v-if="formFieldErrors.password"
              id="form-password-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.password }}</span
            >
            <span class="muted">
              {{
                formMode === "edit"
                  ? "仅写入，不回显已存明文；留空表示不修改"
                  : "仅写入，保存后不再回显"
              }}
            </span>
          </label>
          <label class="field">
            <span class="field__label">Base DN<span class="required">*</span></span>
            <input
              v-model="formBaseDn"
              type="text"
              class="input"
              data-testid="form-base-dn"
              :aria-describedby="
                formFieldErrors.baseDn ? 'form-base-dn-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.baseDn"
            />
            <span
              v-if="formFieldErrors.baseDn"
              id="form-base-dn-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.baseDn }}</span
            >
          </label>
          <label class="field">
            <span class="field__label"
              >用户名属性<span class="required">*</span></span
            >
            <input
              v-model="formUsernameAttr"
              type="text"
              class="input"
              data-testid="form-username-attr"
              :aria-describedby="
                formFieldErrors.usernameAttr
                  ? 'form-username-attr-error'
                  : undefined
              "
              :aria-invalid="!!formFieldErrors.usernameAttr"
            />
            <span
              v-if="formFieldErrors.usernameAttr"
              id="form-username-attr-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.usernameAttr }}</span
            >
          </label>
          <label class="field">
            <span class="field__label">邮箱属性（可选）</span>
            <input
              v-model="formEmailAttr"
              type="text"
              class="input"
              data-testid="form-email-attr"
            />
          </label>
          <label class="field">
            <span class="field__label">超时（秒）<span class="required">*</span></span>
            <input
              v-model.number="formTimeout"
              type="number"
              class="input"
              data-testid="form-timeout"
              min="1"
              max="30"
              :aria-describedby="
                formFieldErrors.timeout ? 'form-timeout-error' : undefined
              "
              :aria-invalid="!!formFieldErrors.timeout"
            />
            <span
              v-if="formFieldErrors.timeout"
              id="form-timeout-error"
              class="field__error"
              role="alert"
              >{{ formFieldErrors.timeout }}</span
            >
            <span class="muted">范围 1–30，默认 5</span>
          </label>
          <label v-if="formMode === 'edit'" class="field field--inline">
            <input
              v-model="formEnabled"
              type="checkbox"
              data-testid="form-enabled"
            />
            <span class="field__label">启用</span>
          </label>
          <!-- 测试连接结果（AC：成功/失败提示） -->
          <p
            v-if="testResult"
            class="test-result"
            :class="testResult.ok ? 'test-result--ok' : 'test-result--fail'"
            role="alert"
            data-testid="test-result"
          >
            {{ testResult.ok ? "连接成功" : "连接失败" }}：{{ testResult.message }}
          </p>
          <div class="dialog__actions">
            <button
              v-if="can(IAM_IDENTITY_SOURCE.TEST)"
              type="button"
              class="btn btn--ghost"
              :disabled="testing"
              data-testid="form-test"
              @click="runTest"
            >
              {{ testing ? "测试中…" : "测试连接" }}
            </button>
            <button type="button" class="btn btn--ghost" @click="closeForm">
              取消
            </button>
            <button
              v-if="can(IAM_IDENTITY_SOURCE.SAVE)"
              type="submit"
              class="btn btn--primary"
              :disabled="formLoading || testing"
              data-testid="form-submit"
            >
              {{ formLoading ? "提交中…" : "保存" }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 删除确认 Dialog -->
    <div v-if="deleteTarget" class="dialog-overlay" @click.self="closeDelete">
      <div
        ref="deleteDialogRef"
        class="dialog dialog--sm"
        role="alertdialog"
        aria-modal="true"
        aria-describedby="delete-idp-desc"
        :aria-label="`删除身份源 ${deleteTarget.name}`"
      >
        <header class="dialog__head">
          <h3>删除身份源</h3>
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
          <p id="delete-idp-desc">
            确认删除身份源 <strong>{{ deleteTarget.name }}</strong
            >？此操作不可撤销。
          </p>
          <p v-if="deleteBlocked" class="delete-blocked" role="alert">
            {{ deleteBlocked }}
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
.page-idp-list {
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

// ---- 启停开关（开关形态，不套徽章）----
.switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;

  &__input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  &__track {
    display: inline-block;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--border-strong);
    position: relative;
    transition: background 150ms;

    &::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: transform 150ms;
    }
  }
  &__input:checked + &__track {
    background: var(--color-success);
    &::after {
      transform: translateX(16px);
    }
  }
  &__input:focus-visible + &__track {
    outline: 2px solid var(--accent-blue);
    outline-offset: 2px;
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
  max-width: 560px;
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

  &--inline {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }
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

.test-result {
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 13px;

  &--ok {
    background: color-mix(in srgb, var(--color-success) 12%, transparent);
    color: var(--color-success);
  }
  &--fail {
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--color-danger);
  }
}
</style>
