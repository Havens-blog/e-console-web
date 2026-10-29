// @vitest-environment happy-dom
/**
 * AuditLogList 页测试（feat-audit-logs 契约 §2.3 / §3）。
 *
 * 覆盖：
 * - 两页签渲染（认证审计 / 操作审计）、aria-selected 反映当前视图
 * - 挂载只拉当前页签（auth 优先，offset=0 / limit=20），另一页签不请求
 * - 认证表：行渲染（用户名 / 认证类型 / 状态 / 失败原因 / 客户端 IP / 时间）、
 *   时间经 formatEpochMs（Unix 毫秒 + 年份护栏）、缺值降级 '—'
 * - 操作表：行渲染（操作人 / 服务 / 模块 / 动作 / 状态 / 时间）
 * - 筛选：查询触发重拉且载荷正确（含 datetime-local → Unix 毫秒、状态枚举），
 *   **空筛选不动请求体**、重置清空筛选并重拉、筛选后回第 1 页
 * - 分页：20·50·100、第 1 页上一页禁用、页大小切换回第 1 页、下一页 offset 推进
 * - 空态：audit-auth-empty / audit-operation-empty
 * - 错误态 + 重试：audit-auth-error / audit-operation-error
 * - 缺码不渲染页签、也不发请求（VIEW_AUTH / VIEW_OPERATION 各自粒度）
 * - 严格只读：行内无任何操作按钮，页内无编辑/删除入口
 * - 页签切换：进入哪个页签拉哪个列表；两页签分页/筛选态互不污染
 *
 * 手法：mock `@/api/auditLogs` 两函数（**不触网、不写任何数据**），pinia + user store
 * 注入权限码；页面自身无 store 依赖（列表态在组件内），故无需 mock router。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import AuditLogList from "./AuditLogList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES, IAM_AUDIT } from "@/config/permission-codes";
import type {
  AuthLog,
  AuthLogQuery,
  OperationLog,
  OperationLogQuery,
} from "@/api/auditLogs";
import type { Page } from "@/api/types";

// ---- api 层 mock（两接口；本文件不触网、不写任何数据）----
const listAuthLogsMock = vi.fn<(q: AuthLogQuery) => Promise<Page<AuthLog>>>();
const listOperationLogsMock = vi.fn<
  (q: OperationLogQuery) => Promise<Page<OperationLog>>
>();

vi.mock("@/api/auditLogs", () => ({
  listAuthLogs: (q: AuthLogQuery) => listAuthLogsMock(q),
  listOperationLogs: (q: OperationLogQuery) => listOperationLogsMock(q),
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

function makeAuthLog(overrides: Partial<AuthLog> = {}): AuthLog {
  return {
    id: 1,
    tenantId: 1,
    userId: 5,
    username: "bob",
    authType: "password",
    status: "SUCCESS",
    failReason: undefined,
    clientIp: "10.0.0.7",
    userAgent: "curl/8",
    ctime: 1730000000000,
    ...overrides,
  };
}

function makeOperationLog(overrides: Partial<OperationLog> = {}): OperationLog {
  return {
    id: 11,
    operatorName: "alice",
    service: "eiam",
    module: "user",
    action: "create",
    status: "SUCCESS",
    ctime: 1730000000000,
    ...overrides,
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
  const wrapper = mount(AuditLogList);
  await flushPromises();
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>;

const authRows = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="audit-auth-row"]');
const opRows = (wrapper: Wrapper) =>
  wrapper.findAll('[data-testid="audit-operation-row"]');

/** 切到操作审计页签 */
async function switchToOperation(wrapper: Wrapper): Promise<void> {
  await wrapper.find('[data-testid="audit-tab-operation"]').trigger("click");
  await flushPromises();
}

/** 提交认证筛选：点「查询」（等价 `<form>` submit；并锁定按钮确为 type="submit"） */
async function searchAuth(wrapper: Wrapper): Promise<void> {
  const btn = wrapper.find('[data-testid="audit-auth-search"]');
  expect(btn.attributes("type")).toBe("submit");
  const form = wrapper.find('[data-testid="audit-panel-auth"] form');
  expect(form.exists()).toBe(true);
  await form.trigger("submit");
  await flushPromises();
}

/** 提交操作筛选 */
async function searchOperation(wrapper: Wrapper): Promise<void> {
  const btn = wrapper.find('[data-testid="audit-operation-search"]');
  expect(btn.attributes("type")).toBe("submit");
  const form = wrapper.find('[data-testid="audit-panel-operation"] form');
  expect(form.exists()).toBe(true);
  await form.trigger("submit");
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  listAuthLogsMock.mockResolvedValue(pageOf([makeAuthLog()]));
  listOperationLogsMock.mockResolvedValue(pageOf([makeOperationLog()]));
});

