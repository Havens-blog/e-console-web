<script setup lang="ts">
/**
 * 登录页（UF-1）—— 密码/LDAP/passkey + MFA + 锁定/强制改密（E1 骨架）。
 *
 * 参照：ui-design UF-1（Layout/States/Interactions/Data Binding）+ tech-design §Interfaces B 档
 * + parity-checklist Phase 0 实核（B-1/B-2/B-4、G-8/G-9 降级）。
 *
 * 状态机（ui-design States）：
 * - Default：登录方式 Tab + 账号密码表单；
 * - MFA challenge：6 位验证码输入（mfaTicket 来自登录响应 mfa_token，verify 载荷 mfa_token，B-1）；
 * - 强制改密：E1 骨架（G-8 降级 —— eiam 无 must_change_password 载体，该态经
 *   `forceMustChangePassword` prop 暴露为未来接线点，当前生产永不触发；改密端点形状 Phase 0
 *   已核实不存在，提交按降级处理）；
 * - Loading：提交中按钮转 loading、禁用；
 * - Error：表单顶部统一中性错误条（CopyContractText 渲染契约文案，不泄账号，Hard Rule）；
 * - Locked：中性锁定提示 auth.account_locked（G-9 降级 —— lockUntil 无数据源，{X} 不自算、
 *   缺参显式可见，不伪造倒计时）。
 *
 * 错误映射（v1 占位，待 parity §5「状态 × code → kind」对照表产出后替为 code→key 映射）：
 * - 空凭据 → auth.empty_credentials（前端拦截，不发请求）；
 * - 凭据错误 / 用户不存在 → auth.invalid_credentials（同一文案，防账号枚举，Hard Rule）；
 * - MFA 码错误 → auth.mfa_invalid；
 * - 锁定（eiam msg 含「锁定」/「次数过多」） → auth.account_locked（G-9 降级，无倒计时）；
 * - 其余 → ApiError.message 原文回退（contractText(code) 未知 code 路径）。
 *
 * 成功 → 租户分流（F-1：profile must_select_tenant 恒 false，前端自算 tenants.length）：
 * 0 受限工作台 / 1 自动选定 / ≥2 租户选择页（3.2/3.3 后续里程碑，此处只定目标并 router.replace）。
 */
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ldapLogin,
  passkeyLoginFinish,
  passkeyLoginStart,
  systemLogin,
  verifyMfa,
} from "@/api/auth";
import { ApiError } from "@/api/types";
import { useUserStore } from "@/stores/user";
import { contractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";

type Tab = "password" | "ldap" | "passkey";
type Phase = "login" | "mfa" | "mustChangePassword";

const props = withDefaults(
  defineProps<{
    /**
     * E1 强制改密骨架接线点（G-8 降级）。
     * eiam 当前无 must_change_password 载体（parity §3.1 G-8），生产永不置 true；
     * eiam 排期补齐后由登录响应处理逻辑置位。仅为可测骨架而暴露。
     */
    forceMustChangePassword?: boolean;
  }>(),
  { forceMustChangePassword: false },
);

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

// ---- WebAuthn 可用性（E8：不可用隐藏 passkey 入口 + 提示）----
const webAuthnAvailable =
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.credentials !== "undefined";

const tabs = computed<Tab[]>(() => {
  const list: Tab[] = ["password", "ldap"];
  if (webAuthnAvailable) list.push("passkey");
  return list;
});

const activeTab = ref<Tab>("password");
const phase = ref<Phase>(
  props.forceMustChangePassword ? "mustChangePassword" : "login",
);
const loading = ref(false);
const locked = ref(false);
/** 错误文案出口：契约 key（如 auth.invalid_credentials）或未知 code 回退原文 */
const errorKey = ref<string>("");
const fieldErrors = ref<Record<string, string>>({});

// ---- 表单字段 ----
const username = ref("");
const password = ref("");
const ldapSourceId = ref("");
const mfaCode = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
/** 登录响应返回的 MFA 票据（eiam 原值 mfa_token，B-1） */
const mfaTicket = ref("");

const submitting = computed(() => loading.value);

/** 表单顶部错误文案渲染：锁定态优先于一般错误 */
const errorRenderKey = computed(() =>
  locked.value ? "auth.account_locked" : errorKey.value,
);

function clearError(): void {
  errorKey.value = "";
  locked.value = false;
  fieldErrors.value = {};
}

/**
 * 把 ApiError 映射为契约 key（v1 占位映射，待 §5 code→key 对照表）。
 * - 锁定检测：eiam ErrUserLocked / ErrMfaAttemptsExhausted 的 msg 含「锁定」/「次数过多」
 *   → auth.account_locked（G-9 降级，无倒计时）；
 * - MFA 阶段失败 → auth.mfa_invalid；
 * - 其余登录失败 → auth.invalid_credentials（凭据错误与用户不存在同一文案，Hard Rule）；
 * - 未知 code 回退 ApiError.message（contractText 未知路径，零二次映射）。
 */
function mapErrorToContractKey(error: unknown, mfaPhase: boolean): string {
  if (error instanceof ApiError) {
    const msg = error.message;
    if (/锁定|次数过多/.test(msg)) return "auth.account_locked";
    // 服务端不可用：5xx 链路繁忙（eiam「服务内部链路繁忙」4010901）或网络超时（无信封 code=null）。
    // eiam 对「密码错误」(4010202) 与「链路繁忙」(4010901) 都回 HTTP 500，只能按文案/code 区分；
    // 正向识别不可用，避免远端 Redis 抖动时登录误显「用户名或密码错误」诱用户反复重试。
    if (error.code === null || /繁忙|链路|暂不可用|不可用|超时/.test(msg)) {
      return "eiam.unavailable";
    }
    if (mfaPhase) return "auth.mfa_invalid";
    // 已知业务 code：优先走 contractText（store 2.4/2.7 同款口径）
    if (error.code !== null) {
      const text = contractText(String(error.code));
      if (text) return String(error.code);
    }
    return "auth.invalid_credentials";
  }
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "登录失败";
}

/**
 * 把 login?redirect=xxx 规范化为可导航目标。
 * 上游（e-cam-web）可能给完整 URL（如 http://localhost:8888/cam/），
 * vue-router 只认站内路径，把完整 URL 当路径匹配必然 no-match、卡死登录页。
 * 只放行同源（防开放重定向），返回 path+search+hash；非法/跨源 → null 回退内部目标。
 */
function sanitizeRedirect(raw: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const path = url.pathname + url.search + url.hash;
  return path && path !== "/" ? path : null;
}

/** 终结登录：拉 profile → 按租户数分流（F-1 自算 tenants.length） */
async function finalizeLogin(): Promise<void> {
  const ok = await userStore.fetchProfile();
  if (!ok) {
    // profile 拉取失败：仍按 401 收敛处理（router 守卫 2.6 承接），此处仅记录错误
    errorKey.value = userStore.error ?? "登录后获取用户信息失败";
    return;
  }
  const tenants = userStore.tenants;
  const redirect =
    typeof route.query.redirect === "string" ? route.query.redirect : null;
  // ≥2 → 租户选择页；0/1 → 工作台（受限态由 workbench 自处理，3.3 承接）
  const target = tenants.length >= 2 ? "/tenant-select" : "/workbench";
  const dest = sanitizeRedirect(redirect ?? "") ?? target;
  // 站内应用路由（/workbench 等）走 SPA；跨应用路径（/cam/ 等）在 console
  // 路由表无匹配，必须整页跳转交给对应前端（Guard 2.6 登录携带语义不变）。
  const resolved = router.resolve(dest);
  if (resolved.matched.length > 0) {
    await router.replace(dest);
  } else {
    window.location.assign(dest);
  }
}

/** 密码 / LDAP 登录提交 */
async function submitCredentialLogin(): Promise<void> {
  clearError();
  if (!username.value || !password.value) {
    errorKey.value = "auth.empty_credentials";
    return;
  }
  loading.value = true;
  try {
    // ldapSourceId 为自由输入字符串；空串不传，非空解析为 number（ldapLogin 期望 source_id?: number）
    const sourceId = ldapSourceId.value
      ? Number(ldapSourceId.value)
      : undefined;
    const result =
      activeTab.value === "ldap"
        ? await ldapLogin(username.value, password.value, sourceId)
        : await systemLogin(username.value, password.value);
    if (result.mfaRequired && result.mfaTicket) {
      mfaTicket.value = result.mfaTicket;
      phase.value = "mfa";
      return;
    }
    await finalizeLogin();
  } catch (error) {
    errorKey.value = mapErrorToContractKey(error, false);
    if (errorKey.value === "auth.account_locked") locked.value = true;
  } finally {
    loading.value = false;
  }
}

/** MFA 验证提交 */
async function submitMfa(): Promise<void> {
  clearError();
  if (!mfaCode.value) {
    // 字段级校验（契约外，就近 aria-describedby）
    fieldErrors.value = { mfaCode: "请输入验证码" };
    return;
  }
  loading.value = true;
  try {
    await verifyMfa(mfaTicket.value, mfaCode.value);
    await finalizeLogin();
  } catch (error) {
    errorKey.value = mapErrorToContractKey(error, true);
    if (errorKey.value === "auth.account_locked") locked.value = true;
  } finally {
    loading.value = false;
  }
}

/** passkey 登录（start → navigator.credentials.get → finish） */
async function submitPasskeyLogin(): Promise<void> {
  clearError();
  if (!webAuthnAvailable) {
    errorKey.value = "auth.passkey_unsupported";
    return;
  }
  loading.value = true;
  try {
    const start = await passkeyLoginStart();
    // start.options 为 eiam 返回的 WebAuthn 断言请求（protocol.CredentialAssertion），
    // 类型层为 unknown（eiam 原生结构非 TS 类型化）；navigator.credentials.get 需要
    // PublicKeyCredentialRequestOptions，此处按 WebAuthn 契约断言转递。
    const assertion = await navigator.credentials.get({
      publicKey: start.options as PublicKeyCredentialRequestOptions,
    });
    const result = await passkeyLoginFinish(start.sessionToken, assertion);
    if (result.mfaRequired && result.mfaTicket) {
      mfaTicket.value = result.mfaTicket;
      phase.value = "mfa";
      return;
    }
    await finalizeLogin();
  } catch (error) {
    // WebAuthn 中断（AbortError）→ 不泄错，静默回 Default
    if (error instanceof DOMException && error.name === "AbortError") return;
    errorKey.value = mapErrorToContractKey(error, false);
    if (errorKey.value === "auth.account_locked") locked.value = true;
  } finally {
    loading.value = false;
  }
}

/** E1 强制改密提交（G-8 降级：eiam 无改密端点，提交按降级处理） */
async function submitChangePassword(): Promise<void> {
  clearError();
  if (!newPassword.value || !confirmPassword.value) {
    fieldErrors.value = {
      newPassword: "请输入新密码",
      confirmPassword: "请确认新密码",
    };
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    fieldErrors.value = { confirmPassword: "两次输入的密码不一致" };
    return;
  }
  // G-8 降级：eiam 无首登强制改密承载端点（parity §3.1 G-8），提交不发出请求，
  // 中性提示改密端点形状待 Phase 0 核实（已核实不存在）。eiam 排期补齐后接线。
  errorKey.value = "auth.first_login_change_password";
}

function selectTab(tab: Tab): void {
  if (tab === activeTab.value) return;
  clearError();
  activeTab.value = tab;
}

const tabLabel: Record<Tab, string> = {
  password: "密码",
  ldap: "LDAP",
  passkey: "Passkey",
};
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <header class="login-header">
        <div class="login-logo" aria-hidden="true">◆</div>
        <h1 class="login-title">Platform</h1>
      </header>

      <!-- 强制改密态（E1 骨架，G-8 降级） -->
      <section
        v-if="phase === 'mustChangePassword'"
        class="login-body"
        data-phase="mustChangePassword"
      >
        <p class="login-error" role="alert" data-error="first-login">
          <CopyContractText
            code="auth.first_login_change_password"
            tag="span"
          />
        </p>
        <form class="login-form" @submit.prevent="submitChangePassword">
          <label class="login-field">
            <span class="login-label"
              >新密码<span class="login-required">*</span></span
            >
            <input
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              class="login-input"
              :aria-describedby="
                fieldErrors.newPassword ? 'new-password-error' : undefined
              "
              :aria-invalid="!!fieldErrors.newPassword"
            />
            <span
              v-if="fieldErrors.newPassword"
              id="new-password-error"
              class="login-field-error"
              role="alert"
              >{{ fieldErrors.newPassword }}</span
            >
          </label>
          <label class="login-field">
            <span class="login-label"
              >确认新密码<span class="login-required">*</span></span
            >
            <input
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              class="login-input"
              :aria-describedby="
                fieldErrors.confirmPassword
                  ? 'confirm-password-error'
                  : undefined
              "
              :aria-invalid="!!fieldErrors.confirmPassword"
            />
            <span
              v-if="fieldErrors.confirmPassword"
              id="confirm-password-error"
              class="login-field-error"
              role="alert"
              >{{ fieldErrors.confirmPassword }}</span
            >
          </label>
          <button type="submit" class="login-submit" :disabled="submitting">
            {{ submitting ? "提交中…" : "修改密码" }}
          </button>
        </form>
      </section>

      <!-- MFA challenge 态 -->
      <section v-else-if="phase === 'mfa'" class="login-body" data-phase="mfa">
        <p
          v-if="errorRenderKey"
          class="login-error"
          role="alert"
          :data-error="locked ? 'locked' : 'mfa'"
        >
          <CopyContractText
            v-if="locked"
            code="auth.account_locked"
            tag="span"
          />
          <CopyContractText v-else :code="errorKey" tag="span" />
        </p>
        <form class="login-form" @submit.prevent="submitMfa">
          <label class="login-field">
            <span class="login-label"
              >验证码<span class="login-required">*</span></span
            >
            <input
              v-model="mfaCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              class="login-input"
              data-testid="mfa-code"
              :aria-describedby="
                fieldErrors.mfaCode ? 'mfa-code-error' : undefined
              "
              :aria-invalid="!!fieldErrors.mfaCode"
            />
            <span
              v-if="fieldErrors.mfaCode"
              id="mfa-code-error"
              class="login-field-error"
              role="alert"
              >{{ fieldErrors.mfaCode }}</span
            >
          </label>
          <button type="submit" class="login-submit" :disabled="submitting">
            {{ submitting ? "验证中…" : "验证" }}
          </button>
        </form>
      </section>

      <!-- Default 登录态 -->
      <section v-else class="login-body" data-phase="login">
        <p
          v-if="errorRenderKey"
          class="login-error"
          role="alert"
          :data-error="locked ? 'locked' : 'credentials'"
        >
          <CopyContractText
            v-if="locked"
            code="auth.account_locked"
            tag="span"
          />
          <CopyContractText v-else :code="errorKey" tag="span" />
        </p>

        <!-- passkey 不可用提示（E8） -->
        <p
          v-if="!webAuthnAvailable && activeTab === 'passkey'"
          class="login-hint"
          role="alert"
          data-error="passkey-unsupported"
        >
          <CopyContractText code="auth.passkey_unsupported" tag="span" />
        </p>

        <nav class="login-tabs" role="tablist" aria-label="登录方式">
          <button
            v-for="tab in tabs"
            :key="tab"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab"
            :class="['login-tab', { 'login-tab--active': activeTab === tab }]"
            @click="selectTab(tab)"
          >
            {{ tabLabel[tab] }}
          </button>
        </nav>

        <form
          v-if="activeTab !== 'passkey'"
          class="login-form"
          @submit.prevent="submitCredentialLogin"
        >
          <label class="login-field">
            <span class="login-label"
              >用户名<span class="login-required">*</span></span
            >
            <input
              v-model="username"
              type="text"
              name="username"
              id="username"
              autocomplete="username"
              class="login-input"
              data-testid="username"
            />
          </label>
          <label class="login-field">
            <span class="login-label"
              >密码<span class="login-required">*</span></span
            >
            <input
              v-model="password"
              type="password"
              name="password"
              id="password"
              autocomplete="current-password"
              class="login-input"
              data-testid="password"
            />
          </label>
          <label v-if="activeTab === 'ldap'" class="login-field">
            <span class="login-label">身份源 ID</span>
            <input
              v-model="ldapSourceId"
              type="text"
              name="identity-source-id"
              inputmode="numeric"
              class="login-input"
              data-testid="ldap-source-id"
            />
          </label>
          <button type="submit" class="login-submit" :disabled="submitting">
            {{ submitting ? "登录中…" : "登录" }}
          </button>
        </form>

        <form v-else class="login-form" @submit.prevent="submitPasskeyLogin">
          <p class="login-passkey-hint">点击下方按钮使用 Passkey 登录。</p>
          <button type="submit" class="login-submit" :disabled="submitting">
            {{ submitting ? "登录中…" : "Passkey 登录" }}
          </button>
        </form>
      </section>

      <footer class="login-footer">
        <a class="login-help" href="#" rel="noreferrer">需要帮助？</a>
      </footer>
    </div>
  </div>
</template>

<style scoped lang="scss">
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
  padding: 24px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: var(--bg-elevated);
  border-radius: 8px;
  box-shadow: var(--shadow-base);
  padding: 32px 28px;
}

