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

// 真实 eiam 偶发抖动（仓库 playwright.config 注释亦已说明）会让登录接近默认 30s 预算，
// 若不留余量，「后端慢」会被误判成布局回归。这里给足用例预算，登录侧仍保留一次重试。
test.describe.configure({ timeout: 60_000 })

/**
 * 真实 eiam 登录。
 * 本文件断言的是布局几何量，登录若因后端瞬时抖动超时，会表现为「布局断言失败」，
 * 故此处给 20s 等待，并对「提交未触发跳转」重试一次——避免用 retries 掩盖真实回归。
 */
async function loginAsAdmin(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${BASE_URL}/console/login`, { waitUntil: 'networkidle' })
    await page.getByTestId('username').fill(ADMIN_USER)
    await page.getByTestId('password').fill(ADMIN_PWD)
    await page.getByRole('button', { name: '登录工作台', exact: true }).click()
    try {
      await page.waitForURL(/\/console\/(tenant-select|workbench)$/, {
        timeout: 20_000,
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

  test('弹窗关闭按钮具备可访问名称（读屏不播报「乘号」）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${USERS_PATH}`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: '新增用户', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // 修复前按钮文本只有「✕」，无 aria-label
    await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('组织树行内动作可键盘到达，且弹窗关闭后焦点归还该动作', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}${ORGS_PATH}`, { waitUntil: 'networkidle' })

    await expect(page.locator('.org-tree .tree__row').first()).toBeVisible()

    // 修复前三个动作按钮 tabindex="-1" 且容器 display:none —— Tab 完全跳过，
    // 键盘用户无法打开「新增子组织 / 编辑 / 删除」，弹窗关闭后焦点也无处可归。
    await page.locator('.tree__row').first().focus()
    await page.keyboard.press('Tab')
    const firstAction = await activeInfo(page)
    expect(firstAction.text).toBe('＋')
    expect(firstAction.insideDialog).toBe(false)

    // Tab 到「编辑」并用键盘打开
    await page.keyboard.press('Tab')
    expect((await activeInfo(page)).text).toBe('编辑')
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect((await activeInfo(page)).testid).toBe('edit-org-name')

    // Escape 关闭后，焦点应回到「编辑」按钮（修复前落回 BODY）
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    const restored = await activeInfo(page)
    expect(restored.text).toBe('编辑')
    expect(restored.tag).toBe('BUTTON')
  })
})

/**
 * 弹窗可访问性接入的第二批页面：授权管理 / 策略管理 / 身份源管理。
 *
 * 层级说明（沿用仓库 tech-design 的 REAL / CONTRACT 两档）：
 * - 授权、策略：REAL —— 真实 eiam 会话，无任何 page.route；
 * - 身份源：CONTRACT —— 浏览器/nginx 真实，仅 fulfill profile 与 identity_source/list
 *   两个响应体。原因：验证账号真实缺少 `iam:identity_source:view`，直连会被守卫剪到
 *   /forbidden，无法触达该页弹窗。该用例仅验证「弹窗交互」，不验证接口行为。
 */
test.describe('弹窗可访问性 · 第二批页面', () => {
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

  test('REAL · 授权管理「撤销授权」：首焦点为取消、Escape 关闭、焦点归还行内按钮', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/authorizations`, { waitUntil: 'networkidle' })

    // 可访问名现在带行标识（如「撤销 admin 对 admin 的 assign 授权」），故用正则而非 exact
    const revokeBtn = page.getByRole('button', { name: /^撤销 / }).first()
    await revokeBtn.focus()
    await revokeBtn.click()

    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await expect(confirm).toHaveAttribute('aria-modal', 'true')
    // 危险操作：初始焦点必须是「取消」
    expect((await activeInfo(page)).text).toBe('取消')
    // ✕ 具备可访问名
    await expect(confirm.getByRole('button', { name: '关闭', exact: true })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    // 焦点归还到行内「撤销」
    expect((await activeInfo(page)).text).toBe('撤销')
  })

  test('REAL · 策略管理「新增策略」：焦点入窗、Escape 关闭、焦点归还', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/policies`, { waitUntil: 'networkidle' })

    const trigger = page.getByRole('button', { name: '新增策略', exact: true })
    await trigger.focus()
    await trigger.click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect((await activeInfo(page)).testid).toBe('edit-policy-code')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect((await activeInfo(page)).text).toBe('新增策略')
  })

  test('REAL · 策略弹窗：下拉展开时 Esc 只收起下拉，不关窗、不丢输入', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/policies`, { waitUntil: 'networkidle' })

    await page.getByRole('button', { name: '新增策略', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // 写入一个可辨识的值，用于证明「Esc 收下拉不会连带丢掉表单内容」
    await page.getByTestId('edit-policy-code').fill('probe-esc-keep')

    const elSelect = dialog.locator('.el-select').first()
    await expect(elSelect).toBeVisible()
    await elSelect.click()
    // Element Plus 打开下拉会在控件上标 aria-expanded=true
    await expect(dialog.locator('[aria-expanded="true"]').first()).toBeVisible()

    await page.keyboard.press('Escape')
    // 弹窗必须仍在（修复前捕获阶段直接关窗，用户输入全部丢失）
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('edit-policy-code')).toHaveValue('probe-esc-keep')

    // 下拉已收起后，再按 Esc 才关闭弹窗
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('CONTRACT · 身份源管理：新增/删除弹窗可键盘操作（真实账号缺该权限码）', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    const envelope = (data: unknown) => ({ code: 0, msg: 'ok', data })
    await page.route('**/api/iam/user/profile**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({
            user: { id: 1, username: 'admin', nickname: '管理员' },
            tenants: [{ id: 3, name: '验证租户', code: 'v3', domain: 'localhost' }],
            current_tenant_id: 3,
            is_admin: true,
            permissions: [
              'iam:identity_source:view',
              'iam:identity_source:save',
              'iam:identity_source:detail',
              'iam:identity_source:delete',
              'iam:identity_source:test',
              'iam:identity_source:toggle',
            ],
            must_select_tenant: false,
          }),
        ),
      }),
    )
    await page.route('**/api/iam/identity_source/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope([
            {
              id: 7,
              name: 'corp-ldap',
              type: 'ldap',
              enabled: true,
              ldap: {
                url: 'ldap://ldap.corp.local:389',
                base_dn: 'dc=corp',
                bind_dn: 'cn=svc',
                username_attribute: 'uid',
                mail_attribute: 'mail',
              },
            },
          ]),
        ),
      }),
    )

    await page.goto(`${BASE_URL}/console/identity-sources`, { waitUntil: 'networkidle' })
    await expect(page).toHaveURL(/\/console\/identity-sources$/)

    // 新增弹窗：焦点入窗 + Escape 关闭 + 焦点归还
    const addBtn = page.getByRole('button', { name: '新增身份源', exact: true })
    await addBtn.first().focus()
    await addBtn.first().click()
    const form = page.getByRole('dialog')
    await expect(form).toBeVisible()
    await expect(form).toHaveAttribute('aria-modal', 'true')
    expect((await activeInfo(page)).testid).toBe('form-name')
    await page.keyboard.press('Escape')
    await expect(form).toHaveCount(0)

    // 删除弹窗：首焦点为取消（身份源行内按钮按 testid 定位，文案为「删除」）
    const delBtn = page.getByTestId('delete-idp').first()
    await delBtn.focus()
    await delBtn.click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    expect((await activeInfo(page)).text).toBe('取消')
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
  })
})

