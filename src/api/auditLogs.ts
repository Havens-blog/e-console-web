/**
 * 审计日志域 api 客户端（feat-audit-logs 契约 §1 / §2.2）—— 认证审计 + 操作审计两张只读列表。
 *
 * 后端零改动（eiam `internal/web/audit/handler.go:101-110` PrivateRoutes 已就绪）：
 * - `POST /api/iam/audit/auth/list`      `{ offset, limit, username?, auth_type?, status?, start_time?, end_time? }`
 *                                        → `{ total, list }`
 * - `POST /api/iam/audit/operation/list` `{ offset, limit, service?, module?, action?, status?, operator_name?,
 *                                        start_time?, end_time? }` → `{ total, list }`
 *
 * 控制台路径前缀 `/api/iam/*` 经 nginx（及 vite dev proxy）重写为 eiam `/api/*`
 * （见 src/api/request/eiam.ts 头注；契约 §1.3 已实测两处路由）。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封统一经 `unwrapEnvelope<T>()` 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 `{total, list}` → `Page<T>.items`（**键是 `list`，不是 items/records**，契约 §1 明示）；
 * - VO 出参为 snake_case（`tenant_id` / `auth_type` / `fail_reason` / `client_ip` / `user_agent` /
 *   `operator_name`）→ 归一 camelCase；
 * - 缺 `id`（非有限数 / ≤0）→ 该记录过滤（脏数据不落到视图层）；
 * - `list` 非数组（缺失 / null / 对象）→ 降级空 Page，**不抛**（契约 §2.2「非数组降级为空」）；
 * - `ctime` 为 **Unix 毫秒**，缺失 / 非有限数 → undefined，由视图层经
 *   `@/views/tenants/timestamp` 的 `formatEpochMs` 渲染（**不在此格式化**）；
 * - `total` 缺失 / 非有限数 → 按归一后 items 长度（与 invitation/group 等列表同口径）。
 *
 * 筛选键（契约 §2.2 + §1.1/§1.2 请求体）：
 * - **可选筛选键为空时不上行** —— 空串 / 纯空白 / 非有限数一律不发（避免「假筛选」：
 *   把空串发上去等于给服务端一个无意义过滤条件）；
 * - 字符串键去首尾空白后非空才上行；时间键仅有限数上行；
 * - `offset` / `limit` 恒上行（分页必需）。
 *
 * **纯只读**：本模块只有两个 list 函数，不存在任何写端点（审计日志不可编辑/删除）。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type { Envelope, Page } from "@/api/types";

/** 认证审计日志（契约 §2.2 规范形；eiam AuthLogVO 已归一） */
export interface AuthLog {
  /** 日志 id（eiam 主键；缺失 → 记录被过滤） */
  id: number;
  /** 所属租户 id（缺失 → undefined） */
  tenantId?: number;
  /** 认证用户 id（缺失 → undefined） */
  userId?: number;
  /** 认证用户名（缺失 → 空串，视图渲染 '—'） */
  username: string;
  /** 认证类型（eiam: password / ldap / oidc / passkey 等；缺失 → 空串） */
  authType: string;
  /** 认证状态（eiam domain：SUCCESS / FAIL / LOCKED；缺失 → 空串） */
  status: string;
  /** 失败原因（缺失 → undefined） */
  failReason?: string;
  /** 客户端 IP（缺失 → undefined） */
  clientIp?: string;
  /** 客户端 User-Agent（缺失 → undefined） */
  userAgent?: string;
  /** 事件时间（Unix 毫秒；缺失 / 非有限数 → undefined，视图 '—'） */
  ctime?: number;
}

/** 操作审计日志（契约 §2.2 规范形；仅契约声明的键，eiam VO 其余字段不透出视图层） */
export interface OperationLog {
  /** 日志 id（eiam 主键；缺失 → 记录被过滤） */
  id: number;
  /** 操作人名称（缺失 → undefined） */
  operatorName?: string;
  /** 所属服务（eiam: eiam / ecmdb / etask 等；缺失 → undefined） */
  service?: string;
  /** 业务模块（user / role / group 等；缺失 → undefined） */
  module?: string;
  /** 操作动作（create / update / delete / assign 等；缺失 → undefined） */
  action?: string;
  /** 操作状态（eiam domain：SUCCESS / FAIL；缺失 → undefined） */
  status?: string;
  /** 事件时间（Unix 毫秒；缺失 / 非有限数 → undefined，视图 '—'） */
  ctime?: number;
}

