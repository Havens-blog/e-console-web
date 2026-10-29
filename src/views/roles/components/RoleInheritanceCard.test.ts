// @vitest-environment happy-dom
/**
 * RoleInheritanceCard 组件行为测试（feat-role-inheritance 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层全 mock，**不触真实网络、不创建真实角色、不改真实继承关系**）：
 * - 打开即拉取：listParentRoles(roleCode) + 角色列表（名称来源）；
 * - 行渲染：名称（查不到回退 code）+ 标识码 + 「直接/间接」+「不可移除」标记；
 * - 空态「该角色暂无父角色」；加载错误原文 + 重试可恢复；
 * - 添加：候选 = 角色列表**排除自身与已有父角色**；选择 + 确认 → addParentRole →
 *   重拉父角色列表；提交中禁用；被拒原文（不改写）；
 * - 移除：行内按钮只开二次确认（不发请求）→ 确认后 removeParentRole + 重拉；
 *   `is_immutable` 行按钮 **disabled**（仍在 DOM 中，可见「不可移除」）；被拒原文；
 * - 权限：无 ADD_PARENT 不渲染选择器/确认，无 REMOVE_PARENT 不渲染行内「移除」。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import RoleInheritanceCard from "./RoleInheritanceCard.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ROLE } from "@/config/permission-codes";
import { ApiError, type Page, type Role } from "@/api/types";
import type { RoleInheritance } from "@/api/roles";
import {
  addParentRole,
  listParentRoles,
  listRolesPage,
  removeParentRole,
} from "@/api/roles";

vi.mock("@/api/roles", () => ({
  listParentRoles: vi.fn(),
  listRolesPage: vi.fn(),
  addParentRole: vi.fn(),
  removeParentRole: vi.fn(),
}));

const listParentsMock = vi.mocked(listParentRoles);
const listRolesMock = vi.mocked(listRolesPage);
const addMock = vi.mocked(addParentRole);
const removeMock = vi.mocked(removeParentRole);

const ALL_PERMISSIONS = [
  IAM_ROLE.VIEW_PARENTS,
  IAM_ROLE.ADD_PARENT,
  IAM_ROLE.REMOVE_PARENT,
];

function makeRole(overrides: Partial<Role> = {}): Role {
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

function makeParent(
  overrides: Partial<RoleInheritance> = {},
): RoleInheritance {
  return { code: "admin", isDirect: true, isImmutable: false, ...overrides };
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

async function mountCard(
  roleCode = "ops",
  permissions: string[] = ALL_PERMISSIONS,
): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(RoleInheritanceCard, {
    props: { roleCode, roleName: "运维角色" },
  });
  await flushPromises();
  return wrapper;
}

/** 选择器里所有 option 的 value（含首项占位 ""） */
function optionValues(wrapper: Wrapper): string[] {
  return wrapper
    .find('[data-testid="role-inheritance-add-select"]')
    .findAll("option")
    .map((o) => o.attributes("value") ?? "");
}

function rowByCode(wrapper: Wrapper, code: string) {
  return wrapper.find(
    `[data-testid="role-inheritance-row"][data-role-code="${code}"]`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listParentsMock.mockResolvedValue([makeParent()]);
  addMock.mockResolvedValue(undefined);
  removeMock.mockResolvedValue(undefined);
  listRolesMock.mockResolvedValue(
    pageOf([
      makeRole({ id: 3, code: "admin", name: "管理员" }),
      makeRole({ id: 4, code: "viewer", name: "只读" }),
      makeRole({ id: 9, code: "ops", name: "运维角色" }),
    ]),
  );
});

