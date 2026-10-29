// @vitest-environment happy-dom
// CommandPalette 单测（P2 全局搜索）：
// - 默认不渲染；hc:open-command-palette 事件 / Ctrl+K 唤起
// - 候选 = 权限可见菜单项（与侧边栏 groupedVisibleMenu 同口径）：admin 全量 / 零租户仅工作台
// - 输入过滤（标题子串）
// - 点击候选 → router.push 目的地；当前页不重复 push
// - Esc 关闭
//
// 注：组件 Teleport 到 body，故断言查 document.body 而非 wrapper 子树。
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp, nextTick } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { defineComponent } from "vue";
import CommandPalette from "./CommandPalette.vue";
import { useUserStore } from "@/stores/user";
import { IAM_ALL_CODES } from "@/config/permission-codes";

const freshPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

const stubPage = (label: string) =>
  defineComponent({ name: label, render: () => null });

async function makeRouter(path = "/workbench"): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/workbench", component: stubPage("Workbench") },
      { path: "/users", component: stubPage("Users") },
      { path: "/organizations", component: stubPage("Orgs") },
      { path: "/tenants", component: stubPage("Tenants") },
      { path: "/identity-sources", component: stubPage("Idp") },
      { path: "/groups", component: stubPage("Groups") },
      { path: "/invitations", component: stubPage("Invitations") },
      { path: "/roles", component: stubPage("Roles") },
      { path: "/authorizations", component: stubPage("Authz") },
      { path: "/policies", component: stubPage("Policies") },
    ],
  });
  await router.push(path);
  await router.isReady();
  return router;
}

async function mountPalette(
  opts: {
    isAdmin?: boolean;
    tenantsCount?: number;
    codes?: readonly string[];
    path?: string;
  } = {},
) {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = opts.isAdmin ?? false;
  (userStore as unknown as { permissions: string[] }).permissions = [
    ...(opts.codes ?? []),
  ];
  const tenants = Array.from({ length: opts.tenantsCount ?? 0 }, (_, i) => ({
    id: i + 1,
    name: `t${i + 1}`,
    code: "",
    domain: "",
  }));
  (userStore as unknown as { tenants: typeof tenants }).tenants = tenants;

  const router = await makeRouter(opts.path ?? "/workbench");
  const wrapper = mount(CommandPalette, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await nextTick();
  return { wrapper, userStore, router };
}

describe("CommandPalette（P2 全局搜索）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("默认不渲染；派发 hc:open-command-palette → 面板打开", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();

    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    expect(
      document.querySelector('[data-testid="command-palette"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("Ctrl+K 唤起 + 再次 Ctrl+K 关闭", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
    );
    await nextTick();
    expect(
      document.querySelector('[data-testid="command-palette"]'),
    ).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true }),
    );
    await nextTick();
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
    wrapper.unmount();
  });

  it("候选=权限可见菜单项：admin 全量 11 项", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    const items = document.querySelectorAll('[data-testid^="cmdk-item-"]');
    expect(items.length).toBe(11);
    expect(
      document.querySelector('[data-testid="cmdk-item-groups"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cmdk-item-invitations"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cmdk-item-audit"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("零租户受限态：候选仅工作台一项", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: false,
      tenantsCount: 0,
      codes: [],
    });
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    const items = document.querySelectorAll('[data-testid^="cmdk-item-"]');
    expect(items.length).toBe(1);
    expect(
      document.querySelector('[data-testid="cmdk-item-workbench"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("输入过滤：输入「角色」仅留角色管理", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    const input = document.querySelector(
      '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    input.value = "角色";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    const items = document.querySelectorAll('[data-testid^="cmdk-item-"]');
    expect(items.length).toBe(1);
    expect(
      document.querySelector('[data-testid="cmdk-item-roles"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("无匹配 → 空态提示", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    const input = document.querySelector(
      '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    input.value = "zzzzz不存在";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect(
      document.querySelector('[data-testid="command-palette-empty"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("点击候选 → router.push 目的地并关闭", async () => {
    const { wrapper, router } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
      path: "/workbench",
    });
    const pushSpy = vi.spyOn(router, "push");
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    const usersItem = document.querySelector(
      '[data-testid="cmdk-item-users"]',
    ) as HTMLElement;
    usersItem.click();
    await flushPromises();
    expect(pushSpy).toHaveBeenCalledWith("/users");
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
    wrapper.unmount();
  });

  it("Esc 关闭面板", async () => {
    const { wrapper } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
    });
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();
    expect(
      document.querySelector('[data-testid="command-palette"]'),
    ).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTick();
    expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
    wrapper.unmount();
  });

  it("最近访问：导航后记录，空查询时最近项带「最近」徽标并排在最前", async () => {
    const { wrapper, router } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
      path: "/workbench",
    });
    // 导航到角色管理 → 记录为最近访问
    await router.push("/roles");
    await flushPromises();

    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();

    // 空查询下首项即最近访问的角色管理
    const items = document.querySelectorAll('[data-testid^="cmdk-item-"]');
    expect(items[0]!.getAttribute("data-testid")).toBe("cmdk-item-roles");
    // 该项含「最近」徽标
    expect(
      items[0]!.querySelector('[data-testid="cmdk-recent-badge"]'),
    ).not.toBeNull();
    wrapper.unmount();
  });

  it("输入查询时不展示「最近」徽标（仅空查询态标注）", async () => {
    const { wrapper, router } = await mountPalette({
      isAdmin: true,
      tenantsCount: 2,
      codes: IAM_ALL_CODES,
      path: "/workbench",
    });
    await router.push("/roles");
    await flushPromises();
    window.dispatchEvent(new CustomEvent("hc:open-command-palette"));
    await nextTick();

    const input = document.querySelector(
      '[data-testid="command-palette-input"]',
    ) as HTMLInputElement;
    input.value = "角色";
    input.dispatchEvent(new Event("input"));
    await nextTick();
    expect(
      document.querySelector('[data-testid="cmdk-recent-badge"]'),
    ).toBeNull();
    wrapper.unmount();
  });
});
