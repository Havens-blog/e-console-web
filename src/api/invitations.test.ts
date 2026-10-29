// @vitest-environment happy-dom
/**
 * invitations.ts api 客户端单测（feat-invitation-management 契约 §2.1 / §3）。
 *
 * 覆盖归一契约（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - mapEiamInvitation：snake_case 原生形（tenant_id / max_uses / expire_at / require_approval）
 *   → 归一 Invitation；缺 code → null（调用方过滤）；
 * - listInvitations：`POST /api/iam/invitation/list` 载荷仅 `{offset, limit}`（契约 §1 无
 *   keyword / status），`{total, invitations}` → `Page<Invitation>`，total 缺省按 items 长度；
 * - createInvitation：`POST /api/iam/invitation/create`，载荷键名精确为
 *   `max_uses` / `expiry_days` / `role_codes` / `require_approval`（不得出现 camelCase 键）；
 * - revokeInvitation：**DELETE** `/api/iam/invitation/revoke/:code`，code 经 encodeURIComponent；
 * - batchRevokeInvitations：`POST /api/iam/invitation/batch_revoke`，载荷 **`{codes}`**
 *   （键不是 `invitation_codes`），空数组原样上行；被拒经 unwrapEnvelope 抛 ApiError 原文；
 * - listJoinRequests：`POST /api/iam/invitation/requests` 载荷 `{offset, limit}`，
 *   `{total, requests}` → `Page<JoinRequest>`，缺 id 过滤；
 * - 错误：2xx + code!=0 → ApiError（业务码透传）；非 2xx 信封 → ApiError；网络错 → unavailable。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  batchRevokeInvitations,
  createInvitation,
  listInvitations,
  listJoinRequests,
  mapEiamInvitation,
  mapEiamJoinRequest,
  revokeInvitation,
} from "./invitations";
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

describe("mapEiamInvitation（邀请原生形 → 归一 Invitation）", () => {
  it("snake_case 全字段原样归一（契约 §1 响应样例逐字段）", () => {
    const inv = mapEiamInvitation({
      code: "abc123",
      tenant_id: 1,
      tenant_name: "系统根管理空间",
      inviter_id: 1,
      role_codes: ["viewer"],
      max_uses: 5,
      used_count: 0,
      expire_at: 1730000000000,
      require_approval: false,
      is_member: false,
    });
    expect(inv).toEqual({
      code: "abc123",
      tenantId: 1,
      tenantName: "系统根管理空间",
      inviterId: 1,
      roleCodes: ["viewer"],
      maxUses: 5,
      usedCount: 0,
      expireAt: 1730000000000,
      requireApproval: false,
    });
    // 归一形只保留契约声明的键（eiam 额外键不透出视图层）
    expect(inv).not.toHaveProperty("is_member");
    expect(inv).not.toHaveProperty("max_uses");
  });

  it("缺 code / code 非字符串 / 空串 → null（调用方过滤）", () => {
    expect(mapEiamInvitation({ max_uses: 1 })).toBeNull();
    expect(mapEiamInvitation({ code: "" })).toBeNull();
    expect(mapEiamInvitation({ code: 123 })).toBeNull();
  });

  it("非对象输入 → null", () => {
    expect(mapEiamInvitation(null)).toBeNull();
    expect(mapEiamInvitation("x")).toBeNull();
    expect(mapEiamInvitation([1, 2])).toBeNull();
  });

  it("可选字段缺失 → undefined / 空数组 / 0；require_approval 非 true → false", () => {
    const inv = mapEiamInvitation({ code: "c1" });
    expect(inv).toEqual({
      code: "c1",
      tenantId: undefined,
      tenantName: undefined,
      inviterId: undefined,
      roleCodes: [],
      maxUses: 0,
      usedCount: 0,
      expireAt: undefined,
      requireApproval: false,
    });
    expect(mapEiamInvitation({ code: "c2", role_codes: "viewer" })?.roleCodes).toEqual(
      [],
    );
  });

  it("时间戳非有限数 → undefined（Unix 毫秒，缺失不补 0）", () => {
    expect(
      mapEiamInvitation({ code: "c3", expire_at: Number.NaN })?.expireAt,
    ).toBeUndefined();
    expect(
      mapEiamInvitation({ code: "c4", expire_at: "1730000000000" })?.expireAt,
    ).toBeUndefined();
  });

  it("role_codes 中非字符串元素被过滤", () => {
    expect(
      mapEiamInvitation({ code: "c5", role_codes: ["viewer", 1, null, "ops"] })
        ?.roleCodes,
    ).toEqual(["viewer", "ops"]);
  });
});

describe("mapEiamJoinRequest（加入申请原生形 → 归一 JoinRequest）", () => {
  it("全字段原样归一（invitation_code / ctime）", () => {
    expect(
      mapEiamJoinRequest({
        id: 1,
        user_id: 5,
        username: "bob",
        nickname: "鲍勃",
        invitation_code: "abc123",
        role_codes: [],
        ctime: 1730000000000,
      }),
    ).toEqual({
      id: 1,
      userId: 5,
      username: "bob",
      nickname: "鲍勃",
      invitationCode: "abc123",
      roleCodes: [],
      ctime: 1730000000000,
    });
  });

  it("缺 id / 非正数 / 非数值 → null；可选字段缺失降级", () => {
    expect(mapEiamJoinRequest({ username: "bob" })).toBeNull();
    expect(mapEiamJoinRequest({ id: 0 })).toBeNull();
    expect(mapEiamJoinRequest({ id: -1 })).toBeNull();
    expect(mapEiamJoinRequest({ id: "1" })).toBeNull();

    const r = mapEiamJoinRequest({ id: 2, username: "eve" });
    expect(r).toEqual({
      id: 2,
      userId: 0,
      username: "eve",
      nickname: "",
      invitationCode: "",
      roleCodes: [],
      ctime: undefined,
    });
  });
});

describe("listInvitations", () => {
  it("POST /api/iam/invitation/list，载荷仅 {offset, limit}；{total, invitations} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 2,
            invitations: [
              { code: "abc123", tenant_id: 1, max_uses: 5, used_count: 0 },
              { code: "def456", max_uses: 1, used_count: 1 },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listInvitations({ offset: 20, limit: 20, keyword: "x" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/invitation/list");
    // 契约 §1：请求体只有 offset/limit —— keyword 不得上行（端点不支持，发了会被静默忽略）
    expect(sentBody(captured[0]!)).toEqual({ offset: 20, limit: 20 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      code: "abc123",
      maxUses: 5,
      usedCount: 0,
    });
  });

  it("过滤缺 code 的脏记录，total 缺省 → 按归一后 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: {
          invitations: [{ code: "a1" }, { max_uses: 3 }, { code: "" }],
        },
      },
    }));
    const page = await listInvitations({ offset: 0, limit: 20, keyword: "" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("空 invitations 数组 → 空 Page", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, invitations: [] } },
    }));
    const page = await listInvitations({ offset: 0, limit: 20, keyword: "" });
    expect(page).toEqual({ total: 0, items: [] });
  });

  it("ListQuery.status 不进请求体（契约 §1 请求体只有两键）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: { code: 0, msg: "ok", data: { total: 0, invitations: [] } },
      }),
      captured,
    );
    await listInvitations({ offset: 0, limit: 50, keyword: "", status: 1 });
    expect(sentBody(captured[0]!)).not.toHaveProperty("status");
    expect(sentBody(captured[0]!)).not.toHaveProperty("keyword");
  });

  it("无跨租户 Header：不携带 X-Active-Tenant-ID（invitation 按会话租户隔离）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: { code: 0, msg: "ok", data: { total: 0, invitations: [] } },
      }),
      captured,
    );
    await listInvitations({ offset: 0, limit: 20, keyword: "" });
    const headers = captured[0]!.headers as unknown as {
      get?: (k: string) => unknown;
    };
    expect(headers.get?.("X-Active-Tenant-ID")).toBeUndefined();
  });
});

describe("createInvitation", () => {
  it("POST /api/iam/invitation/create，载荷键名精确为 snake_case（契约 §1 逐字）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    await createInvitation({
      maxUses: 5,
      expiryDays: 7,
      roleCodes: ["viewer", "ops"],
      requireApproval: true,
    });

    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/invitation/create");
    expect(sentBody(captured[0]!)).toEqual({
      max_uses: 5,
      expiry_days: 7,
      role_codes: ["viewer", "ops"],
      require_approval: true,
    });
    // 不得夹带 camelCase 键（eiam 契约要求 snake_case，错键会被静默丢弃）
    const body = sentBody(captured[0]!);
    expect(body).not.toHaveProperty("maxUses");
    expect(body).not.toHaveProperty("expiryDays");
    expect(body).not.toHaveProperty("roleCodes");
    expect(body).not.toHaveProperty("requireApproval");
  });

  it("空角色列表照常上行（role_codes: []）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);
    await createInvitation({
      maxUses: 1,
      expiryDays: 1,
      roleCodes: [],
      requireApproval: false,
    });
    expect(sentBody(captured[0]!)).toEqual({
      max_uses: 1,
      expiry_days: 1,
      role_codes: [],
      require_approval: false,
    });
  });
});

describe("revokeInvitation", () => {
  it("DELETE /api/iam/invitation/revoke/:code", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    await revokeInvitation("abc123");
    expect(captured[0]!.method?.toLowerCase()).toBe("delete");
    expect(captured[0]!.url).toBe("/api/iam/invitation/revoke/abc123");
  });

  it("邀请码经 encodeURIComponent（含 / 空格 + 等字符不被当成路径结构）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    const code = "a b/c+d&e";
    await revokeInvitation(code);
    expect(captured[0]!.url).toBe(
      `/api/iam/invitation/revoke/${encodeURIComponent(code)}`,
    );
    expect(captured[0]!.url).toBe(
      "/api/iam/invitation/revoke/a%20b%2Fc%2Bd%26e",
    );
    // 原样拼接会把一个人造的路径段注入到 URL 里
    expect(captured[0]!.url).not.toContain("/revoke/a b/c+d&e");
  });

  it("空邀请码也不抛本地错误（交给服务端判定，URL 仍是单段）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);
    await revokeInvitation("");
    expect(captured[0]!.url).toBe("/api/iam/invitation/revoke/");
  });
});

describe("batchRevokeInvitations（feat-invitation-complete 契约 §1 / §2.1）", () => {
  it("POST /api/iam/invitation/batch_revoke，载荷键精确为 codes（数组，逐字保序）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    await batchRevokeInvitations(["abc123", "def456"]);

    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/invitation/batch_revoke");
    expect(sentBody(captured[0]!)).toEqual({ codes: ["abc123", "def456"] });
    // 契约 §1 明示：键是 codes，不是 invitation_codes / role_codes（错键会被 eiam 静默丢弃）
    const body = sentBody(captured[0]!);
    expect(body).not.toHaveProperty("invitation_codes");
    expect(body).not.toHaveProperty("role_codes");
    expect(Object.keys(body)).toEqual(["codes"]);
  });

  it("空数组照样上行（{codes: []}，不在本地臆造拦截）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    await batchRevokeInvitations([]);

    expect(captured[0]!.url).toBe("/api/iam/invitation/batch_revoke");
    expect(sentBody(captured[0]!)).toEqual({ codes: [] });
  });

  it("含特殊字符的邀请码原样放进 body（不经 URL 编码）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);

    const codes = ["a b/c+d&e", "普通码"];
    await batchRevokeInvitations(codes);

    expect(sentBody(captured[0]!)).toEqual({ codes });
    expect(captured[0]!.url).toBe("/api/iam/invitation/batch_revoke");
  });

  it("2xx + code!=0 → ApiError（业务码与 msg 原文透传，UI 原样展示）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4013004, msg: "部分邀请码已失效", data: null },
    }));
    const err = await batchRevokeInvitations(["abc123", "gone"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4013004);
    expect((err as ApiError).message).toBe("部分邀请码已失效");
  });

  it("非 2xx 信封 → ApiError 保留 code / msg（无权限批量撤回）", async () => {
    adapterFor(() => ({
      status: 403,
      body: { code: 4013005, msg: "无权批量撤回邀请", data: null },
    }));
    const err = await batchRevokeInvitations(["abc123"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4013005);
    expect((err as ApiError).message).toBe("无权批量撤回邀请");
  });

  it("网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await batchRevokeInvitations(["abc123"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("listJoinRequests", () => {
  it("POST /api/iam/invitation/requests，载荷 {offset, limit}；{total, requests} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 1,
            requests: [
              {
                id: 1,
                user_id: 5,
                username: "bob",
                nickname: "鲍勃",
                invitation_code: "abc123",
                role_codes: [],
                ctime: 1730000000000,
              },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listJoinRequests({ offset: 0, limit: 20, keyword: "" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/invitation/requests");
    expect(sentBody(captured[0]!)).toEqual({ offset: 0, limit: 20 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      id: 1,
      userId: 5,
      username: "bob",
      invitationCode: "abc123",
    });
  });

  it("过滤缺 id 的脏记录，total 缺省按 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: { requests: [{ id: 3, username: "a" }, { username: "noid" }] },
      },
    }));
    const page = await listJoinRequests({ offset: 0, limit: 20, keyword: "" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("空 requests → 空 Page（申请列表空态数据源）", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, requests: [] } },
    }));
    const page = await listJoinRequests({ offset: 0, limit: 20, keyword: "" });
    expect(page).toEqual({ total: 0, items: [] });
  });
});

describe("错误形态 → ApiError（经 unwrapEnvelope 单一出口）", () => {
  it("list 2xx + code!=0 → ApiError（业务码与 msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4013001, msg: "无权查看邀请", data: null },
    }));
    const err = await listInvitations({
      offset: 0,
      limit: 20,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4013001);
    expect((err as ApiError).message).toBe("无权查看邀请");
  });

  it("create 非 2xx 可解析信封 → ApiError 保留 code / msg（拒绝原文可展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4013002, msg: "有效天数超出范围", data: null },
    }));
    const err = await createInvitation({
      maxUses: 1,
      expiryDays: 999,
      roleCodes: [],
      requireApproval: false,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4013002);
    expect((err as ApiError).message).toBe("有效天数超出范围");
  });

  it("revoke 被拒（邀请已失效）→ ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4013003, msg: "邀请码已失效", data: null },
    }));
    const err = await revokeInvitation("abc123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4013003);
    expect((err as ApiError).message).toBe("邀请码已失效");
  });

  it("requests 网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await listJoinRequests({
      offset: 0,
      limit: 20,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});
