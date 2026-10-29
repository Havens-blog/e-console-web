// @vitest-environment happy-dom
/**
 * groupList store 契约测试（feat-group-management；对齐 TECH-frontend-state-002 统一 list store 契约）。
 *
 * 覆盖：
 * - 统一契约 state{items,total,page,pageSize(默认 20/上限 100),loading,error} + fetch/create/update/remove
 * - AbortController：fetch 前中断在途，慢响应不覆盖新结果（AC-3）
 * - E7 分页边界：page 超界回落最后页；删除末页唯一记录回退上一页；切 keyword 重置 page=1
 * - 搜索：keyword 进 list 载荷；setKeyword 重置 page=1
 * - 写操作：create 回第一页刷新；update 刷新；remove 成功后 E7 回退，失败**重新抛出**（供弹窗原样展示 msg）
 * - 401 收敛：registerUnauthorizedReset 注册的回调复位 state
 * - 不声明 persist（列表态不落 localStorage）
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "vue";
import { useGroupListStore } from "./groupList";
import { eiamAxios } from "@/api/request/eiam";

// ---- router 模块替身：捕获 registerUnauthorizedReset 回调 ----
const resetRegistrations: Array<() => void> = [];
vi.mock("@/router", () => ({
  registerUnauthorizedReset: (fn: () => void) => {
    resetRegistrations.push(fn);
  },
  router: {},
}));

const STATUS_TEXT: Partial<Record<number, string>> = {
  200: "OK",
  500: "Internal Server Error",
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

function adapterFor(
  replyFor: (config: InternalAxiosRequestConfig) => MockReply,
  capture: InternalAxiosRequestConfig[] = [],
): void {
  eiamAxios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    capture.push(config);
    const reply = replyFor(config);
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
}

function freshPinia(): void {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
}

beforeEach(() => {
  resetRegistrations.length = 0;
  freshPinia();
});

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

/** eiam 列表成功信封 */
function listReply(
  total: number,
  groups: Array<Record<string, unknown>> = [],
): MockReply {
  return { body: { code: 0, msg: "ok", data: { total, groups } } };
}

describe("统一契约 state + fetch", () => {
  it("初始 state 默认值（page=1 / pageSize=20 / 无 error / keyword 空）", () => {
    const s = useGroupListStore();
    expect(s.items).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.page).toBe(1);
    expect(s.pageSize).toBe(20);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
    expect(s.keyword).toBe("");
  });

  it("fetch 成功 → 写入 items/total；offset 由 page/pageSize 推导", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () =>
        listReply(2, [
          { id: 1, name: "研发组", code: "rd", desc: "" },
          { id: 2, name: "运维组", code: "ops", desc: "ops" },
        ]),
      captured,
    );
    const s = useGroupListStore();
    s.setPage(2);
    const ok = await s.fetch();
    expect(ok).toBe(true);
    expect(s.items).toHaveLength(2);
    expect(s.total).toBe(2);
    expect(s.loading).toBe(false);
    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      offset: 20,
      limit: 20,
      keyword: "",
    });
  });

  it("fetch 失败 → error 归位（msg 原文），不复位 items", async () => {
    const s = useGroupListStore();
    s.items = [{ id: 9, name: "old", code: "o", desc: "" }];
    adapterFor(() => ({
      status: 500,
      body: { code: 4011001, msg: "eiam 不可用", data: null },
    }));
    const ok = await s.fetch();
    expect(ok).toBe(false);
    expect(s.error).toBe("eiam 不可用");
    expect(s.items).toHaveLength(1);
    expect(s.loading).toBe(false);
  });

  it("AbortController：在途请求被新 fetch 中断，慢响应不覆盖新结果", async () => {
    const s = useGroupListStore();
    const resolvers: Array<(r: MockReply) => void> = [];
    eiamAxios.defaults.adapter = ((config: InternalAxiosRequestConfig) =>
      new Promise<AxiosResponse>((resolve, reject) => {
        resolvers.push((reply) => {
          try {
            resolve(
              settleLike({
                data: reply.body ?? null,
                status: reply.status ?? 200,
                statusText: "OK",
                headers: {},
                config,
              } as AxiosResponse),
            );
          } catch (e) {
            reject(e);
          }
        });
      })) as unknown as typeof eiamAxios.defaults.adapter;

    const first = s.fetch();
    // axios adapter 在微任务里才被调用；等它登记完再发第二次（保证两次请求都在途）
    await Promise.resolve();
    await Promise.resolve();
    const second = s.fetch();
    await Promise.resolve();
    await Promise.resolve();
    // 第二次（最新）先回，第一次（已中断）后回
    resolvers[1]!(
      listReply(1, [{ id: 2, name: "new", code: "new", desc: "" }]),
    );
    await second;
    resolvers[0]!(
      listReply(1, [{ id: 1, name: "stale", code: "stale", desc: "" }]),
    );
    await first;

    expect(s.items.map((g) => g.name)).toEqual(["new"]);
    expect(s.loading).toBe(false);
  });

  it("E7：page 超出总页数 → 回落最后页并重查", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => listReply(25, [{ id: 1, name: "a", code: "a", desc: "" }]),
      captured,
    );
    const s = useGroupListStore();
    s.setPage(99);
    await s.fetch();
    // total=25 / pageSize=20 → 2 页；page 回落 2，共两次请求（99 → 2）
    expect(s.page).toBe(2);
    expect(captured).toHaveLength(2);
    expect(JSON.parse(String(captured[1]!.data)).offset).toBe(20);
  });
});

