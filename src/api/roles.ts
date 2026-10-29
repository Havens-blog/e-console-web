/**
 * 角色域 api 客户端（task 5.1，UF-8）—— 列表/详情/增删改 + 策略/用户绑定。
 *
 * 端点证据等级（tech-design §Interfaces + parity-checklist §2.8/D-3）：
 * - A 档（实核）：role/list（{total, roles}，字段 id/code/name/desc——desc 非 description）、
 *   role/batch_assign|batch_unassign（{usernames, role_codes}，以 code 为准）。
 * - C 档（路径实存、形状待核验）：role/create {name, code, desc}、role/update {id, name, code, desc}、
 *   role/delete/:id、role/detail/:code（按 code 查询，非 id）。
 * - C 档形状分歧 D-3（路径改判 + 形状实核，eiam policy/vo.go）：
 *   角色↔策略绑定经 **policy 侧**承载——
 *   绑定 = POST /api/iam/policy/batch-attach {subjects:[{type, code}], policy_codes}（SubjectItem：
 *   eiam policy/vo.go:84-89，主体键为 **type** 非 sub_type；主体可 user/role/group 混合，
 *   角色为主体时 type=role）；
 *   解绑 = POST /api/iam/policy/batch-detach {assignments:[{sub_type, sub_code, policy_code}]}
 *   （Assignment 显式扁平逐条，eiam policy/vo.go:133-144；避免笛卡尔积误删）；
 *   另有单体 policy/detach。
 *   角色已绑策略清单 = POST /api/iam/policy/list/attached/role {role_code, offset, limit, keyword}
 *   （ListRolePoliciesReq type 为 **uint8**（policy/vo.go:62），0=不过滤全类型
 *   （repository/dao/policy.go:246 policyType != 0 才过滤）——**不得传字符串 "role"**：
 *   字符串入 uint8 触发 gin JSON 绑定失败 → HTTP 400，即「编辑角色 400」事故）。
 * - 角色已绑用户清单 = POST /api/iam/user/list/attached/role {role_code, ...}（A 档路径实存，
 *   反向承接 C 档推定的 role/attached/users；已在 users.ts 实现为 listUsersByRole，本域复用）。
 * - 角色继承 = role/parents | role/add_parent | role/remove_parent（后端已存在，eiam
 *   internal/web/role/handler.go:79-88 实核）。`/parents` 的 data 是**数组**（非分页信封）
 *   `[{code, is_direct, is_immutable}]`：**只给 code 不含名称**，名称须由视图层用角色列表本地映射。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 {total, roles} → Page<Role>.items；
 * - snake_case 原生键归一 camelCase；
 * - Role.desc 字段名对齐 A 档实盘（非 description）。
 *
 * G-6 语义映射（parity §G-6 + D-3/D-4）：角色↔策略绑定落点在 policy 侧（policy/batch-attach|
 * batch-detach），角色↔用户绑定落点在 role 侧（role/batch_assign|batch_unassign）。本域两类绑定
 * 函数均按实核路径调用，载荷对齐 A 档 batch_assign 惯例（role_codes / policy_codes）。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type { Envelope, ListQuery, Page, Role } from "@/api/types";

// ---- eiam 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamRoleRaw {
  id?: number;
  code?: string;
  name?: string;
  desc?: string;
}

interface EiamRoleListResult {
  total?: number;
  roles?: unknown[];
}

/** 可绑定策略引用（policy/list 返回子集；policy 以 code 为键，引用形 {code, name}） */
export interface PolicyRef {
  code: string;
  name: string;
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

/**
 * eiam role 原生形状 → 归一 Role（snake_case → camelCase）。
 * role/list 与 role/detail 均返回 {id, code, name, desc}；policies/users 不在 list/detail 直出，
 * 由 api 层经 policy/list/attached/role 与 user/list/attached/role 回填（parity D-3）。
 * 缺 id（核心标识）返回 null，由调用方降级过滤。
 */
export function mapEiamRole(raw: unknown): Role | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const eiam = raw as EiamRoleRaw;
  const code = asString(eiam.code) ?? "";
  const name = asString(eiam.name) ?? code;
  return {
    id,
    code,
    name,
    desc: asString(eiam.desc) ?? "",
    tenantId: 0, // role/list/detail 不直出 tenant_id；所属租户由当前上下文承载（list 页展示）
    policies: [],
    users: [],
  };
}

