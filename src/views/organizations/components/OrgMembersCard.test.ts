// @vitest-environment happy-dom
/**
 * OrgMembersCard 成员增删行为测试（feat-dept-members-mutation 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层全 mock，**不触真实网络、不创建真实部门、不改真实用户部门归属**）：
 * - 权限裁剪：无 `ASSIGN` 不渲染「添加成员」，无 `REMOVE` 不渲染行内「移除」；
 * - 未选部门：添加按钮渲染但**禁用**；
 * - 既有 testid 未被破坏（`members-search` / 成员表 / 分页仍在）；
 * - 添加：打开选择器即 listUsers 拉候选 → 已在部门候选置灰标「已在部门」→ 多选 → 确认调
 *   `assignOrganizationMembers(deptId, ids[])`（**断言是数字 id 数组，不是 username**）→
 *   关闭选择器 + 回第 1 页重拉成员；
 * - 移除：行内「移除」只开二次确认（不发请求）→ 确认调 `removeOrganizationMembers(deptId, [id])`
 *   → 回第 1 页重拉；取消不发请求；
 * - 被拒：分配 / 移除各自原位展示服务端 msg 原文（不改写），且不重拉、不关闭；
 * - 提交中：确认按钮禁用（防重复提交）。
 *
 * 手法：与上一轮 `GroupMembersDrawer.test.ts` 同款 —— mock `@/api/organizations` 与
 * `@/api/users`，真实 orgList store + user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import OrgMembersCard from "./OrgMembersCard.vue";
import { useOrgListStore } from "@/stores/orgList";
import { useUserStore } from "@/stores/user";
import { IAM_DEPARTMENT } from "@/config/permission-codes";
import { ApiError, type Page, type User } from "@/api/types";
import type { DeptMember } from "@/api/organizations";
import {
  assignOrganizationMembers,
  listOrganizationMembers,
  removeOrganizationMembers,
} from "@/api/organizations";
import { listUsers } from "@/api/users";

vi.mock("@/api/organizations", () => ({
  listOrganizationTree: vi.fn(async () => []),
  getOrganizationDetail: vi.fn(async (id: number) => ({ id, name: "研发部" })),
  listOrganizationMembers: vi.fn(),
  assignOrganizationMembers: vi.fn(),
  removeOrganizationMembers: vi.fn(),
  createOrganization: vi.fn(async () => 1),
  updateOrganization: vi.fn(async () => undefined),
  deleteOrganization: vi.fn(async () => undefined),
}));

vi.mock("@/api/users", () => ({
  listUsers: vi.fn(),
}));

const listMock = vi.mocked(listOrganizationMembers);
const assignMock = vi.mocked(assignOrganizationMembers);
const removeMock = vi.mocked(removeOrganizationMembers);
const listUsersMock = vi.mocked(listUsers);

const DEPT_ID = 7;

function makeMember(overrides: Partial<DeptMember> = {}): DeptMember {
  return {
    id: 9,
    username: "alice",
    displayName: "Alice",
    email: "a@example.com",
    phone: "13800000000",
    ...overrides,
  };
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 9,
    username: "alice",
    displayName: "Alice",
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

interface MountOptions {
  permissions?: string[];
  /** undefined = 已选中部门；null = 未选部门 */
  deptId?: number | null;
  members?: DeptMember[];
  total?: number;
}

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

async function mountCard(options: MountOptions = {}) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions =
    options.permissions ?? [
      IAM_DEPARTMENT.MEMBERS,
      IAM_DEPARTMENT.ASSIGN,
      IAM_DEPARTMENT.REMOVE,
    ];

  const store = useOrgListStore();
  const members = options.members ?? [makeMember()];
  store.selectedId = options.deptId === undefined ? DEPT_ID : options.deptId;
  store.detail = { id: DEPT_ID, name: "研发部" };
  store.members = members;
  store.membersTotal = options.total ?? members.length;

  const wrapper = mount(OrgMembersCard);
  await flushPromises();
  return { wrapper, store };
}

