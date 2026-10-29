// @vitest-environment happy-dom
/**
 * 角色详情页 × 关联用户组区块集成测试（feat-role-bound-groups 契约 §3「集成」）。
 *
 * 目的：证明新增区块**真的挂在角色详情页上**，且既有能力未被改动（Hard Rule：
 * 严禁改动详情页既有 testid 与既有功能 —— 策略绑定、用户分配、继承关系、保存入口）。
 *
 * 锁定：
 * - 持有 `iam:group:view_role_groups` → 详情页渲染 `role-bound-groups`，
 *   并按**角色 code**（路由参数）拉取关联用户组；
 * - 缺该码 → 不渲染该区块、不发该请求；
 * - 两种情况下既有 testid 均在：save-role / save-role-submit / detail-role-code /
 *   detail-role-name / policy-bind / user-search-input / role-inheritance。
 *
 * 全部 api mock，**不触真实网络、不创建真实角色、不改任何真实绑定**。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import RoleDetail from "./RoleDetail.vue";
import { useUserStore } from "@/stores/user";
import { IAM_GROUP, IAM_POLICY, IAM_ROLE } from "@/config/permission-codes";
import type { Page, Role, TenantGroup, User } from "@/api/types";
import type { PolicyRef, RoleInheritance } from "@/api/roles";
import {
  getRoleDetail,
  listBindablePolicies,
  listParentRoles,
  listPoliciesForRole,
  listRolesPage,
} from "@/api/roles";
import { listUsers, listUsersByRole } from "@/api/users";
import { listGroupsForRole } from "@/api/groups";

vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return {
    ...actual,
    useRoute: () => ({ params: { id: "ops" } }),
    useRouter: () => ({ push: vi.fn() }),
    onBeforeRouteLeave: vi.fn(),
  };
});

vi.mock("@/api/roles", () => ({
  getRoleDetail: vi.fn(),
  listPoliciesForRole: vi.fn(),
  listBindablePolicies: vi.fn(),
  listParentRoles: vi.fn(),
  listRolesPage: vi.fn(),
  addParentRole: vi.fn(),
  removeParentRole: vi.fn(),
}));

vi.mock("@/api/users", () => ({
  listUsers: vi.fn(),
  listUsersByRole: vi.fn(),
}));

vi.mock("@/api/groups", () => ({ listGroupsForRole: vi.fn() }));

const detailMock = vi.mocked(getRoleDetail);
const rolePoliciesMock = vi.mocked(listPoliciesForRole);
const bindableMock = vi.mocked(listBindablePolicies);
const parentsMock = vi.mocked(listParentRoles);
const rolesPageMock = vi.mocked(listRolesPage);
const usersByRoleMock = vi.mocked(listUsersByRole);
const boundGroupsMock = vi.mocked(listGroupsForRole);

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

const ROLE: Role = {
  id: 9,
  code: "ops",
  name: "运维角色",
  desc: "运维职责",
  tenantId: 0,
  policies: [],
  users: [],
};

const PARENT: RoleInheritance = {
  code: "admin",
  isDirect: true,
  isImmutable: false,
};

const GROUP: TenantGroup = {
  id: 5,
  name: "运维组",
  code: "ops-group",
  desc: "负责日常运维",
};

/** 详情页既有 testid（本轮不得因新增区块而增删） */
const EXISTING_TESTIDS = [
  "save-role",
  "save-role-submit",
  "detail-role-code",
  "detail-role-name",
  "policy-bind",
  "user-search-input",
  "role-inheritance",
];

const BASE_PERMISSIONS: string[] = [
  IAM_ROLE.EDIT,
  IAM_ROLE.VIEW_PARENTS,
  IAM_ROLE.ADD_PARENT,
  IAM_ROLE.REMOVE_PARENT,
  IAM_POLICY.BATCH_ATTACH,
  IAM_ROLE.BATCH_ASSIGN,
];

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

type Wrapper = ReturnType<typeof mount>;

async function mountDetail(permissions: string[]): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = permissions;
  const wrapper = mount(RoleDetail);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  detailMock.mockResolvedValue(ROLE);
  rolePoliciesMock.mockResolvedValue([{ code: "p1", name: "策略1" }]);
  bindableMock.mockResolvedValue(
    pageOf<PolicyRef>([{ code: "p1", name: "策略1" }]),
  );
  usersByRoleMock.mockResolvedValue(pageOf<User>([]));
  parentsMock.mockResolvedValue([PARENT]);
  rolesPageMock.mockResolvedValue(pageOf([ROLE]));
  vi.mocked(listUsers).mockResolvedValue(pageOf<User>([]));
  boundGroupsMock.mockResolvedValue({ total: 1, items: [GROUP] });
});

describe("RoleDetail × RoleBoundGroupsCard", () => {
  it("持 view_role_groups → 渲染关联用户组区块，按角色 code 拉取并展示组名/标识码/描述", async () => {
    const wrapper = await mountDetail([
      ...BASE_PERMISSIONS,
      IAM_GROUP.VIEW_ROLE_GROUPS,
    ]);

    const block = wrapper.find('[data-testid="role-bound-groups"]');
    expect(block.exists()).toBe(true);
    expect(boundGroupsMock).toHaveBeenCalledTimes(1);
    expect(boundGroupsMock).toHaveBeenCalledWith("ops", {
      offset: 0,
      limit: 100,
      keyword: "",
    });

    const items = wrapper.findAll('[data-testid="role-bound-group-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toContain("运维组");
    expect(items[0]!.text()).toContain("ops-group");
    expect(items[0]!.text()).toContain("负责日常运维");

    // 既有能力仍在（继承 / 策略绑定 / 用户分配 / 保存入口）
    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
    expect(
      (wrapper.find('[data-testid="detail-role-code"]').element as HTMLInputElement)
        .value,
    ).toBe("ops");
  });

  it("缺 view_role_groups → 不渲染区块、不发请求；既有 testid 与继承区块不受影响", async () => {
    const wrapper = await mountDetail(BASE_PERMISSIONS);

    expect(wrapper.find('[data-testid="role-bound-groups"]').exists()).toBe(false);
    expect(boundGroupsMock).not.toHaveBeenCalled();

    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
    // 继承区块照常工作（本轮未改其挂载条件）
    expect(parentsMock).toHaveBeenCalledWith("ops");
  });

  it("关联用户组为空 → 详情页展示空态文案，其余区块正常", async () => {
    boundGroupsMock.mockResolvedValue({ total: 0, items: [] });
    const wrapper = await mountDetail([
      ...BASE_PERMISSIONS,
      IAM_GROUP.VIEW_ROLE_GROUPS,
    ]);

    const empty = wrapper.find('[data-testid="role-bound-groups-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toBe("该角色未被任何用户组关联");
    expect(wrapper.findAll('[data-testid="role-bound-group-item"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="role-inheritance"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-role"]').exists()).toBe(true);
  });

  it("区块加载失败 → 错误态 + 重试；详情页其它功能仍可用", async () => {
    boundGroupsMock.mockRejectedValue(new Error("network down"));
    const wrapper = await mountDetail([
      ...BASE_PERMISSIONS,
      IAM_GROUP.VIEW_ROLE_GROUPS,
    ]);

    const error = wrapper.find('[data-testid="role-bound-groups-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("network down");
    expect(wrapper.find('[data-testid="save-role"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="role-inheritance"]').exists()).toBe(true);
  });
});
