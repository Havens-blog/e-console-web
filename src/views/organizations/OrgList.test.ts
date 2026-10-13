// @vitest-environment happy-dom
/**
 * OrgList 组件接线回归（organizations 大文件拆分后新增）
 *
 * 背景：OrgList.vue 由 1216 行拆为 156 行 + 4 个子组件 + 1 个 composable 后才首次
 * 具备组件级测试。本文件只断言「跨组件接线是否真的通电」，不断言既有业务语义
 * （业务语义由 src/stores/orgList.test.ts 覆盖）：
 *   1. 页面 onMounted → store.fetch() → OrgTree.expandAndSelectFirst()
 *      （默认展开首个根节点并选中）
 *   2. OrgTree 行内「＋」→ emit → 页面 → OrgDialogs.openCreateChild
 *   3. OrgDetailCard 动作按钮 → emit → 同一对话框（第二条 emit 链）
 *   4. E11：openDelete 预检阻断 → 确认按钮置灰且渲染阻断文案
 *   5. 键盘 ↓：useTreeNavigation 的焦点环在 OrgTree 内生效
 *   6. 成员列表在选中节点后渲染（store 二级态接线）
 *
 * 为什么必须有它：这层接线由 defineExpose / emit / 模板 ref 构成，typecheck 抓不到
 * 断裂——useTreeNavigation 改为 OrgTree 内自持后，若父组件那行
 * `treeRef.value?.expandAndSelectFirst()` 被删掉，页面仍能编译、仍能渲染，
 * 但默认展开与成员表会静默失效。已用负向对照确认该断言具有区分力（断开该调用后
 * 多条用例转红，恢复后全绿）。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createApp, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

const h = vi.hoisted(() => ({
  tree: [
    {
      id: 1,
      name: "总部",
      children: [
        {
          id: 2,
          name: "研发部",
          parentId: 1,
          children: [{ id: 3, name: "前端组", parentId: 2, children: [] }],
        },
      ],
    },
  ],
}));

// @/router 本身未被本页直接引用，但 @/stores/user 会传递依赖它；
// 故按 store 实际用到的导出面桩掉，避免拉入真实 router 与守卫副作用。
vi.mock("@/router", () => ({
  getPageEnterTenantSnapshot: () => 1,
  __resetPageEnterTenantSnapshot: vi.fn(),
  registerUnauthorizedReset: vi.fn(),
  router: {},
}));

vi.mock("@/api/organizations", () => ({
  listOrganizationTree: vi.fn(async () => h.tree),
  getOrganizationDetail: vi.fn(async (id: number) => ({ id, name: "总部" })),
  listOrganizationMembers: vi.fn(async () => ({
    items: [
      { id: 9, username: "alice", displayName: "Alice", email: "", phone: "" },
    ],
    total: 1,
  })),
  createOrganization: vi.fn(async () => 99),
  updateOrganization: vi.fn(async () => undefined),
  deleteOrganization: vi.fn(async () => undefined),
}));

import OrgList from "./OrgList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES } from "@/config/permission-codes";

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
    await nextTick();
  }
}

async function mountPage() {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);

  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    ...IAM_ALL_CODES,
  ];
  (
    userStore as unknown as {
      tenants: { id: number; name: string; code: string; domain: string }[];
    }
  ).tenants = [{ id: 1, name: "t1", code: "t1", domain: "" }];

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/organizations", component: { template: "<div />" } },
      { path: "/", component: { template: "<div />" } },
    ],
  });
  await router.push("/organizations");
  await router.isReady();

  const wrapper = mount(OrgList, { global: { plugins: [router] } });
  await flush();
  return wrapper;
}

describe("OrgList 组件接线（拆分后回归）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1+2. 挂载后默认展开并选中首个根节点；行内「＋」能打开新增子组织对话框", async () => {
    const wrapper = await mountPage();

    // 1) expandAndSelectFirst 生效：根节点已展开 → 可见行为「总部」「研发部」两条
    const rows = wrapper.findAll(".tree__row");
    expect(rows.length, "可见行数（根已展开应为 2）").toBe(2);
    expect(
      wrapper.find('[data-node-id="1"]').attributes("aria-selected"),
      "首个根节点应被选中",
    ).toBe("true");
    // 根节点 aria-expanded=true（展开态来自 OrgTree 自持的 useTreeNavigation）
    expect(
      wrapper.find('[data-node-id="1"]').attributes("aria-expanded"),
    ).toBe("true");

    // 2) 行内「＋」→ emit create-child → 页面 → OrgDialogs 打开
    expect(
      wrapper.find('[data-testid="create-org-name"]').exists(),
      "未点击前不应有新增对话框",
    ).toBe(false);
    const plusBtn = wrapper.findAll('[data-node-id="1"] .tree__actions button')[0]!;
    await plusBtn.trigger("click");
    await flush();
    expect(
      wrapper.find('[data-testid="create-org-name"]').exists(),
      "点击行内「＋」后新增子组织对话框应打开",
    ).toBe(true);
    // 标题应体现「子组织（总部）」= createParent 已透传
    expect(wrapper.text()).toContain("新增子组织（总部）");
  });

  it("3. 详情卡片的动作按钮同样能打开对话框（第二条 emit 链）", async () => {
    const wrapper = await mountPage();

    const editBtn = wrapper
      .findAll(".detail-actions button")
      .find((b) => b.text().includes("编辑"))!;
    expect(editBtn, "详情卡片应有「编辑」按钮").toBeTruthy();
    await editBtn.trigger("click");
    await flush();
    expect(
      wrapper.find('[data-testid="edit-org-name"]').exists(),
      "点击详情卡片「编辑」后编辑对话框应打开",
    ).toBe(true);
  });

  it("4. E11：删除预检阻断（有子节点）时确认按钮置灰且渲染阻断文案", async () => {
    const wrapper = await mountPage();

    const delBtn = wrapper.findAll('[data-node-id="1"] .tree__actions button')[2]!;
    await delBtn.trigger("click");
    await flush();

    const confirm = wrapper.find('[data-testid="delete-org-confirm"]');
    expect(confirm.exists(), "删除确认对话框应打开").toBe(true);
    expect(
      confirm.attributes("disabled"),
      "预检阻断（child_count=1）时确认按钮应置灰",
    ).toBeDefined();
    expect(wrapper.find(".delete-blocked").exists(), "应渲染阻断计数文案").toBe(
      true,
    );
  });

  it("5. 键盘 ↓ 移动焦点环（useTreeNavigation 在 OrgTree 内生效）", async () => {
    const wrapper = await mountPage();

    expect(
      wrapper.find('[data-node-id="1"]').classes(),
      "初始焦点应在第 1 行",
    ).toContain("tree__row--focus");

    await wrapper.find(".tree-body").trigger("keydown", { key: "ArrowDown" });
    await flush();

    expect(
      wrapper.find('[data-node-id="2"]').classes(),
      "↓ 之后焦点应移到第 2 行",
    ).toContain("tree__row--focus");
  });

  it("6. 成员列表在选中节点后渲染（store 二级态接线）", async () => {
    const wrapper = await mountPage();

    expect(wrapper.find(".data-table").exists(), "应有成员表格").toBe(true);
    expect(wrapper.text()).toContain("alice");
  });
});
