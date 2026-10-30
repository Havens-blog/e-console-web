// @vitest-environment happy-dom
/**
 * InvitationList 页测试（feat-invitation-management 契约 §2.2 / §3 +
 * feat-invitation-complete 契约 §2.2 / §3）。
 *
 * 覆盖：
 * - 邀请列表：行渲染（邀请码 / 租户 / 角色 / 用量 used/max / 需审批）、过期时间经
 *   formatEpochMs（Unix 毫秒 + 年份护栏）、空态「暂无邀请」、错误态 + 重试
 * - 分页：20·50·100、上一页禁用态、页大小切换回第 1 页、下一页 offset 推进
 * - 创建：默认值（1 / 7 / 未勾选）、max_uses ≥1 整数校验、expiry 1–365 校验、
 *   合法载荷（roleCodes 空数组）、成功后关弹窗并重拉、被拒原文、提交中禁用
 * - 撤回：行内按钮 → 二次确认（未确认不发请求）→ DELETE 调用 → 重拉、被拒原文、取消、
 *   撤回中禁用
 * - 页签切换：邀请列表 ↔ 加入申请（各自独立拉取）、
 *   申请处理（feat-invitation-handle-request）：有 HANDLE_REQUEST 码 → 行内「通过/拒绝」；
 *   缺码 → 行内无按钮；通过/拒绝分别调用 handleJoinRequest(id, true/false) 后重拉；
 *   被拒展示 eiam 文案原文且不谎报成功、处理中禁用该行按钮、
 *   申请空态「暂无加入申请」
 * - 权限裁剪：无 ADD 不渲染创建、无 DELETE 不渲染撤回；码级粒度
 * - 角色多选（feat-invitation-complete）：候选来自 listRolesPage 翻页拉齐（100/页、≤20 页）、
 *   每项 testid 取值为 role code、提交 role_codes 为 code 数组、空选提交 []
 * - 行多选 / 全选、批量撤回禁用态 → 二次确认 → api 调用 → 清空选中 + 重拉、被拒原文
 * - 「加入申请」页签按 VIEW_REQUESTS 显隐（缺码不渲染且不发请求）
 *
 * 手法：mock `@/api/invitations` 五函数与 `@/api/roles` 的 listRolesPage
 * （**不触网、不创建真实邀请**），pinia + user store 注入权限码；页面本身无 store 依赖
 * （列表态在组件内），因此无需 mock router。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import InvitationList from "./InvitationList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES, IAM_INVITATION } from "@/config/permission-codes";
import type { Invitation, JoinRequest } from "@/api/invitations";
import type { Page, Role } from "@/api/types";

// ---- api 层 mock（五接口；本文件不触网、不创建真实邀请）----
const listInvitationsMock = vi.fn<
  (q: { offset: number; limit: number; keyword: string }) => Promise<
    Page<Invitation>
  >
>();
const createInvitationMock = vi.fn<(p: unknown) => Promise<void>>();
const revokeInvitationMock = vi.fn<(code: string) => Promise<void>>();
const batchRevokeInvitationsMock = vi.fn<(codes: string[]) => Promise<void>>();
const listJoinRequestsMock = vi.fn<
  (q: { offset: number; limit: number; keyword: string }) => Promise<
    Page<JoinRequest>
  >
>();
const handleJoinRequestMock = vi.fn<
  (id: number, approve: boolean) => Promise<void>
>();

vi.mock("@/api/invitations", () => ({
  listInvitations: (q: { offset: number; limit: number; keyword: string }) =>
    listInvitationsMock(q),
  createInvitation: (p: unknown) => createInvitationMock(p),
  revokeInvitation: (code: string) => revokeInvitationMock(code),
  batchRevokeInvitations: (codes: string[]) =>
    batchRevokeInvitationsMock(codes),
  listJoinRequests: (q: { offset: number; limit: number; keyword: string }) =>
    listJoinRequestsMock(q),
  handleJoinRequest: (id: number, approve: boolean) =>
    handleJoinRequestMock(id, approve),
}));

// ---- 角色候选 mock（角色多选复用 api/roles，本页不重复实现角色列表）----
const listRolesPageMock = vi.fn<
  (q: { offset: number; limit: number; keyword: string }) => Promise<Page<Role>>
>();

vi.mock("@/api/roles", () => ({
  listRolesPage: (q: { offset: number; limit: number; keyword: string }) =>
    listRolesPageMock(q),
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    code: "abc123",
    tenantId: 1,
    tenantName: "系统根管理空间",
    inviterId: 1,
    roleCodes: ["viewer"],
    maxUses: 5,
    usedCount: 0,
    expireAt: 1730000000000,
    requireApproval: false,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<JoinRequest> = {}): JoinRequest {
  return {
    id: 1,
    userId: 5,
    username: "bob",
    nickname: "鲍勃",
    invitationCode: "abc123",
    roleCodes: [],
    ctime: 1730000000000,
    ...overrides,
  };
}

function makeRole(code: string, name = code): Role {
  return {
    id: code.length,
    code,
    name,
    desc: "",
    tenantId: 0,
    policies: [],
    users: [],
  };
}

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

/** 挂载页面（默认全码管理员；权限可覆盖） */
async function mountPage(codes: readonly string[] = IAM_ALL_CODES) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [...codes];
  const wrapper = mount(InvitationList);
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>;

