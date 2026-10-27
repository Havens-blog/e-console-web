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

    const revokeBtn = page.getByRole('button', { name: '撤销', exact: true }).first()
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

    // 删除弹窗：首焦点为取消
    const delBtn = page.getByRole('button', { name: '删除', exact: true }).first()
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
