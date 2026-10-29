/**
 * 用户组域 api 客户端（feat-group-management 契约 §2.1）—— 列表 / 新建 / 更新 / 删除；
 * feat-group-members 契约 §2.1 追加组成员三接口；
 * feat-group-roles 契约 §2.1 追加组角色三接口；
 * feat-user-permission-sources 契约 §2.1 追加 `listGroupsForUser`；
 * feat-role-bound-groups 契约 §2.2 追加 `listGroupsForRole`。
 *
 * 后端端点（已存在，本切片零后端改动）：
 * - `POST /api/iam/group/list`   `{ offset, limit, keyword }`         → `{ total, groups }`
 * - `POST /api/iam/group/create` `{ name, code, desc }`
 * - `POST /api/iam/group/update` `{ id, name, desc }`（**无 code**，标识码创建后不可改）
 * - `DELETE /api/iam/group/delete/:id`
 * - `POST /api/iam/group/members`        `{ group_code, offset, limit, keyword }` → `{ total, members }`
 * - `POST /api/iam/group/members/assign` `{ group_code, usernames: string[] }`
 * - `POST /api/iam/group/members/remove` `{ group_code, usernames: string[] }`
 * - `GET  /api/iam/group/roles/:code`    → **完整 Role VO 数组**（非分页信封、非 code 列表）
 * - `POST /api/iam/group/role/assign`    `{ group_code, role_code }`
 * - `POST /api/iam/group/role/remove`    `{ group_code, role_code }`
 * - `POST /api/iam/group/list/attached/user` `{ user_id, offset, limit, keyword }` → `{ total, groups }`
 * - `POST /api/iam/group/list/attached/role` `{ role_code, offset, limit, keyword }` → `{ total, groups }`
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封统一经 `unwrapEnvelope<T>()` 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 `{total, groups}` → `Page<TenantGroup>.items`；
 * - `groups[]` 元素键名已是 camelCase（`desc` 等），仅做**缺 id 过滤**与时间戳有效性校验；
 * - `total` 缺失 / 非有限数 → 按归一后 items 长度（与 tenant/role 等列表同口径）。
 *
 * **无跨租户 Header**：group 端点按会话租户隔离（eiam 侧由 session 上下文解析租户），
 * 不需要 `X-Active-Tenant-ID`（该 Header 仅 tenant/members 等跨租户读取端点使用）。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import { mapEiamRole } from "@/api/roles";
import { mapEiamUser } from "@/api/users";
import type {
  Envelope,
  ListQuery,
  Page,
  Role,
  TenantGroup,
} from "@/api/types";

/**
 * 类型单一事实源在 `@/api/types`（identity.ts 定义），此处仅转出，
 * 避免 api 层与类型层各定义一套（契约 §2.2「二选一，勿重复定义两套」）。
 */
export type { TenantGroup } from "@/api/types";

// ---- eiam 原生形状（私有，仅本模块映射用）----

interface EiamGroupRaw {
  id?: number;
  name?: string;
  code?: string;
  /** 描述（eiam 出参键即 `desc`，非 description） */
  desc?: string;
  /** 创建时间（Unix 毫秒；缺失 / 非有限数 → undefined） */
  ctime?: number;
  /** 更新时间（Unix 毫秒；缺失 / 非有限数 → undefined） */
  utime?: number;
}

