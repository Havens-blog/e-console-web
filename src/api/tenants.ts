/**
 * 租户域 api 客户端（task 4.4，UF-6）—— 列表/详情/增删改 + 禁用前置 G-4 降级承载。
 *
 * 端点证据等级（tech-design §Interfaces + parity-checklist §3.2）：
 * - A 档（实核）：tenant/list（`{total, tenants}`，TenantVO 含 status/ctime）。
 * - C 档（路径实存、形状待核验）：tenant/create `{name, code}`、
 *   tenant/update `{id, name, code, domain, status(int 1/2)}`、
 *   tenant/delete/:id、tenant/detail/:id。
 *   （禁用经 update 承载——status int 语义 1=活跃/2=禁用，无独立 toggle 端点。）
 * - **G-4 缺口**（parity §3.2 line 324）：eiam 无任何会话计数端点，tenant 服务内无活跃会话
 *   前置校验证据 → 禁用前置降级（tech-design Data Models 注释）：前端不做自算前置校验，
 *   禁用直接提交 update(status=disable)，被 eiam 拒绝时由拒绝消息携带活跃会话数展示
 *   （tenant.disable_blocked 契约 {n}=active_session_count，与表格列同源）。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - eiam 分页键 {total, tenants} → Page<Tenant>.items；
 * - TenantVO.status 原值 int（1/2）归一为字符串词表 'active'|'disable'|'unknown'
 *   （与 User.status 同款 normalizeStatus 口径，复用 StatusBadge，G-9 不引入 locked）；
 * - 用量计数 user_count / user_group_count → userCount / userGroupCount，**不补 0**：
 *   缺失/null → undefined（视图 '—'，契约 §4.1），number（含 0）→ 原值；
 * - 其余 snake_case 键（无）一律 camelCase 归一。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type { Envelope, ListQuery, Page, Tenant } from "@/api/types";

// ---- eiam 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamTenantRaw {
  id?: number;
  name?: string;
  code?: string;
  domain?: string;
  /**
   * eiam 原值 int（1=活跃 / 2=禁用，parity §3.2 line 321）。
   * 未知值（null/0/其余）归一 'unknown'。
   */
  status?: number;
  /** 创建时间（秒级时间戳，TenantVO 原样出参；缺失 / 非有限数 → undefined） */
  ctime?: number;
  /** 三类治理配置（tenant-management spec 需求 2/6/7；eiam vo.go:65-78 原样出参） */
  max_accounts?: number;
  max_users?: number;
  max_user_groups?: number;
  feature_switch?: Record<string, boolean> | null;
  allowed_vendors?: string[] | null;
  /**
   * 用量统计（tenant-management spec 需求 5；feat-tenant-usage-stats）。
   * 契约 §2.2：int64，字段始终存在（非 omitempty）；缺失/null 表示统计不可用。
   */
  user_count?: number | null;
  user_group_count?: number | null;
}

interface EiamTenantListResult {
  total?: number;
  tenants?: unknown[];
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
 * 用量计数字段 → number | undefined（**不补齐 0**，契约 §4.1）。
 * - 字段缺失 / null / 非 number / 非有限数（NaN、Infinity）→ undefined：视图渲染 '—'；
 * - 字段为有限 number（含 0）→ 原值：0 是「真实为零」，与 undefined 展示不同。
 * 与上方 asNumber（治理配置，缺失补 0 = 不限制）刻意区分：两者零值语义相反。
 */
function asOptionalCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * eiam `feature_switch` → 规范化 Record<string, boolean>。
 * 只保留值为 boolean 的键（后端为 map[string]bool，理论上全是布尔；
 * 防御性过滤避免脏数据把非布尔值带进视图层）。
 */
function asBoolMap(v: unknown): Record<string, boolean> {
  if (!isRecord(v)) return {};
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "boolean") out[k] = val;
  }
  return out;
}

