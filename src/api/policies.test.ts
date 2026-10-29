// @vitest-environment happy-dom
/**
 * policies.ts api 客户端映射单测（task 5.3）。
 *
 * 覆盖归一契约（Hard Rule：eiam 原生形状不经归一不越视图层；D-5 形状分歧）：
 * - mapEiamStatement：单数 action/resource → 复数 actions/resources；access_scope 丢弃；
 *   effect 须 Allow/Deny；空 actions/resources → null；
 * - mapEiamPolicy：snake_case → camelCase；单数 statement → 复数 statements；
 *   assignment_count → assignmentCount；缺 code → null；
 * - listPoliciesPage：{total, policies} → Page<PolicyWithMeta>，过滤 null；
 * - createPolicy：载荷 {name, code, desc, type:2, statement[]}（单数成员键）→ void
 *   （eiam 成功不回传 id，handler.go:201 无 Data，信封 code==0 即成功）；
 * - updatePolicy：载荷 {name, code, desc, statement[]}（无 type）；
 * - deletePolicy：DELETE /policy/delete/:code（按 code 删除，非 id）；
 * - parseStatementsJson：前端 JSON 语法 + 结构校验（effect 枚举 / actions/resources 非空数组 /
 *   condition 可选数组），任一失败 → {ok:false, error}。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPolicy,
  attachPoliciesToRole,
  attachPoliciesToUser,
  detachPolicyFromUser,
  detachPolicyFromRole,
  listPoliciesForRole,
  deletePolicy,
  listPoliciesPage,
  mapEiamPolicy,
  mapEiamStatement,
  parseStatementsJson,
  serializeStatementsJson,
  updatePolicy,
} from "./policies";
import { eiamAxios } from "@/api/request/eiam";

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

describe("mapEiamStatement（单数 action/resource → 复数 actions/resources；access_scope 丢弃）", () => {
  it("完整归一：effect/action/resource/condition → PolicyStatement（复数键）", () => {
    const s = mapEiamStatement({
      effect: "Allow",
      action: ["cam:cert:Get", "cam:cert:List"],
      resource: ["cert/*"],
      condition: [
        {
          key: "aws:PrincipalOrgID",
          operator: "StringEquals",
          values: ["o-1"],
        },
      ],
      access_scope: { include: ["*"] },
    });
    expect(s).toEqual({
      effect: "Allow",
      actions: ["cam:cert:Get", "cam:cert:List"],
      resources: ["cert/*"],
      condition: [
        {
          key: "aws:PrincipalOrgID",
          operator: "StringEquals",
          values: ["o-1"],
        },
      ],
    });
  });

  it("condition 缺省 → 不带 condition 字段", () => {
    const s = mapEiamStatement({
      effect: "Deny",
      action: ["cam:cert:Delete"],
      resource: ["cert/prod-*"],
    });
    expect(s?.condition).toBeUndefined();
  });

  it("effect 非 Allow/Deny → null（不静默截断）", () => {
    expect(
      mapEiamStatement({ effect: "allow", action: ["a"], resource: ["r"] }),
    ).toBeNull();
    expect(
      mapEiamStatement({ effect: "Permit", action: ["a"], resource: ["r"] }),
    ).toBeNull();
  });

  it("actions 空 / 非数组 → null", () => {
    expect(
      mapEiamStatement({ effect: "Allow", action: [], resource: ["r"] }),
    ).toBeNull();
    expect(
      mapEiamStatement({ effect: "Allow", action: "x", resource: ["r"] }),
    ).toBeNull();
  });

  it("resources 空 / 非数组 → null", () => {
    expect(
      mapEiamStatement({ effect: "Allow", action: ["a"], resource: [] }),
    ).toBeNull();
  });
});

describe("mapEiamPolicy（snake_case → camelCase；单数 statement → 复数 statements）", () => {
  it("完整归一：含 assignment_count；过滤非法 statement", () => {
    const p = mapEiamPolicy({
      id: 1,
      code: "cert-readonly",
      name: "证书只读",
      desc: "仅可查看证书",
      type: 2,
      assignment_count: 3,
      statement: [
        { effect: "Allow", action: ["cam:cert:Get"], resource: ["cert/*"] },
        { effect: "bad", action: ["x"], resource: ["y"] },
        {
          effect: "Deny",
          action: ["cam:cert:Delete"],
          resource: ["cert/prod-*"],
        },
      ],
    });
    expect(p).toMatchObject({
      id: 1,
      code: "cert-readonly",
      name: "证书只读",
      assignmentCount: 3,
    });
    expect(p?.statements).toHaveLength(2);
    expect(p?.statements[0]).toMatchObject({
      effect: "Allow",
      actions: ["cam:cert:Get"],
      resources: ["cert/*"],
    });
  });

  it("缺 code（操作键）→ null", () => {
    expect(mapEiamPolicy({ id: 1, name: "x" })).toBeNull();
    expect(mapEiamPolicy({ id: 1, code: "" })).toBeNull();
  });

  it("缺 name → 回退 code", () => {
    const p = mapEiamPolicy({ id: 2, code: "p2", statement: [] });
    expect(p?.name).toBe("p2");
  });

  it("statement 非数组 → 空数组（不报错）", () => {
    const p = mapEiamPolicy({ id: 3, code: "p3", statement: "nope" });
    expect(p?.statements).toEqual([]);
  });
});

describe("listPoliciesPage（C 档：{total, policies} → Page<PolicyWithMeta>）", () => {
  it("归一分页 + 过滤 null（缺 code）", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        status: 200,
        body: {
          code: 0,
          msg: "",
          data: {
            total: 2,
            policies: [
              {
                id: 1,
                code: "p1",
                name: "策略1",
                statement: [
                  { effect: "Allow", action: ["a"], resource: ["r"] },
                ],
                assignment_count: 2,
              },
              { id: 9, name: "无code过滤" },
              {
                id: 2,
                code: "p2",
                name: "策略2",
                statement: [
                  { effect: "Deny", action: ["d"], resource: ["rr"] },
                ],
                assignment_count: 0,
              },
            ],
          },
        },
      }),
      capture,
    );
    const page = await listPoliciesPage({ offset: 0, limit: 20, keyword: "" });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.code).toBe("p1");
    expect(page.items[0]?.assignmentCount).toBe(2);
    expect(page.items[1]?.code).toBe("p2");
    const body = JSON.parse(String(capture[0]?.data));
    expect(body).toEqual({ offset: 0, limit: 20, keyword: "" });
  });

  it("空响应 → total 0 / items []", async () => {
    adapterFor(() => ({
      status: 200,
      body: { code: 0, msg: "", data: { total: 0, policies: [] } },
    }));
    const page = await listPoliciesPage({ offset: 0, limit: 20, keyword: "" });
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });
});

describe("createPolicy（C 档：type=2 CustomPolicy + statement 单数成员键）", () => {
  it("载荷映射 {name,code,desc,type:2,statement[]}；成功不回传 id（handler.go:201 无 Data）→ void", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({
        status: 200,
        body: { code: 0, msg: "创建成功", data: null },
      }),
      capture,
    );
    const result = await createPolicy({
      name: "证书只读",
      code: "cert-readonly",
      desc: "描述",
      statements: [
        {
          effect: "Allow",
          actions: ["cam:cert:Get", "cam:cert:List"],
          resources: ["cert/*"],
        },
      ],
    });
    expect(result).toBeUndefined();
    const body = JSON.parse(String(capture[0]?.data));
    expect(body.name).toBe("证书只读");
    expect(body.code).toBe("cert-readonly");
    expect(body.desc).toBe("描述");
    expect(body.type).toBe(2);
    expect(body.statement).toEqual([
      {
        effect: "Allow",
        action: ["cam:cert:Get", "cam:cert:List"],
        resource: ["cert/*"],
      },
    ]);
    // access_scope 不发
    expect(body.statement[0].access_scope).toBeUndefined();
  });

  it("desc 缺省 → undefined", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: 1 } }),
      capture,
    );
    await createPolicy({
      name: "x",
      code: "y",
      statements: [{ effect: "Deny", actions: ["a"], resources: ["r"] }],
    });
    const body = JSON.parse(String(capture[0]?.data));
    expect(body.desc).toBeUndefined();
  });

  it("condition 映射为单数键（condition 数组成员 key/operator/values）", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: 1 } }),
      capture,
    );
    await createPolicy({
      name: "x",
      code: "y",
      statements: [
        {
          effect: "Allow",
          actions: ["a"],
          resources: ["r"],
          condition: [
            { key: "k", operator: "StringEquals", values: ["v1", "v2"] },
          ],
        },
      ],
    });
    const body = JSON.parse(String(capture[0]?.data));
    expect(body.statement[0].condition).toEqual([
      { key: "k", operator: "StringEquals", values: ["v1", "v2"] },
    ]);
  });
});

describe("updatePolicy（C 档：无 type 字段）", () => {
  it("载荷 {name,code,desc,statement[]}（不含 type）", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: null } }),
      capture,
    );
    await updatePolicy({
      name: "新名",
      code: "cert-readonly",
      desc: "新描述",
      statements: [{ effect: "Deny", actions: ["d"], resources: ["rr"] }],
    });
    const body = JSON.parse(String(capture[0]?.data));
    expect(body).toEqual({
      name: "新名",
      code: "cert-readonly",
      desc: "新描述",
      statement: [{ effect: "Deny", action: ["d"], resource: ["rr"] }],
    });
    expect(body.type).toBeUndefined();
  });
});

describe("deletePolicy（C 档：DELETE /policy/delete/:code，按 code 删除）", () => {
  it("按 code 删除（非 id）；code 编码", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: null } }),
      capture,
    );
    await deletePolicy("cert-readonly");
    expect(capture[0]?.url).toBe("/api/iam/policy/delete/cert-readonly");
    expect(capture[0]?.method).toBe("delete");
  });

  it("特殊字符 code 编码", async () => {
    const capture: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: null } }),
      capture,
    );
    await deletePolicy("a b/c");
    expect(capture[0]?.url).toBe("/api/iam/policy/delete/a%20b%2Fc");
  });
});

describe("parseStatementsJson（前端 JSON 语法 + 结构校验，AC-3 第一层）", () => {
  it("合法 Statement 数组 → ok + statements（复数键）", () => {
    const r = parseStatementsJson(
      JSON.stringify([
        { effect: "Allow", actions: ["cam:cert:Get"], resources: ["cert/*"] },
        {
          effect: "Deny",
          actions: ["cam:cert:Delete"],
          resources: ["cert/prod-*"],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statements).toHaveLength(2);
      expect(r.statements[0]?.effect).toBe("Allow");
      expect(r.statements[1]?.effect).toBe("Deny");
    }
  });

  it("合法带 condition → ok", () => {
    const r = parseStatementsJson(
      JSON.stringify([
        {
          effect: "Allow",
          actions: ["a"],
          resources: ["r"],
          condition: [{ key: "k", operator: "StringEquals", values: ["v1"] }],
        },
      ]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statements[0]?.condition?.[0]?.key).toBe("k");
    }
  });

  it("空文本 → 失败", () => {
    const r = parseStatementsJson("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不能为空");
  });

  it("JSON 语法错误 → 失败（标红 + 阻止保存）", () => {
    const r = parseStatementsJson("{ not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("JSON 语法错误");
  });

  it("顶层非数组 → 失败", () => {
    const r = parseStatementsJson(JSON.stringify({ effect: "Allow" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("数组");
  });

  it("空数组 → 失败", () => {
    const r = parseStatementsJson("[]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("空数组");
  });

  it("effect 非 Allow/Deny → 失败（逐条定位）", () => {
    const r = parseStatementsJson(
      JSON.stringify([{ effect: "allow", actions: ["a"], resources: ["r"] }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("第 1 条");
  });

  it("actions 空数组 → 失败", () => {
    const r = parseStatementsJson(
      JSON.stringify([{ effect: "Allow", actions: [], resources: ["r"] }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("actions");
  });

  it("resources 非数组 → 失败", () => {
    const r = parseStatementsJson(
      JSON.stringify([{ effect: "Allow", actions: ["a"], resources: "r" }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("resources");
  });

  it("condition 非数组 → 失败", () => {
    const r = parseStatementsJson(
      JSON.stringify([
        {
          effect: "Allow",
          actions: ["a"],
          resources: ["r"],
          condition: "nope",
        },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("condition");
  });

  it("condition 成员缺 key → 失败", () => {
    const r = parseStatementsJson(
      JSON.stringify([
        {
          effect: "Allow",
          actions: ["a"],
          resources: ["r"],
          condition: [{ operator: "eq", values: ["v"] }],
        },
      ]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("key");
  });
});

describe("serializeStatementsJson（编辑 Dialog 回显，复数键）", () => {
  it("规范 PolicyStatement[] → JSON 文本（复数键 actions/resources）", () => {
    const text = serializeStatementsJson([
      { effect: "Allow", actions: ["a"], resources: ["r"] },
    ]);
    const parsed = JSON.parse(text);
    expect(parsed[0].actions).toEqual(["a"]);
    expect(parsed[0].resources).toEqual(["r"]);
    expect(parsed[0].effect).toBe("Allow");
  });
});

describe("角色 ↔ 策略 绑定/解绑（feat-role-policies）", () => {
  it("listPoliciesForRole：载荷 {role_code, offset, limit, keyword}；**不含 type**", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(
      () => ({ status: 200, body: { code: 0, msg: "", data: { total: 1, policies: [{ code: "p1", name: "策略一", type: 2, statement: [] }] } } }),
      captured,
    );

    const page = await listPoliciesForRole("admin", { offset: 0, limit: 100, keyword: "" });

    const sent = JSON.parse(String(captured[0]!.data));
    expect(sent).toEqual({ role_code: "admin", offset: 0, limit: 100, keyword: "" });
    // eiam ListRolePoliciesReq.type 是 uint8，传字符串会 400（历史"编辑角色 400"事故）
    expect(sent).not.toHaveProperty("type");
    expect(captured[0]!.url).toBe("/api/iam/policy/list/attached/role");
    expect(page.total).toBe(1);
    expect(page.items[0]!.code).toBe("p1");
  });

  it("listPoliciesForRole：roleCode 为空时**不发请求**，直接返回空页", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, data: { total: 0, policies: [] } } }), captured);
    const page = await listPoliciesForRole("", { offset: 0, limit: 100, keyword: "" });
    expect(page).toEqual({ total: 0, items: [] });
    expect(captured).toHaveLength(0);
  });

  it("listPoliciesForRole：裸数组响应也归一为 Page", async () => {
    adapterFor(
      () => ({ status: 200, body: { code: 0, data: [{ code: "p2", name: "策略二", type: 2, statement: [] }] } }),
      [],
    );
    const page = await listPoliciesForRole("rd", { offset: 0, limit: 100, keyword: "" });
    expect(page.items.map((i) => i.code)).toEqual(["p2"]);
  });

  it("attachPoliciesToRole：载荷 {subjects:[{type:'role',code}], policy_codes}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, msg: "绑定成功", data: null } }), captured);

    await attachPoliciesToRole("admin", ["p1", "p2"]);

    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      subjects: [{ type: "role", code: "admin" }],
      policy_codes: ["p1", "p2"],
    });
    expect(captured[0]!.url).toBe("/api/iam/policy/batch-attach");
  });

  it("attachPoliciesToRole：空角色码或空策略列表时**不发请求**", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, data: null } }), captured);
    await attachPoliciesToRole("", ["p1"]);
    await attachPoliciesToRole("admin", []);
    expect(captured).toHaveLength(0);
  });

  it("detachPolicyFromRole：载荷 {assignments:[{sub_type:'role',sub_code,policy_code}]}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, msg: "解绑成功", data: null } }), captured);

    await detachPolicyFromRole("admin", "p1");

    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      assignments: [{ sub_type: "role", sub_code: "admin", policy_code: "p1" }],
    });
    expect(captured[0]!.url).toBe("/api/iam/policy/batch-detach");
  });

  it("detachPolicyFromRole：服务端拒绝时抛出业务原文", async () => {
    adapterFor(() => ({ status: 200, body: { code: 4050016, msg: "策略正在使用中，无法删除", data: null } }), []);
    await expect(detachPolicyFromRole("admin", "p1")).rejects.toThrow(/策略正在使用中/);
  });
});

describe("用户 ↔ 策略 绑定/解绑（feat-user-policies-write）", () => {
  it("attachPoliciesToUser：subject 的 code 是**用户名**（不是 user_id）", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, msg: "绑定成功", data: { total: 1, inserted: 1, ignored: 0 } } }), captured);

    await attachPoliciesToUser("alice", ["p1"]);

    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      subjects: [{ type: "user", code: "alice" }],
      policy_codes: ["p1"],
    });
    expect(captured[0]!.url).toBe("/api/iam/policy/batch-attach");
  });

  it("attachPoliciesToUser：空用户名或空策略列表时**不发请求**", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, data: {} } }), captured);
    await attachPoliciesToUser("", ["p1"]);
    await attachPoliciesToUser("alice", []);
    expect(captured).toHaveLength(0);
  });

  it("detachPolicyFromUser：载荷 {assignments:[{sub_type:'user',sub_code,policy_code}]}", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    adapterFor(() => ({ status: 200, body: { code: 0, msg: "解绑成功", data: null } }), captured);

    await detachPolicyFromUser("alice", "p1");

    expect(JSON.parse(String(captured[0]!.data))).toEqual({
      assignments: [{ sub_type: "user", sub_code: "alice", policy_code: "p1" }],
    });
    expect(captured[0]!.url).toBe("/api/iam/policy/batch-detach");
  });
});
