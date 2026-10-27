import { expect, test, type Page } from '@playwright/test'
import { ADMIN_PWD, ADMIN_USER, BASE_URL } from '../eiam-sso-login/helpers'

/**
 * IAM 治理页 · 窄屏响应式与列表状态回归（本轮 UI 优化补充）
 *
 * 覆盖本轮修复的真实缺陷（修复前均可在真实浏览器复现）：
 * 1. 390 窄屏下「用户管理 / 角色管理」表格列被压到 37~49px，中文逐字竖排，
 *    表头高度 89~106px、单元格「深圳市嘉立创科技发展有限公司」一列一字 —— 表格不可读。
 * 2. 390 窄屏下「组织管理」两栏栅格（2fr 3fr + 左栏 min-width:280px）超出内容区，
 *    .main-area 为 overflow:hidden，右栏「组织详情 / 成员列表」被裁掉且无法滚动抵达。
 * 3. 「用户 / 角色」错误态文案与「重试」按钮同行紧邻，读作「…请稍后重试重试」；
 *    且错误文案在表格容器外，容器内无内容，错误时残留一个空表格框。
 * 4. 用户列表「筛选无结果」与「本来无数据」共用同一句「暂无用户数据」，无清除筛选出口。
 *
 * 断言全部基于真实 nginx :8888 + 真实 eiam 会话（无 page.route），
 * 仅错误态用例注入一次 500 响应以制造失败分支（不触碰任何写接口）。
 */

const USERS_PATH = '/console/users'
const ROLES_PATH = '/console/roles'
const ORGS_PATH = '/console/organizations'

/**
 * 真实 eiam 登录。
 * 本文件断言的是布局几何量，登录若因后端瞬时抖动超时，会表现为「布局断言失败」，
 * 故此处给 30s 等待，并对「提交未触发跳转」重试一次——避免用 retries 掩盖真实回归。
 */
