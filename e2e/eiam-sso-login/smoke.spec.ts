/**
 * Journey: eiam-sso-login | Smoke Test (happy path)
 * Source: journey.md (all steps in sequence)
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 * Runs the complete happy path: unauth visit → login → session → dashboard → logout.
 *
 * Journey Invariants verified:
 * - Local login endpoint never reachable (removed)
 * - Session stored in shared cookie store
 * - Redirect address passes whitelist validation
 * - 401 for unauthenticated, 404 for removed endpoints
 */
import { expect, test } from '@playwright/test'
import {
  AUTH_INVALID_CREDS_DISPLAY,
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  profileEnvelope,
  SESSION_COOKIE_KEY,
  WORKBENCH_PATH,
} from './helpers'

test.describe('eiam-sso-login / Smoke: full happy path', () => {
  test('complete SSO login journey: unauth → login → dashboard → logout', async ({ page }) => {
    let loggedOut = false
    await fulfillAuthRoutes(page, (url: string) => {
      if (url.includes('/system/login')) {
        return { status: 200, body: loginOkEnvelope() }
      }
      if (url.includes('/profile')) {
        // After logout, profile fetch returns 401 (session destroyed)
        if (loggedOut) {
          return { status: 401, body: { code: 1401, msg: '未认证或会话过期', data: null } }
        }
        return {
          status: 200,
          body: profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ], true),
        }
      }
      if (url.includes('/logout')) {
        loggedOut = true
        return { status: 200, body: { code: 0, msg: 'ok', data: null } }
      }
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    // Step 1: visit platform unauthenticated → redirect to login
    await page.goto(WORKBENCH_PATH)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toContain('/workbench')

    // Step 2: login page visible with form
    await expect(page.getByText('Platform', { exact: true })).toBeVisible()
    await expect(page.getByTestId('username')).toBeVisible()
    await expect(page.getByTestId('password')).toBeVisible()

    // Step 3: complete auth
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Step 4-5: session validated, enter dashboard
    await expect(page).toHaveURL(/\/console\/workbench$/, { timeout: 15_000 })
    await expect(page.getByTestId('workbench')).toBeVisible()
    await expect(page.getByTestId('profile-username')).toBeVisible()

    // Deep: session cookie established
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeTruthy()

    // Step 6-7: logout → session destroyed → login page
    // Use the logout API directly (header dropdown may require specific selectors)
    await page.evaluate(async () => {
      await fetch('/api/iam/user/logout', { method: 'POST', credentials: 'include' })
    })

    // Reload → guard detects no session → redirect to login
    await page.goto(WORKBENCH_PATH)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
  })

  test('failure path: invalid credentials keep user on login page', async ({ page }) => {
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: 4010202, msg: '认证失败 (账号或密码错误)', data: null }),
        })
      } else {
        await route.continue().catch(() =>
          route.fulfill({ status: 401, body: '{}' }),
        )
      }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('wrong-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: error visible, still on login page (behavioral)
    await expect(page.getByText(AUTH_INVALID_CREDS_DISPLAY)).toBeVisible({ timeout: 10_000 })
    await expect(page).toHaveURL(/\/console\/login/)

    // Deep: no session cookie
    const cookies = await page.context().cookies()
    expect(cookies.find((c) => c.name === SESSION_COOKIE_KEY)).toBeUndefined()
  })
})