const invRows = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="invitation-row"]');
const requestRows = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="join-request-row"]');

/** 提交创建表单：对 `<form>` 触发 submit（等价点击「创建」，并锁定按钮确为 type="submit"） */
async function submitForm(wrapper: Wrapper): Promise<void> {
  const submitBtn = wrapper.find('[data-testid="invitation-form-submit"]');
  expect(submitBtn.exists()).toBe(true);
  expect(submitBtn.attributes("type")).toBe("submit");
  const form = wrapper.find('[data-testid="invitation-form"] form');
  expect(form.exists()).toBe(true);
  await form.trigger("submit");
  await flushPromises();
}

async function openCreate(wrapper: Wrapper): Promise<void> {
  await wrapper.find('[data-testid="invitation-create"]').trigger("click");
  await flushPromises();
  expect(wrapper.find('[data-testid="invitation-form"]').exists()).toBe(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  listInvitationsMock.mockResolvedValue(pageOf([makeInvitation()]));
  listJoinRequestsMock.mockResolvedValue(pageOf([makeRequest()]));
  listRolesPageMock.mockResolvedValue(
    pageOf([makeRole("viewer", "只读"), makeRole("ops", "运维")]),
  );
  createInvitationMock.mockResolvedValue(undefined);
  revokeInvitationMock.mockResolvedValue(undefined);
  batchRevokeInvitationsMock.mockResolvedValue(undefined);
});

