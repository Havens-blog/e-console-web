// @vitest-environment happy-dom
// UserList 按钮级权限门控集成测试（P0 三层裁剪之第 3 层，行为同原型）：
// - readonly_audit（仅 iam:user:view）：新增用户/编辑/删除不渲染，行内渲染「查看」
// - tenant_admin（view+add+edit，缺 delete）：新增/编辑渲染，删除不渲染
// - 平台管理员（全码）：新增/编辑/删除全渲染
//
// 手法：
// - mock userList store（fake 对象，不触网络）；mock api/users listRoles（返回空页）
// - 真实 user store（pinia）注入 permissions/tenants；挂载在内存 router 上下文中
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createApp } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import UserList from "./UserList.vue";
import { useUserStore } from "@/stores/user";
import {
  IAM_ALL_CODES,
  IAM_DEPARTMENT,
  IAM_IDENTITY_SOURCE,
  IAM_PERMISSION,
  IAM_ROLE,
  IAM_USER,
} from "@/config/permission-codes";

// ---- fake userList store（组件只读消费，不驱动网络）----
const fakeListStore = {
  items: [
    {
      id: 1,
      username: "alice",
      status: "active" as const,
      loginMethod: "password",
      tenantId: 1,
      displayName: "Alice",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null as string | null,
  fetch: vi.fn(),
  setKeyword: vi.fn(),
  setRoleFilter: vi.fn(),
  setPage: vi.fn(),
  setPageSize: vi.fn(),
};

vi.mock("@/stores/userList", () => ({
  useUserListStore: () => fakeListStore,
}));

const batchDeleteUsersMock = vi.fn<(ids: number[]) => Promise<void>>();

vi.mock("@/api/users", () => ({
  listRoles: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  batchDeleteUsers: (ids: number[]) => batchDeleteUsersMock(ids),
}));

// ---- 装配 ----
function freshPinia() {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

async function makeRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/users", component: { template: "<div />" } },
      { path: "/", component: { template: "<div />" } },
    ],
  });
  await router.push("/users");
  await router.isReady();
  return router;
}

async function mountUserList(opts: {
  isAdmin?: boolean;
  codes?: readonly string[];
}) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = opts.isAdmin ?? false;
  (
    userStore as unknown as {
      permissions: string[];
    }
  ).permissions = [...(opts.codes ?? [])];
  (
    userStore as unknown as {
      tenants: { id: number; name: string; code: string; domain: string }[];
    }
  ).tenants = [{ id: 1, name: "t1", code: "t1", domain: "" }];

  const router = await makeRouter();
  const wrapper = mount(UserList, {
    global: { plugins: [router] },
  });
  return wrapper;
}

const READONLY_CODES: readonly string[] = [
  IAM_USER.VIEW,
  IAM_DEPARTMENT.VIEW,
  IAM_IDENTITY_SOURCE.VIEW,
  IAM_ROLE.VIEW,
  IAM_PERMISSION.VIEW_AUTHORIZATIONS,
];

