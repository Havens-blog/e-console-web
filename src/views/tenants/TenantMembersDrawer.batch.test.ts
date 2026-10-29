// @vitest-environment happy-dom
/**
 * TenantMembersDrawer「批量加入 / 批量移除」行为测试
 * （feat-tenant-members-batch 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层全 mock，**不触真实网络、不改动任何真实租户成员**）：
 * - 选择器**多选**：行点击 / 复选框都能切换选中态，显示「已选 N 人」，0 选中确认禁用；
 * - 选中 ≥2 人确认 → `batchAssignTenantMembers(tenant.id, ids)`（断言参数正确），
 *   成功关层 + 重拉 + emit('assigned') + emit('changed')；
 * - 选中恰 1 人确认 → 沿用既有 `assignTenantMember`（单条路径不回归）；
 * - 成员行复选框 `member-select` + 表头全选 `member-select-all`（仅本页）；
 * - 批量移除按钮 `member-batch-remove`：无选中禁用、显示「移除已选 N 人」，
 *   点它只打开二次确认（不发请求）；
 * - 确认 → `batchUnassignTenantMembers`；成功清空选中 + 重拉 + emit('changed')；
 * - 取消 → 不发任何请求、选中保留；
 * - 被拒 → `member-batch-remove-error` 展示服务端 msg **原文**，弹窗保持、选中不清空；
 * - 提交中确认按钮禁用；
 * - 无 `iam:tenant:batch_unassign` → 不渲染多选列与批量按钮（单条「移除」仍按
 *   `iam:tenant:unassign` 渲染）；单条移除路径不回归。
 *
 * 手法与 TenantMembersDrawer.assign.test.ts 一致：mock api 模块；真实 user store
 * （pinia）注入权限码；真实 member-picker* 交互。
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
import {
  assignTenantMember,
  batchAssignTenantMembers,
  batchUnassignTenantMembers,
  listTenantMembers,
  removeTenantMember,
} from "@/api/tenantMembers";
import { listUsers } from "@/api/users";

vi.mock("@/api/tenantMembers", () => ({
  listTenantMembers: vi.fn(),
  removeTenantMember: vi.fn(),
  assignTenantMember: vi.fn(),
  batchAssignTenantMembers: vi.fn(),
  batchUnassignTenantMembers: vi.fn(),
}));

vi.mock("@/api/users", () => ({
  listUsers: vi.fn(),
}));

const listMembersMock = vi.mocked(listTenantMembers);
const removeMock = vi.mocked(removeTenantMember);
const assignMock = vi.mocked(assignTenantMember);
const batchAssignMock = vi.mocked(batchAssignTenantMembers);
const batchUnassignMock = vi.mocked(batchUnassignTenantMembers);
const listUsersMock = vi.mocked(listUsers);

const TENANT = { id: 7, name: "甲租户" };

/** 当前页成员：id 42 / 43 */
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

const MEMBERS: TenantMember[] = [
  makeMember(),
  makeMember({ id: 43, username: "lisi", nickname: "李四" }),
];

/** 候选用户：42 已是成员；65 / 66 不是 */
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

type DrawerWrapper = ReturnType<typeof mount>;

async function mountDrawer(
  tenant: { id: number; name: string } | null = TENANT,
  permissions: string[] = [
    IAM_TENANT.UNASSIGN,
    IAM_TENANT.ASSIGN,
    IAM_TENANT.BATCH_UNASSIGN,
  ],
): Promise<DrawerWrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(TenantMembersDrawer, { props: { tenant } });
  await flushPromises();
  return wrapper;
}

/** 打开「添加成员」选择器并等候选渲染完成 */
async function openPicker(wrapper: DrawerWrapper): Promise<void> {
  await wrapper.find('[data-testid="member-add"]').trigger("click");
  await flushPromises();
}

function pickerRows(wrapper: DrawerWrapper) {
  return wrapper.findAll('[data-testid="member-picker-row"]');
}

function pickerChecks(wrapper: DrawerWrapper) {
  return wrapper.findAll('[data-testid="member-picker-check"]');
}

function memberChecks(wrapper: DrawerWrapper) {
  return wrapper.findAll('[data-testid="member-select"]');
}