describe("AuditLogList：页签与首屏加载", () => {
  it("两个页签都渲染；容器与页签 testid 齐全", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find('[data-testid="page-audit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="audit-tab-auth"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-testid="audit-tab-operation"]').exists(),
    ).toBe(true);
    expect(
      wrapper.find('[data-testid="audit-tab-auth"]').attributes("aria-selected"),
    ).toBe("true");
  });

  it("挂载只拉当前页签（auth）：offset=0 / limit=20；操作审计不请求", async () => {
    await mountPage();
    expect(listAuthLogsMock).toHaveBeenCalledTimes(1);
    expect(listAuthLogsMock).toHaveBeenCalledWith({ offset: 0, limit: 20 });
    expect(listOperationLogsMock).not.toHaveBeenCalled();
  });

  it("切到操作审计 → 拉操作列表；aria-selected 跟随", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);

    expect(listOperationLogsMock).toHaveBeenCalledTimes(1);
    expect(listOperationLogsMock).toHaveBeenCalledWith({ offset: 0, limit: 20 });
    expect(
      wrapper
        .find('[data-testid="audit-tab-operation"]')
        .attributes("aria-selected"),
    ).toBe("true");
    expect(
      wrapper.find('[data-testid="audit-tab-auth"]').attributes("aria-selected"),
    ).toBe("false");
  });

  it("切回认证审计 → 重新拉认证列表（两页签各自独立）", async () => {
    const wrapper = await mountPage();
    expect(listAuthLogsMock).toHaveBeenCalledTimes(1);

    await switchToOperation(wrapper);
    await wrapper.find('[data-testid="audit-tab-auth"]').trigger("click");
    await flushPromises();

    expect(listAuthLogsMock).toHaveBeenCalledTimes(2);
    expect(authRows(wrapper)).toHaveLength(1);
  });
});