/** 归一 eiam {total, roles} → Page<Role>（过滤 null，total 缺省按 items 长度） */
function toRolePage(raw: unknown): Page<Role> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamRoleListResult;
  const roles = Array.isArray(result.roles) ? result.roles : [];
  const items = roles.map(mapEiamRole).filter((r): r is Role => r !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/** 归一 policy/list/attached/role 响应 → PolicyRef[]（过滤缺 code 的项） */
function toPolicyRefs(raw: unknown): PolicyRef[] {
  if (!isRecord(raw)) return [];
  const result = raw as { total?: number; policies?: unknown[] };
  const policies = Array.isArray(result.policies) ? result.policies : [];
  const refs: PolicyRef[] = [];
  for (const p of policies) {
    if (!isRecord(p)) continue;
    const code = asString(p.code);
    if (!code) continue;
    refs.push({ code, name: asString(p.name) ?? code });
  }
  return refs;
}

// ---- 角色 CRUD ----

/**
 * 角色列表（POST /api/iam/role/list，A 档实核）。
 * 载荷 {offset, limit, keyword}；响应归一为 Page<Role>（policies/users 不直出，留空待 enrichment）。
 */
export async function listRolesPage(q: ListQuery): Promise<Page<Role>> {
  const data = await unwrapEnvelope<EiamRoleListResult>(
    eiamAxios.post<Envelope<EiamRoleListResult>>("/api/iam/role/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toRolePage(data);
}

/**
 * 角色详情（GET /api/iam/role/detail/:code，C 档路径实存、形状待核验）。
 * 按 code 查询（非 id）；响应归一为 Role（policies/users 留空待 enrichment）。
 */
export async function getRoleDetail(code: string): Promise<Role | null> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>(`/api/iam/role/detail/${encodeURIComponent(code)}`),
  );
  return mapEiamRole(data);
}

/** 创建角色载荷（camelCase 规范形；api 层映射为 eiam snake_case 载荷） */
export interface CreateRolePayload {
  /** 角色名（1–64 字符，租户内唯一，eiam 校验） */
  name: string;
  /** 角色 code（稳定标识，batch_assign/policy 绑定以此为键；创建后不可改） */
  code: string;
  /** 描述（可选） */
  desc?: string;
}

/**
 * 创建角色（POST /api/iam/role/create，C 档路径实存、形状待核验）。
 * 载荷 eiam {name, code, desc}（parity §2.8 实核 vo.go:5-9）。
 * @returns 新角色 id
 */
export async function createRole(payload: CreateRolePayload): Promise<number> {
  const id = await unwrapEnvelope<number>(
    eiamAxios.post<Envelope<number>>("/api/iam/role/create", {
      name: payload.name,
      code: payload.code,
      desc: payload.desc,
    }),
  );
  return id;
}

/** 更新角色载荷（id + name + code + desc；code 为原值只读回传，eiam update 载荷含 code） */
export interface UpdateRolePayload {
  id: number;
  name: string;
  /** 角色 code（创建后不可改；update 载荷回传原值） */
  code: string;
  desc?: string;
}

/** 更新角色（POST /api/iam/role/update，C 档路径实存、形状待核验） */
export async function updateRole(payload: UpdateRolePayload): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/update", {
      id: payload.id,
      name: payload.name,
      code: payload.code,
      desc: payload.desc,
    }),
  );
}

/**
 * 删除角色（DELETE /api/iam/role/delete/:id，C 档路径实存、形状待核验）。
 * 依赖删除由 eiam 服务端拒绝（E11）：角色已绑定用户时被拒，调用方据 conflict kind 渲染阻断弹窗
 * （文案契约 delete.blocked_role：无法删除：该角色已绑定 {n} 个用户）。
 */
export async function deleteRole(id: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(`/api/iam/role/delete/${id}`),
  );
}

/**
 * 批量删除角色（POST /api/iam/role/batch_delete，feat-role-batch-delete 契约 §1 / §2.1）。
 *
 * 载荷键名精确为 **`ids`**（数字数组）——**不是** `role_ids` / `codes`：错键会被 eiam 静默丢弃，
 * 表现为「点了批量删除但角色还在」。空数组照样上行（不在本地臆造拦截，由服务端判定）。
 *
 * 返回 void：该端点不回传逐条结果，列表由调用方重拉；被拒（无权限 / 角色仍被用户或策略引用等）
 * 经 unwrapEnvelope 抛 ApiError，`message` 即 eiam msg 原文（**不得二次改写**）。
 */
export async function batchDeleteRoles(ids: number[]): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/batch_delete", { ids }),
  );
}

// ---- 策略绑定（D-3：经 policy 侧承载）----

/**
 * 角色已绑策略清单（POST /api/iam/policy/list/attached/role，D-3 形状实核）。
 * 载荷 {role_code, offset, limit, keyword}——**不带 type**（eiam ListRolePoliciesReq.type 为 uint8，
 * policy/vo.go:62；0=不过滤全类型，dao/policy.go:246）。传字符串 "role" 会在 gin JSON 绑定层
 * 直接 400（「编辑角色 HTTP 400」事故根因）。
 * 响应归一为 PolicyRef[]（详情页策略回显 + 列表页计数）。
 * @param roleCode 角色 code（非 id；policy 侧以 role_code 为键）
 */