/**
 * 第三批：授权 / 策略 / 身份源 的「错误态 + 空态」与 users/roles 对齐。
 *
 * 修复前实测（三页一致）：错误文案渲染在 .table-wrap 之外，容器内无内容只留一个
 * 空壳；且「…请稍后重试」与「重试」按钮同行紧邻，读作「…请稍后重试重试」。
 */
test.describe('列表三态 · 第三批页面', () => {
  const fail500 = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 500, msg: 'upstream error', data: null }),
    })

  /** 错误态几何：必须在表格容器内，且动作位于说明文案下一行 */
  async function expectStackedErrorInContainer(page: Page, label: string) {
    const alert = page.locator('.table-wrap .state-error[role="alert"]')
    await expect(alert, `${label}: 错误态应在表格容器内`).toBeVisible()
    await expect(alert).toContainText('身份服务暂不可用')
    // 修复前容器内是空壳（无表格、也无所属状态块）
    await expect(page.locator('table.data-table')).toHaveCount(0)

    const geo = await page.evaluate(() => {
      const box = document.querySelector('.table-wrap .state-error') as HTMLElement
      const text = box.querySelector('span') as HTMLElement
      const btn = box.querySelector('button') as HTMLElement
      return {
        textBottom: Math.round(text.getBoundingClientRect().bottom),
        btnTop: Math.round(btn.getBoundingClientRect().top),
      }
    })
    expect(geo.btnTop).toBeGreaterThanOrEqual(geo.textBottom)
  }

  test('REAL · 授权管理：错误态入容器+动作分层，重试可恢复，筛选空态可清除', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/permission/authorizations**', fail500)
    await page.goto(`${BASE_URL}/console/authorizations`, { waitUntil: 'networkidle' })
    await expectStackedErrorInContainer(page, '授权')

    await page.unroute('**/api/iam/permission/authorizations**')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('table.data-table')).toBeVisible()

    // 筛选无结果 → 与「本来无数据」区分，并给清除入口
    await page.getByPlaceholder('搜索主体').fill('zzz-not-exist-subject')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.state-empty')).toContainText('没有匹配的授权')
    await page.getByTestId('clear-filters').click()
    await expect(page.locator('table.data-table')).toBeVisible()
  })

  test('REAL · 策略管理：错误态入容器，空态文案与筛选空态可区分', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/policy/list**', fail500)
    await page.goto(`${BASE_URL}/console/policies`, { waitUntil: 'networkidle' })
    await expectStackedErrorInContainer(page, '策略')

    // 真实空列表：纯文案空态（新增入口在页头，空态不重复同名按钮）
    await page.unroute('**/api/iam/policy/list**')
    await page.goto(`${BASE_URL}/console/policies`, { waitUntil: 'networkidle' })
    await expect(page.locator('.state-empty')).toContainText('暂无策略数据')

    // 筛选无结果 → 文案变化并给清除出口
    await page.getByPlaceholder('搜索策略名').fill('zzz-not-exist-policy')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.state-empty')).toContainText('没有匹配的策略')
    await page.getByTestId('clear-filters').click()
    await expect(page.locator('.state-empty')).toContainText('暂无策略数据')
  })

  test('CONTRACT · 身份源管理：错误态入容器，空态文案正确', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    const envelope = (data: unknown) => ({ code: 0, msg: 'ok', data })
    await page.route('**/api/iam/user/profile**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({
            user: { id: 1, username: 'admin', nickname: '管理员' },
            tenants: [{ id: 3, name: '验证租户', code: 'v3', domain: 'localhost' }],
            current_tenant_id: 3,
            is_admin: true,
            permissions: [
              'iam:identity_source:view',
              'iam:identity_source:save',
              'iam:identity_source:delete',
            ],
            must_select_tenant: false,
          }),
        ),
      }),
    )

    await page.route('**/api/iam/identity_source/list**', fail500)
    await page.goto(`${BASE_URL}/console/identity-sources`, { waitUntil: 'networkidle' })
    await expectStackedErrorInContainer(page, '身份源')

    // 空列表 → 空态文案
    await page.unroute('**/api/iam/identity_source/list**')
    await page.route('**/api/iam/identity_source/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope([])),
      }),
    )
    await page.goto(`${BASE_URL}/console/identity-sources`, { waitUntil: 'networkidle' })
    await expect(page.locator('.state-empty')).toContainText('暂无身份源配置')
  })
})

/**
 * 详情页「保存失败」必须被看见。
 *
 * 修复前实测（390×844，滚到底提交，接口 500）：错误提示渲染在表单顶部，
 * getBoundingClientRect().top 为 -369（用户详情）/ -110（角色详情）——完全在视口外，
 * 且无 toast、无 aria-live、焦点停在 BODY，按钮复位「保存」→ 与「没反应」无法区分。
 */