describe("RoleInheritanceCard：打开 / 父角色列表", () => {
  it("打开即按 roleCode 拉取父角色与角色列表，渲染名称 / 标识码 / 直接标记", async () => {
    const wrapper = await mountCard();

    expect(listParentsMock).toHaveBeenCalledTimes(1);
    expect(listParentsMock).toHaveBeenCalledWith("ops");
    expect(listRolesMock).toHaveBeenCalledWith({
      offset: 0,
      limit: 100,
      keyword: "",
    });

    const card = wrapper.find('[data-testid="role-inheritance"]');
    expect(card.exists()).toBe(true);
    for (const id of ["role-inheritance-add-select", "role-inheritance-add-confirm"]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }

    const rows = wrapper.findAll('[data-testid="role-inheritance-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("管理员"); // 名称来自角色列表本地映射
    expect(rows[0]!.text()).toContain("admin"); // 标识码
    expect(rows[0]!.text()).toContain("直接");
    expect(rows[0]!.text()).not.toContain("不可移除");
  });

  it("间接父角色 + 不可移除标记；角色列表查不到名称时回退 code", async () => {
    listParentsMock.mockResolvedValue([
      makeParent({ code: "root", isDirect: false, isImmutable: true }),
    ]);
    const wrapper = await mountCard();

    const row = rowByCode(wrapper, "root");
    expect(row.exists()).toBe(true);
    // 角色列表里没有 root → 名称回退展示 code
    expect(row.text()).toContain("root");
    expect(row.text()).toContain("间接");
    expect(row.text()).toContain("不可移除");
  });

  it("空态：无父角色 → 「该角色暂无父角色」，不渲染行", async () => {
    listParentsMock.mockResolvedValue([]);
    const wrapper = await mountCard();

    const empty = wrapper.find('[data-testid="role-inheritance-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("该角色暂无父角色");
    expect(wrapper.findAll('[data-testid="role-inheritance-row"]')).toHaveLength(
      0,
    );
    expect(wrapper.find('[data-testid="role-inheritance-error"]').exists()).toBe(
      false,
    );
  });

  it("加载失败 → 展示服务端 msg 原文 + 重试可恢复", async () => {
    listParentsMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountCard();

    const error = wrapper.find('[data-testid="role-inheritance-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");

    await error.find("button").trigger("click");
    await flushPromises();
    expect(listParentsMock).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll('[data-testid="role-inheritance-row"]')).toHaveLength(
      1,
    );
    expect(wrapper.find('[data-testid="role-inheritance-error"]').exists()).toBe(
      false,
    );
  });

  it("角色列表加载失败 → 行仍渲染（名称回退 code），候选区展示原文 + 重试", async () => {
    listRolesMock.mockRejectedValueOnce(
      new ApiError("unavailable", "角色列表加载失败"),
    );
    const wrapper = await mountCard();

    const row = rowByCode(wrapper, "admin");
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("admin");

    const error = wrapper.find(
      '[data-testid="role-inheritance-candidates-error"]',
    );
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("角色列表加载失败");

    listRolesMock.mockResolvedValue(pageOf([makeRole()]));
    await error.find("button").trigger("click");
    await flushPromises();
    expect(listRolesMock).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="role-inheritance-row"]').text()).toContain(
      "管理员",
    );
  });
});

