// @vitest-environment happy-dom
/**
 * auditLogs.ts api 客户端单测（feat-audit-logs 契约 §1 / §2.2 / §3）。
 *
 * 覆盖归一契约（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - mapAuthLog：snake_case 原生形（tenant_id / auth_type / fail_reason / client_ip /
 *   user_agent）→ 归一 AuthLog；缺 id → null（调用方过滤）；
 * - mapOperationLog：operator_name → operatorName；仅保留契约声明的键（eiam
 *   OperationLogVO 的 resource_* / before_state 等不透出视图层）；
 * - listAuthLogs：`POST /api/iam/audit/auth/list`，`{total, list}` → `Page<AuthLog>`；
 * - listOperationLogs：`POST /api/iam/audit/operation/list`，`{total, list}` → `Page<OperationLog>`；
 * - **可选筛选键为空时不上行**（空串 / 纯空白 / 非有限数 / 非正数一律不发）；
 * - 筛选键上行时是 eiam 的 snake_case（auth_type / start_time / operator_name ...）；
 * - 缺 id 过滤、list 非数组降级为空、total 缺省按 items 长度、脏数据不抛；
 * - 错误：2xx + code!=0 → ApiError（业务码透传）；非 2xx 信封 → ApiError；网络错 → unavailable。
 *
 * 全程只 mock adapter，**不触网、不写任何数据**（本域本就纯只读）。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthLogBody,
  buildOperationLogBody,
  listAuthLogs,
  listOperationLogs,
  mapAuthLog,
  mapOperationLog,
} from "./auditLogs";
import { eiamAxios } from "@/api/request/eiam";
import { ApiError } from "@/api/types";
import * as auditApi from "./auditLogs";

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

/** 取发送体（JSON 反序列化后） */
function sentBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return JSON.parse(String(config.data)) as Record<string, unknown>;
}

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

