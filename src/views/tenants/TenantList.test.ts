// @vitest-environment happy-dom
/**
 * TenantList「治理配置」列渲染形态测试（feat-tenant-usage-stats 验收 U1–U5 的 DOM 契约）。
 *
 * 纯函数分支由 ./usage.test.ts 覆盖；本文件锁定**组件渲染后**用户可观察的内容：
 * - `data-testid="tenant-governance"` 仍在（验收脚本定位依赖，契约 §4.4）；
 * - 用量 / 上限文案形态：'用户 5 / 50'、'组 3 / 20'、'5 / 不限'、'— / 50'；
 * - 超限段渲染 .is-over + 「超出配额」标记；
 * - 原有「N 家厂商 · M 项开关」摘要未丢失。
 *
 * 手法：mock tenantList store（组件只读消费，不触网络）；真实 user store 注入权限码。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createApp } from "vue";
import TenantList from "./TenantList.vue";
import { useUserStore } from "@/stores/user";
import { IAM_TENANT } from "@/config/permission-codes";
import type { Tenant } from "@/api/types";

// ---- fake tenantList store（同一对象按用例改 items）----
const fakeListStore = {
  items: [] as Tenant[],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null as string | null,
  disableBlocked: null as { count: number; message: string } | null,
  fetch: vi.fn().mockResolvedValue(undefined),
  setKeyword: vi.fn(),
  setPage: vi.fn(),
  setPageSize: vi.fn(),
  clearDisableBlocked: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  setDefault: vi.fn(),
};

vi.mock("@/stores/tenantList", () => ({
  useTenantListStore: () => fakeListStore,
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

/** 基线租户：治理配置齐全（账号 10 / 用户配额 50 / 组配额 20，2 家厂商 1 项开关） */
function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 1,
    name: "深圳市嘉立创科技发展有限公司",
    code: "jlc",
    domain: "",
    status: "active",
    maxAccounts: 10,
    maxUsers: 50,
    maxUserGroups: 20,
    featureSwitch: { cdn: true },
    allowedVendors: ["aliyun", "aws"],
    userCount: 5,
    userGroupCount: 3,
    ...overrides,
  };
}

function mountWith(items: Tenant[]) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    IAM_TENANT.VIEW,
    IAM_TENANT.EDIT,
  ];
  fakeListStore.items = items;
  fakeListStore.total = items.length;
  return mount(TenantList);
}

function governanceCell(wrapper: ReturnType<typeof mountWith>) {
  const cell = wrapper.find('[data-testid="tenant-governance"]');
  expect(cell.exists()).toBe(true);
  return cell;
}

describe("TenantList：治理配置列「用量 / 上限」渲染", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("U1/U2：用量已知 + 配额 > 0 → '用户 5 / 50'、'组 3 / 20'，保留厂商/开关摘要", () => {
    const cell = governanceCell(mountWith([makeTenant()]));
    const text = cell.text();
    expect(text).toContain("用户 5 / 50");
    expect(text).toContain("组 3 / 20");
    expect(text).toContain("账号 10");
    // 原有摘要部分未被本轮改动丢弃
    expect(text).toContain("2 家厂商");
    expect(text).toContain("1 项开关");
    // 可见文本整行排版（空白归一后）——锁死分隔符，避免 / 与 · 混淆
    expect(text.replace(/\s+/g, " ").trim()).toBe(
      "账号 10 · 用户 5 / 50 · 组 3 / 20 · 2 家厂商 · 1 项开关",
    );
  });

  it("U3：配额 0（不限制）→ '用户 5 / 不限'，不渲染超限标记", () => {
    const wrapper = mountWith([makeTenant({ maxUsers: 0, maxUserGroups: 0 })]);
    const cell = governanceCell(wrapper);
    expect(cell.text()).toContain("用户 5 / 不限");
    expect(cell.text()).toContain("组 3 / 不限");
    expect(wrapper.find(".governance-cell__seg.is-over").exists()).toBe(false);
    expect(cell.text()).not.toContain("超出配额");
  });

  it("U5：用量缺失（统计不可用）→ '用户 — / 50'，绝不渲染 0", () => {
    const wrapper = mountWith([
      makeTenant({ userCount: undefined, userGroupCount: undefined }),
    ]);
    const text = governanceCell(wrapper).text();
    expect(text).toContain("用户 — / 50");
    expect(text).toContain("组 — / 20");
    expect(text).not.toContain("用户 0");
    expect(wrapper.find(".governance-cell__seg.is-over").exists()).toBe(false);
  });

  it("U4：用量 > 配额 → 该段 .is-over + 「超出配额」标记（仅超限段）", () => {
    const wrapper = mountWith([makeTenant({ userCount: 51, userGroupCount: 3 })]);
    const cell = governanceCell(wrapper);
    expect(cell.text()).toContain("用户 51 / 50");
    expect(cell.text()).toContain("超出配额");
    // 用量与标记之间可读（空白归一后）
    expect(cell.text().replace(/\s+/g, " ")).toContain("用户 51 / 50 超出配额");

    const overSegs = wrapper.findAll(".governance-cell__seg.is-over");
    expect(overSegs).toHaveLength(1);
    expect(overSegs[0]!.attributes("data-testid")).toBe("tenant-usage-users");
    // 组段未超限 → 不带危险色类
    expect(
      wrapper.find('[data-testid="tenant-usage-groups"]').classes(),
    ).not.toContain("is-over");
  });

  it("用量 = 配额（用满）不触发超限样式", () => {
    const wrapper = mountWith([makeTenant({ userCount: 50 })]);
    expect(wrapper.find(".governance-cell__seg.is-over").exists()).toBe(false);
    expect(governanceCell(wrapper).text()).toContain("用户 50 / 50");
  });

  it("整行文本可由 title 读取（与可见文本同源，便于人工核对）", () => {
    const wrapper = mountWith([makeTenant()]);
    expect(
      governanceCell(wrapper).attributes("title"),
    ).toBe("账号 10 · 用户 5 / 50 · 组 3 / 20 · 2 家厂商 · 1 项开关");
  });
});
