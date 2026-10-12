/**
 * Journey: eiam-sso-login | Step 3: 完成平台账号认证
 * Source: contracts/step-3-complete-eiam-auth.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 *
 * Contract Outcomes:
 * - success: Enter credentials → session created, redirect back
 * - auth-failure: Wrong credentials → error message, no session
 * - form-validation-error: Empty fields → inline validation, no backend request
 * - redirect-whitelist-fail: Malicious redirect → fallback to default path
 */
import { expect, test } from '@playwright/test'
import {
  AUTH_INVALID_CREDS_DISPLAY,
  EIAM_INVALID_USER_MSG,
  errorEnvelope,
  fulfillAuthRoutes,
  gotoLogin,
  loginOkEnvelope,
  LOGIN_PATH,
  profileEnvelope,
  SESSION_COOKIE_KEY,
} from './helpers'

test.describe('eiam-sso-login / Step 3: complete eiam auth', () => {
  // Step 3 / Outcome "success": valid credentials → session created, redirect to workbench
  test('valid credentials create session and redirect to dashboard', async ({ page }) => {
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
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: redirected to workbench (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/workbench$/)
    // Deep: session cookie established
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeTruthy()
    // Assert: workbench loaded with profile data (behavioral — content)
    await expect(page.getByTestId('workbench')).toBeVisible()
    await expect(page.getByTestId('profile-username')).toBeVisible()
  })

  // Step 3 / Outcome "auth-failure": wrong credentials → error message, no session
  test('invalid credentials show generic error without session', async ({ page }) => {
    let loginRequested = false
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        loginRequested = true
        await route.fulfill({
          status: 500, // eiam returns business errors as HTTP 500
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorEnvelope(4010202, EIAM_INVALID_USER_MSG)),
        })
      } else if (url.includes('/profile')) {
        await route.fulfill({
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
        })
      } else {
        await route.continue()
      }
    })

    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('wrong-password')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: error message displayed (behavioral — content verification)
    await expect(page.getByText(AUTH_INVALID_CREDS_DISPLAY)).toBeVisible({ timeout: 10_000 })
    // Assert: still on login page (behavioral — navigation verification)
    await expect(page).toHaveURL(/\/console\/login/)
    // Deep: no session cookie created
    expect(loginRequested).toBe(true)
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeUndefined()
  })

  // Step 3 / Outcome "form-validation-error": empty fields → inline validation, no request
  test('empty form fields show inline validation without backend request', async ({ page }) => {
    let backendCalled = false
    await page.route('**/api/iam/user/**', async (route) => {
      backendCalled = true
      await route.continue().catch(() =>
        route.fulfill({ status: 200, body: '{}' }),
      )
    })

    await gotoLogin(page)
    // Submit without filling any fields
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: inline validation error visible (behavioral — content verification)
    // The form should show required field validation
    await expect(page.getByText(/必填|请输入|不能为空/)).toBeVisible({ timeout: 5_000 })
    // Assert: still on login page (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/)
    // Deep: no backend request was sent (behavioral — no side-effect)
    expect(backendCalled).toBe(false)
  })

  // Step 3 / Outcome "redirect-whitelist-fail": malicious redirect → fallback to default
  test('malicious redirect param falls back to default dashboard path', async ({ page }) => {
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
      return { status: 200, body: { code: 0, msg: 'ok', data: null } }
    })

    // Navigate to login with a malicious redirect param (javascript: scheme)
    await page.goto(`${LOGIN_PATH}?redirect=javascript:alert(1)`)
    await page.getByText('Platform', { exact: true }).waitFor({ state: 'visible' })
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: redirected to workbench, NOT javascript execution (behavioral — security)
    await expect(page).toHaveURL(/\/console\/workbench$/)
    // Deep: URL does not contain javascript scheme (open redirect prevented)
    const currentUrl = page.url()
    expect(currentUrl).not.toContain('javascript:')
  })
})