/** eiam `allowed_vendors` → 字符串数组（过滤非字符串 / 空串，去重保序） */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item !== "" && !out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * eiam status 原值 int → 字符串词表归一（租户 / 租户成员共用单一出口）。
 * - 1 → 'active'；2 → 'disable'；其余（null/undefined/0/未知）→ 'unknown'
 *   （与 User.status normalizeStatus 同款口径，复用 StatusBadge，G-9 不引入 locked）。
 * TenantVO.status 与成员 MemberVO.status 同为 int 1/2 语义，故 tenantMembers.ts
 * 直接复用本函数，避免两处口径漂移。
 */
export function normalizeTenantStatus(raw: unknown): Tenant["status"] {
  if (raw === 1) return "active";
  if (raw === 2) return "disable";
  return "unknown";
}

/**
 * eiam TenantVO 原生形状 → 归一 Tenant。
 * 缺 id（核心标识）返回 null，由调用方降级过滤。
 * status 经 int→字符串归一；domain/code 缺省空串。
 * 三类治理配置一律补齐（配额 0 / 白名单 [] / 开关 {}），使视图层无需区分
 * 「无配置」与「未加载」——eiam 侧零值即无约束，补齐不改变语义。
 * 用量计数（userCount / userGroupCount）**不补齐**：残缺 → undefined（视图 '—'），
 * 0 → 0（真实为零）——见 asOptionalCount。
 */
export function mapEiamTenant(raw: unknown): Tenant | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const t = raw as EiamTenantRaw;
  return {
    id,
    name: asString(t.name) ?? "",
    code: asString(t.code) ?? "",
    domain: asString(t.domain) ?? "",
    status: normalizeTenantStatus(t.status),
    // 创建时间（契约 §2.1）：缺失 / 非有限数 → undefined（视图 '—'），有效值（含 0）原样保留
    ctime:
      typeof t.ctime === "number" && Number.isFinite(t.ctime)
        ? t.ctime
        : undefined,
    maxAccounts: asNumber(t.max_accounts),
    maxUsers: asNumber(t.max_users),
    maxUserGroups: asNumber(t.max_user_groups),
    featureSwitch: asBoolMap(t.feature_switch),
    allowedVendors: asStringArray(t.allowed_vendors),
    userCount: asOptionalCount(t.user_count),
    userGroupCount: asOptionalCount(t.user_group_count),
  };
}

/** 归一 eiam {total, tenants} → Page<Tenant>（过滤 null，total 缺省按 items 长度） */
function toTenantPage(raw: unknown): Page<Tenant> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamTenantListResult;
  const tenants = Array.isArray(result.tenants) ? result.tenants : [];
  const items = tenants
    .map(mapEiamTenant)
    .filter((t): t is Tenant => t !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

// ---- 租户 CRUD ----

/**
 * 租户列表（POST /api/iam/tenant/list，A 档实核）。
 * 载荷 {offset, limit, keyword, status?}；响应归一为 Page<Tenant>（status int→字符串）。
 *
 * 状态筛选（feat-tenant-status-filter 契约 §4.1）：仅当 `status` 有值且 > 0 时才把
 * `status` 放进请求体；缺省 / 0（= 全部）时**不传**该键，保持改动前请求形状不变
 * ——后端尚未提供该参数、或旧版本忽略未知键时，行为与改动前完全一致（优雅降级）。
 *
 * **G-4**：TenantVO 不含 active_session_count 字段（无会话计数端点）→
 * 活跃会话数列无 list 数据源，列表页降级展示 '—'。
 */
export async function listTenants(q: ListQuery): Promise<Page<Tenant>> {
  const status = q.status;
  const data = await unwrapEnvelope<EiamTenantListResult>(
    eiamAxios.post<Envelope<EiamTenantListResult>>("/api/iam/tenant/list", {
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
      // 0 / 缺省 = 不过滤：不进请求体（不改变既有请求形状）
      ...(typeof status === "number" && status > 0 ? { status } : {}),
    }),
  );
  return toTenantPage(data);
}

// ---- 用户权限来源：user → tenants 只读反查（feat-user-permission-sources 契约 §1 / §2.1）----

/**
 * 归一 attached/user 响应 → `Page<Tenant>`。
 *
 * eiam 出参为 `ListTenantRes{total, tenants[]}`（tenant/vo.go:54-58）；另兼容**裸数组**。
 * 复用既有 `toTenantPage`（status int→字符串、治理配置补齐、缺 id 脏项过滤）；
 * 非对象 / 缺键 / 非数组 → `{total:0, items:[]}`，**不抛**。
 */
function toUserTenantPage(raw: unknown): Page<Tenant> {
  if (Array.isArray(raw)) return toTenantPage({ tenants: raw });
  return toTenantPage(raw);
}

/**
 * 用户所属租户（POST /api/iam/tenant/list/attached/user；权限 `iam:tenant:view_user_tenants`）。
 *
 * 载荷 `{user_id, offset, limit, keyword}`（eiam `ListUserTenantsReq`，tenant/vo.go:51-56）。
 * 该端点在 eiam 侧经 `WithTenantOverride` 包装（跨租户读取，parity §6.3），**只读**：
 * 本函数不承担任何租户分配/移除（另有 tenant/assign 等既有入口）。
 *
 * 归一为 `Page<Tenant>`：视图层只消费 `total / items`，status 已由 api 层归一为词表。
 */
export async function listTenantsForUser(
  userId: number,
  q: ListQuery,
): Promise<Page<Tenant>> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.post<Envelope<unknown>>("/api/iam/tenant/list/attached/user", {
      user_id: userId,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toUserTenantPage(data);
}

/**
 * 租户详情（GET /api/iam/tenant/detail/:id，C 档路径实存、形状待核验）。
 * 响应归一为 Tenant（缺 id 返回 null）。
 */
export async function getTenantDetail(id: number): Promise<Tenant | null> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>(`/api/iam/tenant/detail/${id}`),
  );
  return mapEiamTenant(data);
}