describe("AuditLogList：认证审计表渲染", () => {
  it("行渲染用户名 / 认证类型 / 状态 / 失败原因 / 客户端 IP / 时间", async () => {
    listAuthLogsMock.mockResolvedValue(
      pageOf([
        makeAuthLog({
          id: 1,
          username: "bob",
          authType: "password",
          status: "FAIL",
          failReason: "密码错误",
          clientIp: "10.0.0.7",
        }),
        makeAuthLog({
          id: 2,
          username: "eve",
          authType: "ldap",
          status: "LOCKED",
          failReason: undefined,
          clientIp: undefined,
        }),
      ]),
    );
    const wrapper = await mountPage();
    const rows = authRows(wrapper);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("bob");
    expect(rows[0]!.text()).toContain("password");
    expect(rows[0]!.text()).toContain("FAIL");
    expect(rows[0]!.text()).toContain("密码错误");
    expect(rows[0]!.text()).toContain("10.0.0.7");
    // 缺值降级 '—'（失败原因 / 客户端 IP）
    expect(rows[1]!.text()).toContain("eve");
    expect(rows[1]!.text()).toContain("—");
  });

  it("表头六列与契约 §2.3 逐字一致", async () => {
    const wrapper = await mountPage();
    const headers = wrapper
      .find('[data-testid="audit-panel-auth"] table')
      .findAll("th")
      .map((th) => th.text());
    expect(headers).toEqual([
      "用户名",
      "认证类型",
      "状态",
      "失败原因",
      "客户端 IP",
      "时间",
    ]);
  });

  it("时间经 formatEpochMs 渲染（Unix 毫秒 → YYYY-MM-DD HH:mm:ss，不出现荒谬年份）", async () => {
    const wrapper = await mountPage();
    const row = authRows(wrapper)[0]!;
    expect(row.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    expect(row.text()).not.toContain("58563");
    // Unix 毫秒直接 new Date（不再乘 1000）
    expect(row.text()).toContain("2024-10");
  });

  it("ctime 缺失 → 时间列 '—'（不渲染 1970 / undefined）", async () => {
    listAuthLogsMock.mockResolvedValue(
      pageOf([makeAuthLog({ ctime: undefined })]),
    );
    const wrapper = await mountPage();
    const row = authRows(wrapper)[0]!;
    expect(row.text()).toContain("—");
    expect(row.text()).not.toContain("1970");
    expect(row.text()).not.toContain("undefined");
  });

  it("空态：无日志显示 audit-auth-empty「暂无认证审计日志」", async () => {
    listAuthLogsMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    const empty = wrapper.find('[data-testid="audit-auth-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("暂无认证审计日志");
    expect(authRows(wrapper)).toHaveLength(0);
  });

  it("错误态：audit-auth-error 展示 eiam msg 原文 + 重试重查", async () => {
    listAuthLogsMock.mockRejectedValueOnce(new Error("eiam 不可用"));
    const wrapper = await mountPage();

    const errorBox = wrapper.find('[data-testid="audit-auth-error"]');
    expect(errorBox.exists()).toBe(true);
    expect(errorBox.text()).toContain("eiam 不可用");
    expect(authRows(wrapper)).toHaveLength(0);

    await wrapper.find('[data-testid="audit-auth-retry"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenCalledTimes(2);
    expect(authRows(wrapper)).toHaveLength(1);
  });
});

describe("AuditLogList：操作审计表渲染", () => {
  it("行渲染操作人 / 服务 / 模块 / 动作 / 状态 / 时间；表头六列逐字", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);

    const headers = wrapper
      .find('[data-testid="audit-panel-operation"] table')
      .findAll("th")
      .map((th) => th.text());
    expect(headers).toEqual(["操作人", "服务", "模块", "动作", "状态", "时间"]);

    const rows = opRows(wrapper);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("alice");
    expect(rows[0]!.text()).toContain("eiam");
    expect(rows[0]!.text()).toContain("user");
    expect(rows[0]!.text()).toContain("create");
    expect(rows[0]!.text()).toContain("SUCCESS");
    expect(rows[0]!.text()).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it("可选字段缺失 → 各列 '—'", async () => {
    listOperationLogsMock.mockResolvedValue(
      pageOf([
        makeOperationLog({
          id: 12,
          operatorName: undefined,
          service: undefined,
          module: undefined,
          action: undefined,
          status: undefined,
          ctime: undefined,
        }),
      ]),
    );
    const wrapper = await mountPage();
    await switchToOperation(wrapper);
    const row = opRows(wrapper)[0]!;
    expect(row.findAll("td").map((td) => td.text())).toEqual([
      "—",
      "—",
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  it("空态：audit-operation-empty「暂无操作审计日志」", async () => {
    listOperationLogsMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountPage();
    await switchToOperation(wrapper);

    const empty = wrapper.find('[data-testid="audit-operation-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("暂无操作审计日志");
    expect(opRows(wrapper)).toHaveLength(0);
  });

  it("错误态：audit-operation-error + 重试", async () => {
    listOperationLogsMock.mockRejectedValueOnce(new Error("审计库不可用"));
    const wrapper = await mountPage();
    await switchToOperation(wrapper);

    const errorBox = wrapper.find('[data-testid="audit-operation-error"]');
    expect(errorBox.exists()).toBe(true);
    expect(errorBox.text()).toContain("审计库不可用");

    await wrapper
      .find('[data-testid="audit-operation-retry"]')
      .trigger("click");
    await flushPromises();
    expect(listOperationLogsMock).toHaveBeenCalledTimes(2);
    expect(opRows(wrapper)).toHaveLength(1);
  });
});

describe("AuditLogList：认证审计筛选", () => {
  it("全量筛选 → 载荷含 snake_case 语义键（authType/status/startTime/endTime）且回第 1 页", async () => {
    listAuthLogsMock.mockResolvedValue(pageOf([makeAuthLog()], 200));
    const wrapper = await mountPage();

    // 先翻到第 2 页，再筛选 → 必须回第 1 页
    await wrapper.find('[data-testid="audit-auth-page-next"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 20, limit: 20 });

    await wrapper
      .find('[data-testid="audit-filter-username"]')
      .setValue(" bob ");
    await wrapper
      .find('[data-testid="audit-filter-auth-type"]')
      .setValue("password");
    await wrapper.find('[data-testid="audit-filter-status"]').setValue("FAIL");
    await wrapper
      .find('[data-testid="audit-filter-start"]')
      .setValue("2026-10-01T09:30");
    await wrapper
      .find('[data-testid="audit-filter-end"]')
      .setValue("2026-10-02T09:30");
    await searchAuth(wrapper);

    expect(listAuthLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      username: "bob",
      authType: "password",
      status: "FAIL",
      startTime: new Date("2026-10-01T09:30").getTime(),
      endTime: new Date("2026-10-02T09:30").getTime(),
    });
  });

  it("空筛选不上行：只改空白/空值 → 载荷仍只有分页两键", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="audit-filter-username"]').setValue("   ");
    await wrapper.find('[data-testid="audit-filter-auth-type"]').setValue("");
    await wrapper.find('[data-testid="audit-filter-status"]').setValue("");
    await searchAuth(wrapper);

    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 0, limit: 20 });
    const payload = listAuthLogsMock.mock.calls[
      listAuthLogsMock.mock.calls.length - 1
    ]![0];
    expect(Object.keys(payload).sort()).toEqual(["limit", "offset"]);
  });

  it("只填用户名 → 只上行 username（其余空键不出现）", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="audit-filter-username"]').setValue("eve");
    await searchAuth(wrapper);

    expect(listAuthLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      username: "eve",
    });
  });

  it("重置 → 清空筛选并重拉（载荷回到纯分页）", async () => {
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="audit-filter-username"]').setValue("bob");
    await searchAuth(wrapper);
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      username: "bob",
    });

    await wrapper.find('[data-testid="audit-auth-reset"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 0, limit: 20 });
    // 输入框也被清空
    expect(
      (
        wrapper.find('[data-testid="audit-filter-username"]')
          .element as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("翻页沿用已生效筛选（不是草稿）", async () => {
    listAuthLogsMock.mockResolvedValue(pageOf([makeAuthLog()], 200));
    const wrapper = await mountPage();
    await wrapper.find('[data-testid="audit-filter-username"]').setValue("bob");
    await searchAuth(wrapper);
    // 改了草稿但不提交
    await wrapper.find('[data-testid="audit-filter-username"]').setValue("eve");

    await wrapper.find('[data-testid="audit-auth-page-next"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({
      offset: 20,
      limit: 20,
      username: "bob",
    });
  });
});

describe("AuditLogList：操作审计筛选", () => {
  it("全量筛选 → 载荷含 operatorName/service/module/action/status", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);

    await wrapper
      .find('[data-testid="audit-filter-operator"]')
      .setValue(" alice ");
    await wrapper.find('[data-testid="audit-filter-service"]').setValue("eiam");
    await wrapper.find('[data-testid="audit-filter-module"]').setValue("role");
    await wrapper.find('[data-testid="audit-filter-action"]').setValue("assign");
    await wrapper
      .find('[data-testid="audit-filter-status"]')
      .setValue("SUCCESS");
    await searchOperation(wrapper);

    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      operatorName: "alice",
      service: "eiam",
      module: "role",
      action: "assign",
      status: "SUCCESS",
    });
  });

  it("空筛选不上行（操作页签无时间维度，载荷只有分页两键）", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);
    await wrapper.find('[data-testid="audit-filter-operator"]').setValue(" ");
    await wrapper.find('[data-testid="audit-filter-status"]').setValue("");
    await searchOperation(wrapper);

    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
    });
    const payload = listOperationLogsMock.mock.calls[
      listOperationLogsMock.mock.calls.length - 1
    ]![0];
    expect(Object.keys(payload).sort()).toEqual(["limit", "offset"]);
  });

  it("重置 → 清空筛选并重拉", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);
    await wrapper.find('[data-testid="audit-filter-service"]').setValue("eiam");
    await searchOperation(wrapper);
    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
      service: "eiam",
    });

    await wrapper
      .find('[data-testid="audit-operation-reset"]')
      .trigger("click");
    await flushPromises();
    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
    });
  });
});

