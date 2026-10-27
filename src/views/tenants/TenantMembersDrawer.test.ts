// @vitest-environment happy-dom
/**
 * TenantMembersDrawer 组件行为测试（feat-tenant-members-ui 契约 §2.2/§3 + 验收 M2–M5/M7/M9）。
 *
 * 锁定用户可观察行为（api 层 mock，不触真实网络）：
 * - 打开即拉取（X-Active-Tenant-ID 由 api 层注入，组件按当前 tenant.id 传参）；
 * - 搜索 / 重置重置分页（第 1 页、keyword 生效）；
 * - 移除必须二次确认（点「移除」不发请求，确认后才调 api）；
 * - 移除成功 emit('removed') 并重拉列表；
 * - 移除被拒时原样展示服务端 msg（不吞、不改写），且不 emit removed；
 * - 无 iam:tenant:unassign 权限不渲染「移除」按钮；
 * - 空态文案「该租户暂无成员」+ 可直接删除提示；
 * - tenant=null 不渲染、不拉取；关闭时不产生新请求。
 *
 * 手法：mock @/api/tenantMembers；真实 user store（pinia）注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantMembersDrawer from "./TenantMembersDrawer.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import { ApiError, type TenantMember } from "@/api/types";
import { listTenantMembers, removeTenantMember } from "@/api/tenantMembers";

vi.mock("@/api/tenantMembers", () => ({
  listTenantMembers: vi.fn(),
  removeTenantMember: vi.fn(),
}));

const listMock = vi.mocked(listTenantMembers);
const removeMock = vi.mocked(removeTenantMember);

const TENANT = { id: 7, name: "甲租户" };

function makeMember(overrides: Partial<TenantMember> = {}): TenantMember {
  return {
    id: 42,
    username: "zhangsan",
    nickname: "张三",
    email: "z@example.com",
    status: "active",
    jobTitle: "工程师",
    lastLoginAt: 1_730_000_000_000,  // eiam 为 Unix **毫秒**（time.Now().UnixMilli()）
    ctime: 1_729_000_000_000,
    ...overrides,
  };
}

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

async function mountDrawer(
  tenant: { id: number; name: string } | null = TENANT,
  permissions: string[] = [IAM_TENANT.UNASSIGN],
): Promise<ReturnType<typeof mount>> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(TenantMembersDrawer, { props: { tenant } });
  await flushPromises();
  return wrapper;
}

describe("TenantMembersDrawer：打开 / 拉取", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({
      total: 2,
      items: [
        makeMember(),
        makeMember({
          id: 43,
          username: "lisi",
          nickname: "李四",
          email: undefined,
          status: "disable",
        }),
      ],
    });
    removeMock.mockResolvedValue(undefined);
  });

  it("打开即拉取：按 tenant.id 请求第 1 页，渲染成员行与标题", async () => {
    const wrapper = await mountDrawer();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(wrapper.find('[data-testid="tenant-members-drawer"]').exists()).toBe(
      true,
    );
    expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(2);
    expect(wrapper.text()).toContain("甲租户 · 成员");
    expect(wrapper.find('[data-testid="member-search"]').exists()).toBe(true);
  });

  it("tenant=null → 不渲染且不拉取", async () => {
    const wrapper = await mountDrawer(null);
    expect(wrapper.find('[data-testid="tenant-members-drawer"]').exists()).toBe(
      false,
    );
    expect(listMock).not.toHaveBeenCalled();
  });

  it("关闭：emit close，且不产生新请求", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="member-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    // 父级响应 close 把 tenant 置 null → 不再拉取
    await wrapper.setProps({ tenant: null });
    await flushPromises();
    expect(wrapper.find('[data-testid="tenant-members-drawer"]').exists()).toBe(
      false,
    );
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe("TenantMembersDrawer：搜索 / 分页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ total: 45, items: [makeMember()] });
    removeMock.mockResolvedValue(undefined);
  });

  it("搜索：关键词 trim 后生效并重置到第 1 页；重置清空关键词", async () => {
    const wrapper = await mountDrawer();

    // 先翻到第 2 页
    await wrapper.find('[data-testid="member-next"]').trigger("click");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith(7, {
      offset: 20,
      limit: 20,
      keyword: "",
    });

    // 输入关键词回车搜索 → offset 归 0
    const search = wrapper.find('[data-testid="member-search"]');
    await search.setValue("  李  ");
    await search.trigger("keyup.enter");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith(7, {
      offset: 0,
      limit: 20,
      keyword: "李",
    });

    // 重置 → keyword 清空并回第 1 页
    const reset = wrapper
      .findAll("button")
      .find((b) => b.text().replace(/\s+/g, "") === "重置");
    expect(reset).toBeDefined();
    await reset!.trigger("click");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("切页大小重置到第 1 页（20/50/100 同租户列表口径）", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="member-next"]').trigger("click");
    await flushPromises();

    const size = wrapper.find("select.pagination__size");
    await size.setValue("50");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith(7, {
      offset: 0,
      limit: 50,
      keyword: "",
    });
  });
});

describe("TenantMembersDrawer：移除成员", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({ total: 2, items: [makeMember()] });
    removeMock.mockResolvedValue(undefined);
  });

  it("点「移除」只打开二次确认，不发请求；确认后才调 api 并 emit removed", async () => {
    const wrapper = await mountDrawer();

    await wrapper.find('[data-testid="member-remove"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="member-remove-confirm"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-testid="member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).toHaveBeenCalledWith(7, 42);
    expect(wrapper.emitted("removed")).toHaveLength(1);
    // 成功后重拉当前页
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("被拒时原样展示服务端 msg（禁止移除自己），且不 emit removed", async () => {
    removeMock.mockRejectedValueOnce(
      new ApiError("unknown", "禁止将当前登录账号从当前租户空间中移除", {
        code: 4020910,
      }),
    );
    const wrapper = await mountDrawer();

    await wrapper.find('[data-testid="member-remove"]').trigger("click");
    await wrapper.find('[data-testid="member-remove-confirm"]').trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="member-remove-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("禁止将当前登录账号从当前租户空间中移除");
    expect(wrapper.emitted("removed")).toBeUndefined();
    // 确认弹窗保持打开，允许取消 / 重试
    expect(
      wrapper.find('[data-testid="member-remove-confirm"]').exists(),
    ).toBe(true);
  });

  it("无 iam:tenant:unassign 权限 → 不渲染「移除」按钮", async () => {
    const wrapper = await mountDrawer(TENANT, []);
    expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="member-remove"]')).toHaveLength(0);
  });
});

describe("TenantMembersDrawer：空态 / 错误态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeMock.mockResolvedValue(undefined);
  });

  it("空租户 → 「该租户暂无成员」+ 可直接删除提示", async () => {
    listMock.mockResolvedValue({ total: 0, items: [] });
    const wrapper = await mountDrawer();

    const empty = wrapper.find('[data-testid="member-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("该租户暂无成员");
    expect(empty.text()).toContain("可直接删除");
    expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(0);
  });

  it("加载失败 → 展示服务端 msg + 重试可恢复", async () => {
    listMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountDrawer();

    const error = wrapper.find('[data-testid="member-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");

    listMock.mockResolvedValue({ total: 1, items: [makeMember()] });
    const retry = wrapper
      .findAll("button")
      .find((b) => b.text().replace(/\s+/g, "") === "重试");
    expect(retry).toBeDefined();
    await retry!.trigger("click");
    await flushPromises();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('[data-testid="member-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="member-error"]').exists()).toBe(false);
  });
});
