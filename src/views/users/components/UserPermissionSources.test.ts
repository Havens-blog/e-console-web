// @vitest-environment happy-dom
/**
 * UserPermissionSources 组件行为测试（feat-user-permission-sources 契约 §2.2 / §3）。
 *
 * 全部 api mock，**不触真实网络、不读写任何真实用户数据**（面板纯只读）。
 *
 * 锁定用户可观察行为：
 * - 四个区块（角色 / 分组 / 策略 / 所属租户）各自渲染条目、各自独立空态；
 * - 错误为**区块级**：一个区块失败 → 仅该区块显示 `ups-<section>-error` + 重试，
 *   其余区块照常渲染条目（独立降级，不共用一个 loading / 一个全局 error）；
 * - 重试只重拉该区块（其它区块的调用次数不变），成功后恢复条目；
 * - 缺某个权限码 → 该区块**不渲染且不发请求**；四码全缺 → 整卡不渲染、零请求；
 * - 严格只读：面板内没有任何输入控件 / 表单 / 增删改按钮（唯一的按钮是错误态「重试」）。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import UserPermissionSources from "./UserPermissionSources.vue";
import { useUserStore } from "@/stores/user";
import {
  IAM_GROUP,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
} from "@/config/permission-codes";
import { ApiError, type Role, type Tenant, type TenantGroup } from "@/api/types";
import type { PolicyWithMeta } from "@/api/policies";
import { listRolesForUser } from "@/api/roles";
import { listGroupsForUser } from "@/api/groups";
import { listPoliciesForUser } from "@/api/policies";
import { listTenantsForUser } from "@/api/tenants";

vi.mock("@/api/roles", () => ({ listRolesForUser: vi.fn() }));
vi.mock("@/api/groups", () => ({ listGroupsForUser: vi.fn() }));
vi.mock("@/api/policies", () => ({ listPoliciesForUser: vi.fn() }));
vi.mock("@/api/tenants", () => ({ listTenantsForUser: vi.fn() }));

const rolesMock = vi.mocked(listRolesForUser);
const groupsMock = vi.mocked(listGroupsForUser);
const policiesMock = vi.mocked(listPoliciesForUser);
const tenantsMock = vi.mocked(listTenantsForUser);

/** 四区块的权限码（顺序与面板一致） */
const ALL_PERMISSIONS: string[] = [
  IAM_ROLE.VIEW_USER_ROLES,
  IAM_GROUP.VIEW_USER_GROUPS,
  IAM_POLICY.VIEW_USER_POLICIES,
  IAM_TENANT.VIEW_USER_TENANTS,
];

const ROLE: Role = {
  id: 3,
  code: "admin",
  name: "管理员",
  desc: "平台管理员",
  tenantId: 0,
  policies: [],
  users: [],
};

const GROUP: TenantGroup = {
  id: 5,
  name: "运维组",
  code: "ops",
  desc: "运维",
};

const POLICY: PolicyWithMeta = {
  id: 2,
  code: "p1",
  name: "策略1",
  statements: [],
};

const TENANT: Tenant = {
  id: 1,
  name: "系统租户",
  code: "system",
  domain: "",
  status: "active",
  userCount: 5,
  maxUsers: 50,
};

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

type Wrapper = ReturnType<typeof mount>;

async function mountPanel(
  permissions: readonly string[] = ALL_PERMISSIONS,
  userId = 1,
): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    ...permissions,
  ];
  const wrapper = mount(UserPermissionSources, { props: { userId } });
  await flushPromises();
  return wrapper;
}

function byTestId(wrapper: Wrapper, id: string): ReturnType<Wrapper["find"]> {
  return wrapper.find(`[data-testid="${id}"]`);
}

function allText(wrapper: Wrapper): string {
  return wrapper.text();
}

/** 每个区块的 {区块 testid, 条目 testid, 空态 testid, 错误 testid} */
const SECTIONS = [
  {
    key: "roles",
    block: "ups-roles",
    item: "ups-role-item",
    empty: "ups-roles-empty",
    error: "ups-roles-error",
    title: "角色",
    code: IAM_ROLE.VIEW_USER_ROLES,
    mock: rolesMock,
  },
  {
    key: "groups",
    block: "ups-groups",
    item: "ups-group-item",
    empty: "ups-groups-empty",
    error: "ups-groups-error",
    title: "分组",
    code: IAM_GROUP.VIEW_USER_GROUPS,
    mock: groupsMock,
  },
  {
    key: "policies",
    block: "ups-policies",
    item: "ups-policy-item",
    empty: "ups-policies-empty",
    error: "ups-policies-error",
    title: "策略",
    code: IAM_POLICY.VIEW_USER_POLICIES,
    mock: policiesMock,
  },
  {
    key: "tenants",
    block: "ups-tenants",
    item: "ups-tenant-item",
    empty: "ups-tenants-empty",
    error: "ups-tenants-error",
    title: "所属租户",
    code: IAM_TENANT.VIEW_USER_TENANTS,
    mock: tenantsMock,
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  rolesMock.mockResolvedValue([ROLE]);
  groupsMock.mockResolvedValue([GROUP]);
  policiesMock.mockResolvedValue({ total: 1, items: [POLICY] });
  tenantsMock.mockResolvedValue({ total: 1, items: [TENANT] });
});