describe("AuditLogList：分页（20·50·100）", () => {
  it("认证审计：第 1 页上一页禁用 / 选项 20·50·100 / 页大小切换回第 1 页 / 下一页推进 offset", async () => {
    listAuthLogsMock.mockResolvedValue(pageOf([makeAuthLog()], 120));
    const wrapper = await mountPage();

    expect(
      wrapper
        .find('[data-testid="audit-auth-page-prev"]')
        .attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 6 页");

    const options = wrapper
      .find('[data-testid="audit-auth-page-size"]')
      .findAll("option")
      .map((o) => Number(o.attributes("value")));
    expect(options).toEqual([20, 50, 100]);

    await wrapper.find('[data-testid="audit-auth-page-size"]').setValue("50");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 0, limit: 50 });
    expect(wrapper.find(".pagination__info").text()).toContain("第 1 / 3 页");

    await wrapper.find('[data-testid="audit-auth-page-next"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 50, limit: 50 });
  });

  it("操作审计：分页同样 20·50·100 且与认证页签互不干扰", async () => {
    listAuthLogsMock.mockResolvedValue(pageOf([makeAuthLog()], 120));
    listOperationLogsMock.mockResolvedValue(pageOf([makeOperationLog()], 45));
    const wrapper = await mountPage();
    // 认证页签先切到 50/页 + 第 2 页
    await wrapper.find('[data-testid="audit-auth-page-size"]').setValue("50");
    await flushPromises();
    await wrapper.find('[data-testid="audit-auth-page-next"]').trigger("click");
    await flushPromises();

    await switchToOperation(wrapper);
    // 操作页签仍从第 1 页 / 20 条开始
    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 20,
    });
    expect(
      wrapper
        .find('[data-testid="audit-operation-page-prev"]')
        .attributes("disabled"),
    ).toBeDefined();

    await wrapper
      .find('[data-testid="audit-operation-page-size"]')
      .setValue("100");
    await flushPromises();
    expect(listOperationLogsMock).toHaveBeenLastCalledWith({
      offset: 0,
      limit: 100,
    });

    // 回认证页签：分页态保持（50 / 第 2 页）
    await wrapper.find('[data-testid="audit-tab-auth"]').trigger("click");
    await flushPromises();
    expect(listAuthLogsMock).toHaveBeenLastCalledWith({ offset: 50, limit: 50 });
  });
});

