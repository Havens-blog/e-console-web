/**
 * 邀请域 api 客户端（feat-invitation-management 契约 §2.1）—— 邀请列表 / 创建邀请 /
 * 撤回邀请 / 加入申请列表。后端零改动（`/api/iam/invitation/*` 全就绪，**不发信**）。
 *
 * 后端端点（已存在，本切片零后端改动）：
 * - `POST   /api/iam/invitation/list`        `{ offset, limit }` → `{ total, invitations }`
 * - `POST   /api/iam/invitation/create`      `{ max_uses, expiry_days, role_codes, require_approval }`
 * - `DELETE /api/iam/invitation/revoke/:code`
 * - `POST   /api/iam/invitation/requests`    `{ offset, limit }` → `{ total, requests }`
 * - `POST   /api/iam/invitation/batch_revoke` `{ codes }`（feat-invitation-complete 契约 §1；
 *   键是 **codes**，不是 `invitation_codes`）
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封统一经 `unwrapEnvelope<T>()` 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 `{total, invitations}` / `{total, requests}` → `Page<T>.items`；
 * - eiam 出参键为 snake_case（`tenant_id` / `max_uses` / `expire_at` / `require_approval` 等）
 *   → 归一 camelCase；
 * - 邀请缺 `code`（唯一标识）/ 申请缺 `id` → 该记录过滤（脏数据不落到视图层）；
 * - 时间戳（`expire_at` / `ctime`）为 **Unix 毫秒**，缺失 / 非有限数 → undefined，
 *   由视图层经 `@/views/tenants/timestamp` 的 `formatEpochMs` 渲染（**不在此格式化**）；
 * - `total` 缺失 / 非有限数 → 按归一后 items 长度（与 group/tenant 等列表同口径）。
 *
 * 请求体只放契约声明的键：list / requests 均为 `{offset, limit}`（**无 keyword**——
 * 该端点不支持关键词，发上去会被静默忽略，属「假搜索」）；`ListQuery` 的 keyword/status
 * 不进入请求体。
 *
 * **无跨租户 Header**：invitation 端点按会话租户隔离（eiam 侧由 session 上下文解析租户），
 * 不需要 `X-Active-Tenant-ID`。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type { Envelope, ListQuery, Page } from "@/api/types";

/** 邀请（契约 §2.1 规范形；eiam 原生 snake_case 已归一） */
export interface Invitation {
  /** 邀请码（唯一标识；创建后作为 revoke 的 path 参数） */
  code: string;
  /** 发起邀请的租户 id（缺失 → undefined） */
  tenantId?: number;
  /** 租户名（缺失 → undefined） */
  tenantName?: string;
  /** 邀请人用户 id（缺失 → undefined） */
  inviterId?: number;
  /** 授予的角色码列表（缺失 / 非数组 → 空数组） */
  roleCodes: string[];
  /** 最大可用次数 */
  maxUses: number;
  /** 已用次数 */
  usedCount: number;
  /** 过期时间（Unix 毫秒；缺失 / 非有限数 → undefined，视图 '—'） */
  expireAt?: number;
  /** 是否需要审批 */
  requireApproval: boolean;
}

/** 加入申请（契约 §2.1 规范形；只读展示） */
export interface JoinRequest {
  /** 申请 id（eiam 主键；缺失 → 记录被过滤） */
  id: number;
  /** 申请人用户 id */
  userId: number;
  /** 申请人登录名 */
  username: string;
  /** 申请人昵称（缺失 → 空串，视图渲染 '—'） */
  nickname: string;
  /** 来源邀请码 */
  invitationCode: string;
  /** 申请携带的角色码列表（缺失 / 非数组 → 空数组） */
  roleCodes: string[];
  /** 申请时间（Unix 毫秒；缺失 / 非有限数 → undefined，视图 '—'） */
  ctime?: number;
}

/** 创建邀请载荷（契约 §2.1；键名即 eiam `CreateInvitationRequest` 的 snake_case） */
export interface CreateInvitationPayload {
  /** 最大可用次数（整数 ≥1） */
  maxUses: number;
  /** 有效天数（1–365） */
  expiryDays: number;
  /** 授予的角色码列表 */
  roleCodes: string[];
  /** 是否需要审批 */
  requireApproval: boolean;
}