test.describe('详情页保存失败反馈', () => {
  const saveError = (page: Page) => page.getByTestId('save-error')

  async function expectVisibleAndFocused(page: Page, label: string) {
    const el = saveError(page)
    await expect(el, `${label}: 保存失败提示应出现`).toBeVisible()
    await expect(el).toHaveAttribute('role', 'alert')

    const geo = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="save-error"]') as HTMLElement
      const r = box.getBoundingClientRect()
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
        focused: document.activeElement === box,
      }
    })
    expect(geo.inViewport, `${label}: 提示应在视口内`).toBe(true)
    expect(geo.focused, `${label}: 焦点应落到提示上`).toBe(true)
  }

  test('用户详情：390 滚到底保存失败 → 提示滚入视口并聚焦', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    // 无改动时保存按钮禁用，先改一个字段（不提交成功，接口被拦截）
    await page.route('**/api/iam/user/update**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 500, msg: 'upstream error', data: null }),
      }),
    )
    await page.locator('.detail-form input:not([readonly])').first().fill('probe-save-fail')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.locator('.form-actions button', { hasText: '保存' }).click()

    await expectVisibleAndFocused(page, '用户详情')
  })

  test('角色详情：390 滚到底保存失败 → 提示滚入视口并聚焦', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/roles/admin`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    await page.route('**/api/iam/role/update**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 500, msg: 'upstream error', data: null }),
      }),
    )
    await page.locator('.detail-form input:not([readonly])').first().fill('probe-role-save-fail')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page
      .locator('.form-actions button, .detail-actions button')
      .filter({ hasText: '保存' })
      .first()
      .click()

    await expectVisibleAndFocused(page, '角色详情')
  })

  /**
   * 角色列表筛选空态。
   *
   * 注意：当前 eiam 的 `role/list` 忽略了请求里的 keyword
   * （eiam/internal/web/role/handler.go:186 只传 Offset/Limit，service 的 Search/CountByKeyword 未接线），
   * 因此真实搜索永远返回全量，前端「筛选无结果」分支在真实后端下不可达。
   * 本用例用 CONTRACT 方式返回空页，验证前端该分支的文案与清除出口本身正确。
   */
  test('CONTRACT · 角色列表筛选空态：区分文案并可一键清除', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.route('**/api/iam/role/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', data: { total: 0, items: [] } }),
      }),
    )
    await page.goto(`${BASE_URL}/console/roles`, { waitUntil: 'networkidle' })

    await page.getByTestId('role-search').fill('zzz-not-exist-role')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.state-empty')).toContainText('没有匹配的角色')

    await page.getByTestId('clear-filters').click()
    await expect(page.locator('.state-empty')).toContainText('暂无角色数据')
  })
})

/**
 * 租户管理页（CONTRACT 层）。
 *
 * 真实 admin 账号缺少 `iam:tenant:view`，直连会被守卫剪到 /console/forbidden，
 * 因此用 CONTRACT 手法仅 fulfill profile（补租户权限码）与 tenant/list 两个响应体，
 * 浏览器 / nginx / 登录链路均为真实。
 *
 * 修复前实测（子 agent 审计）：4 个弹窗全为「假模态」——无 aria-modal、Esc 无效、
 * 焦点不进弹窗且 Tab 第 1 次即逃到背景、关闭后焦点落 body；错误态在表格容器外且
 * 文案为「…请稍后重试重试」；空态不区分筛选；390 下表头 106px、行高 243px 逐字竖排。
 */
test.describe('租户管理页（CONTRACT）', () => {
  const TENANT_ROWS = [
    { id: 11, name: '华东验证租户', code: 'east', domain: 'east.local', status: 1 },
    { id: 12, name: '华南演示租户', code: 'south', domain: 'south.local', status: 1 },
  ]

  async function openTenants(page: Page) {
    const envelope = (data: unknown) => ({ code: 0, msg: 'ok', data })
    await page.route('**/api/iam/user/profile**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({
            user: { id: 1, username: 'admin', nickname: '管理员' },
            tenants: [{ id: 11, name: '华东验证租户', code: 'east', domain: 'east.local' }],
            current_tenant_id: 11,
            is_admin: true,
            permissions: [
              'iam:tenant:view',
              'iam:tenant:add',
              'iam:tenant:edit',
              'iam:tenant:get',
              'iam:tenant:delete',
            ],
            must_select_tenant: false,
          }),
        ),
      }),
    )
    await page.route('**/api/iam/tenant/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope({ total: TENANT_ROWS.length, tenants: TENANT_ROWS })),
      }),
    )
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/tenants`, { waitUntil: 'networkidle' })
    await expect(page.locator('tbody tr').first()).toBeVisible()
  }

  test('四个弹窗均为真模态：焦点入窗 / Esc 关闭 / Tab 不逃逸 / 焦点归还', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTenants(page)

    const cases = [
      {
        name: '新增租户',
        trigger: page.locator('.page-head').getByRole('button', { name: '新增租户', exact: true }),
        firstFocus: 'form-name',
      },
      { name: '编辑租户', trigger: page.getByTestId('edit-tenant').first(), firstFocus: 'form-name' },
      { name: '禁用租户', trigger: page.getByTestId('disable-tenant').first(), firstFocus: '取消' },
      { name: '删除租户', trigger: page.getByTestId('delete-tenant').first(), firstFocus: '取消' },
    ]

    for (const c of cases) {
      await c.trigger.focus()
      await c.trigger.click()
      const dialog = page.locator('[role="dialog"],[role="alertdialog"]')
      await expect(dialog.first(), `${c.name} 应打开`).toBeVisible()
      await expect(dialog.first()).toHaveAttribute('aria-modal', 'true')
      await expect(
        dialog.first().getByRole('button', { name: '关闭', exact: true }),
      ).toBeVisible()

      const first = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        return {
          text: (el?.textContent ?? '').trim().slice(0, 8),
          testid: el?.getAttribute('data-testid') ?? null,
          inDialog: !!el?.closest('[role="dialog"],[role="alertdialog"]'),
        }
      })
      expect(first.inDialog, `${c.name}: 首焦点应在弹窗内`).toBe(true)
      if (c.firstFocus === '取消') expect(first.text).toBe('取消')
      else expect(first.testid).toBe(c.firstFocus)

      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate(
          () => !!document.activeElement?.closest('[role="dialog"],[role="alertdialog"]'),
        )
        expect(inside, `${c.name}: Tab ${i + 1} 不应逃出弹窗`).toBe(true)
      }

      await page.keyboard.press('Escape')
      await expect(dialog, `${c.name}: Esc 应关闭`).toHaveCount(0)
      // 焦点归还触发按钮
      const restored = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? null,
      )
      expect(restored, `${c.name}: 焦点应归还触发按钮`).toBe(
        (await c.trigger.getAttribute('data-testid')) ?? restored,
      )
    }
  })

  test('错误态入容器且动作分层；筛选空态可清除', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openTenants(page)

    // 错误态
    await page.unroute('**/api/iam/tenant/list**')
    await page.route('**/api/iam/tenant/list**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ code: 500, msg: 'boom', data: null }),
      }),
    )
    await page.reload({ waitUntil: 'networkidle' })
    const alert = page.locator('.table-wrap .state-error[role="alert"]')
    await expect(alert).toBeVisible()
    const geo = await page.evaluate(() => {
      const box = document.querySelector('.table-wrap .state-error') as HTMLElement
      const t = box.querySelector('span') as HTMLElement
      const b = box.querySelector('button') as HTMLElement
      return {
        stacked: Math.round(b.getBoundingClientRect().top) >= Math.round(t.getBoundingClientRect().bottom),
      }
    })
    expect(geo.stacked, '错误动作应在说明下一行').toBe(true)

    // 筛选空态
    await page.unroute('**/api/iam/tenant/list**')
    await page.route('**/api/iam/tenant/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', data: { total: 0, tenants: [] } }),
      }),
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.toolbar__search').first().fill('zzz-no-such-tenant')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    await expect(page.locator('.state-empty')).toContainText('没有匹配的租户')
    await expect(page.getByTestId('clear-filters')).toBeVisible()
  })

  test('390 窄屏：表头不竖排、表格可横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openTenants(page)

    const m = await page.evaluate(() => ({
      thMax: [...document.querySelectorAll('table.data-table th')].reduce(
        (mx, th) => Math.max(mx, Math.round(th.getBoundingClientRect().height)),
        0,
      ),
      rowH: Math.round(
        document.querySelector('table.data-table tbody tr')?.getBoundingClientRect().height ?? 0,
      ),
      scroll: (() => {
        const w = document.querySelector('.table-wrap') as HTMLElement
        return w.scrollWidth - w.clientWidth
      })(),
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }))
    // 修复前 thMax=106、rowH=243
    expect(m.thMax).toBeLessThan(48)
    expect(m.rowH).toBeLessThan(72)
    expect(m.scroll).toBeGreaterThan(0)
    expect(m.pageOverflow).toBe(false)
  })
})

