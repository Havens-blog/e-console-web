/**
 * 策略域 api 客户端（task 5.3，UF-10）—— 列表/详情/增删改。
 *
 * 端点证据等级（tech-design §Interfaces C 档 + parity-checklist §2.10/D-5）：
 * - POST /api/iam/policy/list {offset,limit,keyword} → {total, policies: PolicyVO[]}（C 档路径实存）。
 * - POST /api/iam/policy/create {name,code,desc,type,statement[]} → 新 id（C 档；type=2 CustomPolicy）。
 * - POST /api/iam/policy/update {name,code,desc,statement[]} → null（C 档；无 type 字段）。
 * - DELETE /api/iam/policy/delete/:code → null（C 档；按 code 删除，非 id）。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层；D-5 形状分歧）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - eiam 容器键单数 `statement` → 规范复数 `statements`（PolicyStatement[]）；
 * - eiam 成员键单数 `action`/`resource` → 规范复数 `actions`/`resources`；
 * - eiam `access_scope` 不入 v1 规范形（需要时 api 层扩展）；
 * - eiam `assignment_count` → PolicyWithMeta.assignmentCount（E11 删除被拒绑定角色数数据源）；
 * - Effect 词表 "Allow"/"Deny"（首字母大写，与 UF-10 一致；eiam domain/policy.go:27-31）；
 * - snake_case 原生键归一 camelCase。
 *
 * D-5 已结（tech-design 重点核查项）：eiam 原生即 Statement 数组（CreatePolicyReq.Statement []Statement），
 * tech-design 预置的「扁平单 effect ≡ 恰含一条 Statement 的数组」兼容归一无需触发。
 *
 * 策略 code：eiam 端点以 code 为键（detail/delete/:code），规范 Policy 类型保持设计最小字段集
 * {id,name,statements}（permission.ts 注释：code/assignment_count 承载随 api 客户端 5.3 扩展，不提前扩形）；
 * 本 api 层定义 PolicyWithMeta（Policy & {code, assignmentCount?}）承载操作键与 E11 计数，
 * store/视图统一消费 PolicyWithMeta，未经归一不越视图层。
 *
 * 删除被拒（E11）：deletePolicy 由 eiam 服务端拒绝（conflict kind，绑定角色数 > 0）；
 * 绑定角色数数据源 = PolicyVO.assignment_count（list 响应直出，无额外请求）；
 * 调用方据 catch 渲染 delete.blocked_policy 契约文案（{n} = assignmentCount）。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type {
  Envelope,
  ListQuery,
  Page,
  Policy,
  PolicyStatement,
} from "@/api/types";

// ---- eiam 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamStatementRaw {
  effect?: unknown;
  action?: unknown;
  resource?: unknown;
  condition?: unknown;
  access_scope?: unknown;
}

interface EiamPolicyRaw {
  id?: unknown;
  code?: unknown;
  name?: unknown;
  desc?: unknown;
  type?: unknown;
  assignment_count?: unknown;
  statement?: unknown;
}

interface EiamPolicyListResult {
  total?: number;
  policies?: unknown[];
}

/** 规范 Policy + 操作键 code + 描述 + E11 绑定计数（api 层承载，不扩 permission.ts 规范形） */
export interface PolicyWithMeta extends Policy {
  /** 策略 code（eiam 端点操作键：detail/delete/:code；create 后不可改） */
  code: string;
  /** 描述（eiam PolicyVO.desc；编辑 Dialog 回显，规范 Policy 最小字段集不含 desc） */
  desc?: string;
  /** 已绑定角色数（eiam PolicyVO.assignment_count；E11 删除被拒提示数据源） */
  assignmentCount?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0) return null;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string" || item === "") return null;
    out.push(item);
  }
  return out;
}

/**
 * eiam statement 原生形状（单数 action/resource + access_scope） → 规范 PolicyStatement
 * （复数 actions/resources；access_scope 丢弃）。Effect 须为 "Allow"|"Deny"（首字母大写），
 * 非法 effect / 空 actions / 空 resources → null（调用方过滤，不静默截断）。
 */
