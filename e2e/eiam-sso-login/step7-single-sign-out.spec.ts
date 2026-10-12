/**
 * Journey: eiam-sso-login | Step 7: 单点登出
 * Source: contracts/step-7-single-sign-out.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: REAL — real eiam + real nginx + real shared cookie.
 * Uses admin/12345678 (dev eiam seed). Zero page.route.
 * Hard Rule: must not mock browser session for SSO logout tests.
 *
 * Contract Outcomes:
 * - success: Logout → session destroyed, redirect to login
 * - other-tab-401: Other tab → 401 → redirect to login
 */
import { expect, test } from '@playwright/test'
import {
  ADMIN_PWD,
  ADMIN_USER,
  gotoLogin,
  LOGIN_PATH,
  SESSION_COOKIE_KEY,
  WORKBENCH_PATH,
} from './helpers'

test.describe('eiam-sso-login / Step 7: single sign out', () => {
  // Step 7 / Outcome "success": user logs out → session destroyed → login page
  test('logout destroys session and redirects to login page', async ({ page }) => {
    // REAL: login with real admin
    await gotoLogin(page)
    await page.getByTestId('username').fill(ADMIN_USER)
    await page.getByTestId('password').fill(ADMIN_PWD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/(tenant-select|workbench)$/, { timeout: 15_000 })
    await page.goto(WORKBENCH_PATH)

    // Assert: authenticated (behavioral — state verification)
    await expect(page.getByTestId('workbench')).toBeVisible()

    // Act: click logout via header dropdown
    await page.locator('.app-header .header-user-trigger').click()
    await page.getByText('登出', { exact: true }).click()

    // Assert: redirected to login page (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    // Deep: session cookie cleared by eiam logout response
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie?.value).toBeFalsy()
  })

  // Step 7 / Outcome "other-tab-401": logout in one tab → other tab 401
  test('logout in one tab invalidates session in other tab', async ({ browser }) => {
    // REAL: two pages sharing the same browser context (shared cookie jar)
    const context = await browser.newContext()
    const page1 = await context.newPage()
    const page2 = await context.newPage()

    // Login on page1
    await page1.goto(`${LOGIN_PATH}`)
    await page1.getByText('Platform', { exact: true }).waitFor({ state: 'visible' })
    await page1.getByTestId('username').fill(ADMIN_USER)
    await page1.getByTestId('password').fill(ADMIN_PWD)
    await page1.getByRole('button', { name: '登录', exact: true }).click()
    await page1.waitForURL(/\/console\/(tenant-select|workbench)$/, { timeout: 15_000 })
    await page1.goto(WORKBENCH_PATH)
    await expect(page1.getByTestId('workbench')).toBeVisible()

    // Page2: also authenticated (shared cookie)
    await page2.goto(WORKBENCH_PATH)
    await expect(page2.getByTestId('workbench')).toBeVisible()

    // Act: logout on page1
    await page1.locator('.app-header .header-user-trigger').click()
    await page1.getByText('登出', { exact: true }).click()
    await expect(page1).toHaveURL(/\/console\/login/, { timeout: 10_000 })

    // Act: page2 makes a request → 401 → redirect to login
    await page2.reload()

    // Deep: page2 also redirected to login (cross-tab SSO invalidation)
    await expect(page2).toHaveURL(/\/console\/login/, { timeout: 15_000 })

    await context.close()
  })
})
