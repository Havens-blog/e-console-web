/**
 * Journey: eiam-sso-login | Step 1: 访问告警平台（未登录态）
 * Source: contracts/step-1-access-unauth-platform.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 * Browser + nginx are real; only API response bodies are fulfilled.
 *
 * Contract Outcomes:
 * - success: Visit platform unauth → show login redirect entry, no local login form
 * - local-login-endpoint-404: POST to removed /api/system/login → 404
 */
import { expect, test } from '@playwright/test'
import {
  BASE_URL,
  fulfillAuthRoutes,
  LOGIN_PATH,
  WORKBENCH_PATH,
} from './helpers'

test.describe('eiam-sso-login / Step 1: access unauth platform', () => {
  // Step 1 / Outcome "success": unauthenticated visit redirects to login page
  test('unauthenticated visit redirects to eiam login page', async ({ page }) => {
    // CONTRACT: fulfill profile request with 401 to simulate no session
    await fulfillAuthRoutes(page, () => ({
      status: 401,
      body: { code: 1401, msg: '未认证或会话过期', data: null },
    }))

    // Act: visit workbench without any session cookie
    await page.goto(WORKBENCH_PATH)

    // Assert: redirected to login page (behavioral — navigation verification)
    await expect(page).toHaveURL(new RegExp(`${LOGIN_PATH.replace('/', '\\/')}`))
    // Deep: redirect query param preserves original path
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toBeTruthy()
    expect(redirect).toContain('/workbench')

    // Assert: login page heading visible (behavioral — content verification)
    await expect(page.getByText('Platform', { exact: true })).toBeVisible()
  })

  // Step 1 / Outcome "local-login-endpoint-404": removed endpoint returns 404
  test('removed local login endpoint returns 404', async ({ page }) => {
    // The old WatchAlert local login endpoint POST /api/system/login is removed.
    // haven-console delegates auth to eiam POST /api/iam/user/system/login.
    // Act: attempt POST to the removed endpoint
    const response = await page.request.post(`${BASE_URL}/api/system/login`, {
      data: { username: 'admin', password: '12345678' },
    })

    // Assert: 404 Not Found (behavioral — endpoint removed semantics)
    expect(response.status()).toBe(404)
    // Deep: no session token in response body
    const body = await response.text()
    expect(body).not.toContain('token')
  })
})