export function mapEiamStatement(raw: unknown): PolicyStatement | null {
  if (!isRecord(raw)) return null;
  const s = raw as EiamStatementRaw;
  const effect = s.effect;
  if (effect !== "Allow" && effect !== "Deny") return null;
  const actions = asStringArray(s.action);
  if (actions === null) return null;
  const resources = asStringArray(s.resource);
  if (resources === null) return null;
  const stmt: PolicyStatement = { effect, actions, resources };
  // condition 归一：eiam 为 []{key,operator,values}；非数组或缺省 → undefined
  if (Array.isArray(s.condition)) {
    const condition = s.condition.filter(isRecord).map((c) => ({
      key: typeof c.key === "string" ? (c.key as string) : "",
      operator: typeof c.operator === "string" ? (c.operator as string) : "",
      values: Array.isArray(c.values)
        ? (c.values.filter(
            (v): v is string => typeof v === "string",
          ) as string[])
        : [],
    }));
    if (condition.length > 0) {
      stmt.condition = condition;
    }
  }
  return stmt;
}

/**
 * eiam PolicyVO 原生形状 → 归一 PolicyWithMeta（snake_case → camelCase；单数 statement → 复数 statements）。
 * 缺 code（操作键）→ null（调用方降级过滤）。assignment_count 直出（E11 数据源）。
 */
export function mapEiamPolicy(raw: unknown): PolicyWithMeta | null {
  if (!isRecord(raw)) return null;
  const eiam = raw as EiamPolicyRaw;
  const code = asString(eiam.code);
  if (!code) return null;
  const statements = Array.isArray(eiam.statement)
    ? eiam.statement
        .map(mapEiamStatement)
        .filter((s): s is PolicyStatement => s !== null)
    : [];
  return {
    id: asNumber(eiam.id),
    code,
    name: asString(eiam.name) ?? code,
    desc: asString(eiam.desc),
    statements,
    assignmentCount: asNumber(eiam.assignment_count),
  };
}