.login-header {
  text-align: center;
  margin-bottom: 24px;
}

.login-logo {
  color: var(--accent-primary);
  font-size: 28px;
  margin-bottom: 8px;
}

.login-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 24px;
  font-weight: 700;
}

.login-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-error {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
  line-height: 1.5;
}

.login-hint {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
  color: var(--color-warning);
  font-size: 13px;
}

.login-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-subtle);
}

.login-tab {
  flex: 1;
  padding: 10px 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 8px 8px 0 0;
}

.login-tab--active {
  color: var(--accent-blue);
  border-bottom: 2px solid var(--accent-primary);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.login-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.login-label {
  color: var(--text-regular);
  font-size: 13px;
}

.login-required {
  color: var(--color-danger);
  margin-left: 2px;
}

.login-input {
  height: 40px;
  padding: 0 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
}

.login-input:focus {
  outline: none;
  border-color: var(--input-border-focus);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-blue) 35%, transparent);
}

.login-input[aria-invalid="true"] {
  border-color: var(--color-danger);
}

.login-field-error {
  color: var(--color-danger);
  font-size: 12px;
}

.login-submit {
  height: 40px;
  border: none;
  border-radius: 8px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.login-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-passkey-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: 13px;
}

.login-footer {
  margin-top: 24px;
  text-align: center;
}

.login-help {
  color: var(--accent-blue);
  font-size: 13px;
  text-decoration: none;
}
</style>