describe("InvitationList：邀请列表渲染", () => {
  it("行渲染邀请码 / 租户 / 角色 / 用量 / 需审批；挂载即拉列表（offset=0, limit=20）", async () => {
    listInvitationsMock.mockResolvedValue(
      pageOf([
        makeInvitation({
          code: "abc123",
          tenantName: "系统根管理空间",
          roleCodes: ["viewer", "ops"],
          usedCount: 2,
          maxUses: 5,
          requireApproval: false,
        }),
        makeInvitation({
          code: "def456",
          tenantName: "",
          roleCodes: [],
          usedCount: 0,
          maxUses: 1,
          requireApproval: true,
        }),
      ]),
    );
    const wrapper = await mountPage();
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
    expect(listInvitationsMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });

    const rows = invRows(wrapper);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("abc123");
    expect(rows[0]!.text()).toContain("系统根管理空间");
    expect(rows[0]!.text()).toContain("viewer, ops");
    expect(rows[0]!.text()).toContain("2/5");
    expect(rows[0]!.text()).toContain("否");
    // 第二行：租户缺失 → '—'；无角色 → '—'；需审批 → 是
    expect(rows[1]!.text()).toContain("def456");
    expect(rows[1]!.text()).toContain("—");
    expect(rows[1]!.text()).toContain("0/1");
    expect(rows[1]!.text()).toContain("是");
  });

  it("邀请码列等宽渲染（mono class）", async () => {
    const wrapper = await mountPage();
    // feat-invitation-complete：首列改为行多选列，邀请码列顺延为第 2 个 td
    const codeCell = invRows(wrapper)[0]!.findAll("td")[1]!;
    expect(codeCell.classes()).toContain("mono");
    expect(codeCell.text()).toBe("abc123");
  });

  it("过期时间经 formatEpochMs 渲染（Unix 毫秒 → YYYY-MM-DD HH:mm:ss，不出现荒谬年份）", async () => {
    const wrapper = await mountPage();
    const row = invRows(wrapper)[0]!;
    expect(row.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(row.text()).not.toContain("58563");
  });

  it("expireAt 缺失 → 过期时间列 '—'（不渲染 1970 / undefined）", async () => {
    listInvitationsMock.mockResolvedValue(
      pageOf([makeInvitation({ expireAt: undefined })]),
    );
    const wrapper = await mountPage();
    const row = invRows(wrapper)[0]!;
    expect(row.text()).toContain("—");
    expect(row.text()).not.toContain("1970");
  });

  it("空态：无邀请显示「暂无邀请」", async () => {
    listInvitationsMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    const empty = wrapper.find('[data-testid="invitation-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("暂无邀请");
    expect(invRows(wrapper)).toHaveLength(0);
  });

  it("错误态：展示 eiam msg + 重试按钮重查", async () => {
    listInvitationsMock.mockRejectedValueOnce(new Error("eiam 不可用"));
    const wrapper = await mountPage();
    const errorBox = wrapper.find(".state-error");
    expect(errorBox.exists()).toBe(true);
    expect(errorBox.text()).toContain("eiam 不可用");

    await errorBox.find("button").trigger("click");
    await flushPromises();
    expect(listInvitationsMock).toHaveBeenCalledTimes(2);
    expect(invRows(wrapper)).toHaveLength(1);
  });
});

describe("InvitationList：分页（20·50·100）", () => {
  it("第 1 页上一页禁用 / 页大小切换回第 1 页 / 下一页推进 offset", async () => {
    listInvitationsMock.mockResolvedValue(pageOf([makeInvitation()], 120));
    const wrapper = await mountPage();

    expect(
      wrapper.find('[data-testid="invitation-page-prev"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 6 页");
    // 页大小选项为 20 / 50 / 100
    const options = wrapper
      .find('[data-testid="invitation-page-size"]')
      .findAll("option")
      .map((o) => Number(o.attributes("value")));
    expect(options).toEqual([20, 50, 100]);

    await wrapper.find('[data-testid="invitation-page-size"]').setValue("50");
    await flushPromises();
    expect(listInvitationsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 50,
      keyword: "",
    });
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 3 页");

    await wrapper.find('[data-testid="invitation-page-next"]').trigger("click");
    await flushPromises();
    expect(listInvitationsMock).toHaveBeenLastCalledWith({
      offset: 50,
      limit: 50,
      keyword: "",
    });
  });
});

describe("InvitationList：创建（校验 / 载荷 / 重拉）", () => {
  it("打开弹窗：默认 max_uses=1 / expiry_days=7 / 未勾选需审批", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);

    const maxUses = wrapper.find('[data-testid="invitation-form-max-uses"]');
    const expiry = wrapper.find('[data-testid="invitation-form-expiry-days"]');
    const approval = wrapper.find(
      '[data-testid="invitation-form-require-approval"]',
    );
    expect((maxUses.element as HTMLInputElement).value).toBe("1");
    expect((expiry.element as HTMLInputElement).value).toBe("7");
    expect((approval.element as HTMLInputElement).checked).toBe(false);
  });

  it("max_uses = 0 → 阻止提交并就近报错", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await wrapper.find('[data-testid="invitation-form-max-uses"]').setValue("0");
    await submitForm(wrapper);

    expect(createInvitationMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="invitation-form"]').text()).toContain(
      "最大使用次数须为 ≥1 的整数",
    );
  });

  it("max_uses 非整数（1.5）→ 阻止提交", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await wrapper.find('[data-testid="invitation-form-max-uses"]').setValue("1.5");
    await submitForm(wrapper);

    expect(createInvitationMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="invitation-form"]').text()).toContain(
      "最大使用次数须为 ≥1 的整数",
    );
  });

  it("expiry_days 越界（0 / 366）→ 阻止提交并报错", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);

    await wrapper
      .find('[data-testid="invitation-form-expiry-days"]')
      .setValue("0");
    await submitForm(wrapper);
    expect(createInvitationMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="invitation-form"]').text()).toContain(
      "有效天数须为 1–365 的整数",
    );

    await wrapper
      .find('[data-testid="invitation-form-expiry-days"]')
      .setValue("366");
    await submitForm(wrapper);
    expect(createInvitationMock).not.toHaveBeenCalled();
  });

  it("合法输入 → 载荷 {maxUses, expiryDays, roleCodes: [], requireApproval}，成功后关弹窗并重拉", async () => {
    const wrapper = await mountPage();
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
    await openCreate(wrapper);

    await wrapper.find('[data-testid="invitation-form-max-uses"]').setValue("3");
    await wrapper
      .find('[data-testid="invitation-form-expiry-days"]')
      .setValue("30");
    await submitForm(wrapper);

    expect(createInvitationMock).toHaveBeenCalledWith({
      maxUses: 3,
      expiryDays: 30,
      roleCodes: [],
      requireApproval: false,
    });
    expect(wrapper.find('[data-testid="invitation-form"]').exists()).toBe(false);
    // 创建成功后重拉列表（挂载 1 次 + 创建后 1 次）
    expect(listInvitationsMock).toHaveBeenCalledTimes(2);
    expect(listInvitationsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });
  });

  it("勾选「加入需审批」→ requireApproval: true", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await wrapper
      .find('[data-testid="invitation-form-require-approval"]')
      .setValue(true);
    await submitForm(wrapper);

    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ requireApproval: true }),
    );
  });

  it("服务端拒绝 → 弹窗内原样展示 eiam msg，不关闭", async () => {
    createInvitationMock.mockRejectedValue(new Error("无权限创建邀请"));
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await submitForm(wrapper);

    const form = wrapper.find('[data-testid="invitation-form"]');
    expect(form.exists()).toBe(true);
    expect(form.find(".form-error").text()).toContain("无权限创建邀请");
    // 失败不重拉列表
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
  });

  it("提交中禁用提交按钮（防重复提交）", async () => {
    let resolveCreate: (() => void) | undefined;
    createInvitationMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCreate = () => resolve();
        }),
    );
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await wrapper.find('[data-testid="invitation-form"] form').trigger("submit");
    await flushPromises();

    const submitBtn = wrapper.find('[data-testid="invitation-form-submit"]');
    expect(submitBtn.attributes("disabled")).toBeDefined();
    expect(submitBtn.text()).toContain("提交中");

    resolveCreate!();
    await flushPromises();
    expect(wrapper.find('[data-testid="invitation-form"]').exists()).toBe(false);
  });

  it("取消 → 不调用创建接口", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await wrapper
      .findAll('[data-testid="invitation-form"] button')
      .find((b) => b.text() === "取消")!
      .trigger("click");
    await flushPromises();

    expect(createInvitationMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="invitation-form"]').exists()).toBe(false);
  });
});

