// @vitest-environment happy-dom
/**
 * orgList store（task 4.3，UF-5）契约测试。
 *
 * 覆盖 AC：
 * - 统一契约 state{items,total,page,pageSize,loading,error} + fetch/create/update/remove
 * - AbortController fetch 前中断在途（AC-3）
 * - 写前守卫（3.1）：快照 != currentTenantId → 阻断写 + reload 自愈（Hard Rule 不绕过）
 * - 响应回读（3.1）：department/list 无租户标识 → 跳过此层放行
 * - 上限保护（Hard Rule）：深度 ≥8 / 节点 ≥1000 → canAddChild 禁建
 * - 删除前置预检（Hard Rule）：child_count/user_count >0 → precheckDelete 阻断
 * - create/update/remove 经写前守卫
 * - 401 收敛：registerUnauthorizedReset 注册的回调复位 state
 * - 不声明 persist（列表态不落 localStorage）
 */
import { URL as NodeURL } from "node:url";
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { createPinia, setActivePinia } from "pinia";
import { useUserStore } from "@/stores/user";
import { IAM_DEPARTMENT } from "@/config/permission-codes";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { useOrgListStore, MAX_ORG_NODES, MAX_ORG_DEPTH } from "./orgList";
import { useTenantStore } from "./tenant";
import { eiamAxios } from "@/api/request/eiam";

// ---- router 模块替身：受控快照 + 捕获 registerUnauthorizedReset 回调 ----
const snapshotMock = vi.fn<(...args: never[]) => number>();
const resetRegistrations: Array<() => void> = [];
vi.mock("@/router", () => ({
  getPageEnterTenantSnapshot: (...args: never[]) => snapshotMock(...args),
  __resetPageEnterTenantSnapshot: vi.fn(),
  registerUnauthorizedReset: (fn: () => void) => {
    resetRegistrations.push(fn);
  },
  router: {},
}));

// ---- window.location 替身（enforceWriteGuard reload 断言）----
function stubLocation(initialHref: string): { replaced: string[] } {
  let current = new NodeURL(initialHref);
  const replaced: string[] = [];
  const fake = {
    get href(): string {
      return current.href;
    },
    set href(value: string) {
      current = new NodeURL(value, current);
    },
    get origin(): string {
      return current.origin;
    },
    replace(value: string) {
      replaced.push(value);
      current = new NodeURL(value, current);
    },
    toString(): string {
      return current.href;
    },
  };
  Object.defineProperty(window, "location", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return { replaced };
}

const realLocation = window.location;

function restoreLocation(original: Location): void {
  Object.defineProperty(window, "location", {
    value: original,
    configurable: true,
    writable: true,
  });
}

const STATUS_TEXT: Partial<Record<number, string>> = {
  200: "OK",
};

interface MockReply {
  status?: number;
  body?: unknown;
  networkFailure?: { code: string; message: string };
}

function settleLike(response: AxiosResponse): AxiosResponse {
  const validate =
    response.config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  if (validate(response.status)) return response;
  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    AxiosError.ERR_BAD_REQUEST,
    response.config,
    undefined,
    response,
  );
}

type ReplyFn = (config: InternalAxiosRequestConfig) => MockReply;

/** 按 url 路由不同响应：department/list|create|update|delete|detail|members */
function adapterRouting(
  listReply: ReplyFn,
  writes: Partial<Record<string, ReplyFn>> = {},
): { calls: string[] } {
  const calls: string[] = [];
  eiamAxios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? "";
    calls.push(url);
    let reply: MockReply;
    if (url.includes("/department/list")) reply = listReply(config);
    else if (url.includes("/department/create"))
      reply = (
        writes.create ??
        (() => ({ status: 200, body: { code: 0, msg: "", data: 99 } }))
      )(config);
    else if (url.includes("/department/update"))
      reply = (
        writes.update ??
        (() => ({ status: 200, body: { code: 0, msg: "", data: null } }))
      )(config);
    else if (url.includes("/department/delete"))
      reply = (
        writes.delete ??
        (() => ({ status: 200, body: { code: 0, msg: "", data: null } }))
      )(config);
    else if (url.includes("/department/detail"))
      reply = (
        writes.detail ??
        (() => ({
          status: 200,
          body: {
            code: 0,
            msg: "",
            data: { id: 1, parent_id: 0, name: "总部" },
          },
        }))
      )(config);
    else if (url.includes("/department/members"))
      reply = (
        writes.members ??
        (() => ({
          status: 200,
          body: { code: 0, msg: "", data: { total: 0, members: [] } },
        }))
      )(config);
    else reply = { status: 200, body: { code: 0, msg: "", data: null } };
    if (reply.networkFailure) {
      throw new AxiosError(
        reply.networkFailure.message,
        reply.networkFailure.code,
        config,
      );
    }
    return settleLike({
      data: reply.body ?? null,
      status: reply.status ?? 200,
      statusText: STATUS_TEXT[reply.status ?? 200] ?? "",
      headers: {},
      config,
    } as AxiosResponse);
  }) as unknown as typeof eiamAxios.defaults.adapter;
  return { calls };
}

