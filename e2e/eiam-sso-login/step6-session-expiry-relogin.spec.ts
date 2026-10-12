/**
 * Journey: eiam-sso-login | Step 6: 使用中会话过期后重登回原路径
 * Source: contracts/step-6-session-expiry-relogin.md
 * @feature: watchalert-subproject-integration
 * @web-e2e
 *
 * Evidence tier: CONTRACT — page.route fulfills eiam API responses.
 *
 * Contract Outcomes:
 * - success: Relogin → return to original path
 * - session-expired: 401 → redirect to login (preserve original path)
 * - session-expired-eiam-unavailable: 401 + eiam down → readonly view
 */
import { expect, test } from '@playwright/test'
import {
  errorEnvelope,
  gotoLogin,
  loginOkEnvelope,
  profileEnvelope,
  SESSION_COOKIE_KEY,
  WORKBENCH_PATH,
} from './helpers'

test.describe('eiam-sso-login / Step 6: session expiry and relogin', () => {
  // Step 6 / Outcome "session-expired": session TTL expires → 401 → redirect to login
  test('expired session triggers 401 redirect to login with path preservation', async ({ page }) => {
    let profileCallCount = 0
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-expiry-test; Path=/; SameSite=Lax`,
          },
          body: JSON.stringify(loginOkEnvelope()),
        })
      } else if (url.includes('/profile')) {
        profileCallCount++
        if (profileCallCount <= 1) {
          // First profile: success (session valid)
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileEnvelope([
              { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
            ])),
          })
        } else {
          // Subsequent: session expired → 401
          await route.fulfill({
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
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

    // Login first
    await gotoLogin(page)
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL(/\/console\/workbench$/, { timeout: 15_000 })

    // Act: navigate to a sub-page (simulate working in a sub-section)
    await page.goto(`${WORKBENCH_PATH}`)

    // Trigger profile re-fetch → 401 (session expired)
    await page.reload()

    // Assert: redirected to login (behavioral — navigation)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })
    // Deep: redirect param preserves original path for post-login return
    const redirect = new URL(page.url()).searchParams.get('redirect')
    expect(redirect).toBeTruthy()
    expect(redirect).toContain('/workbench')
  })

  // Step 6 / Outcome "success": relogin after expiry → return to original path
  test('relogin after expiry returns to original path', async ({ page }) => {
    let phase: 'expired' | 'relogin' = 'expired'
    await page.route('**/api/iam/user/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/system/login')) {
        if (phase === 'relogin') {
          await route.fulfill({
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': `${SESSION_COOKIE_KEY}=e2e-relogin-test; Path=/; SameSite=Lax`,
            },
            body: JSON.stringify(loginOkEnvelope()),
          })
        } else {
          await route.fulfill({
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorEnvelope(1500, '服务暂不可用')),
          })
        }
      } else if (url.includes('/profile')) {
        if (phase === 'relogin') {
          await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(profileEnvelope([
              { id: 1, name: '默认租户', code: 'default', domain: 'localhost' },
            ])),
          })
        } else {
          await route.fulfill({
            status: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(errorEnvelope(1401, '未认证或会话过期')),
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

    // Phase 1: session expired → redirect to login
    await page.goto(WORKBENCH_PATH)
    await expect(page).toHaveURL(/\/console\/login/, { timeout: 10_000 })

    // Phase 2: relogin
    phase = 'relogin'
    await page.getByTestId('username').fill('admin')
    await page.getByTestId('password').fill('12345678')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    // Assert: returned to original workbench path (deep — state transition: expired→authenticated)
    await expect(page).toHaveURL(/\/console\/workbench$/, { timeout: 15_000 })
    await expect(page.getByTestId('workbench')).toBeVisible()
  })

  // Step 6 / Outcome "session-expired-eiam-unavailable": 401 + eiam down → readonly
  test('session expired with eiam unavailable shows degradation view', async ({ page }) => {
    // All eiam requests fail (eiam unavailable)
    await page.route('**/api/iam/**', async (route) => {
      await route.fulfill({
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(errorEnvelope(1500, '服务暂不可用')),
      })
    })

    await page.goto(WORKBENCH_PATH)

    // Assert: not redirected to login (eiam unavailable prevents login redirect)
    // Assert: degradation banner visible (behavioral — content)
    await expect(page.getByTestId('workbench-degradation')).toBeVisible({ timeout: 10_000 })
    // Deep: no login form present (eiam unavailable, no login entry)
    await expect(page.getByTestId('username')).not.toBeVisible({ timeout: 3_000 })
  })
})
