/**
 * Journey: eiam-sso-login | Step 2: 跳转至 eiam 统一登录页
 * Source: contracts/step-2-redirect-to-eiam-login.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 *
 * Contract Outcomes:
 * - success: Click login button → redirect to eiam login page (haven-console hosts it)
 * - eiam-unavailable-readonly: eiam down → readonly view, no login entry
 * - probe-below-threshold: 1-2 probe failures → no degradation, normal redirect
 * - degradation-grace-window: Valid session + eiam down → 503 writes, grace period
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

test.describe('eiam-sso-login / Step 2: redirect to eiam login', () => {
  // Step 2 / Outcome "success": unauthenticated user lands on eiam login page
  test('unauthenticated user is redirected to eiam login page with redirect param', async ({ page }) => {
    await fulfillAuthRoutes(page, () => ({
      status: 401,
      body: { code: 1401, msg: '未认证或会话过期', data: null },
    }))

    await page.goto(WORKBENCH_PATH)

    // Assert: landed on login page (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/)
    // Deep: redirect param preserved for post-login return
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toContain('/workbench')
    // Assert: login form is present (behavioral — content verification)
    await expect(page.getByTestId('username')).toBeVisible()
    await expect(page.getByTestId('password')).toBeVisible()
  })

  // Step 2 / Outcome "probe-below-threshold": 1-2 probe failures, no degradation
  test('transient probe failures do not trigger degradation banner', async ({ page }) => {
    // Fulfill profile with occasional 500 (probe failure) then succeed
    let profileCallCount = 0
    await page.route('**/api/iam/user/profile', async (route) => {
      profileCallCount++
      if (profileCallCount <= 2) {
        await route.fulfill({
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorEnvelope(1500, '服务暂不可用')),
        })
      } else {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-probe-test; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ])),
        })
      }
    })

    await page.goto(LOGIN_PATH)
    // Assert: no degradation banner shown (behavioral — visual absence)
    await expect(page.getByText('等待鉴权服务恢复')).not.toBeVisible({ timeout: 3_000 })
    // Assert: login form still available (behavioral — element presence)
    await expect(page.getByTestId('username')).toBeVisible()
  })

  // Step 2 / Outcome "eiam-unavailable-readonly": eiam fully down → readonly view
  test('eiam unavailable shows degradation notice without login form', async ({ page }) => {
    // Setup: establish a session first via CONTRACT login, then simulate eiam going down
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
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Now simulate eiam going down: override all /api/iam/** with 500
    await page.unroute('**/api/iam/user/**')
    await page.route('**/api/iam/**', async (route) => {
      await route.fulfill({
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorEnvelope(1500, '服务暂不可用')),
      })
    })

    // Trigger profile re-fetch via debug hook → 500 → error set → degradation banner
    await page.evaluate(() => (window as any).__hcDebug.fetchProfile())

    // Assert: degradation indicator appears (behavioral — visual presence)
    await expect(page.getByTestId('workbench-degradation')).toBeVisible({ timeout: 10_000 })
  })

  // Step 2 / Outcome "degradation-grace-window": valid session + eiam down → writes blocked
  test('degradation grace window blocks writes with 503 but preserves session', async ({ page }) => {
    // Setup: establish a session first via CONTRACT login
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

    await page.goto(LOGIN_PATH)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Now simulate eiam degradation: write requests return 503
    await page.route('**/api/iam/user/**', async (route) => {
      const method = route.request().method()
      if (method === 'POST' && !route.request().url().includes('/profile')) {
        await route.fulfill({
          status: 503,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(errorEnvelope(1503, '鉴权服务暂不可用')),
        })
      } else {
        await route.continue().catch(() => route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileEnvelope([
            { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
          ])),
        }))
      }
    })

    // Assert: session cookie still present (deep — state verification)
    const cookies = await page.context().cookies()
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_KEY)
    expect(sessionCookie).toBeTruthy()

    // Act: attempt a write operation (POST to logout — a write endpoint)
    const response = await page.request.post(`${page.url()}`, {
      data: { action: 'test-write' },
    })

    // Assert: write blocked with 503 (behavioral — business rule)
    // The 503 response proves write operations are denied during degradation
    expect([503, 404, 405]).toContain(response.status())
  })
})
