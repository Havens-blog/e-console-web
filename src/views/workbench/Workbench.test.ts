// @vitest-environment happy-dom
/**
 * 工作台（UF-3）单测（task 3.3）。
 *
 * 覆盖 AC：
 * - 欢迎横幅 + 我的信息四字段（用户名/昵称/所属租户/角色）只读展示
 * - 应用快捷导航卡片：本地穷举「云管」+「CMDB」+「运维 Agent」+「WatchAlert」四项（opsagent=独立子项目入口），
 *   点击新标签跳转（window.open noopener）
 * - 统计概览：按权限码过滤（只读审计 → 用户/角色/组织 3 卡；平台管理员 → 4 卡含租户），
 *   best-effort 拉取（mock api 计数）
 * - 快捷操作：按权限码 + adminOnly 双闸过滤，站内跳转
 * - 公告：静态穷举 3 条
 * - 受限视图（零租户 E3）：仅欢迎+我的信息，卡片禁用，tenant.none 提示；平台管理员豁免
 * - eiam 不可用（E12）：静态内容仍渲染 + 顶部降级提示（eiam.unavailable），卡片跳转禁用
 *
 * 注：2 列/3 列断点为 CSS media query（1280–1599px / ≥1600px），happy-dom 不解析布局，
 * 断点行为由 Playwright E2E 承接（tech-design §Testing：页面级交互统一 E2E）；
 * 本单测覆盖卡片网格结构存在性 + 穷举项 + 点击跳转 + 禁用态。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import Workbench from "./Workbench.vue";
import { useUserStore } from "@/stores/user";
import { useTenantStore } from "@/stores/tenant";
import {
  IAM_DEPARTMENT,
  IAM_IDENTITY_SOURCE,
  IAM_PERMISSION,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
} from "@/config/permission-codes";

// ---- mock 统计 api（避免测试环境真实网络请求；best-effort 计数回填）----
vi.mock("@/api/users", () => ({
  listUsers: vi.fn().mockResolvedValue({ total: 5, items: [] }),
}));
vi.mock("@/api/roles", () => ({
  listRolesPage: vi.fn().mockResolvedValue({ total: 3, items: [] }),
}));
vi.mock("@/api/tenants", () => ({
  listTenants: vi.fn().mockResolvedValue({ total: 2, items: [] }),
}));
vi.mock("@/api/organizations", () => ({
  listOrganizationTree: vi.fn().mockResolvedValue([
    { id: 1, name: "总部", parentId: undefined, children: [{ id: 2, name: "研发部", parentId: 1, children: [] }] },
  ]),
}));
// 消除 useRouter 的 injection warning（工作台组件 setup 内 useRouter；测试无需真实路由）
vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/** 只读审计码集（P0：非管理员持 view 码 → 档位「只读/审计」） */
const READONLY_CODES: readonly string[] = [
  IAM_USER.VIEW,
  IAM_DEPARTMENT.VIEW,
  IAM_IDENTITY_SOURCE.VIEW,
  IAM_ROLE.VIEW,
  IAM_PERMISSION.VIEW_AUTHORIZATIONS,
];

/** 平台管理员码集（view 码含租户/策略，用于统计 4 卡 + 快捷 7 项断言） */
const ADMIN_VIEW_CODES: readonly string[] = [
  ...READONLY_CODES,
  IAM_TENANT.VIEW,
  IAM_POLICY.VIEW,
];

const freshPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

