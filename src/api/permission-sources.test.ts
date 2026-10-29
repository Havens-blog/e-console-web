// @vitest-environment happy-dom
/**
 * 「权限来源」四接口 api 层单测（feat-user-permission-sources 契约 §1 / §2.1 / §3）。
 *
 * 全部 mock axios adapter，**不触真实网络、不读写任何真实用户数据**（本面板纯只读）。
 *
 * 锁定：
 * - 路径精确：四个 attached/user 端点；
 * - 载荷精确：`user_id` 必在，**role 只有 `user_id`**（契约 §1 明令无分页字段），
 *   其余三个带 `offset / limit / keyword`；policy 不夹带 `type`（eiam 为 uint8，传错会 400）；
 * - 归一：`{total, <list>}` → `Role[]` / `TenantGroup[]` / `Page<PolicyWithMeta>` / `Page<Tenant>`，
 *   snake_case / 单数 statement / status int 全在 api 层收敛；
 * - 降级：非对象 / 缺键 / 非数组 → 空（不抛）；缺 id / 缺 code 脏项过滤，合法项保序；
 * - 错误：2xx 业务码 / 非 2xx 信封 / 网络失败 → 统一 ApiError（kind + msg 原文透传）。
 *
 * 另记（契约 §1 与后端实现的一处事实）：eiam `role/list/attached/user` 与
 * `group/list/attached/user` 的 handler **不兜底 limit**（role/handler.go:114、
 * group/handler.go:185 原样下传），而 DAO 走 `Paginate(=Limit(limit))` —— `limit=0` 会生成
 * `LIMIT 0`。本文件只按契约锁定「role 载荷仅 user_id」，不擅自加字段；
 * 见交付报告「契约与实际后端的差异」一节。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import { listRolesForUser } from "./roles";
import { listGroupsForUser } from "./groups";
import { listPoliciesForUser } from "./policies";
import { listTenantsForUser } from "./tenants";
import { eiamAxios } from "@/api/request/eiam";
import { ApiError } from "@/api/types";

const STATUS_TEXT: Partial<Record<number, string>> = {
  200: "OK",
  500: "Internal Server Error",
  403: "Forbidden",
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

/** 取发送体（JSON 反序列化后） */
function sentBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return JSON.parse(String(config.data)) as Record<string, unknown>;
}

/** 成功信封 */
function ok(data: unknown): MockReply {
  return { body: { code: 0, msg: "ok", data } };
}

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