/**
 * 三类治理配置载荷（create / update 共用）。
 *
 * **整体覆盖式更新约束**（eiam dao/tenant.go:228-237 显式 Select 落列）：
 * update 请求中未携带的治理字段会被写成零值（配额 0 / 白名单 NULL / 开关 NULL），
 * 等价于「清空该租户的治理配置」。因此**任何 update 调用都必须全量回传**这三个配置
 * （编辑表单回传表单值；禁用/启用等局部操作回传列表中的现值）。
 */
export interface TenantGovernancePayload {
  /** 最大云账号数（0 或负数 = 不限制） */
  maxAccounts?: number;
  /** 最大用户数（0 或负数 = 不限制） */
  maxUsers?: number;
  /** 最大用户组数（0 或负数 = 不限制） */
  maxUserGroups?: number;
  /** 功能开关映射表（空表 = 未启用差异化开关） */
  featureSwitch?: Record<string, boolean>;
  /** 云厂商白名单（空数组 = 允许全部厂商） */
  allowedVendors?: string[];
}

/**
 * 治理配置载荷 → eiam snake_case 原生形状。
 * 保持 undefined 语义：调用方未提供该字段时不进请求体（由调用方保证 update 全量回传）。
 */
function governanceToRaw(p: TenantGovernancePayload): Record<string, unknown> {
  return {
    max_accounts: p.maxAccounts,
    max_users: p.maxUsers,
    max_user_groups: p.maxUserGroups,
    feature_switch: p.featureSwitch,
    allowed_vendors: p.allowedVendors,
  };
}

/** 创建租户载荷（camelCase 规范形；code 必填、max32——parity §3.2 line 320） */
export interface CreateTenantPayload extends TenantGovernancePayload {
  /** 租户名（1–64 字符，全局唯一，冲突提示契约 validation.name_exists） */
  name: string;
  /** 租户 code（eiam 必填、max32；前端校验长度，唯一性由 eiam 反馈） */
  code: string;
  /** 域名（可选） */
  domain?: string;
}

/**
 * 创建租户（POST /api/iam/tenant/create，C 档路径实存、形状待核验）。
 * 载荷 eiam `{name, code}` + 三类治理配置（eiam CreateTenantReq 已支持，handler.go:168-176 落库）。
 * domain 经 update 后置补全（编辑态）。返回新 id。
 */
export async function createTenant(
  payload: CreateTenantPayload,
): Promise<number> {
  const id = await unwrapEnvelope<number>(
    eiamAxios.post<Envelope<number>>("/api/iam/tenant/create", {
      name: payload.name,
      code: payload.code,
      ...governanceToRaw(payload),
    }),
  );
  return id;
}