describe("InvitationList：撤回二次确认", () => {
  it("点撤回先开确认弹窗（不发请求），确认后才 DELETE", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-revoke"]').trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="invitation-revoke-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("abc123");
    expect(revokeInvitationMock).not.toHaveBeenCalled();

    await wrapper
      .find('[data-testid="invitation-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(revokeInvitationMock).toHaveBeenCalledWith("abc123");
    expect(wrapper.find('[data-testid="invitation-revoke-dialog"]').exists()).toBe(
      false,
    );
    // 撤回成功后重拉列表
    expect(listInvitationsMock).toHaveBeenCalledTimes(2);
  });

  it("服务端拒绝 → 原样展示 msg，弹窗保持打开", async () => {
    revokeInvitationMock.mockRejectedValue(new Error("邀请码已失效"));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-revoke"]').trigger("click");
    await flushPromises();
    await wrapper
      .find('[data-testid="invitation-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="invitation-revoke-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(
      dialog.find('[data-testid="invitation-revoke-error"]').text(),
    ).toContain("邀请码已失效");
    // 失败不重拉
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
  });

  it("取消 → 不调用撤回接口，弹窗关闭", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-revoke"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="invitation-revoke-cancel"]').trigger("click");
    await flushPromises();

    expect(revokeInvitationMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="invitation-revoke-dialog"]').exists()).toBe(
      false,
    );
  });

  it("撤回中禁用确认按钮", async () => {
    let resolveRevoke: (() => void) | undefined;
    revokeInvitationMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRevoke = () => resolve();
        }),
    );
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-revoke"]').trigger("click");
    await flushPromises();
    await wrapper
      .find('[data-testid="invitation-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    const confirmBtn = wrapper.find('[data-testid="invitation-revoke-confirm"]');
    expect(confirmBtn.attributes("disabled")).toBeDefined();
    expect(confirmBtn.text()).toContain("撤回中");

    resolveRevoke!();
    await flushPromises();
    expect(wrapper.find('[data-testid="invitation-revoke-dialog"]').exists()).toBe(
      false,
    );
  });
});

