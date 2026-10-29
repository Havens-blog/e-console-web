// @vitest-environment happy-dom
/**
 * GroupMembersDrawer 组件行为测试（feat-group-members 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层 mock，**不触真实网络、不创建真实用户组/成员**）：
 * - 打开即拉取（按行 groupCode 请求第 1 页）、group=null 不渲染不拉取；
 * - 搜索走**服务端**（keyword 上行 + 重置到第 1 页；该端点真支持 keyword）；
 * - 分页 20 / 50 / 100（切页大小回第 1 页、下一页 offset 递增）；
 * - 添加成员：选择器复用 listUsers，**多选**复选框 → 确认调 assignGroupMembers(code, usernames[])
 *   （断言传入的是 **username 数组**，不是 id 数组）；
 * - 已在组内：候选置灰（checkbox disabled + 「已在组内」标记），不可选中、不可提交；
 * - 移除：先二次确认（点「移除」不发请求），确认后调 removeGroupMembers(code, [username])；
 * - 被拒：原样展示服务端 msg（不改写），且不 emit changed；
 * - 空态文案「该用户组暂无成员」、列表错误态原文 + 重试；
 * - 关闭抽屉：emit close 且不产生新请求；
 * - 权限：无 ASSIGN_MEMBERS 不渲染「添加成员」，无 REMOVE_MEMBERS 不渲染「移除」。
 *
 * 手法：mock `@/api/groups` 三函数与 `@/api/users` 的 listUsers；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupMembersDrawer from "./GroupMembersDrawer.vue";
import { useUserStore } from "@/stores/user";
import { IAM_GROUP } from "@/config/permission-codes";
import { ApiError, type Page, type User } from "@/api/types";
import type { GroupMember } from "@/api/groups";
import {
  assignGroupMembers,
  listGroupMembers,
  removeGroupMembers,
} from "@/api/groups";
import { listUsers } from "@/api/users";

vi.mock("@/api/groups", () => ({
  listGroupMembers: vi.fn(),
  assignGroupMembers: vi.fn(),
  removeGroupMembers: vi.fn(),
}));

vi.mock("@/api/users", () => ({
  listUsers: vi.fn(),
}));

const listMock = vi.mocked(listGroupMembers);
const assignMock = vi.mocked(assignGroupMembers);
const removeMock = vi.mocked(removeGroupMembers);
const listUsersMock = vi.mocked(listUsers);

const GROUP = { code: "rd", name: "研发组" };

function makeMember(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    id: 42,
    username: "zhangsan",
    nickname: "张三",
    email: "z@example.com",
    phone: "13800000000",
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 42,
    username: "zhangsan",
    displayName: "张三",
    tenantId: 1,
    roles: [],
    status: "active",
    loginMethod: "password",
    passkeyRegistered: false,
    ...overrides,
  };
}

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

async function mountDrawer(
  group: { code: string; name: string } | null = GROUP,
  permissions: string[] = [
    IAM_GROUP.MEMBERS,
    IAM_GROUP.ASSIGN_MEMBERS,
    IAM_GROUP.REMOVE_MEMBERS,
  ],
): Promise<ReturnType<typeof mount>> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(GroupMembersDrawer, { props: { group } });
  await flushPromises();
  return wrapper;
}

/** 打开添加成员选择器（等待候选用户加载完成） */
async function openPicker(
  wrapper: Awaited<ReturnType<typeof mountDrawer>>,
): Promise<void> {
  await wrapper.find('[data-testid="group-member-add"]').trigger("click");
  await flushPromises();
}

/** 选择器内所有候选行的复选框 */
function pickerBoxes(wrapper: Awaited<ReturnType<typeof mountDrawer>>) {
  return wrapper.findAll(
    '[data-testid="group-member-picker-row"] input[type="checkbox"]',
  );
}