/** 归一 eiam {total, policies} → Page<PolicyWithMeta>（过滤 null，total 缺省按 items 长度） */
function toPolicyPage(raw: unknown): Page<PolicyWithMeta> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamPolicyListResult;
  const policies = Array.isArray(result.policies) ? result.policies : [];
  const items = policies
    .map(mapEiamPolicy)
    .filter((p): p is PolicyWithMeta => p !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/** 规范 PolicyStatement → eiam 单数载荷 {effect, action, resource, condition?}（access_scope 不发） */
function toEiamStatement(s: PolicyStatement): {
  effect: string;
  action: string[];
  resource: string[];
  condition?: unknown;
} {
  const out: {
    effect: string;
    action: string[];
    resource: string[];
    condition?: unknown;
  } = {
    effect: s.effect,
    action: s.actions,
    resource: s.resources,
  };
  if (s.condition !== undefined && s.condition.length > 0) {
    out.condition = s.condition.map((c) => ({
      key: c.key,
      operator: c.operator,
      values: c.values,
    }));
  }
  return out;
}

// ---- 策略 CRUD ----

/**
 * 策略列表（POST /api/iam/policy/list，C 档路径实存）。
 * 载荷 {offset, limit, keyword}（type 不发，eiam 默认 0 与 roles.ts listBindablePolicies 同款口径）；
 * 响应归一为 Page<PolicyWithMeta>（含 assignmentCount，承载 E11 绑定角色数列与删除被拒提示）。
 */
export async function listPoliciesPage(
  q: ListQuery,
): Promise<Page<PolicyWithMeta>> {
  const data = await unwrapEnvelope<EiamPolicyListResult>(
    eiamAxios.post<Envelope<EiamPolicyListResult>>("/api/iam/policy/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toPolicyPage(data);
}

// ---- 用户权限来源：user → policies 只读反查（feat-user-permission-sources 契约 §1 / §2.1）----

/**
 * 归一 attached/user 响应 → `Page<PolicyWithMeta>`。
 *
 * eiam 出参为 `ListPolicyRes{total, policies[]}`（policy/handler.go:120-127）；
 * 另兼容**裸数组**。复用既有 `toPolicyPage`（`mapEiamPolicy` 归一 statement / assignment_count、
 * 缺 code 脏项过滤、total 缺省按 items 长度）；非对象 / 缺键 / 非数组 → `{total:0, items:[]}`，**不抛**。
 */
function toUserPolicyPage(raw: unknown): Page<PolicyWithMeta> {
  if (Array.isArray(raw)) return toPolicyPage({ policies: raw });
  return toPolicyPage(raw);
}

/**
 * 用户直接绑定的策略（POST /api/iam/policy/list/attached/user；权限 `iam:policy:view_user_policies`）。
 *
 * 载荷 `{user_id, offset, limit, keyword}`（eiam `ListUserPoliciesReq`，policy/vo.go:49-55）。
 * 注意 eiam 该 handler 对 `limit <= 0` 回落 10（policy/handler.go:103-106），故调用方必须显式传
 * limit（面板取 100），否则只会拿到 10 条。
 *
 * 归一为 `Page<PolicyWithMeta>`（**不是** eiam 原生 `{total, policies}`；statement 单数键已归一等），
 * 视图层只消费 `total / items`。
 */
export async function listPoliciesForUser(
  userId: number,
  q: ListQuery,
): Promise<Page<PolicyWithMeta>> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/policy/list/attached/user", {
      user_id: userId,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toUserPolicyPage(data);
}

// ---- 用户组权限来源：group → policies 只读反查（feat-group-policies 契约 §1 / §2.1）----

/**
 * 归一 attached/group 响应 → `Page<PolicyWithMeta>`。
 *
 * eiam 出参为 `ListPolicyRes{total, policies[]}`（policy/handler.go:120-127，与 attached/user
 * 同款 handler 形状），另兼容**裸数组**（契约 §1「响应形状以既有实现为准…必须在 api 层归一」）。
 * 复用既有 `toPolicyPage`（`mapEiamPolicy` 归一 statement 单数键 / assignment_count、缺 code
 * 脏项过滤、total 缺省按 items 长度）；非对象 / 缺键 / 非数组 → `{total:0, items:[]}`，**不抛**。
 */
function toGroupPolicyPage(raw: unknown): Page<PolicyWithMeta> {
  if (Array.isArray(raw)) return toPolicyPage({ policies: raw });
  return toPolicyPage(raw);
}

/**
 * 用户组**直接绑定**的策略（POST /api/iam/policy/list/attached/group；
 * 权限 `iam:policy:view_group_policies`，eiam policy/handler.go）。
 *
 * 载荷 `{group_code, offset, limit, keyword}`（eiam `ListGroupPoliciesReq`，policy/vo.go）。
 * 契约 §1 两条硬约束：
 * - 键名精确 **`group_code`**（snake_case；不是 group_id / groupCode）；
 * - **不传 `type`**（该字段是策略类型过滤，本轮不做筛选，传错会误过滤出空列表）。
 *
 * `groupCode` 空串 → 直接返回空页且**不发请求**（也避免 eiam 侧 `binding:"required"` 直接 400
 * 把可用区域变成错误态）。归一为 `Page<PolicyWithMeta>`，视图层只消费 `total / items`。
 *
 * 只读：本函数只读反查，组与策略的绑定 / 解绑属策略域，一律不在职责内。
 */
export async function listPoliciesForGroup(
  groupCode: string,
  q: ListQuery,
): Promise<Page<PolicyWithMeta>> {
  if (groupCode === "") return { total: 0, items: [] };
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>(
      "/api/iam/policy/list/attached/group",
      {
        group_code: groupCode,
        offset: q.offset,
        limit: q.limit,
        keyword: q.keyword,
      },
    ),
  );
  return toGroupPolicyPage(data);
}

/** 创建策略载荷（camelCase 规范形；api 层映射为 eiam 载荷） */
export interface CreatePolicyPayload {
  /** 策略名（1–64 字符，唯一，eiam 校验——冲突提示契约 validation.name_exists） */
  name: string;
  /** 策略 code（稳定标识，detail/delete 以此为键；创建后不可改；格式 ^[a-z][a-z0-9_-]{2,31}$） */
  code: string;
  /** 描述（可选） */
  desc?: string;
  /** 策略内容：Statement 数组（一条策略可同时含 Allow 与 Deny 声明） */
  statements: PolicyStatement[];
}

/**
 * 创建策略（POST /api/iam/policy/create，C 档）。
 * 载荷 eiam {name, code, desc, type, statement[]}（type=2 CustomPolicy；statement 成员单数键）。
 * eiam 成功响应不回传 id（eiam/internal/web/policy/handler.go:201 实核：
 * ginx.Result{Msg:"创建成功"} 无 Data 字段）—— 以信封 code==0 为成功口径（unwrapEnvelope<null>）。
 */
export async function createPolicy(
  payload: CreatePolicyPayload,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/create", {
      name: payload.name,
      code: payload.code,
      desc: payload.desc,
      type: 2, // domain.CustomPolicy —— 控制台建策略均为用户自定义类型
      statement: payload.statements.map(toEiamStatement),
    }),
  );
}

