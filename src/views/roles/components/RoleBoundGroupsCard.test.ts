// @vitest-environment happy-dom
/**
 * RoleBoundGroupsCard 组件行为测试（feat-role-bound-groups 契约 §2.3 / §3）。
 *
 * 全部 api mock，**不触真实网络、不读写任何真实数据**（区块纯只读）。
 *
 * 锁定：
 * - 渲染：区块 `role-bound-groups` + 条目 `role-bound-group-item`，各展示 组名 / 标识码（等宽）/ 描述；
 * - 空态：`role-bound-groups-empty`「该角色未被任何用户组关联」，且不渲染条目；
 * - 错误 + 重试：`role-bound-groups-error` 展示服务端 msg 原文，点「重试」重新拉取并恢复条目；
 * - 缺码不渲染不请求：无 `iam:group:view_role_groups` → 整块不渲染且 api 零调用；
 * - roleCode 为空 → 同样不渲染、不发请求（防御）；
 * - 严格只读：成功/空态下零输入控件、零按钮；错误态唯一按钮是「重试」且 `type=button`。
 */
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createApp } from "vue";
import RoleBoundGroupsCard from "./RoleBoundGroupsCard.vue";
import { useUserStore } from "@/stores/user";
import { IAM_GROUP, IAM_ROLE } from "@/config/permission-codes";
import { ApiError, type TenantGroup } from "@/api/types";
import { listGroupsForRole } from "@/api/groups";

vi.mock("@/api/groups", () => ({ listGroupsForRole: vi.fn() }));

const groupsMock = vi.mocked(listGroupsForRole);

const GROUP_A: TenantGroup = {
  id: 5,
  name: "运维组",
  code: "ops-group",
  desc: "负责日常运维",
};

const GROUP_B: TenantGroup = {
  id: 6,
  name: "审计组",
  code: "audit-group",
  desc: "",
};

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

type Wrapper = ReturnType<typeof mount>;

async function mountCard(
  permissions: readonly string[] = [IAM_GROUP.VIEW_ROLE_GROUPS],
  roleCode = "ops",
): Promise<Wrapper> {
  freshPinia();
  const userStore = useUserStore();
  userStore.isAdmin = true;
  (userStore as unknown as { permissions: string[] }).permissions = [
    ...permissions,
  ];
  const wrapper = mount(RoleBoundGroupsCard, { props: { roleCode } });
  await flushPromises();
  return wrapper;
}

function byTestId(wrapper: Wrapper, id: string): ReturnType<Wrapper["find"]> {
  return wrapper.find(`[data-testid="${id}"]`);
}

beforeEach(() => {
  vi.clearAllMocks();
  groupsMock.mockResolvedValue({ total: 2, items: [GROUP_A, GROUP_B] });
});

