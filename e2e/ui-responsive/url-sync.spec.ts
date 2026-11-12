import { expect, test, type Page } from '@playwright/test'
import { ADMIN_PWD, ADMIN_USER, BASE_URL } from '../eiam-sso-login/helpers'

/**
 * 列表页 URL 状态同步（T12）· 真实浏览器回归
 *
 * 为什么必须有这一份：
 * T12 跨五轮五个 PR（console #40/#41/#42、cmdb #128、CAM #347/#350/#351）给 11 个页面加了
 * 「筛选/分页 ↔ 地址栏」双向同步，但这些工作**只有单测覆盖**。
 * 而单测用的是 `createMemoryHistory()` 的 router —— **它验证不了真实地址栏**：
 *   · 单元测试里 `route.query` 是构造出来的，不经过浏览器的 URL 解析；
 *   · 单测无法验证「刷新页面后状态是否还在」这个 T12 的核心承诺；
 *   · 单测无法验证「把当前地址复制给同事，他打开能不能看到同一个视图」。
 *
 * 本文件只做这三件事，都在**真实 nginx :8888 + 真实 eiam 会话**下跑：
 *   ① 带 query 打开 → 状态还原；
 *   ② 操作（切页签/翻页/筛选）→ 地址栏更新；
 *   ③ **刷新 → 状态保持**（T12 的存在理由，单测永远测不到）。
 *
 * 断言口径：
 *   · 只断言「URL 里有这个参数」与「DOM 状态与该参数一致」，**不断言具体数据条数**
 *     （数据随环境变化，写死会制造 flaky）；
 *   · 默认值（tab=auth / page=1 / size=20）**不应写进 URL** —— 保持链接干净，这一点也断言。
 */

/**
 * 登录管理员。
 *
 * 与 `list-pages.spec.ts` 保持同一实现（含 2 次重试）：本套件用例串行共用同一个 eiam 会话，
 * 偶发超时靠重试吸收。**按钮可访问名是「登录」**——历史上曾误写「登录工作台」，
 * 导致整套 62 个用例全部卡在登录步骤（见 list-pages.spec.ts 的注释），这里保持一致。
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

/** 当前 URL 的查询参数（只取字符串值，忽略数组） */
async function query(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    new URLSearchParams(location.search).forEach((v, k) => {
      out[k] = v
    })
    return out
  })
}

test.describe('URL 状态同步 · 邀请管理', () => {
  const PATH = '/console/invitations'

  test('默认进入不写默认值（地址栏保持干净）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}`, { waitUntil: 'networkidle' })

    const q = await query(page)
    // tab 默认 auth、page 默认 1、size 默认 20 —— 三者都不该出现在地址栏
    expect(q, '默认态不应把 tab/page/size 写进 URL').not.toHaveProperty('tab')
    expect(q).not.toHaveProperty('page')
    expect(q).not.toHaveProperty('size')
  })

  test('切换页签 → 地址栏出现 tab；刷新后仍停在「加入申请」', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}`, { waitUntil: 'networkidle' })

    await page.getByRole('tab', { name: /加入申请/ }).click()
    await expect.poll(async () => (await query(page)).tab, { timeout: 10_000 }).toBe('requests')

    // ③ 刷新后状态保持 —— 这是 T12 的核心承诺
    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('tab', { name: /加入申请/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 10_000 },
    )
  })

  test('带 ?tab=requests 直接打开 → 落在「加入申请」页签', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}?tab=requests`, { waitUntil: 'networkidle' })

    await expect(page.getByRole('tab', { name: /加入申请/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 10_000 },
    )
  })
})

test.describe('URL 状态同步 · 租户管理（本环境为权限受限态）', () => {
  const PATH = '/console/tenants'

  /**
   * **本环境验证不了租户页的 URL 同步** —— 实测 admin 账号**没有 `iam:tenant:view`**，
   * 访问 `/console/tenants` 会被守卫重定向到 403 页（h1「无权限执行该操作」、input 数 0）。
   *
   * 所以这里不写「搜索框回填」这类断言 —— 那个输入框根本不存在，写了只会永远红。
   * 改为断言**权限守卫本身工作正常**：未授权时落 403，而不是白屏或静默失败。
   *
   * 租户页的 URL 同步逻辑仍有单测覆盖（`TenantList.test.ts` 的 5 条 URL 用例）；
   * 真实浏览器验证需等有 `iam:tenant:view` 的账号在 CI 环境可用后再补。
   */
  test('无 iam:tenant:view 权限时落到 403（而不是白屏）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}?search=zzz-url-sync-probe`, { waitUntil: 'networkidle' })

    await expect(page).toHaveURL(/\/console\/forbidden/, { timeout: 10_000 })
    await expect(page.locator('h1')).toContainText('无权限', { timeout: 10_000 })
  })
})

test.describe('URL 状态同步 · 审计日志（双分页）', () => {
  const PATH = '/console/audit'

  test('默认进入不写默认值', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}`, { waitUntil: 'networkidle' })

    const q = await query(page)
    for (const key of ['tab', 'page', 'size', 'opage', 'osize']) {
      expect(q, `默认态不应把 ${key} 写进 URL`).not.toHaveProperty(key)
    }
  })

  test('带 ?tab=operation 打开 → 落在「操作审计」页签；刷新后保持', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${PATH}?tab=operation`, { waitUntil: 'networkidle' })

    const opTab = page.getByRole('tab', { name: /操作审计/ })
    await expect(opTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })

    await page.reload({ waitUntil: 'networkidle' })
    await expect(page.getByRole('tab', { name: /操作审计/ })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 10_000 },
    )
  })
})