/** 认证审计查询（契约 §1.1 请求体的归一形；可选筛选键空值不上行） */
export interface AuthLogQuery {
  /** 分页偏移 */
  offset: number;
  /** 页大小 */
  limit: number;
  /** 用户名（空串 / 纯空白 → 不上行） */
  username?: string;
  /** 认证类型（空串 / 纯空白 → 不上行） */
  authType?: string;
  /** 状态（SUCCESS / FAIL / LOCKED；空串 → 不上行） */
  status?: string;
  /** 起始时间（Unix 毫秒；缺失 / 非有限数 → 不上行） */
  startTime?: number;
  /** 结束时间（Unix 毫秒；缺失 / 非有限数 → 不上行） */
  endTime?: number;
}

/** 操作审计查询（契约 §1.2 请求体的归一形；可选筛选键空值不上行） */
export interface OperationLogQuery {
  /** 分页偏移 */
  offset: number;
  /** 页大小 */
  limit: number;
  /** 服务（空串 / 纯空白 → 不上行） */
  service?: string;
  /** 业务模块（空串 → 不上行） */
  module?: string;
  /** 操作动作（空串 → 不上行） */
  action?: string;
  /** 状态（SUCCESS / FAIL；空串 → 不上行） */
  status?: string;
  /** 操作人名称（空串 → 不上行） */
  operatorName?: string;
  /** 起始时间（Unix 毫秒；缺失 / 非有限数 → 不上行） */
  startTime?: number;
  /** 结束时间（Unix 毫秒；缺失 / 非有限数 → 不上行） */
  endTime?: number;
}

// ---- eiam 原生形状（私有，仅本模块映射用）----

interface EiamAuthLogRaw {
  id?: unknown;
  tenant_id?: unknown;
  user_id?: unknown;
  username?: unknown;
  auth_type?: unknown;
  status?: unknown;
  fail_reason?: unknown;
  client_ip?: unknown;
  user_agent?: unknown;
  ctime?: unknown;
}

interface EiamOperationLogRaw {
  id?: unknown;
  operator_name?: unknown;
  service?: unknown;
  module?: unknown;
  action?: unknown;
  status?: unknown;
  ctime?: unknown;
}

/** eiam 两接口共同的 `{total, list}` 信封载荷（契约 §1：键名是 list） */
interface EiamAuditListResult {
  total?: unknown;
  list?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 字符串归一（缺失 / 非字符串 → 空串） */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** 可选字符串归一（缺失 / 非字符串 → undefined；空串原样保留，视图自行降级 '—'） */
function asOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 有限数归一（缺失 / 非有限数 → undefined；0 原样保留） */
function asOptionalNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * eiam 认证审计原生形 → 归一 AuthLog。
 *
 * 缺 `id`（非有限数 / ≤0）→ null，由调用方降级过滤（与 mapEiamJoinRequest 的缺 id 过滤同口径）。
 * **脏数据不抛**：任何异常输入（null / 字符串 / 数组 / 字段类型错）都返回 null 或降级值。
 */
export function mapAuthLog(raw: unknown): AuthLog | null {
  if (!isRecord(raw)) return null;
  const r = raw as EiamAuthLogRaw;
  const id = r.id;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    tenantId: asOptionalNumber(r.tenant_id),
    userId: asOptionalNumber(r.user_id),
    username: asString(r.username),
    authType: asString(r.auth_type),
    status: asString(r.status),
    failReason: asOptionalString(r.fail_reason),
    clientIp: asOptionalString(r.client_ip),
    userAgent: asOptionalString(r.user_agent),
    ctime: asOptionalNumber(r.ctime),
  };
}

/**
 * eiam 操作审计原生形 → 归一 OperationLog。
 *
 * 缺 `id`（非有限数 / ≤0）→ null，由调用方降级过滤。仅保留契约 §2.2 声明的键
 * （eiam OperationLogVO 另有 resource_* / before_state / after_state 等，不透出视图层）。
 */