/**
 * 用户详情「状态 → 禁用」二次确认。
 *
 * 修复前：`<select v-model="status">` 一选「禁用」即改本地状态，保存后账号不可登录，
 * 既无确认也无影响说明（审计实测零提示），与列表页「危险操作先确认」的约定不一致。
 */
test.describe('详情页危险操作确认', () => {
  async function openUserDetail(page: Page) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.getByTestId('detail-status')).toBeVisible()
  }

  test('选「禁用」弹确认；取消/Esc 均回滚，确认才落地', async ({ page }) => {
    await openUserDetail(page)
    const select = page.getByTestId('detail-status')
    // 只认可见实例：Element Plus 关闭后旧节点会短暂留在 DOM
    const box = page.locator('.el-message-box:visible')

    expect(await select.inputValue()).toBe('active')

    // 1) 取消 → 回滚
    await select.selectOption('disable')
    await expect(box).toBeVisible()
    await expect(box).toContainText('将无法登录')
    await box.getByRole('button', { name: '取消', exact: true }).click()
    await expect(box).toHaveCount(0)
    expect(await select.inputValue()).toBe('active')

    // 2) Esc → 回滚
    await select.selectOption('disable')
    await expect(box).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    expect(await select.inputValue()).toBe('active')

    // 3) 确认 → 落地
    await select.selectOption('disable')
    await expect(box).toBeVisible()
    await box.getByRole('button', { name: '确认禁用', exact: true }).click()
    await expect(box).toHaveCount(0)
    expect(await select.inputValue()).toBe('disable')
  })

  test('详情页不再向用户暴露开发备注（G-2/G-3/E1、待 eiam 等）', async ({ page }) => {
    await openUserDetail(page)
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).not.toMatch(/G-2|G-3|reset_password/)
    expect(text).not.toMatch(/list\/detail/)
    expect(text).toContain('当前账号的登录方式')
  })
})

/**
 * 详情页「未保存离开」拦截。
 *
 * 修复前实测：取消 / 返回列表 / 侧栏跳转 / 浏览器后退 四条路径全部静默丢弃编辑
 * （dialog=0，直接跳走）。修复后用 onBeforeRouteLeave 一处覆盖——
 * 因为四条路径最终都走路由跳转。
 */
test.describe('详情页未保存离开拦截', () => {
  // Element Plus 关闭后会把旧弹窗节点短暂留在 DOM，故只认可见实例
  const box = (page: Page) => page.locator('.el-message-box:visible')

  async function makeDirty(page: Page) {
    await page.locator('.detail-form input:not([readonly])').first().fill('dirty-e2e-value')
    await expect(
      page.locator('.form-actions button, .detail-actions button').filter({ hasText: '保存' }).first(),
    ).toBeEnabled()
  }

  /**
   * 三条 push 型路径各自独立成用例：串联在同一条用例里时，Element Plus 的关闭动画
   * 会让前后两个 `.el-message-box` 短暂共存（实测 2 个可见节点），断言不稳定。
   * 每条用例从全新页面开始，只验证一条路径。
   */
  test('取消：拦截并可继续编辑', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    await makeDirty(page)
    await page.locator('.form-actions button', { hasText: '取消' }).click()
    await expect(box(page)).toHaveCount(1)
    await expect(box(page)).toContainText('未保存')
    await box(page).getByRole('button', { name: '继续编辑' }).click()
    await expect(box(page)).toHaveCount(0)
    await expect(page).toHaveURL(/\/console\/users\/\d+$/)
  })

  test('返回列表：拦截；放弃修改后可离开', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    await makeDirty(page)
    await page.getByRole('button', { name: /返回用户列表|← 返回/ }).first().click()
    await expect(box(page)).toHaveCount(1)
    await box(page).getByRole('button', { name: '继续编辑' }).click()
    await expect(page).toHaveURL(/\/console\/users\/\d+$/)

    // 放弃修改 → 允许离开
    await page.getByRole('button', { name: /返回用户列表|← 返回/ }).first().click()
    await expect(box(page)).toHaveCount(1)
    await box(page).getByRole('button', { name: '放弃修改并离开' }).click()
    await expect(page).toHaveURL(/\/console\/users$/)
  })

  test('侧栏跳转：拦截并可继续编辑', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    await makeDirty(page)
    await page.locator('.sidebar a').filter({ hasText: '角色管理' }).first().click()
    await expect(box(page)).toHaveCount(1)
    await box(page).getByRole('button', { name: '继续编辑' }).click()
    await expect(page).toHaveURL(/\/console\/users\/\d+$/)
  })

  test('浏览器后退（SPA 内导航）同样拦截', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    // 必须用应用内跳转进入详情，`page.goto` 属文档级导航、后退会整页重载（Vue 守卫无法介入）
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })
    await page.getByTestId('edit-user').first().click()
    await page.waitForURL(/\/console\/users\/\d+$/)
    await expect(page.locator('.detail-form')).toBeVisible()

    await makeDirty(page)
    await page.goBack()

    await expect(box(page)).toBeVisible()
    await box(page).getByRole('button', { name: '继续编辑' }).click()
    // 守卫拒绝后 vue-router 应把 URL 恢复回详情页
    await expect(page).toHaveURL(/\/console\/users\/\d+$/)
  })

  test('保存成功后返回列表不被自身守卫拦住', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.route('**/api/iam/user/update**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
      }),
    )
    await page.goto(`${BASE_URL}/console/users/1`, { waitUntil: 'networkidle' })
    await expect(page.locator('.detail-form')).toBeVisible()

    await makeDirty(page)
    await page.locator('.form-actions button').filter({ hasText: '保存' }).first().click()

    // 保存成功 → 直接回列表，不弹「未保存」确认
    await expect(page).toHaveURL(/\/console\/users$/)
    await expect(box(page)).toHaveCount(0)
  })
})

/**
 * 列表页加载态可播报（R5/R6）。
 *
 * 修复前实测（4 页一致）：`role=status` 数量为 0，骨架带 `aria-hidden="true"`，
 * 只有 `aria-busy` 属性在变 → 读屏用户完全得不到「正在加载」信息；
 * 刷新/翻页时更是连骨架都没有，形同无反应。
 */
