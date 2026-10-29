// @vitest-environment happy-dom
/**
 * TenantMembersDrawer「添加成员」行为测试
 * （feat-tenant-assign-member 契约 §2.2/§3 + 需求卡 A1–A5/A8/A9）。
 *
 * 锁定用户可观察行为（api 层全 mock，不触真实网络、不创建用户）：
 * - 入口按钮受 iam:tenant:assign 门控（无权限不渲染）；
 * - 打开选择器即 listUsers 拉候选（复用 @/api/users，不重复实现）；
 * - 搜索关键词 trim 后生效并重置分页；
 * - 按**当前成员集合的 id** 判定「已在租户」：行置灰不可选、确认禁用；
 * - 确认成功 → 调 assignTenantMember(tenant.id, user.id) + 关闭选择器 + 重拉成员 + emit('assigned')；
 * - 被拒 → 在 member-picker-error 展示服务端 msg 原文（不改写）、不 emit('assigned')、选择器保持打开；
 * - 取消不发任何请求；tenant=null 不拉取候选。
 *
 * 手法与 TenantMembersDrawer.test.ts 一致：mock api 模块；真实 user store（pinia）注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantMembersDrawer from "./TenantMembersDrawer.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import { ApiError, type TenantMember, type User } from "@/api/types";
import { assignTenantMember, listTenantMembers } from "@/api/tenantMembers";
import { listUsers } from "@/api/users";

vi.mock("@/api/tenantMembers", () => ({
  listTenantMembers: vi.fn(),
  removeTenantMember: vi.fn(),
  assignTenantMember: vi.fn(),
}));

vi.mock("@/api/users", () => ({
  listUsers: vi.fn(),
}));

const listMembersMock = vi.mocked(listTenantMembers);
const assignMock = vi.mocked(assignTenantMember);
const listUsersMock = vi.mocked(listUsers);

const TENANT = { id: 7, name: "甲租户" };

/** 已在租户的成员（id 42 / 43） */
function makeMember(overrides: Partial<TenantMember> = {}): TenantMember {
  return {
    id: 42,
    username: "zhangsan",
    nickname: "张三",
    email: "z@example.com",
    status: "active",
    ...overrides,
  };
}

/** 候选用户（42 已是成员；65/66 不是） */
function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 65,
    username: "wangwu",
    displayName: "王五",
    tenantId: 0,
    roles: [],
    status: "active",
    loginMethod: "password",
    passkeyRegistered: false,
    ...overrides,
  };
}

const CANDIDATES: User[] = [
  makeUser({ id: 42, username: "zhangsan", displayName: "张三" }),
  makeUser({ id: 65, username: "wangwu", displayName: "王五" }),
  makeUser({ id: 66, username: "zhaoliu", displayName: "赵六" }),
];

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

/** 抽屉 wrapper 类型（与既有测试同口径：mount 返回类型） */
type DrawerWrapper = ReturnType<typeof mount>;

async function mountDrawer(
  tenant: { id: number; name: string } | null = TENANT,
  permissions: string[] = [IAM_TENANT.UNASSIGN, IAM_TENANT.ASSIGN],
): Promise<DrawerWrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(TenantMembersDrawer, { props: { tenant } });
  await flushPromises();
  return wrapper;
}

/** 打开选择器并等候选渲染完成 */
async function openPicker(wrapper: DrawerWrapper): Promise<void> {
  await wrapper.find('[data-testid="member-add"]').trigger("click");
  await flushPromises();
}

function pickerRows(wrapper: DrawerWrapper) {
  return wrapper.findAll('[data-testid="member-picker-row"]');
}

/** 选择器内的按钮（按去空白文本精确匹配，避免命中抽屉工具条同名按钮） */
function pickerButton(wrapper: DrawerWrapper, text: string) {
  const picker = wrapper.find('[data-testid="member-picker"]');
  return picker
    .findAll("button")
    .find((b) => b.text().replace(/\s+/g, "") === text);
}

describe("TenantMembersDrawer：添加成员入口（A1/A9）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersMock.mockResolvedValue({ total: 2, items: [makeMember()] });
    listUsersMock.mockResolvedValue({ total: 3, items: CANDIDATES });
    assignMock.mockResolvedValue(undefined);
  });

  it("有 iam:tenant:assign → 工具条渲染「添加成员」按钮", async () => {
    const wrapper = await mountDrawer();
    const button = wrapper.find('[data-testid="member-add"]');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain("添加成员");
  });

  it("无 iam:tenant:assign → 不渲染「添加成员」按钮（A9）", async () => {
    const wrapper = await mountDrawer(TENANT, [IAM_TENANT.UNASSIGN]);
    expect(wrapper.find('[data-testid="member-add"]').exists()).toBe(false);
  });

  it("tenant=null → 抽屉不渲染、不拉候选用户", async () => {
    const wrapper = await mountDrawer(null);
    expect(wrapper.find('[data-testid="member-add"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);
    expect(listUsersMock).not.toHaveBeenCalled();
  });
});