/** 成员行复选框是否勾选（读 DOM 真值，用于断言「选中不清空」） */
function memberChecked(wrapper: DrawerWrapper, index: number): boolean {
  return (memberChecks(wrapper)[index]!.element as HTMLInputElement).checked;
}

function confirmButton(wrapper: DrawerWrapper) {
  return wrapper.find('[data-testid="member-picker-confirm"]');
}

function batchRemoveButton(wrapper: DrawerWrapper) {
  return wrapper.find('[data-testid="member-batch-remove"]');
}

/** 元素是否处于禁用态（含 :disabled 属性） */
function isDisabled(el: {
  attributes: (name: string) => string | undefined;
}): boolean {
  return el.attributes("disabled") !== undefined;
}

describe("TenantMembersDrawer：选择器多选（加入）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersMock.mockResolvedValue({ total: 2, items: MEMBERS });
    listUsersMock.mockResolvedValue({ total: 3, items: CANDIDATES });
    assignMock.mockResolvedValue(undefined);
    batchAssignMock.mockResolvedValue(undefined);
    batchUnassignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
  });

  it("多选 ≥2 人 → 确认调 batchAssignTenantMembers(租户id, ids[]) 并 emit changed", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await pickerRows(wrapper)[2]!.trigger("click");
    await flushPromises();

    await confirmButton(wrapper).trigger("click");
    await flushPromises();

    expect(batchAssignMock).toHaveBeenCalledTimes(1);
    expect(batchAssignMock).toHaveBeenCalledWith(7, [65, 66]);
    // 批量路径不再走单条 api
    expect(assignMock).not.toHaveBeenCalled();
    // 契约 §2.2：成功 emit('changed')（另发既有 assigned 供父级刷新用量）
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.emitted("assigned")).toHaveLength(1);
    // 选择器关闭 + 成员列表重拉（初次 + 成功后各一次）
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);
    expect(listMembersMock).toHaveBeenCalledTimes(2);
  });

  it("已选计数：勾选后显示「已选 N 人」，取消勾选归 0", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    // 计数只在选择器内（抽屉里另有「移除已选 N 人」批量按钮，不参与本断言）
    const pickerText = (): string =>
      wrapper.find('[data-testid="member-picker"]').text();

    expect(pickerText()).not.toContain("已选");

    await pickerRows(wrapper)[1]!.trigger("click");
    await flushPromises();
    expect(pickerText()).toContain("已选 1 人");

    await pickerRows(wrapper)[2]!.trigger("click");
    await flushPromises();
    expect(pickerText()).toContain("已选 2 人");

    // 再点一次同一行 → 取消勾选
    await pickerRows(wrapper)[2]!.trigger("click");
    await flushPromises();
    expect(pickerText()).toContain("已选 1 人");
  });

  it("0 选中 → 确认按钮禁用；勾选后可用", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    expect(isDisabled(confirmButton(wrapper))).toBe(true);

    await pickerRows(wrapper)[1]!.trigger("click");
    await flushPromises();
    expect(isDisabled(confirmButton(wrapper))).toBe(false);

    // 取消勾选 → 回到 0 选中，确认重新禁用
    await pickerRows(wrapper)[1]!.trigger("click");
    await flushPromises();
    expect(isDisabled(confirmButton(wrapper))).toBe(true);
  });

  it("已在租户的候选：复选框 disabled、点击不选中、确认保持禁用", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    const checks = pickerChecks(wrapper);
    expect(checks[0]!.attributes("disabled")).toBeDefined();
    expect(checks[1]!.attributes("disabled")).toBeUndefined();

    await pickerRows(wrapper)[0]!.trigger("click");
    await flushPromises();

    expect(pickerRows(wrapper)[0]!.classes()).not.toContain("is-selected");
    expect(isDisabled(confirmButton(wrapper))).toBe(true);
  });

  it("候选复选框可直接切换选中态（与行点击等价）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerChecks(wrapper)[1]!.setValue(true);
    await flushPromises();

    expect(pickerRows(wrapper)[1]!.classes()).toContain("is-selected");
    expect(wrapper.find('[data-testid="member-picker"]').text()).toContain(
      "已选 1 人",
    );

    await pickerChecks(wrapper)[1]!.setValue(false);
    await flushPromises();
    expect(pickerRows(wrapper)[1]!.classes()).not.toContain("is-selected");
  });

  it("选中恰 1 人 → 仍走既有单条 assignTenantMember（单条路径不回归）", async () => {
    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await confirmButton(wrapper).trigger("click");
    await flushPromises();

    expect(assignMock).toHaveBeenCalledWith(7, 65);
    expect(batchAssignMock).not.toHaveBeenCalled();
    // 单条路径语义不变：不发 changed
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.emitted("assigned")).toHaveLength(1);
  });

  it("批量加入被拒 → 展示服务端 msg 原文、选择器保持打开、不 emit changed", async () => {
    const MSG = "该用户已在此租户空间中，无需重复添加";
    batchAssignMock.mockRejectedValueOnce(
      new ApiError("unknown", MSG, { code: 4020904 }),
    );

    const wrapper = await mountDrawer();
    await openPicker(wrapper);

    await pickerRows(wrapper)[1]!.trigger("click");
    await pickerRows(wrapper)[2]!.trigger("click");
    await confirmButton(wrapper).trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="member-picker-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toBe(MSG);
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(true);
    // 未重拉成员（仅初次 1 次）
    expect(listMembersMock).toHaveBeenCalledTimes(1);
  });

  it("选择器提交中 → 确认按钮禁用", async () => {
    let release: () => void = () => {};
    batchAssignMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const wrapper = await mountDrawer();
    await openPicker(wrapper);
    await pickerRows(wrapper)[1]!.trigger("click");
    await pickerRows(wrapper)[2]!.trigger("click");
    await confirmButton(wrapper).trigger("click");
    await wrapper.vm.$nextTick();

    expect(isDisabled(confirmButton(wrapper))).toBe(true);

    release();
    await flushPromises();
    expect(wrapper.find('[data-testid="member-picker"]').exists()).toBe(false);
  });
});

