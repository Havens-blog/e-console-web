// @vitest-environment happy-dom
/**
 * groups.ts api 客户端单测（feat-group-management 契约 §2.1 / §3；
 * feat-group-members 契约 §2.1 / §3 追加组成员三接口）。
 *
 * 覆盖归一契约（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - mapEiamGroup：group 原生形 → 归一 TenantGroup；缺 id 返回 null；描述缺失补空串；
 *   ctime / utime 非有限数 → undefined（Unix 毫秒）；
 * - listGroups：`{total, groups}` → `Page<TenantGroup>`，过滤 null，total 缺省按 items 长度；
 * - createGroup：`POST /api/iam/group/create` 载荷 `{name, code, desc}`；
 * - updateGroup：`POST /api/iam/group/update` 载荷 `{id, name, desc}`，**不得夹带 code**；
 * - deleteGroup：`DELETE /api/iam/group/delete/:id`；
 * - listGroupMembers：`POST /api/iam/group/members`，载荷 `{group_code, offset, limit, keyword}`
 *   （keyword 服务端真支持，照常上行），`{total, members}` → `Page<GroupMember>`；
 * - assignGroupMembers / removeGroupMembers：载荷 `{group_code, usernames: string[]}`
 *   —— **username 数组，不是 id 数组**；
 * - 错误：2xx + code!=0 → ApiError（业务码透传）；非 2xx 信封 → ApiError；网络错 → unavailable。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  assignGroupMembers,
  createGroup,
  deleteGroup,
  listGroupMembers,
  listGroups,
  mapEiamGroup,
  mapEiamGroupMember,
  removeGroupMembers,
  updateGroup,
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

describe("mapEiamGroup（group 原生形 → 归一 TenantGroup）", () => {
  it("完整字段原样映射（desc 键即 eiam 出参键，不做 camelCase 猜测）", () => {
    const g = mapEiamGroup({
      id: 7,
      name: "研发组",
      code: "rd",
      desc: "研发团队",
      ctime: 1730000000000,
      utime: 1730000001000,
    });
    expect(g).toEqual({
      id: 7,
      name: "研发组",
      code: "rd",
      desc: "研发团队",
      ctime: 1730000000000,
      utime: 1730000001000,
    });
  });

  it("描述缺失 → 空串（视图渲染 '—'，不出现 undefined）", () => {
    const g = mapEiamGroup({ id: 8, name: "a", code: "a" });
    expect(g?.desc).toBe("");
  });

  it("缺 id / id 非正数 / 非数值 → null（调用方过滤）", () => {
    expect(mapEiamGroup({ name: "noid", code: "x" })).toBeNull();
    expect(mapEiamGroup({ id: 0, name: "zero", code: "x" })).toBeNull();
    expect(mapEiamGroup({ id: -3, name: "neg", code: "x" })).toBeNull();
    expect(mapEiamGroup({ id: "7", name: "str", code: "x" })).toBeNull();
  });

  it("非对象输入 → null", () => {
    expect(mapEiamGroup(null)).toBeNull();
    expect(mapEiamGroup("x")).toBeNull();
    expect(mapEiamGroup([1, 2])).toBeNull();
  });

  it("时间戳非有限数 → undefined（Unix 毫秒，缺失不补 0）", () => {
    const g = mapEiamGroup({
      id: 9,
      name: "a",
      code: "a",
      ctime: Number.NaN,
      utime: "1730000000000",
    });
    expect(g?.ctime).toBeUndefined();
    expect(g?.utime).toBeUndefined();
  });
});

describe("listGroups", () => {
  it("POST /api/iam/group/list，载荷 {offset, limit, keyword}；{total, groups} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 2,
            groups: [
              { id: 1, name: "研发组", code: "rd", desc: "", ctime: 1730000000000 },
              { id: 2, name: "运维组", code: "ops" },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listGroups({ offset: 20, limit: 20, keyword: "组" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/list");
    expect(sentBody(captured[0]!)).toEqual({
      offset: 20,
      limit: 20,
      keyword: "组",
    });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({ id: 1, name: "研发组", code: "rd" });
    expect(page.items[1]).toMatchObject({ id: 2, code: "ops", desc: "" });
  });

  it("过滤缺 id 的脏记录，total 缺省 → 按归一后 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: {
          groups: [
            { id: 1, name: "a", code: "a" },
            { name: "noid", code: "x" },
          ],
        },
      },
    }));
    const page = await listGroups({ offset: 0, limit: 20, keyword: "" });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("空 groups 数组 → 空 Page", async () => {
    adapterFor(() => ({
      body: { code: 0, msg: "ok", data: { total: 0, groups: [] } },
    }));
    const page = await listGroups({ offset: 0, limit: 20, keyword: "" });
    expect(page).toEqual({ total: 0, items: [] });
  });

  it("ListQuery.status 不进 group 请求体（契约 §1 请求体只有三键）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, groups: [] } } }),
      captured,
    );
    await listGroups({ offset: 0, limit: 20, keyword: "", status: 1 });
    expect(sentBody(captured[0]!)).not.toHaveProperty("status");
  });

  it("无跨租户 Header：不携带 X-Active-Tenant-ID（group 按会话租户隔离）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, groups: [] } } }),
      captured,
    );
    await listGroups({ offset: 0, limit: 20, keyword: "" });
    const headers = captured[0]!.headers as unknown as {
      get?: (k: string) => unknown;
    };
    const sentHeader = headers.get?.("X-Active-Tenant-ID");
    expect(sentHeader).toBeUndefined();
    expect(
      Object.keys((captured[0]!.headers ?? {}) as unknown as object).map((k) =>
        k.toLowerCase(),
      ),
    ).not.toContain("x-active-tenant-id");
  });
});

describe("createGroup", () => {
  it("POST /api/iam/group/create，载荷 {name, code, desc}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await createGroup({ name: "研发组", code: "rd", desc: "研发团队" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/create");
    expect(sentBody(captured[0]!)).toEqual({
      name: "研发组",
      code: "rd",
      desc: "研发团队",
    });
  });

  it("desc 省略 → 不发送该键（undefined 经 JSON 序列化丢弃）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await createGroup({ name: "运维组", code: "ops" });
    expect(sentBody(captured[0]!)).toEqual({ name: "运维组", code: "ops" });
  });
});

describe("updateGroup", () => {
  it("POST /api/iam/group/update，载荷 {id, name, desc}（无 code）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await updateGroup({ id: 7, name: "研发组（新）", desc: "改描述" });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/update");
    const body = sentBody(captured[0]!);
    expect(body).toEqual({ id: 7, name: "研发组（新）", desc: "改描述" });
    // 契约 §1：UpdateGroupReq 无 code 字段，api 层不得夹带
    expect(body).not.toHaveProperty("code");
  });
});

describe("deleteGroup", () => {
  it("DELETE /api/iam/group/delete/:id", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await deleteGroup(7);
    expect(captured[0]!.method?.toLowerCase()).toBe("delete");
    expect(captured[0]!.url).toBe("/api/iam/group/delete/7");
  });
});

describe("错误形态 → ApiError（经 unwrapEnvelope 单一出口）", () => {
  it("list 2xx + code!=0 → ApiError（业务码与 msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4011001, msg: "无权访问用户组", data: null },
    }));
    const err = await listGroups({ offset: 0, limit: 20, keyword: "" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4011001);
    expect((err as ApiError).message).toBe("无权访问用户组");
  });

  it("create 非 2xx 可解析信封 → ApiError 保留 code / msg（服务端拒绝原文可展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4011002, msg: "标识码已存在", data: null },
    }));
    const err = await createGroup({ name: "研发组", code: "rd" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4011002);
    expect((err as ApiError).message).toBe("标识码已存在");
  });

  it("update 网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await updateGroup({ id: 1, name: "x" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });

  it("delete 被拒（组内仍有成员）→ ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4011003, msg: "用户组仍有成员，无法删除", data: null },
    }));
    const err = await deleteGroup(7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4011003);
    expect((err as ApiError).message).toBe("用户组仍有成员，无法删除");
  });
});

// ---- 组成员（feat-group-members 契约 §1 / §2.1 / §3）----

describe("mapEiamGroupMember（组成员原生形 → 归一 GroupMember）", () => {
  it("完整字段原样映射（eiam members[] 即 {id, username, nickname, avatar, email, phone}）", () => {
    const m = mapEiamGroupMember({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      avatar: "https://cdn/a.png",
      email: "z@example.com",
      phone: "13800000000",
    });
    expect(m).toEqual({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      email: "z@example.com",
      phone: "13800000000",
    });
  });

  it("可选字段缺失 / 空串 → undefined（视图渲染 '—'，不出现空字符串）", () => {
    const m = mapEiamGroupMember({ id: 43, username: "lisi", nickname: "" });
    expect(m).toEqual({
      id: 43,
      username: "lisi",
      nickname: "",
      email: undefined,
      phone: undefined,
    });
    expect(mapEiamGroupMember({ id: 44, username: "w", email: "" })?.email).toBe(
      undefined,
    );
  });

  it("缺 id / id 为 0 / 非数值 → null（复用 mapEiamUser 的 id 校验，调用方过滤）", () => {
    expect(mapEiamGroupMember({ username: "noid" })).toBeNull();
    expect(mapEiamGroupMember({ id: 0, username: "zero" })).toBeNull();
    expect(mapEiamGroupMember({ id: "42", username: "str" })).toBeNull();
    expect(mapEiamGroupMember(null)).toBeNull();
    expect(mapEiamGroupMember([1, 2])).toBeNull();
  });
});

describe("listGroupMembers", () => {
  it("POST /api/iam/group/members，载荷 {group_code, offset, limit, keyword}；{total, members} → Page", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        body: {
          code: 0,
          msg: "ok",
          data: {
            total: 2,
            members: [
              { id: 42, username: "zhangsan", nickname: "张三", email: "z@example.com" },
              { id: 43, username: "lisi", nickname: "李四" },
            ],
          },
        },
      }),
      captured,
    );

    const page = await listGroupMembers("rd", {
      offset: 20,
      limit: 50,
      keyword: "张",
    });
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/members");
    // 契约 §1：成员列表服务端支持 keyword（与 group/list 不同），照常上行
    expect(sentBody(captured[0]!)).toEqual({
      group_code: "rd",
      offset: 20,
      limit: 50,
      keyword: "张",
    });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      id: 42,
      username: "zhangsan",
      nickname: "张三",
      email: "z@example.com",
    });
    expect(page.items[1]).toMatchObject({ id: 43, username: "lisi" });
  });

  it("过滤缺 id 的脏记录；total 缺省 → 按归一后 items 长度", async () => {
    adapterFor(() => ({
      body: {
        code: 0,
        msg: "ok",
        data: { members: [{ id: 1, username: "a" }, { username: "noid" }] },
      },
    }));
    const page = await listGroupMembers("rd", {
      offset: 0,
      limit: 20,
      keyword: "",
    });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });

  it("空 members 数组 → 空 Page；ListQuery.status 不进请求体", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, members: [] } } }),
      captured,
    );
    const page = await listGroupMembers("rd", {
      offset: 0,
      limit: 20,
      keyword: "",
      status: 1,
    });
    expect(page).toEqual({ total: 0, items: [] });
    expect(sentBody(captured[0]!)).not.toHaveProperty("status");
  });

  it("无跨租户 Header：不携带 X-Active-Tenant-ID（group 端点按会话租户隔离）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: { total: 0, members: [] } } }),
      captured,
    );
    await listGroupMembers("rd", { offset: 0, limit: 20, keyword: "" });
    expect(
      Object.keys((captured[0]!.headers ?? {}) as unknown as object).map((k) =>
        k.toLowerCase(),
      ),
    ).not.toContain("x-active-tenant-id");
  });

  it("被拒 → ApiError（业务码 + msg 原文透传）", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 4010803, msg: "无权查看组成员", data: null },
    }));
    const err = await listGroupMembers("rd", {
      offset: 0,
      limit: 20,
      keyword: "",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010803);
    expect((err as ApiError).message).toBe("无权查看组成员");
  });
});

describe("assignGroupMembers", () => {
  it("POST /api/iam/group/members/assign，载荷 {group_code, usernames}（username 数组，不是 id）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await assignGroupMembers("rd", ["zhangsan", "lisi"]);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/members/assign");
    const body = sentBody(captured[0]!);
    expect(body).toEqual({
      group_code: "rd",
      usernames: ["zhangsan", "lisi"],
    });
    // 关键：数组元素是字符串用户名，不是数字 id
    expect(Array.isArray(body.usernames)).toBe(true);
    expect((body.usernames as unknown[]).every((u) => typeof u === "string")).toBe(
      true,
    );
    expect(body).not.toHaveProperty("user_ids");
  });

  it("空数组也原样上行（服务端 binding:\"required\" 自行判定）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await assignGroupMembers("rd", []);
    expect(sentBody(captured[0]!)).toEqual({ group_code: "rd", usernames: [] });
  });

  it("被拒（重复加入 / 无权限）→ ApiError 原文透传（UI 必须原样展示）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010806, msg: "分配组成员失败", data: null },
    }));
    const err = await assignGroupMembers("rd", ["zhangsan"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010806);
    expect((err as ApiError).message).toBe("分配组成员失败");
  });

  it("网络失败 → ApiError(unavailable)，不泄漏原生 axios 错误", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "network down" },
    }));
    const err = await assignGroupMembers("rd", ["zhangsan"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});

describe("removeGroupMembers", () => {
  it("POST /api/iam/group/members/remove，载荷 {group_code, usernames}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ body: { code: 0, msg: "ok", data: null } }),
      captured,
    );
    await removeGroupMembers("rd", ["zhangsan"]);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/group/members/remove");
    expect(sentBody(captured[0]!)).toEqual({
      group_code: "rd",
      usernames: ["zhangsan"],
    });
  });

  it("被拒 → ApiError 原文透传（视图原样展示服务端 msg）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010807, msg: "移出组成员失败", data: null },
    }));
    const err = await removeGroupMembers("rd", ["zhangsan"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(4010807);
    expect((err as ApiError).message).toBe("移出组成员失败");
  });
});