interface EiamGroupListResult {
  total?: number;
  groups?: unknown[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Unix 毫秒时间戳归一：缺失 / 非有限数 → undefined（视图 '—'），有效值（含 0）原样保留 */
function asOptionalTimestamp(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * eiam group 原生形状 → 归一 TenantGroup。
 * 缺 id（核心标识）返回 null，由调用方降级过滤（与 mapEiamTenant 同口径）。
 */
export function mapEiamGroup(raw: unknown): TenantGroup | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  const g = raw as EiamGroupRaw;
  return {
    id,
    name: asString(g.name),
    code: asString(g.code),
    desc: asString(g.desc),
    ctime: asOptionalTimestamp(g.ctime),
    utime: asOptionalTimestamp(g.utime),
  };
}

/** 归一 eiam `{total, groups}` → `Page<TenantGroup>`（过滤 null，total 缺省按 items 长度） */
function toGroupPage(raw: unknown): Page<TenantGroup> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamGroupListResult;
  const groups = Array.isArray(result.groups) ? result.groups : [];
  const items = groups
    .map(mapEiamGroup)
    .filter((g): g is TenantGroup => g !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

// ---- 用户组 CRUD ----

/**
 * 用户组列表（POST /api/iam/group/list）。
 * 载荷 `{offset, limit, keyword}`（契约 §1；无 status 维度 → 不携带多余键）。
 */
export async function listGroups(q: ListQuery): Promise<Page<TenantGroup>> {
  const data = await unwrapEnvelope<EiamGroupListResult>(
    eiamAxios.post<Envelope<EiamGroupListResult>>("/api/iam/group/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toGroupPage(data);
}

/** 新建用户组载荷（契约 §2.1） */
export interface CreateGroupPayload {
  /** 组名（必填，1–64 字符） */
  name: string;
  /** 标识码（必填，≤32；创建后不可改） */
  code: string;
  /** 描述（可选，≤512） */
  desc?: string;
}

/**
 * 新建用户组（POST /api/iam/group/create）。
 * 契约签名返回 void —— eiam 该端点不回传新 id，列表由调用方重新拉取。
 */
export async function createGroup(payload: CreateGroupPayload): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/create", {
      name: payload.name,
      code: payload.code,
      desc: payload.desc,
    }),
  );
}

/** 更新用户组载荷（契约 §2.1；**无 code** —— eiam UpdateGroupReq 不含该字段） */
export interface UpdateGroupPayload {
  id: number;
  /** 组名（必填，1–64 字符） */
  name: string;
  /** 描述（可选，≤512） */
  desc?: string;
}

/**
 * 更新用户组（POST /api/iam/group/update）。
 * 载荷仅 `{id, name, desc}`：标识码不可改（前端表单编辑态只读，api 层也不得夹带 code，
 * 否则 eiam 侧字段语义漂移）。
 */
export async function updateGroup(payload: UpdateGroupPayload): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/update", {
      id: payload.id,
      name: payload.name,
      desc: payload.desc,
    }),
  );
}

/**
 * 删除用户组（DELETE /api/iam/group/delete/:id）。
 * 拒绝原因（如组内仍有成员）由 eiam 返回，store/视图原样透传 msg。
 */
export async function deleteGroup(id: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(`/api/iam/group/delete/${id}`),
  );
}

// ---- 组成员（feat-group-members 契约 §2.1）----

/**
 * 组成员（契约 §2.1）。
 *
 * 形状与 eiam `ListMembersResponse.members[]`（`group/vo.go` 的 `User`）一致：
 * `{ id, username, nickname, avatar, email, phone }`。
 * **添加/移除成员以 `username` 为参数**（不是 id）—— 故规范形保留 username 为主键语义字段，
 * id 仅用于 v-for 的 key / 展示。
 */
export interface GroupMember {
  /** 用户 id（eiam 主键；仅作渲染 key，成员增删用 username） */
  id: number;
  /** 登录名（成员增删载荷 usernames[] 的元素） */
  username: string;
  /** 昵称（缺失 → 空串，视图渲染 '—'） */
  nickname: string;
  /** 邮箱（缺失 / 空串 → undefined，视图渲染 '—'） */
  email?: string;
  /** 手机号（缺失 / 空串 → undefined，视图渲染 '—'） */
  phone?: string;
}

/** eiam 组成员原生形状（私有，仅本模块映射用） */
interface EiamGroupMemberRaw {
  id?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  phone?: string;
}

interface EiamGroupMemberListResult {
  total?: number;
  members?: unknown[];
}

/**
 * eiam 组成员原生形状 → 归一 GroupMember。
 *
 * id / username 的解析与缺 id 过滤**复用 `@/api/users` 的 mapEiamUser**（单一事实源，
 * 不另写一套 id 校验）；nickname / email / phone 取原生键（mapEiamUser 的规范形不含
 * email / phone，其 displayName 又会在昵称缺失时回填用户名，不适合成员列的「昵称」语义）。
 * 缺 id → null，由调用方降级过滤。
 */
export function mapEiamGroupMember(raw: unknown): GroupMember | null {
  const user = mapEiamUser(raw);
  if (!user) return null;
  const m = raw as EiamGroupMemberRaw;
  return {
    id: user.id,
    username: user.username,
    nickname: asString(m.nickname),
    email: asString(m.email) || undefined,
    phone: asString(m.phone) || undefined,
  };
}

