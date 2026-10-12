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
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  profileEnvelope,
  WORKBENCH_PATH,
} from '../eiam-sso-login/helpers'

test.describe('dev-subsystem-startup / Smoke: web happy path', () => {
  test('developer accesses platform with valid session and starts work', async ({ page }) => {
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
