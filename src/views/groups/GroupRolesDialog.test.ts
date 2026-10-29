// @vitest-environment happy-dom
/**
 * GroupRolesDialog 组件行为测试（feat-group-roles 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层 mock，**不触真实网络、不创建真实用户组/角色**）：
 * - 打开即拉取（按 group.code GET 已绑角色）、group=null 不渲染不拉取；
 * - 空态「该用户组暂无角色」；已绑列表渲染名称 / 标识码 / 描述；
 * - 分配：候选 = listRolesPage 全量角色**排除已绑定**（选项里不得出现已绑定 code）；
 *   确认 → assignGroupRole(group_code, role_code) → emit changed + 重拉已绑列表；
 * - 解绑：点「解绑」只开二次确认（不发请求）、确认后调 removeGroupRole → emit changed + 重拉；
 * - 被拒：原样展示服务端 msg（分配 / 解绑各自原位展示），不 emit changed；
 * - 提交中禁用（防重复点击）；加载错误原文 + 重试可恢复；
 * - 权限：无 ASSIGN_ROLE 不渲染选择器 / 确认按钮，无 REMOVE_ROLE 不渲染行内「解绑」；
 * - 关闭不留请求（父级把 group 置 null 后不再发起任何请求）。
 *
 * 手法：mock `@/api/groups` 三函数与 `@/api/roles` 的 listRolesPage；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupRolesDialog from "./GroupRolesDialog.vue";
import { useUserStore } from "@/stores/user";
import { IAM_GROUP } from "@/config/permission-codes";
import { ApiError, type Page, type Role } from "@/api/types";
import type { TenantGroupRole } from "@/api/groups";
import {
  assignGroupRole,
  listGroupRoles,
  removeGroupRole,
} from "@/api/groups";
import { listRolesPage } from "@/api/roles";

vi.mock("@/api/groups", () => ({
  listGroupRoles: vi.fn(),
  assignGroupRole: vi.fn(),
  removeGroupRole: vi.fn(),
}));

vi.mock("@/api/roles", () => ({
  listRolesPage: vi.fn(),
}));

const listBoundMock = vi.mocked(listGroupRoles);
const assignMock = vi.mocked(assignGroupRole);
const removeMock = vi.mocked(removeGroupRole);
const listRolesMock = vi.mocked(listRolesPage);

const GROUP = { code: "rd", name: "研发组" };

const ALL_PERMISSIONS = [
  IAM_GROUP.ROLES,
  IAM_GROUP.ASSIGN_ROLE,
  IAM_GROUP.REMOVE_ROLE,
];

function makeBoundRole(
  overrides: Partial<TenantGroupRole> = {},
): TenantGroupRole {
  return {
    id: 3,
    code: "admin",
    name: "管理员",
    desc: "平台管理员",
    ctime: 1730000000000,
    tenantId: 0,
    policies: [],
    users: [],
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Role> = {}): Role {
  return {
    id: 3,
    code: "admin",
    name: "管理员",
    desc: "平台管理员",
    tenantId: 0,
    policies: [],
    users: [],
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

type Wrapper = ReturnType<typeof mount>;

async function mountDialog(
  group: { code: string; name: string } | null = GROUP,
  permissions: string[] = ALL_PERMISSIONS,
): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(GroupRolesDialog, { props: { group } });
  await flushPromises();
  return wrapper;
}

/** 选择器里所有 option 的 value（含首项占位 ""） */
function optionValues(wrapper: Wrapper): string[] {
  return wrapper
    .find('[data-testid="group-role-assign-select"]')
    .findAll("option")
    .map((o) => o.attributes("value") ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  listBoundMock.mockResolvedValue([makeBoundRole()]);
  assignMock.mockResolvedValue(undefined);
  removeMock.mockResolvedValue(undefined);
  listRolesMock.mockResolvedValue(
    pageOf([
      makeCandidate(),
      makeCandidate({ id: 4, code: "viewer", name: "只读", desc: "只读角色" }),
    ]),
  );
});