describe("搜索与分页 setters（E7）", () => {
  it("setKeyword 重置 page=1；keyword 进请求载荷", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => listReply(0), captured);
    const s = useGroupListStore();
    s.setPage(3);
    s.setKeyword("研发");
    expect(s.page).toBe(1);
    await s.fetch();
    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      offset: 0,
      limit: 20,
      keyword: "研发",
    });
  });

  it("setPageSize 重置 page=1；超上限夹到 100；非法值回落默认 20", () => {
    const s = useGroupListStore();
    s.setPage(3);
    s.setPageSize(50);
    expect(s.pageSize).toBe(50);
    expect(s.page).toBe(1);

    s.setPageSize(999);
    expect(s.pageSize).toBe(100);

    s.setPageSize(Number.NaN);
    expect(s.pageSize).toBe(20);
  });

  it("setPage(0) 归一为 1", () => {
    const s = useGroupListStore();
    s.setPage(0);
    expect(s.page).toBe(1);
  });
});

describe("写操作：create / update / remove", () => {
  it("create 成功 → 回第一页并刷新", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      (config) =>
        config.url === "/api/iam/group/create"
          ? { body: { code: 0, msg: "ok", data: null } }
          : listReply(1, [{ id: 1, name: "研发组", code: "rd", desc: "" }]),
      captured,
    );
    const s = useGroupListStore();
    s.setPage(3);
    const ok = await s.create({ name: "研发组", code: "rd" });
    expect(ok).toBe(true);
    expect(s.page).toBe(1);
    expect(captured[0]!.url).toBe("/api/iam/group/create");
    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      name: "研发组",
      code: "rd",
    });
    expect(captured[1]!.url).toBe("/api/iam/group/list");
  });

  it("create 失败 → false + error 归位（eiam 拒绝原文）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4011002, msg: "标识码已存在", data: null },
    }));
    const s = useGroupListStore();
    const ok = await s.create({ name: "研发组", code: "rd" });
    expect(ok).toBe(false);
    expect(s.error).toBe("标识码已存在");
  });

  it("update 成功 → 刷新当前页；载荷无 code", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      (config) =>
        config.url === "/api/iam/group/update"
          ? { body: { code: 0, msg: "ok", data: null } }
          : listReply(1, [{ id: 7, name: "研发组2", code: "rd", desc: "" }]),
      captured,
    );
    const s = useGroupListStore();
    const ok = await s.update({ id: 7, name: "研发组2" });
    expect(ok).toBe(true);
    const body = JSON.parse(String(captured[0]!.data));
    expect(body).toEqual({ id: 7, name: "研发组2" });
    expect(body.code).toBeUndefined();
    expect(s.items[0]?.name).toBe("研发组2");
  });

  it("remove 成功 → 刷新列表", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      (config) =>
        config.url?.startsWith("/api/iam/group/delete/")
          ? { body: { code: 0, msg: "ok", data: null } }
          : listReply(0),
      captured,
    );
    const s = useGroupListStore();
    const ok = await s.remove(7);
    expect(ok).toBe(true);
    expect(captured[0]!.method?.toLowerCase()).toBe("delete");
    expect(captured[0]!.url).toBe("/api/iam/group/delete/7");
    expect(captured[1]!.url).toBe("/api/iam/group/list");
  });

  it("remove：删掉末页唯一记录 → page 回退上一页（E7）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    let calls = 0;
    adapterFor((config) => {
      if (config.url?.startsWith("/api/iam/group/delete/")) {
        return { body: { code: 0, msg: "ok", data: null } };
      }
      calls += 1;
      // 第一次 list（page=2，共 21 条）→ 1 条；删除后只剩 20 条 → 1 页
      return calls === 1
        ? listReply(21, [{ id: 21, name: "last", code: "l", desc: "" }])
        : listReply(20, [{ id: 1, name: "first", code: "f", desc: "" }]);
    }, captured);

    const s = useGroupListStore();
    s.setPage(2);
    await s.fetch();
    expect(s.page).toBe(2);

    await s.remove(21);
    // 删除后末页变空 → 回落第 1 页，最终一次 list 的 offset 为 0
    expect(s.page).toBe(1);
    const listCalls = captured.filter(
      (c) => c.url === "/api/iam/group/list",
    );
    expect(JSON.parse(String(listCalls[listCalls.length - 1]!.data)).offset).toBe(
      0,
    );
  });

  it("remove 失败 → error 归位且**重新抛出**（调用方渲染 eiam 原文）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4011003, msg: "用户组仍有成员，无法删除", data: null },
    }));
    const s = useGroupListStore();
    await expect(s.remove(7)).rejects.toBeInstanceOf(Error);
    expect(s.error).toBe("用户组仍有成员，无法删除");
  });
});

describe("resetState（401 收敛）", () => {
  it("复位全部 state 与 keyword", async () => {
    const s = useGroupListStore();
    s.items = [{ id: 1, name: "a", code: "a", desc: "" }];
    s.total = 9;
    s.setPage(2);
    s.setPageSize(50);
    s.setKeyword("x");
    s.resetState();
    expect(s.items).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.page).toBe(1);
    expect(s.pageSize).toBe(20);
    expect(s.keyword).toBe("");
    expect(s.error).toBeNull();
  });

  it("经 registerUnauthorizedReset 注册了复位回调（401 收敛链路）", () => {
    useGroupListStore();
    expect(resetRegistrations.length).toBeGreaterThan(0);
  });

  it("不声明 persist（列表态不落 localStorage）", () => {
    useGroupListStore();
    const keys = Object.keys(localStorage);
    expect(keys.filter((k) => k.toLowerCase().includes("group"))).toHaveLength(0);
  });
});