describe("RoleInheritanceCard：添加父角色（候选排除自身与已有父角色）", () => {
  it("候选 = 角色列表中排除自身与已有父角色", async () => {
    const wrapper = await mountCard();

    const values = optionValues(wrapper);
    expect(values[0]).toBe(""); // 占位项
    expect(values).toContain("viewer");
    // 自身 ops 与已是父角色的 admin 都不得出现在候选里
    expect(values).not.toContain("ops");
    expect(values).not.toContain("admin");
    const texts = wrapper
      .findAll('[data-testid="role-inheritance-add-select"] option')
      .map((o) => o.text())
      .join(" ");
    expect(texts).not.toContain("运维角色（ops）");
    expect(texts).not.toContain("管理员（admin）");
  });

  it("候选源为全量角色：listRolesPage 翻页拉齐（offset 递增）后再排除", async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      makeRole({ id: 1000 + i, code: `r${i}`, name: `角色${i}` }),
    );
    const second = Array.from({ length: 20 }, (_, i) =>
      makeRole({ id: 2000 + i, code: `r${100 + i}`, name: `角色${100 + i}` }),
    );
    listRolesMock
      .mockResolvedValueOnce(pageOf(first, 120))
      .mockResolvedValueOnce(pageOf(second, 120));

    const wrapper = await mountCard();

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
    expect(values).toHaveLength(121);
    expect(values).toContain("r0");
    expect(values).toContain("r119");
  });

  it("候选全被排除 → 无可用项、确认禁用并给出说明", async () => {
    listRolesMock.mockResolvedValue(
      pageOf([makeRole({ id: 9, code: "ops", name: "运维角色" })]),
    );
    const wrapper = await mountCard();

    expect(optionValues(wrapper)).toEqual([""]);
    expect(
      wrapper.find('[data-testid="role-inheritance-add-empty"]').text(),
    ).toContain("没有可添加的父角色");
    expect(
      wrapper
        .find('[data-testid="role-inheritance-add-confirm"]')
        .attributes("disabled"),
    ).toBeDefined();
  });

  it("未选父角色 → 确认按钮禁用且点击不调 api", async () => {
    const wrapper = await mountCard();
    const confirm = wrapper.find('[data-testid="role-inheritance-add-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();

    await confirm.trigger("click");
    await flushPromises();
    expect(addMock).not.toHaveBeenCalled();
  });

  it("选中 + 确认 → addParentRole(roleCode, parentCode)，成功后重拉父角色列表", async () => {
    const wrapper = await mountCard();
    await wrapper
      .find('[data-testid="role-inheritance-add-select"]')
      .setValue("viewer");

    await wrapper
      .find('[data-testid="role-inheritance-add-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith("ops", "viewer");
    // 挂载 1 次 + 添加成功后 1 次
    expect(listParentsMock).toHaveBeenCalledTimes(2);
  });

  it("添加成功后重拉：新父角色进入列表并从候选中消失", async () => {
    const wrapper = await mountCard();
    listParentsMock.mockResolvedValueOnce([
      makeParent(),
      makeParent({ code: "viewer", isDirect: true, isImmutable: false }),
    ]);

    await wrapper
      .find('[data-testid="role-inheritance-add-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="role-inheritance-add-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-testid="role-inheritance-row"]')).toHaveLength(
      2,
    );
    expect(optionValues(wrapper)).not.toContain("viewer");
  });

  it("提交中确认按钮禁用（防重复点击）", async () => {
    let release: (() => void) | undefined;
    addMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = await mountCard();
    await wrapper
      .find('[data-testid="role-inheritance-add-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="role-inheritance-add-confirm"]')
      .trigger("click");
    await wrapper.vm.$nextTick();

    const confirm = wrapper.find('[data-testid="role-inheritance-add-confirm"]');
    expect(confirm.attributes("disabled")).toBeDefined();
    expect(confirm.text()).toContain("添加中");

    release?.();
    await flushPromises();
    expect(addMock).toHaveBeenCalledTimes(1);
  });

  it("添加被拒 → 原位展示服务端 msg 原文，不重拉列表", async () => {
    addMock.mockRejectedValueOnce(
      new ApiError("unknown", "添加父角色会形成环", { code: 4010802 }),
    );
    const wrapper = await mountCard();
    await wrapper
      .find('[data-testid="role-inheritance-add-select"]')
      .setValue("viewer");
    await wrapper
      .find('[data-testid="role-inheritance-add-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="role-inheritance-add-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("添加父角色会形成环");
    expect(listParentsMock).toHaveBeenCalledTimes(1);
  });
});