test.describe('列表加载态可播报', () => {
  const cases = [
    { name: '用户管理', path: '/console/users', list: '**/api/iam/user/list**', text: '正在加载用户列表…' },
    { name: '角色管理', path: '/console/roles', list: '**/api/iam/role/list**', text: '正在加载角色列表…' },
    {
      name: '授权管理',
      path: '/console/authorizations',
      list: '**/api/iam/permission/authorizations**',
      text: '正在加载授权列表…',
    },
  ]

  for (const c of cases) {
    test(`${c.name}：加载中暴露 role=status 且文案随状态清空`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await loginAsAdmin(page)

      await page.route(c.list, async (route) => {
        await new Promise((r) => setTimeout(r, 2000))
        await route.continue()
      })
      await page.goto(`${BASE_URL}${c.path}`)

      const status = page.locator('[role="status"]')
      await expect(status).toHaveCount(1)
      await expect(status).toHaveAttribute('aria-live', 'polite')
      await expect(status).toHaveText(c.text)

      // sr-only：视觉不可见、仍在无障碍树
      const hidden = await status.evaluate((el) => {
        const cs = getComputedStyle(el)
        return parseInt(cs.width) <= 1 && parseInt(cs.height) <= 1
      })
      expect(hidden, '状态区应视觉隐藏（sr-only）').toBe(true)

      // 加载完成后播报结果摘要（空态文案或「共 N 条」），不再静默
      await page.unroute(c.list)
      await expect(status).toHaveText(/^(共 \d+ 条|暂无.*数据|没有匹配的.*)$/, { timeout: 10_000 })
    })
  }
})

/**
 * 列表分页「每页条数」选择器。
 *
 * 修复前实测：选择器只调 `store.setPageSize()`（仅改状态、不发起请求），
 * 切换后**零请求**、列表不变——用户/角色/策略三页同样如此，授权页则连选择器都没有。
 */
test.describe('列表每页条数', () => {
  const cases = [
    { name: '用户管理', path: '/console/users', list: '/api/iam/user/list', sel: '[data-testid="user-page-size"]' },
    { name: '角色管理', path: '/console/roles', list: '/api/iam/role/list', sel: '[data-testid="role-page-size"]' },
  ]

  for (const c of cases) {
    test(`${c.name}：切换每页条数会带 limit=50 重新请求`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await loginAsAdmin(page)
      await page.goto(`${BASE_URL}${c.path}`, { waitUntil: 'networkidle' })

      const sel = page.locator(c.sel)
      await expect(sel).toHaveCount(1)
      await expect(sel).toHaveAttribute('aria-label', '每页条数')

      const bodies: string[] = []
      page.on('request', (r) => {
        if (r.url().includes(c.list)) bodies.push(r.postData() ?? '')
      })
      await sel.selectOption('50')

      await expect.poll(() => bodies.length, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(bodies[bodies.length - 1]).toContain('"limit":50')
      await expect(sel).toHaveValue('50')
    })
  }

  test('授权管理：页大小选择器可用（原先完全缺失）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/authorizations`, { waitUntil: 'networkidle' })

    const sel = page.locator('[data-testid="auth-page-size"]')
    // 无数据时分页条整体不渲染，故仅在存在时断言可用性
    if ((await sel.count()) > 0) {
      const bodies: string[] = []
      page.on('request', (r) => {
        if (r.url().includes('/api/iam/permission/authorizations')) bodies.push(r.postData() ?? '')
      })
      await sel.selectOption('50')
      await expect.poll(() => bodies.length, { timeout: 10_000 }).toBeGreaterThan(0)
      expect(bodies[bodies.length - 1]).toContain('"limit":50')
    }
  })
})

/**
 * 加载前后布局稳定（R8）。
 *
 * 修复前实测：骨架固定 232px，`.table-wrap` 只有 `min-height:120px`，
 * 于是 1 行数据的页面从 248px 收缩到 120px（**整页跳动 128px**），
 * 6 行数据的页面则从 248px 长到 326px（+78px）。
 * 修复：`min-height` 提到与骨架实测高度一致（248px），小数据量页零跳动。
 */
test.describe('加载前后布局稳定', () => {
  test('角色页：加载中与加载后容器高度一致（1 行数据不再塌陷）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/role/list**', async (route) => {
      await new Promise((r) => setTimeout(r, 1800))
      await route.continue()
    })
    await page.goto(`${BASE_URL}/console/roles`)

    const wrapH = () =>
      page.evaluate(() => Math.round(document.querySelector('.table-wrap')!.getBoundingClientRect().height))

    await expect(page.locator('.skeleton')).toBeVisible()
    const duringLoad = await wrapH()

    await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 15_000 })
    const afterLoad = await wrapH()

    // 修复前：duringLoad=248 → afterLoad=120（塌陷 128px）
    expect(duringLoad).toBeGreaterThanOrEqual(240)
    expect(afterLoad).toBe(duringLoad)
  })
})

/**
 * 弹窗背景隔离（R9）。
 *
 * 修复前实测：弹窗打开时 `[inert]` 数量为 0，背景仍有 35 个可聚焦元素能被脚本聚焦
 * （`document.activeElement` 一度落在侧栏 logo 上）——焦点陷阱只管 Tab，
 * 管不住读屏虚拟光标，用户能「读穿」弹窗浏览后面的页面。
 */
test.describe('弹窗背景隔离', () => {
  test('打开时背景 inert 且不可聚焦；三种关闭方式都还原', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })

    const inertCount = () => page.evaluate(() => document.querySelectorAll('[inert]').length)
    const bgFocusable = () =>
      page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]')
        const target = [...document.querySelectorAll('a[href], button, input, select')].find(
          (el) => el.offsetParent !== null && (!dlg || !dlg.contains(el)),
        )
        if (!target) return null
        target.focus()
        return document.activeElement === target
      })

    const trigger = page.getByRole('button', { name: '新增用户', exact: true })
    const dialog = page.locator('[role="dialog"]')

    for (const how of ['close', 'esc', 'cancel'] as const) {
      await trigger.click()
      await expect(dialog).toBeVisible()

      expect(await inertCount(), '打开时背景应被 inert 隔离').toBeGreaterThan(0)
      expect(await bgFocusable(), '背景不应可被聚焦').toBe(false)

      if (how === 'esc') await page.keyboard.press('Escape')
      else if (how === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click()
      else await page.getByRole('button', { name: '关闭' }).first().click()

      await expect(dialog).toHaveCount(0)
      expect(await inertCount(), `关闭（${how}）后 inert 必须清空`).toBe(0)
      // 焦点归还触发按钮
      await expect(trigger).toBeFocused()
    }
  })
})

