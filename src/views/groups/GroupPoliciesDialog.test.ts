// @vitest-environment happy-dom
/**
 * GroupPoliciesDialog 组件行为测试（feat-group-policies 契约 §2.2 / §3）。
 *
 * 锁定用户可观察行为（api 层 mock，**不触真实网络、不创建 / 修改任何真实数据**）：
 * - 打开即按 group.code 拉取（offset 0 / limit 100 / keyword ""，manifest：本弹窗不分页）；
 * - group=null → 不渲染且零请求；
 * - 条目渲染 策略名 / 标识码（等宽）/ 描述（缺失 → `—`）；
 * - 空态「该用户组未直接绑定策略」；错误态服务端 msg 原文 + 重试可恢复；
 * - **严格只读**：无 input / textarea / select / submit，且无任何绑定 / 解绑 / 提交类按钮
 *   （契约 §2.2 硬约束：本弹窗不得出现写入口）；
 * - 关闭 emit('close')；关闭后迟到响应不写回 state；
 * - 换 code 重拉（同一 code 的新 props 对象不重复拉取）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import GroupPoliciesDialog from "./GroupPoliciesDialog.vue";
import { listPoliciesForGroup, type PolicyWithMeta } from "@/api/policies";
import { ApiError, type Page } from "@/api/types";

vi.mock("@/api/policies", () => ({
  listPoliciesForGroup: vi.fn(),
  listPoliciesPage: vi.fn(),
  attachPoliciesToGroup: vi.fn(),
  detachPolicyFromGroup: vi.fn(),
}));

// 权限门控可测：直接 mock useCan，避免为一个组件测试搭建整棵 Pinia store。
// 默认授予查看 / 绑定 / 解绑三码；个别用例可改 owned 集合验证裁剪。
const ownedPerms = new Set<string>([
  "iam:policy:view_group_policies",
  "iam:policy:batch_attach",
  "iam:policy:detach",
]);
vi.mock("@/composables/useCan", () => ({
  useCan: () => ({
    can: (code: string) => ownedPerms.has(code),
    canEvery: (codes: readonly string[]) => codes.every((c) => ownedPerms.has(c)),
    canSome: (codes: readonly string[]) => codes.some((c) => ownedPerms.has(c)),
  }),
}));

const listMock = vi.mocked(listPoliciesForGroup);

const GROUP = { code: "rd", name: "研发组" };

function makePolicy(overrides: Partial<PolicyWithMeta> = {}): PolicyWithMeta {
  return {
    id: 2,
    code: "p1",
    name: "只读策略",
    desc: "允许只读访问",
    statements: [],
    assignmentCount: 0,
    ...overrides,
  };
}

function pageOf(items: PolicyWithMeta[], total = items.length): Page<PolicyWithMeta> {
  return { total, items };
}

/** 挂起当前请求，返回 resolve 句柄（用于验证加载态 / 迟到响应） */
function pendingFetch(): (page: Page<PolicyWithMeta>) => void {
  let release: ((page: Page<PolicyWithMeta>) => void) | undefined;
  listMock.mockImplementation(
    () =>
      new Promise<Page<PolicyWithMeta>>((resolve) => {
        release = resolve;
      }),
  );
  return (page: Page<PolicyWithMeta>) => release?.(page);
}

type Wrapper = ReturnType<typeof mount>;