describe("UserPermissionSources：四区块渲染", () => {
  it("四区块均渲染并按 userId 各发一次请求；条目展示名称 + 标识码", async () => {
    const wrapper = await mountPanel();

    expect(byTestId(wrapper, "user-permission-sources").exists()).toBe(true);

    expect(rolesMock).toHaveBeenCalledTimes(1);
    expect(rolesMock).toHaveBeenCalledWith(1);
    expect(groupsMock).toHaveBeenCalledWith(1);
    expect(policiesMock).toHaveBeenCalledWith(1, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(tenantsMock).toHaveBeenCalledWith(1, {
      offset: 0,
      limit: 100,
      keyword: "",
    });

    for (const s of SECTIONS) {
      expect(byTestId(wrapper, s.block).exists(), `缺区块 ${s.block}`).toBe(true);
      expect(byTestId(wrapper, s.block).text()).toContain(s.title);
      expect(
        wrapper.findAll(`[data-testid="${s.item}"]`).length,
        `缺条目 ${s.item}`,
      ).toBe(1);
    }

    expect(wrapper.text()).toContain("管理员");
    expect(wrapper.text()).toContain("admin");
    expect(wrapper.text()).toContain("运维组");
    expect(wrapper.text()).toContain("策略1");
    expect(wrapper.text()).toContain("系统租户");
    // 租户区块复用既有用量口径（用户 5 / 50）
    expect(byTestId(wrapper, "ups-tenants").text()).toContain("用户 5 / 50");
    // 不出现任何空态 / 错误态
    for (const s of SECTIONS) {
      expect(byTestId(wrapper, s.empty).exists()).toBe(false);
      expect(byTestId(wrapper, s.error).exists()).toBe(false);
    }
  });

  it("四区块各自独立空态（文案按区块区分，条目为零）", async () => {
    rolesMock.mockResolvedValue([]);
    groupsMock.mockResolvedValue([]);
    policiesMock.mockResolvedValue({ total: 0, items: [] });
    tenantsMock.mockResolvedValue({ total: 0, items: [] });

    const wrapper = await mountPanel();

    for (const s of SECTIONS) {
      expect(byTestId(wrapper, s.empty).exists(), `缺空态 ${s.empty}`).toBe(true);
      expect(wrapper.findAll(`[data-testid="${s.item}"]`)).toHaveLength(0);
    }
    expect(byTestId(wrapper, "ups-roles-empty").text()).toContain("该用户未分配角色");
    expect(byTestId(wrapper, "ups-groups-empty").text()).toContain(
      "该用户未加入任何分组",
    );
    expect(byTestId(wrapper, "ups-policies-empty").text()).toContain(
      "该用户无直接绑定的策略",
    );
    expect(byTestId(wrapper, "ups-tenants-empty").text()).toContain(
      "该用户不属于任何租户",
    );
  });
});

describe("UserPermissionSources：区块级错误与独立降级", () => {
  it("角色区块失败 → 仅角色显示错误态，其余三区块照常渲染条目", async () => {
    rolesMock.mockRejectedValue(new ApiError("forbidden", "无权查看用户角色"));

    const wrapper = await mountPanel();

    const roleError = byTestId(wrapper, "ups-roles-error");
    expect(roleError.exists()).toBe(true);
    expect(roleError.text()).toContain("无权查看用户角色");
    // 失败区块不渲染条目/空态
    expect(wrapper.findAll('[data-testid="ups-role-item"]')).toHaveLength(0);
    expect(byTestId(wrapper, "ups-roles-empty").exists()).toBe(false);

    // 其余三区块不受影响（独立降级）
    for (const key of ["groups", "policies", "tenants"] as const) {
      const s = SECTIONS.find((x) => x.key === key)!;
      expect(byTestId(wrapper, s.error).exists()).toBe(false);
      expect(wrapper.findAll(`[data-testid="${s.item}"]`)).toHaveLength(1);
    }
  });

  it("重试只重拉失败区块，且成功后恢复条目（其它区块请求次数不变）", async () => {
    rolesMock.mockRejectedValue(new ApiError("unavailable", "网络异常"));
    const wrapper = await mountPanel();
    expect(byTestId(wrapper, "ups-roles-error").exists()).toBe(true);
    expect(groupsMock).toHaveBeenCalledTimes(1);
    expect(policiesMock).toHaveBeenCalledTimes(1);
    expect(tenantsMock).toHaveBeenCalledTimes(1);

    rolesMock.mockResolvedValue([ROLE]);
    await byTestId(wrapper, "ups-roles-error").find("button").trigger("click");
    await flushPromises();

    expect(rolesMock).toHaveBeenCalledTimes(2);
    expect(byTestId(wrapper, "ups-roles-error").exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="ups-role-item"]')).toHaveLength(1);
    // 其它区块没有因角色重试而被重拉
    expect(groupsMock).toHaveBeenCalledTimes(1);
    expect(policiesMock).toHaveBeenCalledTimes(1);
    expect(tenantsMock).toHaveBeenCalledTimes(1);
  });

  it("四区块同时失败 → 四条独立错误各自可重试（互不覆盖）", async () => {
    rolesMock.mockRejectedValue(new ApiError("forbidden", "角色无权限"));
    groupsMock.mockRejectedValue(new ApiError("forbidden", "分组无权限"));
    policiesMock.mockRejectedValue(new ApiError("forbidden", "策略无权限"));
    tenantsMock.mockRejectedValue(new ApiError("forbidden", "租户无权限"));

    const wrapper = await mountPanel();

    expect(byTestId(wrapper, "ups-roles-error").text()).toContain("角色无权限");
    expect(byTestId(wrapper, "ups-groups-error").text()).toContain("分组无权限");
    expect(byTestId(wrapper, "ups-policies-error").text()).toContain(
      "策略无权限",
    );
    expect(byTestId(wrapper, "ups-tenants-error").text()).toContain("租户无权限");

    // 只修好分组 → 只有分组错误消失，其余三条错误仍在
    groupsMock.mockResolvedValue([GROUP]);
    await byTestId(wrapper, "ups-groups-error").find("button").trigger("click");
    await flushPromises();

    expect(byTestId(wrapper, "ups-groups-error").exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="ups-group-item"]')).toHaveLength(1);
    expect(byTestId(wrapper, "ups-roles-error").exists()).toBe(true);
    expect(byTestId(wrapper, "ups-policies-error").exists()).toBe(true);
    expect(byTestId(wrapper, "ups-tenants-error").exists()).toBe(true);
  });
});

describe("UserPermissionSources：权限码裁剪", () => {
  it("四码全缺 → 整卡不渲染、零请求", async () => {
    const wrapper = await mountPanel([]);

    expect(byTestId(wrapper, "user-permission-sources").exists()).toBe(false);
    expect(rolesMock).not.toHaveBeenCalled();
    expect(groupsMock).not.toHaveBeenCalled();
    expect(policiesMock).not.toHaveBeenCalled();
    expect(tenantsMock).not.toHaveBeenCalled();
  });

  it.each(SECTIONS.map((s) => [s.key, s] as const))(
    "缺 %s 的权限码 → 该区块不渲染且不发请求，其余三区块正常",
    async (_key, section) => {
      const permissions = ALL_PERMISSIONS.filter((c) => c !== section.code);
      const wrapper = await mountPanel(permissions);

      expect(byTestId(wrapper, section.block).exists()).toBe(false);
      expect(section.mock).not.toHaveBeenCalled();

      for (const other of SECTIONS.filter((s) => s.key !== section.key)) {
        expect(byTestId(wrapper, other.block).exists()).toBe(true);
        expect(other.mock).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("userId 非法（0）→ 整卡不渲染且不发任何请求（详情页未加载完的防御）", async () => {
    const wrapper = await mountPanel(ALL_PERMISSIONS, 0);

    expect(
      wrapper.find('[data-testid="user-permission-sources"]').exists(),
    ).toBe(false);
    expect(rolesMock).not.toHaveBeenCalled();
    expect(groupsMock).not.toHaveBeenCalled();
    expect(policiesMock).not.toHaveBeenCalled();
    expect(tenantsMock).not.toHaveBeenCalled();
  });
});

describe("UserPermissionSources：严格只读", () => {
  it("面板内无输入控件 / 表单 / 增删改入口（成功态零按钮）", async () => {
    const wrapper = await mountPanel();
    const panel = byTestId(wrapper, "user-permission-sources");

    expect(panel.findAll("input")).toHaveLength(0);
    expect(panel.findAll("textarea")).toHaveLength(0);
    expect(panel.findAll("select")).toHaveLength(0);
    expect(panel.findAll("form")).toHaveLength(0);
    // 成功态唯一可能的按钮是错误态的「重试」——此处不应有任何按钮
    expect(panel.findAll("button")).toHaveLength(0);
    // 文案层面也不出现写操作动词（只读提示里的「变更请到对应管理页」不算入口）
    for (const word of ["添加", "新建", "编辑", "删除", "移除", "绑定", "解绑"]) {
      expect(allText(wrapper)).not.toContain(word);
    }
  });

  it("错误态下唯一的按钮是「重试」", async () => {
    rolesMock.mockRejectedValue(new ApiError("forbidden", "无权限"));
    const wrapper = await mountPanel();
    const panel = byTestId(wrapper, "user-permission-sources");

    const buttons = panel.findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text()).toBe("重试");
    // 重试按钮不得触发表单提交（可能在详情页表单上下文内）
    expect(buttons[0]!.attributes("type")).toBe("button");
  });
});