describe("GroupRolesDialog：打开 / 已绑列表", () => {
  it("打开即按 group.code 拉取已绑角色，渲染名称 / 标识码 / 描述与标题", async () => {
    listBoundMock.mockResolvedValue([
      makeBoundRole(),
      makeBoundRole({ id: 4, code: "viewer", name: "只读", desc: "" }),
    ]);
    const wrapper = await mountDialog();

    expect(listBoundMock).toHaveBeenCalledTimes(1);
    expect(listBoundMock).toHaveBeenCalledWith("rd");
    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain("研发组 · 角色");

    // 契约 §2.2 必备 testid
    for (const id of [
      "group-roles-close",
      "group-role-assign-select",
      "group-role-assign-confirm",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }

    const rows = wrapper.findAll('[data-testid="group-role-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("管理员");
    expect(rows[0]!.text()).toContain("admin");
    expect(rows[0]!.text()).toContain("平台管理员");
    // 描述缺失 → '—'
    expect(rows[1]!.text()).toContain("—");
    // 创建时间经 formatEpochMs（Unix 毫秒，不是 1970 / 荒谬年份）
    expect(rows[0]!.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(rows[0]!.text()).not.toContain("58563");
  });

  it("group=null → 不渲染且不拉取（已绑角色与候选都不请求）", async () => {
    const wrapper = await mountDialog(null);
    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      false,
    );
    expect(listBoundMock).not.toHaveBeenCalled();
    expect(listRolesMock).not.toHaveBeenCalled();
  });

  it("空态：未绑定任何角色 → 「该用户组暂无角色」", async () => {
    listBoundMock.mockResolvedValue([]);
    const wrapper = await mountDialog();

    const empty = wrapper.find('[data-testid="group-roles-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("该用户组暂无角色");
    expect(wrapper.findAll('[data-testid="group-role-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="group-roles-error"]').exists()).toBe(
      false,
    );
  });

  it("加载失败 → 展示服务端 msg 原文 + 重试可恢复", async () => {
    listBoundMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountDialog();

    const error = wrapper.find('[data-testid="group-roles-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");

    await error.find("button").trigger("click");
    await flushPromises();
    expect(listBoundMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('[data-testid="group-role-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="group-roles-error"]').exists()).toBe(
      false,
    );
  });
});

describe("GroupRolesDialog：分配角色（候选排除已绑定）", () => {
  it("候选来自 listRolesPage 全量角色，且排除已绑定 code", async () => {
    const wrapper = await mountDialog();

    expect(listRolesMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 100,
      keyword: "",
    });

    const values = optionValues(wrapper);
    // 首项为占位「选择角色」，其余为未绑定候选
    expect(values[0]).toBe("");
    expect(values).toContain("viewer");
    // admin 已绑定 → 不得出现在候选里
    expect(values).not.toContain("admin");
    expect(
      wrapper
        .findAll('[data-testid="group-role-assign-select"] option')
        .map((o) => o.text())
        .join(" "),
    ).not.toContain("管理员");
  });

  it("候选为「全量角色」：listRolesPage 分页拉齐（offset 递增），再排除已绑定", async () => {
    // 第 1 页 100 条（total 120），第 2 页 20 条 —— 候选源必须是全部 120 条
    const firstPage = Array.from({ length: 100 }, (_, i) =>
      makeCandidate({ id: 1000 + i, code: `r${i}`, name: `角色${i}` }),
    );
    const secondPage = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ id: 2000 + i, code: `r${100 + i}`, name: `角色${100 + i}` }),
    );
    listRolesMock
      .mockResolvedValueOnce(pageOf(firstPage, 120))
      .mockResolvedValueOnce(pageOf(secondPage, 120));

    const wrapper = await mountDialog();

    expect(listRolesMock).toHaveBeenNthCalledWith(1, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(listRolesMock).toHaveBeenNthCalledWith(2, {
      offset: 100,
      limit: 100,
      keyword: "",
    });
    const values = optionValues(wrapper);
    // 占位 + 120 条候选；已绑定的 admin 不在其中
    expect(values).toHaveLength(121);
    expect(values).toContain("r0");
    expect(values).toContain("r119");
  });

  it("候选全被绑定 → 选择器无可用项并给出说明", async () => {
    listRolesMock.mockResolvedValue(pageOf([makeCandidate()]));
    const wrapper = await mountDialog();

    expect(optionValues(wrapper)).toEqual([""]);
    expect(
      wrapper.find('[data-testid="group-role-assign-empty"]').text(),
    ).toContain("没有可分配的角色");
    expect(
      wrapper
        .find('[data-testid="group-role-assign-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();
  });

  it("未选角色 → 确认按钮禁用且不调 api", async () => {
    const wrapper = await mountDialog();
    const confirm = wrapper.find('[data-testid="group-role-assign-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();

    await confirm.trigger("click");
    await flushPromises();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("选中未绑定角色 + 确认 → assignGroupRole(group_code, role_code)，emit changed 并重拉", async () => {
    const wrapper = await mountDialog();
    await wrapper
      .find('[data-testid="group-role-assign-select"]')
      .setValue("viewer");

    await wrapper
      .find('[data-testid="group-role-assign-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(assignMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith("rd", "viewer");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    // 成功后重拉已绑列表（挂载 1 次 + 分配后 1 次）
    expect(listBoundMock).toHaveBeenCalledTimes(2);
  });

  it("分配成功后重拉：新绑定的角色从候选中消失、进入已绑列表", async () => {
    listBoundMock.mockResolvedValueOnce([makeBoundRole()]);
    const wrapper = await mountDialog();

    // 分配成功后服务端已绑集合包含 viewer
    listBoundMock.mockResolvedValueOnce([
      makeBoundRole(),
      makeBoundRole({ id: 4, code: "viewer", name: "只读", desc: "只读角色" }),
    ]);
    await wrapper
      .find('[data-testid="group-role-assign-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="group-role-assign-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-testid="group-role-row"]')).toHaveLength(2);
    expect(optionValues(wrapper)).not.toContain("viewer");
  });

  it("提交中确认按钮禁用（防重复点击）", async () => {
    let release: (() => void) | undefined;
    assignMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = await mountDialog();
    await wrapper
      .find('[data-testid="group-role-assign-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="group-role-assign-confirm"]')
      .trigger("click");
    await wrapper.vm.$nextTick();

    const confirm = wrapper.find('[data-testid="group-role-assign-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();
    expect(confirm.text()).toContain("分配中");

    release?.();
    await flushPromises();
    expect(assignMock).toHaveBeenCalledTimes(1);
  });

  it("分配被拒 → 原样展示服务端 msg，不 emit changed、弹窗保持打开", async () => {
    assignMock.mockRejectedValueOnce(
      new ApiError("unknown", "该用户组已绑定此角色", { code: 4010902 }),
    );
    const wrapper = await mountDialog();
    await wrapper
      .find('[data-testid="group-role-assign-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="group-role-assign-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="group-role-assign-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("该用户组已绑定此角色");
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      true,
    );
  });

  it("无 iam:group:assign_role → 不渲染选择器 / 确认按钮，且不请求候选", async () => {
    const wrapper = await mountDialog(GROUP, [
      IAM_GROUP.ROLES,
      IAM_GROUP.REMOVE_ROLE,
    ]);
    expect(
      wrapper.find('[data-testid="group-role-assign-select"]').exists(),
    ).toBe(false);
    expect(
      wrapper.find('[data-testid="group-role-assign-confirm"]').exists(),
    ).toBe(false);
    expect(listRolesMock).not.toHaveBeenCalled();
  });
});

describe("GroupRolesDialog：解绑角色（二次确认）", () => {
  it("点「解绑」只开二次确认（不发请求）；确认后调 removeGroupRole 并 emit changed + 重拉", async () => {
    const wrapper = await mountDialog();

    await wrapper.find('[data-testid="group-role-remove"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="group-role-remove-confirm"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-testid="group-role-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith("rd", "admin");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(listBoundMock).toHaveBeenCalledTimes(2);
    expect(
      wrapper.find('[data-testid="group-role-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("解绑被拒 → 原样展示服务端 msg（不改写），不 emit changed、确认弹窗保持打开", async () => {
    removeMock.mockRejectedValueOnce(
      new ApiError("unknown", "该角色未被用户组绑定", { code: 4010903 }),
    );
    const wrapper = await mountDialog();

    await wrapper.find('[data-testid="group-role-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="group-role-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="group-role-remove-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("该角色未被用户组绑定");
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(
      wrapper.find('[data-testid="group-role-remove-confirm"]').exists(),
    ).toBe(true);
  });

  it("取消二次确认 → 不调 api、确认弹窗关闭", async () => {
    const wrapper = await mountDialog();
    await wrapper.find('[data-testid="group-role-remove"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper
      .find('[data-testid="group-role-remove-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="group-role-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("无 iam:group:remove_role → 不渲染行内「解绑」", async () => {
    const wrapper = await mountDialog(GROUP, [
      IAM_GROUP.ROLES,
      IAM_GROUP.ASSIGN_ROLE,
    ]);
    expect(wrapper.findAll('[data-testid="group-role-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="group-role-remove"]')).toHaveLength(0);
  });
});

describe("GroupRolesDialog：关闭", () => {
  it("点关闭 → emit close；父级置 null 后不再发起请求", async () => {
    const wrapper = await mountDialog();
    await wrapper.find('[data-testid="group-roles-close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ group: null });
    await flushPromises();

    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      false,
    );
    expect(listBoundMock).toHaveBeenCalledTimes(1);
    expect(listRolesMock).toHaveBeenCalledTimes(1);
  });

  it("关闭后迟到的响应不写回 state（不渲染已绑行）", async () => {
    let release: ((roles: TenantGroupRole[]) => void) | undefined;
    listBoundMock.mockImplementation(
      () =>
        new Promise<TenantGroupRole[]>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = await mountDialog();

    await wrapper.setProps({ group: null });
    release?.([makeBoundRole()]);
    await flushPromises();

    expect(wrapper.findAll('[data-testid="group-role-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      false,
    );
  });

  it("同一 code 的新 props 对象 → 不重复拉取；换 code → 按新 code 重拉", async () => {
    const wrapper = await mountDialog();
    expect(listBoundMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ group: { code: "rd", name: "研发组" } });
    await flushPromises();
    expect(listBoundMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ group: { code: "ops", name: "运维组" } });
    await flushPromises();
    expect(listBoundMock).toHaveBeenLastCalledWith("ops");
    expect(wrapper.text()).toContain("运维组 · 角色");
  });
});
