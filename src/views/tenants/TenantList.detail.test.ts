// @vitest-environment happy-dom
/**
 * TenantList 接入详情抽屉的集成测试（feat-tenant-detail-ui 契约 §2.4，验收 T1 / T9）。
 *
 * 锁定：
 * - 行内「详情」按钮受 iam:tenant:get 门控（无权限不渲染，不靠点击报错）；
 * - 点击按钮打开抽屉，取数用的是当前行租户 id（不串租户）；
 * - 抽屉 emit('close') → 父级置 null，抽屉关闭；
 * - 既有治理配置列 / 状态筛选 / 删除入口 / 成员入口的 data-testid 未受影响（禁止改动区）。
 *
 * 手法与 ./TenantList.members.test.ts 一致：mock tenantList store / 详情 api / 成员 api，
 * 真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantList from "./TenantList.vue";
import TenantDetailDrawer from "./TenantDetailDrawer.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import type { Tenant } from "@/api/types";
import { getTenantDetail } from "@/api/tenants";

const fakeListStore = {
  items: [] as Tenant[],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null as string | null,
  keyword: "",
  status: 0,
  disableBlocked: null as { count: number; message: string } | null,
  fetch: vi.fn().mockResolvedValue(undefined),
  setKeyword: vi.fn(),
  setStatus: vi.fn(),
  setPage: vi.fn(),
  setPageSize: vi.fn(),
  clearDisableBlocked: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  setDefault: vi.fn(),
};

vi.mock("@/stores/tenantList", () => ({
  useTenantListStore: () => fakeListStore,
}));

vi.mock("@/api/tenants", () => ({
  getTenantDetail: vi.fn(),
}));

vi.mock("@/api/tenantMembers", () => ({
  listTenantMembers: vi.fn().mockResolvedValue({ total: 0, items: [] }),
  removeTenantMember: vi.fn(),
}));

const detailMock = vi.mocked(getTenantDetail);

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 7,
    name: "甲租户",
    code: "jia",
    domain: "jia.example.com",
    status: "active",
    maxAccounts: 0,
    maxUsers: 50,
    maxUserGroups: 0,
    featureSwitch: {},
    allowedVendors: [],
    userCount: 6,
    userGroupCount: 0,
    ctime: 1730000000,
    ...overrides,
  };
}

function mountWith(permissions: string[]): ReturnType<typeof mount> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  fakeListStore.items = [makeTenant()];
  fakeListStore.total = 1;
  return mount(TenantList);
}

describe("TenantList：详情入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailMock.mockResolvedValue(makeTenant());
  });

  it("无 iam:tenant:get → 不渲染「详情」按钮（T9）", () => {
    const wrapper = mountWith([IAM_TENANT.VIEW, IAM_TENANT.EDIT]);
    expect(wrapper.find('[data-testid="tenant-detail"]').exists()).toBe(false);
  });

  it("有权限 → 出现「详情」按钮，点击打开抽屉并按当前租户取数（T1/T2）", async () => {
    const wrapper = mountWith([IAM_TENANT.VIEW, IAM_TENANT.GET]);

    const button = wrapper.find('[data-testid="tenant-detail"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("详情");

    await button.trigger("click");
    await flushPromises();

    expect(
      wrapper.find('[data-testid="tenant-detail-drawer"]').exists(),
    ).toBe(true);
    expect(detailMock).toHaveBeenCalledWith(7);
  });

  it("抽屉 emit close → 关闭（target 置 null）", async () => {
    const wrapper = mountWith([IAM_TENANT.VIEW, IAM_TENANT.GET]);
    await wrapper.find('[data-testid="tenant-detail"]').trigger("click");
    await flushPromises();

    wrapper.findComponent(TenantDetailDrawer).vm.$emit("close");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="tenant-detail-drawer"]').exists()).toBe(
      false,
    );
  });

  it("既有入口未被改动：状态筛选 / 治理配置列 / 删除 / 成员仍按原权限渲染", () => {
    const wrapper = mountWith([
      IAM_TENANT.VIEW,
      IAM_TENANT.GET,
      IAM_TENANT.EDIT,
      IAM_TENANT.DELETE,
      IAM_TENANT.VIEW_MEMBERS,
    ]);
    expect(wrapper.find('[data-testid="tenant-status-filter"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="tenant-governance"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="delete-tenant"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tenant-members"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tenant-detail"]').exists()).toBe(true);
  });
});