/** 更新策略载荷（code 原值只读回传；eiam update 无 type 字段） */
export interface UpdatePolicyPayload {
  name: string;
  /** 策略 code（创建后不可改；update 载荷回传原值） */
  code: string;
  desc?: string;
  statements: PolicyStatement[];
}

/** 更新策略（POST /api/iam/policy/update，C 档） */
export async function updatePolicy(
  payload: UpdatePolicyPayload,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/update", {
      name: payload.name,
      code: payload.code,
      desc: payload.desc,
      statement: payload.statements.map(toEiamStatement),
    }),
  );
}

/**
 * 删除策略（DELETE /api/iam/policy/delete/:code，C 档；按 code 删除，非 id）。
 * 依赖删除由 eiam 服务端拒绝（E11）：策略已绑定角色时被拒（conflict kind），
 * 调用方据 catch + list 响应 assignmentCount 渲染 delete.blocked_policy 契约文案。
 */
export async function deletePolicy(code: string): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(
      `/api/iam/policy/delete/${encodeURIComponent(code)}`,
    ),
  );
}

// ---- 前端 JSON Statement 语法 + 结构校验（AC-3 前端层）----

export type StatementsParseResult =
  { ok: true; statements: PolicyStatement[] } | { ok: false; error: string };

/**
 * 前端 JSON 语法 + 结构校验（AC-3 第一层）。
 * 解析用户在编辑 Dialog JSON 文本框输入的 Statement 数组，校验：
 * - JSON 语法可解析（失败 → 语法错误，阻止保存）；
 * - 顶层为数组（策略 = Statement 数组，D-5）；
 * - 每条 Statement：effect ∈ {"Allow","Deny"}（首字母大写）、actions 非空字符串数组、
 *   resources 非空字符串数组、condition 可选（为数组时每条 {key,operator,values[]}）；
 * - 任一失败 → 返回 error（视图层标红 statements 字段 + 阻止保存）。
 *
 * 通过后再发 eiam 服务端 schema 校验（AC-3 第二层，字段名/枚举/结构），任一失败标红对应字段。
 */
