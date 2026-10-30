/**
 * 用户域 api 客户端（task 4.2，UF-4）—— 列表/详情/增删改 + 角色绑定 + passkey/reset 降级。
 *
 * 端点证据等级（tech-design §Interfaces + parity-checklist §2/§3）：
 * - A 档（实核）：user/list、user/create、user/update、user/delete、role/list、
 *   role/list/attached/user、role/batch_assign|batch_unassign。
 * - C 档（路径实存、形状待核验）：user/detail（GET query 传参）、user/list/attached/role
 *   （角色过滤列表，载荷 role_code）。
 * - C 档缺口（G-1/G-2/G-3，待 eiam 排期补齐）：user/reset_password、passkey register/start|finish、
 *   passkey 撤销。api 层按 tech-design C 档推定形状实现为类型载体；v1 store/UI 按降级口径不调用
 *   （reset 流裁剪、passkey 仅展示绑定态），eiam 排期补齐后端点落定即生效。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 {total, users} → Page<User>.items；
 * - snake_case 原生键（job_title / last_login_at / role_codes / user_id 等）一律 camelCase 归一；
 * - User.status 原值 'active'|'disable'，未知串归一 'unknown'（G-9：不引入 'locked'）。
 *
 * Phase 0 降级承载（task 4.2 Hard Rules + parity §3.1）：
 * - G-1：user/reset_password 端点缺口 → 初始密码发放保留于 user/create（A 档 #2 已核成立），
 *   resetPassword 函数为待 eiam 排期的类型载体，v1 不在 UI 暴露可用入口。
 * - G-2/G-3：管理员发起 passkey 注册/撤销端点缺口 → v1 仅展示绑定态，startPasskeyRegistration/
 *   revokePasskey 为待排期类型载体。
 * - User.orgRef：eiam 用户域无组织 ref 数据源（G 类缺口）→ 不在 api 层伪造，orgRef 留 undefined。
 * - User.loginMethod / passkeyRegistered：user/list 不直出（UserMemberVO 无此字段），
 *   list 归一时 loginMethod 缺省 'password'、passkeyRegistered 缺省 false；详情页按需 enrichment。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type {
  Envelope,
  ListQuery,
  Page,
  PasskeyRegistrationSession,
  RoleRef,
  User,
} from "@/api/types";

// ---- eiam 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamUserRaw {
  id?: number;
  username?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  job_title?: string;
  status?: unknown;
  avatar?: string;
  last_login_at?: number;
  is_member?: boolean;
  is_system_space?: boolean;
  tenant_id?: number;
}

interface EiamRoleRaw {
  id?: number;
  code?: string;
  name?: string;
  desc?: string;
}

interface EiamListResult {
  total?: number;
  users?: unknown[];
}

interface EiamRoleListResult {
  total?: number;
  roles?: unknown[];
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

/** eiam status 原值 → User.status 归一（G-9：不引入 'locked'，未知串归一 'unknown'） */
function normalizeStatus(raw: unknown): User["status"] {
  if (raw === "active") return "active";
  if (raw === "disable") return "disable";
  return "unknown";
}

/**
 * eiam user 原生形状 → 归一 User（snake_case → camelCase）。
 * 缺 id（核心标识）返回 null，由调用方降级过滤。
 * loginMethod/passkeyRegistered 在 list 响应中无数据源（UserMemberVO 不携带），
 * 分别缺省 'password' / false；详情页 enrichment 覆盖。
 */
export function mapEiamUser(raw: unknown): User | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const eiam = raw as EiamUserRaw;
  const username = asString(eiam.username) ?? "";
  return {
    id,
    username,
    displayName: asString(eiam.nickname) ?? username,
    tenantId: asNumber(eiam.tenant_id),
    roles: [],
    status: normalizeStatus(eiam.status),
    // list/detail 均不直出 loginMethod；缺省 password，详情页按绑定态覆盖
    loginMethod: "password",
    // passkeyRegistered 无直出字段（G-2）；缺省 false，详情页经 identity 探测覆盖
    passkeyRegistered: false,
  };
}

/** eiam role 原生形状 → 归一 RoleRef（id/code/name；desc 不入引用） */
export function mapEiamRoleRef(raw: unknown): RoleRef | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  const code = asString((raw as EiamRoleRaw).code);
  // id 与 code 至少其一有效（eiam 角色以 code 为准，id 可能为 0 但 code 存在）
  if (id === 0 && code === undefined) return null;
  return {
    id,
    code: code ?? "",
    name: asString((raw as EiamRoleRaw).name) ?? code ?? "",
  };
}

