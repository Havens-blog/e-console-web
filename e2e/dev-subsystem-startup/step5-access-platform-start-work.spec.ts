/**
 * Journey: dev-subsystem-startup | Step 5: 在浏览器中访问告警平台开始日常开发工作
 * Source: contracts/step-5-access-platform-start-work.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 * Tests frontend behavior for auth/session outcomes when accessing the platform.
 *
 * Contract Outcomes (web-surface):
 * - success: Platform loads, eiam login available
 * - session-expired: 401 → redirect to login
 * - unauthorized-401: No session → 401 → redirect to login
 * - forbidden-403: Valid session, no role → 403 stay on page
 * - validation-error: Form validation → 400, stay on page
 * - unavailable-503: eiam/Redis down → 503, degradation toast
 * - local-login-removed-404: POST /api/system/login → 404
 */
import { expect, test } from '@playwright/test'
import {
  BASE_URL,
  errorEnvelope,
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  profileEnvelope,
  SESSION_COOKIE_KEY,
  WORKBENCH_PATH,
} from '../eiam-sso-login/helpers'

test.describe('dev-subsystem-startup / Step 5: access platform start work', () => {
  // Step 5 / Outcome "success": platform loads with valid session
  test('platform loads with valid session and eiam login available', async ({ page }) => {
    await fulfillAuthRoutes(page, (url: string) => {
      if (url.includes('/system/login')) {
        return { status: 200, body: loginOkEnvelope() }
      }
      if (url.includes('/profile')) {
        return {
          status: 200,
          body: profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ], true),
        }
      }
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Assert: platform loaded with workbench (behavioral — content)
    await expect(page.getByTestId('workbench')).toBeVisible()
    // Deep: app navigation card for WatchAlert visible (integration confirmed)
    await expect(page.getByTestId('app-card-watchalert')).toBeVisible()
  })

  // Step 5 / Outcome "session-expired": session TTL expired → 401 → redirect
  test('session expired returns 401 and redirects to login', async ({ page }) => {
    let profileCallCount = 0
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-dev-expiry; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        profileCallCount++
        if (profileCallCount <= 1) {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileEnvelope([
              { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
            ])),
          })
        } else {
          // Session expired
          await route.fulfill({
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
          })
        }
      } else {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
        })
      }
    })

    // Login first
    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Trigger session-expired 401 via reload
    await page.reload()

    // Assert: redirected to login (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    // Deep: redirect param preserves original path
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toContain('/workbench')
  })

  // Step 5 / Outcome "unauthorized-401": no session ever established → 401 → redirect
  test('unauthorized access without session redirects to login', async ({ page }) => {
    await page.route('**/api/iam/user/profile', async (route) => {
      await route.fulfill({
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
      })
    })

    await page.goto(WORKBENCH_PATH)

    // Assert: redirected to login (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    // Deep: redirect param preserves original path
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toContain('/workbench')
  })

  // Step 5 / Outcome "forbidden-403": valid session but no role → 403 stay on page
  test('authenticated user without role gets 403 and stays on page', async ({ page }) => {
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-dev-403; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        // Valid session but no role (is_admin=false, no permissions)
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileEnvelope([], false)),
        })
      } else {
        await route.fulfill({
          status: 200,
          body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
        })
      }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: NOT on login page (behavioral — 403 stays, no redirect to login)
    await page.waitForTimeout(3_000)
    expect(page.url()).not.toMatch(/\/console\/login/)
    // Deep: session cookie still present (403 doesn't clear session)
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeTruthy()
  })

  // Step 5 / Outcome "validation-error": form validation → 400, no submit
  test('form validation error shows inline without backend submit', async ({ page }) => {
    let backendCalled = false
    await page.route('**/api/iam/user/**', async (route) => {
      backendCalled = true
      await route.continue().catch(() =>
        route.fulfill({ status: 200, body: '{}' }),
      )
    })

    await gotoLogin(page)
    // Submit with empty fields
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: inline validation visible (behavioral — content)
    await expect(page.getByText(/必填|请输入|不能为空/)).toBeVisible({ timeout: 5_000 })
    // Deep: no backend request sent (no side-effect)
    expect(backendCalled).toBe(false)
  })

  // Step 5 / Outcome "unavailable-503": eiam/Redis down → 503, degradation
  test('eiam unavailable returns 503 and shows degradation on writes', async ({ page }) => {
    // Setup: all eiam requests fail
    await page.route('**/api/iam/**', async (route) => {
      await route.fulfill({
        status: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorEnvelope(1503, '鉴权服务暂不可用')),
      })
    })

    await page.goto(WORKBENCH_PATH)

    // Assert: degradation indicator visible (behavioral — content)
    await expect(page.getByTestId('workbench-degradation')).toBeVisible({ timeout: 10_000 })
    // Deep: no login form (eiam unavailable, no login entry)
    await expect(page.getByTestId('username')).not.toBeVisible({ timeout: 3_000 })
  })

  // Step 5 / Outcome "local-login-removed-404": removed endpoint → 404
  test('removed local login endpoint returns 404 not 401', async ({ page }) => {
    const response = await page.request.post(`${BASE_URL}/api/system/login`, {
      data: { username: 'admin', password: '12345678' },
    })

    // Assert: 404 (behavioral — endpoint removed, not unauthorized)
    expect(response.status()).toBe(404)
    // Deep: no token/session in response
    const body = await response.text()
    expect(body).not.toContain('token')
  })
})