describe("listRolesForUser（/role/list/attached/user）", () => {
  // 契约勘误（2026-10-28）：原契约写「本端点载荷只有 user_id」，实测该端点会把 limit=0
  // 原样下传 → GORM `LIMIT 0` → 恒空列表（total 却非 0）。故改为**必须带分页字段**。
  it("POST 正确路径，载荷含 user_id + 分页字段（不带 limit 会被后端 LIMIT 0 清空）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () =>
        ok({
          total: 1,
          roles: [
            { id: 3, code: "admin", name: "管理员", desc: "平台管理员" },
          ],
        }),
      captured,
    );

    await listRolesForUser(7);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/role/list/attached/user");

    const body = sentBody(captured[0]!);
    expect(body).toEqual({ user_id: 7, offset: 0, limit: 100, keyword: "" });
    // limit 必须 > 0：git 历史里有「不带 limit → LIMIT 0 → 角色区块恒空」的教训
    expect(Number((body as { limit: number }).limit)).toBeGreaterThan(0);
    // 键名精确：不接受 camelCase / 角色 code
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("role_code");
  });

  it("归一 {total, roles} → Role[]（缺 id 脏项过滤，合法项保序）", async () => {
    adapterFor(() =>
      ok({
        total: 2,
        roles: [
          { id: 3, code: "admin", name: "管理员", desc: "平台管理员" },
          { id: 0, code: "dirty" },
          { code: "no-id" },
          null,
          "x",
          { id: 4, code: "viewer", name: "只读" },
        ],
      }),
    );

    const roles = await listRolesForUser(7);
    expect(roles.map((r) => r.code)).toEqual(["admin", "viewer"]);
    expect(roles[0]).toEqual({
      id: 3,
      code: "admin",
      name: "管理员",
      desc: "平台管理员",
      tenantId: 0,
      policies: [],
      users: [],
    });
    // name 缺失回退 code（不臆造）
    expect(roles[1]!.name).toBe("只读");
  });

  it("兼容裸数组响应（防御代理/旧版直出），仍归一为 Role[]", async () => {
    adapterFor(() => ok([{ id: 5, code: "ops", name: "运维" }]));
    const roles = await listRolesForUser(7);
    expect(roles).toHaveLength(1);
    expect(roles[0]!.code).toBe("ops");
  });

  it("脏数据降级：null / 缺 roles / roles 非数组 → []，不抛", async () => {
    for (const data of [null, {}, { total: 3 }, { roles: "x" }, 42]) {
      adapterFor(() => ok(data));
      await expect(listRolesForUser(7)).resolves.toEqual([]);
    }
  });

  it("2xx 业务码 → ApiError（业务码 + msg 原文透传）", async () => {
    adapterFor(() => ({
      body: { code: 4010801, msg: "无权查看用户角色", data: null },
    }));
    const err = await listRolesForUser(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010801);
    expect((err as ApiError).message).toBe("无权查看用户角色");
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await listRolesForUser(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("listGroupsForUser（/group/list/attached/user）", () => {
  it("POST 正确路径，载荷 {user_id, offset, limit, keyword}（不带分页以外字段）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, groups: [] }), captured);

    await listGroupsForUser(7);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/list/attached/user");
    expect(sentBody(captured[0]!)).toEqual({
      user_id: 7,
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(sentBody(captured[0]!)).not.toHaveProperty("username");
  });

  it("归一 {total, groups} → TenantGroup[]（键名 camelCase，时间戳缺失 → undefined）", async () => {
    adapterFor(() =>
      ok({
        total: 2,
        groups: [
          { id: 5, name: "运维组", code: "ops", desc: "运维", ctime: 1700000000000 },
          { id: 6, name: "空描述组", code: "empty" },
        ],
      }),
    );

    const groups = await listGroupsForUser(7);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      id: 5,
      name: "运维组",
      code: "ops",
      desc: "运维",
      ctime: 1700000000000,
      utime: undefined,
    });
    expect(groups[1]!.ctime).toBeUndefined();
  });

  it("兼容裸数组；脏项（缺 id / 非对象）过滤，脏数据整体降级为 []", async () => {
    adapterFor(() =>
      ok([{ id: 5, name: "运维组", code: "ops" }, null, { id: 0 }]),
    );
    const groups = await listGroupsForUser(7);
    expect(groups.map((g) => g.code)).toEqual(["ops"]);

    for (const data of [null, "x", { total: 1 }, { groups: {} }]) {
      adapterFor(() => ok(data));
      await expect(listGroupsForUser(7)).resolves.toEqual([]);
    }
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ECONNABORTED", message: "timeout" },
    }));
    const err = await listGroupsForUser(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("listPoliciesForUser（/policy/list/attached/user）", () => {
  it("POST 正确路径，载荷精确 {user_id, offset, limit, keyword}（不夹带 type）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, policies: [] }), captured);

    await listPoliciesForUser(7, { offset: 20, limit: 5, keyword: "read" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/policy/list/attached/user");
    expect(sentBody(captured[0]!)).toEqual({
      user_id: 7,
      offset: 20,
      limit: 5,
      keyword: "read",
    });
    // eiam ListUserPoliciesReq.type 为 uint8，传字符串会 400 —— 本层不发该键
    expect(sentBody(captured[0]!)).not.toHaveProperty("type");
  });

  it("归一 {total, policies} → Page<PolicyWithMeta>（单数 statement → 复数 statements）", async () => {
    adapterFor(() =>
      ok({
        total: 1,
        policies: [
          {
            id: 2,
            code: "p1",
            name: "策略1",
            desc: "读权限",
            assignment_count: 3,
            statement: [
              { effect: "Allow", action: ["read"], resource: ["*"] },
            ],
          },
        ],
      }),
    );

    const page = await listPoliciesForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const p = page.items[0]!;
    expect(p.code).toBe("p1");
    expect(p.assignmentCount).toBe(3);
    expect(p.statements).toEqual([
      { effect: "Allow", actions: ["read"], resources: ["*"] },
    ]);
  });

  it("缺 code 的策略被过滤；total 保留服务端值；脏数据降级为 {total:0, items:[]}", async () => {
    adapterFor(() =>
      ok({ total: 9, policies: [{ id: 2 }, null, { code: "p1", name: "策略1" }] }),
    );
    const page = await listPoliciesForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(page.total).toBe(9);
    expect(page.items.map((p) => p.code)).toEqual(["p1"]);

    for (const data of [null, "x", 3]) {
      adapterFor(() => ok(data));
      await expect(
        listPoliciesForUser(7, { offset: 0, limit: 100, keyword: "" }),
      ).resolves.toEqual({ total: 0, items: [] });
    }

    // 缺 policies 键但服务端 total 有效 → items 空、total 原值保留（分页器仍可显示总数）
    adapterFor(() => ok({ total: 1 }));
    await expect(
      listPoliciesForUser(7, { offset: 0, limit: 100, keyword: "" }),
    ).resolves.toEqual({ total: 1, items: [] });
  });

  it("兼容裸数组响应；total 缺省按 items 长度", async () => {
    adapterFor(() => ok([{ code: "p1", name: "策略1" }]));
    const page = await listPoliciesForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(page).toMatchObject({ total: 1 });
    expect(page.items[0]!.code).toBe("p1");
  });

  it("被拒 → ApiError（业务码 + msg 原文）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010902, msg: "无权查看用户策略", data: null },
    }));
    const err = await listPoliciesForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010902);
    expect((err as ApiError).message).toBe("无权查看用户策略");
  });
});