describe("TenantMembersDrawer：用户选择器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersMock.mockResolvedValue({
      total: 2,
      items: [makeMember(), makeMember({ id: 43, username: "lisi" })],
    });
    listUsersMock.mockResolvedValue({ total: 3, items: CANDIDATES });
    assignMock.mockResolvedValue(undefined);
  });

  it("打开即拉候选用户（第 1 页、空关键词）并渲染候选行（A2）", async () => {
    const wrapper = await mountDrawer();
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);

    await openPicker(wrapper);

    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(true);
    expect(listUsersMock).toHaveBeenCalledTimes(1);
    expect(listUsersMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(pickerRows(wrapper)).toHaveLength(3);
  });

  it("搜索：关键词 trim 后生效并重置分页（Enter 与「搜索」按钮同路径，A3）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const search = wrapper.find('[data-testid="member-picker-search"]');
    await search.setValue("  王  ");
    await search.trigger("keyup.enter");
    await flushPromises();

    expect(listUsersMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      keyword: "王",
    });

    // 「搜索」按钮同样触发（关键词为空串时也回第 1 页重查）
    await search.setValue("");
    const searchButton = pickerButton(wrapper, "搜索");
    expect(searchButton).toBeDefined();
    await searchButton!.trigger("click");
    await flushPromises();

    expect(listUsersMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("已在租户的行置灰且标「已在租户」，点击不选中、确认保持禁用（A4）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const rows = pickerRows(wrapper);
    // 候选顺序与 mock 一致：42（成员）/ 65 / 66
    expect(rows[0]!.attributes("disabled")).toBeDefined();
    expect(rows[0]!.attributes("aria-disabled")).toBe("true");
    expect(rows[0]!.text()).toContain("已在租户");

    expect(rows[1]!.attributes("disabled")).toBeUndefined();
    expect(rows[1]!.text()).not.toContain("已在租户");

    // 点已在租户的行 → 不产生选中态，确认按钮仍禁用
    await rows[0]!.trigger("click");
    await flushPromises();
    expect(rows[0]!.classes()).not.toContain("is-selected");
    expect(
      wrapper
        .find('[data-testid="member-picker-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();

    // 选中非成员行 → 高亮且确认可用
    await rows[1]!.trigger("click");
    await flushPromises();
    expect(rows[1]!.classes()).toContain("is-selected");
    expect(
      wrapper
        .find('[data-testid="member-picker-confirm"]')
        .attributes("disabled"),
    ).toBeUndefined();
  });

  it("确认加入：调 api(租户id, 用户id)、关闭选择器、重拉成员并 emit assigned（A5）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await wrapper.find('[data-testid="member-picker-confirm"]').trigger("click");
    await flushPromises();

    expect(assignMock).toHaveBeenCalledWith(7, 65);
    expect(wrapper.emitted("assigned")).toHaveLength(1);
    // 选择器关闭
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);
    // 成员列表重拉（初次 + 加入成功后各一次）
    expect(listMembersMock).toHaveBeenCalledTimes(2);
    expect(listMembersMock).toHaveBeenLastCalledWith(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("被拒：member-picker-error 展示服务端 msg 原文，不 emit assigned，选择器保持打开（A8）", async () => {
    const MSG = "该用户已在此租户空间中，无需重复添加";
    assignMock.mockRejectedValueOnce(
      new ApiError("unknown", MSG, { code: 4020904 }),
    );

    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await wrapper.find('[data-testid="member-picker-confirm"]').trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="member-picker-error"]');
    expect(error.exists()).toBe(true);
    // 原文展示：不套通用文案、不截断
    expect(error.text()).toBe(MSG);
    expect(wrapper.emitted("assigned")).toBeUndefined();
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(true);
    // 未重拉成员列表（初次 1 次）
    expect(listMembersMock).toHaveBeenCalledTimes(1);
  });

  it("取消：关闭选择器且不发任何请求", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await wrapper.find('[data-testid="member-picker-cancel"]').trigger("click");
    await flushPromises();

    expect(assignMock).not.toHaveBeenCalled();
    expect(wrapper.emitted("assigned")).toBeUndefined();
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);
    expect(listUsersMock).toHaveBeenCalledTimes(1);
  });

  it("候选加载失败 → 展示原文 + 重试可恢复（PRD §6）", async () => {
    listUsersMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );

    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const error = wrapper.find('[data-testid="member-picker-load-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");
    expect(pickerRows(wrapper)).toHaveLength(0);

    listUsersMock.mockResolvedValue({ total: 3, items: CANDIDATES });
    const retry = pickerButton(wrapper, "重试");
    expect(retry).toBeDefined();
    await retry!.trigger("click");
    await flushPromises();

    expect(listUsersMock).toHaveBeenCalledTimes(2);
    expect(pickerRows(wrapper)).toHaveLength(3);
    expect(
      wrapper.find('[data-testid="member-picker-load-error"]').exists(),
    ).toBe(false);
  });
});