describe("UserList 按钮级权限门控（P0）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("readonly_audit：新增/编辑/删除不渲染，行内渲染「查看」", async () => {
    const wrapper = await mountUserList({ isAdmin: false, codes: READONLY_CODES });

    // 新增用户（页头）
    const addBtn = wrapper
      .findAll("button")
      .filter((b) => b.text().includes("新增用户"));
    expect(addBtn).toHaveLength(0);

    expect(wrapper.find('[data-testid="edit-user"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="delete-user"]').exists()).toBe(false);
    // 「查看」兜底（可进详情页只读视图）
    expect(wrapper.find('[data-testid="view-user"]').exists()).toBe(true);
  });

  it("tenant_admin（view+add+edit 缺 delete）：新增/编辑渲染，删除不渲染", async () => {
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.ADD, IAM_USER.EDIT],
    });

    const addBtn = wrapper
      .findAll("button")
      .filter((b) => b.text().includes("新增用户"));
    expect(addBtn).toHaveLength(1);
    expect(wrapper.find('[data-testid="edit-user"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="delete-user"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="view-user"]').exists()).toBe(false);
  });

  it("平台管理员（全码）：新增/编辑/删除全渲染", async () => {
    const wrapper = await mountUserList({
      isAdmin: true,
      codes: IAM_ALL_CODES,
    });

    const addBtn = wrapper
      .findAll("button")
      .filter((b) => b.text().includes("新增用户"));
    expect(addBtn).toHaveLength(1);
    expect(wrapper.find('[data-testid="edit-user"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="delete-user"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="view-user"]').exists()).toBe(false);
  });
});
// 批量删除（feat-user-batch-delete）：后端 /user/batch_delete 与能力码
// iam:user:batch_delete 均已存在，console 侧此前零使用（无 api 函数、无视图调用）。
describe("UserList 批量删除（IAM_USER.BATCH_DELETE）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    batchDeleteUsersMock.mockResolvedValue(undefined);
    fakeListStore.fetch.mockResolvedValue(undefined);
  });

  it("缺码：不渲染选择列 / 全选框 / 批量按钮", async () => {
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.DELETE],
    });

    expect(wrapper.find('[data-testid="user-batch-delete"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="user-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="user-select-all"]').exists()).toBe(false);
  });

  it("有码：渲染选择列与批量按钮，未选中时按钮禁用", async () => {
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.BATCH_DELETE],
    });

    const btn = wrapper.find('[data-testid="user-batch-delete"]');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="user-select"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="user-select-all"]').exists()).toBe(true);
  });

  it("全选本页 → 选中所有可见行；取消全选 → 清空", async () => {
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.BATCH_DELETE],
    });

    const all = wrapper.find('[data-testid="user-select-all"]');
    await all.setValue(true);
    expect(wrapper.find('[data-testid="user-batch-delete"]').text()).toContain(
      "已选 1 项",
    );

    await all.setValue(false);
    expect(
      wrapper.find('[data-testid="user-batch-delete"]').text(),
    ).not.toContain("已选");
  });

  it("选中 → 批量删除 → 弹窗列名 → 确认 → batchDeleteUsers([1]) + 重拉 + 清空选中", async () => {
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.BATCH_DELETE],
    });

    await wrapper.find('[data-testid="user-select"]').setValue(true);
    await wrapper.find('[data-testid="user-batch-delete"]').trigger("click");

    const dialog = wrapper.find('[data-testid="user-batch-delete-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("alice");

    await wrapper
      .find('[data-testid="user-batch-delete-confirm"]')
      .trigger("click");
    await new Promise((r) => setTimeout(r, 0));

    expect(batchDeleteUsersMock).toHaveBeenCalledWith([1]);
    expect(fakeListStore.fetch).toHaveBeenCalled();
    expect(
      wrapper.find('[data-testid="user-batch-delete-dialog"]').exists(),
    ).toBe(false);
    expect(
      wrapper.find('[data-testid="user-batch-delete"]').text(),
    ).not.toContain("已选");
  });

  it("被拒：展示 eiam 文案原文、弹窗保持打开、不重拉、不清选中", async () => {
    batchDeleteUsersMock.mockRejectedValue(new Error("未找到该用户信息"));
    const wrapper = await mountUserList({
      isAdmin: false,
      codes: [IAM_USER.VIEW, IAM_USER.BATCH_DELETE],
    });

    await wrapper.find('[data-testid="user-select"]').setValue(true);
    await wrapper.find('[data-testid="user-batch-delete"]').trigger("click");
    // 挂载时 onMounted 已拉过一次列表，故比较"确认前后次数是否变化"而不是"是否被调用"
    const callsBefore = fakeListStore.fetch.mock.calls.length;
    await wrapper
      .find('[data-testid="user-batch-delete-confirm"]')
      .trigger("click");
    await new Promise((r) => setTimeout(r, 0));

    expect(
      wrapper.find('[data-testid="user-batch-delete-dialog"]').exists(),
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="user-batch-delete-error"]').text(),
    ).toContain("未找到该用户信息");
    expect(fakeListStore.fetch.mock.calls.length).toBe(callsBefore);
    expect(wrapper.find('[data-testid="user-batch-delete"]').text()).toContain(
      "已选 1 项",
    );
  });
});