describe("mapAuthLog（认证审计原生形 → 归一 AuthLog）", () => {
  it("snake_case 全字段原样归一（契约 §1.1 AuthLogVO 逐字段）", () => {
    const log = mapAuthLog({
      id: 11,
      tenant_id: 1,
      user_id: 5,
      username: "bob",
      auth_type: "password",
      status: "FAIL",
      fail_reason: "密码错误",
      client_ip: "10.0.0.7",
      user_agent: "curl/8",
      ctime: 1730000000000,
    });
    expect(log).toEqual({
      id: 11,
      tenantId: 1,
      userId: 5,
      username: "bob",
      authType: "password",
      status: "FAIL",
      failReason: "密码错误",
      clientIp: "10.0.0.7",
      userAgent: "curl/8",
      ctime: 1730000000000,
    });
    // 归一形只保留契约声明的键（eiam 额外键不透出视图层）
    expect(log).not.toHaveProperty("auth_type");
    expect(log).not.toHaveProperty("fail_reason");
  });

  it("缺 id / id 非正数 / id 非数值 → null（调用方过滤，脏数据不抛）", () => {
    expect(mapAuthLog({ username: "bob" })).toBeNull();
    expect(mapAuthLog({ id: 0 })).toBeNull();
    expect(mapAuthLog({ id: -3 })).toBeNull();
    expect(mapAuthLog({ id: "11" })).toBeNull();
    expect(mapAuthLog({ id: Number.NaN })).toBeNull();
    expect(mapAuthLog({ id: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("非对象输入（null / 字符串 / 数组）→ null，不抛", () => {
    expect(mapAuthLog(null)).toBeNull();
    expect(mapAuthLog("x")).toBeNull();
    expect(mapAuthLog([{ id: 1 }])).toBeNull();
    expect(mapAuthLog(undefined)).toBeNull();
  });

  it("可选字段缺失降级：字符串为空串、可选串为 undefined、时间缺失为 undefined", () => {
    const log = mapAuthLog({ id: 1 });
    expect(log).toEqual({
      id: 1,
      tenantId: undefined,
      userId: undefined,
      username: "",
      authType: "",
      status: "",
      failReason: undefined,
      clientIp: undefined,
      userAgent: undefined,
      ctime: undefined,
    });
  });

  it("字段类型脏（数字当字符串 / 字符串当数值）→ 各自降级，不抛", () => {
    const log = mapAuthLog({
      id: 2,
      username: 123,
      auth_type: null,
      ctime: "1730000000000",
    });
    expect(log?.username).toBe("");
    expect(log?.authType).toBe("");
    expect(log?.ctime).toBeUndefined();
  });
});

describe("mapOperationLog（操作审计原生形 → 归一 OperationLog）", () => {
  it("operator_name → operatorName；契约声明的键原样归一", () => {
    const log = mapOperationLog({
      id: 21,
      operator_name: "alice",
      service: "eiam",
      module: "user",
      action: "create",
      status: "SUCCESS",
      ctime: 1730000000000,
    });
    expect(log).toEqual({
      id: 21,
      operatorName: "alice",
      service: "eiam",
      module: "user",
      action: "create",
      status: "SUCCESS",
      ctime: 1730000000000,
    });
  });

  it("eiam 额外字段（tenant_id / resource_urn / before_state 等）不透出视图层", () => {
    const log = mapOperationLog({
      id: 22,
      tenant_id: 1,
      operator_id: 9,
      resource_id: "u-1",
      resource_name: "张三",
      resource_urn: "urn:iam:api:iam:post:/api/user/create",
      before_state: "{}",
      after_state: '{"name":"张三"}',
      fail_reason: "",
      client_ip: "10.0.0.7",
      user_agent: "curl/8",
    });
    expect(log).toEqual({
      id: 22,
      operatorName: undefined,
      service: undefined,
      module: undefined,
      action: undefined,
      status: undefined,
      ctime: undefined,
    });
  });

  it("缺 id / id 非正数 → null；非对象输入 → null", () => {
    expect(mapOperationLog({ action: "create" })).toBeNull();
    expect(mapOperationLog({ id: 0 })).toBeNull();
    expect(mapOperationLog({ id: "21" })).toBeNull();
    expect(mapOperationLog(null)).toBeNull();
    expect(mapOperationLog("x")).toBeNull();
  });
});

describe("buildAuthLogBody（可选筛选键为空时不上行）", () => {
  it("无筛选 → 仅分页两键", () => {
    expect(buildAuthLogBody({ offset: 0, limit: 20 })).toEqual({
      offset: 0,
      limit: 20,
    });
  });

  it("空串 / 纯空白 / undefined 的筛选键一律不上行", () => {
    const body = buildAuthLogBody({
      offset: 20,
      limit: 50,
      username: "   ",
      authType: "",
      status: " ",
      startTime: undefined,
      endTime: undefined,
    });
    expect(body).toEqual({ offset: 20, limit: 50 });
    expect(Object.keys(body).sort()).toEqual(["limit", "offset"]);
  });

  it("时间键非正数 / 非有限数不上行（0 视为未选）", () => {
    const body = buildAuthLogBody({
      offset: 0,
      limit: 20,
      startTime: 0,
      endTime: Number.NaN,
    });
    expect(body).not.toHaveProperty("start_time");
    expect(body).not.toHaveProperty("end_time");
  });

  it("有值筛选键 → eiam snake_case（auth_type / start_time / end_time），值去首尾空白", () => {
    const body = buildAuthLogBody({
      offset: 0,
      limit: 100,
      username: " bob ",
      authType: "password",
      status: "FAIL",
      startTime: 1730000000000,
      endTime: 1730000600000,
    });
    expect(body).toEqual({
      offset: 0,
      limit: 100,
      username: "bob",
      auth_type: "password",
      status: "FAIL",
      start_time: 1730000000000,
      end_time: 1730000600000,
    });
    // 不得夹带 camelCase 键（eiam 契约要求 snake_case，错键会被静默丢弃）
    expect(body).not.toHaveProperty("authType");
    expect(body).not.toHaveProperty("startTime");
    expect(body).not.toHaveProperty("endTime");
  });
});

describe("buildOperationLogBody（可选筛选键为空时不上行）", () => {
  it("无筛选 → 仅分页两键", () => {
    expect(buildOperationLogBody({ offset: 0, limit: 20 })).toEqual({
      offset: 0,
      limit: 20,
    });
  });

  it("空串 / 纯空白筛选键一律不上行", () => {
    const body = buildOperationLogBody({
      offset: 0,
      limit: 20,
      service: "",
      module: "  ",
      action: "",
      status: " ",
      operatorName: "\t",
      startTime: 0,
      endTime: Number.POSITIVE_INFINITY,
    });
    expect(body).toEqual({ offset: 0, limit: 20 });
  });

  it("有值筛选键 → operator_name 等 snake_case 键（契约 §1.2 逐字）", () => {
    const body = buildOperationLogBody({
      offset: 40,
      limit: 20,
      service: "eiam",
      module: "user",
      action: "delete",
      status: "FAIL",
      operatorName: " alice ",
      startTime: 1730000000000,
      endTime: 1730000600000,
    });
    expect(body).toEqual({
      offset: 40,
      limit: 20,
      service: "eiam",
      module: "user",
      action: "delete",
      status: "FAIL",
      operator_name: "alice",
      start_time: 1730000000000,
      end_time: 1730000600000,
    });
    expect(body).not.toHaveProperty("operatorName");
  });
});

describe("listAuthLogs", () => {
  it("POST /api/iam/audit/auth/list，载荷 {offset, limit}；{total, list} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 2,
            list: [
              {
                id: 1,
                username: "bob",
                auth_type: "password",
                status: "SUCCESS",
                ctime: 1730000000000,
              },
              {
                id: 2,
                username: "eve",
                auth_type: "ldap",
                status: "FAIL",
                fail_reason: "凭据无效",
              },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listAuthLogs({ offset: 20, limit: 20 });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/audit/auth/list");
    expect(sentBody(captured[0]!)).toEqual({ offset: 20, limit: 20 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: 1,
      username: "bob",
      authType: "password",
      status: "SUCCESS",
    });
    expect(page.items[1]).toMatchObject({ failReason: "凭据无效" });
  });

  it("带全量筛选 → 载荷为 snake_case 且键值逐字（契约 §1.1）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, list: [] } } }),
      captured,
    );

    await listAuthLogs({
      offset: 0,
      limit: 50,
      username: "bob",
      authType: "oidc",
      status: "LOCKED",
      startTime: 1730000000000,
      endTime: 1730000600000,
    });

    expect(sentBody(captured[0]!)).toEqual({
      offset: 0,
      limit: 50,
      username: "bob",
      auth_type: "oidc",
      status: "LOCKED",
      start_time: 1730000000000,
      end_time: 1730000600000,
    });
  });

  it("空筛选键不上行（空串 / 纯空白 / 0 时间都不出现在请求体）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, list: [] } } }),
      captured,
    );

    await listAuthLogs({
      offset: 0,
      limit: 20,
      username: "",
      authType: "   ",
      status: "",
      startTime: 0,
      endTime: undefined,
    });

    expect(sentBody(captured[0]!)).toEqual({ offset: 0, limit: 20 });
  });

  it("过滤缺 id 的脏记录（非对象 / 缺 id / id≤0），total 保留服务端值", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: {
          total: 9,
          list: [
            { id: 3, username: "ok" },
            { username: "noid" },
            { id: 0, username: "zero" },
            null,
            "bad",
          ],
        },
      },
    }));
    const page = await listAuthLogs({ offset: 0, limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.username).toBe("ok");
    expect(page.total).toBe(9);
  });

  it("total 缺失 → 按归一后 items 长度（不出现 NaN / undefined）", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { list: [{ id: 1 }, { id: 2 }] } },
    }));
    const page = await listAuthLogs({ offset: 0, limit: 20 });
    expect(page.total).toBe(2);
  });

  it("list 非数组（null / 对象 / 缺失）→ 降级空 Page，不抛", async () => {
    for (const list of [null, { a: 1 }, undefined, "x"]) {
      adapterFor(() => ({ body: { code: 0, msg: "ok", data: { total: 0, list } } }));
      const page = await listAuthLogs({ offset: 0, limit: 20 });
      expect(page).toEqual({ total: 0, items: [] });
    }
    // data 整个缺失（null）同样降级
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }));
    await expect(listAuthLogs({ offset: 0, limit: 20 })).resolves.toEqual({
      total: 0,
      items: [],
    });
  });

  it("空 list → 空 Page（页面空态数据源）", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, list: [] } },
    }));
    await expect(listAuthLogs({ offset: 0, limit: 20 })).resolves.toEqual({
      total: 0,
      items: [],
    });
  });
});