describe("RoleInheritanceCard：移除父角色（二次确认）", () => {
  it("点「移除」只开二次确认（不发请求）；确认后调 removeParentRole 并重拉", async () => {
    const wrapper = await mountCard();

    await wrapper.find('[data-testid="role-inheritance-remove"]').trigger("click");
    await wrapper.vm.$nextTick();
    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="role-inheritance-remove-confirm"]').exists(),
    ).toBe(true);

    await wrapper
      .find('[data-testid="role-inheritance-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith("ops", "admin");
    expect(listParentsMock).toHaveBeenCalledTimes(2);
    expect(
      wrapper.find('[data-testid="role-inheritance-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("取消二次确认 → 不调 api、确认框关闭", async () => {
    const wrapper = await mountCard();
    await wrapper.find('[data-testid="role-inheritance-remove"]').trigger("click");
    await wrapper.vm.$nextTick();

    await wrapper
      .find('[data-testid="role-inheritance-remove-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(removeMock).not.toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="role-inheritance-remove-confirm"]').exists(),
    ).toBe(false);
  });

  it("移除被拒 → 确认框内原样展示服务端 msg，不重拉、确认框保持打开", async () => {
    removeMock.mockRejectedValueOnce(
      new ApiError("unknown", "该父角色不可移除", { code: 4010803 }),
    );
    const wrapper = await mountCard();

    await wrapper.find('[data-testid="role-inheritance-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="role-inheritance-remove-confirm"]')
      .trigger("click");
    await flushPromises();

    const error = wrapper.find('[data-testid="role-inheritance-remove-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("该父角色不可移除");
    expect(listParentsMock).toHaveBeenCalledTimes(1);
    expect(
      wrapper.find('[data-testid="role-inheritance-remove-confirm"]').exists(),
    ).toBe(true);
  });

  it("is_immutable → 行内移除按钮 disabled（仍可见）且点击不弹确认、不调 api", async () => {
    listParentsMock.mockResolvedValue([
      makeParent({ code: "root", isDirect: false, isImmutable: true }),
    ]);
    const wrapper = await mountCard();

    const row = rowByCode(wrapper, "root");
    const button = row.find('[data-testid="role-inheritance-remove"]');
    expect(button.exists()).toBe(true); // 禁用而不是隐藏
    expect(button.attributes("disabled")).toBeDefined();
    expect(row.text()).toContain("不可移除");

    await button.trigger("click");
    await flushPromises();
    expect(
      wrapper.find('[data-testid="role-inheritance-remove-confirm"]').exists(),
    ).toBe(false);
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("移除提交中确认按钮禁用（防重复点击）", async () => {
    let release: (() => void) | undefined;
    removeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = await mountCard();
    await wrapper.find('[data-testid="role-inheritance-remove"]').trigger("click");
    await wrapper
      .find('[data-testid="role-inheritance-remove-confirm"]')
      .trigger("click");
    await wrapper.vm.$nextTick();

    const confirm = wrapper.find(
      '[data-testid="role-inheritance-remove-confirm"]',
    );
    expect(confirm.attributes("disabled")).toBeDefined();
    expect(confirm.text()).toContain("移除中");

    release?.();
    await flushPromises();
    expect(removeMock).toHaveBeenCalledTimes(1);
  });
});

describe("RoleInheritanceCard：权限裁剪", () => {
  it("无 iam:role:add_parent → 不渲染选择器 / 确认按钮（父角色列表照常展示）", async () => {
    const wrapper = await mountCard("ops", [
      IAM_ROLE.VIEW_PARENTS,
      IAM_ROLE.REMOVE_PARENT,
    ]);

    expect(
      wrapper.find('[data-testid="role-inheritance-add-select"]').exists(),
    ).toBe(false);
    expect(
      wrapper.find('[data-testid="role-inheritance-add-confirm"]').exists(),
    ).toBe(false);
    expect(wrapper.findAll('[data-testid="role-inheritance-row"]')).toHaveLength(
      1,
    );
  });

  it("无 iam:role:remove_parent → 不渲染行内「移除」", async () => {
    const wrapper = await mountCard("ops", [
      IAM_ROLE.VIEW_PARENTS,
      IAM_ROLE.ADD_PARENT,
    ]);

    expect(
      wrapper.findAll('[data-testid="role-inheritance-remove"]'),
    ).toHaveLength(0);
    expect(wrapper.findAll('[data-testid="role-inheritance-row"]')).toHaveLength(
      1,
    );
  });
});
