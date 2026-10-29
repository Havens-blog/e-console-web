// @vitest-environment happy-dom
/**
 * TenantList 接入成员抽屉的集成测试（feat-tenant-members-ui 契约 §2.3 / M1 / M6）。
 *
 * 锁定：
 * - 行内「成员」按钮受 iam:tenant:view_members 门控（无权限不渲染，不靠点击报错）；
 * - 点击按钮打开抽屉，api 层收到的是当前行租户 id（不串租户）；
 * - 抽屉 emit('removed') → 父级调用 store.fetch() 刷新用量列；
 * - 既有治理配置列 / 状态筛选 / 删除入口的 data-testid 未受影响。
 *
 * 手法：mock tenantList store + mock 成员 api（不触网络）；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantList from "./TenantList.vue";
import TenantMembersDrawer from "./TenantMembersDrawer.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import type { Tenant } from "@/api/types";
import { listTenantMembers } from "@/api/tenantMembers";

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

vi.mock("@/api/tenantMembers", () => ({
  listTenantMembers: vi.fn().mockResolvedValue({ total: 0, items: [] }),
  removeTenantMember: vi.fn(),
  assignTenantMember: vi.fn(),
}));

const listMock = vi.mocked(listTenantMembers);

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
    domain: "",
    status: "active",
    maxAccounts: 0,
    maxUsers: 0,
    maxUserGroups: 0,
    featureSwitch: {},
    allowedVendors: [],
    userCount: 5,
    userGroupCount: 0,
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

describe("TenantList：成员入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ total: 0, items: [] });
  });

  it("无 iam:tenant:view_members → 不渲染「成员」按钮（M6）", () => {
    const wrapper = mountWith([IAM_TENANT.VIEW, IAM_TENANT.EDIT]);
    expect(wrapper.find('[data-testid="tenant-members"]').exists()).toBe(false);
  });

  it("有权限 → 出现「成员」按钮，点击打开抽屉并按当前租户拉取（M1/M2）", async () => {
    const wrapper = mountWith([
      IAM_TENANT.VIEW,
      IAM_TENANT.EDIT,
      IAM_TENANT.VIEW_MEMBERS,
    ]);

    const button = wrapper.find('[data-testid="tenant-members"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("成员");

    await button.trigger("click");
    await flushPromises();

    expect(
      wrapper.find('[data-testid="tenant-members-drawer"]').exists(),
    ).toBe(true);
    expect(listMock).toHaveBeenCalledWith(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("抽屉 emit removed → 父级 store.fetch() 刷新租户列表（用量列）", async () => {
    const wrapper = mountWith([IAM_TENANT.VIEW_MEMBERS]);
    await wrapper.find('[data-testid="tenant-members"]').trigger("click");
    await flushPromises();

    fakeListStore.fetch.mockClear();
    wrapper.findComponent(TenantMembersDrawer).vm.$emit("removed");
    await wrapper.vm.$nextTick();

    expect(fakeListStore.fetch).toHaveBeenCalledTimes(1);
  });

  it("抽屉 emit assigned → 父级 store.fetch() 刷新租户列表（用量列，feat-tenant-assign-member §2.3）", async () => {
    const wrapper = mountWith([IAM_TENANT.VIEW_MEMBERS, IAM_TENANT.ASSIGN]);
    await wrapper.find('[data-testid="tenant-members"]').trigger("click");
    await flushPromises();

    fakeListStore.fetch.mockClear();
    wrapper.findComponent(TenantMembersDrawer).vm.$emit("assigned");
    await wrapper.vm.$nextTick();

    expect(fakeListStore.fetch).toHaveBeenCalledTimes(1);
  });

  it("抽屉 emit close → 关闭（tenant 置 null）", async () => {
    const wrapper = mountWith([IAM_TENANT.VIEW_MEMBERS]);
    await wrapper.find('[data-testid="tenant-members"]').trigger("click");
    await flushPromises();

    wrapper.findComponent(TenantMembersDrawer).vm.$emit("close");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="tenant-members-drawer"]').exists()).toBe(
      false,
    );
  });

  it("既有入口未被改动：状态筛选 / 治理配置列 / 删除按钮仍在", () => {
    const wrapper = mountWith([
      IAM_TENANT.VIEW,
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
  });
});