describe("listOperationLogs", () => {
  it("POST /api/iam/audit/operation/list，载荷 {offset, limit}；{total, list} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 1,
            list: [
              {
                id: 7,
                operator_name: "alice",
                service: "eiam",
                module: "role",
                action: "assign",
                status: "SUCCESS",
                ctime: 1730000000000,
                resource_urn: "urn:iam:api:iam:post:/api/role/assign",
              },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listOperationLogs({ offset: 0, limit: 20 });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/audit/operation/list");
    expect(sentBody(captured[0]!)).toEqual({ offset: 0, limit: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual({
      id: 7,
      operatorName: "alice",
      service: "eiam",
      module: "role",
      action: "assign",
      status: "SUCCESS",
      ctime: 1730000000000,
    });
  });

  it("带全量筛选 → operator_name / start_time / end_time 等 snake_case 键", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, list: [] } } }),
      captured,
    );

    await listOperationLogs({
      offset: 100,
      limit: 100,
      service: "eiam",
      module: "user",
      action: "update",
      status: "SUCCESS",
      operatorName: "alice",
      startTime: 1730000000000,
      endTime: 1730000600000,
    });

    expect(sentBody(captured[0]!)).toEqual({
      offset: 100,
      limit: 100,
      service: "eiam",
      module: "user",
      action: "update",
      status: "SUCCESS",
      operator_name: "alice",
      start_time: 1730000000000,
      end_time: 1730000600000,
    });
  });

  it("空筛选键不上行", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, list: [] } } }),
      captured,
    );

    await listOperationLogs({
      offset: 0,
      limit: 20,
      service: "",
      module: " ",
      action: "",
      status: "",
      operatorName: "  ",
      startTime: 0,
      endTime: 0,
    });

    expect(sentBody(captured[0]!)).toEqual({ offset: 0, limit: 20 });
  });

  it("过滤缺 id 的脏记录，total 缺省按 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: {
          list: [
            { id: 1, action: "create" },
            { action: "noid" },
            null,
          ],
        },
      },
    }));
    const page = await listOperationLogs({ offset: 0, limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("list 非数组 → 降级空 Page，不抛", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 3, list: { 0: { id: 1 } } } },
    }));
    const page = await listOperationLogs({ offset: 0, limit: 20 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(3);
  });
});

describe("纯只读（契约 §1「纯前端、纯只读」）", () => {
  it("模块只导出两个 list 读取函数，无任何写端点（审计日志不可编辑/删除）", () => {
    const exported = Object.keys(auditApi);
    expect(exported).toEqual(
      expect.arrayContaining(["listAuthLogs", "listOperationLogs"]),
    );
    expect(
      exported.filter((key) =>
        /create|update|delete|remove|revoke|batch|clear|export|write/i.test(key),
      ),
    ).toEqual([]);
  });
});

describe("错误形态 → ApiError（经 unwrapEnvelope 单一出口）", () => {
  it("认证审计 2xx + code!=0 → ApiError（业务码与 msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4030010, msg: "无权查看认证审计", data: null },
    }));
    const err = await listAuthLogs({ offset: 0, limit: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4030010);
    expect((err as ApiError).message).toBe("无权查看认证审计");
  });

  it("操作审计非 2xx 可解析信封 → ApiError 保留 code / msg", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4030011, msg: "操作审计查询失败", data: null },
    }));
    const err = await listOperationLogs({ offset: 0, limit: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4030011);
    expect((err as ApiError).message).toBe("操作审计查询失败");
  });

  it("网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await listAuthLogs({ offset: 0, limit: 20 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});