describe("InvitationList：页签切换与加入申请（只读）", () => {
  it("切到「加入申请」→ 拉申请列表并渲染申请人 / 邀请码 / 角色 / 时间", async () => {
    listJoinRequestsMock.mockResolvedValue(
      pageOf([
        makeRequest({
          id: 1,
          username: "bob",
          nickname: "鲍勃",
          invitationCode: "abc123",
          roleCodes: ["viewer"],
        }),
        makeRequest({
          id: 2,
          username: "eve",
          nickname: "",
          invitationCode: "",
          roleCodes: [],
        }),
      ]),
    );
    const wrapper = await mountPage();
    expect(listJoinRequestsMock).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    expect(listJoinRequestsMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });
    const rows = requestRows(wrapper);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("鲍勃");
    expect(rows[0]!.text()).toContain("bob");
    expect(rows[0]!.text()).toContain("abc123");
    expect(rows[0]!.text()).toContain("viewer");
    expect(rows[0]!.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    // 昵称缺失 → 回退登录名
    expect(rows[1]!.text()).toContain("eve");
  });

  it("申请处理（feat-invitation-handle-request）：有 HANDLE_REQUEST 码 → 行内渲染「通过/拒绝」", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    const rows = requestRows(wrapper);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.findAll("button")).toHaveLength(2);
      expect(row.find('[data-testid="join-request-approve"]').exists()).toBe(
        true,
      );
      expect(row.find('[data-testid="join-request-reject"]').exists()).toBe(
        true,
      );
    }
  });

  it("申请处理：缺 HANDLE_REQUEST 码 → 行内无操作按钮（不渲染入口、不发请求）", async () => {
    const without = IAM_ALL_CODES.filter(
      (c) => c !== IAM_INVITATION.HANDLE_REQUEST,
    );
    const wrapper = await mountPage(without);
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    for (const row of requestRows(wrapper)) {
      expect(row.findAll("button")).toHaveLength(0);
    }
    expect(handleJoinRequestMock).not.toHaveBeenCalled();
  });

  it("申请处理：点「通过」→ handleJoinRequest(id, true) 并按处理结果重拉列表", async () => {
    handleJoinRequestMock.mockResolvedValue(undefined);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();
    const callsBefore = listJoinRequestsMock.mock.calls.length;

    await requestRows(wrapper)[0]!
      .find('[data-testid="join-request-approve"]')
      .trigger("click");
    await flushPromises();

    expect(handleJoinRequestMock).toHaveBeenCalledWith(1, true);
    expect(listJoinRequestsMock.mock.calls.length).toBe(callsBefore + 1);
    expect(wrapper.find('[data-testid="join-request-handle-error"]').exists()).toBe(
      false,
    );
  });

  it("申请处理：点「拒绝」→ handleJoinRequest(id, false)", async () => {
    handleJoinRequestMock.mockResolvedValue(undefined);
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    await requestRows(wrapper)[0]!
      .find('[data-testid="join-request-reject"]')
      .trigger("click");
    await flushPromises();

    expect(handleJoinRequestMock).toHaveBeenCalledWith(1, false);
  });

  it("申请处理被拒：展示 eiam 文案原文、不重拉、不谎报成功", async () => {
    handleJoinRequestMock.mockRejectedValue(new Error("申请已处理，请勿重复操作"));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();
    const callsBefore = listJoinRequestsMock.mock.calls.length;

    await requestRows(wrapper)[0]!
      .find('[data-testid="join-request-approve"]')
      .trigger("click");
    await flushPromises();

    const errEl = wrapper.find('[data-testid="join-request-handle-error"]');
    expect(errEl.exists()).toBe(true);
    expect(errEl.text()).toContain("申请已处理，请勿重复操作");
    // 失败不重拉（避免用"列表没变"掩盖失败），且行仍在
    expect(listJoinRequestsMock.mock.calls.length).toBe(callsBefore);
    expect(requestRows(wrapper)).toHaveLength(1);
  });

  it("申请空态：无申请显示「暂无加入申请」", async () => {
    listJoinRequestsMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    const empty = wrapper.find('[data-testid="join-request-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("暂无加入申请");
  });

  it("申请列表错误态：原文 + 重试", async () => {
    listJoinRequestsMock.mockRejectedValueOnce(new Error("申请列表不可用"));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();

    const errorBox = wrapper.find(".state-error");
    expect(errorBox.text()).toContain("申请列表不可用");

    await errorBox.find("button").trigger("click");
    await flushPromises();
    expect(listJoinRequestsMock).toHaveBeenCalledTimes(2);
    expect(requestRows(wrapper)).toHaveLength(1);
  });

  it("切回「邀请列表」→ 重新拉邀请列表（两页签各自独立）", async () => {
    const wrapper = await mountPage();
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);

    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="invitation-tab-list"]').trigger("click");
    await flushPromises();

    expect(listInvitationsMock).toHaveBeenCalledTimes(2);
    expect(invRows(wrapper)).toHaveLength(1);
  });

  it("页签 aria-selected 反映当前视图", async () => {
    const wrapper = await mountPage();
    expect(
      wrapper.find('[data-testid="invitation-tab-list"]').attributes("aria-selected"),
    ).toBe("true");
    await wrapper.find('[data-testid="invitation-tab-requests"]').trigger("click");
    await flushPromises();
    expect(
      wrapper
        .find('[data-testid="invitation-tab-requests"]')
        .attributes("aria-selected"),
    ).toBe("true");
    expect(
      wrapper.find('[data-testid="invitation-tab-list"]').attributes("aria-selected"),
    ).toBe("false");
  });
});

