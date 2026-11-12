import { expect, test, type Page } from '@playwright/test'
import { ADMIN_PWD, ADMIN_USER, BASE_URL } from '../eiam-sso-login/helpers'

/**
 * CAM 列表页 URL 状态同步 · 真实浏览器回归（跨站，指向 CAM dev server）
 *
 * ## 为什么这里指向 dev server 而不是 nginx
 *
 * `e-cam-web` 没有 Playwright 依赖、没有 e2e 目录、没有配置 —— 建独立基础设施是独立工程。
 * 所以复用 console 的 Playwright（同域 `localhost`、cookie `domain=localhost` **不绑定端口**，
 * 登录一次即可在其它端口复用会话）。
 *
 * **但目标必须是 dev server，不能是 nginx `:8888`**：
 * 实测（iter368，按 S206 复查）CAM 的 `dist/index.html` 停在 **11/04**，
 * 而 `origin/main` 是 **11/12** —— **产物落后 8 天**。
 * 跨站打 nginx 只会验证到 8 天前的代码，跑出来的绿色报告对当前 main 毫无意义。
 * dev server 直接跑 worktree 源码，能保证验证的是 `origin/main`。
 *
 * 端口通过 `CAM_DEV_ORIGIN` 覆盖，默认 `http://localhost:5204`。
 * 跑之前必须先起 CAM 的 dev server：
 *   git -C ../e-cam-web worktree add ../.tmp-cam origin/main
 *   cd ../.tmp-cam && node node_modules/vite/bin/vite.js --port 5204 --strictPort
 *
 * ## 局限（写在代码里，不只写在 PR 里）
 *
 * 本文件**不在 CI 里跑**（需要真实 dev server + 真实 eiam 会话），是一个手动回归工具。
 * CAM 长期仍应建自己的 e2e 基础设施；在那之前，这份文件是唯一覆盖 CAM 真实浏览器
 * URL 行为的东西。
 */

const CAM = process.env.CAM_DEV_ORIGIN ?? 'http://localhost:5204'

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

/** 当前 URL 查询参数 */
async function query(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    new URLSearchParams(location.search).forEach((v, k) => {
      out[k] = v
    })
    return out
  })
}

test.describe('CAM URL 状态同步 · cert/probes（iter355 的成果）', () => {
  const PATH = '/cam/certs/probes'

  test('默认进入不写默认值（地址栏保持干净）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${CAM}${PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('h1')).toContainText('探测', { timeout: 15_000 })

    const q = await query(page)
    for (const key of ['keyword', 'status', 'link']) {
      expect(q, `默认态不应把 ${key} 写进 URL`).not.toHaveProperty(key)
    }
  })

  test('带 ?keyword= 打开 → 搜索框回填（iter355 修的就是这个）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${CAM}${PATH}?keyword=example`, { waitUntil: 'networkidle' })

    await expect(page.locator('h1')).toContainText('探测', { timeout: 15_000 })

    // 搜索框应回填「example」。
    // iter355 的 bug 正是：写回 watch 用了 immediate:true，在 setup 阶段先把 urlState 洗成
    // undefined，导致 URL 里的 keyword 被整条清掉、输入框永远为空。
    // 这条断言专门锁住那次修复。
    const input = page.locator('input[placeholder*="域名"]').first()
    await expect(input).toHaveValue('example', { timeout: 10_000 })

    // 且 URL 没有被洗掉
    expect((await query(page)).keyword).toBe('example')
  })

  test('带 ?status= 打开 → 参数保留且不被清掉', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${CAM}${PATH}?keyword=example&status=fail`, { waitUntil: 'networkidle' })

    await expect(page.locator('h1')).toContainText('探测', { timeout: 15_000 })

    const q = await query(page)
    expect(q.keyword, 'keyword 不应被写回 watch 洗掉').toBe('example')
    expect(q.status).toBe('fail')
  })

  test('刷新后参数仍保留（单测验不了这一层）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${CAM}${PATH}?keyword=example&status=fail`, { waitUntil: 'networkidle' })
    await expect(page.locator('h1')).toContainText('探测', { timeout: 15_000 })

    await page.reload({ waitUntil: 'networkidle' })

    await expect
      .poll(async () => (await query(page)).keyword, { timeout: 10_000 })
      .toBe('example')
    await expect
      .poll(async () => (await query(page)).status, { timeout: 10_000 })
      .toBe('fail')
  })
})

test.describe('CAM URL 状态同步 · network/cdn', () => {
  const PATH = '/cam/network/cdn'

  test('带 ?name=&page= 打开 → 筛选标签与分页都被还原', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${CAM}${PATH}?name=test&page=2`, { waitUntil: 'networkidle' })

    await expect(page.locator('h1')).toContainText('CDN', { timeout: 15_000 })

    // 该页把 filters 转成「筛选标签」展示 —— 标签出现即证明 name 被真正应用，
    // 而不只是留在地址栏里（两者是不同的事，只断言 URL 会漏掉「参数在但不生效」）。
    await expect(page.locator('.search-tag, .filter-tag, .el-tag').first()).toContainText(
      'test',
      { timeout: 10_000 },
    )

    const q = await query(page)
    expect(q.name).toBe('test')
    expect(q.page).toBe('2')
  })
})