describe("AuditLogList：契约 §2.3 testid 清单", () => {
  it("认证审计页签的筛选 testid 全部存在", async () => {
    const wrapper = await mountPage();
    for (const id of [
      "audit-filter-username",
      "audit-filter-auth-type",
      "audit-filter-status",
      "audit-filter-start",
      "audit-filter-end",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
  });

  it("操作审计页签的筛选 testid 全部存在", async () => {
    const wrapper = await mountPage();
    await switchToOperation(wrapper);
    for (const id of [
      "audit-filter-operator",
      "audit-filter-service",
      "audit-filter-module",
      "audit-filter-action",
      "audit-filter-status",
    ]) {
      expect(wrapper.find(`[data-testid="${id}"]`).exists()).toBe(true);
    }
  });
});

describe("AuditLogList：权限裁剪与只读", () => {
  it("缺 VIEW_AUTH → 认证页签与面板不渲染，也不请求 auth/list", async () => {
    const wrapper = await mountPage([IAM_AUDIT.VIEW_OPERATION]);

    expect(wrapper.find('[data-testid="audit-tab-auth"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="audit-panel-auth"]').exists()).toBe(
      false,
    );
    expect(listAuthLogsMock).not.toHaveBeenCalled();
    // 操作页签成为默认视图并正常加载
    expect(
      wrapper
        .find('[data-testid="audit-tab-operation"]')
        .attributes("aria-selected"),
    ).toBe("true");
    expect(listOperationLogsMock).toHaveBeenCalledTimes(1);
  });

  it("缺 VIEW_OPERATION → 操作页签与面板不渲染，也不请求 operation/list", async () => {
    const wrapper = await mountPage([IAM_AUDIT.VIEW_AUTH]);

    expect(
      wrapper.find('[data-testid="audit-tab-operation"]').exists(),
    ).toBe(false);
    expect(
      wrapper.find('[data-testid="audit-panel-operation"]').exists(),
    ).toBe(false);
    expect(listOperationLogsMock).not.toHaveBeenCalled();
    expect(listAuthLogsMock).toHaveBeenCalledTimes(1);
    expect(authRows(wrapper)).toHaveLength(1);
  });

  it("两个码都没有 → 无页签、无面板、零请求", async () => {
    const wrapper = await mountPage([]);

    expect(wrapper.find('[data-testid="page-audit"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="audit-tab-auth"]').exists()).toBe(false);
    expect(
      wrapper.find('[data-testid="audit-tab-operation"]').exists(),
    ).toBe(false);
    expect(wrapper.find('[data-testid="audit-no-permission"]').exists()).toBe(
      true,
    );
    expect(listAuthLogsMock).not.toHaveBeenCalled();
    expect(listOperationLogsMock).not.toHaveBeenCalled();
  });

  it("严格只读：两张表行内均无按钮，页内无编辑/删除入口", async () => {
    const wrapper = await mountPage();

    for (const row of authRows(wrapper)) {
      expect(row.findAll("button")).toHaveLength(0);
    }

    await switchToOperation(wrapper);
    for (const row of opRows(wrapper)) {
      expect(row.findAll("button")).toHaveLength(0);
    }

    // 页内按钮只有页签 / 查询 / 重置 / 分页（无「新建 / 编辑 / 删除 / 导出」）
    const buttonTexts = wrapper.findAll("button").map((b) => b.text());
    for (const label of ["新建", "创建", "编辑", "删除", "导出", "清理"]) {
      expect(buttonTexts.some((t) => t.includes(label))).toBe(false);
    }
    // 也无表格内的行操作列
    expect(wrapper.findAll("th").map((th) => th.text())).not.toContain("操作");
  });
});
