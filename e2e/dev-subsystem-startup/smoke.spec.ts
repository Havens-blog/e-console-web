/**
 * Journey: dev-subsystem-startup | Smoke Test (web-interactive happy path)
 * Source: journey.md (Step 5 web path)
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 * Covers the web-interactive portion: access platform with valid session.
 *
 * Journey Invariants:
 * - Backend and frontend started via single command
 * - watch-alert subproject managed under same surface registry
 * - Compile failures always prominently marked
 */
import { expect, test } from '@playwright/test'
import {
  ADMIN_PERMISSIONS,
  gotoLogin,
  loginOkEnvelope,
  SESSION_COOKIE_KEY,
} from '../eiam-sso-login/helpers'

test.describe('dev-subsystem-startup / Smoke: web happy path', () => {
  test('developer accesses platform with valid session and starts work', async ({ page }) => {
    // Use page.route directly (not fulfillAuthRoutes) to avoid Set-Cookie on profile response
    await page.route('**/api/iam/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-devsmoke; Path=/; SameSite=Lax` },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: 0, msg: 'ok',
            data: {
              user: { id: 1, username: 'admin', nickname: '管理员' },
              tenants: [{ id: 1, name: '默认租户', code: 'default', domain: 'localhost' }],
              current_tenant_id: 1,
              is_admin: true,
              permissions: ADMIN_PERMISSIONS,
              must_select_tenant: false,
            },
          }),
        })
      } else {
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 0, msg: 'ok', data: null }) })
      }
    })

    // Step 5 success: access platform, login, see workbench
    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Assert: workbench loaded (behavioral — content)
    await expect(page.getByTestId('workbench')).toBeVisible()
    // Assert: profile visible (behavioral — content)
    await expect(page.getByTestId('profile-username')).toBeVisible()
    // Deep: WatchAlert app card visible (integration confirmed, state: platform ready)
    await expect(page.getByTestId('app-card-watchalert')).toBeVisible()
    // Deep: admin stat cards present (role-level features unlocked)
    await expect(page.getByTestId('stat-card-users')).toBeVisible()
  })
})