export function parseStatementsJson(text: string): StatementsParseResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, error: "Statement 不能为空" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return {
      ok: false,
      error: `JSON 语法错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Statement 必须为数组（[]）" };
  }
  if (parsed.length === 0) {
    return { ok: false, error: "Statement 不能为空数组" };
  }
  const statements: PolicyStatement[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!isRecord(item)) {
      return { ok: false, error: `第 ${i + 1} 条：必须为对象` };
    }
    const effect = item.effect;
    if (effect !== "Allow" && effect !== "Deny") {
      return {
        ok: false,
        error: `第 ${i + 1} 条：effect 必须为 "Allow" 或 "Deny"（首字母大写）`,
      };
    }
    const actions = asStringArray(item.actions);
    if (actions === null) {
      return {
        ok: false,
        error: `第 ${i + 1} 条：actions 必须为非空字符串数组`,
      };
    }
    const resources = asStringArray(item.resources);
    if (resources === null) {
      return {
        ok: false,
        error: `第 ${i + 1} 条：resources 必须为非空字符串数组`,
      };
    }
    const stmt: PolicyStatement = { effect, actions, resources };
    if (item.condition !== undefined && item.condition !== null) {
      if (!Array.isArray(item.condition)) {
        return {
          ok: false,
          error: `第 ${i + 1} 条：condition 必须为数组`,
        };
      }
      const condition = [];
      for (let j = 0; j < item.condition.length; j++) {
        const c = item.condition[j];
        if (!isRecord(c)) {
          return {
            ok: false,
            error: `第 ${i + 1} 条 condition[${j + 1}]：必须为对象`,
          };
        }
        if (typeof c.key !== "string" || c.key === "") {
          return {
            ok: false,
            error: `第 ${i + 1} 条 condition[${j + 1}]：key 必须为非空字符串`,
          };
        }
        if (typeof c.operator !== "string" || c.operator === "") {
          return {
            ok: false,
            error: `第 ${i + 1} 条 condition[${j + 1}]：operator 必须为非空字符串`,
          };
        }
        if (!Array.isArray(c.values) || c.values.length === 0) {
          return {
            ok: false,
            error: `第 ${i + 1} 条 condition[${j + 1}]：values 必须为非空字符串数组`,
          };
        }
        const values: string[] = [];
        for (const v of c.values) {
          if (typeof v !== "string" || v === "") {
            return {
              ok: false,
              error: `第 ${i + 1} 条 condition[${j + 1}]：values 必须为非空字符串数组`,
            };
          }
          values.push(v);
        }
        condition.push({ key: c.key, operator: c.operator, values });
      }
      stmt.condition = condition;
    }
    statements.push(stmt);
  }
  return { ok: true, statements };
}

/** 规范 PolicyStatement[] → JSON 文本（编辑 Dialog 回显，规范复数键） */
export function serializeStatementsJson(statements: PolicyStatement[]): string {
  return JSON.stringify(statements, null, 2);
}

// ---- 角色 ↔ 策略 绑定/解绑（feat-role-policies）----
//
// 契约依据（roles.ts 头注释已核验，勿另造形状）：
// - 绑定 = POST /api/iam/policy/batch-attach {subjects:[{type, code}], policy_codes}
//   注意主体键是 **type**（不是 sub_type），role 主体时 type="role"、code=角色 code。
// - 解绑 = POST /api/iam/policy/batch-detach {assignments:[{sub_type, sub_code, policy_code}]}
//   逐条扁平，避免笛卡尔积误删。
// - 已绑清单 = POST /api/iam/policy/list/attached/role {role_code, offset, limit, keyword}
//   **不得传 type**：eiam ListRolePoliciesReq.type 是 uint8，传字符串会触发绑定失败 → HTTP 400
//   （历史上出过"编辑角色 400"事故）。

/**
 * 角色已绑策略清单（POST /api/iam/policy/list/attached/role）。
 *
 * 载荷键名精确为 `role_code`（snake_case）；**不发送 `type`**（见上方事故说明）。
 * 归一为 `Page<PolicyWithMeta>`，视图层只消费 total / items。
 */
export async function listPoliciesForRole(
  roleCode: string,
  q: ListQuery,
): Promise<Page<PolicyWithMeta>> {
  // 空 code 直接返回空页且不发请求：避免打到一个必然 400 的请求
  if (!roleCode) return { total: 0, items: [] };

  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/policy/list/attached/role", {
      role_code: roleCode,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return Array.isArray(data) ? toPolicyPage({ policies: data }) : toPolicyPage(data);
}

/**
 * 为角色绑定策略（POST /api/iam/policy/batch-attach，权限 `iam:policy:batch_attach`）。
 *
 * 一次可绑多条：把 role 作为单个主体，policy_codes 批量下发。
 */
export async function attachPoliciesToRole(
  roleCode: string,
  policyCodes: string[],
): Promise<void> {
  if (!roleCode || policyCodes.length === 0) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-attach", {
      subjects: [{ type: "role", code: roleCode }],
      policy_codes: policyCodes,
    }),
  );
}

/**
 * 解绑角色的某条策略（POST /api/iam/policy/batch-detach，权限 `iam:policy:batch_detach`）。
 *
 * 为什么要用 batch-detach 而非单体 detach：单体 `policy/detach` 接收 AttachPolicyReq
 * {sub_type, sub_code, policy_code}，形状与 batch 不同；统一走 batch 可少维护一套载荷，
 * 且 assignments 逐条扁平、语义无歧义（不会误删笛卡尔积）。
 */
export async function detachPolicyFromRole(
  roleCode: string,
  policyCode: string,
): Promise<void> {
  if (!roleCode || !policyCode) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-detach", {
      assignments: [{ sub_type: "role", sub_code: roleCode, policy_code: policyCode }],
    }),
  );
}

// ---- 用户组 ↔ 策略 绑定/解绑（feat-group-policies-write）----
//
// 用户组策略弹窗此前**严格只读**，且文案写着"策略绑定请到策略页操作"——
// 而策略页当时根本没有绑定能力，属双重误导。本轮补齐用户组侧的写能力：
// 后端 batch-attach / batch-detach 本就支持 type=group，无需后端改动。

/**
 * 为用户组绑定策略（POST /api/iam/policy/batch-attach，权限 `iam:policy:batch_attach`）。
 *
 * 主体键是 **type**（不是 sub_type），group 主体时 type="group"、code=组 code。
 */
export async function attachPoliciesToGroup(
  groupCode: string,
  policyCodes: string[],
): Promise<void> {
  if (!groupCode || policyCodes.length === 0) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-attach", {
      subjects: [{ type: "group", code: groupCode }],
      policy_codes: policyCodes,
    }),
  );
}

/**
 * 解绑用户组的某条策略（POST /api/iam/policy/batch-detach，权限 `iam:policy:batch_detach`）。
 *
 * assignments 逐条扁平（sub_type / sub_code / policy_code），避免笛卡尔积误删。
 */
export async function detachPolicyFromGroup(
  groupCode: string,
  policyCode: string,
): Promise<void> {
  if (!groupCode || !policyCode) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-detach", {
      assignments: [{ sub_type: "group", sub_code: groupCode, policy_code: policyCode }],
    }),
  );
}

// ---- 用户 ↔ 策略 绑定/解绑（feat-user-policies-write）----
//
// 三类主体的策略授权至此齐备：角色（feat-role-policies）、用户组（feat-group-policies-write）、用户（本批）。
// 后端 batch-attach / batch-detach 均支持 type/sub_type=user，无需后端改动。
// 注意：**直接绑定**的策略才在这里增删；经角色/用户组继承来的策略属"权限来源"只读展示（UserPermissionSources）。

/**
 * 为用户绑定策略（POST /api/iam/policy/batch-attach，权限 `iam:policy:batch_attach`）。
 *
 * 主体键是 **type**（不是 sub_type）；user 主体时 type="user"、code=**用户名**。
 */
export async function attachPoliciesToUser(
  username: string,
  policyCodes: string[],
): Promise<void> {
  if (!username || policyCodes.length === 0) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-attach", {
      subjects: [{ type: "user", code: username }],
      policy_codes: policyCodes,
    }),
  );
}

/**
 * 解绑用户的某条直接策略（POST /api/iam/policy/batch-detach，权限 `iam:policy:detach`）。
 */
export async function detachPolicyFromUser(
  username: string,
  policyCode: string,
): Promise<void> {
  if (!username || !policyCode) return;

  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-detach", {
      assignments: [{ sub_type: "user", sub_code: username, policy_code: policyCode }],
    }),
  );
}