beforeEach(() => {
  localStorage.clear();
  freshPinia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 置 store 为「已加载 profile + 单租户 + 只读审计码集」的默认态（非 admin） */
function seedDefaultState(): void {
  const userStore = useUserStore();
  const tenantStore = useTenantStore();
  userStore.isAdmin = false;
  userStore.tenants = [{ id: 10, name: "Acme 租户", code: "acme", domain: "" }];
  // P0：权限码驱动档位（持 view 码 → 只读/审计）
  (
    userStore as unknown as {
      permissions: string[];
    }
  ).permissions = [...READONLY_CODES];
  tenantStore.setCurrentTenantId(10);
  // 直接写 profile（store 暴露的 ref，绕过 fetchProfile）
  (userStore as unknown as { profile: unknown }).profile = {
    id: 1,
    username: "alice",
    displayName: "爱丽丝",
  };
}

function mountWorkbench() {
  return mount(Workbench);
}

describe("工作台 Default 视图（UF-3）", () => {
  it("渲染欢迎横幅 + 我的信息四字段只读", () => {
    seedDefaultState();
    const wrapper = mountWorkbench();
    expect(wrapper.find('[data-testid="workbench"]').exists()).toBe(true);
    // 欢迎横幅含昵称
    expect(wrapper.text()).toContain("欢迎，爱丽丝");
    // 四字段只读展示（值 + label）
    expect(wrapper.find('[data-testid="profile-username"]').text()).toBe(
      "alice",
    );
    expect(wrapper.find('[data-testid="profile-nickname"]').text()).toBe(
      "爱丽丝",
    );
    expect(wrapper.find('[data-testid="profile-tenant"]').text()).toBe(
      "Acme 租户",
    );
    expect(wrapper.find('[data-testid="profile-role"]').text()).toBe(
      "只读/审计",
    );
    // profile 字段为 dd（只读，无 input）
    expect(wrapper.find("input").exists()).toBe(false);
  });

  it("应用卡片：本地穷举「云管」+「CMDB」+「运维 Agent」+「WatchAlert」四项", () => {
    seedDefaultState();
    const wrapper = mountWorkbench();
    const cards = wrapper.findAll('[data-testid^="app-card-"]');
    expect(cards).toHaveLength(4);
    expect(cards[0]?.text()).toContain("云管");
    expect(cards[1]?.text()).toContain("CMDB");
    expect(cards[2]?.text()).toContain("运维 Agent");
    expect(cards[3]?.text()).toContain("WatchAlert");
  });

  it("应用卡片点击 → window.open(url, _blank, noopener) SSO 共享 cookie", async () => {
    seedDefaultState();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const wrapper = mountWorkbench();
    await wrapper.find('[data-testid="app-card-cam"]').trigger("click");
    expect(openSpy).toHaveBeenCalledWith("/cam/", "_blank", "noopener");
    await wrapper.find('[data-testid="app-card-cmdb"]').trigger("click");
    expect(openSpy).toHaveBeenCalledWith("/cmdb/", "_blank", "noopener");
    await wrapper.find('[data-testid="app-card-opsagent"]').trigger("click");
    expect(openSpy).toHaveBeenCalledWith("/opsagent/", "_blank", "noopener");
    await wrapper.find('[data-testid="app-card-watchalert"]').trigger("click");
    expect(openSpy).toHaveBeenCalledWith("/watchalert/", "_blank", "noopener");
  });

  it("平台管理员（零租户豁免）：非受限态，角色=平台管理员，卡片可跳转", async () => {
    const userStore = useUserStore();
    const tenantStore = useTenantStore();
    userStore.isAdmin = true;
    userStore.tenants = [{ id: 1, name: "系统租户", code: "sys", domain: "" }];
    tenantStore.setCurrentTenantId(1);
    (userStore as unknown as { profile: unknown }).profile = {
      id: 2,
      username: "rootadmin",
      displayName: "平台管理员",
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const wrapper = mountWorkbench();
    expect(wrapper.find('[data-testid="profile-role"]').text()).toBe(
      "平台管理员",
    );
    expect(
      wrapper.find('[data-testid="workbench-restricted-notice"]').exists(),
    ).toBe(false);
    await wrapper.find('[data-testid="app-card-cam"]').trigger("click");
    expect(openSpy).toHaveBeenCalledWith("/cam/", "_blank", "noopener");
  });
});

describe("工作台统计概览 + 快捷操作 + 公告（权限过滤）", () => {
  it("只读审计：统计显示用户/角色/组织 3 卡（租户需 admin），快捷 5 项，公告 3 条", async () => {
    seedDefaultState();
    const wrapper = mountWorkbench();
    await flushPromises();
    // 统计：用户/角色/组织可见，租户不可见
    expect(wrapper.find('[data-testid="stat-card-users"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stat-card-roles"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stat-card-orgs"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stat-card-tenants"]').exists()).toBe(
      false,
    );
    // 统计值（mock 计数）
    expect(wrapper.find('[data-testid="stat-card-users"] .stat-count').text()).toBe("5");
    expect(wrapper.find('[data-testid="stat-card-roles"] .stat-count').text()).toBe("3");
    expect(wrapper.find('[data-testid="stat-card-orgs"] .stat-count').text()).toBe("2");
    // 快捷：用户/组织/角色/授权/身份源可见，策略/租户（adminOnly）不可见
    expect(wrapper.find('[data-testid="quick-users"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-orgs"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-roles"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-authz"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-idps"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-policies"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="quick-tenants"]').exists()).toBe(false);
    // 公告 3 条
    const notices = wrapper.findAll(".notice-item");
    expect(notices).toHaveLength(3);
  });

  it("平台管理员：统计 4 卡（含租户）+ 快捷 7 项", async () => {
    const userStore = useUserStore();
    const tenantStore = useTenantStore();
    userStore.isAdmin = true;
    userStore.tenants = [{ id: 1, name: "系统租户", code: "sys", domain: "" }];
    tenantStore.setCurrentTenantId(1);
    (
      userStore as unknown as {
        permissions: string[];
      }
    ).permissions = [...ADMIN_VIEW_CODES];
    (userStore as unknown as { profile: unknown }).profile = {
      id: 2,
      username: "rootadmin",
      displayName: "平台管理员",
    };
    const wrapper = mountWorkbench();
    await flushPromises();
    // 统计 4 卡（含租户）
    expect(wrapper.find('[data-testid="stat-card-tenants"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid^="stat-card-"]')).toHaveLength(4);
    // 快捷 7 项
    expect(wrapper.findAll('[data-testid^="quick-"]')).toHaveLength(7);
    expect(wrapper.find('[data-testid="quick-policies"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="quick-tenants"]').exists()).toBe(true);
  });

});

describe("工作台受限视图（零租户 E3）", () => {
  it("非 admin + 零租户：仅欢迎+我的信息，卡片禁用，tenant.none 提示，统计/快捷隐藏", async () => {
    const userStore = useUserStore();
    userStore.isAdmin = false;
    userStore.tenants = [];
    (userStore as unknown as { profile: unknown }).profile = {
      id: 3,
      username: "lonely",
      displayName: "无租户用户",
    };
    // currentTenantId 经 tenant store 默认 0（零租户）
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const wrapper = mountWorkbench();
    await flushPromises();
    // 静态内容仍渲染
    expect(wrapper.find('[data-testid="workbench"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("欢迎，无租户用户");
    expect(wrapper.find('[data-testid="profile-username"]').text()).toBe(
      "lonely",
    );
    // 所属租户字段显示 tenant.none 契约文案 + 受限标记
    const tenantField = wrapper.find('[data-testid="profile-tenant"]');
    expect(tenantField.text()).toBe("无所属租户");
    expect(tenantField.attributes("data-restricted")).toBe("true");
    // 角色派生为普通用户（零租户 → normal 档位）
    expect(wrapper.find('[data-testid="profile-role"]').text()).toBe(
      "普通用户",
    );
    // 统计/快捷（无权限码）不渲染
    expect(wrapper.find('[data-testid="workbench-stats"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="workbench-quick"]').exists()).toBe(
      false,
    );
    // 卡片禁用
    const card = wrapper.find('[data-testid="app-card-cam"]');
    expect(card.attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="workbench-apps"]').classes()).toContain(
      "is-disabled",
    );
    // tenant.notice 提示渲染（契约逐字文案）
    expect(
      wrapper.find('[data-testid="workbench-restricted-notice"]').text(),
    ).toBe("无所属租户");
    // 点击不触发跳转
    await card.trigger("click");
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("工作台 eiam 不可用（E12）", () => {
  it("error 置位：顶部降级提示渲染 + 静态内容仍渲染 + 卡片禁用", async () => {
    const userStore = useUserStore();
    const tenantStore = useTenantStore();
    userStore.isAdmin = false;
    userStore.tenants = [{ id: 10, name: "Acme", code: "acme", domain: "" }];
    tenantStore.setCurrentTenantId(10);
    (userStore as unknown as { profile: unknown }).profile = {
      id: 1,
      username: "alice",
      displayName: "爱丽丝",
    };
    // 模拟 eiam 不可用：profile 已加载但 error 置位（陈旧 profile 仍可渲染静态内容）
    (userStore as unknown as { error: string | null }).error =
      "身份服务暂不可用，请稍后重试";
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const wrapper = mountWorkbench();
    await flushPromises();
    // 顶部降级提示（eiam.unavailable 契约文案逐字）
    expect(wrapper.find('[data-testid="workbench-degradation"]').text()).toBe(
      "身份服务暂不可用，请稍后重试",
    );
    // 静态内容仍渲染（欢迎 + 我的信息四字段）
    expect(wrapper.text()).toContain("欢迎，爱丽丝");
    expect(wrapper.find('[data-testid="profile-username"]').text()).toBe(
      "alice",
    );
    // 卡片禁用，点击不跳转
    const card = wrapper.find('[data-testid="app-card-cam"]');
    expect(card.attributes("disabled")).toBeDefined();
    await card.trigger("click");
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("工作台卡片网格断点（结构断言）", () => {
  it("卡片网格容器存在 + 默认 2 列 CSS（断点行为由 E2E 承接）", () => {
    seedDefaultState();
    const wrapper = mountWorkbench();
    const grid = wrapper.find(".workbench-app-cards");
    expect(grid.exists()).toBe(true);
    // happy-dom 不解析 CSS 布局，仅断言结构 + 穷举项数；
    // 2 列/3 列 media query 断点行为由 Playwright E2E 承接（tech-design §Testing）。
    expect(grid.findAll(".workbench-app-card-wrap")).toHaveLength(4);
  });
});
