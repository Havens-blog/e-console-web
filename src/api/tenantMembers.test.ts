// @vitest-environment happy-dom
/**
 * tenantMembers.ts api 客户端单测（feat-tenant-members-ui 契约 §1.1/§1.2/§1.3/§3）。
 *
 * 锁定 api 层契约（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 每次调用都注入 `X-Active-Tenant-ID: <tenantId>`（跨租户上下文，漏掉会串数据 / 403）；
 * - 请求体：members 为 {offset, limit, keyword}；unassign 为 {user_id}；
 * - 归一：`{total, members}` → Page<TenantMember>；status int(1/2) 复用
 *   normalizeTenantStatus 口径；snake_case（job_title/last_login_at）→ camelCase；
 *   缺 id 过滤、可选字段缺失兜底（undefined / 空串）；
 * - 错误信封（2xx code!=0 / 非 2xx 可解析信封）→ ApiError，message 保留 eiam msg 原文。
 *
 * 手法与 tenants.test.ts 一致：替换 eiamAxios.defaults.adapter，不触真实网络。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  listTenantMembers,
  mapEiamTenantMember,
  removeTenantMember,
} from "./tenantMembers";
import { eiamAxios } from "@/api/request/eiam";
import { ApiError } from "@/api/types";

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

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

/** 读取请求头（AxiosHeaders 支持 get；普通对象回退下标） */
function headerValue(
  config: InternalAxiosRequestConfig,
  name: string,
): string | undefined {
  const headers = config.headers as unknown as {
    get?: (key: string) => unknown;
    [key: string]: unknown;
  };
  const fromGet =
    typeof headers.get === "function" ? headers.get(name) : undefined;
  const value = fromGet ?? headers[name];
  return value === undefined || value === null ? undefined : String(value);
}

/** 固定成功响应：2 名成员（第二名缺可选字段 + status 2） + 1 条缺 id 的脏数据 */
function membersReply(): MockReply {
  return {
    body: {
      code: 0,
      msg: "ok",
      data: {
        total: 3,
        members: [
          {
            id: 42,
            username: "zhangsan",
            nickname: "张三",
            avatar: "",
            email: "z@example.com",
            status: 1,
            job_title: "工程师",
            last_login_at: 1730000000,
            ctime: 1729000000,
          },
          { id: 43, username: "lisi", status: 2 },
          { id: 0, username: "bad" },
        ],
      },
    },
  };
}

describe("mapEiamTenantMember（成员原生形状 → 归一 TenantMember）", () => {
  it("完整字段归一：snake_case → camelCase、status int 1 → 'active'", () => {
    const m = mapEiamTenantMember({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      avatar: "https://cdn/avatar.png",
      email: "z@example.com",
      status: 1,
      job_title: "工程师",
      last_login_at: 1730000000,
      ctime: 1729000000,
    });
    expect(m).toEqual({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      avatar: "https://cdn/avatar.png",
      email: "z@example.com",
      status: "active",
      jobTitle: "工程师",
      lastLoginAt: 1730000000,
      ctime: 1729000000,
    });
  });

  it("status int 2 → 'disable'；缺失 / 未知值 → 'unknown'", () => {
    expect(
      mapEiamTenantMember({ id: 1, username: "a", status: 2 })?.status,
    ).toBe("disable");
    expect(mapEiamTenantMember({ id: 2, username: "b" })?.status).toBe(
      "unknown",
    );
    expect(
      mapEiamTenantMember({ id: 3, username: "c", status: 99 })?.status,
    ).toBe("unknown");
  });

  it("可选字段缺失兜底：nickname 空串、其余 undefined，不补假值", () => {
    const m = mapEiamTenantMember({ id: 5, username: "u" });
    expect(m).toMatchObject({ id: 5, username: "u", nickname: "", status: "unknown" });
    expect(m?.avatar).toBeUndefined();
    expect(m?.email).toBeUndefined();
    expect(m?.jobTitle).toBeUndefined();
    expect(m?.lastLoginAt).toBeUndefined();
    expect(m?.ctime).toBeUndefined();
  });

  it("缺 id（核心标识）→ null；非对象 → null", () => {
    expect(mapEiamTenantMember({ username: "noid" })).toBeNull();
    expect(mapEiamTenantMember({ id: 0, username: "zero" })).toBeNull();
    expect(mapEiamTenantMember(null)).toBeNull();
    expect(mapEiamTenantMember([1, 2])).toBeNull();
  });
});

