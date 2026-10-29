// @vitest-environment happy-dom
/**
 * 用户详情页 × 权限来源面板集成测试（feat-user-permission-sources 契约 §2.3 / §3）。
 *
 * 目的：证明面板**真的挂在用户详情页上**，且详情页既有 testid / 既有功能零改动
 * （Hard Rule：严禁改动详情页既有 testid 与既有功能）。
 *
 * 锁定：
 * - 持四枚 view_user_* 码 → 详情页渲染 `user-permission-sources`，四区块按用户 id 各拉一次；
 * - 缺这些码 → 面板不渲染、零请求；既有 testid（用户名 / 状态 / 角色绑定 / passkey / 保存）
 *   两种情况下都在；
 * - 单个区块接口失败 → 该区块错误态，其余区块照常渲染（详情页不因面板局部失败而垮）。
 *
 * 全部 api mock，**不触真实网络、不读写任何真实用户数据**。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import UserDetail from "./UserDetail.vue";
import { useUserStore } from "@/stores/user";
import { ApiError, type RoleRef, type User } from "@/api/types";
import {
  IAM_GROUP,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
} from "@/config/permission-codes";
import { getUserDetail, listRoles } from "@/api/users";
import { listRolesForUser } from "@/api/roles";
import { listGroupsForUser } from "@/api/groups";
import { listPoliciesForUser } from "@/api/policies";
import { listTenantsForUser } from "@/api/tenants";

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRoute: () => ({ params: { id: "7" } }),
    useRouter: () => ({ push: vi.fn() }),
    onBeforeRouteLeave: vi.fn(),
  };
});

// 详情页既有数据源
vi.mock("@/api/users", () => ({
  getUserDetail: vi.fn(),
  listRoles: vi.fn(),
}));

// 「权限来源」四接口
vi.mock("@/api/roles", () => ({ listRolesForUser: vi.fn() }));
vi.mock("@/api/groups", () => ({ listGroupsForUser: vi.fn() }));
vi.mock("@/api/policies", () => ({ listPoliciesForUser: vi.fn() }));
vi.mock("@/api/tenants", () => ({ listTenantsForUser: vi.fn() }));

const fakeListStore = {
  error: null as string | null,
  loadUserRoles: vi.fn(),
  update: vi.fn(),
};

vi.mock("@/stores/userList", () => ({
  useUserListStore: () => fakeListStore,
}));

const detailMock = vi.mocked(getUserDetail);
const rolesListMock = vi.mocked(listRoles);
const userRolesMock = vi.mocked(listRolesForUser);
const groupsMock = vi.mocked(listGroupsForUser);
const policiesMock = vi.mocked(listPoliciesForUser);
const tenantsMock = vi.mocked(listTenantsForUser);

const USER: User = {
  id: 7,
  username: "alice",
  displayName: "Alice",
  tenantId: 1,
  roles: [],
  status: "active",
  loginMethod: "password",
  passkeyRegistered: false,
};

const ROLE_REF: RoleRef = { id: 3, code: "admin", name: "管理员" };

/** 面板四枚权限码 */
const SOURCE_CODES: string[] = [
  IAM_ROLE.VIEW_USER_ROLES,
  IAM_GROUP.VIEW_USER_GROUPS,
  IAM_POLICY.VIEW_USER_POLICIES,
  IAM_TENANT.VIEW_USER_TENANTS,
];

/** 详情页既有能力的权限码（编辑 / 角色绑定），与面板无关 */
const EXISTING_CODES: string[] = [IAM_USER.EDIT, IAM_ROLE.BATCH_ASSIGN];

/** 详情页既有 testid（本轮不得因新增面板而增删） */
const EXISTING_TESTIDS = [
  "detail-username",
  "detail-status",
  "role-bind",
  "passkey-block",
  "save-user",
];

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

type Wrapper = ReturnType<typeof mount>;