/** 打开添加成员选择器（等待候选加载完成） */
async function openPicker(
  wrapper: Awaited<ReturnType<typeof mountCard>>["wrapper"],
): Promise<void> {
  await wrapper.find('[data-testid="dept-member-add"]').trigger("click");
  await flushPromises();
}

/** 选择器内所有候选行的复选框 */
function pickerBoxes(wrapper: Awaited<ReturnType<typeof mountCard>>["wrapper"]) {
  return wrapper.findAll(
    '[data-testid="dept-member-picker-row"] input[type="checkbox"]',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(pageOf([makeMember()]));
  assignMock.mockResolvedValue(undefined);
  removeMock.mockResolvedValue(undefined);
  listUsersMock.mockResolvedValue(pageOf([]));
});

describe("OrgMembersCard：权限裁剪与既有交互回归", () => {
  it("无 ASSIGN → 不渲染「添加成员」；无 REMOVE → 不渲染行内「移除」", async () => {
    const { wrapper } = await mountCard({
      permissions: [IAM_DEPARTMENT.MEMBERS],
    });

    expect(wrapper.find('[data-testid="dept-member-add"]').exists()).toBe(
      false,
    );
    expect(wrapper.findAll('[data-testid="dept-member-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="dept-member-remove"]')).toHaveLength(
      0,
    );
  });

  it("有 ASSIGN/REMOVE 时两个入口都渲染", async () => {
    const { wrapper } = await mountCard();
    expect(wrapper.find('[data-testid="dept-member-add"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="dept-member-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="dept-member-remove"]')).toHaveLength(
      1,
    );
  });

  it("未选部门 → 添加按钮渲染但禁用（不可打开选择器）", async () => {
    const { wrapper } = await mountCard({ deptId: null });
    const add = wrapper.find('[data-testid="dept-member-add"]');
    expect(add.exists()).toBe(true);
    expect(add.attributes("disabled")).toBeDefined();

    await add.trigger("click");
    await flushPromises();
    expect(
      wrapper.find('[data-testid="dept-member-picker"]').exists(),
      "禁用态点击不应打开选择器",
    ).toBe(false);
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it("选中部门后添加按钮可用", async () => {
    const { wrapper } = await mountCard();
    expect(
      wrapper.find('[data-testid="dept-member-add"]').attributes("disabled"),
    ).toBeUndefined();
  });

  it("既有 testid / 交互保持不变：members-search、成员表、分页仍在", async () => {
    const { wrapper } = await mountCard({ total: 45 });
    expect(wrapper.find('[data-testid="members-search"]').exists()).toBe(true);
    expect(wrapper.find(".data-table").exists()).toBe(true);
    expect(
      wrapper.find('[data-testid="dept-member-row"]').attributes,
      "成员行应带 dept-member-row",
    ).toBeTruthy();
    expect(wrapper.text()).toContain("alice");
    expect(wrapper.text()).toContain("共 45 人");
    expect(wrapper.find(".pagination").exists()).toBe(true);
  });
});

describe("OrgMembersCard：添加成员（多选）", () => {
  beforeEach(() => {
    listUsersMock.mockResolvedValue(
      pageOf([
        makeUser(), // alice —— 已在部门
        makeUser({ id: 43, username: "bob", displayName: "Bob" }),
        makeUser({ id: 44, username: "carol", displayName: "Carol" }),
      ]),
    );
  });

  it("打开即拉候选（复用 listUsers），已在部门的候选置灰并标「已在部门」", async () => {
    const { wrapper } = await mountCard();
    await openPicker(wrapper);

    expect(wrapper.find('[data-testid="dept-member-picker"]').exists()).toBe(
      true,
    );
    expect(listUsersMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });

    const boxes = pickerBoxes(wrapper);
    expect(boxes).toHaveLength(3);
    // 已在部门 → checkbox 禁用 + 文案标记
    expect(boxes[0]!.attributes("disabled")).toBeDefined();
    expect(
      wrapper.findAll('[data-testid="dept-member-picker-row"]')[0]!.text(),
    ).toContain("已在部门");
    // 未在部门 → 可选
    expect(boxes[1]!.attributes("disabled")).toBeUndefined();
    expect(boxes[2]!.attributes("disabled")).toBeUndefined();
  });

  it("多选两行 → 确认调 assignOrganizationMembers(deptId, ids[])，关闭选择器并回第 1 页重拉", async () => {
    const { wrapper, store } = await mountCard();
    // 先停在第 2 页，验证成功后回到第 1 页
    store.membersPage = 2;
    await openPicker(wrapper);

    const boxes = pickerBoxes(wrapper);
    await boxes[1]!.setValue(true);
    await boxes[2]!.setValue(true);
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain("已选 2 人");

    const confirm = wrapper.find('[data-testid="dept-member-picker-confirm"]');
    expect(confirm.attributes("disabled")).toBeUndefined();
    await confirm.trigger("click");
    await flushPromises();

    // 契约 §1：传数字 id 数组（不是 username）
    expect(assignMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith(DEPT_ID, [43, 44]);
    const ids = assignMock.mock.calls[0]![1];
    expect(Array.isArray(ids)).toBe(true);
    expect(ids.every((id) => typeof id === "number")).toBe(true);

    // 成功后关闭选择器、重拉当前部门第 1 页成员
    expect(wrapper.find('[data-testid="dept-member-picker"]').exists()).toBe(
      false,
    );
    expect(store.membersPage).toBe(1);
    expect(listMock).toHaveBeenLastCalledWith(DEPT_ID, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("一个都没选 → 确认禁用且不调 api", async () => {
    const { wrapper } = await mountCard();
    await openPicker(wrapper);

    const confirm = wrapper.find('[data-testid="dept-member-picker-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();
    await confirm.trigger("click");
    await flushPromises();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("仅勾选「已在部门」的行无效，不进入提交数组", async () => {
    const { wrapper } = await mountCard();
    await openPicker(wrapper);

    const boxes = pickerBoxes(wrapper);
    // disabled 的复选框 setValue 不改变状态
    await boxes[0]!.setValue(true);
    await wrapper.vm.$nextTick();

    expect(wrapper.text()).not.toContain("已选 1 人");
    await wrapper
      .find('[data-testid="dept-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("选择器搜索走 listUsers 的 keyword（候选服务端搜索，非本页假筛选）", async () => {
    const { wrapper } = await mountCard();
    await openPicker(wrapper);

    const box = wrapper.find('[data-testid="dept-member-picker-search"]');
    await box.setValue("  bob  ");
    await box.trigger("keyup.enter");
    await flushPromises();

    expect(listUsersMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      keyword: "bob",
    });
  });

  it("提交中确认按钮禁用（防重复提交）", async () => {
    let resolveAssign!: () => void;
    assignMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAssign = resolve;
        }),
    );
    const { wrapper } = await mountCard();
    await openPicker(wrapper);
    await pickerBoxes(wrapper)[1]!.setValue(true);

    await wrapper
      .find('[data-testid="dept-member-picker-confirm"]')
      .trigger("click");
    await wrapper.vm.$nextTick();

    const confirm = wrapper.find('[data-testid="dept-member-picker-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();
    expect(confirm.text()).toContain("添加中");

    resolveAssign();
    await flushPromises();
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("添加被拒 → 选择器内原样展示服务端 msg，不关闭、不重拉", async () => {
    assignMock.mockRejectedValueOnce(
      new ApiError("unknown", "用户已在部门内", { code: 4010701 }),
    );
    const { wrapper } = await mountCard();
    await openPicker(wrapper);
    await pickerBoxes(wrapper)[1]!.setValue(true);

    await wrapper
      .find('[data-testid="dept-member-picker-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="dept-member-picker-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("用户已在部门内");
    expect(wrapper.find('[data-testid="dept-member-picker"]').exists()).toBe(
      true,
    );
    expect(listMock).not.toHaveBeenCalled();
  });

  it("取消选择器 → 不调 api、弹层关闭", async () => {
    const { wrapper } = await mountCard();
    await openPicker(wrapper);
    await pickerBoxes(wrapper)[1]!.setValue(true);

    await wrapper
      .find('[data-testid="dept-member-picker-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(assignMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="dept-member-picker"]').exists()).toBe(
      false,
    );
  });
});

describe("OrgMembersCard：移除成员（二次确认）", () => {
  it("点行内「移除」只打开二次确认，不发请求", async () => {
    const { wrapper } = await mountCard();
    await wrapper.find('[data-testid="dept-member-remove"]').trigger("click");
    await wrapper.vm.$nextTick();

    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="dept-member-remove-confirm"]').exists(),
    ).toBe(true);
    expect(wrapper.text()).toContain("alice");
  });

  it("确认后调 removeOrganizationMembers(deptId, [id]) 并回第 1 页重拉", async () => {
    const { wrapper, store } = await mountCard();
    store.membersPage = 3;

    await wrapper.find('[data-testid="dept-member-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="dept-member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    // 契约 §1：数字 id 数组
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith(DEPT_ID, [9]);
    expect(
      (removeMock.mock.calls[0]![1] as unknown[]).every(
        (id) => typeof id === "number",
      ),
    ).toBe(true);

    expect(store.membersPage).toBe(1);
    expect(listMock).toHaveBeenLastCalledWith(DEPT_ID, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    // 成功后弹窗关闭
    expect(
      wrapper.find('[data-testid="dept-member-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("取消二次确认 → 不调 api、弹窗关闭", async () => {
    const { wrapper } = await mountCard();
    await wrapper.find('[data-testid="dept-member-remove"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper
      .findAll('[data-testid="dept-member-remove-dialog"] button')
      .find((b) => b.text() === "取消")!
      .trigger("click");
    await flushPromises();

    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="dept-member-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("移除被拒 → 弹窗内原样展示服务端 msg，弹窗保持、不重拉", async () => {
    removeMock.mockRejectedValueOnce(
      new ApiError("unknown", "用户不在该部门", { code: 4010702 }),
    );
    const { wrapper } = await mountCard();

    await wrapper.find('[data-testid="dept-member-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="dept-member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="dept-member-remove-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("用户不在该部门");
    expect(
      wrapper.find('[data-testid="dept-member-remove-confirm"]').exists(),
    ).toBe(true);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("移除提交中确认按钮禁用（防重复提交）", async () => {
    let resolveRemove!: () => void;
    removeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    const { wrapper } = await mountCard();

    await wrapper.find('[data-testid="dept-member-remove"]').trigger("click");
    const confirm = wrapper.find('[data-testid="dept-member-remove-confirm"]');
    await confirm.trigger("click");
    await wrapper.vm.$nextTick();

    expect(
      wrapper
        .find('[data-testid="dept-member-remove-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();
    expect(
      wrapper.find('[data-testid="dept-member-remove-confirm"]').text(),
    ).toContain("移除中");

    resolveRemove();
    await flushPromises();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

// 成员列表按 IAM_DEPARTMENT.MEMBERS 裁剪（feat-dept-members-gate）：
// 该能力码此前在 console 侧零使用 —— /department/members 由服务端强制校验，
// 缺码时卡片照常渲染只会得到 403 + "加载失败"的成员区。
describe("OrgMembersCard：成员列表按 IAM_DEPARTMENT.MEMBERS 裁剪", () => {
  it("缺 MEMBERS 码 → 整个成员卡片不渲染（即使有 ASSIGN/REMOVE）", async () => {
    const { wrapper } = await mountCard({
      permissions: [IAM_DEPARTMENT.ASSIGN, IAM_DEPARTMENT.REMOVE],
    });

    expect(wrapper.find(".card").exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="dept-member-row"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain("成员列表");
  });

  it("有 MEMBERS 码 → 正常渲染成员行", async () => {
    const { wrapper } = await mountCard({
      permissions: [IAM_DEPARTMENT.MEMBERS],
    });

    expect(wrapper.find(".card").exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="dept-member-row"]')).toHaveLength(1);
  });
});