/** 归一 eiam `{total, members}` → `Page<GroupMember>`（过滤 null，total 缺省按 items 长度） */
function toGroupMemberPage(raw: unknown): Page<GroupMember> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamGroupMemberListResult;
  const members = Array.isArray(result.members) ? result.members : [];
  const items = members
    .map(mapEiamGroupMember)
    .filter((m): m is GroupMember => m !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/**
 * 组成员列表（POST /api/iam/group/members，契约 §1）。
 *
 * 载荷 `{group_code, offset, limit, keyword}`；与 group/list 不同，本端点**服务端真支持
 * keyword**（`ListMembersRequest.Keyword`），故 keyword 照常上行，前端不做本页假筛选。
 * 无跨租户 Header：group 端点按会话租户隔离。
 */
export async function listGroupMembers(
  groupCode: string,
  q: ListQuery,
): Promise<Page<GroupMember>> {
  const data = await unwrapEnvelope<EiamGroupMemberListResult>(
    eiamAxios.post<Envelope<EiamGroupMemberListResult>>(
      "/api/iam/group/members",
      {
        group_code: groupCode,
        offset: q.offset,
        limit: q.limit,
        keyword: q.keyword,
      },
    ),
  );
  return toGroupMemberPage(data);
}

/**
 * 添加组成员（POST /api/iam/group/members/assign，契约 §1）。
 *
 * 载荷 `{group_code, usernames}` —— **username 数组，不是 id 数组**（eiam
 * `AssignMembersRequest.Usernames`）。被拒（重复加入 / 无权限等）经 unwrapEnvelope 抛
 * ApiError，message 即 eiam msg 原文，调用方须原样展示。
 */
export async function assignGroupMembers(
  groupCode: string,
  usernames: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/members/assign", {
      group_code: groupCode,
      usernames,
    }),
  );
}

/**
 * 移除组成员（POST /api/iam/group/members/remove，契约 §1）。
 *
 * 载荷 `{group_code, usernames}` —— 同样是 **username 数组**（eiam
 * `RemoveMembersRequest.Usernames`）。被拒时 message 即 eiam msg 原文。
 */
export async function removeGroupMembers(
  groupCode: string,
  usernames: string[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/members/remove", {
      group_code: groupCode,
      usernames,
    }),
  );
}

// ---- 组角色（feat-group-roles 契约 §2.1）----

/**
 * 组已绑角色（契约 §2.2 列表行）。
 *
 * 复用 `@/api/types` 的 `Role`（id / code / name / desc）作为唯一事实源，
 * 只补 eiam group/vo.go `Role` 额外携带的两个时间戳（Unix 毫秒），**不另定义一套角色形**
 * （契约 §2.1「二选一，勿重复定义两套」）。
 */
export interface TenantGroupRole extends Role {
  /** 创建时间（Unix 毫秒；缺失 / 非有限数 → undefined，视图经 formatEpochMs 降级 '—'） */
  ctime?: number;
  /** 更新时间（Unix 毫秒；同上） */
  utime?: number;
}

/** eiam 组角色原生形状中本层额外消费的键（id/code/name/desc 由 mapEiamRole 归一） */
interface EiamGroupRoleRaw {
  ctime?: unknown;
  utime?: unknown;
}

/**
 * eiam 组角色原生形状 → 归一 TenantGroupRole。
 *
 * id / code / name / desc 的解析与缺 id 过滤**复用 `@/api/roles` 的 mapEiamRole**
 * （单一事实源，不另写一套 id 校验）；本层只补 ctime / utime 两个时间戳。
 * 缺 id → null，由调用方降级过滤。
 */
export function mapEiamGroupRole(raw: unknown): TenantGroupRole | null {
  const role = mapEiamRole(raw);
  if (!role) return null;
  const r = raw as EiamGroupRoleRaw;
  return {
    ...role,
    ctime: asOptionalTimestamp(r.ctime),
    utime: asOptionalTimestamp(r.utime),
  };
}

/**
 * 组已绑角色列表（GET /api/iam/group/roles/:code，契约 §1）。
 *
 * 注意端点形态与其他组接口不同：**GET + path 参数**（不是 POST + body），
 * `data` 直接是**完整 Role VO 数组**（`[{id, code, name, desc, ctime, utime}]`），
 * 未绑定任何角色时返回 `[]`；**不是** `{total, roles}` 分页信封。
 * 无跨租户 Header：group 端点按会话租户隔离。
 */
export async function listGroupRoles(
  groupCode: string,
): Promise<TenantGroupRole[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>(
      `/api/iam/group/roles/${encodeURIComponent(groupCode)}`,
    ),
  );
  // 数组归一：非数组（异常形状 / null）按空集合处理；缺 id 的脏记录降级过滤
  if (!Array.isArray(data)) return [];
  return data
    .map(mapEiamGroupRole)
    .filter((r): r is TenantGroupRole => r !== null);
}

/**
 * 给用户组分配角色（POST /api/iam/group/role/assign，契约 §1）。
 *
 * 载荷 `{group_code, role_code}`（eiam `AssignRoleRequest`，两者 binding:"required"）。
 * 被拒（重复绑定 / 无权限 / 角色不存在等）经 unwrapEnvelope 抛 ApiError，
 * message 即 eiam msg 原文，调用方须原样展示。
 */
