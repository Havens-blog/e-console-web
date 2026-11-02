// @vitest-environment happy-dom
/**
 * TenantSelector 共享组件单测（task 3.1）。
 *
 * 覆盖 AC：
 * - 读取 user store 所属租户列表，勾选目标 → 调 tenant/switch（X-Active-Tenant-ID 头由 tenant store 注入）
 *   → 整页 location.replace（由 tenant store 完成，组件只调 switchTenant）
 * - 三态：无租户 → 「无所属租户」禁用占位（契约 tenant.none）；单租户 → 静态文本；多租户 → el-select
 *
 * el-select/el-option 用 stub 替身（捕获 model-value/options + 派发 change），避免 ElementPlus
 * 内部 teleport/popper 在 happy-dom 的渲染复杂度（与 e-cam-web 测试同款手法）。
 */
import { createPinia as cp, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import TenantSelector from "./TenantSelector.vue";
import { useUserStore } from "@/stores/user";
import { useTenantStore } from "@/stores/tenant";
import { COPY_CONTRACT } from "@/utils/copyContract";
import { eiamAxios } from "@/api/request/eiam";

// ElSelect stub：捕获 model-value/loading/disabled props + 派发 change 事件
const ElSelectStub = defineComponent({
  name: "ElSelect",
  props: {
    modelValue: { type: [Number, String], default: null },
    placeholder: { type: String, default: "" },
    loading: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    size: { type: String, default: "small" },
  },
  emits: ["change", "update:modelValue"],
  setup(props, { slots }) {
    return () =>
      h("div", { class: "el-select-stub" }, [
        h("span", { class: "stub-model" }, String(props.modelValue)),
        h("span", { class: "stub-options" }, slots.default?.()),
      ]);
  },
});

// ElOption stub：渲染 label 便于断言选项集
const ElOptionStub = defineComponent({
  name: "ElOption",
  props: {
    label: { type: String, default: "" },
    value: { type: [Number, String], default: null },
  },
  setup(props) {
    return () =>
      h(
        "span",
        { class: "stub-option", "data-value": String(props.value) },
        props.label,
      );
  },
});

// ElMessage stub（避免全局挂载副作用）
vi.mock("element-plus", async (orig) => {
  const real = (await orig()) as typeof import("element-plus");
  return {
    ...real,
    ElMessage: Object.assign(vi.fn(), {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    }),
  };
});

const freshPinia = () => {
  const pinia = cp();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

function mountSelector(opts?: { width?: string }) {
  return mount(TenantSelector, {
    props: opts ?? {},
    global: {
      stubs: { ElSelect: ElSelectStub, ElOption: ElOptionStub },
    },
  });
}

beforeEach(() => {
  localStorage.clear();
  freshPinia();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TenantSelector 三态渲染", () => {
  it("无租户：禁用占位「无所属租户」（契约 tenant.none 逐字）", () => {
    const wrapper = mountSelector();
    expect(wrapper.find(".tenant-selector-none").exists()).toBe(true);
    expect(wrapper.find(".tenant-selector-none").text()).toBe(
      COPY_CONTRACT["tenant.none"],
    );
    expect(wrapper.findComponent(ElSelectStub).exists()).toBe(false);
  });

  it("单租户：静态文本当前租户名（无可切换）", () => {
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "Acme", code: "acme", domain: "acme.io" },
    ];
    useTenantStore().setCurrentTenantId(5);
    const wrapper = mountSelector();
    expect(wrapper.find(".tenant-selector-current").exists()).toBe(true);
    expect(wrapper.find(".tenant-selector-current").text()).toBe("Acme");
    expect(wrapper.findComponent(ElSelectStub).exists()).toBe(false);
  });

  it("多租户：el-select 渲染，model-value=currentTenantId，options=tenants 全集", async () => {
    const userStore = useUserStore();
    const tenants = [
      { id: 5, name: "Acme", code: "acme", domain: "a" },
      { id: 7, name: "Globex", code: "globex", domain: "g" },
    ];
    (userStore as unknown as { tenants: typeof tenants }).tenants = tenants;
    useTenantStore().setCurrentTenantId(7);

    const wrapper = mountSelector();
    await flushPromises();
    const select = wrapper.findComponent(ElSelectStub);
    expect(select.exists()).toBe(true);
    expect(select.props("modelValue")).toBe(7);
    const options = select.findAll(".stub-option");
    expect(options).toHaveLength(2);
    expect(options[0]!.text()).toBe("Acme");
    expect(options[1]!.text()).toBe("Globex");
    expect(options[1]!.attributes("data-value")).toBe("7");
  });

  it("switching=true 透传 el-select loading + disabled", async () => {
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "A", code: "", domain: "" },
      { id: 7, name: "B", code: "", domain: "" },
    ];
    useTenantStore().setCurrentTenantId(5);
    // 模拟切换中（store.switching 直接赋值——setup store ref 暴露）
    const tenantStore = useTenantStore();
    (tenantStore as unknown as { switching: boolean }).switching = true;

    const wrapper = mountSelector();
    await flushPromises();
    const select = wrapper.findComponent(ElSelectStub);
    expect(select.props("loading")).toBe(true);
    expect(select.props("disabled")).toBe(true);
  });
});

