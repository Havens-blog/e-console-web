// @vitest-environment happy-dom
/**
 * `listPoliciesForGroup` api 层单测（feat-group-policies 契约 §1 / §2.1 / §3）。
 *
 * 全部 mock axios adapter，**不触真实网络、不读写任何真实数据**（本特性纯只读）。
 *
 * 锁定：
 * - 路径/方法精确：`POST /api/iam/policy/list/attached/group`；
 * - 载荷精确 `{group_code, offset, limit, keyword}` —— 键名必须是 snake_case `group_code`，
 *   且**不得夹带 `type`**（契约 §1：该字段为策略类型过滤，误传会静默过滤出空列表）；
 * - 归一：`{total, policies}` → `Page<PolicyWithMeta>`（单数 statement → 复数 statements、
 *   `assignment_count` → assignmentCount、缺 code 脏项过滤）；
 * - 空 `groupCode` → 返回空页且**零请求**（不发请求天然不会 400）；
 * - 脏数据降级为空页且**不抛**；裸数组响应兼容；
 * - 被拒 / 网络失败 → 统一 `ApiError`（kind + 业务码 + msg 原文透传）。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import { listPoliciesForGroup } from "./policies";
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

/** 成功信封 */
function ok(data: unknown): MockReply {
  return { body: { code: 0, msg: "ok", data } };
}

const QUERY = { offset: 0, limit: 100, keyword: "" };

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
});

describe("listPoliciesForGroup（/policy/list/attached/group）", () => {
  it("POST 精确路径，载荷 {group_code, offset, limit, keyword} 且不含 type", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ok({ total: 0, policies: [] }), captured);

    await listPoliciesForGroup("rd", { offset: 20, limit: 5, keyword: "读" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method?.toLowerCase()).toBe("post");
    expect(captured[0]!.url).toBe("/api/iam/policy/list/attached/group");
    expect(sentBody(captured[0]!)).toEqual({
      group_code: "rd",
      offset: 20,
      limit: 5,
      keyword: "读",
    });
    // 契约 §1：不传 type（策略类型过滤，本轮不筛选）
    expect(sentBody(captured[0]!)).not.toHaveProperty("type");
    // 键名精确：不是 group_id / groupCode
    expect(sentBody(captured[0]!)).not.toHaveProperty("group_id");
    expect(sentBody(captured[0]!)).not.toHaveProperty("groupCode");
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
            desc: "只读权限",
            assignment_count: 3,
            statement: [
              { effect: "Allow", action: ["read"], resource: ["*"] },
            ],
          },
        ],
      }),
    );

    const page = await listPoliciesForGroup("rd", QUERY);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const p = page.items[0]!;
    expect(p.code).toBe("p1");
    expect(p.name).toBe("策略1");
    expect(p.desc).toBe("只读权限");
    expect(p.assignmentCount).toBe(3);
    expect(p.statements).toEqual([
      { effect: "Allow", actions: ["read"], resources: ["*"] },
    ]);
  });

  it("空 groupCode → 返回空页且零请求（不抛）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => {
        throw new Error("空 code 不得发请求");
      },
      captured,
    );

    await expect(listPoliciesForGroup("", QUERY)).resolves.toEqual({
      total: 0,
      items: [],
    });
    expect(captured).toHaveLength(0);
  });

  it("缺 code 的策略被过滤；total 保留服务端值", async () => {
    adapterFor(() =>
      ok({
        total: 9,
        policies: [{ id: 2 }, null, { code: "p1", name: "策略1" }],
      }),
    );

    const page = await listPoliciesForGroup("rd", QUERY);

    expect(page.total).toBe(9);
    expect(page.items.map((p) => p.code)).toEqual(["p1"]);
  });

  it("脏数据降级为空页且不抛（非对象 / 字符串 / 数字 / 缺 policies 键）", async () => {
    for (const data of [null, "x", 3]) {
      adapterFor(() => ok(data));
      await expect(listPoliciesForGroup("rd", QUERY)).resolves.toEqual({
        total: 0,
        items: [],
      });
    }

    // 缺 policies 键但服务端 total 有效 → items 空、total 原值保留
    adapterFor(() => ok({ total: 1 }));
    await expect(listPoliciesForGroup("rd", QUERY)).resolves.toEqual({
      total: 1,
      items: [],
    });

    // policies 非数组 → 空 items
    adapterFor(() => ok({ total: 2, policies: "nope" }));
    await expect(listPoliciesForGroup("rd", QUERY)).resolves.toEqual({
      total: 2,
      items: [],
    });
  });

  it("兼容裸数组响应；total 缺省按 items 长度", async () => {
    adapterFor(() => ok([{ code: "p1", name: "策略1" }]));

    const page = await listPoliciesForGroup("rd", QUERY);

    expect(page.total).toBe(1);
    expect(page.items[0]!.code).toBe("p1");
  });

  it("被拒 → ApiError（业务码 + msg 原文 + kind）", async () => {
    adapterFor(() => ({
      status: 500,
      body: { code: 4010902, msg: "无权查看用户组策略", data: null },
    }));

    const err = await listPoliciesForGroup("rd", QUERY).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
    expect((err as ApiError).code).toBe(4010902);
    expect((err as ApiError).message).toBe("无权查看用户组策略");
  });

  it("网络失败 → ApiError(unavailable)", async () => {
    adapterFor(() => ({
      networkFailure: { code: "ECONNABORTED", message: "timeout" },
    }));

    const err = await listPoliciesForGroup("rd", QUERY).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("unavailable");
  });
});
