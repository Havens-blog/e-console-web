// @vitest-environment happy-dom
/**
 * RoleList 页 × 行多选 + 批量删除集成测试（feat-role-batch-delete 契约 §2.2 / §3）。
 *
 * 目的：证明新增的多选 / 批量删除**真的挂在角色列表页上**，且既有能力未被改动
 * （Hard Rule：严禁改动既有 testid 与既有语义 —— 单条删除、分页、搜索、新建/编辑）。
 *
 * 锁定：
 * - 行多选 `role-select` + 表头全选 `role-select-all`（仅本页）；勾选 / 全选 / 取消全选；
 * - 批量删除 `role-batch-delete`：无选中禁用、显示「已选 N 项」、需 `IAM_ROLE.BATCH_DELETE`；
 * - 二次确认 `role-batch-delete-confirm` / `role-batch-delete-cancel`：未确认不发请求；
 * - 确认后调 `batchDeleteRoles(ids)`（数字数组）→ 清空选中 → 重拉列表；
 * - 被拒 → `role-batch-delete-error` 展示服务端 msg **原文**，弹窗保持、选中不清空、不重拉；
 * - 提交中确认按钮禁用（防重复提交）；
 * - 缺 `BATCH_DELETE` → 不渲染多选列与批量按钮，既有 testid（role-search / role-page-size /
 *   edit-role / delete-role）仍在。
 *
 * 手法：mock `@/api/roles`、`@/api/users`、`@/router`、`vue-router`（**不触网、不删除任何真实角色**），
 * 真实 pinia + roleList store（列表态与重拉动作走生产代码，不用 fake store）。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import RoleList from "./RoleList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES, IAM_ROLE } from "@/config/permission-codes";
import { ApiError } from "@/api/types";
import type { Page, Role } from "@/api/types";

// ---- router 替身：写前守卫快照恒 0（= tenant store 的 currentTenantId 默认值，写路径放行）----
vi.mock("@/router", () => ({
  getPageEnterTenantSnapshot: () => 0,
  __resetPageEnterTenantSnapshot: vi.fn(),
  registerUnauthorizedReset: vi.fn(),
  router: {},
}));

// ---- vue-router 替身：页面「编辑」跳转用 useRouter().push，测试不装真路由 ----
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// ---- api 层 mock（本文件不触网、不删除真实角色）----
const listRolesPageMock = vi.fn<
  (q: { offset: number; limit: number; keyword: string }) => Promise<Page<Role>>
>();
const listPoliciesForRoleMock = vi.fn<(code: string) => Promise<unknown[]>>();
const listUsersByRoleMock = vi.fn<
  (
    code: string,
    q: { offset: number; limit: number; keyword: string },
  ) => Promise<Page<unknown>>
>();
const batchDeleteRolesMock = vi.fn<(ids: number[]) => Promise<void>>();
const deleteRoleMock = vi.fn<(id: number) => Promise<void>>();

vi.mock("@/api/roles", () => ({
  listRolesPage: (q: { offset: number; limit: number; keyword: string }) =>
    listRolesPageMock(q),
  listPoliciesForRole: (code: string) => listPoliciesForRoleMock(code),
  batchDeleteRoles: (ids: number[]) => batchDeleteRolesMock(ids),
  deleteRole: (id: number) => deleteRoleMock(id),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  attachPoliciesToRole: vi.fn(),
  detachPoliciesFromRole: vi.fn(),
  assignUsersToRole: vi.fn(),
  unassignUsersFromRole: vi.fn(),
  listBindablePolicies: vi.fn(),
  listRolesForUser: vi.fn(),
  listParentRoles: vi.fn(),
  addParentRole: vi.fn(),
  removeParentRole: vi.fn(),
}));

vi.mock("@/api/users", () => ({
  listUsersByRole: (
    code: string,
    q: { offset: number; limit: number; keyword: string },
  ) => listUsersByRoleMock(code, q),
  listUsers: vi.fn(),
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeRole(id: number, code: string, name = code): Role {
  return {
    id,
    code,
    name,
    desc: "",
    tenantId: 0,
    policies: [],
    users: [],
  };
}

function pageOf<T>(items: T[], total = items.length): Page<T> {
  return { total, items };
}

/** 挂载页面（默认全码管理员；权限可覆盖） */
async function mountPage(codes: readonly string[] = IAM_ALL_CODES) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [...codes];
  const wrapper = mount(RoleList);
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>;

