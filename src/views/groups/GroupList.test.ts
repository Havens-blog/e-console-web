// @vitest-environment happy-dom
/**
 * GroupList 页面六条主流程测试（feat-group-management 契约 §2.3 / §3）。
 *
 * 覆盖：
 * - 列表：行渲染（名称 / 标识码 / 描述 / 创建时间）、创建时间经 formatEpochMs（毫秒 + 年月日形态）
 * - 搜索 / 重置 / 分页（关键词 trim、重置清空并回第 1 页、翻页与页大小切换）
 * - 新建：必填校验（名称 / 标识码）、长度校验（标识码 ≤32 / 描述 ≤512）、成功载荷、服务端拒绝展示 msg
 * - 编辑：标识码只读（readonly + 不进入更新载荷）
 * - 删除：二次确认（打开弹窗不请求）、确认后调用、服务端拒绝原样展示 msg 且弹窗保持
 * - 无权限：仅 iam:group:view 时不渲染新建 / 编辑 / 删除按钮
 * - 状态：空态「暂无用户组」、错误态 + 重试
 *
 * 手法：mock `@/api/groups` 四函数（**不触网**），pinia 装配真实 groupList store
 * （顺带校验页面与统一 store 契约的接线），user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import GroupList from "./GroupList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES, IAM_GROUP } from "@/config/permission-codes";
import type { Page, TenantGroup } from "@/api/types";

// ---- api 层 mock（四接口；本文件不触网、不创建真实用户组）----
const listGroups = vi.fn<
  (q: { offset: number; limit: number; keyword: string }) => Promise<
    Page<TenantGroup>
  >
>();
const createGroup = vi.fn<(p: unknown) => Promise<void>>();
const updateGroup = vi.fn<(p: unknown) => Promise<void>>();
const deleteGroup = vi.fn<(id: number) => Promise<void>>();

vi.mock("@/api/groups", () => ({
  listGroups: (q: { offset: number; limit: number; keyword: string }) =>
    listGroups(q),
  createGroup: (p: unknown) => createGroup(p),
  updateGroup: (p: unknown) => updateGroup(p),
  deleteGroup: (id: number) => deleteGroup(id),
}));

// ---- router 模块替身（store 依赖 registerUnauthorizedReset）----
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

function pageOf(
  items: TenantGroup[],
  total = items.length,
): Page<TenantGroup> {
  return { total, items };
}

/** 挂载页面（默认全码管理员；权限可覆盖） */
async function mountPage(codes: readonly string[] = IAM_ALL_CODES) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [...codes];
  const wrapper = mount(GroupList);
  await flushPromises();
  return wrapper;
}

const rows = (wrapper: Awaited<ReturnType<typeof mountPage>>) =>
  wrapper.findAll('[data-testid="group-row"]');

/**
 * 提交新建/编辑表单：对 `<form>` 触发 submit（等价点击「保存」按钮，
 * 并顺带锁定提交按钮确为 type="submit" —— 否则回车/点击都不会触发表单提交）。
 */
async function submitForm(wrapper: Awaited<ReturnType<typeof mountPage>>) {
  const submitBtn = wrapper.find('[data-testid="group-form-submit"]');
  expect(submitBtn.exists()).toBe(true);
  expect(submitBtn.attributes("type")).toBe("submit");
  const form = wrapper.find('[data-testid="group-form"] form');
  expect(form.exists()).toBe(true);
  await form.trigger("submit");
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  listGroups.mockResolvedValue(pageOf([makeGroup()]));
  createGroup.mockResolvedValue(undefined);
  updateGroup.mockResolvedValue(undefined);
  deleteGroup.mockResolvedValue(undefined);
});