describe("TenantMembersDrawer：成员多选 + 批量移除", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersMock.mockResolvedValue({ total: 2, items: MEMBERS });
    listUsersMock.mockResolvedValue({ total: 3, items: CANDIDATES });
    assignMock.mockResolvedValue(undefined);
    batchAssignMock.mockResolvedValue(undefined);
    batchUnassignMock.mockResolvedValue(undefined);
    removeMock.mockResolvedValue(undefined);
  });

  it("成员行复选框 + 表头全选（仅本页）驱动「移除已选 N 人」", async () => {
    const wrapper = await mountDrawer();

    expect(memberChecks(wrapper)).toHaveLength(2);
    expect(batchRemoveButton(wrapper).exists()).toBe(true);
    // 无选中 → 禁用
    expect(isDisabled(batchRemoveButton(wrapper))).toBe(true);
    expect(
      batchRemoveButton(wrapper).text().replace(/\s+/g, ""),
    ).toContain("移除已选0人");

    // 单行勾选
    await memberChecks(wrapper)[0]!.setValue(true);
    await flushPromises();
    expect(
      batchRemoveButton(wrapper).text().replace(/\s+/g, ""),
    ).toContain("移除已选1人");
    expect(isDisabled(batchRemoveButton(wrapper))).toBe(false);

    // 表头全选 → 本页两行都选中
    await wrapper.find('[data-testid="member-select-all"]').setValue(true);
    await flushPromises();
    expect(memberChecked(wrapper, 0)).toBe(true);
    expect(memberChecked(wrapper, 1)).toBe(true);
    expect(
      batchRemoveButton(wrapper).text().replace(/\s+/g, ""),
    ).toContain("移除已选2人");

    // 取消全选 → 清空
    await wrapper.find('[data-testid="member-select-all"]').setValue(false);
    await flushPromises();
    expect(memberChecked(wrapper, 0)).toBe(false);
    expect(isDisabled(batchRemoveButton(wrapper))).toBe(true);
  });

  it("点「移除已选 N 人」只打开二次确认，不发请求；确认后才调批量 api", async () => {
    const wrapper = await mountDrawer();

    await memberChecks(wrapper)[0]!.setValue(true);
    await memberChecks(wrapper)[1]!.setValue(true);
    await flushPromises();

    await batchRemoveButton(wrapper).trigger("click");
    await flushPromises();

    expect(batchUnassignMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="member-batch-remove-confirm"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-testid="member-batch-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(batchUnassignMock).toHaveBeenCalledTimes(1);
    expect(batchUnassignMock).toHaveBeenCalledWith(7, [42, 43]);
    // 成功：清空选中 + 重拉 + emit changed（另发既有 removed 供父级刷新用量）
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.emitted("removed")).toHaveLength(1);
    expect(listMembersMock).toHaveBeenCalledTimes(2);
    expect(
      wrapper.find('[data-testid="member-batch-remove-dialog"]').exists(),
    ).toBe(false);
    expect(isDisabled(batchRemoveButton(wrapper))).toBe(true);
  });

  it("取消 → 关闭弹窗、不发请求、选中保留", async () => {
    const wrapper = await mountDrawer();

    await memberChecks(wrapper)[0]!.setValue(true);
    await flushPromises();
    await batchRemoveButton(wrapper).trigger("click");
    await wrapper
      .find('[data-testid="member-batch-remove-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(batchUnassignMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="member-batch-remove-dialog"]').exists(),
    ).toBe(false);
    expect(memberChecked(wrapper, 0)).toBe(true);
    expect(
      batchRemoveButton(wrapper).text().replace(/\s+/g, ""),
    ).toContain("移除已选1人");
  });

  it("被拒 → 原文展示、弹窗保持、选中不清空、不 emit changed", async () => {
    const MSG = "禁止将系统初始超级管理员从系统根管理空间中移除";
    batchUnassignMock.mockRejectedValueOnce(
      new ApiError("unknown", MSG, { code: 4020909 }),
    );

    const wrapper = await mountDrawer();
    await memberChecks(wrapper)[0]!.setValue(true);
    await memberChecks(wrapper)[1]!.setValue(true);
    await flushPromises();
    await batchRemoveButton(wrapper).trigger("click");
    await wrapper
      .find('[data-testid="member-batch-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="member-batch-remove-error"]');
    expect(error.exists()).toBe(true);
    // 原文展示：不套通用文案、不截断
    expect(error.text()).toBe(MSG);
    // 弹窗保持、选中不清空（不谎报成功）
    expect(
      wrapper.find('[data-testid="member-batch-remove-dialog"]').exists(),
    ).toBe(true);
    expect(memberChecked(wrapper, 0)).toBe(true);
    expect(memberChecked(wrapper, 1)).toBe(true);
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.emitted("removed")).toBeUndefined();
    // 未重拉（仅初次 1 次）
    expect(listMembersMock).toHaveBeenCalledTimes(1);
  });

  it("批量移除提交中 → 确认按钮禁用", async () => {
    let release: () => void = () => {};
    batchUnassignMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const wrapper = await mountDrawer();
    await memberChecks(wrapper)[0]!.setValue(true);
    await flushPromises();
    await batchRemoveButton(wrapper).trigger("click");
    await wrapper
      .find('[data-testid="member-batch-remove-confirm"]')
      .trigger("click");
    await wrapper.vm.$nextTick();

    expect(
      isDisabled(wrapper.find('[data-testid="member-batch-remove-confirm"]')),
    ).toBe(true);

    release();
    await flushPromises();
    expect(
      wrapper.find('[data-testid="member-batch-remove-dialog"]').exists(),
    ).toBe(false);
  });

  it("无 iam:tenant:batch_unassign → 不渲染多选列与批量按钮（单条「移除」仍在）", async () => {
    const wrapper = await mountDrawer(TENANT, [IAM_TENANT.UNASSIGN]);

    expect(batchRemoveButton(wrapper).exists()).toBe(false);
    expect(memberChecks(wrapper)).toHaveLength(0);
    expect(wrapper.find('[data-testid="member-select-all"]').exists()).toBe(
      false,
    );
    // 既有单条「移除」不受影响
    expect(wrapper.findAll('[data-testid="member-remove"]')).toHaveLength(2);
  });

  it("单条移除路径不回归：仍调 removeTenantMember 并 emit removed", async () => {
    const wrapper = await mountDrawer();

    await wrapper.find('[data-testid="member-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="member-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).toHaveBeenCalledWith(7, 42);
    expect(batchUnassignMock).not.toHaveBeenCalled();
    expect(wrapper.emitted("removed")).toHaveLength(1);
    expect(wrapper.emitted("changed")).toBeUndefined();
  });
});