/** 更新租户载荷（UpdateTenantReq：id + name + code + domain + status int + 三类治理配置） */
export interface UpdateTenantPayload extends TenantGovernancePayload {
  id: number;
  /**
   * 全量编辑时提供；纯状态切换（disable/enable）时缺省——eiam update 载荷仅传提供字段
   * （undefined 经 JSON 序列化丢弃），禁用/启用 lever 仅靠 id + status 承载。
   */
  name?: string;
  code?: string;
  domain?: string;
  /**
   * 启用/禁用 lever（'active'→1 / 'disable'→2）。
   * 禁用经 update 承载（无独立 toggle 端点）；G-4 降级：前端不自算前置会话计数，
   * 直接提交 disable，被 eiam 拒绝时由拒绝消息携带活跃会话数展示。
   */
  status?: Tenant["status"];
}

/** 归一 Tenant.status 字符串 → eiam update 载荷 int（1=活跃 / 2=禁用） */
function statusToInt(status: NonNullable<Tenant["status"]>): number {
  if (status === "active") return 1;
  if (status === "disable") return 2;
  return 1; // unknown 兜底为活跃（不禁用，避免误禁）
}

/**
 * 更新租户（POST /api/iam/tenant/update，C 档路径实存、形状待核验）。
 * 载荷 eiam `{id, name, code, domain, status(int)}` + 三类治理配置；status int 语义 1=活跃/2=禁用。
 *
 * **整体覆盖式更新（重要）**：eiam dao/tenant.go:228-237 以显式 Select 落列，
 * 未携带的治理字段会被写为零值 = 清空配置。故调用方必须全量回传（见 TenantGovernancePayload 注释）。
 *
 * **G-4 禁用降级**：禁用（status='disable'）直接提交，前端不做活跃会话数前置校验
 * （无端点）。若 eiam 因活跃会话>0 拒绝，store catch 后从拒绝消息提取 active_session_count
 * 渲染 tenant.disable_blocked 契约。
 */
export async function updateTenant(
  payload: UpdateTenantPayload,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/tenant/update", {
      id: payload.id,
      name: payload.name,
      code: payload.code,
      domain: payload.domain,
      status:
        payload.status !== undefined ? statusToInt(payload.status) : undefined,
      ...governanceToRaw(payload),
    }),
  );
}

/**
 * 删除租户（DELETE /api/iam/tenant/delete/:id，C 档路径实存、形状待核验）。
 * 依赖删除由 eiam 服务端拒绝。
 */
export async function deleteTenant(id: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(`/api/iam/tenant/delete/${id}`),
  );
}

/**
 * 设置默认登录租户（POST /api/iam/user/default_tenant）。
 *
 * 操作的是「当前登录用户自己」的默认登录租户偏好（user.default_tenant_id），
 * 不是改租户本身——下次登录时 eiam resolveActiveTenant 优先采用该值，直接落入。
 * 与 switch 的区别：只持久化偏好、不切换当前会话，switch 不覆盖本设置。
 *
 * 落 user 域接口（操作用户字段，属个人偏好自服务，登录态即可，非平台管理员独占）。
 */
export async function setDefaultTenant(tenantId: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/user/default_tenant", {
      tenant_id: tenantId,
    }),
  );
}

/**
 * 系统管理员强制删除租户（DELETE /api/iam/tenant/force_delete/:id?confirm_name=…）。
 *
 * 与 deleteTenant 的区别：常规删除要求"租户已清空"，而创建者不可移除自己、admin 亦不可被移除，
 * 一旦租户由当前管理员创建就形成"建了删不掉"的死锁（需求 3 未覆盖的运维死锁）。
 * 本接口由系统管理员使用：会**连同该租户的成员关系与授权规则一并清除**，不可恢复。
 *
 * 二次确认：必须传与租户名完全一致的 confirmName；不一致时服务端返回 4020912 且不做任何删除。
 */
export async function forceDeleteTenant(id: number, confirmName: string): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(
      `/api/iam/tenant/force_delete/${id}?confirm_name=${encodeURIComponent(confirmName)}`,
    ),
  );
}
