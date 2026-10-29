// @vitest-environment happy-dom
/**
 * 角色详情页 × 继承关系卡片集成测试（feat-role-inheritance）。
 *
 * 目的：证明新增区块**真的挂在角色详情页上**，且既有能力未被改动（Hard Rule：严禁改动
 * 详情页既有 testid 与既有功能 —— 策略绑定、用户分配等）。
 *
 * 锁定：
 * - 持有 `iam:role:view_parents` → 详情页渲染 `role-inheritance` 并按角色 code 拉取父角色；
 * - 缺 `iam:role:view_parents` → 不渲染该区块、不发父角色请求；
 * - 两种情况下既有 testid 均在：detail-role-code / detail-role-name / policy-bind /
 *   user-search-input / save-role / save-role-submit。
 *
 * 全部 api mock，**不触真实网络、不创建真实角色、不改真实继承关系**。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import RoleDetail from "./RoleDetail.vue";
import { useUserStore } from "@/stores/user";
import { IAM_POLICY, IAM_ROLE } from "@/config/permission-codes";
import type { Page, Role, User } from "@/api/types";
import type { PolicyRef, RoleInheritance } from "@/api/roles";
import {
  getRoleDetail,
  listBindablePolicies,
  listParentRoles,
  listPoliciesForRole,
  listRolesPage,
} from "@/api/roles";
import { listUsers, listUsersByRole } from "@/api/users";

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

const detailMock = vi.mocked(getRoleDetail);
const rolePoliciesMock = vi.mocked(listPoliciesForRole);
const bindableMock = vi.mocked(listBindablePolicies);
const parentsMock = vi.mocked(listParentRoles);
const rolesPageMock = vi.mocked(listRolesPage);
const usersByRoleMock = vi.mocked(listUsersByRole);

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

/** 详情页既有 testid（本轮不得因新增区块而增删） */
const EXISTING_TESTIDS = [
  "save-role",
  "save-role-submit",
  "detail-role-code",
  "detail-role-name",
  "policy-bind",
  "user-search-input",
];

beforeEach(() => {
  vi.clearAllMocks();
  detailMock.mockResolvedValue(ROLE);
  rolePoliciesMock.mockResolvedValue([{ code: "p1", name: "策略1" }]);
  bindableMock.mockResolvedValue(
    pageOf<PolicyRef>([{ code: "p1", name: "策略1" }]),
  );
  usersByRoleMock.mockResolvedValue(pageOf<User>([]));
  parentsMock.mockResolvedValue([PARENT]);
  rolesPageMock.mockResolvedValue(
    pageOf([
      ROLE,
      { ...ROLE, id: 3, code: "admin", name: "管理员", desc: "平台管理员" },
    ]),
  );
  vi.mocked(listUsers).mockResolvedValue(pageOf<User>([]));
});

describe("RoleDetail × RoleInheritanceCard", () => {
  it("持 view_parents → 详情页渲染继承区块，按角色 code 拉取父角色并展示名称", async () => {
    const wrapper = await mountDetail([
      IAM_ROLE.VIEW_PARENTS,
      IAM_ROLE.ADD_PARENT,
      IAM_ROLE.REMOVE_PARENT,
      IAM_ROLE.EDIT,
      IAM_POLICY.BATCH_ATTACH,
      IAM_ROLE.BATCH_ASSIGN,
    ]);

    expect(wrapper.find('[data-testid="role-inheritance"]').exists()).toBe(true);
    expect(parentsMock).toHaveBeenCalledWith("ops");

    const row = wrapper.find(
      '[data-testid="role-inheritance-row"][data-role-code="admin"]',
    );
    expect(row.exists()).toBe(true);
    expect(row.text()).toContain("管理员");
    expect(row.text()).toContain("直接");

    // 既有能力仍在（策略绑定 / 用户分配 / 保存入口）
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

  it("缺 view_parents → 不渲染继承区块、不请求父角色；既有 testid 不受影响", async () => {
    const wrapper = await mountDetail([
      IAM_ROLE.EDIT,
      IAM_POLICY.BATCH_ATTACH,
      IAM_ROLE.BATCH_ASSIGN,
    ]);

    expect(wrapper.find('[data-testid="role-inheritance"]').exists()).toBe(false);
    expect(parentsMock).not.toHaveBeenCalled();
    expect(rolesPageMock).not.toHaveBeenCalled();

    for (const id of EXISTING_TESTIDS) {
      expect(
        wrapper.find(`[data-testid="${id}"]`).exists(),
        `既有 testid 缺失：${id}`,
      ).toBe(true);
    }
  });
});