async function loginAsAdmin(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE_URL}/console/login`, { waitUntil: 'networkidle' })
    await page.getByTestId('username').fill(ADMIN_USER)
    await page.getByTestId('password').fill(ADMIN_PWD)
    await page.getByRole('button', { name: '登录工作台', exact: true }).click()
    try {
      await page.waitForURL(/\/console\/(tenant-select|workbench)$/, {
        timeout: 30_000,
      })
      return
    } catch (err) {
      if (attempt === 1) throw err
    }
  }
}

/** 页面是否出现整页横向溢出（整页溢出会让 header/侧栏跟随横移，属回归） */
async function hasPageOverflow(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  )
}

/** 表头最大高度：中文逐字竖排时远大于单行高度（修复前 89~106px，修复后 38px） */
async function maxHeaderHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ths = [...document.querySelectorAll('table.data-table th')]
    return ths.reduce(
      (max, th) => Math.max(max, Math.round(th.getBoundingClientRect().height)),
      0,
    )
  })
}

/** 表格所在滚动容器的可横向滚动量（>0 表示保留可读列宽后交给横向滚动） */
async function tableScrollOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wrap = document.querySelector('.table-wrap') as HTMLElement | null
    if (!wrap) return -1
    return wrap.scrollWidth - wrap.clientWidth
  })
}

test.describe('IAM 治理页窄屏响应式', () => {
  test('桌面 1440：用户列表表格铺满、无整页横向溢出、无窄屏提示', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('table.data-table')).toBeVisible()
    await expect(page.locator('tbody tr').first()).toBeVisible()

    // 桌面端不出现窄屏横向滚动提示
    await expect(page.locator('.table-hint')).toBeHidden()
    expect(await hasPageOverflow(page)).toBe(false)

    // 表头单行（未被挤压换行）
    expect(await maxHeaderHeight(page)).toBeLessThan(48)
  })

  test('窄屏 390：用户列表表格保持可读列宽并可横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('table.data-table')).toBeVisible()

    // 表头不再逐字竖排（修复前 89px）
    expect(await maxHeaderHeight(page)).toBeLessThan(48)
    // 表格保留最小可读宽度，超出部分交给容器横向滚动（修复前容器不可横向滚动）
    expect(await tableScrollOverflow(page)).toBeGreaterThan(0)
    // 窄屏提示可见，告知可左右滑动
    await expect(page.locator('.table-hint')).toBeVisible()
    // 整页不横向溢出
    expect(await hasPageOverflow(page)).toBe(false)

    // 行内单元格不再「一列一字」：行高应落在正常两行以内（修复前 90px+）
    const rowHeight = await page.evaluate(() => {
      const tr = document.querySelector('table.data-table tbody tr')
      return tr ? Math.round(tr.getBoundingClientRect().height) : 0
    })
    expect(rowHeight).toBeGreaterThan(0)
    expect(rowHeight).toBeLessThan(72)
  })

  test('窄屏 390：角色列表表头不竖排且可横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${ROLES_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('table.data-table')).toBeVisible()
    expect(await maxHeaderHeight(page)).toBeLessThan(48)
    expect(await tableScrollOverflow(page)).toBeGreaterThan(0)
    await expect(page.locator('.table-hint')).toBeVisible()
    expect(await hasPageOverflow(page)).toBe(false)
  })

  test('窄屏 390：组织管理详情与成员卡片在视口内可达（不被裁切）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${ORGS_PATH}`, { waitUntil: 'networkidle' })

    // 等组织树数据落位后再量几何，避免把「尚未渲染」误判为布局问题
    await expect(page.locator('.org-tree')).toContainText('组织树')
    await expect(page.locator('.org-tree .tree__row').first()).toBeVisible()
    await expect(page.locator('.org-detail .card').first()).toBeVisible()

    // 右栏两张卡片必须落在视口横向范围内（修复前被推到 x>340 并被裁掉）
    const layout = await page.evaluate(() => {
      const detail = document.querySelector('.org-detail') as HTMLElement
      const cards = document.querySelectorAll('.org-detail .card')
      return {
        detailLeft: Math.round(detail.getBoundingClientRect().left),
        detailRight: Math.round(detail.getBoundingClientRect().right),
        firstCardBottom: Math.round(cards[0]!.getBoundingClientRect().bottom),
        cardCount: cards.length,
        innerWidth: window.innerWidth,
      }
    })
    expect(layout.detailLeft).toBeGreaterThanOrEqual(0)
    expect(layout.detailRight).toBeLessThanOrEqual(layout.innerWidth)
    expect(layout.firstCardBottom).toBeGreaterThan(0)
    expect(layout.cardCount).toBe(2)

    // 单栏堆叠：详情卡片位于组织树下方（而非右侧）
    const stacked = await page.evaluate(() => {
      const tree = document.querySelector('.org-tree') as HTMLElement
      const detail = document.querySelector('.org-detail') as HTMLElement
      return (
        detail.getBoundingClientRect().top >=
        tree.getBoundingClientRect().bottom - 1
      )
    })
    expect(stacked).toBe(true)

    // 成员卡片可滚动抵达（修复前根本无法进入视口）
    const membersReachable = await page.evaluate(() => {
      const card = document.querySelectorAll('.org-detail .card')[1] as HTMLElement
      card.scrollIntoView({ block: 'center' })
      const r = card.getBoundingClientRect()
      return r.left >= 0 && r.right <= window.innerWidth
    })
    expect(membersReachable).toBe(true)

    expect(await hasPageOverflow(page)).toBe(false)
  })

  test('桌面 1440：组织管理仍为双栏（响应式不回归桌面布局）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${ORGS_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('.org-tree .tree__row').first()).toBeVisible()
    await expect(page.locator('.org-detail .card').first()).toBeVisible()

    const sideBySide = await page.evaluate(() => {
      const tree = document.querySelector('.org-tree') as HTMLElement
      const detail = document.querySelector('.org-detail') as HTMLElement
      return (
        detail.getBoundingClientRect().left >=
        tree.getBoundingClientRect().right - 1
      )
    })
    expect(sideBySide).toBe(true)
  })
})