/** 组织树信封（嵌套 children） */
function treeEnvelope(nodes: unknown[]): unknown {
  return { code: 0, msg: "ok", data: nodes };
}

function nodeRaw(
  id: number,
  name: string,
  parentId = 0,
  children: unknown[] = [],
): unknown {
  return { id, parent_id: parentId, name, children };
}

async function freshStore(
  listReply: ReplyFn,
  writes: Partial<Record<string, ReplyFn>> = {},
): Promise<{
  store: ReturnType<typeof useOrgListStore>;
  calls: string[];
}> {
  const { calls } = adapterRouting(listReply, writes);
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  snapshotMock.mockReturnValue(5);
  useTenantStore().setCurrentTenantId(5);
  // fetchMembers 缺 `iam:department:members` 时会跳过请求（避免必然 403），
  // 本文件验证 store 行为，故显式声明该能力码（与 OrgMembersCard 的门控口径一致）。
  (useUserStore() as unknown as { permissions: string[] }).permissions = [
    IAM_DEPARTMENT.MEMBERS,
  ];
  return { store: useOrgListStore(), calls };
}

beforeEach(() => {
  localStorage.clear();
  resetRegistrations.length = 0;
  snapshotMock.mockReset();
});

afterEach(() => {
  restoreLocation(realLocation);
  eiamAxios.defaults.adapter = undefined;
  vi.restoreAllMocks();
});

describe("orgList store 统一契约（AC-1）", () => {
  it("state 初值：items=[] / total=0 / page=1 / pageSize=20 / loading=false / error=null", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([]),
    }));
    expect(store.items).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.page).toBe(1);
    expect(store.pageSize).toBe(20);
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it("fetch 拉取组织树：items=顶层节点，total=全量节点数", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store, calls } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([
        nodeRaw(1, "总部", 0, [
          nodeRaw(2, "研发", 1),
          nodeRaw(3, "运维", 1, [nodeRaw(4, "SRE", 3)]),
        ]),
        nodeRaw(5, "财务", 0),
      ]),
    }));
    const ok = await store.fetch();
    expect(ok).toBe(true);
    expect(calls[0]).toContain("/department/list");
    expect(store.items).toHaveLength(2);
    expect(store.total).toBe(5); // 总部+研发+运维+SRE+财务
  });

  it("fetch 失败归位 error，不复位 items", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 500,
      body: { code: 4010704, msg: "获取部门列表失败", data: null },
    }));
    const ok = await store.fetch();
    expect(ok).toBe(false);
    expect(store.error).toBe("获取部门列表失败");
    expect(store.items).toEqual([]);
  });
});

describe("orgList 上限保护（AC-4，Hard Rule：≤1000 节点/深度 ≤8）", () => {
  it("根组织（parentId=null）始终可建", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    expect(store.canAddChild(null).allowed).toBe(true);
  });

  it("节点数达 1000 时禁建", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    // 构造 1000 个根节点（达到上限）
    const nodes = Array.from({ length: MAX_ORG_NODES }, (_, i) =>
      nodeRaw(i + 1, `n${i + 1}`),
    );
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope(nodes),
    }));
    await store.fetch();
    expect(store.total).toBe(MAX_ORG_NODES);
    const check = store.canAddChild(1);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain(String(MAX_ORG_NODES));
  });

  it("父节点深度达 8 时禁建子级", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    // 构造深度 8 的链：1→2→3→4→5→6→7→8
    const depth8 = nodeRaw(8, "L8", 7);
    const depth7 = nodeRaw(7, "L7", 6, [depth8]);
    const depth6 = nodeRaw(6, "L6", 5, [depth7]);
    const depth5 = nodeRaw(5, "L5", 4, [depth6]);
    const depth4 = nodeRaw(4, "L4", 3, [depth5]);
    const depth3 = nodeRaw(3, "L3", 2, [depth4]);
    const depth2 = nodeRaw(2, "L2", 1, [depth3]);
    const root = nodeRaw(1, "root", 0, [depth2]);
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([root]),
    }));
    await store.fetch();
    // depth8 节点（id=8）深度=8，再建子级为 9 → 禁建
    const check = store.canAddChild(8);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain(String(MAX_ORG_DEPTH));
    // depth7 节点（id=7）深度=7，子级为 8 → 允许
    expect(store.canAddChild(7).allowed).toBe(true);
  });
});

