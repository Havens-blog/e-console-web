// @vitest-environment happy-dom
/**
 * roles.ts 角色继承三接口单测（feat-role-inheritance 契约 §2.1 / §3）。
 *
 * 锁定（全部 mock axios adapter，**不触真实网络、不创建真实角色、不改任何真实继承关系**）：
 * - listParentRoles：POST `/api/iam/role/parents`，载荷精确 `{role_code}`；响应的 `data` 是
 *   **数组**（非分页信封）`[{code, is_direct, is_immutable}]` → 归一 RoleInheritance[]
 *   （snake_case → camelCase；**响应只有 code，不含名称**）；
 * - 数组归一：非数组（null / 对象 / 字符串）→ []，不抛错；
 * - 缺 code（含空串 / 非对象脏项）过滤，合法项顺序保持；
 * - 布尔归一：仅 `true` 视为真（缺失 / 非布尔 → false，即「间接 + 可移除」保守默认）；
 * - addParentRole：POST `/api/iam/role/add_parent`，载荷精确 `{role_code, parent_role_code}`
 *   （不是 roleCode / code / id）；
 * - removeParentRole：POST `/api/iam/role/remove_parent`，载荷同上；
 * - 错误：2xx + code!=0 → ApiError（业务码与 msg 原文透传）；网络错 → ApiError(unavailable)。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  addParentRole,
  listParentRoles,
  removeParentRole,
} from "./roles";
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

describe("listParentRoles（/role/parents：数组非分页信封）", () => {
  it("POST /api/iam/role/parents，载荷精确 {role_code}，数组归一为 RoleInheritance[]", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: [
            { code: "admin", is_direct: true, is_immutable: false },
            { code: "root", is_direct: false, is_immutable: true },
          ],
        },
      }),
      captured,
    );

    const parents = await listParentRoles("ops");
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/role/parents");
    // 载荷键名精确：snake_case role_code（不是 roleCode / code / id）
    const body = sentBody(captured[0]!);
    expect(body).toEqual({ role_code: "ops" });
    expect(body).not.toHaveProperty("roleCode");
    expect(body).not.toHaveProperty("id");

    // 契约 §1：只返回 code，不含名称 —— 归一结果也不臆造 name 字段
    expect(parents).toEqual([
      { code: "admin", isDirect: true, isImmutable: false },
      { code: "root", isDirect: false, isImmutable: true },
    ]);
    expect(parents[0]).not.toHaveProperty("name");
  });

  it("无父角色 → []（不是分页信封）", async () => {
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: [] } }));
    expect(await listParentRoles("ops")).toEqual([]);
  });

  it("非数组 data（null / 对象 / 字符串）→ []，不抛错", async () => {
    adapterFor(() => ({ body: { code: 0, msg: "ok", data: null } }));
    expect(await listParentRoles("ops")).toEqual([]);

    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, items: [] } },
    }));
    expect(await listParentRoles("ops")).toEqual([]);

    adapterFor(() => ({ body: { code: 0, msg: "ok", data: "admin" } }));
    expect(await listParentRoles("ops")).toEqual([]);
  });

  it("缺 code / 空 code / 非对象脏项被过滤，合法项顺序保持", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: [
          { code: "a", is_direct: true, is_immutable: false },
          { code: "", is_direct: true, is_immutable: false },
          { is_direct: true, is_immutable: false },
          null,
          "b",
          { code: "b", is_direct: false, is_immutable: false },
        ],
      },
    }));
    const parents = await listParentRoles("ops");
    expect(parents.map((p) => p.code)).toEqual(["a", "b"]);
  });

  it("布尔归一：仅 true 视为真（缺失 / 非布尔 → false）", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: [
          { code: "a" },
          { code: "b", is_direct: "true", is_immutable: 1 },
          { code: "c", is_direct: true, is_immutable: true },
        ],
      },
    }));
    const parents = await listParentRoles("ops");
    expect(parents).toEqual([
      { code: "a", isDirect: false, isImmutable: false },
      { code: "b", isDirect: false, isImmutable: false },
      { code: "c", isDirect: true, isImmutable: true },
    ]);
  });

  it("被拒 → ApiError（业务码 + msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4010801, msg: "无权查看角色继承关系", data: null },
    }));
    const err = await listParentRoles("ops").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010801);
    expect((err as ApiError).message).toBe("无权查看角色继承关系");
  });

  it("网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await listParentRoles("ops").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("addParentRole（/role/add_parent）", () => {
  it("POST /api/iam/role/add_parent，载荷精确 {role_code, parent_role_code}（无 id / camelCase）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );

    await addParentRole("ops", "admin");
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/role/add_parent");
    const body = sentBody(captured[0]!);
    expect(body).toEqual({ role_code: "ops", parent_role_code: "admin" });
    // 键名精确：不接受 camelCase / 简写 / id
    expect(body).not.toHaveProperty("roleCode");
    expect(body).not.toHaveProperty("parentRoleCode");
    expect(body).not.toHaveProperty("role_codes");
    expect(body).not.toHaveProperty("id");
  });

  it("被拒（成环 / 重复）→ ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010802, msg: "添加父角色会形成环", data: null },
    }));
    const err = await addParentRole("ops", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010802);
    expect((err as ApiError).message).toBe("添加父角色会形成环");
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ECONNABORTED", message: "timeout" },
    }));
    const err = await addParentRole("ops", "admin").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("removeParentRole（/role/remove_parent）", () => {
  it("POST /api/iam/role/remove_parent，载荷精确 {role_code, parent_role_code}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );

    await removeParentRole("ops", "root");
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/role/remove_parent");
    expect(sentBody(captured[0]!)).toEqual({
      role_code: "ops",
      parent_role_code: "root",
    });
  });

  it("被拒（不可移除 / 未绑定）→ ApiError 原文透传", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010803, msg: "该父角色不可移除", data: null },
    }));
    const err = await removeParentRole("ops", "root").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010803);
    expect((err as ApiError).message).toBe("该父角色不可移除");
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await removeParentRole("ops", "root").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});