describe("InvitationList：权限裁剪（按钮级）", () => {
  it("仅 iam:invitation:view → 不渲染创建 / 撤回按钮，列表仍可见", async () => {
    const wrapper = await mountPage([IAM_INVITATION.VIEW]);
    expect(wrapper.find('[data-testid="invitation-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="invitation-revoke"]').exists()).toBe(false);
    expect(invRows(wrapper)).toHaveLength(1);
  });

  it("VIEW + ADD → 创建在、撤回不在", async () => {
    const wrapper = await mountPage([IAM_INVITATION.VIEW, IAM_INVITATION.ADD]);
    expect(wrapper.find('[data-testid="invitation-create"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="invitation-revoke"]').exists()).toBe(false);
  });

  it("VIEW + DELETE → 撤回在、创建不在", async () => {
    const wrapper = await mountPage([IAM_INVITATION.VIEW, IAM_INVITATION.DELETE]);
    expect(wrapper.find('[data-testid="invitation-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="invitation-revoke"]').exists()).toBe(true);
  });
});

// ===== feat-invitation-complete 增量 =====

const roleOptions = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="invitation-form-role-option"]');
const rowSelects = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="invitation-select"]');
const toolbarText = (wrapper: Wrapper) =>
  wrapper.find(".table-toolbar__info").text();

describe("InvitationList：创建弹窗角色多选（契约 §2.2）", () => {
  it("打开弹窗即拉角色候选（listRolesPage offset 0 / limit 100），每项取值为 role code", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);

    expect(listRolesPageMock).toHaveBeenCalledTimes(1);
    expect(listRolesPageMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 100,
      keyword: "",
    });

    const options = roleOptions(wrapper);
    expect(options).toHaveLength(2);
    expect((options[0]!.element as HTMLInputElement).value).toBe("viewer");
    expect((options[1]!.element as HTMLInputElement).value).toBe("ops");
    // 默认不预选（允许空选）
    expect((options[0]!.element as HTMLInputElement).checked).toBe(false);
  });

  it("角色候选翻页拉齐：100/页，total 未满前继续翻页", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => makeRole(`r${i}`));
    listRolesPageMock
      .mockResolvedValueOnce(pageOf(firstPage, 101))
      .mockResolvedValueOnce(pageOf([makeRole("last")], 101));

    const wrapper = await mountPage();
    await openCreate(wrapper);

    expect(listRolesPageMock).toHaveBeenCalledTimes(2);
    expect(listRolesPageMock).toHaveBeenLastCalledWith({
      offset: 100,
      limit: 100,
      keyword: "",
    });
    expect(roleOptions(wrapper)).toHaveLength(101);
  });

  it("角色候选 ≤20 页护栏（服务端 total 异常也不会死循环）", async () => {
    listRolesPageMock.mockImplementation(async (q) => ({
      total: Number.MAX_SAFE_INTEGER,
      items: Array.from({ length: 100 }, (_, i) => makeRole(`r${q.offset + i}`)),
    }));

    const wrapper = await mountPage();
    await openCreate(wrapper);

    expect(listRolesPageMock).toHaveBeenCalledTimes(20);
    expect(roleOptions(wrapper)).toHaveLength(2000);
  });

  it("勾选两个角色 → 提交 role_codes 为所选 code 数组（不是 name / id）", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    const options = roleOptions(wrapper);
    await options[0]!.setValue(true);
    await options[1]!.setValue(true);
    await submitForm(wrapper);

    const payload = createInvitationMock.mock.calls[0]![0] as {
      roleCodes: unknown;
    };
    expect(payload.roleCodes).toEqual(["viewer", "ops"]);
    expect(Array.isArray(payload.roleCodes)).toBe(true);
    // 不得误传角色名（name）或 id
    expect(payload.roleCodes).not.toContain("只读");
  });

  it("允许空选：一个都不勾 → 提交 role_codes: []（向后兼容）", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    expect(roleOptions(wrapper)).toHaveLength(2);

    await submitForm(wrapper);

    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ roleCodes: [] }),
    );
  });

  it("没有可分配角色 → 「暂无可选角色」，仍可空选提交", async () => {
    listRolesPageMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    await openCreate(wrapper);

    expect(roleOptions(wrapper)).toHaveLength(0);
    expect(wrapper.find('[data-testid="invitation-form-roles"]').text()).toContain(
      "暂无可选角色",
    );

    await submitForm(wrapper);
    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ roleCodes: [] }),
    );
  });

  it("角色候选加载失败 → 弹窗内提示原文，仍可空选提交（不阻断创建）", async () => {
    listRolesPageMock.mockRejectedValue(new Error("角色服务不可用"));
    const wrapper = await mountPage();
    await openCreate(wrapper);

    const rolesBox = wrapper.find('[data-testid="invitation-form-roles"]');
    expect(rolesBox.text()).toContain("角色服务不可用");
    expect(roleOptions(wrapper)).toHaveLength(0);

    await submitForm(wrapper);
    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ roleCodes: [] }),
    );
  });

  it("重新打开弹窗 → 角色选择复位（不沿用上一次的勾选）", async () => {
    const wrapper = await mountPage();
    await openCreate(wrapper);
    await roleOptions(wrapper)[0]!.setValue(true);
    await wrapper
      .findAll('[data-testid="invitation-form"] button')
      .find((b) => b.text() === "取消")!
      .trigger("click");
    await flushPromises();

    await openCreate(wrapper);
    for (const option of roleOptions(wrapper)) {
      expect((option.element as HTMLInputElement).checked).toBe(false);
    }
    await submitForm(wrapper);
    expect(createInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({ roleCodes: [] }),
    );
  });
});