async function mountDialog(
  group: { code: string; name: string } | null = GROUP,
): Promise<Wrapper> {
  const wrapper = mount(GroupPoliciesDialog, { props: { group } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue(pageOf([makePolicy()]));
});

describe("GroupPoliciesDialog：打开 / 条目渲染", () => {
  it("打开即按 group.code 拉取，渲染标题与 策略名 / 标识码 / 描述", async () => {
    listMock.mockResolvedValue(
      pageOf([
        makePolicy(),
        makePolicy({ id: 3, code: "p2", name: "写入策略", desc: "" }),
      ]),
    );
    const wrapper = await mountDialog();

    // 契约 §2.1：offset 0 / limit 100 / keyword ""（不分页，取前 100 条）
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith("rd", {
      offset: 0,
      limit: 100,
      keyword: "",
    });

    expect(wrapper.find('[data-testid="group-policies-dialog"]').exists()).toBe(
      true,
    );
    expect(wrapper.text()).toContain("研发组 · 策略");
    expect(wrapper.find('[data-testid="group-policies-close"]').exists()).toBe(
      true,
    );

    const rows = wrapper.findAll('[data-testid="group-policy-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("只读策略");
    expect(rows[0]!.text()).toContain("p1");
    expect(rows[0]!.text()).toContain("允许只读访问");
    // 标识码等宽（契约 §2.2）
    expect(rows[0]!.find(".mono").text()).toBe("p1");
    // 描述缺失 → '—'
    expect(rows[1]!.text()).toContain("—");
    // 无错误 / 空态
    expect(wrapper.find('[data-testid="group-policies-error"]').exists()).toBe(
      false,
    );
    expect(wrapper.find('[data-testid="group-policies-empty"]').exists()).toBe(
      false,
    );
  });

  it("group=null → 不渲染且零请求", async () => {
    const wrapper = await mountDialog(null);

    expect(wrapper.find('[data-testid="group-policies-dialog"]').exists()).toBe(
      false,
    );
    expect(listMock).not.toHaveBeenCalled();
  });

  it("加载中展示骨架（未返回前不渲染行，也不误报空态）", async () => {
    const release = pendingFetch();
    const wrapper = await mountDialog();

    expect(wrapper.find(".skeleton").exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="group-policies-empty"]').exists()).toBe(
      false,
    );

    release(pageOf([makePolicy()]));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(1);
  });

  it("空态：未直接绑定策略 → 「该用户组未直接绑定策略」", async () => {
    listMock.mockResolvedValue(pageOf([]));
    const wrapper = await mountDialog();

    const empty = wrapper.find('[data-testid="group-policies-empty"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain("该用户组未直接绑定策略");
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="group-policies-error"]').exists()).toBe(
      false,
    );
  });

  it("加载失败 → 展示服务端 msg 原文 + 重试可恢复", async () => {
    listMock.mockRejectedValueOnce(
      new ApiError("unavailable", "身份服务暂不可用，请稍后重试"),
    );
    const wrapper = await mountDialog();

    const error = wrapper.find('[data-testid="group-policies-error"]');
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("身份服务暂不可用，请稍后重试");
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(0);

    await wrapper
      .find('[data-testid="group-policies-retry"]')
      .trigger("click");
    await flushPromises();

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(listMock).toHaveBeenLastCalledWith("rd", {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="group-policies-error"]').exists()).toBe(
      false,
    );
  });
});