describe("GroupList：列表渲染", () => {
  it("行渲染名称 / 标识码 / 描述；挂载即拉列表（offset=0, limit=20）", async () => {
    listGroups.mockResolvedValue(
      pageOf([
        makeGroup({ id: 7, name: "研发组", code: "rd", desc: "研发团队" }),
        makeGroup({ id: 8, name: "运维组", code: "ops", desc: "" }),
      ]),
    );
    const wrapper = await mountPage();
    expect(listGroups).toHaveBeenCalledTimes(1);
    expect(listGroups).toHaveBeenCalledWith({
      offset: 0,
      limit: 20,
      keyword: "",
    });

    const list = rows(wrapper);
    expect(list).toHaveLength(2);
    expect(list[0]!.text()).toContain("研发组");
    expect(list[0]!.text()).toContain("rd");
    expect(list[0]!.text()).toContain("研发团队");
    // 描述为空 → '—'
    expect(list[1]!.text()).toContain("—");
  });

  it("创建时间经 formatEpochMs 渲染（Unix 毫秒 → YYYY-MM-DD HH:mm:ss，不出现荒谬年份）", async () => {
    const wrapper = await mountPage();
    const row = rows(wrapper)[0]!;
    expect(row.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(row.text()).not.toContain("58563");
  });

  it("ctime 缺失 → 创建时间列 '—'（不渲染 1970 / undefined）", async () => {
    listGroups.mockResolvedValue(
      pageOf([makeGroup({ ctime: undefined })]),
    );
    const wrapper = await mountPage();
    const row = rows(wrapper)[0]!;
    expect(row.text()).toContain("—");
    expect(row.text()).not.toContain("1970");
  });
});

describe("GroupList：当前页筛选 / 重置 / 分页", () => {
  // 事实依据：eiam `POST /iam/group/list` 的 ListGroupRequest 只有 offset/limit，
  // **服务端不支持 keyword**。故筛选改为**本页内即时过滤**，不重新请求（否则输入会被静默忽略）。
  it("输入关键词点搜索 → 只过滤当前页，且不重新请求", async () => {
    listGroups.mockResolvedValue(
      pageOf(
        [
          makeGroup({ id: 1, name: "研发组", code: "rd" }),
          makeGroup({ id: 2, name: "运营组", code: "ops" }),
        ],
        2,
      ),
    );
    const wrapper = await mountPage();
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
    const callsBefore = listGroups.mock.calls.length;

    await wrapper.find('[data-testid="group-search"]').setValue("  研发  ");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "搜索")!
      .trigger("click");
    await flushPromises();

    const rows = wrapper.findAll('[data-testid="group-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text()).toContain("研发组");
    // 关键：不因筛选而重查（服务端本就不支持 keyword）
    expect(listGroups.mock.calls.length).toBe(callsBefore);
  });

  it("重置 → 清空输入框与筛选，恢复本页全部行（不重查、不改页码）", async () => {
    listGroups.mockResolvedValue(
      pageOf(
        [
          makeGroup({ id: 1, name: "研发组", code: "rd" }),
          makeGroup({ id: 2, name: "运营组", code: "ops" }),
        ],
        45,
      ),
    );
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="group-search"]').setValue("研发");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "搜索")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(1);

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "重置")!
      .trigger("click");
    await flushPromises();

    expect(
      (wrapper.find('[data-testid="group-search"]').element as HTMLInputElement)
        .value,
    ).toBe("");
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(2);
  });

  it("当前页筛不出结果 → 提示仅在当前页生效并给清除入口", async () => {
    listGroups.mockResolvedValue(pageOf([makeGroup({ name: "研发组", code: "rd" })], 1));
    const wrapper = await mountPage();

    await wrapper.find('[data-testid="group-search"]').setValue("不存在的组");
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "搜索")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(0);
    expect(wrapper.text()).toContain("当前页没有匹配的用户组");
    await wrapper.find('[data-testid="group-clear-filters"]').trigger("click");
    await flushPromises();
    expect(wrapper.findAll('[data-testid="group-row"]')).toHaveLength(1);
  });

  it("分页：上一页禁用态 / 页大小切换回第 1 页 / 下一页推进", async () => {
    listGroups.mockResolvedValue(pageOf([makeGroup()], 120));
    const wrapper = await mountPage();

    // 第 1 页：上一页禁用（total=120 / 20 → 6 页）
    expect(
      wrapper.find('[data-testid="group-page-prev"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 6 页");

    // 页大小 20 → 50：重置回第 1 页（offset=0）
    await wrapper.find('[data-testid="group-page-size"]').setValue("50");
    await flushPromises();
    expect(listGroups).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 50,
      keyword: "",
    });
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 3 页");

    // 下一页：page=2 → offset=50（pageSize=50）
    await wrapper.find('[data-testid="group-page-next"]').trigger("click");
    await flushPromises();
    expect(listGroups).toHaveBeenLastCalledWith({
      offset: 50,
      limit: 50,
      keyword: "",
    });
  });

  it("空态：无数据显示「暂无用户组」", async () => {
    listGroups.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    expect(wrapper.find(".state-empty").text()).toContain("暂无用户组");
  });

  it("错误态：展示 eiam msg + 重试按钮重查", async () => {
    listGroups.mockRejectedValueOnce(new Error("eiam 不可用"));
    const wrapper = await mountPage();
    const errorBox = wrapper.find(".state-error");
    expect(errorBox.exists()).toBe(true);
    expect(errorBox.text()).toContain("eiam 不可用");

    await errorBox.find("button").trigger("click");
    await flushPromises();
    expect(listGroups).toHaveBeenCalledTimes(2);
    expect(rows(wrapper)).toHaveLength(1);
  });
});

