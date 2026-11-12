// @vitest-environment happy-dom
/**
 * TenantList 行内操作按钮的可访问名（R17c，iter371）
 *
 * 缺陷：操作列有 6 个行内按钮，可见文本只有「详情 / 编辑 / 禁用 / 启用 / 删除 / 成员 / 设为默认」。
 * 表格里每行都有一组，**读屏用户听到的是连续的「编辑 按钮」「编辑 按钮」「编辑 按钮」**，
 * 无法知道当前这个按钮作用在哪一行 —— 属 WCAG 2.4.6（标题和标签）/ 2.5.3（标签包含名称）取向。
 *
 * 修法与本仓既有范式一致（`identity-sources/IdpList.vue:403`）：
 * 用 `:aria-label` 把行标识拼进去，**可见文本保持不变**（视觉不变，只改可访问名）。
 *
 * 为什么这个缺陷之前一直标 BLOCKED：`TenantList.vue` 当时被他人占用。
 * iter371 复查：`git status --short -- src/views/tenants/TenantList.vue` 为空 —— **早已释放**，
 * 是记录没更新（S209：别把「没复查」当成「还阻塞」）。
 */
import { createPinia, setActivePinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createApp } from 'vue'
import TenantList from './TenantList.vue'
import { useUserStore } from '@/stores/user'
import { IAM_TENANT } from '@/config/permission-codes'
import type { Tenant } from '@/api/types'

const fakeListStore = {
  items: [] as Tenant[],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null as string | null,
  disableBlocked: null as { count: number; message: string } | null,
  fetch: vi.fn().mockResolvedValue(undefined),
  setKeyword: vi.fn(),
  setStatus: vi.fn(),
  setPage: vi.fn(),
  setPageSize: vi.fn(),
  clearDisableBlocked: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn().mockResolvedValue(true),
  disable: vi.fn(),
  enable: vi.fn(),
  setDefault: vi.fn(),
}

vi.mock('@/stores/tenantList', () => ({
  useTenantListStore: () => fakeListStore,
}))

function freshPinia(): void {
  const pinia = createPinia()
  pinia.use(piniaPluginPersistedstate)
  createApp({ render: () => null }).use(pinia)
  setActivePinia(pinia)
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 7,
    name: '待处理租户',
    code: 'tp',
    domain: '',
    status: 'active',
    ...overrides,
  } as Tenant
}

function grantAll(): void {
  const userStore = useUserStore()
  ;(userStore as unknown as { permissions: string[] }).permissions = Object.values(IAM_TENANT)
}

async function mountPage(tenants: Tenant[]) {
  fakeListStore.items = tenants
  fakeListStore.total = tenants.length
  freshPinia()
  grantAll()
  const wrapper = mount(TenantList)
  await new Promise((r) => setTimeout(r, 0))
  return wrapper
}

describe('TenantList 行内按钮的可访问名（R17c）', () => {
  it('每行的操作按钮 aria-label 里都带租户名（读屏能区分是哪一行）', async () => {
    const wrapper = await mountPage([
      makeTenant({ id: 1, name: '租户甲' }),
      makeTenant({ id: 2, name: '租户乙' }),
    ])

    // 收集所有带 data-testid="*-tenant" 的行内按钮
    const ids = [
      'tenant-detail',
      'edit-tenant',
      'disable-tenant',
      'delete-tenant',
      'tenant-members',
    ]

    const problems: string[] = []
    for (const tid of ids) {
      const btns = wrapper.findAll(`[data-testid="${tid}"]`)
      if (!btns.length) continue // 权限不足或状态不符时不渲染，跳过
      btns.forEach((btn, i) => {
        const aria = btn.attributes('aria-label') ?? ''
        const expectedName = i === 0 ? '租户甲' : '租户乙'
        if (!aria) {
          problems.push(`${tid}[${i}] 没有 aria-label（可访问名只有可见文本，无法区分行）`)
        } else if (!aria.includes(expectedName)) {
          problems.push(`${tid}[${i}] 的 aria-label="${aria}" 不含行标识「${expectedName}」`)
        }
      })
    }

    expect(problems, '行内按钮的可访问名必须带行标识：\n  ' + problems.join('\n  ')).toEqual([])
  })

  it('可见文本保持不变（只改可访问名，不影响视觉）', async () => {
    const wrapper = await mountPage([makeTenant({ id: 1, name: '租户甲' })])

    // 视觉文本仍是「编辑」「删除」这类短词 —— 修法不能把可见文本改长
    const edit = wrapper.find('[data-testid="edit-tenant"]')
    if (edit.exists()) expect(edit.text().trim()).toBe('编辑')

    const del = wrapper.find('[data-testid="delete-tenant"]')
    if (del.exists()) expect(del.text().trim()).toBe('删除')
  })
})
