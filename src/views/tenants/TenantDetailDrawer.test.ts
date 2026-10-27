// @vitest-environment happy-dom
/**
 * TenantDetailDrawer 组件行为测试（feat-tenant-detail-ui 契约 §2.2/§2.3/§3，验收 T1–T9 的 DOM 契约）。
 *
 * 锁定用户可观察行为（api 层 mock，不触真实网络）：
 * - 打开即按 tenant.id 取详情；三块信息（基本信息 / 治理配置 / 用量）渲染；
 * - 展示口径：配额 0 → 「不限制」；白名单空 → 「全部允许」；开关空 → 「无」；
 *   用量 undefined → 「—」；用量 > 配额 > 0 → 危险色 + 「超出配额」；创建时间缺失 / 0 → 「—」；
 * - 失败（含 404 / 无权限 / 网络）→ 服务端文案原文 + 「重试」可恢复；
 * - 响应缺 id（null）→ 「未找到」提示；
 * - 关闭 emit('close')，父级置 null 后不产生新请求；tenant=null 不渲染不取数；
 * - 严格只读：无可编辑控件、无提交 / 保存 / 删除入口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import TenantDetailDrawer from "./TenantDetailDrawer.vue";
import { ApiError, type Tenant } from "@/api/types";
import { getTenantDetail } from "@/api/tenants";

vi.mock("@/api/tenants", () => ({
  getTenantDetail: vi.fn(),
}));

const detailMock = vi.mocked(getTenantDetail);

const TENANT = { id: 7, name: "甲租户" };

function makeDetail(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 7,
    name: "甲租户",
    code: "jia",
    domain: "jia.example.com",
    status: "active",
    maxAccounts: 10,
    maxUsers: 50,
    maxUserGroups: 20,
    featureSwitch: { cdn: true, waf: false },
    allowedVendors: ["aliyun", "aws"],
    userCount: 6,
    userGroupCount: 3,
    ctime: 1_730_000_000_000,  // eiam 为 Unix **毫秒**（time.Now().UnixMilli()）
    ...overrides,
  };
}

async function mountDrawer(
  tenant: { id: number; name: string } | null = TENANT,
): Promise<ReturnType<typeof mount>> {
  const wrapper = mount(TenantDetailDrawer, { props: { tenant } });
  await flushPromises();
  return wrapper;
}

function byTestId(wrapper: ReturnType<typeof mount>, id: string) {
  return wrapper.find(`[data-testid="${id}"]`);
}

describe("TenantDetailDrawer：打开 / 取数", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailMock.mockResolvedValue(makeDetail());
  });

  it("打开即按 tenant.id 取详情，三块信息齐备", async () => {
    const wrapper = await mountDrawer();

    expect(detailMock).toHaveBeenCalledTimes(1);
    expect(detailMock).toHaveBeenCalledWith(7);
    expect(byTestId(wrapper, "tenant-detail-drawer").exists()).toBe(true);
    expect(byTestId(wrapper, "detail-basic").exists()).toBe(true);
    expect(byTestId(wrapper, "detail-governance").exists()).toBe(true);
    expect(byTestId(wrapper, "detail-usage").exists()).toBe(true);
    expect(wrapper.text()).toContain("甲租户 · 详情");
  });

  it("基本信息：名称 / 编码 / 域名 / 状态 / 创建时间", async () => {
    const wrapper = await mountDrawer();

    expect(byTestId(wrapper, "detail-name").text()).toBe("甲租户");
    expect(byTestId(wrapper, "detail-code").text()).toBe("jia");
    expect(byTestId(wrapper, "detail-domain").text()).toBe("jia.example.com");
    expect(byTestId(wrapper, "detail-basic").text()).toContain("启用");
    // eiam ctime 是**毫秒**：格式化后必须是合理年份（曾因按秒处理显示成 58563 年）
    const ctime = byTestId(wrapper, "detail-ctime").text();
    expect(ctime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const year = Number(ctime.slice(0, 4));
    expect(year).toBeGreaterThanOrEqual(2000);
    expect(year).toBeLessThanOrEqual(2100);
  });

  it("创建时间缺失 / 0 → '—'（不渲染 1970）", async () => {
    detailMock.mockResolvedValue(makeDetail({ ctime: 0 }));
    const zero = await mountDrawer();
    expect(byTestId(zero, "detail-ctime").text()).toBe("—");

    detailMock.mockResolvedValue(makeDetail({ ctime: undefined }));
    const missing = await mountDrawer();
    expect(byTestId(missing, "detail-ctime").text()).toBe("—");
  });

  it("tenant=null → 不渲染且不取数", async () => {
    const wrapper = await mountDrawer(null);
    expect(byTestId(wrapper, "tenant-detail-drawer").exists()).toBe(false);
    expect(detailMock).not.toHaveBeenCalled();
  });

  it("关闭：emit close；父级置 null 后不再发请求", async () => {
    const wrapper = await mountDrawer();

    await byTestId(wrapper, "detail-close").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);

    await wrapper.setProps({ tenant: null });
    await flushPromises();
    expect(byTestId(wrapper, "tenant-detail-drawer").exists()).toBe(false);
    expect(detailMock).toHaveBeenCalledTimes(1);
  });

  it("Escape 关闭抽屉（走同一条关闭路径）", async () => {
    const wrapper = await mountDrawer();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await flushPromises();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});

describe("TenantDetailDrawer：治理配置展示口径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("配额 0 → 「不限制」，正数 → 原值", async () => {
    detailMock.mockResolvedValue(
      makeDetail({ maxAccounts: 0, maxUsers: 50, maxUserGroups: 0 }),
    );
    const wrapper = await mountDrawer();

    expect(byTestId(wrapper, "detail-quota-accounts").text()).toContain(
      "不限制",
    );
    expect(byTestId(wrapper, "detail-quota-users").text()).toContain("50");
    expect(byTestId(wrapper, "detail-quota-users").text()).not.toContain(
      "不限制",
    );
    expect(byTestId(wrapper, "detail-quota-groups").text()).toContain("不限制");
  });

  it("白名单非空 → 逐个展示；空 → 「全部允许」", async () => {
    detailMock.mockResolvedValue(makeDetail());
    const withVendors = await mountDrawer();
    const vendors = byTestId(withVendors, "detail-vendors");
    expect(vendors.text()).toContain("aliyun");
    expect(vendors.text()).toContain("aws");
    expect(vendors.text()).not.toContain("全部允许");

    detailMock.mockResolvedValue(makeDetail({ allowedVendors: [] }));
    const empty = await mountDrawer();
    expect(byTestId(empty, "detail-vendors").text()).toContain("全部允许");
  });

  it("开关非空 → k=启用/禁用；空 → 「无」", async () => {
    detailMock.mockResolvedValue(makeDetail());
    const withSwitches = await mountDrawer();
    const switches = byTestId(withSwitches, "detail-switches");
    expect(switches.text()).toContain("cdn=启用");
    expect(switches.text()).toContain("waf=禁用");

    detailMock.mockResolvedValue(makeDetail({ featureSwitch: {} }));
    const empty = await mountDrawer();
    expect(byTestId(empty, "detail-switches").text().trim()).toBe("无");
  });
});

describe("TenantDetailDrawer：用量展示口径", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("用量已知 → 「用户 6 / 50」「用户组 3 / 20」", async () => {
    detailMock.mockResolvedValue(makeDetail());
    const wrapper = await mountDrawer();

    expect(byTestId(wrapper, "detail-usage-users-value").text()).toContain(
      "6 / 50",
    );
    expect(byTestId(wrapper, "detail-usage-groups-value").text()).toContain(
      "3 / 20",
    );
    expect(wrapper.findAll('[data-testid="detail-over-quota"]')).toHaveLength(0);
  });

  it("用量 undefined → '— / 50'（不渲染 0）", async () => {
    detailMock.mockResolvedValue(
      makeDetail({ userCount: undefined, userGroupCount: undefined }),
    );
    const wrapper = await mountDrawer();

    const users = byTestId(wrapper, "detail-usage-users-value").text();
    expect(users).toContain("— / 50");
    expect(users).not.toContain("0 / 50");
    expect(byTestId(wrapper, "detail-usage-groups-value").text()).toContain(
      "— / 20",
    );
  });

  it("用量 0（真实为零）→ '0 / 50'，与 undefined 区分", async () => {
    detailMock.mockResolvedValue(makeDetail({ userCount: 0 }));
    const wrapper = await mountDrawer();
    expect(byTestId(wrapper, "detail-usage-users-value").text()).toContain(
      "0 / 50",
    );
  });

  it("超限（用量 > 配额 > 0）→ 危险色段 + 「超出配额」", async () => {
    detailMock.mockResolvedValue(makeDetail({ userCount: 51, maxUsers: 50 }));
    const wrapper = await mountDrawer();

    const users = byTestId(wrapper, "detail-usage-users-value");
    expect(users.text()).toContain("51 / 50");
    expect(users.text()).toContain("超出配额");
    expect(users.classes()).toContain("is-over");
    // 另一段不受影响
    expect(byTestId(wrapper, "detail-usage-groups-value").classes()).not.toContain(
      "is-over",
    );
  });

  it("配额 0（不限）→ 不判超限", async () => {
    detailMock.mockResolvedValue(
      makeDetail({ userCount: 9999, maxUsers: 0 }),
    );
    const wrapper = await mountDrawer();
    expect(byTestId(wrapper, "detail-usage-users-value").text()).toContain(
      "9999 / 不限制",
    );
    expect(byTestId(wrapper, "detail-usage-users-value").classes()).not.toContain(
      "is-over",
    );
  });
});

describe("TenantDetailDrawer：失败 / 未找到 / 重试", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("接口失败 → 服务端文案原文 + 「重试」可恢复", async () => {
    detailMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountDrawer();

    const error = byTestId(wrapper, "detail-error");
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");
    expect(byTestId(wrapper, "detail-basic").exists()).toBe(false);

    detailMock.mockResolvedValue(makeDetail());
    await byTestId(wrapper, "detail-retry").trigger("click");
    await flushPromises();

    expect(detailMock).toHaveBeenCalledTimes(2);
    expect(byTestId(wrapper, "detail-error").exists()).toBe(false);
    expect(byTestId(wrapper, "detail-basic").exists()).toBe(true);
  });

  it("404 / 无权限（业务码）→ 原文展示，不伪造权限逻辑", async () => {
    detailMock.mockRejectedValueOnce(
      new ApiError("forbidden", "无权访问该租户", { code: 4020910 }),
    );
    const wrapper = await mountDrawer();
    expect(byTestId(wrapper, "detail-error").text()).toContain("无权访问该租户");
  });

  it("响应缺 id（null）→ 「未找到」提示，不渲染半截信息", async () => {
    detailMock.mockResolvedValueOnce(null);
    const wrapper = await mountDrawer();

    const error = byTestId(wrapper, "detail-error");
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("未找到");
    expect(byTestId(wrapper, "detail-usage").exists()).toBe(false);
    // 仍可重试
    expect(byTestId(wrapper, "detail-retry").exists()).toBe(true);
  });
});

describe("TenantDetailDrawer：严格只读", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailMock.mockResolvedValue(makeDetail());
  });

  it("无可编辑控件、无提交 / 保存 / 删除入口", async () => {
    const wrapper = await mountDrawer();

    expect(wrapper.find("input").exists()).toBe(false);
    expect(wrapper.find("select").exists()).toBe(false);
    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(wrapper.find("form").exists()).toBe(false);
    const labels = wrapper.findAll("button").map((b) => b.text());
    expect(labels).toEqual(["✕", "关闭"]);
  });
});