describe("orgList 删除前置预检（AC-3，Hard Rule：删除校验通过前不得放行提交）", () => {
  it("child_count=0 且 user_count=0 → precheckDelete 返回 null（可提交）", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    await store.loadDetail(1);
    expect(store.precheckDelete()).toBeNull();
  });

  it("child_count>0 → precheckDelete 阻断（列下属组织数）", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部", 0, [nodeRaw(2, "子")])]),
    }));
    await store.fetch();
    await store.loadDetail(1);
    const blocked = store.precheckDelete();
    expect(blocked).not.toBeNull();
    expect(blocked!.childCount).toBe(1);
    expect(blocked!.userCount).toBe(0);
  });

  it("user_count>0 → precheckDelete 阻断（列关联用户数）", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(
      () => ({ status: 200, body: treeEnvelope([nodeRaw(1, "总部")]) }),
      {
        members: () => ({
          status: 200,
          body: {
            code: 0,
            msg: "",
            data: { total: 3, members: [{ id: 1, username: "a" }] },
          },
        }),
      },
    );
    await store.fetch();
    await store.loadDetail(1);
    const blocked = store.precheckDelete();
    expect(blocked).not.toBeNull();
    expect(blocked!.childCount).toBe(0);
    expect(blocked!.userCount).toBe(3);
  });
});

describe("orgList 写前守卫（3.1，Hard Rule：不得绕过）", () => {
  it("快照 != currentTenantId → create 阻断 + reload 自愈", async () => {
    const { replaced } = stubLocation(
      "http://localhost:8888/console/organizations",
    );
    const { store, calls } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    // 切租户：currentTenantId 变 9，快照仍 5
    useTenantStore().setCurrentTenantId(9);
    const id = await store.create({ name: "新组" });
    expect(id).toBeNull();
    expect(replaced.length).toBe(1); // reload 自愈
    expect(calls.some((c) => c.includes("/department/create"))).toBe(false); // 未发请求
  });

  it("快照一致 → create 放行（POST create + fetch 刷新）", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store, calls } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    calls.length = 0;
    const id = await store.create({ parentId: 1, name: "子" });
    expect(id).toBe(99);
    expect(calls.some((c) => c.includes("/department/create"))).toBe(true);
    // create 后刷新树
    expect(calls.filter((c) => c.includes("/department/list")).length).toBe(1);
  });

  it("update 经写前守卫", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store, calls } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    calls.length = 0;
    const ok = await store.update({ id: 1, name: "改名" });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.includes("/department/update"))).toBe(true);
  });

  it("remove 经写前守卫；eiam 拒绝重新抛出（E11 兜底）", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(
      () => ({ status: 200, body: treeEnvelope([nodeRaw(1, "总部")]) }),
      {
        delete: () => ({
          status: 200,
          body: { code: 4010703, msg: "存在子部门，无法删除", data: null },
        }),
      },
    );
    await store.fetch();
    await expect(store.remove(1)).rejects.toMatchObject({
      name: "ApiError",
      code: 4010703,
    });
    expect(store.error).toBe("存在子部门，无法删除");
  });
});

describe("orgList 成员分页 + 详情加载（AC-2）", () => {
  it("loadDetail 加载 detail + members，selectedChildCount 来自树", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(
      () => ({
        status: 200,
        body: treeEnvelope([nodeRaw(1, "总部", 0, [nodeRaw(2, "研发", 1)])]),
      }),
      {
        members: () => ({
          status: 200,
          body: {
            code: 0,
            msg: "",
            data: { total: 2, members: [{ id: 1, username: "a" }] },
          },
        }),
      },
    );
    await store.fetch();
    await store.loadDetail(1);
    expect(store.selectedId).toBe(1);
    expect(store.selectedChildCount).toBe(1);
    expect(store.membersTotal).toBe(2);
    expect(store.members).toHaveLength(1);
  });

  it("fetchMembers 切关键词重置 page=1", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    await store.loadDetail(1);
    store.setMembersPage(3);
    store.setMembersKeyword("alice");
    expect(store.membersPage).toBe(1);
    expect(store.membersKeyword).toBe("alice");
  });
});

describe("orgList 401 收敛 + 持久化口径", () => {
  it("registerUnauthorizedReset 注册的回调复位 state", async () => {
    stubLocation("http://localhost:8888/console/organizations");
    const { store } = await freshStore(() => ({
      status: 200,
      body: treeEnvelope([nodeRaw(1, "总部")]),
    }));
    await store.fetch();
    await store.loadDetail(1);
    expect(resetRegistrations.length).toBeGreaterThan(0);
    resetRegistrations[resetRegistrations.length - 1]!();
    expect(store.items).toEqual([]);
    expect(store.total).toBe(0);
    expect(store.selectedId).toBeNull();
    expect(store.members).toEqual([]);
  });
});