export async function listPoliciesForRole(
  roleCode: string,
): Promise<PolicyRef[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/policy/list/attached/role", {
      role_code: roleCode,
      offset: 0,
      limit: 100,
      keyword: "",
    }),
  );
  return toPolicyRefs(data);
}

/**
 * 可绑定策略清单（POST /api/iam/policy/list，C 档路径实存、形状待核验）。
 * UF-8 策略绑定多选数据源——**仅列 eiam 返回的可绑定策略，无新建/编辑/删除策略入口**
 * （Hard Rule：租户管理员策略绑定下拉仅列 eiam 可绑定策略）。
 * 载荷 {offset, limit, keyword}；响应归一为 PolicyRef[]。
 */
export async function listBindablePolicies(
  q: ListQuery,
): Promise<Page<PolicyRef>> {
  const data = await unwrapEnvelope<{ total?: number; policies?: unknown[] }>(
    eiamAxios.post<Envelope<{ total?: number; policies?: unknown[] }>>(
      "/api/iam/policy/list",
      {
        offset: q.offset,
        limit: q.limit,
        keyword: q.keyword,
      },
    ),
  );
  if (!isRecord(data)) return { total: 0, items: [] };
  const result = data as { total?: number; policies?: unknown[] };
  const items = toPolicyRefs(data);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/** 主体引用（policy/batch-attach 载荷 subjects 成员；eiam SubjectItem 键为 type，policy/vo.go:84-89） */
export interface PolicySubject {
  type: "user" | "role" | "group";
  code: string;
}

/**
 * 绑定策略到角色（POST /api/iam/policy/batch-attach，D-3 路径改判 + 形状实核）。
 * 载荷 {subjects:[{type:"role", code: roleCode}], policy_codes}（主体键 **type** 非 sub_type，
 * 与 eiam SubjectItem 对齐；主体可 user/role/group 混合，角色为主体时 type=role）。
 * G-6 语义映射：角色↔策略绑定落点在 policy 侧。
 * @param roleCode 角色 code（主体键）
 * @param policyCodes 待绑定策略 code 列表
 */
export async function attachPoliciesToRole(
  roleCode: string,
  policyCodes: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-attach", {
      subjects: [{ type: "role", code: roleCode }] as PolicySubject[],
      policy_codes: policyCodes,
    }),
  );
}

/**
 * 解绑策略（POST /api/iam/policy/batch-detach，D-3 路径改判 + 形状实核）。
 * 载荷 {assignments:[{sub_type, sub_code, policy_code}]}——eiam Assignment 为扁平逐条
 * （policy/vo.go:133-144），**无 subject 嵌套**；显式逐条避免笛卡尔积误删。
 * @param roleCode 角色 code（主体键）
 * @param policyCodes 待解绑策略 code 列表（逐条构造 assignment）
 */
export async function detachPoliciesFromRole(
  roleCode: string,
  policyCodes: string[],
): Promise<void> {
  const assignments = policyCodes.map((code) => ({
    sub_type: "role",
    sub_code: roleCode,
    policy_code: code,
  }));
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/policy/batch-detach", {
      assignments,
    }),
  );
}

// ---- 用户绑定（A 档：role/batch_assign|batch_unassign，以 code 为准）----

/**
 * 分配用户到角色（POST /api/iam/role/batch_assign，A 档实核）。
 * 载荷 {usernames, role_codes}（角色分配以 code 为准）；角色↔用户绑定以角色为主体，复用 A 档端点。
 * @param roleCode 角色 code
 * @param usernames 待绑定用户名列表
 */
export async function assignUsersToRole(
  roleCode: string,
  usernames: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/batch_assign", {
      usernames,
      role_codes: [roleCode],
    }),
  );
}

/**
 * 解绑用户（POST /api/iam/role/batch_unassign，A 档实核）。
 * 载荷 {usernames, role_codes}。
 * @param roleCode 角色 code
 * @param usernames 待解绑用户名列表
 */
export async function unassignUsersFromRole(
  roleCode: string,
  usernames: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/batch_unassign", {
      usernames,
      role_codes: [roleCode],
    }),
  );
}

// ---- 角色继承（feat-role-inheritance：parents / add_parent / remove_parent，后端已存在、零改动）----

/**
 * 父角色引用（eiam `RoleInheritanceInfo`：`{code, is_direct, is_immutable}`）。
 *
 * **响应只有 code，不含名称/描述** —— 名称由视图层从既有 `listRolesPage` 的全量角色本地映射，
 * 查不到时回退展示 code（契约 §1）。
 * - `isDirect=true` 直接父角色；`false` 为继承链上游的间接父角色；
 * - `isImmutable=true` 表示不允许手动移除（系统维护）→ 行内移除按钮必须**禁用**（不是隐藏）。
 */
