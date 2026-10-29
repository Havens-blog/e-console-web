// @vitest-environment happy-dom
/**
 * GroupList 接入成员抽屉的集成测试（feat-group-members 契约 §2.3 / §3）。
 *
 * 锁定：
 * - 行内「成员」按钮受 iam:group:members 门控（无权限不渲染，不靠点击报错）；
 * - 点击按钮打开抽屉，并按**当前行 groupCode** 拉取成员（不串组、不用 id）；
 * - 抽屉 emit('changed') → 父级调用 store.fetch() 刷新用户组列表；
 * - 抽屉 emit('close') → 关闭（group 置 null）；
 * - 既有 testid / 筛选语义 / 新建/编辑/删除逻辑未被改动。
 *
 * 手法：mock `@/api/groups` 七接口 + `@/router`（store 依赖 registerUnauthorizedReset），
 * 装配真实 groupList store；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupList from "./GroupList.vue";
import GroupMembersDrawer from "./GroupMembersDrawer.vue";
import { useUserStore } from "@/stores/user";
import { useGroupListStore } from "@/stores/groupList";
import { IAM_GROUP } from "@/config/permission-codes";
import type { Page, TenantGroup } from "@/api/types";
import type { GroupMember } from "@/api/groups";
import { listGroupMembers, listGroups } from "@/api/groups";

const listGroupsMock = vi.mocked(listGroups);
const listMembersMock = vi.mocked(listGroupMembers);

vi.mock("@/api/groups", () => ({
  listGroups: vi.fn(),
  createGroup: vi.fn(),
  updateGroup: vi.fn(),
  deleteGroup: vi.fn(),
  listGroupMembers: vi.fn(),
  assignGroupMembers: vi.fn(),
  removeGroupMembers: vi.fn(),
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

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

/** 挂载页面（权限码可覆盖；默认给齐成员相关码） */
async function mountPage(
  codes: readonly string[] = [
    IAM_GROUP.VIEW,
    IAM_GROUP.MEMBERS,
    IAM_GROUP.ASSIGN_MEMBERS,
    IAM_GROUP.REMOVE_MEMBERS,
  ],
): Promise<ReturnType<typeof mount>> {
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
  listMembersMock.mockResolvedValue(pageOf<GroupMember>([]));
});

describe("GroupList：成员入口", () => {
  it("无 iam:group:members → 不渲染「成员」按钮（但列表与其他按钮不受影响）", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.EDIT,
      IAM_GROUP.DELETE,
    ]);

    expect(wrapper.find('[data-testid="group-members"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
    expect(wrapper.find('[data-testid="group-edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="group-delete"]').exists()).toBe(true);
  });

  it("有权限 → 每行都有「成员」按钮", async () => {
    const wrapper = await mountPage();
    expect(wrapper.findAll('[data-testid="group-members"]')).toHaveLength(2);
  });

  it("点击第 2 行的「成员」→ 打开抽屉并按该行 groupCode 拉取（不串组、不用 id）", async () => {
    const wrapper = await mountPage();
    expect(listMembersMock).not.toHaveBeenCalled();

    await wrapper.findAll('[data-testid="group-members"]')[1]!.trigger("click");
    await flushPromises();

    expect(
      wrapper.find('[data-testid="group-members-drawer"]').exists(),
    ).toBe(true);
    // 第 2 行是 code=ops / id=8 → 必须是 "ops"
    expect(listMembersMock).toHaveBeenCalledTimes(1);
    expect(listMembersMock).toHaveBeenCalledWith("ops", {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(wrapper.text()).toContain("运维组 · 成员");
  });

  it("抽屉 emit changed → 父级 store.fetch() 刷新用户组列表", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-members"]')[0]!.trigger("click");
    await flushPromises();

    const store = useGroupListStore();
    const fetchSpy = vi.spyOn(store, "fetch");
    fetchSpy.mockClear();

    wrapper.findComponent(GroupMembersDrawer).vm.$emit("changed");
    await wrapper.vm.$nextTick();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("抽屉 emit close → 关闭（group 置 null，不再渲染遮罩）", async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('[data-testid="group-members"]')[0]!.trigger("click");
    await flushPromises();

    wrapper.findComponent(GroupMembersDrawer).vm.$emit("close");
    await wrapper.vm.$nextTick();

    expect(
      wrapper.find('[data-testid="group-members-drawer"]').exists(),
    ).toBe(false);
  });

  it("既有入口未被改动：搜索 / 新建 / 分页 testid 仍在", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
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
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
  });
});
