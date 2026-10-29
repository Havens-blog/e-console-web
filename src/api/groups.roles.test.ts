// @vitest-environment happy-dom
/**
 * groups.ts 组角色三接口单测（feat-group-roles 契约 §2.1 / §3）。
 *
 * 锁定（全部 mock axios adapter，**不触真实网络、不创建真实用户组/角色**）：
 * - listGroupRoles：**GET `/api/iam/group/roles/:code`**（path 参数，非 POST body）；
 *   `data` 是**完整 Role VO 数组**（不是 `{total, roles}` 分页信封、不是 code 列表）→ 归一为
 *   TenantGroupRole[]（复用 mapEiamRole 的 id/name/desc 归一 + 时间戳补齐）；
 * - 数组归一：非数组 → []；缺 id 脏记录过滤；name 缺失回退 code；desc 缺失 → '';
 * - ctime / utime：Unix 毫秒原样保留，非有限数 / 字符串 → undefined（视图降级 '—'）；
 * - assignGroupRole / removeGroupRole：POST 且载荷键名精确为 `group_code` / `role_code`
 *   （不是 groupCode / code），**不带 id**；
 * - 三接口均无跨租户 Header（group 端点按会话租户隔离）；
 * - 错误：2xx + code!=0 → ApiError（业务码与 msg 原文透传）；网络错 → unavailable。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignGroupRole,
  listGroupRoles,
  mapEiamGroupRole,
  removeGroupRole,
} from "./groups";
import { eiamAxios } from "@/api/request/eiam";
import { ApiError } from "@/api/types";

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

describe("mapEiamGroupRole（组角色原生形 → 归一 TenantGroupRole）", () => {
  it("完整字段原样映射（eiam group Role VO：id/code/name/desc/ctime/utime）", () => {
    const r = mapEiamGroupRole({
      id: 3,
      code: "admin",
      name: "管理员",
      desc: "平台管理员",
      ctime: 1730000000000,
      utime: 1730000001000,
    });
    expect(r).toMatchObject({
      id: 3,
      code: "admin",
      name: "管理员",
      desc: "平台管理员",
      ctime: 1730000000000,
      utime: 1730000001000,
    });
  });

  it("name 缺失回退 code；desc 缺失 → 空串（复用 mapEiamRole 的归一）", () => {
    const r = mapEiamGroupRole({ id: 4, code: "viewer" });
    expect(r?.name).toBe("viewer");
    expect(r?.desc).toBe("");
  });

  it("缺 id / id 非正数 / 非数值 → null（复用 mapEiamRole 的 id 校验）", () => {
    expect(mapEiamGroupRole({ code: "noid" })).toBeNull();
    expect(mapEiamGroupRole({ id: 0, code: "zero" })).toBeNull();
    expect(mapEiamGroupRole({ id: "3", code: "str" })).toBeNull();
    expect(mapEiamGroupRole(null)).toBeNull();
    expect(mapEiamGroupRole([1, 2])).toBeNull();
  });

  it("ctime / utime 非有限数或字符串 → undefined（Unix 毫秒，缺失不补 0）", () => {
    const r = mapEiamGroupRole({
      id: 5,
      code: "x",
      ctime: Number.NaN,
      utime: "1730000000000",
    });
    expect(r?.ctime).toBeUndefined();
    expect(r?.utime).toBeUndefined();
  });
});

describe("listGroupRoles", () => {
  it("GET /api/iam/group/roles/:code（path 参数，无请求体），完整 Role VO 数组 → TenantGroupRole[]", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: [
            {
              id: 3,
              code: "admin",
              name: "管理员",
              desc: "平台管理员",
              ctime: 1730000000000,
              utime: 1730000001000,
            },
            { id: 4, code: "viewer", name: "只读", desc: "" },
          ],
        },
      }),
      captured,
    );

    const roles = await listGroupRoles("rd");
    expect(captured[0]!.method?.toLowerCase()).toBe("get");
    expect(captured[0]!.url).toBe("/api/iam/group/roles/rd");
    // 契约 §1：GET + path 参数 → 不发请求体
    expect(captured[0]!.data).toBeUndefined();

    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({
      id: 3,
      code: "admin",
      name: "管理员",
      desc: "平台管理员",
      ctime: 1730000000000,
    });
    expect(roles[1]).toMatchObject({ id: 4, code: "viewer", desc: "" });
  });

  it("未绑定任何角色 → []（不是分页信封）", async () => {
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: [] } }));
    expect(await listGroupRoles("rd")).toEqual([]);
  });

  it("数组归一：非数组 data（null / 对象）→ []，不抛错", async () => {
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }));
    expect(await listGroupRoles("rd")).toEqual([]);

    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, roles: [] } },
    }));
    expect(await listGroupRoles("rd")).toEqual([]);
  });

  it("过滤缺 id 的脏记录（顺序保持）", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: [
          { id: 1, code: "a", name: "A", desc: "" },
          { code: "noid", name: "脏" },
          { id: 2, code: "b", name: "B", desc: "" },
        ],
      },
    }));
    const roles = await listGroupRoles("rd");
    expect(roles.map((r) => r.code)).toEqual(["a", "b"]);
  });

  it("path 参数经 encodeURIComponent（标识码含保留字符不破坏路径）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: [] } }),
      captured,
    );
    await listGroupRoles("rd/1");
    expect(captured[0]!.url).toBe("/api/iam/group/roles/rd%2F1");
  });

  it("无跨租户 Header：不携带 X-Active-Tenant-ID（group 端点按会话租户隔离）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: [] } }),
      captured,
    );
    await listGroupRoles("rd");
    expect(
      Object.keys((captured[0]!.headers ?? {}) as unknown as object).map((k) =>
        k.toLowerCase(),
      ),
    ).not.toContain("x-active-tenant-id");
  });

  it("被拒 → ApiError（业务码 + msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4010901, msg: "无权查看用户组角色", data: null },
    }));
    const err = await listGroupRoles("rd").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010901);
    expect((err as ApiError).message).toBe("无权查看用户组角色");
  });
});

describe("assignGroupRole", () => {
  it("POST /api/iam/group/role/assign，载荷 {group_code, role_code}（键名精确，无 id）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await assignGroupRole("rd", "admin");
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/role/assign");
    const body = sentBody(captured[0]!);
    expect(body).toEqual({ group_code: "rd", role_code: "admin" });
    // 键名精确：不接受 camelCase / 简写
    expect(body).not.toHaveProperty("groupCode");
    expect(body).not.toHaveProperty("roleCode");
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("id");
  });

  it("被拒 → ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010902, msg: "该用户组已绑定此角色", data: null },
    }));
    const err = await assignGroupRole("rd", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010902);
    expect((err as ApiError).message).toBe("该用户组已绑定此角色");
  });

  it("网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await assignGroupRole("rd", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("removeGroupRole", () => {
  it("POST /api/iam/group/role/remove，载荷 {group_code, role_code}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await removeGroupRole("rd", "admin");
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/role/remove");
    expect(sentBody(captured[0]!)).toEqual({
      group_code: "rd",
      role_code: "admin",
    });
  });

  it("被拒 → ApiError 原文透传（视图原样展示服务端 msg）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010903, msg: "解绑角色失败", data: null },
    }));
    const err = await removeGroupRole("rd", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010903);
    expect((err as ApiError).message).toBe("解绑角色失败");
  });
});
