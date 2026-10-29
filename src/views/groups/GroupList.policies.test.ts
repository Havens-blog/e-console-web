// @vitest-environment happy-dom
/**
 * GroupList 接入「策略」入口的集成测试（feat-group-policies 契约 §2.3 / §3）。
 *
 * 锁定：
 * - 行内「策略」按钮受 `iam:policy:view_group_policies` 门控（无权限**不渲染**，不靠点击报错）；
 * - 点击按钮按**当前行 groupCode** 打开只读弹窗（不串组、不用 id），载荷 offset 0 / limit 100；
 * - 弹窗**严格只读**：列表页打开的弹窗内无 input / textarea / select / submit；
 * - 弹窗 emit('close') → 关闭（group 置 null，遮罩消失）；
 * - 契约 §2.3：**不得改动既有 testid 与语义** —— 「角色」「成员」「搜索」「新建」等仍在，
 *   且与策略入口各自独立。
 *
 * 手法：mock `@/api/groups` / `@/api/roles` / `@/api/policies` + `@/router`，
 * 装配真实 groupList store；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupList from "./GroupList.vue";
import GroupPoliciesDialog from "./GroupPoliciesDialog.vue";
import { useUserStore } from "@/stores/user";
import { IAM_GROUP, IAM_POLICY } from "@/config/permission-codes";
import type { Page, TenantGroup } from "@/api/types";
import { listGroups } from "@/api/groups";
import { listPoliciesForGroup, type PolicyWithMeta } from "@/api/policies";

const listGroupsMock = vi.mocked(listGroups);
const listPoliciesMock = vi.mocked(listPoliciesForGroup);

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

vi.mock("@/api/policies", () => ({
  listPoliciesForGroup: vi.fn(),
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

function makePolicy(overrides: Partial<PolicyWithMeta> = {}): PolicyWithMeta {
  return {
    id: 2,
    code: "p1",
    name: "只读策略",
    desc: "允许只读访问",
    statements: [],
    assignmentCount: 0,
    ...overrides,
  };
}

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

type Wrapper = ReturnType<typeof mount>;

/** 挂载页面（权限码可覆盖；默认给齐策略相关码） */
async function mountPage(
  codes: readonly string[] = [IAM_GROUP.VIEW, IAM_POLICY.VIEW_GROUP_POLICIES],
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
  listPoliciesMock.mockResolvedValue(pageOf([makePolicy()]));
});

describe("GroupList：策略入口", () => {
  it("无 iam:policy:view_group_policies → 不渲染「策略」按钮（列表与其他入口不受影响）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
    ]);

    expect(wrapper.find('[data-testid="group-policies"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
    // 既有入口照旧
    expect(wrapper.findAll('[data-testid="group-roles"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="group-members"]')).toHaveLength(2);
    expect(listPoliciesMock).not.toHaveBeenCalled();
  });

  it("有权限 → 每行一个「策略」按钮（与角色 / 成员入口各自独立）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
      IAM_POLICY.VIEW_GROUP_POLICIES,
    ]);

    expect(wrapper.findAll('[data-testid="group-policies"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="group-roles"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="group-members"]')).toHaveLength(2);
  });

  it("点击第 2 行「策略」→ 按该行 groupCode 打开弹窗拉取（不串组、不用 id）", async () => {
    const wrapper = await mountPage();
    expect(listPoliciesMock).not.toHaveBeenCalled();

    await wrapper.findAll('[data-testid="group-policies"]')[1]!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="group-policies-dialog"]').exists()).toBe(
      true,
    );
    // 第 2 行是 code=ops / id=8 → 必须是 "ops"
    expect(listPoliciesMock).toHaveBeenCalledTimes(1);
    expect(listPoliciesMock).toHaveBeenCalledWith("ops", {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(wrapper.text()).toContain("运维组 · 策略");
    expect(
      wrapper.findAll('[data-testid="group-policy-row"]').length,
    ).toBeGreaterThan(0);
  });

  it("弹窗严格只读：无输入控件 / 无提交入口（契约 §2.2）", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-policies"]')[0]!.trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="group-policies-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.findAll("input")).toHaveLength(0);
    expect(dialog.findAll("textarea")).toHaveLength(0);
    expect(dialog.findAll("select")).toHaveLength(0);
    expect(dialog.findAll('button[type="submit"]')).toHaveLength(0);
    const labels = dialog.findAll("button").map((b) => b.text());
    expect(labels.join(" ")).not.toMatch(/绑定|解绑|提交|保存|分配/);
  });

  it("弹窗 emit close → 关闭（group 置 null，遮罩不再渲染）", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-policies"]')[0]!.trigger("click");
    await flushPromises();

    wrapper.findComponent(GroupPoliciesDialog).vm.$emit("close");
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="group-policies-dialog"]').exists()).toBe(
      false,
    );
  });

  it("策略 / 角色 / 成员三个弹层可并存（各按行 code，互不影响）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
      IAM_POLICY.VIEW_GROUP_POLICIES,
    ]);
    await wrapper.findAll('[data-testid="group-members"]')[0]!.trigger("click");
    await flushPromises();
    await wrapper.findAll('[data-testid="group-policies"]')[1]!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="group-members-drawer"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-testid="group-policies-dialog"]').exists()).toBe(
      true,
    );
    expect(listPoliciesMock).toHaveBeenCalledWith("ops", {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    // 成员抽屉仍持有第 1 行的 code
    expect(wrapper.text()).toContain("研发组 · 成员");
  });

  it("既有 testid 回归：搜索 / 新建 / 分页 / 角色 / 成员 / 行 全在", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ROLES,
      IAM_GROUP.MEMBERS,
      IAM_GROUP.ADD,
      IAM_POLICY.VIEW_GROUP_POLICIES,
    ]);

    for (const id of [
      "group-search",
      "group-search-submit",
      "group-search-reset",
      "group-create",
      "group-page-prev",
      "group-page-next",
      "group-page-size",
      "group-roles",
      "group-members",
      "group-policies",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
  });
});
