// @vitest-environment happy-dom
/**
 * TenantList 状态筛选（feat-tenant-status-filter 验收 S1–S8 的 DOM 契约）。
 *
 * 锁定**组件渲染后**用户可观察的行为：
 * - S1：工具栏出现「状态」下拉（data-testid="tenant-status-filter"），默认「全部」，原生 select；
 * - S2/S3：选择「禁用」/「启用」→ store.setStatus(n) + store.fetch()（change 即生效）；
 * - S8：点「重置」→ 关键词与状态同时清空（setKeyword("") + setStatus(0)），回到第 1 页；
 * - 空态：筛选无结果时仍显示「暂无租户数据」，且不清空筛选条件。
 *
 * 手法：mock tenantList store（组件只读消费 + 监听动作，不触网络）；真实 user store 注入权限码。
 * 原生 select 是契约硬要求（§4.3），故断言元素 tagName 为 SELECT、且未引入组件库。
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

// ---- fake tenantList store（同一对象按用例改状态）----
const fakeListStore = {
  items: [] as Tenant[],
  total: 0,
  page: 1,
  pageSize: 20,
  loading: false,
  error: null as string | null,
  keyword: "",
  status: 0,
  disableBlocked: null as { count: number; message: string } | null,
  fetch: vi.fn().mockResolvedValue(undefined),
  setKeyword: vi.fn(),
  setStatus: vi.fn(),
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

function mountView(): ReturnType<typeof mount> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    IAM_TENANT.VIEW,
    IAM_TENANT.EDIT,
  ];
  return mount(TenantList);
}

function statusSelect(wrapper: ReturnType<typeof mountView>) {
  const select = wrapper.find('[data-testid="tenant-status-filter"]');
  expect(select.exists()).toBe(true);
  return select;
}

function buttonByText(wrapper: ReturnType<typeof mountView>, text: string) {
  const btn = wrapper
    .findAll("button")
    .find((b) => b.text().replace(/\s+/g, "") === text);
  expect(btn).toBeTruthy();
  return btn!;
}

describe("TenantList：状态筛选下拉（feat-tenant-status-filter §4.3）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeListStore.items = [];
    fakeListStore.total = 0;
    fakeListStore.status = 0;
    fakeListStore.page = 1;
    fakeListStore.loading = false;
    fakeListStore.error = null;
  });

  it("S1：工具栏渲染原生 select，默认「全部」，选项 全部(0)/启用(1)/禁用(2)", () => {
    const wrapper = mountView();
    const select = statusSelect(wrapper);
    // 必须原生 select（该页原生元素风格，不引入 Element Plus）
    expect(select.element.tagName).toBe("SELECT");
    expect(select.classes()).toContain("input");
    // 默认全部（0）
    expect((select.element as HTMLSelectElement).value).toBe("0");

    const options = select.findAll("option");
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.text())).toEqual(["全部", "启用", "禁用"]);
    expect(options.map((o) => o.attributes("value"))).toEqual([
      "0",
      "1",
      "2",
    ]);
  });

  it("S2：选择「禁用」→ setStatus(2) + fetch（change 即生效）", async () => {
    const wrapper = mountView();
    await statusSelect(wrapper).setValue("2");
    expect(fakeListStore.setStatus).toHaveBeenCalledWith(2);
    expect(fakeListStore.fetch).toHaveBeenCalled();
  });

  it("S3：选择「启用」→ setStatus(1) + fetch", async () => {
    const wrapper = mountView();
    await statusSelect(wrapper).setValue("1");
    expect(fakeListStore.setStatus).toHaveBeenCalledWith(1);
    expect(fakeListStore.fetch).toHaveBeenCalled();
  });

  it("S8：点「重置」→ 关键词与状态同时清空，并重查", async () => {
    const wrapper = mountView();
    await buttonByText(wrapper, "重置").trigger("click");
    expect(fakeListStore.setKeyword).toHaveBeenCalledWith("");
    expect(fakeListStore.setStatus).toHaveBeenCalledWith(0);
    expect(fakeListStore.fetch).toHaveBeenCalled();
    // 关键词输入框被清空（local ref 同步）
    expect(
      (wrapper.find('[data-testid="tenant-search"]').element as HTMLInputElement)
        .value,
    ).toBe("");
  });

  it("筛选无结果 → 空态文案与「本来无数据」区分，且筛选条件保留", () => {
    // 模拟「选禁用后无结果」：status 已为 2，列表为空
    fakeListStore.status = 2;
    const wrapper = mountView();
    // 行为变更（本轮 UI 优化）：筛选无结果不再复用「暂无租户数据」，
    // 改为区分文案 + 就地「清除筛选」出口，避免把「没匹配」说成「没数据」。
    const empty = wrapper.find(".state-empty");
    expect(empty.text()).toContain("没有匹配的租户");
    expect(empty.find('[data-testid="clear-filters"]').exists()).toBe(true);
    // 筛选条件不清空（下拉仍停在「禁用」）—— 与上述「就地清除」不冲突：清除需用户显式点击
    expect(
      (statusSelect(wrapper).element as HTMLSelectElement).value,
    ).toBe("2");
  });

  it("无筛选且列表为空 → 仍显示「暂无租户数据」", () => {
    fakeListStore.status = 0;
    fakeListStore.keyword = "";
    const wrapper = mountView();
    expect(wrapper.find(".state-empty").text()).toContain("暂无租户数据");
    expect(wrapper.find('[data-testid="clear-filters"]').exists()).toBe(false);
  });

  it("筛选请求不会误触重试分支（error 为空时不渲染 eiam.unavailable）", () => {
    fakeListStore.status = 1;
    const wrapper = mountView();
    expect(wrapper.find(".state-error").exists()).toBe(false);
  });
});