// ---- eiam 原生形状（私有，仅本模块映射用）----

interface EiamInvitationRaw {
  code?: unknown;
  tenant_id?: unknown;
  tenant_name?: unknown;
  inviter_id?: unknown;
  role_codes?: unknown;
  max_uses?: unknown;
  used_count?: unknown;
  expire_at?: unknown;
  require_approval?: unknown;
}

interface EiamJoinRequestRaw {
  id?: unknown;
  user_id?: unknown;
  username?: unknown;
  nickname?: unknown;
  invitation_code?: unknown;
  role_codes?: unknown;
  ctime?: unknown;
}

interface EiamInvitationListResult {
  total?: unknown;
  invitations?: unknown;
}

interface EiamJoinRequestListResult {
  total?: unknown;
  requests?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 非空字符串归一（缺失 / 非字符串 → 空串） */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 有限数归一（缺失 / 非有限数 → undefined；0 原样保留） */
function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Unix 毫秒时间戳归一（缺失 / 非有限数 → undefined，视图 '—'） */
function asOptionalTimestamp(v: unknown): number | undefined {
  return asOptionalNumber(v);
}

/** 计数类数值归一：缺失 / 非有限 → 0（用量列不出现 NaN） */
function asCount(v: unknown): number {
  return asOptionalNumber(v) ?? 0;
}

/** 字符串数组归一：非数组 → []；元素非字符串的项过滤 */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

/**
 * eiam 邀请原生形 → 归一 Invitation。
 *
 * `code` 是邀请的业务主键（revoke 的 path 参数）：缺失 / 空串 → null，由调用方降级过滤
 * （与 mapEiamGroup 的缺 id 过滤同口径）。
 */
export function mapEiamInvitation(raw: unknown): Invitation | null {
  if (!isRecord(raw)) return null;
  const i = raw as EiamInvitationRaw;
  const code = asString(i.code);
  if (code === "") return null;
  return {
    code,
    tenantId: asOptionalNumber(i.tenant_id),
    tenantName: typeof i.tenant_name === "string" ? i.tenant_name : undefined,
    inviterId: asOptionalNumber(i.inviter_id),
    roleCodes: asStringArray(i.role_codes),
    maxUses: asCount(i.max_uses),
    usedCount: asCount(i.used_count),
    expireAt: asOptionalTimestamp(i.expire_at),
    requireApproval: i.require_approval === true,
  };
}

/**
 * eiam 加入申请原生形 → 归一 JoinRequest。
 *
 * 缺 `id`（非正数 / 非数值）→ null，由调用方降级过滤。
 */
export function mapEiamJoinRequest(raw: unknown): JoinRequest | null {
  if (!isRecord(raw)) return null;
  const r = raw as EiamJoinRequestRaw;
  const id = r.id;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    userId: asCount(r.user_id),
    username: asString(r.username),
    nickname: asString(r.nickname),
    invitationCode: asString(r.invitation_code),
    roleCodes: asStringArray(r.role_codes),
    ctime: asOptionalTimestamp(r.ctime),
  };
}

/** 归一 eiam `{total, invitations}` → `Page<Invitation>`（过滤 null，total 缺省按 items 长度） */
function toInvitationPage(raw: unknown): Page<Invitation> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamInvitationListResult;
  const list = Array.isArray(result.invitations) ? result.invitations : [];
  const items = list
    .map(mapEiamInvitation)
    .filter((i): i is Invitation => i !== null);
  return {
    total: asOptionalNumber(result.total) ?? items.length,
    items,
  };
}

/** 归一 eiam `{total, requests}` → `Page<JoinRequest>`（过滤 null，total 缺省按 items 长度） */
function toJoinRequestPage(raw: unknown): Page<JoinRequest> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamJoinRequestListResult;
  const list = Array.isArray(result.requests) ? result.requests : [];
  const items = list
    .map(mapEiamJoinRequest)
    .filter((r): r is JoinRequest => r !== null);
  return {
    total: asOptionalNumber(result.total) ?? items.length,
    items,
  };
}