describe("listTenantMembers", () => {
  it("请求：POST /api/iam/tenant/members + X-Active-Tenant-ID + {offset,limit,keyword}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => membersReply(), captured);

    const page = await listTenantMembers(42, {
      offset: 20,
      limit: 50,
      keyword: "张",
    });

    expect(captured[0]?.method).toBe("post");
    expect(captured[0]?.url).toBe("/api/iam/tenant/members");
    // 跨租户上下文：必须带目标租户 id（契约 §1.1）
    expect(headerValue(captured[0]!, "X-Active-Tenant-ID")).toBe("42");
    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      offset: 20,
      limit: 50,
      keyword: "张",
    });

    // 归一：{total, members} → Page<TenantMember>，缺 id 记录被过滤
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      status: "active",
      jobTitle: "工程师",
      lastLoginAt: 1730000000,
      ctime: 1729000000,
    });
    // avatar 空串 → undefined（视图渲染 '—'）
    expect(page.items[0]?.avatar).toBeUndefined();
    expect(page.items[1]).toMatchObject({ id: 43, status: "disable" });
    expect(page.items[1]?.nickname).toBe("");
  });

  it("total 缺省 → 按归一后 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: { members: [{ id: 1, username: "only", status: 1 }] },
      },
    }));
    const page = await listTenantMembers(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
  });

  it("空 / 缺失 members → 空 Page（不抛错）", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0 } },
    }));
    const page = await listTenantMembers(7, {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(page).toEqual({ total: 0, items: [] });
  });

  it("2xx + code!=0 → 抛 ApiError（业务码与 msg 原文透传）", async () => {
    adapterFor(() => ({
      body: {
        code: 403001,
        msg: "检测到跨租户越权操作，该请求已被安全拦截",
        data: null,
      },
    }));
    const err = await listTenantMembers(42, {
      offset: 0,
      limit: 20,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 403001,
      message: "检测到跨租户越权操作，该请求已被安全拦截",
    });
  });

  it("非 2xx 可解析信封 → ApiError 保留信封 code 与 msg 原文", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 500001, msg: "内部错误", data: null },
    }));
    const err = await listTenantMembers(42, {
      offset: 0,
      limit: 20,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 500001,
      httpStatus: 500,
      message: "内部错误",
    });
  });
});

describe("removeTenantMember", () => {
  it("请求：POST /api/iam/tenant/unassign + X-Active-Tenant-ID + {user_id}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "成功将用户从租户空间移除", data: null } }),
      captured,
    );

    await expect(removeTenantMember(42, 7)).resolves.toBeUndefined();

    expect(captured[0]?.method).toBe("post");
    expect(captured[0]?.url).toBe("/api/iam/tenant/unassign");
    expect(headerValue(captured[0]!, "X-Active-Tenant-ID")).toBe("42");
    expect(JSON.parse(String(captured[0]!.data))).toEqual({ user_id: 7 });
  });

  it("每次调用按入参租户注入 Header（不串租户）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }), captured);
    await removeTenantMember(7, 1);
    await removeTenantMember(8, 2);
    expect(headerValue(captured[0]!, "X-Active-Tenant-ID")).toBe("7");
    expect(headerValue(captured[1]!, "X-Active-Tenant-ID")).toBe("8");
  });

  it("被拒（4020910 移除自己）→ ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      body: {
        code: 4020910,
        msg: "禁止将当前登录账号从当前租户空间中移除",
        data: null,
      },
    }));
    const err = await removeTenantMember(42, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 4020910,
      message: "禁止将当前登录账号从当前租户空间中移除",
    });
  });

  it("被拒（4020909 移除 admin，非 2xx）→ msg 原文与 HTTP 状态保留", async () => {
    adapterFor(() => ({
      status: 500,
      body: {
        code: 4020909,
        msg: "禁止将系统初始超级管理员从系统根管理空间中移除",
        data: null,
      },
    }));
    const err = await removeTenantMember(42, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 4020909,
      httpStatus: 500,
      message: "禁止将系统初始超级管理员从系统根管理空间中移除",
    });
  });
});