describe("GroupList：新建校验", () => {
  it("名称与标识码必填：空提交阻止请求并就近报错", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    await submitForm(wrapper);
    await flushPromises();

    expect(createGroup).not.toHaveBeenCalled();
    const form = wrapper.find('[data-testid="group-form"]');
    expect(form.text()).toContain("请输入用户组名称");
    expect(form.text()).toContain("请输入标识码");
  });

  it("名称 > 64 / 描述 > 512 → 阻止提交（maxlength 之外再兜一层）", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    const nameInput = wrapper.find('[data-testid="group-form-name"]');
    const descInput = wrapper.find('[data-testid="group-form-desc"]');
    expect(nameInput.attributes("maxlength")).toBe("64");
    expect(descInput.attributes("maxlength")).toBe("512");

    (nameInput.element as HTMLInputElement).value = "名".repeat(65);
    await nameInput.trigger("input");
    await wrapper.find('[data-testid="group-form-code"]').setValue("rd");
    (descInput.element as HTMLTextAreaElement).value = "描".repeat(513);
    await descInput.trigger("input");
    await submitForm(wrapper);

    expect(createGroup).not.toHaveBeenCalled();
    const form = wrapper.find('[data-testid="group-form"]');
    expect(form.text()).toContain("名称长度 1–64 字符");
    expect(form.text()).toContain("描述长度 ≤512");
  });

  it("标识码长度 > 32 → 阻止提交（maxlength 之外再兜一层，防粘贴绕过）", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    await wrapper.find('[data-testid="group-form-name"]').setValue("研发组");
    const codeInput = wrapper.find('[data-testid="group-form-code"]');
    // maxlength 属性存在（浏览器层拦截）
    expect(codeInput.attributes("maxlength")).toBe("32");
    // 直接写超长值模拟粘贴/程序化赋值
    (codeInput.element as HTMLInputElement).value = "x".repeat(33);
    await codeInput.trigger("input");
    await submitForm(wrapper);
    await flushPromises();

    expect(createGroup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="group-form"]').text()).toContain(
      "标识码长度 ≤32",
    );
  });

  it("合法输入 → createGroup 载荷 {name, code, desc}，成功后关闭弹窗并刷新", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    await wrapper.find('[data-testid="group-form-name"]').setValue("  研发组  ");
    await wrapper.find('[data-testid="group-form-code"]').setValue(" rd ");
    await wrapper.find('[data-testid="group-form-desc"]').setValue("研发团队");
    await submitForm(wrapper);
    await flushPromises();

    expect(createGroup).toHaveBeenCalledWith({
      name: "研发组",
      code: "rd",
      desc: "研发团队",
    });
    expect(wrapper.find('[data-testid="group-form"]').exists()).toBe(false);
    // 新建后刷新列表（挂载 1 次 + 新建后 1 次）
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  it("服务端拒绝 → 弹窗内原样展示 eiam msg，不关闭", async () => {
    createGroup.mockRejectedValue(new Error("标识码已存在"));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    await wrapper.find('[data-testid="group-form-name"]').setValue("研发组");
    await wrapper.find('[data-testid="group-form-code"]').setValue("rd");
    await submitForm(wrapper);
    await flushPromises();

    const form = wrapper.find('[data-testid="group-form"]');
    expect(form.exists()).toBe(true);
    expect(form.find(".form-error").text()).toContain("标识码已存在");
  });
});