/**
 * 删除成功后焦点兜底（R10）。
 *
 * 修复前实测：删除成功后整行消失，原「删除」按钮 isConnected=false，
 * `document.activeElement` 落回 **BODY**，按 Tab 也停在 body——键盘用户丢失位置。
 * 修复后兜底到页标题（`.page-title`，补 tabindex=-1），再按 Tab 回到页头按钮。
 */
test.describe('删除后焦点兜底', () => {
  test('删除成功的行消失后，焦点不落 body 且 Tab 能继续', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })

    const mk = (id: number, name: string) => ({
      id,
      username: name,
      nickname: name,
      email: '',
      phone: '',
      job_title: '',
      status: 'active',
      ctime: 1730000000000,
      utime: 1730000000000,
      login_method: 'password',
      passkey_registered: false,
      tenant_id: 1,
    })
    let users = [mk(1, 'u-one'), mk(2, 'u-two'), mk(3, 'u-three')]

    await page.route('**/api/iam/user/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', data: { total: users.length, users } }),
      }),
    )
    await page.route('**/api/iam/user/delete**', (route) => {
      // DELETE /api/iam/user/delete/:id —— id 在 URL 上，不在 body
      const m = route.request().url().match(/\/user\/delete\/(\d+)/)
      const id = m ? Number(m[1]) : NaN
      users = users.filter((u) => u.id !== id)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, msg: 'ok', data: null }),
      })
    })

    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })
    await expect(page.locator('tbody tr')).toHaveCount(3)

    await page.getByTestId('delete-user').first().click()
    const dlg = page.locator('[role="alertdialog"]')
    await expect(dlg).toBeVisible()
    await dlg.getByRole('button', { name: /确认删除|删除/ }).last().click()

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 10_000 })
    await expect(dlg).toHaveCount(0)

    // 焦点不落 body，且落在页标题这类稳定落点
    const focus = await page.evaluate(() => {
      const el = document.activeElement
      return { isBody: el === document.body, tag: el?.tagName ?? null, text: (el?.textContent ?? '').trim() }
    })
    expect(focus.isBody, '焦点不应落在 body').toBe(false)
    expect(focus.text).toContain('用户管理')

    // 键盘可继续
    await page.keyboard.press('Tab')
    const next = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
    expect(next).not.toBe('')
  })
})

/**
 * 弹窗栈（R11）。
 *
 * 实测可复现：用脚本在「新增用户」弹窗开着时再点行内「删除」→ 两个弹窗并存。
 * 修复前两个缺陷：
 *   1) 第一次 Esc 关掉的是**底层**（先注册）的「新增用户」，而不是最上层「删除确认」；
 *   2) 底层关闭时把 inert 整体清成 0，而上层仍需隔离 → 背景又变得可聚焦。
 */
test.describe('弹窗栈', () => {
  test('两弹窗并存时 Esc 只关最上层，且隔离仍归属剩余弹窗', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })

    const snapshot = () =>
      page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        return {
          count: dialogs.length,
          titles: dialogs.map((d) => (d.getAttribute('aria-label') || d.querySelector('h3')?.textContent || '').trim()),
          inert: document.querySelectorAll('[inert]').length,
        }
      })

    // 打开「新增用户」
    await page.getByRole('button', { name: '新增用户', exact: true }).click()
    await expect(page.locator('.dialog-overlay')).toHaveCount(1)

    // 脚本绕过遮罩，再打开行内「删除」→ 并存
    await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="delete-user"]')?.click())
    await expect(page.locator('.dialog-overlay')).toHaveCount(2)

    const both = await snapshot()
    expect(both.count).toBe(2)
    expect(both.titles.join('|')).toContain('删除用户')

    // 第一次 Esc：只关最上层（删除确认）
    await page.keyboard.press('Escape')
    await expect(page.locator('.dialog-overlay')).toHaveCount(1)
    const afterFirst = await snapshot()
    expect(afterFirst.titles.join('|')).toContain('新增用户')
    expect(afterFirst.titles.join('|')).not.toContain('删除用户')
    // 剩余弹窗仍须隔离背景（修复前此处为 0）
    expect(afterFirst.inert).toBeGreaterThan(0)

    // 第二次 Esc：关掉「新增用户」
    await page.keyboard.press('Escape')
    await expect(page.locator('.dialog-overlay')).toHaveCount(0)
    expect((await snapshot()).inert).toBe(0)
  })
})

/**
 * 组织管理页加载态可播报（R5 同类缺口）。
 *
 * 修复前实测：加载中 `[role="status"]` 数量为 **0**，只有 `aria-busy` 与骨架，
 * 读屏得不到「正在加载」信息（列表页已在 R5 修过，组织页当时漏掉）。
 */
test.describe('组织页加载态可播报', () => {
  test('加载中暴露 role=status，加载后清空', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/department/list**', async (route) => {
      await new Promise((r) => setTimeout(r, 1800))
      await route.continue()
    })
    await page.goto(`${BASE_URL}/console/organizations`)

    const status = page.locator('[role="status"]')
    await expect(status).toHaveCount(1)
    await expect(status).toHaveAttribute('aria-live', 'polite')
    await expect(status).toContainText('正在加载组织树')

    // sr-only：视觉不可见、仍在无障碍树
    const hidden = await status.evaluate((el) => {
      const cs = getComputedStyle(el)
      return parseInt(cs.width) <= 1 && parseInt(cs.height) <= 1
    })
    expect(hidden, '状态区应视觉隐藏（sr-only）').toBe(true)

    await page.unroute('**/api/iam/department/list**')
    await expect(status).toHaveText('', { timeout: 10_000 })
  })
})

/**
 * 详情页加载态可播报（R5 同类缺口）。
 *
 * 修复前实测：用户/角色详情加载中 `[role="status"]` 为 **0**，骨架带 `aria-hidden`，
 * 只有 `aria-busy`：读屏在「进入详情页」这段等待里完全静默。
 */
test.describe('详情页加载态可播报', () => {
  test('用户详情：加载中暴露 role=status，加载后清空', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/user/detail**', async (route) => {
      await new Promise((r) => setTimeout(r, 1800))
      await route.continue()
    })
    await page.goto(`${BASE_URL}/console/users/1`)

    const status = page.locator('[role="status"]')
    await expect(status).toHaveCount(1)
    await expect(status).toHaveAttribute('aria-live', 'polite')
    await expect(status).toContainText('正在加载用户详情')

    const hidden = await status.evaluate((el) => {
      const cs = getComputedStyle(el)
      return parseInt(cs.width) <= 1 && parseInt(cs.height) <= 1
    })
    expect(hidden, '状态区应视觉隐藏（sr-only）').toBe(true)

    await page.unroute('**/api/iam/user/detail**')
    await expect(page.locator('.detail-form')).toBeVisible({ timeout: 10_000 })
    await expect(status).toHaveText('')
  })

  test('角色详情：加载中暴露 role=status', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.route('**/api/iam/role/detail**', async (route) => {
      await new Promise((r) => setTimeout(r, 1800))
      await route.continue()
    })
    await page.goto(`${BASE_URL}/console/roles/admin`)

    const status = page.locator('[role="status"]')
    await expect(status).toHaveCount(1)
    await expect(status).toContainText('正在加载角色详情')

    await page.unroute('**/api/iam/role/detail**')
    await expect(status).toHaveText('', { timeout: 10_000 })
  })
})