describe("GroupMembersDrawer：打开 / 拉取", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(pageOf([makeMember()]));
    assignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    listUsersMock.mockResolvedValue(pageOf([]));
  });

  it("打开即拉取：按 groupCode 请求第 1 页，渲染成员行与标题", async () => {
    listMock.mockResolvedValue(
      pageOf([
        makeMember(),
        makeMember({
          id: 43,
          username: "lisi",
          nickname: "李四",
          email: undefined,
        }),
      ]),
    );
    const wrapper = await mountDrawer();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith("rd", {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(
      wrapper.find('[data-testid="group-members-drawer"]').exists(),
    ).toBe(true);
    expect(wrapper.text()).toContain("研发组 · 成员");
    // 契约 §2.2 必备 testid
    for (const id of [
      "group-members-close",
      "group-member-search",
      "group-member-add",
      "group-member-pagination",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }

    const rows = wrapper.findAll('[data-testid="group-member-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("zhangsan");
    expect(rows[0]!.text()).toContain("张三");
    expect(rows[0]!.text()).toContain("z@example.com");
    // 邮箱缺失 → '—'
    expect(rows[1]!.text()).toContain("—");
  });

  it("group=null → 不渲染且不拉取", async () => {
    const wrapper = await mountDrawer(null);
    expect(
      wrapper.find('[data-testid="group-members-drawer"]').exists(),
    ).toBe(false);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("关闭：emit close，且不产生新请求", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="group-members-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    // 父级响应 close 把 group 置 null → 不再拉取
    await wrapper.setProps({ group: null });
    await flushPromises();
    expect(
      wrapper.find('[data-testid="group-members-drawer"]').exists(),
    ).toBe(false);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("父级重渲染传入新对象但 code 相同 → 不重复拉取（按 code 而非对象身份观察）", async () => {
    const wrapper = await mountDrawer();
    expect(listMock).toHaveBeenCalledTimes(1);

    // 模拟父页重渲染：同一 code 的新对象字面量（身份变了）
    await wrapper.setProps({ group: { code: "rd", name: "研发组" } });
    await flushPromises();

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("切到另一个组（code 变化）→ 按新 code 重置到第 1 页重拉", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="group-member-next"]').trigger("click");
    await flushPromises();

    await wrapper.setProps({ group: { code: "ops", name: "运维组" } });
    await flushPromises();

    expect(listMock).toHaveBeenLastCalledWith("ops", {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });
});

describe("GroupMembersDrawer：服务端搜索 / 分页", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(pageOf([makeMember()], 45));
    assignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
  });

  it("搜索带 keyword 且重置到第 1 页（服务端搜索，非本页假筛选）", async () => {
    const wrapper = await mountDrawer();

    // 先翻到第 2 页（offset=20）
    await wrapper.find('[data-testid="group-member-next"]').trigger("click");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 20,
      limit: 20,
      keyword: "",
    });

    // 关键词 trim 后上行，offset 归 0
    const search = wrapper.find('[data-testid="group-member-search"]');
    await search.setValue("  张  ");
    await search.trigger("keyup.enter");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 0,
      limit: 20,
      keyword: "张",
    });

    // 重置 → keyword 清空并回第 1 页
    await wrapper
      .findAll("button")
      .find((b) => b.text().replace(/\s+/g, "") === "重置")!
      .trigger("click");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("分页 20 / 50 / 100：切页大小重置到第 1 页", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="group-member-next"]').trigger("click");
    await flushPromises();

    const size = wrapper.find('[data-testid="group-member-page-size"]');
    // 三档都可选（20 / 50 / 100）
    expect(
      size.findAll("option").map((o) => o.attributes("value")),
    ).toEqual(["20", "50", "100"]);

    await size.setValue("50");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 0,
      limit: 50,
      keyword: "",
    });

    await size.setValue("100");
    await flushPromises();
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 0,
      limit: 100,
      keyword: "",
    });
  });
});