// 2026-10-29 起本弹窗可写（详见组件头注释：策略域缺「策略→主体」反查端点，
// 旧契约"请到策略页操作"实际是死路）。原「严格只读」断言按新语义改写为
// 「主视图无输入控件 + 写入口受权限门控」，防护价值不降反升。
describe("GroupPoliciesDialog：主视图无输入控件 + 写入口权限门控", () => {
  it("无任何输入控件与提交入口（input / textarea / select / submit 全为 0）", async () => {
    const wrapper = await mountDialog();

    expect(wrapper.findAll("input")).toHaveLength(0);
    expect(wrapper.findAll("textarea")).toHaveLength(0);
    expect(wrapper.findAll("select")).toHaveLength(0);
    expect(wrapper.findAll('button[type="submit"]')).toHaveLength(0);
    expect(wrapper.findAll("form")).toHaveLength(0);
  });

    it("无写权限时：只有关闭按钮，不渲染绑定 / 解绑入口", async () => {
      // 只留查看权限，去掉 batch_attach 与 detach
      const backup = new Set(ownedPerms);
      ownedPerms.clear();
      ownedPerms.add("iam:policy:view_group_policies");
      try {
        const wrapper = await mountDialog();
        expect(
          wrapper.find('[data-testid="group-policy-attach-open"]').exists(),
        ).toBe(false);
        expect(
          wrapper.find('[data-testid="group-policy-detach"]').exists(),
        ).toBe(false);
        // 有数据时唯一按钮就是关闭
        expect(wrapper.findAll("button")).toHaveLength(1);
        expect(wrapper.find('[data-testid="group-policies-close"]').exists()).toBe(true);
      } finally {
        ownedPerms.clear();
        backup.forEach((perm) => ownedPerms.add(perm));
      }
    });

    it("有写权限时：渲染绑定入口与每行解绑按钮", async () => {
      const wrapper = await mountDialog();
      expect(
        wrapper.find('[data-testid="group-policy-attach-open"]').exists(),
      ).toBe(true);
      expect(wrapper.findAll('[data-testid="group-policy-detach"]')).toHaveLength(1);
    });

    it("错误态：只多出「重试」，且主视图仍无输入控件", async () => {
      listMock.mockRejectedValueOnce(new ApiError("unknown", "加载失败"));
      const errorWrapper = await mountDialog();
      const labels = errorWrapper.findAll("button").map((b) => b.text());
      expect(labels).toContain("重试");
      expect(labels).toContain("✕");
      // 主视图（绑定弹层未打开）不得有 input / textarea / select
      expect(errorWrapper.findAll("input, textarea, select")).toHaveLength(0);
    });
  });

  // 关闭 / 换组行为（原有覆盖，保持不变）
  describe("GroupPoliciesDialog：关闭 / 换组", () => {
    it("点关闭 → emit close；父级置 null 后不再发起请求", async () => {
      const wrapper = await mountDialog();
      await wrapper.find('[data-testid="group-policies-close"]').trigger("click");
      expect(wrapper.emitted("close")).toHaveLength(1);

      const callsBefore = listMock.mock.calls.length;
      await wrapper.setProps({ group: null });
      await flushPromises();
      expect(listMock.mock.calls.length).toBe(callsBefore);
    });

    it("同一 code 的新 props 对象不重拉；换 code → 按新 code 重拉并换标题", async () => {
      const wrapper = await mountDialog();
      expect(listMock).toHaveBeenCalledTimes(1);

      // 同一 code、新对象引用 → 不重复请求
      await wrapper.setProps({ group: { code: "rd", name: "研发组" } });
      await flushPromises();
      expect(listMock).toHaveBeenCalledTimes(1);

      await wrapper.setProps({ group: { code: "ops", name: "运维组" } });
      await flushPromises();
      expect(listMock).toHaveBeenCalledTimes(2);
      expect(wrapper.text()).toContain("运维组 · 策略");
    });

  it("换 code 后旧响应不覆盖新组数据（请求序号）", async () => {
    const resolvers: Array<(p: Page<PolicyWithMeta>) => void> = [];
    listMock.mockImplementation(
      () =>
        new Promise<Page<PolicyWithMeta>>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const wrapper = await mountDialog();
    await wrapper.setProps({ group: { code: "ops", name: "运维组" } });
    await flushPromises();

    // 先回旧组（rd）的响应，再回新组（ops）
    resolvers[0]?.(pageOf([makePolicy({ code: "old", name: "旧组策略" })]));
    await flushPromises();
    expect(wrapper.findAll('[data-testid="group-policy-row"]')).toHaveLength(0);

    resolvers[1]?.(pageOf([makePolicy({ code: "new", name: "新组策略" })]));
    await flushPromises();
    const rows = wrapper.findAll('[data-testid="group-policy-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain("新组策略");
    expect(rows[0]!.text()).not.toContain("旧组策略");
  });
  });
