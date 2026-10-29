// @vitest-environment happy-dom
/**
 * 角色关联用户组 api 层单测（feat-role-bound-groups 契约 §1 / §2.2 / §3）。
 *
 * 全部 mock axios adapter，**不触真实网络、不读写任何真实数据**（本区块纯只读）。
 *
 * 锁定：
 * - 路径/方法精确：`POST /api/iam/group/list/attached/role`；
 * - 载荷精确：`{role_code, offset, limit, keyword}` —— `role_code`（snake_case，非 roleCode/id），
 *   分页三字段按入参原样上行（不夹带 user_id / group_code 等其它域字段）；
 * - 归一：`{total, groups}` → `Page<TenantGroup>`（items 键，视图层不消费原生 `groups` 键），
 *   兼容裸数组；缺 id 脏项过滤、合法项保序；`total` 缺失按归一后 items 长度；
 * - 降级：非对象 / 缺键 / 非数组 → 空页（total 0、items []），**不抛**；
 * - 缺 `role_code`（空串）→ 空页且**不发请求**（不触发 eiam binding:"required" 400）；
 * - 错误：2xx 业务码 / 非 2xx 信封 / 网络失败 → 统一 ApiError（code + msg 原文 / kind 透传）。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import { listGroupsForRole } from "./groups";
import { eiamAxios } from "@/api/request/eiam";
import { ApiError, type Page, type TenantGroup } from "@/api/types";

const STATUS_TEXT: Partial<Record<number, string>> = {
  200: "OK",
  403: "Forbidden",
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

/** 成功信封 */
function ok(data: unknown): MockReply {
  return { body: { code: 0, msg: "ok", data } };
}

const QUERY = { offset: 0, limit: 100, keyword: "" };

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

describe("listGroupsForRole（/group/list/attached/role）", () => {
  it("POST 正确路径，载荷精确 {role_code, offset, limit, keyword}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, groups: [] }), captured);

    await listGroupsForRole("ops", QUERY);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/list/attached/role");
    expect(sentBody(captured[0]!)).toEqual({
      role_code: "ops",
      offset: 0,
      limit: 100,
      keyword: "",
    });
    // 键名精确：不接受 camelCase / 用户域字段
    expect(sentBody(captured[0]!)).not.toHaveProperty("roleCode");
    expect(sentBody(captured[0]!)).not.toHaveProperty("userId");
    expect(sentBody(captured[0]!)).not.toHaveProperty("user_id");
    expect(sentBody(captured[0]!)).not.toHaveProperty("group_code");
  });

  it("分页字段按入参原样上行（不吞 offset / limit / keyword）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, groups: [] }), captured);

    await listGroupsForRole("ops", { offset: 20, limit: 5, keyword: "运维" });

    expect(sentBody(captured[0]!)).toEqual({
      role_code: "ops",
      offset: 20,
      limit: 5,
      keyword: "运维",
    });
  });

  it("归一 {total, groups} → Page<TenantGroup>（items 键，原生键不外泄）", async () => {
    adapterFor(() =>
      ok({
        total: 2,
        groups: [
          { id: 5, name: "运维组", code: "ops", desc: "运维", ctime: 1700000000000 },
          { id: 6, name: "只读组", code: "viewer" },
        ],
      }),
    );

    const page = await listGroupsForRole("ops", QUERY);

    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    // 视图层只认 items：原生 groups 键不得成为返回形的键
    expect(page).not.toHaveProperty("groups");
    expect(page.items[0]).toEqual({
      id: 5,
      name: "运维组",
      code: "ops",
      desc: "运维",
      ctime: 1700000000000,
      utime: undefined,
    });
    // 描述缺失归空串（视图渲染 '—'），时间戳缺失 undefined
    expect(page.items[1]!.desc).toBe("");
    expect(page.items[1]!.ctime).toBeUndefined();
  });

  it("脏项过滤：缺 id / id 非法 / 非对象一律丢弃，合法项保序", async () => {
    adapterFor(() =>
      ok({
        total: 6,
        groups: [
          { id: 7, name: "A", code: "a" },
          { id: 0, name: "脏", code: "dirty" },
          { code: "no-id" },
          null,
          "x",
          { id: 9, name: "B", code: "b" },
        ],
      }),
    );

    const page = await listGroupsForRole("ops", QUERY);
    expect(page.items.map((g) => g.code)).toEqual(["a", "b"]);
    // total 取服务端原值（脏项过滤不回头改写分页总数）
    expect(page.total).toBe(6);
  });

  it("兼容裸数组响应（防御代理/旧版直出），total 按归一后长度", async () => {
    adapterFor(() => ok([{ id: 5, name: "运维组", code: "ops" }, null]));

    const page = await listGroupsForRole("ops", QUERY);
    expect(page.items.map((g) => g.code)).toEqual(["ops"]);
    expect(page.total).toBe(1);
  });

  it("total 缺失 / 非有限数 → 按归一后 items 长度", async () => {
    for (const total of [undefined, "3", null]) {
      adapterFor(() => ok({ total, groups: [{ id: 5, code: "ops" }] }));
      const page = await listGroupsForRole("ops", QUERY);
      expect(page.total).toBe(1);
    }
  });

  it("脏数据降级为空页（不抛）", async () => {
    for (const data of [null, {}, { groups: "x" }, { groups: {} }, 42, "x"]) {
      adapterFor(() => ok(data));
      await expect(listGroupsForRole("ops", QUERY)).resolves.toEqual({
        total: 0,
        items: [],
      } satisfies Page<TenantGroup>);
    }
  });

  it("缺 groups 键但 total 为有限数 → items 空、total 保留服务端原值（沿用既有归一口径）", async () => {
    adapterFor(() => ok({ total: 3 }));
    const page = await listGroupsForRole("ops", QUERY);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(3);
  });

  it("缺 role_code（空串）→ 空页且不发请求（不触 eiam binding:required 400）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 1, groups: [{ id: 5, code: "ops" }] }), captured);

    await expect(listGroupsForRole("", QUERY)).resolves.toEqual({
      total: 0,
      items: [],
    });
    expect(captured).toHaveLength(0);
  });

  it("2xx 业务码 → ApiError（业务码 + msg 原文透传）", async () => {
    adapterFor(() => ({
      body: { code: 4010802, msg: "无权查看角色关联分组", data: null },
    }));

    const err = await listGroupsForRole("ops", QUERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010802);
    expect((err as ApiError).message).toBe("无权查看角色关联分组");
  });

  it("非 2xx 信封（500 + 业务码）→ ApiError 保留 code 与 msg 原文", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010803, msg: "查询角色关联分组失败", data: null },
    }));

    const err = await listGroupsForRole("ops", QUERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010803);
    expect((err as ApiError).message).toBe("查询角色关联分组失败");
    expect((err as ApiError).httpStatus).toBe(500);
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ECONNABORTED", message: "timeout" },
    }));

    const err = await listGroupsForRole("ops", QUERY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});
