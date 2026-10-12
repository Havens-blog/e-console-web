/**
 * Journey: eiam-sso-login | Step 5: 进入告警看板
 * Source: contracts/step-5-enter-dashboard.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 *
 * Contract Outcomes:
 * - success: User enters dashboard → role-level features loaded
 */
import { expect, test } from '@playwright/test'
import {
  ADMIN_PERMISSIONS,
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  profileEnvelope,
  SESSION_COOKIE_KEY,
} from './helpers'

test.describe('eiam-sso-login / Step 5: enter dashboard', () => {
  // Step 5 / Outcome "success": authenticated user with role sees workbench
  test('authenticated admin sees workbench with full feature set', async ({ page }) => {
    // Use page.route directly (not fulfillAuthRoutes) to avoid Set-Cookie on profile response
    await page.route('**/api/iam/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-step5; Path=/; SameSite=Lax` },
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

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Assert: workbench container visible (behavioral — content presence)
    await expect(page.getByTestId('workbench')).toBeVisible()
    // Assert: profile data rendered (behavioral — content verification)
    await expect(page.getByTestId('profile-username')).toBeVisible()
    await expect(page.getByTestId('profile-nickname')).toBeVisible()
    // Deep: admin-level stat cards visible (role-level feature verification)
    await expect(page.getByTestId('stat-card-users')).toBeVisible()
    await expect(page.getByTestId('stat-card-roles')).toBeVisible()
    await expect(page.getByTestId('stat-card-tenants')).toBeVisible()
    // Deep: app navigation cards present (platform integration visible)
    await expect(page.getByTestId('app-card-watchalert')).toBeVisible()
  })

  // Step 5 / Outcome "success" variant: non-admin user sees restricted features
  test('authenticated non-admin sees workbench with limited features', async ({ page }) => {
    await fulfillAuthRoutes(page, (url: string) => {
      if (url.includes('/system/login')) {
        return { status: 200, body: loginOkEnvelope() }
      }
      if (url.includes('/profile')) {
        return {
          status: 200,
          body: profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ], false), // isAdmin = false → user role
        }
      }
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Assert: workbench visible (behavioral — content)
    await expect(page.getByTestId('workbench')).toBeVisible()
    // Assert: profile rendered (behavioral — content)
    await expect(page.getByTestId('profile-username')).toBeVisible()
    // Deep: admin-only stat cards NOT visible (role-level restriction enforced)
    await expect(page.getByTestId('stat-card-tenants')).not.toBeVisible({ timeout: 3_000 })
  })
})
