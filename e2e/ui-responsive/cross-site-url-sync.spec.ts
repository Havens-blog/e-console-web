import { expect, test, type Page } from '@playwright/test'
import { ADMIN_PWD, ADMIN_USER, BASE_URL } from '../eiam-sso-login/helpers'

/**
 * cmdb 列表页 URL 状态同步（cmdb #128）· 跨站真实浏览器回归
 *
 * ## 为什么这个文件在 console 仓的 e2e 目录里
 *
 * `e-cmdb-web` **没有 Playwright 依赖、没有 e2e 目录、没有 playwright 配置**。
 * 给它建独立 e2e 基础设施要装依赖（改 lockfile）+ 写配置 + 搭登录流程，
 * 属于独立工程，不适合塞进一轮 UI 迭代里。
 *
 * 但 cmdb 的 URL 同步（#128 四页）**也只有单测覆盖**，而单测用 memory router，
 * 验不了「真实地址栏里刷新后状态是否还在」—— 这正是 #128 承诺的核心。
 *
 * 所以这里**复用 console 已有的 Playwright 环境做跨站验证**：
 * 三站同域（nginx `:8888`）、共用同一个 eiam 会话，登录一次即可访问 `/cmdb/*`。
 * **不装依赖、不改 package.json、不动 lockfile。**
 *
 * ## 前置条件（不满足时本文件会明确失败，而不是静默通过）
 *
 * cmdb 的 nginx 产物（`e-cmdb-web/dist`）必须是**含 #128 代码的构建**。
 * 实测口径（iter367）：`dist/index.html` 修改时间 **11/11 22:36**、`origin/main` **11/11 22:41** —— 新鲜。
 * **CAM 不能这样验证**：它的 `dist` 停在 **11/04**，落后 `origin/main` **8 天**，
 * 跨站跑只会验证到过期代码（iter364 已被这个坑误导过一次）。
 *
 * ## 断言口径
 *
 * cmdb 有**多租户机制**，访问任何页都会自动追加 `tenant_id=3`。
 * 所以断言一律用「**URL 包含某参数**」而不是「URL 完全等于某值」——
 * 写成相等断言会因为 `tenant_id` 被加进去而永远红。
 */

async function loginAsAdmin(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE_URL}/console/login`, { waitUntil: 'networkidle' })
    await page.getByTestId('username').fill(ADMIN_USER)
    await page.getByTestId('password').fill(ADMIN_PWD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    try {
      await page.waitForURL(/\/console\/(tenant-select|workbench)$/, { timeout: 20_000 })
      return
    } catch (err) {
      if (attempt === 1) throw err
    }
  }
}

/** 当前 URL 的查询参数（忽略数组值） */
async function query(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    new URLSearchParams(location.search).forEach((v, k) => {
      out[k] = v
    })
    return out
  })
}

test.describe('cmdb URL 状态同步 · 跨站验证（复用 console Playwright）', () => {
  test('审计页：带 ?page=2&size=50 打开 → 参数保留且页面正常渲染', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/cmdb/audit?page=2&size=50`, { waitUntil: 'networkidle' })

    // 页面正常渲染（不是 403、不是白屏）
    await expect(page.locator('h1')).toContainText('审计', { timeout: 15_000 })

    // 参数被保留 —— 注意不能断言 URL 相等，cmdb 会追加 tenant_id
    const q = await query(page)
    expect(q.page, 'page 参数应被保留').toBe('2')
    expect(q.size, 'size 参数应被保留').toBe('50')
  })

  test('审计页：刷新后分页参数仍保留（#128 的核心承诺）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/cmdb/audit?page=2&size=50`, { waitUntil: 'networkidle' })
    await expect(page.locator('h1')).toContainText('审计', { timeout: 15_000 })

    await page.reload({ waitUntil: 'networkidle' })

    // 刷新后参数还在 —— 单测（memory router）永远测不到这一层
    await expect
      .poll(async () => (await query(page)).page, { timeout: 10_000 })
      .toBe('2')
    await expect
      .poll(async () => (await query(page)).size, { timeout: 10_000 })
      .toBe('50')
  })

  test('质量页：双分页参数（page/size 与 spage/ssize）互不覆盖', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    // 两套分页同时给值，验证不会互相覆盖
    await page.goto(`${BASE_URL}/cmdb/quality?page=2&size=50&spage=3&ssize=30`, {
      waitUntil: 'networkidle',
    })
    await expect(page.locator('h1')).toContainText('质量', { timeout: 15_000 })

    const q = await query(page)
    expect(q.page, '主分页 page 不应被 spage 覆盖').toBe('2')
    expect(q.size).toBe('50')
    expect(q.spage, '次分页 spage 不应被 page 覆盖').toBe('3')
    expect(q.ssize).toBe('30')
  })

  test('实例关系页：带 ?page=2&size=50 → 参数保留', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/cmdb/instance-relations?page=2&size=50`, {
      waitUntil: 'networkidle',
    })
    await expect(page.locator('h1')).toContainText('实例关系', { timeout: 15_000 })

    const q = await query(page)
    expect(q.page).toBe('2')
    expect(q.size).toBe('50')
  })
})