/** 归一 eiam {total, users} → Page<User>（过滤 null，total 缺省按 items 长度） */
function toUserPage(raw: unknown): Page<User> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamListResult;
  const users = Array.isArray(result.users) ? result.users : [];
  const items = users.map(mapEiamUser).filter((u): u is User => u !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/** 归一 eiam {total, roles} → RoleRef[]（详情页角色回显用，过滤 null） */
function toRoleRefs(raw: unknown): RoleRef[] {
  if (!isRecord(raw)) return [];
  const result = raw as EiamRoleListResult;
  const roles = Array.isArray(result.roles) ? result.roles : [];
  return roles.map(mapEiamRoleRef).filter((r): r is RoleRef => r !== null);
}

// ---- 用户 CRUD ----

/**
 * 用户列表（POST /api/iam/user/list，A 档实核）。
 * 载荷 {offset, limit, keyword}；响应归一为 Page<User>（roles/loginMethod/passkeyRegistered
 * 缺省值，详情页 enrichment 覆盖）。
 */
export async function listUsers(q: ListQuery): Promise<Page<User>> {
  const data = await unwrapEnvelope<EiamListResult>(
    eiamAxios.post<Envelope<EiamListResult>>("/api/iam/user/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toUserPage(data);
}

/**
 * 按角色过滤的用户列表（POST /api/iam/user/list/attached/role，C 档路径实存、形状待核验）。
 * 载荷 {role_code, offset, limit, keyword}；用于 UF-4 角色过滤。无角色过滤时 store 走 listUsers。
 */
export async function listUsersByRole(
  roleCode: string,
  q: ListQuery,
): Promise<Page<User>> {
  const data = await unwrapEnvelope<EiamListResult>(
    eiamAxios.post<Envelope<EiamListResult>>(
      "/api/iam/user/list/attached/role",
      {
        role_code: roleCode,
        offset: q.offset,
        limit: q.limit,
        keyword: q.keyword,
      },
    ),
  );
  return toUserPage(data);
}

/** 创建用户载荷（camelCase 规范形；api 层映射为 eiam SignupRequest snake_case 载荷） */
export interface CreateUserPayload {
  username: string;
  /** 初始密码（管理员设置或系统生成；展示一次，Hard Rule） */
  password: string;
  nickname?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  /** 缺省时 eiam 默认 active */
  status?: User["status"];
}

/** 创建结果：新用户 id + 初始密码回显（展示一次，Hard Rule：不进列表/编辑回显） */
export interface CreateUserResult {
  id: number;
  initialPassword: string;
}

/**
 * 创建用户（POST /api/iam/user/create，A 档实核）。
 * 载荷 eiam SignupRequest {username, password, confirm_password, nickname?, ...}；
 * 初始密码发放经 create 承载（G-1 降级：reset 端点缺口，初始密码由 create 发放）。
 * @returns 新 id + initialPassword（= payload.password 回显，供 Dialog 一次性展示）
 */
export async function createUser(
  payload: CreateUserPayload,
): Promise<CreateUserResult> {
  const id = await unwrapEnvelope<number>(
    eiamAxios.post<Envelope<number>>("/api/iam/user/create", {
      username: payload.username,
      password: payload.password,
      confirm_password: payload.password,
      nickname: payload.nickname,
      email: payload.email,
      phone: payload.phone,
      job_title: payload.jobTitle,
      status: payload.status,
    }),
  );
  // 初始密码回显：取自 payload（eiam create 仅返回 id；密码不回显，由调用方展示一次）
  return { id, initialPassword: payload.password };
}

/** 更新用户载荷（UpdateUserReq = ID + BaseUserRequest，无 password 字段——A 档实核） */
export interface UpdateUserPayload {
  id: number;
  nickname?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  /** 启用/禁用 lever（active/disable；G-9：无 locked） */
  status?: User["status"];
}

/** 更新用户（POST /api/iam/user/update，A 档实核） */
export async function updateUser(payload: UpdateUserPayload): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/update", {
      id: payload.id,
      nickname: payload.nickname,
      email: payload.email,
      phone: payload.phone,
      job_title: payload.jobTitle,
      status: payload.status,
    }),
  );
}