describe("InvitationList：行多选与批量撤回（契约 §2.2）", () => {
  it("无选中 → 批量撤回禁用；勾选一行后启用并显示已选条数", async () => {
    const wrapper = await mountPage();
    const batchBtn = wrapper.find('[data-testid="invitation-batch-revoke"]');
    expect(batchBtn.exists()).toBe(true);
    expect(batchBtn.attributes("disabled")).toBeDefined();
    expect(toolbarText(wrapper)).toContain("已选 0 条");

    await rowSelects(wrapper)[0]!.setValue(true);
    expect(batchBtn.attributes("disabled")).toBeUndefined();
    expect(toolbarText(wrapper)).toContain("已选 1 条");
  });

  it("表头全选 → 勾中本页全部行；再取消 → 全部清空", async () => {
    listInvitationsMock.mockResolvedValue(
      pageOf([
        makeInvitation({ code: "a1" }),
        makeInvitation({ code: "a2" }),
        makeInvitation({ code: "a3" }),
      ]),
    );
    const wrapper = await mountPage();
    const selectAll = wrapper.find('[data-testid="invitation-select-all"]');
    expect(selectAll.exists()).toBe(true);

    await selectAll.setValue(true);
    expect(rowSelects(wrapper)).toHaveLength(3);
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(true);
    }
    expect(toolbarText(wrapper)).toContain("已选 3 条");

    await selectAll.setValue(false);
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(false);
    }
    expect(toolbarText(wrapper)).toContain("已选 0 条");
  });

  it("确认后调 batchRevokeInvitations(codes) → 清空选中 → 重拉列表", async () => {
    listInvitationsMock.mockResolvedValue(
      pageOf([
        makeInvitation({ code: "a1" }),
        makeInvitation({ code: "a2" }),
        makeInvitation({ code: "a3" }),
      ]),
    );
    const wrapper = await mountPage();
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);

    await rowSelects(wrapper)[0]!.setValue(true);
    await rowSelects(wrapper)[2]!.setValue(true);
    await wrapper.find('[data-testid="invitation-batch-revoke"]').trigger("click");
    await flushPromises();

    // 二次确认：未确认不发请求
    expect(batchRevokeInvitationsMock).not.toHaveBeenCalled();
    const dialog = wrapper.find('[data-testid="invitation-batch-revoke-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("a1");
    expect(dialog.text()).toContain("a3");

    await wrapper
      .find('[data-testid="invitation-batch-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(batchRevokeInvitationsMock).toHaveBeenCalledTimes(1);
    expect(batchRevokeInvitationsMock).toHaveBeenCalledWith(["a1", "a3"]);
    expect(
      wrapper.find('[data-testid="invitation-batch-revoke-dialog"]').exists(),
    ).toBe(false);
    // 成功后重拉
    expect(listInvitationsMock).toHaveBeenCalledTimes(2);
    // 选中已清空
    expect(toolbarText(wrapper)).toContain("已选 0 条");
    expect(
      wrapper.find('[data-testid="invitation-batch-revoke"]').attributes("disabled"),
    ).toBeDefined();
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(false);
    }
  });

  it("被拒 → 展示服务端 msg 原文，弹窗保持打开、选中不清空、不重拉", async () => {
    batchRevokeInvitationsMock.mockRejectedValue(
      new Error("部分邀请码已失效：a9"),
    );
    const wrapper = await mountPage();
    await rowSelects(wrapper)[0]!.setValue(true);
    await wrapper.find('[data-testid="invitation-batch-revoke"]').trigger("click");
    await flushPromises();
    await wrapper
      .find('[data-testid="invitation-batch-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="invitation-batch-revoke-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(
      dialog.find('[data-testid="invitation-batch-revoke-error"]').text(),
    ).toContain("部分邀请码已失效：a9");
    // 失败不重拉、选中保留（不谎报成功）
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
    expect(toolbarText(wrapper)).toContain("已选 1 条");
    expect((rowSelects(wrapper)[0]!.element as HTMLInputElement).checked).toBe(true);
  });

  it("取消二次确认 → 不调用批量撤回接口，选中保留", async () => {
    const wrapper = await mountPage();
    await rowSelects(wrapper)[0]!.setValue(true);
    await wrapper.find('[data-testid="invitation-batch-revoke"]').trigger("click");
    await flushPromises();
    await wrapper
      .find('[data-testid="invitation-batch-revoke-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(batchRevokeInvitationsMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="invitation-batch-revoke-dialog"]').exists(),
    ).toBe(false);
    expect(toolbarText(wrapper)).toContain("已选 1 条");
  });

  it("撤回中禁用确认按钮（防重复提交）", async () => {
    let resolveBatch: (() => void) | undefined;
    batchRevokeInvitationsMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveBatch = () => resolve();
        }),
    );
    const wrapper = await mountPage();
    await rowSelects(wrapper)[0]!.setValue(true);
    await wrapper.find('[data-testid="invitation-batch-revoke"]').trigger("click");
    await flushPromises();
    await wrapper
      .find('[data-testid="invitation-batch-revoke-confirm"]')
      .trigger("click");
    await flushPromises();

    const confirmBtn = wrapper.find('[data-testid="invitation-batch-revoke-confirm"]');
    expect(confirmBtn.attributes("disabled")).toBeDefined();
    expect(confirmBtn.text()).toContain("撤回中");

    resolveBatch!();
    await flushPromises();
    expect(
      wrapper.find('[data-testid="invitation-batch-revoke-dialog"]').exists(),
    ).toBe(false);
  });

  it("缺 BATCH_DELETE → 不渲染行多选 / 全选 / 批量撤回按钮", async () => {
    const wrapper = await mountPage([
      IAM_INVITATION.VIEW,
      IAM_INVITATION.DELETE,
    ]);
    expect(invRows(wrapper)).toHaveLength(1);
    expect(wrapper.find('[data-testid="invitation-batch-revoke"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="invitation-select"]').exists()).toBe(false);
    expect(
      wrapper.find('[data-testid="invitation-select-all"]').exists(),
    ).toBe(false);
  });
});

