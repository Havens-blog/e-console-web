// @vitest-environment happy-dom
/**
 * GroupList 接入角色弹窗的集成测试（feat-group-roles 契约 §2.3 / §3）。
 *
 * 锁定：
 * - 行内「角色」按钮受 `iam:group:roles` 门控（无权限不渲染，不靠点击报错）；
 * - 点击按钮按**当前行 groupCode** 打开弹窗并拉取该组已绑角色（不串组、不用 id）；
 * - 契约 §2.3：角色不影响组字段 → 弹窗 emit('changed') **不**触发组列表重查；
 * - 弹窗 emit('close') → 关闭（group 置 null，遮罩消失）；
 * - 既有 testid / 筛选语义 / 成员入口未被改动。
 *
 * 手法：mock `@/api/groups`（含角色三接口）+ `@/api/roles` + `@/router`，
 * 装配真实 groupList store；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupList from "./GroupList.vue";
import GroupRolesDialog from "./GroupRolesDialog.vue";
import { useUserStore } from "@/stores/user";
import { useGroupListStore } from "@/stores/groupList";
import { IAM_GROUP } from "@/config/permission-codes";
import type { Page, TenantGroup } from "@/api/types";
import type { TenantGroupRole } from "@/api/groups";
import { listGroupRoles, listGroups } from "@/api/groups";
import { listRolesPage } from "@/api/roles";

const listGroupsMock = vi.mocked(listGroups);
const listRolesOfGroupMock = vi.mocked(listGroupRoles);
const listRolesMock = vi.mocked(listRolesPage);

vi.mock("@/api/groups", () => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listGroupMembers: vi.fn(),
  assignGroupMembers: vi.fn(),
  removeGroupMembers: vi.fn(),
  listGroupRoles: vi.fn(),
  assignGroupRole: vi.fn(),
  removeGroupRole: vi.fn(),
}));

vi.mock("@/api/roles", () => ({
  listRolesPage: vi.fn(),
}));

// ---- router 模块替身（groupList store 依赖 registerUnauthorizedReset）----
vi.mock("@/router", () => ({
  registerUnauthorizedReset: vi.fn(),
  router: {},
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeGroup(overrides: Partial<TenantGroup> = {}): TenantGroup {
  return {
    id: 7,
    name: "研发组",
    code: "rd",
    desc: "",
    ctime: 1730000000000,
    ...overrides,
  };
}

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

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

type Wrapper = ReturnType<typeof mount>;

/** 挂载页面（权限码可覆盖；默认给齐角色相关码） */
async function mountPage(
  codes: readonly string[] = [
    IAM_GROUP.VIEW,
    IAM_GROUP.ROLES,
    IAM_GROUP.ASSIGN_ROLE,
    IAM_GROUP.REMOVE_ROLE,
  ],
): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [...codes];
  const wrapper = mount(GroupList);
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  listGroupsMock.mockResolvedValue(
    pageOf([
      makeGroup({ id: 7, name: "研发组", code: "rd" }),
      makeGroup({ id: 8, name: "运维组", code: "ops" }),
    ]),
  );
  listRolesOfGroupMock.mockResolvedValue([makeBoundRole()]);
  listRolesMock.mockResolvedValue(pageOf([]));
});

describe("GroupList：角色入口", () => {
  it("无 iam:group:roles → 不渲染「角色」按钮（列表与其他按钮不受影响）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.EDIT,
      IAM_GROUP.DELETE,
    ]);

    expect(wrapper.find('[data-testid="group-roles"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
    expect(wrapper.find('[data-testid="group-edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="group-delete"]').exists()).toBe(true);
  });

  it("有权限 → 每行都有「角色」按钮（与成员入口各自独立）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
    ]);
    expect(wrapper.findAll('[data-testid="group-roles"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="group-members"]')).toHaveLength(2);
  });

  it("点击第 2 行的「角色」→ 按该行 groupCode 打开弹窗拉取（不串组、不用 id）", async () => {
    const wrapper = await mountPage();
    expect(listRolesOfGroupMock).not.toHaveBeenCalled();

    await wrapper.findAll('[data-testid="group-roles"]')[1]!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      true,
    );
    // 第 2 行是 code=ops / id=8 → 必须是 "ops"
    expect(listRolesOfGroupMock).toHaveBeenCalledTimes(1);
    expect(listRolesOfGroupMock).toHaveBeenCalledWith("ops");
    expect(wrapper.text()).toContain("运维组 · 角色");
  });

  it("弹窗 emit changed → 不刷新组列表（角色不影响组字段，契约 §2.3）", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-roles"]')[0]!.trigger("click");
    await flushPromises();

    const store = useGroupListStore();
    const fetchSpy = vi.spyOn(store, "fetch");
    fetchSpy.mockClear();

    wrapper.findComponent(GroupRolesDialog).vm.$emit("changed");
    await wrapper.vm.$nextTick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("弹窗 emit close → 关闭（group 置 null，遮罩不再渲染）", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-roles"]')[0]!.trigger("click");
    await flushPromises();

    wrapper.findComponent(GroupRolesDialog).vm.$emit("close");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      false,
    );
  });

  it("既有入口未被改动：搜索 / 新建 / 分页 / 成员 testid 仍在", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
      IAM_GROUP.ADD,
    ]);
    for (const id of [
      "group-search",
      "group-search-submit",
      "group-search-reset",
      "group-create",
      "group-page-prev",
      "group-page-next",
      "group-page-size",
      "group-members",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
  });
});

describe("GroupList：角色弹窗与成员抽屉并存", () => {
  it("成员抽屉打开时再开角色弹窗 → 两者互不影响（各自按行 code）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
    ]);
    await wrapper.findAll('[data-testid="group-members"]')[0]!.trigger("click");
    await flushPromises();
    await wrapper.findAll('[data-testid="group-roles"]')[1]!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="group-members-drawer"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="group-roles-dialog"]').exists()).toBe(
      true,
    );
    expect(listRolesOfGroupMock).toHaveBeenCalledWith("ops");
    // 成员抽屉仍持有第 1 行的 code
    expect(wrapper.text()).toContain("研发组 · 成员");
  });
});