/** 删除用户（DELETE /api/iam/user/delete/:id，A 档实核）；依赖删除由 eiam 服务端拒绝（E11） */
export async function deleteUser(id: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(`/api/iam/user/delete/${id}`),
  );
}

/**
 * 用户详情（GET /api/iam/user/detail，C 档路径实存、形状待核验）。
 * query 传参 id；响应归一为 User（缺 id 返回 null）。roles 需经 listRolesForUser enrichment。
 */
export async function getUserDetail(id: number): Promise<User | null> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>("/api/iam/user/detail", {
      params: { id },
    }),
  );
  return mapEiamUser(data);
}

// ---- 角色绑定 ----

/**
 * 用户已绑角色（POST /api/iam/role/list/attached/user，A 档实核）。
 * 载荷 {user_id, offset, limit}；用户详情页角色回显数据源。
 */
export async function listRolesForUser(userId: number): Promise<RoleRef[]> {
  const data = await unwrapEnvelope<EiamRoleListResult>(
    eiamAxios.post<Envelope<EiamRoleListResult>>(
      "/api/iam/role/list/attached/user",
      { user_id: userId, offset: 0, limit: 100 },
    ),
  );
  return toRoleRefs(data);
}

/**
 * 角色清单（POST /api/iam/role/list，A 档实核）。
 * UF-4 角色过滤下拉 / 编辑页角色绑定多选数据源。
 */
export async function listRoles(q: ListQuery): Promise<Page<RoleRef>> {
  const data = await unwrapEnvelope<EiamRoleListResult>(
    eiamAxios.post<Envelope<EiamRoleListResult>>("/api/iam/role/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  if (!isRecord(data)) return { total: 0, items: [] };
  const result = data as EiamRoleListResult;
  const items = toRoleRefs(data);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/**
 * 分配角色（POST /api/iam/role/batch_assign，A 档实核）。
 * 载荷 {usernames, role_codes}（角色分配以 code 为准，parity §2.1 实核）。
 */
export async function assignRoles(
  usernames: string[],
  roleCodes: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/batch_assign", {
      usernames,
      role_codes: roleCodes,
    }),
  );
}

/** 解绑角色（POST /api/iam/role/batch_unassign，A 档实核） */
export async function unassignRoles(
  usernames: string[],
  roleCodes: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/role/batch_unassign", {
      usernames,
      role_codes: roleCodes,
    }),
  );
}

// ---- 端点就绪状态（G-1 已补齐；G-2/G-3 仍缺）----

/**
 * 管理员重置指定用户密码（POST /api/iam/user/reset_password）。
 *
 * **G-1 已补齐**（2026-10-28，eiam `web/user/handler.go` 新增该路由，权限 `iam:user:edit`）。
 * 真实契约：请求 `{ id, new_password, confirm_password }` → `{ msg: "密码重置成功" }`；
 * **不返回明文密码**（后端只落 bcrypt 哈希，不回显），故此前"返回一次性初始密码"的推定已废弃。
 *
 * 安全：新密码强度由后端 `validatePassword` 校验（弱口令返回 4010205），
 * 前端不做口令策略实现，只校验两次输入一致。
 */
export async function resetPassword(
  userId: number,
  newPassword: string,
  confirmPassword: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/reset_password", {
      id: userId,
      new_password: newPassword,
      confirm_password: confirmPassword,
    }),
  );
}

/**
 * 管理员发起 passkey 注册引导（POST /api/iam/user/passkey/register/start，C 档推定）。
 * **G-2 缺口**：现役 register/start 为 L1 本人自服务，管理员代发起端点不存在，待 eiam 排期补齐。
 * 推定载荷 {user_id} → {options, ticket}（形状对齐 B 档 passkey/login/start）。
 * v1 降级：控制台仅展示 passkey 绑定态（bound-state display），本函数为待排期类型载体。
 */
export async function startPasskeyRegistration(
  userId: number,
): Promise<PasskeyRegistrationSession> {
  const data = await unwrapEnvelope<{
    ticket?: string;
    expires_at?: number;
    used?: boolean;
  }>(
    eiamAxios.post<
      Envelope<{ ticket?: string; expires_at?: number; used?: boolean }>
    >("/api/iam/user/passkey/register/start", { user_id: userId }),
  );
  const ticket = asString(data?.ticket) ?? "";
  return {
    ticket,
    expiresAt: asNumber(data?.expires_at),
    used: data?.used === true,
  };
}