describe("RoleBoundGroupsCard：渲染", () => {
  it("按角色 code 拉取一次（前 100 条）并渲染区块与条目", async () => {
    const wrapper = await mountCard();

    expect(groupsMock).toHaveBeenCalledTimes(1);
    expect(groupsMock).toHaveBeenCalledWith("ops", {
      offset: 0,
      limit: 100,
      keyword: "",
    });

    expect(byTestId(wrapper, "role-bound-groups").exists()).toBe(true);
    const items = wrapper.findAll('[data-testid="role-bound-group-item"]');
    expect(items).toHaveLength(2);

    // 条目：组名 / 标识码（等宽）/ 描述
    expect(items[0]!.text()).toContain("运维组");
    expect(items[0]!.text()).toContain("ops-group");
    expect(items[0]!.text()).toContain("负责日常运维");
    expect(items[0]!.find(".mono").exists()).toBe(true);
    expect(items[0]!.find(".mono").text()).toBe("ops-group");

    // 描述为空 → '—'（不渲染空串占位）
    expect(items[1]!.text()).toContain("审计组");
    expect(items[1]!.text()).toContain("—");

    // 有数据时不出现空态 / 错误态
    expect(byTestId(wrapper, "role-bound-groups-empty").exists()).toBe(false);
    expect(byTestId(wrapper, "role-bound-groups-error").exists()).toBe(false);
  });

  it("roleCode 变化 → 清空旧条目并按新 code 重拉", async () => {
    const wrapper = await mountCard();
    expect(wrapper.findAll('[data-testid="role-bound-group-item"]')).toHaveLength(2);

    groupsMock.mockResolvedValue({ total: 1, items: [GROUP_B] });
    await wrapper.setProps({ roleCode: "admin" });
    await flushPromises();

    expect(groupsMock).toHaveBeenCalledTimes(2);
    expect(groupsMock).toHaveBeenLastCalledWith("admin", {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    const items = wrapper.findAll('[data-testid="role-bound-group-item"]');
    expect(items).toHaveLength(1);
    expect(items[0]!.text()).toContain("审计组");
  });
});

describe("RoleBoundGroupsCard：空态", () => {
  it("零条目 → 空态文案「该角色未被任何用户组关联」，不渲染条目 / 错误", async () => {
    groupsMock.mockResolvedValue({ total: 0, items: [] });

    const wrapper = await mountCard();

    const empty = byTestId(wrapper, "role-bound-groups-empty");
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toBe("该角色未被任何用户组关联");
    expect(wrapper.findAll('[data-testid="role-bound-group-item"]')).toHaveLength(0);
    expect(byTestId(wrapper, "role-bound-groups-error").exists()).toBe(false);
  });
});

describe("RoleBoundGroupsCard：错误与重试", () => {
  it("加载失败 → 错误态展示 msg 原文 + 重试，不渲染条目 / 空态", async () => {
    groupsMock.mockRejectedValue(new ApiError("forbidden", "无权查看角色关联分组"));

    const wrapper = await mountCard();

    const error = byTestId(wrapper, "role-bound-groups-error");
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("无权查看角色关联分组");
    expect(wrapper.findAll('[data-testid="role-bound-group-item"]')).toHaveLength(0);
    expect(byTestId(wrapper, "role-bound-groups-empty").exists()).toBe(false);
  });

  it("点重试重新拉取，成功后错误消失并渲染条目", async () => {
    groupsMock.mockRejectedValueOnce(new ApiError("unavailable", "网络异常"));

    const wrapper = await mountCard();
    expect(byTestId(wrapper, "role-bound-groups-error").exists()).toBe(true);
    expect(groupsMock).toHaveBeenCalledTimes(1);

    groupsMock.mockResolvedValue({ total: 1, items: [GROUP_A] });
    await byTestId(wrapper, "role-bound-groups-error")
      .find("button")
      .trigger("click");
    await flushPromises();

    expect(groupsMock).toHaveBeenCalledTimes(2);
    expect(byTestId(wrapper, "role-bound-groups-error").exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="role-bound-group-item"]')).toHaveLength(1);
  });
});

describe("RoleBoundGroupsCard：权限门", () => {
  it("缺 iam:group:view_role_groups → 整块不渲染且不发请求", async () => {
    const wrapper = await mountCard([IAM_ROLE.VIEW, IAM_GROUP.VIEW_USER_GROUPS]);

    expect(byTestId(wrapper, "role-bound-groups").exists()).toBe(false);
    expect(groupsMock).not.toHaveBeenCalled();
  });

  it("权限码为空数组 → 同样不渲染、零请求（空态文案也不出现）", async () => {
    const wrapper = await mountCard([]);

    expect(byTestId(wrapper, "role-bound-groups").exists()).toBe(false);
    expect(byTestId(wrapper, "role-bound-groups-empty").exists()).toBe(false);
    expect(groupsMock).not.toHaveBeenCalled();
  });

  it("roleCode 为空 → 不渲染且不发请求", async () => {
    const wrapper = await mountCard([IAM_GROUP.VIEW_ROLE_GROUPS], "");

    expect(byTestId(wrapper, "role-bound-groups").exists()).toBe(false);
    expect(groupsMock).not.toHaveBeenCalled();
  });
});

describe("RoleBoundGroupsCard：严格只读", () => {
  it("成功态无输入控件 / 表单 / 任何按钮（零增删改入口）", async () => {
    const wrapper = await mountCard();
    const card = byTestId(wrapper, "role-bound-groups");

    expect(card.findAll("input")).toHaveLength(0);
    expect(card.findAll("textarea")).toHaveLength(0);
    expect(card.findAll("select")).toHaveLength(0);
    expect(card.findAll("form")).toHaveLength(0);
    expect(card.findAll("button")).toHaveLength(0);
    // 文案层面不出现写操作动词（只读提示里的「操作」不算入口）
    for (const word of ["添加", "新建", "编辑", "删除", "移除", "绑定", "解绑"]) {
      expect(card.text()).not.toContain(word);
    }
  });

  it("空态同样零按钮（只读区块）", async () => {
    groupsMock.mockResolvedValue({ total: 0, items: [] });
    const wrapper = await mountCard();
    expect(byTestId(wrapper, "role-bound-groups").findAll("button")).toHaveLength(
      0,
    );
  });

  it("错误态唯一按钮是「重试」，且 type=button（不触发表单提交）", async () => {
    groupsMock.mockRejectedValue(new ApiError("forbidden", "无权限"));
    const wrapper = await mountCard();

    const buttons = byTestId(wrapper, "role-bound-groups").findAll("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.text()).toBe("重试");
    expect(buttons[0]!.attributes("type")).toBe("button");
  });
});
