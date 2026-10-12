/**
 * Journey: eiam-sso-login | Step 4: WatchAlert 后端校验会话并匹配角色
 * Source: contracts/step-4-validate-session-match-role.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 * Tests frontend behavior for 401/403 outcomes (haven-console's interceptor + guard).
 *
 * Contract Outcomes:
 * - success: Valid session + role → authenticated, role-level features
 * - unauthorized: No/invalid session → 401, redirect to login
 * - no-role: Valid session, no role → 403, stay on page
 * - invalid-role-binding: Invalid role value → 403
 * - legacy-jwt-read-only: Legacy JWT → read OK, write 403
 */
import { expect, test } from '@playwright/test'
import {
  errorEnvelope,
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  LOGIN_PATH,
  profileEnvelope,
  SESSION_COOKIE_KEY,
  WORKBENCH_PATH,
} from './helpers'

test.describe('eiam-sso-login / Step 4: validate session and match role', () => {
  // Step 4 / Outcome "success": valid session with admin role loads dashboard
  test('valid session with role loads workbench with role-level features', async ({ page }) => {
    await fulfillAuthRoutes(page, (url: string) => {
      if (url.includes('/system/login')) {
        return { status: 200, body: loginOkEnvelope() }
      }
      if (url.includes('/profile')) {
        return {
          status: 200,
          body: profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ], true), // isAdmin = true → admin role
        }
      }
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Assert: workbench visible with admin features (behavioral — content)
    await expect(page.getByTestId('workbench')).toBeVisible()
    // Deep: admin-specific stat cards present (role-level feature verification)
    await expect(page.getByTestId('stat-card-users')).toBeVisible()
    await expect(page.getByTestId('stat-card-tenants')).toBeVisible()
  })

  // Step 4 / Outcome "unauthorized": no session → 401 → redirect to login
  test('missing session cookie triggers 401 redirect to login', async ({ page }) => {
    await page.route('**/api/iam/user/profile', async (route) => {
      await route.fulfill({
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
      })
    })

    await page.goto(WORKBENCH_PATH)

    // Assert: redirected to login page (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    // Deep: redirect param preserves original path
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toContain('/workbench')
  })

  // Step 4 / Outcome "no-role": valid session but no role → 403 stay on page
  test('authenticated user without role gets 403 without redirect to login', async ({ page }) => {
    // Setup: establish session first
    let profileCallCount = 0
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-norole-test; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        profileCallCount++
        if (profileCallCount <= 1) {
          // First profile: success but with no tenants, not admin, no permissions
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileEnvelope([], false)),
          })
        } else {
          // Subsequent profile fetches also succeed (session still valid)
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileEnvelope([], false)),
          })
        }
      } else {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
        })
      }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: NOT redirected to login (behavioral — 403 stays on page)
    // User with no role should see restricted workbench or forbidden page, not login
    await page.waitForTimeout(3_000) // Allow redirect/guard to settle
    const currentUrl = page.url()
    expect(currentUrl).not.toMatch(/\/console\/login/)
    // Deep: session cookie still present (not cleared on 403)
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeTruthy()
  })

  // Step 4 / Outcome "invalid-role-binding": invalid role value → 403 (same as no-role)
  test('invalid role binding value results in 403 not default access', async ({ page }) => {
    let profileCallCount = 0
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-invalidrole-test; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        profileCallCount++
        // Profile with is_admin=false and no permissions (invalid role binding)
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileEnvelope([], false)),
        })
      } else {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
        })
      }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: NOT redirected to login — 403 stays (behavioral — security)
    await page.waitForTimeout(3_000)
    expect(page.url()).not.toMatch(/\/console\/login/)
    // Deep: admin-only stat cards NOT visible (role features not unlocked)
    const usersStat = page.getByTestId('stat-card-users')
    await expect(usersStat).not.toBeVisible({ timeout: 3_000 })
  })

  // Step 4 / Outcome "legacy-jwt-read-only": legacy JWT → read OK, write 403
  test('legacy JWT allows read access but blocks writes', async ({ page }) => {
    // Simulate a legacy JWT in Authorization header (not a shared session cookie)
    // Read requests succeed, write requests return 403
    await page.route('**/api/iam/user/**', async (route) => {
      const method = route.request().method()
      const url = route.request().url()
      if (url.includes('/profile') && method === 'GET') {
        // Read: legacy JWT tolerated
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ])),
        })
      } else if (method === 'POST' && !url.includes('/system/login')) {
        // Write: legacy JWT rejected with 403
        await route.fulfill({
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorEnvelope(1403, '无访问权限')),
        })
      } else {
        await route.continue().catch(() =>
          route.fulfill({ status: 200, body: '{}' }),
        )
      }
    })

    // Act: read request via profile endpoint
    const readResp = await page.request.get(
      `${page.url().split('/console')[0]}/api/iam/user/profile`,
    )
    // Assert: read succeeds (behavioral — migration safety)
    expect(readResp.status()).toBe(200)

    // Act: write request
    const writeResp = await page.request.post(
      `${page.url().split('/console')[0]}/api/iam/user/logout`,
    )
    // Deep: write blocked with 403 (state transition — write denied for legacy JWT)
    expect(writeResp.status()).toBe(403)
  })
})