const rowSelects = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="role-select"]');
const batchBtn = (wrapper: Wrapper) =>
  wrapper.find('[data-testid="role-batch-delete"]');
const batchDialog = (wrapper: Wrapper) =>
  wrapper.find('[data-testid="role-batch-delete-dialog"]');

/** 打开二次确认弹窗（勾选第 index 行 → 点批量删除） */
async function openBatchDialog(
  wrapper: Wrapper,
  indexes: number[] = [0],
): Promise<void> {
  for (const i of indexes) {
    await rowSelects(wrapper)[i]!.setValue(true);
  }
  await batchBtn(wrapper).trigger("click");
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  listRolesPageMock.mockResolvedValue(
    pageOf([
      makeRole(1, "admin", "管理员"),
      makeRole(2, "viewer", "只读"),
      makeRole(3, "ops", "运维"),
    ]),
  );
  listPoliciesForRoleMock.mockResolvedValue([]);
  listUsersByRoleMock.mockResolvedValue({ total: 0, items: [] });
  batchDeleteRolesMock.mockResolvedValue(undefined);
  deleteRoleMock.mockResolvedValue(undefined);
});

describe("RoleList：行多选与批量删除（契约 §2.2）", () => {
  it("无选中 → 批量删除禁用并显示「已选 0 项」；勾选一行 → 启用并计数", async () => {
    const wrapper = await mountPage();

    expect(batchBtn(wrapper).exists()).toBe(true);
    expect(batchBtn(wrapper).attributes("disabled")).toBeDefined();
    expect(batchBtn(wrapper).text()).toContain("已选 0 项");

    await rowSelects(wrapper)[0]!.setValue(true);

    expect(batchBtn(wrapper).attributes("disabled")).toBeUndefined();
    expect(batchBtn(wrapper).text()).toContain("已选 1 项");
  });

  it("表头全选 → 勾中本页全部行；再取消 → 全不选（仅本页）", async () => {
    const wrapper = await mountPage();
    const selectAll = () => wrapper.find('[data-testid="role-select-all"]');
    expect(selectAll().exists()).toBe(true);
    expect(rowSelects(wrapper)).toHaveLength(3);

    await selectAll().setValue(true);
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(true);
    }
    expect(batchBtn(wrapper).text()).toContain("已选 3 项");

    // 逐行取消一行 → 表头全选随之取消（受控）
    await rowSelects(wrapper)[1]!.setValue(false);
    expect((selectAll().element as HTMLInputElement).checked).toBe(false);
    expect(batchBtn(wrapper).text()).toContain("已选 2 项");

    // 表头再次全选 → 补齐本页缺失的那一行
    await selectAll().setValue(true);
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(true);
    }
    expect(batchBtn(wrapper).text()).toContain("已选 3 项");

    await selectAll().setValue(false);
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(false);
    }
    expect(batchBtn(wrapper).text()).toContain("已选 0 项");
  });

  it("确认后调 batchDeleteRoles(ids 数字数组) → 清空选中 → 重拉列表", async () => {
    const wrapper = await mountPage();
    expect(listRolesPageMock).toHaveBeenCalledTimes(1);

    await openBatchDialog(wrapper, [0, 2]);

    // 二次确认：未确认不发请求
    expect(batchDeleteRolesMock).not.toHaveBeenCalled();
    expect(batchDialog(wrapper).exists()).toBe(true);
    expect(batchDialog(wrapper).text()).toContain("管理员");
    expect(batchDialog(wrapper).text()).toContain("运维");

    await wrapper
      .find('[data-testid="role-batch-delete-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(batchDeleteRolesMock).toHaveBeenCalledTimes(1);
    expect(batchDeleteRolesMock).toHaveBeenCalledWith([1, 3]);
    // ids 为数字数组（非 code / 非字符串）
    expect(batchDeleteRolesMock.mock.calls[0]![0].every((id) => typeof id === "number")).toBe(
      true,
    );
    // 成功后关弹窗 + 重拉
    expect(batchDialog(wrapper).exists()).toBe(false);
    expect(listRolesPageMock).toHaveBeenCalledTimes(2);
    // 选中已清空
    expect(batchBtn(wrapper).text()).toContain("已选 0 项");
    expect(batchBtn(wrapper).attributes("disabled")).toBeDefined();
    for (const box of rowSelects(wrapper)) {
      expect((box.element as HTMLInputElement).checked).toBe(false);
    }
  });

  it("取消二次确认 → 不调用批量删除接口，选中保留", async () => {
    const wrapper = await mountPage();
    await openBatchDialog(wrapper, [0]);

    await wrapper
      .find('[data-testid="role-batch-delete-cancel"]')
      .trigger("click");
    await flushPromises();

    expect(batchDeleteRolesMock).not.toHaveBeenCalled();
    expect(batchDialog(wrapper).exists()).toBe(false);
    expect(batchBtn(wrapper).text()).toContain("已选 1 项");
    expect((rowSelects(wrapper)[0]!.element as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("被拒 → 展示服务端 msg 原文，弹窗保持、选中不清空、不重拉", async () => {
    batchDeleteRolesMock.mockRejectedValue(
      new ApiError("conflict", "角色仍被 3 个用户引用，无法删除", {
        code: 4090001,
        httpStatus: 409,
      }),
    );
    const wrapper = await mountPage();
    await openBatchDialog(wrapper, [0]);

    await wrapper
      .find('[data-testid="role-batch-delete-confirm"]')
      .trigger("click");
    await flushPromises();

    expect(batchDialog(wrapper).exists()).toBe(true);
    expect(
      batchDialog(wrapper).find('[data-testid="role-batch-delete-error"]').text(),
    ).toBe("角色仍被 3 个用户引用，无法删除");
    // 失败不重拉、选中保留（不谎报成功）
    expect(listRolesPageMock).toHaveBeenCalledTimes(1);
    expect(batchBtn(wrapper).text()).toContain("已选 1 项");
    expect((rowSelects(wrapper)[0]!.element as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("提交中确认按钮禁用（防重复提交）", async () => {
    let resolveBatch: (() => void) | undefined;
    batchDeleteRolesMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveBatch = () => resolve();
        }),
    );
    const wrapper = await mountPage();
    await openBatchDialog(wrapper, [0]);

    await wrapper
      .find('[data-testid="role-batch-delete-confirm"]')
      .trigger("click");
    await flushPromises();

    const confirmBtn = wrapper.find('[data-testid="role-batch-delete-confirm"]');
    expect(confirmBtn.attributes("disabled")).toBeDefined();
    expect(confirmBtn.text()).toContain("删除中");

    // 重复点击不产生第二次提交
    await confirmBtn.trigger("click");
    expect(batchDeleteRolesMock).toHaveBeenCalledTimes(1);

    resolveBatch!();
    await flushPromises();
    expect(batchDialog(wrapper).exists()).toBe(false);
    expect(listRolesPageMock).toHaveBeenCalledTimes(2);
  });

  it("缺 BATCH_DELETE → 不渲染多选列 / 全选 / 批量按钮，既有 testid 不变", async () => {
    const wrapper = await mountPage([
      IAM_ROLE.VIEW,
      IAM_ROLE.EDIT,
      IAM_ROLE.DELETE,
    ]);

    // 本页 3 行照常渲染
    expect(wrapper.findAll(".data-table tbody tr")).toHaveLength(3);
    expect(wrapper.find('[data-testid="role-select"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="role-select-all"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="role-batch-delete"]').exists()).toBe(
      false,
    );

    // 既有 testid / 语义原样保留
    expect(wrapper.find('[data-testid="role-search"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="role-page-size"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="edit-role"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-testid="delete-role"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-testid="role-policy-count"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-testid="role-user-count"]')).toHaveLength(3);
  });

  it("既有单条删除不回归：点删除 → 二次确认 → deleteRole(id)", async () => {
    const wrapper = await mountPage([
      IAM_ROLE.VIEW,
      IAM_ROLE.DELETE,
      IAM_ROLE.BATCH_DELETE,
    ]);

    await wrapper.findAll('[data-testid="delete-role"]')[0]!.trigger("click");
    await flushPromises();
    expect(deleteRoleMock).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="delete-confirm"]').trigger("click");
    await flushPromises();

    expect(deleteRoleMock).toHaveBeenCalledTimes(1);
    expect(deleteRoleMock).toHaveBeenCalledWith(1);
    // 单条删除成功同样重拉（原有语义）
    expect(listRolesPageMock).toHaveBeenCalledTimes(2);
  });
});