/**
 * 403 页语义与文案。
 *
 * 修复前实测：页面**没有任何 h1/h2**（`document.querySelectorAll('h1,h2,h3')` 为空），
 * 读屏用户按标题导航找不到这一页；正文还残留内部术语
 * 「当前页面访问被权限裁剪拦截，不会跳转登录页（403 本地态）」。
 * 修复后：标题即契约文案，提示语改为面向使用者的表述。
 */
test.describe('403 页', () => {
  test('有语义标题（即契约文案），且不暴露内部术语', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)

    await page.goto(`${BASE_URL}/console/forbidden?required=iam:tenant:view`, {
      waitUntil: 'networkidle',
    })

    // 语义标题存在，且内容就是契约文案（不新造第二套措辞）
    const heading = page.getByRole('heading', { level: 1 })
    await expect(heading).toHaveCount(1)
    await expect(heading).toHaveText('无权限执行该操作')

    // 权限码透传仍展示
    await expect(page.getByTestId('forbidden-required')).toContainText('iam:tenant:view')

    // 面客文案不含实现术语
    const text = await page.evaluate(() => document.body.innerText)
    expect(text).not.toContain('权限裁剪')
    expect(text).not.toContain('本地态')
    expect(text).toContain('登录状态仍然有效')
  })

  test('390 窄屏无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/forbidden?required=iam:tenant:view`, {
      waitUntil: 'networkidle',
    })

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
    expect(overflow).toBe(false)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })
})

/**
 * 列表结果摘要可播报。
 *
 * 修复前实测：加载完成与「搜索无结果」时状态区文案都是空串，
 * 而 `.state-empty` 不在 live region 内——读屏既不知道回来几条，也不知道是没搜到。
 */
test.describe('列表结果摘要可播报', () => {
  test('用户页：加载完成播报条数，搜索无结果播报空态', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })

    const status = page.locator('[role="status"]')
    // 有数据时播报条数
    await expect(status).toHaveText(/^共 \d+ 条$/, { timeout: 15_000 })

    // 搜一个必然无命中的词（后端支持用户搜索）
    await page.getByPlaceholder(/搜索/).first().fill('zzz-no-such-user-zzz')
    await page.getByRole('button', { name: '搜索', exact: true }).first().click()

    await expect(status).toHaveText(/没有匹配的用户/, { timeout: 15_000 })
    // 视觉空态仍在，且带「清除筛选」出口
    await expect(page.locator('.state-empty')).toContainText('没有匹配的用户')
  })
})

/**
 * 表格行内按钮的可访问名唯一性。
 *
 * 修复前实测：用户页 6 行 × 「编辑/删除」→ 各 6 个**同名**按钮、0 个 aria-label，
 * 读屏只会连续念「编辑 按钮」「删除 按钮」，无法分辨是哪一行。
 */
test.describe('行内按钮可访问名', () => {
  test('用户页：每行的编辑/删除带用户名，可访问名不重复', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })
    await expect(page.locator('tbody tr').first()).toBeVisible()

    const names = await page.evaluate(() =>
      [...document.querySelectorAll('tbody button')].map(
        (b) => b.getAttribute('aria-label') ?? '',
      ),
    )
    expect(names.length).toBeGreaterThan(0)
    // 全部都有可访问名
    expect(names.filter((n) => n === '')).toHaveLength(0)
    // 且互不重复
    expect(new Set(names).size).toBe(names.length)
  })

  test('角色页：编辑/删除带角色名', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/roles`, { waitUntil: 'networkidle' })
    await expect(page.locator('tbody tr').first()).toBeVisible()

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('tbody button')].map((b) => b.getAttribute('aria-label') ?? ''),
    )
    expect(labels.filter((n) => n === '')).toHaveLength(0)
    expect(labels.some((n) => n.startsWith('编辑角色 '))).toBe(true)
  })

  /**
   * 身份源页（真实账号缺权限，走 CONTRACT 造 3 行）：
   * 行内按钮与「启用」开关都必须带身份源名，且开关动词随状态切换。
   */
  test('CONTRACT · 身份源页：按钮与启用开关都带身份源名，无重名', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const envelope = (data: unknown) => ({ code: 0, msg: 'ok', data })
    const src = (id: number, name: string, enabled: boolean) => ({
      id,
      name,
      type: 'ldap',
      enabled,
      ldap: {
        url: 'ldap://ldap.corp.local:389',
        base_dn: 'dc=corp',
        bind_dn: 'cn=svc',
        username_attribute: 'uid',
        mail_attribute: 'mail',
      },
    })

    await page.route('**/api/iam/user/profile**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({
            user: { id: 1, username: 'admin', nickname: '管理员' },
            tenants: [{ id: 3, name: '验证租户', code: 'v3', domain: 'localhost' }],
            current_tenant_id: 3,
            is_admin: true,
            permissions: [
              'iam:identity_source:view',
              'iam:identity_source:save',
              'iam:identity_source:delete',
              'iam:identity_source:toggle',
            ],
            must_select_tenant: false,
          }),
        ),
      }),
    )
    await page.route('**/api/iam/identity_source/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope([src(7, 'corp-ldap', true), src(8, 'corp-oidc', false)])),
      }),
    )

    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/identity-sources`, { waitUntil: 'networkidle' })
    await expect(page.locator('tbody tr').first()).toBeVisible()

    const names = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('tbody button')].map((b) => b.getAttribute('aria-label') ?? '')
      const boxes = [...document.querySelectorAll('tbody input[type="checkbox"]')].map(
        (c) => c.getAttribute('aria-label') ?? '',
      )
      return [...btns, ...boxes]
    })

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => n === ''), '不能有无名控件').toHaveLength(0)
    expect(new Set(names).size, '可访问名不能重复').toBe(names.length)
    // 开关动词随状态切换
    expect(names).toContain('停用身份源 corp-ldap')
    expect(names).toContain('启用身份源 corp-oidc')
  })
})

/**
 * 地标结构：全站必须只有一个 <main>，且不得嵌套。
 *
 * 修复前实测：`/console/organizations` 的 `mainCount=2`、`nested=1`
 * ——外壳 `MainLayout` 已有 `<main class="layout-content">`，
 * 而 `OrgList` 里又写了一个 `<main class="org-detail">`。
 * HTML 规范禁止 `<main>` 嵌套，会让读屏的「主内容」地标与跳转失效。
 */