export interface RoleInheritance {
  code: string;
  isDirect: boolean;
  isImmutable: boolean;
}

/** 归一 `/parents` 响应 → RoleInheritance[]（**数组**，非分页信封；非数组降级 []，缺 code 过滤） */
function toRoleInheritances(raw: unknown): RoleInheritance[] {
  if (!Array.isArray(raw)) return [];
  const items: RoleInheritance[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const code = asString(item.code);
    if (!code) continue;
    items.push({
      code,
      isDirect: item.is_direct === true,
      isImmutable: item.is_immutable === true,
    });
  }
  return items;
}

/**
 * 父角色列表（POST /api/iam/role/parents，后端已存在；权限 `iam:role:view_parents`）。
 * 载荷 `{role_code}`；响应的 `data` 是**数组**（非 `{total, items}` 分页信封），
 * 归一为 RoleInheritance[]（非数组 → []，缺 code 脏记录过滤）。
 */
export async function listParentRoles(
  roleCode: string,
): Promise<RoleInheritance[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/role/parents", {
      role_code: roleCode,
    }),
  );
  return toRoleInheritances(data);
}

/**
 * 添加父角色（POST /api/iam/role/add_parent，后端已存在；权限 `iam:role:add_parent`）。
 * 载荷 `{role_code, parent_role_code}`（两者均为 code，非 id）。
 * 被拒（成环 / 重复 / 无权限等）由调用方展示 `ApiError.message` **原文**。
 */
export async function addParentRole(
  roleCode: string,
  parentRoleCode: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/add_parent", {
      role_code: roleCode,
      parent_role_code: parentRoleCode,
    }),
  );
}

/**
 * 移除父角色（POST /api/iam/role/remove_parent，后端已存在；权限 `iam:role:remove_parent`）。
 * 载荷 `{role_code, parent_role_code}`；`is_immutable` 的父角色由 UI 禁用（服务端仍兜底拒绝）。
 */
export async function removeParentRole(
  roleCode: string,
  parentRoleCode: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/remove_parent", {
      role_code: roleCode,
      parent_role_code: parentRoleCode,
    }),
  );
}

// ---- 用户权限来源：user → roles 只读反查（feat-user-permission-sources 契约 §1 / §2.1）----

/**
 * 归一 attached/user 响应 → `Role[]`。
 *
 * eiam 出参为 `RetrieveRole{total, roles[]}`（与 role/list 同款，role/handler.go:120-127）；
 * 另兼容**裸数组**（防御代理/旧版直出）。复用既有 `toRolePage`（缺 id 脏项过滤、total 缺省
 * 按 items 长度），非对象 / 缺 `roles` 键 / 非数组 → 空数组，**不抛**。
 */
function toUserRoleList(raw: unknown): Role[] {
  if (Array.isArray(raw)) return toRolePage({ roles: raw }).items;
  return toRolePage(raw).items;
}

/**
 * 用户已绑角色（POST /api/iam/role/list/attached/user；权限 `iam:role:view_user_roles`）。
 *
 * 载荷 `{ user_id, offset, limit, keyword }`。
 *
 * 与 `@/api/users` 的同名函数刻意区分：那个是 UF-4 既有的角色回显（返回 `RoleRef[]`，
 * 载荷 `{user_id, offset, limit}`，服务于用户列表 store 与详情页编辑回显）；本函数是契约 §2.1
 * 为「权限来源」面板新增的只读反查，返回完整 `Role`（含 name / desc），两者并存以免回归既有回显链路。
 *
 * 脏数据一律降级：响应非对象/非数组/缺键 → `[]`；缺 id 的脏记录由 `mapEiamRole` 过滤。
 *
 * **必须带 `limit`（重要，契约已勘误）**：eiam `GetRolesByUserId` 把 `req.Limit` 原样下传
 * （role/handler.go:114），DAO 走 `Paginate` = `Offset(offset).Limit(limit)`（dao/paginate.go），
 * 而 GORM v2 对 `limit=0` 生成 **`LIMIT 0`** —— 只传 `user_id` 会得到空列表（total 却非 0），
 * 表现为「角色区块恒为空态」。故此处显式带分页字段（后端 struct 本就支持 offset/limit/keyword）。
 */
export async function listRolesForUser(
  userId: number,
  q: ListQuery = { offset: 0, limit: 100, keyword: "" },
): Promise<Role[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/role/list/attached/user", {
      user_id: userId,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toUserRoleList(data);
}

// ---- 复用导出（users.ts 已实现的 A 档角色引用映射，供本域调用方面复用）----

export type { RoleRef } from "@/api/types";