describe("InvitationList：加入申请页签权限（VIEW_REQUESTS）", () => {
  it("缺 VIEW_REQUESTS → 页签不渲染，也不请求 /requests", async () => {
    const wrapper = await mountPage([
      IAM_INVITATION.VIEW,
      IAM_INVITATION.ADD,
      IAM_INVITATION.DELETE,
      IAM_INVITATION.BATCH_DELETE,
    ]);

    expect(
      wrapper.find('[data-testid="invitation-tab-requests"]').exists(),
    ).toBe(false);
    expect(
      wrapper.find('[data-testid="invitation-panel-requests"]').exists(),
    ).toBe(false);
    expect(listJoinRequestsMock).not.toHaveBeenCalled();
    // 邀请列表本身照常可用
    expect(invRows(wrapper)).toHaveLength(1);
  });

  it("有 VIEW_REQUESTS → 页签渲染，切换后才请求 /requests", async () => {
    const wrapper = await mountPage([
      IAM_INVITATION.VIEW,
      IAM_INVITATION.VIEW_REQUESTS,
    ]);
    const tab = wrapper.find('[data-testid="invitation-tab-requests"]');
    expect(tab.exists()).toBe(true);
    // 未切换前不请求（懒加载语义不变）
    expect(listJoinRequestsMock).not.toHaveBeenCalled();

    await tab.trigger("click");
    await flushPromises();

    expect(listJoinRequestsMock).toHaveBeenCalledTimes(1);
    expect(
      wrapper.find('[data-testid="invitation-panel-requests"]').exists(),
    ).toBe(true);
    expect(requestRows(wrapper)).toHaveLength(1);
  });
});