export async function assignGroupRole(
  groupCode: string,
  roleCode: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/role/assign", {
      group_code: groupCode,
      role_code: roleCode,
    }),
  );
}

/**
 * 从用户组解绑角色（POST /api/iam/group/role/remove，契约 §1）。
 *
 * 载荷 `{group_code, role_code}`（eiam `RemoveRoleRequest`）。被拒时 message 即
 * eiam msg 原文（视图原样展示，不改写）。
 */
export async function removeGroupRole(
  groupCode: string,
  roleCode: string,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/group/role/remove", {
      group_code: groupCode,
      role_code: roleCode,
    }),
  );
}

// ---- 用户权限来源：user → groups 只读反查（feat-user-permission-sources 契约 §1 / §2.1）----

/** attached/user 单次取前若干条的条数（本面板不做分页，取接口上限内的前 N 条） */
const USER_GROUPS_LIMIT = 100;

/**
 * 归一 attached/user 响应 → `TenantGroup[]`。
 *
 * eiam 出参为 `ListGroupsResponse{total, groups[]}`（group/vo.go；与 group/list 同款），
 * 另兼容**裸数组**。复用既有 `toGroupPage`（缺 id 脏项过滤、total 缺省按 items 长度）；
 * 非对象 / 缺 `groups` 键 / 非数组 → 空数组，**不抛**。
 */
function toUserGroupList(raw: unknown): TenantGroup[] {
  if (Array.isArray(raw)) return toGroupPage({ groups: raw }).items;
  return toGroupPage(raw).items;
}

/**
 * 用户所属分组（POST /api/iam/group/list/attached/user；权限 `iam:group:view_user_groups`）。
 *
 * 载荷 `{user_id, offset, limit, keyword}` —— eiam `ListAttachedUserGroupsRequest` 支持
 * offset / limit / keyword（eiam/internal/web/group/vo.go:20-26），本面板不分页，
 * 固定 `offset=0 / limit=USER_GROUPS_LIMIT / keyword=""`。
 *
 * 只读：分组增删、组成员、组角色变更一律不在本函数职责内（另有既有入口）。
 */
export async function listGroupsForUser(
  userId: number,
): Promise<TenantGroup[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/group/list/attached/user", {
      user_id: userId,
      offset: 0,
      limit: USER_GROUPS_LIMIT,
      keyword: "",
    }),
  );
  return toUserGroupList(data);
}

// ---- 角色关联用户组：role → groups 只读反查（feat-role-bound-groups 契约 §2.2）----

/**
 * 归一 attached/role 响应 → `Page<TenantGroup>`。
 *
 * eiam 出参为 `ListAttachedRoleGroupsResponse{total, groups[]}`（group/vo.go，与
 * attached/user 同款），另兼容**裸数组**（契约 §1「响应形状以既有实现为准…必须在 api 层归一」）。
 * 复用既有 `toGroupPage`：缺 id 脏项过滤、`total` 缺失 / 非有限数按归一后 items 长度；
 * 非对象 / 缺 `groups` 键 / 非数组 → 空页，**不抛**。
 */
function toRoleGroupPage(raw: unknown): Page<TenantGroup> {
  if (Array.isArray(raw)) return toGroupPage({ groups: raw });
  return toGroupPage(raw);
}

/**
 * 角色关联的用户组（POST /api/iam/group/list/attached/role；
 * 权限 `iam:group:view_role_groups`，eiam group/handler.go:61）。
 *
 * 载荷 `{role_code, offset, limit, keyword}` —— eiam `ListAttachedRoleGroupsRequest`
 * （group/vo.go，`role_code` binding:"required"；offset / limit / keyword 服务端真支持）。
 * 与 `listGroupsForUser` 的差异：该端点入参是 **角色 code**（非 id），且本面板按契约
 * 返回**分页归一形** `Page<TenantGroup>`（视图取前若干条，不做分页器）。
 *
 * `role_code` 缺失（空串）→ 直接返回空页、**不发请求**（契约 §1「缺 role_code 过滤」；
 * 也避免 eiam 侧 binding:"required" 直接 400 把可用区域变成错误态）。
 *
 * 只读：本函数只读反查，组增删改 / 组成员 / 组角色变更各有既有入口，一律不在职责内。
 */
export async function listGroupsForRole(
  roleCode: string,
  q: ListQuery,
): Promise<Page<TenantGroup>> {
  if (roleCode === "") return { total: 0, items: [] };
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/group/list/attached/role", {
      role_code: roleCode,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toRoleGroupPage(data);
}