describe("GroupMembersDrawer：添加成员（多选）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 当前成员：zhangsan
    listMock.mockResolvedValue(pageOf([makeMember()]));
    assignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    listUsersMock.mockResolvedValue(
      pageOf([
        makeUser(), // zhangsan —— 已在组内
        makeUser({ id: 43, username: "lisi", displayName: "李四" }),
        makeUser({ id: 44, username: "wangwu", displayName: "王五" }),
      ]),
    );
  });

  it("打开选择器即拉候选（复用 listUsers），已在组内行置灰标「已在组内」", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    expect(
      wrapper.find('[data-testid="group-member-picker"]').exists(),
    ).toBe(true);
    expect(listUsersMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });

    const boxes = pickerBoxes(wrapper);
    expect(boxes).toHaveLength(3);
    // 已在组内 → checkbox 禁用 + 文案标记
    expect(boxes[0]!.attributes("disabled")).toBeDefined();
    expect(
      wrapper
        .findAll('[data-testid="group-member-picker-row"]')[0]!
        .text(),
    ).toContain("已在组内");
    // 非成员 → 可选
    expect(boxes[1]!.attributes("disabled")).toBeUndefined();
    expect(boxes[2]!.attributes("disabled")).toBeUndefined();
  });

  it("多选两行 → 确认调 assignGroupMembers(groupCode, usernames[]) 并 emit changed", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const boxes = pickerBoxes(wrapper);
    await boxes[1]!.setValue(true);
    await boxes[2]!.setValue(true);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("已选 2 人");

    const confirm = wrapper.find('[data-testid="group-member-picker-confirm"]');
    expect(confirm.attributes("disabled")).toBeUndefined();
    await confirm.trigger("click");
    await flushPromises();

    // 契约 §1：参数是 username 数组（不是 id）
    expect(assignMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith("rd", ["lisi", "wangwu"]);
    const sent = assignMock.mock.calls[0]![1];
    expect(Array.isArray(sent)).toBe(true);
    expect(sent.every((u) => typeof u === "string")).toBe(true);

    // 成功后关闭选择器、emit changed 并重拉成员
    expect(wrapper.find('[data-testid="group-member-picker"]').exists()).toBe(
      false,
    );
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("取消勾选后不提交该用户（多选可反选）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const boxes = pickerBoxes(wrapper);
    await boxes[1]!.setValue(true);
    await boxes[2]!.setValue(true);
    await boxes[1]!.setValue(false);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain("已选 1 人");
    await wrapper
      .find('[data-testid="group-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();
    expect(assignMock).toHaveBeenCalledWith("rd", ["wangwu"]);
  });

  it("一个都没选 → 确认禁用且不调 api", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    expect(
      wrapper
        .find('[data-testid="group-member-picker-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();
    await wrapper
      .find('[data-testid="group-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("仅已在组内的用户被勾选也无法提交（置灰行不进入 usernames）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);
    const boxes = pickerBoxes(wrapper);
    // disabled 的复选框 setValue 不改变状态
    await boxes[0]!.setValue(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("已选 1 人");
    expect(
      wrapper
        .find('[data-testid="group-member-picker-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();
    await wrapper
      .find('[data-testid="group-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("选择器搜索走 listUsers 的 keyword（候选服务端搜索）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const box = wrapper.find('[data-testid="group-member-picker-search"]');
    await box.setValue("  李  ");
    await box.trigger("keyup.enter");
    await flushPromises();

    expect(listUsersMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      keyword: "李",
    });
  });

  it("添加被拒 → 选择器内原样展示服务端 msg，不关闭、不 emit changed", async () => {
    assignMock.mockRejectedValueOnce(
      new ApiError("unknown", "用户组不存在或已被删除", { code: 4010806 }),
    );
    const wrapper = await mountDrawer();
    await openPicker(wrapper);
    await pickerBoxes(wrapper)[1]!.setValue(true);
    await wrapper
      .find('[data-testid="group-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="group-member-picker-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("用户组不存在或已被删除");
    expect(wrapper.find('[data-testid="group-member-picker"]').exists()).toBe(
      true,
    );
    expect(wrapper.emitted("changed")).toBeUndefined();
  });

  it("无 iam:group:assign_members → 不渲染「添加成员」入口", async () => {
    const wrapper = await mountDrawer(GROUP, [
      IAM_GROUP.MEMBERS,
      IAM_GROUP.REMOVE_MEMBERS,
    ]);
    expect(wrapper.find('[data-testid="group-member-add"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="group-member-picker"]').exists()).toBe(
      false,
    );
  });
});

describe("GroupMembersDrawer：移除成员", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue(pageOf([makeMember()]));
    assignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
    listUsersMock.mockResolvedValue(pageOf([]));
  });

  it("点「移除」只打开二次确认，不发请求；确认后调 api（username 数组）并 emit changed", async () => {
    const wrapper = await mountDrawer();

    await wrapper.find('[data-testid="group-member-remove"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="group-member-remove-confirm"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-testid="group-member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    // 契约 §1：移除载荷是 username 数组（不是 id）
    expect(removeMock).toHaveBeenCalledWith("rd", ["zhangsan"]);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    // 成功后重拉当前页
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("被拒时原样展示服务端 msg，且不 emit changed / 弹窗保持打开", async () => {
    removeMock.mockRejectedValueOnce(
      new ApiError("unknown", "该用户不在用户组内", { code: 4010807 }),
    );
    const wrapper = await mountDrawer();

    await wrapper.find('[data-testid="group-member-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="group-member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="group-member-remove-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("该用户不在用户组内");
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(
      wrapper.find('[data-testid="group-member-remove-confirm"]').exists(),
    ).toBe(true);
  });

  it("取消二次确认 → 不调 api、弹窗关闭", async () => {
    const wrapper = await mountDrawer();
    await wrapper.find('[data-testid="group-member-remove"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper
      .findAll('[data-testid="group-member-remove-dialog"] button')
      .find((b) => b.text() === "取消")!
      .trigger("click");
    await flushPromises();

    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="group-member-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("无 iam:group:remove_members → 不渲染「移除」按钮", async () => {
    const wrapper = await mountDrawer(GROUP, [
      IAM_GROUP.MEMBERS,
      IAM_GROUP.ASSIGN_MEMBERS,
    ]);
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(1);
    expect(
      wrapper.findAll('[data-testid="group-member-remove"]'),
    ).toHaveLength(0);
  });
});

describe("GroupMembersDrawer：空态 / 错误态", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
  });

  it("空成员 → 「该用户组暂无成员」+ 添加提示", async () => {
    listMock.mockResolvedValue(pageOf([], 0));
    const wrapper = await mountDrawer();

    const empty = wrapper.find('[data-testid="group-member-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("该用户组暂无成员");
    expect(empty.text()).toContain("添加成员");
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(0);
    // 无成员 → 不渲染分页
    expect(
      wrapper.find('[data-testid="group-member-pagination"]').exists(),
    ).toBe(false);
  });

  it("加载失败 → 展示服务端 msg + 重试可恢复", async () => {
    listMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountDrawer();

    const error = wrapper.find('[data-testid="group-member-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");

    listMock.mockResolvedValue(pageOf([makeMember()]));
    await wrapper
      .findAll("button")
      .find((b) => b.text().replace(/\s+/g, "") === "重试")!
      .trigger("click");
    await flushPromises();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('[data-testid="group-member-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="group-member-error"]').exists()).toBe(
      false,
    );
  });
});
