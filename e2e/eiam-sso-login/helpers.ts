/**
 * Shared helpers for eiam-sso-login journey E2E tests.
 *
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tiers (transparently labeled per test):
 * ① REAL — real eiam + real nginx + real shared cookie. Uses admin/12345678. Zero page.route.
 * ② CONTRACT — page.route fulfills eiam response envelopes per parity-checklist §3.2.
 *   Browser + nginx are real; only API response bodies are fulfilled.
 *
 * Fact Table (source: haven-console code reconnaissance):
 * - Session cookie: ecmdb-token-key (shared domain-level, Path=/)
 * - Login route (browser): /console/login
 * - Login endpoint: POST /api/iam/user/system/login
 * - Profile endpoint: GET /api/iam/user/profile
 * - Logout endpoint: POST /api/iam/user/logout
 * - MFA verify endpoint: POST /api/iam/user/login/mfa/verify
 * - Envelope shape: { code: number, msg: string, data: T }  (code===0 = success)
 * - 401 behavior: hard window.location.href redirect to /console/login?redirect=<url>
 * - 403 behavior: stay on page, ElMessage toast "无权限执行该操作"
 * - Login success: no token field in body; session via Set-Cookie only
 * - workbench data-testid: "workbench"
 * - Login testids: "username", "password", "mfa-code"
 */
import type { Page, Route } from '@playwright/test'

// ---- Constants ----

export const BASE_URL = 'http://localhost:8888'
export const LOGIN_PATH = '/console/login'
export const WORKBENCH_PATH = '/console/workbench'
export const SESSION_COOKIE_KEY = 'ecmdb-token-key'
export const REDIRECT_PARAM = 'redirect'

// Real admin credentials (dev eiam seed)
export const ADMIN_USER = 'admin'
export const ADMIN_PWD = '12345678'

// Eiam error messages (verbatim from eiam/internal/web/user/errs.go)
export const EIAM_INVALID_USER_MSG = '认证失败 (账号或密码错误)'
export const EIAM_USER_LOCKED_MSG = '账号由于多次输入错误已被锁定，请稍后再试'
export const EIAM_MFA_INVALID_MSG = '验证码不正确'
export const EIAM_MFA_LOCKED_MSG = '验证失败次数过多，请重新登录'

// ---- Envelope construction (parity §3.2 snake_case verified shape) ----

export function envelope(data: unknown, code = 0, msg = 'ok'): unknown {
  return { code, msg, data }
}

export function errorEnvelope(code: number, msg: string): unknown {
  return { code, msg, data: null }
}

/** Password/LDAP login success envelope (B-2: no token field, session via Set-Cookie) */
export function loginOkEnvelope(extra: Record<string, unknown> = {}): unknown {
  return envelope({ mfa_required: false, ...extra })
}

/** Profile envelope (user store mapProfile normalization source) */
export function profileEnvelope(
  tenants: Array<{ id: number; name: string; code: string; domain: string }> = [],
  isAdmin = true,
): unknown {
  return envelope({
    user: { id: 1, username: 'admin', nickname: '管理员' },
    tenants,
    current_tenant_id: tenants[0]?.id ?? 0,
    is_admin: isAdmin,
    permissions: [],
    must_select_tenant: false, // F-1: always false; frontend computes tenants.length
  })
}

// ---- CONTRACT route fulfillment installer ----

/**
 * Install page.route to fulfill /api/iam/* auth route responses.
 * handler: (url, body) => {status, body, headers?}, dispatched by URL substring.
 *
 * Session cookie: login/verify success responses attach Set-Cookie (ecmdb-token-key)
 * so the browser cookie store + hasSessionCookie() guard operate on a real chain.
 * This is NOT a mock browser session — form submit → response Set-Cookie → guard
 * validation is a real chain; only API response bodies are fulfilled.
 */
export async function fulfillAuthRoutes(
  page: Page,
  handler: (
    url: string,
    body: unknown,
  ) => { status: number; body: unknown; headers?: Record<string, string> },
): Promise<void> {
  await page.route('**/api/iam/user/**', async (route: Route) => {
    const url = route.request().url()
    const method = route.request().method()
    let postBody: unknown = undefined
    if (method === 'POST') {
      try {
        postBody = route.request().postDataJSON()
      } catch {
        postBody = undefined
      }
    }
    const reply = handler(url, postBody)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(reply.headers ?? {}),
    }
    if (reply.status >= 200 && reply.status < 300) {
      headers['Set-Cookie'] = `${SESSION_COOKIE_KEY}=e2e-contract-session; Path=/; SameSite=Lax`
    }
    await route.fulfill({
      status: reply.status,
      headers,
      body: JSON.stringify(reply.body),
    })
  })
}

// ---- Page operation helpers ----

export async function gotoLogin(page: Page): Promise<void> {
  await page.goto(LOGIN_PATH)
  await page.getByText('Platform', { exact: true }).waitFor({ state: 'visible' })
}

export async function fillCredentials(page: Page, user: string, pwd: string): Promise<void> {
  await page.getByTestId('username').fill(user)
  await page.getByTestId('password').fill(pwd)
}

export async function submitCredentialForm(page: Page): Promise<void> {
  await page.getByRole('button', { name: '登录', exact: true }).click()
}

/**
 * Login with real admin credentials (REAL tier).
 * Asserts landing on workbench or tenant-select.
 */
export async function loginRealAdmin(page: Page): Promise<void> {
  await gotoLogin(page)
  await fillCredentials(page, ADMIN_USER, ADMIN_PWD)
  await submitCredentialForm(page)
  await page.waitForURL(/\/console\/(tenant-select|workbench)$/, { timeout: 15_000 })
  await page.goto(WORKBENCH_PATH)
}

/**
 * Login via CONTRACT tier (fulfilled eiam responses).
 * Sets up route fulfillment for login + profile, fills credentials, submits.
 */
export async function loginContract(page: Page): Promise<void> {
  await fulfillAuthRoutes(page, (url: string) => {
    if (url.includes('/system/login')) {
      return { status: 200, body: loginOkEnvelope() }
    }
    if (url.includes('/profile')) {
      return {
        status: 200,
        body: profileEnvelope([
          { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
        ]),
      }
    }
    if (url.includes('/logout')) {
      return { status: 200, body: envelope(null) }
    }
    return { status: 200, body: envelope(null) }
  })
  await gotoLogin(page)
  await fillCredentials(page, ADMIN_USER, ADMIN_PWD)
  await submitCredentialForm(page)
  await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })
}