describe("TenantSelector 切换动作 → tenant store switchTenant", () => {
  it("el-select change(7) → switchTenant(7)（由 store 完成 X-Active-Tenant-ID + reload）", async () => {
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "A", code: "", domain: "" },
      { id: 7, name: "B", code: "", domain: "" },
    ];
    useTenantStore().setCurrentTenantId(5);

    const wrapper = mountSelector();
    await flushPromises();
    const select = wrapper.findComponent(ElSelectStub);
    // 派发 change（el-option 选中后 el-select emit 的契约事件）
    select.vm.$emit("change", 7);
    await flushPromises();

    // 验证 store.switching 被置 true（switchTenant 入口动作）；
    // 真实 switchTenant 的 POST + reload 在 tenant.test.ts 覆盖，此处只验组件→store 调用链
    expect(useTenantStore().switching).toBe(true);
  });

  it("change(0) 或与当前相同 id → 不触发 switchTenant", async () => {
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "A", code: "", domain: "" },
      { id: 7, name: "B", code: "", domain: "" },
    ];
    useTenantStore().setCurrentTenantId(5);

    const wrapper = mountSelector();
    await flushPromises();
    const select = wrapper.findComponent(ElSelectStub);
    // 与当前相同
    select.vm.$emit("change", 5);
    await flushPromises();
    expect(useTenantStore().switching).toBe(false);
    // 0（无）→ 不切换
    select.vm.$emit("change", 0);
    await flushPromises();
    expect(useTenantStore().switching).toBe(false);
  });

  it("change(字符串 id) → Number 归一后调 switchTenant", async () => {
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "A", code: "", domain: "" },
      { id: 7, name: "B", code: "", domain: "" },
    ];
    useTenantStore().setCurrentTenantId(5);

    const wrapper = mountSelector();
    await flushPromises();
    const select = wrapper.findComponent(ElSelectStub);
    select.vm.$emit("change", "7");
    await flushPromises();
    expect(useTenantStore().switching).toBe(true);
  });
});

describe("TenantSelector 切换失败 → ElMessage.error 契约文案", () => {
  it("tenant store error 变化 → ElMessage.error（未知 code 回退原文）", async () => {
    const { ElMessage } = await import("element-plus");
    const userStore = useUserStore();
    (userStore as unknown as { tenants: unknown[] }).tenants = [
      { id: 5, name: "A", code: "", domain: "" },
      { id: 7, name: "B", code: "", domain: "" },
    ];
    useTenantStore().setCurrentTenantId(5);

    const wrapper = mountSelector();
    await flushPromises();
    // store 置 error（模拟切换失败回填）
    const tenantStore = useTenantStore();
    (tenantStore as unknown as { error: string | null }).error = "切换租户失败";
    await flushPromises();
    expect(ElMessage.error).toHaveBeenCalledWith("切换租户失败");
    wrapper.unmount();
  });
});

// 本文件会走**真实** tenant store 的 switchTenant（组件→store 调用链断言），它会用 eiamAxios
// 发 POST /api/iam/tenant/switch；happy-dom 的默认 base 是 http://localhost:3000，
// 于是每次运行都在做一次**真实网络尝试**并在输出里留下 ECONNREFUSED 噪声（用例本身通过，属误导性噪音）。
// 这里用内存 adapter 短路网络：只验证调用链，不依赖真实后端。
beforeEach(() => {
  eiamAxios.defaults.adapter = async (config) => ({
    data: { code: 0, msg: "ok", data: null },
    status: 200,
    statusText: "OK",
    headers: {},
    config,
  });
});

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});