describe("GroupList：编辑（标识码只读）", () => {
  it("编辑弹窗回显行数据，标识码 readonly，提交载荷不含 code", async () => {
    listGroups.mockResolvedValue(
      pageOf([makeGroup({ id: 7, name: "研发组", code: "rd", desc: "旧描述" })]),
    );
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-edit"]').trigger("click");
    await flushPromises();

    const codeInput = wrapper.find('[data-testid="group-form-code"]');
    expect(codeInput.attributes("readonly")).toBeDefined();
    expect((codeInput.element as HTMLInputElement).value).toBe("rd");
    expect(
      (wrapper.find('[data-testid="group-form-name"]').element as HTMLInputElement)
        .value,
    ).toBe("研发组");

    await wrapper.find('[data-testid="group-form-name"]').setValue("研发组（新）");
    await wrapper.find('[data-testid="group-form-desc"]').setValue("新描述");
    await submitForm(wrapper);
    await flushPromises();

    expect(updateGroup).toHaveBeenCalledWith({
      id: 7,
      name: "研发组（新）",
      desc: "新描述",
    });
    // 契约 §1：UpdateGroupReq 无 code，页面不得传
    expect(updateGroup.mock.calls[0]![0]).not.toHaveProperty("code");
    expect(wrapper.find('[data-testid="group-form"]').exists()).toBe(false);
  });

  it("新建弹窗的标识码可编辑（readonly 仅编辑态）", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-create"]').trigger("click");
    expect(
      wrapper.find('[data-testid="group-form-code"]').attributes("readonly"),
    ).toBeUndefined();
  });
});

describe("GroupList：删除二次确认", () => {
  it("点删除先开确认弹窗（不发请求），确认后才调用 deleteGroup", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-delete"]').trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="group-delete-confirm"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("研发组");
    expect(deleteGroup).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="group-delete-submit"]').trigger("click");
    await flushPromises();
    expect(deleteGroup).toHaveBeenCalledWith(7);
    // 成功后弹窗关闭 + 列表刷新
    expect(wrapper.find('[data-testid="group-delete-confirm"]').exists()).toBe(
      false,
    );
    expect(listGroups).toHaveBeenCalledTimes(2);
  });

  it("取消 → 不调用 deleteGroup，弹窗关闭", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-delete"]').trigger("click");
    await flushPromises();
    await wrapper
      .findAll('[data-testid="group-delete-confirm"] button')
      .find((b) => b.text() === "取消")!
      .trigger("click");
    await flushPromises();

    expect(deleteGroup).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="group-delete-confirm"]').exists()).toBe(
      false,
    );
  });

  it("服务端拒绝 → 原样展示 msg，弹窗保持打开（可重试或取消）", async () => {
    deleteGroup.mockRejectedValue(new Error("用户组仍有成员，无法删除"));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="group-delete"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="group-delete-submit"]').trigger("click");
    await flushPromises();

    const dialog = wrapper.find('[data-testid="group-delete-confirm"]');
    expect(dialog.exists()).toBe(true);
    expect(
      dialog.find('[data-testid="group-delete-error"]').text(),
    ).toContain("用户组仍有成员，无法删除");
  });
});

describe("GroupList：权限裁剪（按钮级）", () => {
  it("仅 iam:group:view → 不渲染新建 / 编辑 / 删除按钮", async () => {
    const wrapper = await mountPage([IAM_GROUP.VIEW]);
    expect(wrapper.find('[data-testid="group-create"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="group-edit"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="group-delete"]').exists()).toBe(false);
    // 列表本身仍可见
    expect(rows(wrapper)).toHaveLength(1);
  });

  it("持 add/edit/delete 码 → 三个按钮齐备", async () => {
    const wrapper = await mountPage([
      IAM_GROUP.VIEW,
      IAM_GROUP.ADD,
      IAM_GROUP.EDIT,
      IAM_GROUP.DELETE,
    ]);
    expect(wrapper.find('[data-testid="group-create"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="group-edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="group-delete"]').exists()).toBe(true);
  });

  it("码级粒度：仅缺 delete 码时编辑在、删除不在", async () => {
    const wrapper = await mountPage([IAM_GROUP.VIEW, IAM_GROUP.EDIT]);
    expect(wrapper.find('[data-testid="group-edit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="group-delete"]').exists()).toBe(false);
  });
});