test.describe('地标结构', () => {
  const pages = [
    { name: '用户管理', path: '/console/users' },
    { name: '角色管理', path: '/console/roles' },
    { name: '组织管理', path: '/console/organizations' },
  ]

  for (const p of pages) {
    test(`${p.name}：只有一个 main 且无嵌套`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await loginAsAdmin(page)
      await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'networkidle' })

      const m = await page.evaluate(() => {
        const mains = [...document.querySelectorAll('main')]
        return {
          count: mains.length,
          nested: mains.filter((el) => !!el.parentElement?.closest('main')).length,
        }
      })

      expect(m.count, '页面应有且只有一个 main 地标').toBe(1)
      expect(m.nested, 'main 不得嵌套').toBe(0)
    })
  }

  test('组织详情区改为可导航 region（保留语义）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/organizations`, { waitUntil: 'networkidle' })

    const region = page.locator('section.org-detail')
    await expect(region).toHaveAttribute('aria-label', '组织详情与成员')
  })
})

/**
 * 页面主标题必须是 h1（文档大纲锚点）。
 *
 * 修复前实测：全站**没有任何 h1**——每个业务页的标题都是 `<h2 class="page-title">`，
 * 读屏按标题导航时找不到「这一页是什么」的锚点（首次进入只能靠逐段听）。
 */
test.describe('页面主标题', () => {
  const pages = [
    { name: '用户管理', path: '/console/users', title: '用户管理' },
    { name: '角色管理', path: '/console/roles', title: '角色管理' },
    { name: '策略管理', path: '/console/policies', title: '策略管理' },
    { name: '组织管理', path: '/console/organizations', title: '组织管理' },
  ]

  for (const p of pages) {
    test(`${p.name}：页面标题是 h1`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await loginAsAdmin(page)
      await page.goto(`${BASE_URL}${p.path}`, { waitUntil: 'networkidle' })

      const h1 = page.getByRole('heading', { level: 1 })
      await expect(h1).toHaveCount(1)
      await expect(h1).toHaveText(p.title)

      // 视觉不变：.page-title 显式 20px，不受 h1 默认字号影响
      const style = await h1.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { fontSize: cs.fontSize, fontWeight: cs.fontWeight }
      })
      expect(style.fontSize).toBe('20px')
      expect(style.fontWeight).toBe('600')
    })
  }
})

/**
 * 组织树叶子节点的装饰性占位不再是无名按钮。
 *
 * 修复前实测：叶子节点也渲染 `<button class="tree__toggle tree__toggle--leaf" aria-label="">`，
 * 虽然 `tabindex="-1"` 不可 Tab 到，但它仍在无障碍树里 —— 读屏虚拟光标会念到一个**没有名称的按钮**。
 * 修复后：叶子渲染为 `span[aria-hidden="true"]`（保留 16px 占位对齐），仅非叶子渲染真按钮。
 */
test.describe('组织树展开按钮', () => {
  test('CONTRACT · 叶子为装饰 span，只有非叶子是可命名的按钮', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const envelope = (data: unknown) => ({ code: 0, msg: 'ok', data })

    await page.route('**/api/iam/department/list**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope([
            {
              id: 1,
              name: '总部',
              parent_id: 0,
              children: [{ id: 2, name: '研发部', parent_id: 1, children: [] }],
            },
            { id: 3, name: '独立部门', parent_id: 0, children: [] },
          ]),
        ),
      }),
    )

    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/organizations`, { waitUntil: 'networkidle' })
    await expect(page.locator('.tree__row').first()).toBeVisible()

    const m = await page.evaluate(() => {
      const toggles = [...document.querySelectorAll('.tree__toggle')]
      const unnamed = [...document.querySelectorAll('button')].filter(
        (b) => !(b.getAttribute('aria-label') || (b.textContent || '').trim()),
      )
      return {
        rows: document.querySelectorAll('.tree__row').length,
        buttonToggles: document.querySelectorAll('button.tree__toggle').length,
        leafSpans: document.querySelectorAll('span.tree__toggle--leaf[aria-hidden="true"]').length,
        labels: [...document.querySelectorAll('button.tree__toggle')].map((b) => b.getAttribute('aria-label')),
        widths: [...new Set(toggles.map((t) => Math.round(t.getBoundingClientRect().width)))],
        unnamedButtons: unnamed.length,
      }
    })

    // 只有「总部」有子节点 → 只有 1 个真按钮；两个叶子是装饰 span
    expect(m.buttonToggles).toBe(1)
    expect(m.leafSpans).toBe(2)
    expect(m.labels).toEqual(['折叠'])
    // 占位宽度一致（对齐不破）
    expect(m.widths).toEqual([16])
    // 全页不得有无名按钮
    expect(m.unnamedButtons, '不应存在没有可访问名的按钮').toBe(0)
  })
})

/**
 * 危险操作按钮（填充态）的对比度必须 ≥ 4.5:1（WCAG 1.4.3 AA）。
 *
 * 修复前实测：白字在 `--color-danger`(#ef4444) 上只有 **3.76:1**，不达标。
 * 修复后压暗填充到约 #c43838 → **5.3:1**。
 * 注意：必须测**启用态**（disabled 控件按 WCAG 豁免，`opacity:.5` 的读数没有意义）。
 */
test.describe('危险按钮对比度', () => {
  test('删除确认弹窗的「确认删除」对比度 ≥ 4.5', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await loginAsAdmin(page)
    await page.goto(`${BASE_URL}/console/users`, { waitUntil: 'networkidle' })

    await page.getByTestId('delete-user').first().click()
    const confirm = page
      .locator('[role="alertdialog"]')
      .getByRole('button', { name: '确认删除', exact: true })
    await expect(confirm).toBeVisible()

    const measured = await confirm.evaluate((el) => {
      const parse = (c: string) => {
        let m = c.match(/rgba?\(([^)]+)\)/)
        if (m) {
          const p = m[1].split(',').map((x) => parseFloat(x.trim()))
          return { r: p[0], g: p[1], b: p[2] }
        }
        // color-mix 结果以 color(srgb r g b) 形式返回
        m = c.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
        if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255 }
        return null
      }
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const f = (v: number) => {
          v /= 255
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const cs = getComputedStyle(el as HTMLElement)
      const fg = parse(cs.color)
      const bg = parse(cs.backgroundColor)
      if (!fg || !bg) return { ratio: null, fg: cs.color, bg: cs.backgroundColor }
      const l1 = lum(fg)
      const l2 = lum(bg)
      return {
        ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05),
        fg: cs.color,
        bg: cs.backgroundColor,
        disabled: (el as HTMLButtonElement).disabled,
      }
    })

    expect(measured.disabled, '必须测启用态（disabled 控件豁免）').toBeFalsy()
    expect(measured.ratio, `对比度不足：fg=${measured.fg} bg=${measured.bg}`).not.toBeNull()
    expect(measured.ratio!).toBeGreaterThanOrEqual(4.5)
  })
})
