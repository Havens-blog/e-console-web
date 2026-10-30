// @vitest-environment happy-dom
// UserIdentities 组件：外部身份治理入口的门控与载荷（feat-user-identity-manage）
//
// 手法：mock @/api/users 三函数；真实 pinia user store 注入 permissions。
import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import UserIdentities from "./UserIdentities.vue";
import { useUserStore } from "@/stores/user";
import { IAM_USER } from "@/config/permission-codes";

const listMock = vi.fn<(userId: number) => Promise<unknown[]>>();
const unbindMock = vi.fn<(u: number, p: string, i: string) => Promise<void>>();
const manageMock = vi.fn<(u: number, p: unknown) => Promise<void>>();

vi.mock("@/api/users", () => ({
  listUserIdentities: (userId: number) => listMock(userId),
  unbindUserIdentity: (u: number, p: string, i: string) => unbindMock(u, p, i),
  manageUserIdentity: (u: number, p: unknown) => manageMock(u, p),
}));

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

async function mountWith(codes: readonly string[]) {
  freshPinia();
  const userStore = useUserStore();
  (userStore as unknown as { permissions: string[] }).permissions = [...codes];
  const wrapper = mount(UserIdentities, { props: { userId: 65 } });
  await flushPromises();
  return wrapper;
}

describe("UserIdentities：治理外部身份（IAM_USER.MANAGE_IDENTITY）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([]);
    manageMock.mockResolvedValue(undefined);
    unbindMock.mockResolvedValue(undefined);
  });

  it("缺 MANAGE_IDENTITY 码 → 不渲染治理入口（且不发治理请求）", async () => {
    const wrapper = await mountWith([IAM_USER.GET]);
    expect(wrapper.find('[data-testid="identity-manage-open"]').exists()).toBe(false);
    expect(manageMock).not.toHaveBeenCalled();
  });

  it("有码 → 渲染入口；点开弹窗；空表单提交禁用", async () => {
    const wrapper = await mountWith([IAM_USER.GET, IAM_USER.MANAGE_IDENTITY]);
    const open = wrapper.find('[data-testid="identity-manage-open"]');
    expect(open.exists()).toBe(true);
    await open.trigger("click");
    expect(wrapper.find('[data-testid="identity-manage-dialog"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-testid="identity-manage-submit"]').attributes("disabled"),
    ).toBeDefined();
  });

  it("填 LDAP DN → 提交 → manageUserIdentity(userId, {ldapDN}) 且重载列表", async () => {
    const wrapper = await mountWith([IAM_USER.GET, IAM_USER.MANAGE_IDENTITY]);
    const callsBefore = listMock.mock.calls.length;
    await wrapper.find('[data-testid="identity-manage-open"]').trigger("click");
    await wrapper.find('[data-testid="identity-manage-ldap-dn"]').setValue(
      "uid=e2e,dc=example,dc=com",
    );
    await wrapper.find('[data-testid="identity-manage-submit"]').trigger("click");
    await flushPromises();

    expect(manageMock).toHaveBeenCalledWith(65, {
      ldapDN: "uid=e2e,dc=example,dc=com",
      wechatUserID: undefined,
      feishuUserID: undefined,
    });
    expect(listMock.mock.calls.length).toBe(callsBefore + 1);
    expect(wrapper.find('[data-testid="identity-manage-dialog"]').exists()).toBe(false);
  });

  it("被拒 → 展示服务端文案原文，弹窗保持打开、不重载", async () => {
    manageMock.mockRejectedValue(new Error("无权访问目标租户空间"));
    const wrapper = await mountWith([IAM_USER.GET, IAM_USER.MANAGE_IDENTITY]);
    await wrapper.find('[data-testid="identity-manage-open"]').trigger("click");
    await wrapper.find('[data-testid="identity-manage-ldap-dn"]').setValue("uid=x,dc=y");
    const callsBefore = listMock.mock.calls.length;
    await wrapper.find('[data-testid="identity-manage-submit"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="identity-manage-dialog"]').exists()).toBe(true);
    expect(
      wrapper.find('[data-testid="identity-manage-error"]').text(),
    ).toContain("无权访问目标租户空间");
    expect(listMock.mock.calls.length).toBe(callsBefore);
  });
});