async function mountDetail(permissions: readonly string[]): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    ...permissions,
  ];
  (
    userStore as unknown as {
      tenants: { id: number; name: string; code: string; domain: string }[];
    }
  ).tenants = [{ id: 1, name: "t1", code: "t1", domain: "" }];

  const wrapper = mount(UserDetail);
  await flushPromises();
  // 详情加载完成后 panel 才挂载（v-if="user"）→ 再冲刷一次其区块请求
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  detailMock.mockResolvedValue(USER);
  rolesListMock.mockResolvedValue({ total: 1, items: [ROLE_REF] });
  fakeListStore.loadUserRoles.mockResolvedValue([ROLE_REF]);
  userRolesMock.mockResolvedValue([
    {
      id: 3,
      code: "admin",
      name: "管理员",
      desc: "平台管理员",
      tenantId: 0,
      policies: [],
      users: [],
    },
  ]);
  groupsMock.mockResolvedValue([
    { id: 5, name: "运维组", code: "ops", desc: "运维" },
  ]);
  policiesMock.mockResolvedValue({
    total: 1,
    items: [{ id: 2, code: "p1", name: "策略1", statements: [] }],
  });
  tenantsMock.mockResolvedValue({
    total: 1,
    items: [
      { id: 1, name: "系统租户", code: "system", domain: "", status: "active" },
    ],
  });
});

describe("UserDetail × UserPermissionSources", () => {
  it("持四枚 view_user_* 码 → 面板挂在详情页内，四区块按用户 id 拉取并渲染条目", async () => {
    const wrapper = await mountDetail([...EXISTING_CODES, ...SOURCE_CODES]);

    // 真挂在页面根节点内（不是孤立组件）
    expect(
      wrapper
        .find('.page-user-detail [data-testid="user-permission-sources"]')
        .exists(),
    ).toBe(true);

    expect(userRolesMock).toHaveBeenCalledWith(7);
    expect(groupsMock).toHaveBeenCalledWith(7);
    expect(policiesMock).toHaveBeenCalledWith(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(tenantsMock).toHaveBeenCalledWith(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });

    expect(wrapper.findAll('[data-testid="ups-role-item"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="ups-group-item"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="ups-policy-item"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="ups-tenant-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain("管理员");
    expect(wrapper.text()).toContain("运维组");
    expect(wrapper.text()).toContain("策略1");
    expect(wrapper.text()).toContain("系统租户");

    // 既有 testid 与既有功能不受影响
    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
    expect(
      (wrapper.find('[data-testid="detail-username"]').element as HTMLInputElement)
        .value,
    ).toBe("alice");
  });

  it("缺四码 → 面板不渲染、四接口零请求；既有 testid 不受影响", async () => {
    const wrapper = await mountDetail(EXISTING_CODES);

    expect(
      wrapper.find('[data-testid="user-permission-sources"]').exists(),
    ).toBe(false);
    expect(userRolesMock).not.toHaveBeenCalled();
    expect(groupsMock).not.toHaveBeenCalled();
    expect(policiesMock).not.toHaveBeenCalled();
    expect(tenantsMock).not.toHaveBeenCalled();

    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
  });

  it("面板单区块失败 → 该区块错误态，其余区块与详情页既有内容照常", async () => {
    userRolesMock.mockRejectedValue(
      new ApiError("forbidden", "无权查看用户角色"),
    );
    const wrapper = await mountDetail([...EXISTING_CODES, ...SOURCE_CODES]);

    const panel = wrapper.find('[data-testid="user-permission-sources"]');
    expect(panel.exists()).toBe(true);
    expect(panel.find('[data-testid="ups-roles-error"]').text()).toContain(
      "无权查看用户角色",
    );
    // 其它区块照常
    expect(wrapper.findAll('[data-testid="ups-group-item"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="ups-policy-item"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-testid="ups-tenant-item"]')).toHaveLength(1);
    // 详情页骨架与既有入口不受影响
    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
  });
});
