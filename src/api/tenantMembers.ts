/**
 * 租户成员域 api 客户端（feat-tenant-members-ui 契约 §1.2/§1.3 + §2.1）。
 *
 * 端点（均已存在，后端零改动）：
 * - 成员列表：POST /api/iam/tenant/members   权限 iam:tenant:view_members；
 * - 移除成员：POST /api/iam/tenant/unassign  权限 iam:tenant:unassign。
 *
 * 跨租户上下文（契约 §1.1，关键且不可省）：目标租户经请求头
 * `X-Active-Tenant-ID: <tenantId>` 指定，**每次调用都必须按当前租户 id 注入**；
 * 服务端要求会话所属租户为系统租户，否则 403（前端不做该判定，交由服务端兜底）。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 `{total, members}` → Page<TenantMember>.items；
 * - snake_case 原生键（job_title / last_login_at）→ camelCase；
 * - status 原值 int（1=活跃 / 2=禁用）复用 tenants.ts 的 normalizeTenantStatus
 *   单一口径 → 'active' | 'disable' | 'unknown'（未知值降级 unknown，不崩）；
 * - 缺 id（核心标识）的记录过滤掉；可选字段缺失 → undefined（视图渲染 '—'）。
 *
 * 错误：2xx 业务错误 / 非 2xx / 网络错一律经 unwrapEnvelope 归一为 ApiError，
 * message 即 eiam msg 原文（移除被拒时视图必须展示该原文，禁止二次改写）。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import { normalizeTenantStatus } from "@/api/tenants";
import type { Envelope, Page, TenantMember } from "@/api/types";

/** 成员列表查询入参（与 eiam 请求体同形：offset / limit / keyword） */
export interface ListTenantMembersQuery {
  offset: number;
  limit: number;
  /** 关键词（空串 = 不过滤；服务端按用户名/昵称过滤） */
  keyword: string;
}

// ---- eiam 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamTenantMemberRaw {
  id?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  /** eiam 原值 int（1=活跃 / 2=禁用）；未知值归一 'unknown' */
  status?: number;
  job_title?: string;
  /** 最近登录时间（秒级时间戳） */
  last_login_at?: number;
  ctime?: number;
}

interface EiamTenantMemberListResult {
  total?: number;
  members?: unknown[];
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
 * 可选秒级时间戳 → number | undefined。
 * 字段缺失 / null / 非有限数 → undefined（视图渲染 '—'）；
 * 0 保留原值（后端未记录登录时间），由视图按「<= 0 视为未登录」展示。
 */
function asOptionalTimestamp(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * eiam 成员原生形状 → 归一 TenantMember。
 * 缺 id（核心标识）返回 null，由调用方降级过滤。
 * status 经 int→字符串归一（复用 normalizeTenantStatus 单一口径）；
 * 可选字段缺失 → undefined，不补假值。
 */
export function mapEiamTenantMember(raw: unknown): TenantMember | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const m = raw as EiamTenantMemberRaw;
  return {
    id,
    username: asString(m.username) ?? "",
    nickname: asString(m.nickname) ?? "",
    avatar: asString(m.avatar),
    email: asString(m.email),
    status: normalizeTenantStatus(m.status),
    jobTitle: asString(m.job_title),
    lastLoginAt: asOptionalTimestamp(m.last_login_at),
    ctime: asOptionalTimestamp(m.ctime),
  };
}

/** 归一 eiam `{total, members}` → Page<TenantMember>（过滤 null，total 缺省按 items 长度） */
function toTenantMemberPage(raw: unknown): Page<TenantMember> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamTenantMemberListResult;
  const members = Array.isArray(result.members) ? result.members : [];
  const items = members
    .map(mapEiamTenantMember)
    .filter((m): m is TenantMember => m !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

/**
 * 租户成员列表（POST /api/iam/tenant/members，契约 §1.2）。
 *
 * 跨租户 Header 固定按入参 tenantId 注入（不使用全局当前租户），避免串租户数据。
 * 响应 `{total, members}` 归一为 Page<TenantMember>。
 */
export async function listTenantMembers(
  tenantId: number,
  q: ListTenantMembersQuery,
): Promise<Page<TenantMember>> {
  const data = await unwrapEnvelope<EiamTenantMemberListResult>(
    eiamAxios.post<Envelope<EiamTenantMemberListResult>>(
      "/api/iam/tenant/members",
      {
        offset: q.offset,
        limit: q.limit,
        keyword: q.keyword,
      },
      { headers: { "X-Active-Tenant-ID": String(tenantId) } },
    ),
  );
  return toTenantMemberPage(data);
}

/**
 * 移除租户成员（POST /api/iam/tenant/unassign，契约 §1.3）。
 *
 * 载荷 `{user_id}`；同样必须携带 `X-Active-Tenant-ID` 指定目标租户。
 * 被拒（4020910 移除自己 / 4020909 移除 admin / 4020907 其他）经 unwrapEnvelope
 * 抛 ApiError，message 即 eiam msg 原文，调用方必须原样展示。
 */
export async function removeTenantMember(
  tenantId: number,
  userId: number,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>(
      "/api/iam/tenant/unassign",
      { user_id: userId },
      { headers: { "X-Active-Tenant-ID": String(tenantId) } },
    ),
  );
}