test.describe('列表状态反馈', () => {
  test('接口失败：错误态动作与说明分行，重试可恢复', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    // 只注入读接口的 500，制造失败分支（不触碰写接口）
    await page.route('**/api/iam/user/list**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 500, msg: 'upstream error', data: null }),
      }),
    )
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    const alert = page.locator('.state-error[role="alert"]')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('身份服务暂不可用')

    // 修复前「…请稍后重试」与「重试」按钮同行紧邻，读作「…重试重试」。
    // 现在动作独占一行：断言几何位置（两者文本节点相邻，textContent 必然仍含两次「重试」）。
    const separation = await page.evaluate(() => {
      const box = document.querySelector('.state-error') as HTMLElement
      const text = box.querySelector('span') as HTMLElement
      const btn = box.querySelector('button') as HTMLElement
      return {
        textBottom: Math.round(text.getBoundingClientRect().bottom),
        btnTop: Math.round(btn.getBoundingClientRect().top),
      }
    })
    expect(separation.btnTop).toBeGreaterThanOrEqual(separation.textBottom)

    // 错误态落在表格容器内（不再残留一个空表格框）
    await expect(page.locator('.table-wrap .state-error')).toBeVisible()
    await expect(page.locator('table.data-table')).toHaveCount(0)

    // 重试可恢复真实数据
    await page.unroute('**/api/iam/user/list**')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('table.data-table')).toBeVisible()
    await expect(page.locator('tbody tr').first()).toBeVisible()
    await expect(page.locator('.state-error')).toHaveCount(0)
  })

  test('筛选无结果：区分空态并提供清除筛选，点击后恢复列表', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('table.data-table')).toBeVisible()

    await page.getByTestId('user-search').fill('zzz-not-exist-user')
    await page.getByRole('button', { name: '搜索', exact: true }).click()

    // 修复前只有「暂无用户数据」，与实际「无数据」不可区分、也无清除出口
    await expect(page.locator('.state-empty')).toContainText('没有匹配的用户')
    const clearBtn = page.getByTestId('clear-filters')
    await expect(clearBtn).toBeVisible()

    await clearBtn.click()
    await expect(page.locator('table.data-table')).toBeVisible()
    await expect(page.locator('tbody tr').first()).toBeVisible()
    await expect(page.locator('.state-empty')).toHaveCount(0)
  })
})

test.describe('弹窗键盘与焦点可访问性', () => {
  /** 当前焦点落在哪个可识别元素上 */
  async function activeInfo(page: Page) {
    return page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return {
        tag: el?.tagName ?? null,
        testid: el?.getAttribute('data-testid') ?? null,
        text: (el?.textContent ?? '').trim().slice(0, 12),
        insideDialog: !!el?.closest('[role="dialog"],[role="alertdialog"]'),
      }
    })
  }

  test('新增用户弹窗：焦点入窗、Tab 不逃逸、Escape 关闭、焦点归还', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    const trigger = page.getByRole('button', { name: '新增用户', exact: true })
    await trigger.focus()
    await trigger.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 修复前无 aria-modal、焦点仍留在触发按钮上
    await expect(dialog).toHaveAttribute('aria-modal', 'true')

    // 焦点落在首个输入项
    const first = await activeInfo(page)
    expect(first.testid).toBe('create-username')
    expect(first.insideDialog).toBe(true)

    // Tab 连续 6 次仍在弹窗内（修复前会跑到背景页链接）
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect((await activeInfo(page)).insideDialog).toBe(true)
    }

    // Escape 关闭（修复前无效，这是最直接的键盘可用性缺陷）
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // 焦点归还触发元素
    const restored = await activeInfo(page)
    expect(restored.text).toContain('新增用户')
  })

  test('删除确认弹窗：初始焦点落在「取消」，Escape 可关闭且不提交删除', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    const rowsBefore = await page.locator('tbody tr').count()
    await page.getByTestId('delete-user').first().click()

    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await expect(confirm).toHaveAttribute('aria-modal', 'true')

    // 危险操作：初始焦点必须是「取消」而不是「确认删除」，避免回车误删
    expect((await activeInfo(page)).text).toBe('取消')

    // Escape 关闭且未发起删除（行数不变）
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(page.locator('tbody tr')).toHaveCount(rowsBefore)
  })

  test('点击遮罩仍可关闭弹窗（既有交互未被破坏）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: '新增用户', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.locator('.dialog-overlay').click({ position: { x: 5, y: 5 } })
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('角色管理「新增角色」：Escape 可关闭', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${ROLES_PATH}`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: '新增角色', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    expect((await activeInfo(page)).testid).toBe('create-role-code')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
