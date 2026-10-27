// @vitest-environment happy-dom
/**
 * TenantList 删除弹窗的「从属资源」前置拦截（feat-tenant-delete-guard，需求 3 AC4/AC5）。
 *
 * 锁定用户可观察行为：
 * - 行内计数显示仍有用户/用户组 → 打开删除弹窗即出现提示，且「确认删除」禁用；
 * - 计数为 0 → 无提示、可确认（空租户可删）；
 * - 计数 undefined（统计不可用）→ **不误拦**（交由服务端 fail-closed 兜底）。
 *
 * 手法与 ./TenantList.test.ts 一致：mock tenantList store，真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantList from "./TenantList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import type { Tenant } from "@/api/types";

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
};

vi.mock("@/stores/tenantList", () => ({
  useTenantListStore: () => fakeListStore,
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 7,
    name: "待删租户",
    code: "del",
    domain: "",
    status: "active",
    maxAccounts: 0,
    maxUsers: 0,
    maxUserGroups: 0,
    featureSwitch: {},
    allowedVendors: [],
    userCount: 0,
    userGroupCount: 0,
    ...overrides,
  };
}

function mountWith(tenant: Tenant) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    IAM_TENANT.VIEW,
    IAM_TENANT.EDIT,
    IAM_TENANT.DELETE,
  ];
  fakeListStore.items = [tenant];
  fakeListStore.total = 1;
  return mount(TenantList);
}

/** 点开删除弹窗 */
async function openDeleteDialog(wrapper: ReturnType<typeof mountWith>) {
  await wrapper.find('[data-testid="delete-tenant"]').trigger("click");
  await wrapper.vm.$nextTick();
}

describe("TenantList：删除前的从属资源拦截", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("仍有用户 → 弹窗提示数量且「确认删除」禁用", async () => {
    const wrapper = mountWith(makeTenant({ userCount: 5, userGroupCount: 0 }));
    await openDeleteDialog(wrapper);

    const hint = wrapper.find('[data-testid="delete-resource-hint"]');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain("5 个用户");

    const confirm = wrapper.find('[data-testid="delete-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();
  });

  it("仍有用户组 → 同时列出用户组数量并禁用", async () => {
    const wrapper = mountWith(makeTenant({ userCount: 2, userGroupCount: 3 }));
    await openDeleteDialog(wrapper);

    const hint = wrapper.find('[data-testid="delete-resource-hint"]');
    expect(hint.text()).toContain("2 个用户");
    expect(hint.text()).toContain("3 个用户组");
    expect(
      wrapper.find('[data-testid="delete-confirm"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("已清空（计数均为 0）→ 无提示且可确认", async () => {
    const wrapper = mountWith(makeTenant({ userCount: 0, userGroupCount: 0 }));
    await openDeleteDialog(wrapper);

    expect(wrapper.find('[data-testid="delete-resource-hint"]').exists()).toBe(
      false,
    );
    expect(
      wrapper.find('[data-testid="delete-confirm"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("计数不可用（undefined）→ 不误拦，交由服务端兜底", async () => {
    const wrapper = mountWith(
      makeTenant({ userCount: undefined, userGroupCount: undefined }),
    );
    await openDeleteDialog(wrapper);

    expect(wrapper.find('[data-testid="delete-resource-hint"]').exists()).toBe(
      false,
    );
    expect(
      wrapper.find('[data-testid="delete-confirm"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("被前置拦截时点确认不发删除请求", async () => {
    const wrapper = mountWith(makeTenant({ userCount: 4 }));
    await openDeleteDialog(wrapper);
    await wrapper.find('[data-testid="delete-confirm"]').trigger("click");
    expect(fakeListStore.remove).not.toHaveBeenCalled();
  });
});