// ---- 邀请接口（契约 §1 / §2.1）----

/**
 * 邀请列表（POST /api/iam/invitation/list）。
 * 载荷仅 `{offset, limit}`（契约 §1；该端点无 keyword / status 维度）。
 */
export async function listInvitations(q: ListQuery): Promise<Page<Invitation>> {
  const data = await unwrapEnvelope<EiamInvitationListResult>(
    eiamAxios.post<Envelope<EiamInvitationListResult>>(
      "/api/iam/invitation/list",
      {
        offset: q.offset,
        limit: q.limit,
      },
    ),
  );
  return toInvitationPage(data);
}

/**
 * 创建邀请（POST /api/iam/invitation/create）。
 *
 * 载荷键名必须是 eiam 的 snake_case（`max_uses` / `expiry_days` / `role_codes` /
 * `require_approval`，契约 §1 逐字）；返回 void —— 该端点不回传新记录，列表由调用方重拉。
 * 被拒（无权限 / 参数非法等）经 unwrapEnvelope 抛 ApiError，message 即 eiam msg 原文。
 */
export async function createInvitation(
  p: CreateInvitationPayload,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/invitation/create", {
      max_uses: p.maxUses,
      expiry_days: p.expiryDays,
      role_codes: p.roleCodes,
      require_approval: p.requireApproval,
    }),
  );
}

/**
 * 撤回邀请（DELETE /api/iam/invitation/revoke/:code）。
 *
 * 邀请码是 path 参数，必须 `encodeURIComponent`（邀请码可能含 `/`、`+` 等字符，
 * 不编码会把路径拆错）；删除后由调用方重拉列表。
 */
export async function revokeInvitation(code: string): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(
      `/api/iam/invitation/revoke/${encodeURIComponent(code)}`,
    ),
  );
}

/**
 * 批量撤回邀请（POST /api/iam/invitation/batch_revoke，feat-invitation-complete 契约 §1 / §2.1）。
 *
 * 载荷键名精确为 `codes`（契约 §1 明示：**不是** `invitation_codes`——错键会被 eiam 静默丢弃，
 * 表现为「点了批量撤回但服务端没撤回」。空数组照样上行（不在本地臆造拦截，由服务端判定）。
 *
 * 返回 void：该端点不回传逐条结果，列表由调用方重拉；被拒（无权限 / 邀请码不存在 / 已失效等）
 * 经 unwrapEnvelope 抛 ApiError，message 即 eiam msg 原文（**不得改写**，含部分失败场景）。
 */
export async function batchRevokeInvitations(codes: string[]): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/invitation/batch_revoke", { codes }),
  );
}

/**
 * 加入申请列表（POST /api/iam/invitation/requests）。
 * 载荷仅 `{offset, limit}`（契约 §1）；只读，本切片不含「处理申请」。
 */
export async function listJoinRequests(
  q: ListQuery,
): Promise<Page<JoinRequest>> {
  const data = await unwrapEnvelope<EiamJoinRequestListResult>(
    eiamAxios.post<Envelope<EiamJoinRequestListResult>>(
      "/api/iam/invitation/requests",
      {
        offset: q.offset,
        limit: q.limit,
      },
    ),
  );
  return toJoinRequestPage(data);
}

/**
 * 处理加入申请（POST /api/iam/invitation/requests/handle）。
 *
 * 载荷键精确为 `{id, approve}`（对应 eiam `HandleJoinRequestReq{ID,Approve}`；
 * approve=true 通过、false 拒绝）。
 *
 * 为什么补这个函数：后端已实现该端点（权限 iam:invitation:handle_request），
 * 但前端此前**既无 api 函数也无视图调用** —— 权限码在 console 侧零使用，
 * 管理员看不到待审申请的处理入口（"已实现却无视图调用"）。
 *
 * 返回 void：该端点不回传逐条结果，列表由调用方重拉；被拒（无权限 / 申请已被处理 /
 * 无权处理该申请）经 unwrapEnvelope 抛 ApiError，message 即 eiam msg 原文（不得改写）。
 */
export async function handleJoinRequest(id: number, approve: boolean): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/invitation/requests/handle", {
      id,
      approve,
    }),
  );
}