describe("listTenantsForUser（/tenant/list/attached/user）", () => {
  it("POST 正确路径，载荷精确 {user_id, offset, limit, keyword}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, tenants: [] }), captured);

    await listTenantsForUser(7, { offset: 0, limit: 100, keyword: "" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/tenant/list/attached/user");
    expect(sentBody(captured[0]!)).toEqual({
      user_id: 7,
      offset: 0,
      limit: 100,
      keyword: "",
    });
  });

  it("归一 {total, tenants} → Page<Tenant>（status int → 词表，用量计数不补 0）", async () => {
    adapterFor(() =>
      ok({
        total: 2,
        tenants: [
          {
            id: 1,
            name: "系统租户",
            code: "system",
            domain: "",
            status: 1,
            user_count: 5,
            max_users: 50,
          },
          { id: 2, name: "禁用租户", code: "off", status: 2, user_count: 0 },
        ],
      }),
    );

    const page = await listTenantsForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(page.total).toBe(2);
    const first = page.items[0]!;
    expect(first.status).toBe("active");
    expect(first.userCount).toBe(5);
    expect(first.maxUsers).toBe(50);
    // 治理配置补齐（视图无需区分「无配置」与「未加载」）
    expect(first.featureSwitch).toEqual({});
    expect(first.allowedVendors).toEqual([]);
    const second = page.items[1]!;
    expect(second.status).toBe("disable");
    // 0 是真实为零，必须保留（与 undefined = 统计不可用 区分）
    expect(second.userCount).toBe(0);
    expect(second.maxUsers).toBe(0);
  });

  it("兼容裸数组；脏数据降级为 {total:0, items:[]}", async () => {
    adapterFor(() => ok([{ id: 1, name: "系统租户", code: "system" }]));
    const page = await listTenantsForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);

    for (const data of [null, "x", { tenants: 3 }]) {
      adapterFor(() => ok(data));
      await expect(
        listTenantsForUser(7, { offset: 0, limit: 100, keyword: "" }),
      ).resolves.toEqual({ total: 0, items: [] });
    }

    // 缺 tenants 键但服务端 total 有效 → items 空、total 原值保留
    adapterFor(() => ok({ total: 2 }));
    await expect(
      listTenantsForUser(7, { offset: 0, limit: 100, keyword: "" }),
    ).resolves.toEqual({ total: 2, items: [] });
  });

  it("403 跨租户拦截 → ApiError(forbidden)，msg 原文透传（WTO 包装）", async () => {
    adapterFor(() => ({
      status: 403,
      body: {
        code: 403001,
        msg: "检测到跨租户越权操作，该请求已被安全拦截",
        data: null,
      },
    }));
    const err = await listTenantsForUser(7, {
      offset: 0,
      limit: 100,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("forbidden");
    expect((err as ApiError).message).toBe(
      "检测到跨租户越权操作，该请求已被安全拦截",
    );
  });
});