export function mapOperationLog(raw: unknown): OperationLog | null {
  if (!isRecord(raw)) return null;
  const r = raw as EiamOperationLogRaw;
  const id = r.id;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    operatorName: asOptionalString(r.operator_name),
    service: asOptionalString(r.service),
    module: asOptionalString(r.module),
    action: asOptionalString(r.action),
    status: asOptionalString(r.status),
    ctime: asOptionalNumber(r.ctime),
  };
}

/**
 * 归一 eiam `{total, list}` → `Page<T>`（过滤 null，total 缺省按 items 长度）。
 *
 * `list` 非数组 → 空 Page（降级不抛）；`total` 非有限数 → items.length。
 */
function toAuditPage<T>(
  raw: unknown,
  mapItem: (item: unknown) => T | null,
): Page<T> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamAuditListResult;
  const list = Array.isArray(result.list) ? result.list : [];
  const items = list.map(mapItem).filter((item): item is T => item !== null);
  return {
    total: asOptionalNumber(result.total) ?? items.length,
    items,
  };
}

// ---- 请求体构造（契约：可选筛选键为空时不上行）----

/** 字符串筛选值归一：非字符串 / 纯空白 → undefined；否则去首尾空白 */
function filterText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 时间筛选值归一：非有限数 → undefined；非正数视为「未选」→ undefined */
function filterTime(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** 认证审计请求体（snake_case；空筛选键整键省略，契约 §2.2） */
export function buildAuthLogBody(q: AuthLogQuery): Record<string, unknown> {
  const body: Record<string, unknown> = { offset: q.offset, limit: q.limit };
  const username = filterText(q.username);
  if (username !== undefined) body.username = username;
  const authType = filterText(q.authType);
  if (authType !== undefined) body.auth_type = authType;
  const status = filterText(q.status);
  if (status !== undefined) body.status = status;
  const startTime = filterTime(q.startTime);
  if (startTime !== undefined) body.start_time = startTime;
  const endTime = filterTime(q.endTime);
  if (endTime !== undefined) body.end_time = endTime;
  return body;
}

/** 操作审计请求体（snake_case；空筛选键整键省略，契约 §2.2） */
export function buildOperationLogBody(
  q: OperationLogQuery,
): Record<string, unknown> {
  const body: Record<string, unknown> = { offset: q.offset, limit: q.limit };
  const service = filterText(q.service);
  if (service !== undefined) body.service = service;
  const module = filterText(q.module);
  if (module !== undefined) body.module = module;
  const action = filterText(q.action);
  if (action !== undefined) body.action = action;
  const status = filterText(q.status);
  if (status !== undefined) body.status = status;
  const operatorName = filterText(q.operatorName);
  if (operatorName !== undefined) body.operator_name = operatorName;
  const startTime = filterTime(q.startTime);
  if (startTime !== undefined) body.start_time = startTime;
  const endTime = filterTime(q.endTime);
  if (endTime !== undefined) body.end_time = endTime;
  return body;
}

// ---- 审计接口（契约 §1，纯只读）----

/**
 * 认证审计列表（POST /api/iam/audit/auth/list）。
 *
 * 载荷只放契约声明的键，且**空筛选键不上行**（见 buildAuthLogBody）。
 * 无权限 / 服务异常经 unwrapEnvelope 抛 ApiError，message 即 eiam msg 原文（视图原样展示）。
 */
export async function listAuthLogs(q: AuthLogQuery): Promise<Page<AuthLog>> {
  const data = await unwrapEnvelope<EiamAuditListResult>(
    eiamAxios.post<Envelope<EiamAuditListResult>>(
      "/api/iam/audit/auth/list",
      buildAuthLogBody(q),
    ),
  );
  return toAuditPage(data, mapAuthLog);
}

/**
 * 操作审计列表（POST /api/iam/audit/operation/list）。
 *
 * 同上：空筛选键不上行；`{total, list}` → `Page<OperationLog>`；缺 id 过滤；脏数据降级不抛。
 */
export async function listOperationLogs(
  q: OperationLogQuery,
): Promise<Page<OperationLog>> {
  const data = await unwrapEnvelope<EiamAuditListResult>(
    eiamAxios.post<Envelope<EiamAuditListResult>>(
      "/api/iam/audit/operation/list",
      buildOperationLogBody(q),
    ),
  );
  return toAuditPage(data, mapOperationLog);
}