/**
 * 撤销 passkey 绑定（POST /api/iam/user/identity/unbind，G-3 替代路径待核验）。
 * **G-3 缺口**：DELETE /api/iam/user/passkey/:id 推定路由不存在；替代承载 = identity/unbind
 * （载荷 {user_id, provider, identity_id}，provider=passkey 是否生效待响应样本核验）。
 * v1 降级：核验不过并入 G-2 降级口径；本函数为待排期类型载体。
 */
export async function revokePasskey(
  userId: number,
  identityId: number,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/identity/unbind", {
      user_id: userId,
      provider: "passkey",
      identity_id: identityId,
    }),
  );
}

// ---- 外部身份绑定（管理员视角）----

/** 用户外部身份绑定（provider=ldap/wechat/feishu/passkey） */
export interface UserIdentity {
  provider: string;
  identityId: string;
}

/**
 * 管理员查询指定用户的外部身份绑定（POST /api/iam/user/identity/list，权限 iam:user:get）。
 *
 * 为什么需要它：解绑必须知道 provider + identity_id；而 GET /identity/list 是**自助**接口
 * （只能查自己）。没有本函数，管理员只能"盲解绑"，`iam:user:unbind_identity` 也就无从使用。
 */
/** 把未知响应体归一为数组（非数组一律视为空，避免后端换形状时页面崩溃） */
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export async function listUserIdentities(
  userId: number,
  provider?: string,
): Promise<UserIdentity[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/user/identity/list", {
      user_id: userId,
      ...(provider ? { provider } : {}),
    }),
  );
  return asArray(data)
    .map((raw) => {
      const provider = asString((raw as Record<string, unknown>)?.provider);
      const identityId = asString((raw as Record<string, unknown>)?.identity_id);
      return provider && identityId ? { provider, identityId } : null;
    })
    .filter((x): x is UserIdentity => x !== null);
}

/**
 * 解绑指定用户的外部身份（POST /api/iam/user/identity/unbind，权限 iam:user:unbind_identity）。
 *
 * identityId 为 string：后端 domain.UserIdentity.IdentityID 是 DN / OpenID / CredentialID
 * 这类字符串标识，不是数字（旧 revokePasskey 把它当 number 传，属类型误设）。
 */
export async function unbindUserIdentity(
  userId: number,
  provider: string,
  identityId: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/identity/unbind", {
      user_id: userId,
      provider,
      identity_id: identityId,
    }),
  );
}
/**
 * 批量删除用户（POST /api/iam/user/batch_delete）。
 *
 * 载荷键精确为 `{ids}`（对应 eiam `BatchDeleteReq{IDs []int64}`，json tag 为 `ids`）；
 * 空数组照样上行（不在本地臆造拦截，由服务端判定）。
 *
 * 为什么补这个函数：后端已实现该端点并声明能力码 `iam:user:batch_delete`，
 * 但 console 侧此前**既无 api 函数也无视图调用**（权限码零使用）——
 * 管理员只能逐个删除，无法批量处理（"已实现却无视图调用"）。
 *
 * 返回 void：该端点不回传逐条结果，列表由调用方重拉；任一 id 不存在等业务拒绝
 * 经 unwrapEnvelope 抛 ApiError，message 即 eiam msg 原文（不得改写）。
 */
export async function batchDeleteUsers(ids: number[]): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/batch_delete", { ids }),
  );
}

/**
 * 治理用户外部身份（POST /api/iam/user/identity/manage）。
 *
 * 语义（2026-10-30 后端已按产品口径修正）：**只绑定/更新**，不再隐式解绑——
 * 旧实现在 provider 块为空时会连带删除该 provider 的全部绑定（"只更新 LDAP"会删掉 wechat/feishu）。
 * 因此本函数只提交"非空"的 provider 块：未填写的 provider 一律不下发（既不解绑也不会误删）。
 *
 * 精确解绑请走 unbindUserIdentity（必带 identityId）。
 */
export async function manageUserIdentity(
  userId: number,
  payload: {
    ldapDN?: string;
    wechatUserID?: string;
    feishuUserID?: string;
  },
): Promise<void> {
  const body: Record<string, unknown> = { user_id: userId };
  if (payload.ldapDN) body.ldap_info = { dn: payload.ldapDN };
  if (payload.wechatUserID) body.wechat_info = { user_id: payload.wechatUserID };
  if (payload.feishuUserID) body.feishu_info = { user_id: payload.feishuUserID };
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/identity/manage", body),
  );
}