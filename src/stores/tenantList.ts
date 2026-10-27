/**
 * tenantList store（task 4.4，UF-6）—— 7 个 list store 之一，统一契约承载租户管理。
 *
 * 统一契约（TECH-frontend-state-002）：state{items, total, page, pageSize(默认 20、上限 100),
 * loading, error} + fetch/create/update/remove；AbortController fetch 前中断在途（AC-3）。
 *
 * 跨标签租户一致性（tech-design §Integration Specs 6，task 3.1 接入）：
 * - 响应回读：tenant/list 响应无租户标识 → 跳过此层（return true 放行）；
 * - 写前守卫：create/update/disable/remove 提交前 enforceWriteGuard（Hard Rule：不得绕过）。
 *
 * 禁用前置 G-4 降级（Hard Rule + tech-design Data Models 注释 + parity §3.2 line 324）：
 * - eiam 无会话计数端点、tenant 服务内无活跃会话前置校验证据；
 * - 前端**不做**自算前置会话计数校验，禁用直接提交（update status=disable）；
 * - 被 eiam 拒绝时，从拒绝消息（ApiError.message，eiam msg 原文）提取活跃会话数，
 *   写入 disableBlocked { count, message }，调用方据 tenant.disable_blocked 契约渲染
 *   （{n}=active_session_count，与表格活跃会话数列同源；列无 list 数据源降级 '—'）。
 *
 * 分页边界（E7，ui-design §边界行为约定）：
 * - page 超出总页数 → 回落最后页重查；
 * - 删除使当前页变空（末页唯一记录被删）→ 回退上一页重查；
 * - 切换 keyword / status → page 重置 1。
 *
 * 状态筛选（feat-tenant-status-filter 契约 §4.2）：
 * - status 0=全部（默认）、1=启用、2=禁用；切筛选与 keyword 同口径重置 page=1；
 * - fetch 把 status 一并交给 listTenants，后者仅在 >0 时放进请求体（0 = 不传，旧形状）；
 * - resetState 复位为 0（全部），与 keyword 清空同口径。
 *
 * 持久化口径（Hard Rule）：列表态不落 localStorage——本 store 不声明 persist。
 * 401 收敛：经 registerUnauthorizedReset 自助注册复位回调（router 2.6）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  createTenant,
  deleteTenant,
  listTenants,
  setDefaultTenant,
  updateTenant,
  type CreateTenantPayload,
  type UpdateTenantPayload,
} from "@/api/tenants";
import { ApiError, type Tenant } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import {
  assertResponseTenantMatch,
  enforceWriteGuard,
} from "@/utils/tenantGuard";
import { registerUnauthorizedReset } from "@/router";
import { useUserStore } from "@/stores/user";

/** 默认页大小（TECH-frontend-state-002：默认 20） */
const DEFAULT_PAGE_SIZE = 20;
/** 页大小上限（TECH-frontend-state-002：上限 100） */
const MAX_PAGE_SIZE = 100;
/** 租户名长度约束（UF-6 Data Binding：1–64 字符） */
export const TENANT_NAME_MIN = 1;
export const TENANT_NAME_MAX = 64;
/** 租户 code 长度约束（parity §3.2 line 320：max32） */
export const TENANT_CODE_MAX = 32;

function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

/** 任意抛出值 → 文案（contractText(code)/message 回退，与 userList/orgList 同款口径） */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code !== null) {
      const text = contractText(String(error.code));
      if (text) return text;
    }
    return error.message;
  }
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "租户操作失败";
}

/**
 * 从 eiam 拒绝消息中提取活跃会话数（G-4 降级承载）。
 * eiam 拒绝 msg 为 Go err.Error() 串（parity §3.2 类同 §2.5 department 删除被拒形态），
 * 计数嵌入在错误串中（如「tenant has 3 active sessions」）。提取首个正整数作为
 * active_session_count；提取不到（无数字）返回 0，调用方降级为渲染 eiam 原文拒绝消息。
 */
export function extractActiveSessionCount(message: string): number {
  const match = message.match(/\d+/);
  if (!match) return 0;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 禁用被拒态：活跃会话数 + eiam 拒绝原文（供调用方渲染 tenant.disable_blocked 契约） */
export interface DisableBlocked {
  /** 从拒绝消息提取的活跃会话数（0 = 未提取到，调用方降级渲染原文） */
  count: number;
  /** eiam 拒绝原文（ApiError.message，未知 code 时直接渲染） */
  message: string;
  /** 被禁用的租户 id（关联行） */
  tenantId: number;
}

/**
 * 由列表项构造「全量回传」载荷（整体覆盖式更新的硬约束）。
 *
 * 为什么局部操作也要回传全字段：eiam `dao.TenantDAO.Update` 以显式 Select 落列
 * （name/code/domain/status 与三类治理配置列），未携带即写零值；
 * 且 `UpdateTenantReq.Name` / `Code` 均为 `binding:"required"`。故禁用/启用这类
 * 「只想改一个字段」的操作，也必须带上当前行完整字段，否则：
 * ① 请求被 eiam 校验拒绝（缺 name/code）；② 即使通过也会静默清空租户治理配置。
 */
function fullUpdatePayload(
  t: Tenant | undefined,
  status: NonNullable<Tenant["status"]>,
): UpdateTenantPayload {
  return {
    id: t?.id ?? 0,
    name: t?.name,
    code: t?.code,
    domain: t?.domain,
    status,
    maxAccounts: t?.maxAccounts ?? 0,
    maxUsers: t?.maxUsers ?? 0,
    maxUserGroups: t?.maxUserGroups ?? 0,
    featureSwitch: t?.featureSwitch ?? {},
    allowedVendors: t?.allowedVendors ?? [],
  };
}

export const useTenantListStore = defineStore("tenantList", () => {
  // ---- 统一契约 state ----
  const items = ref<Tenant[]>([]);
  const total = ref<number>(0);
  const page = ref<number>(1);
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  // ---- 筛选 UI 态 ----
  /** 关键词搜索（空串 = 不过滤） */
  const keyword = ref<string>("");
  /** 状态筛选（0 = 全部；1 = 启用；2 = 禁用；契约 §2.3 语义） */
  const status = ref<number>(0);

  // ---- 禁用被拒态（G-4 降级）----
  const disableBlocked = ref<DisableBlocked | null>(null);

  /** 在途 fetch 的 AbortController（fetch 前中断在途，AC-3） */
  let fetchAbort: AbortController | null = null;

  /** 当前页总页数（上取整；total=0 时为 1 以便空态回落） */
  function totalPages(): number {
    if (total.value <= 0) return 1;
    return Math.ceil(total.value / pageSize.value);
  }

  /**
   * 拉取租户列表。
   * - fetch 前中断在途请求（AbortController）；
   * - 成功 → 响应回读（无租户标识跳过）→ 写入 state；
   * - page 超界 → 回落最后页重查（E7）；
   * - 失败 → 归位 error（contractText 回退），不复位 items。
   */
  async function fetch(): Promise<boolean> {
    if (fetchAbort) {
      fetchAbort.abort();
    }
    const abort = new AbortController();
    fetchAbort = abort;

    loading.value = true;
    error.value = null;
    try {
      const offset = (page.value - 1) * pageSize.value;
      const q = {
        offset,
        limit: pageSize.value,
        keyword: keyword.value,
        // 0 = 不过滤：api 层据此不把 status 放进请求体（旧请求形状不变）
        status: status.value,
      };
      const result = await listTenants(q);
      if (abort.signal.aborted) return false;
      // 响应回读：tenant/list 响应无 response 级租户标识 → 跳过此层（return true 放行）
      assertResponseTenantMatch(undefined);
      items.value = result.items;
      total.value = result.total;
      // E7：page 超出总页数 → 回落最后页重查（仅当当前 page > 总页数且 total>0）
      const last = totalPages();
      if (page.value > last && total.value > 0) {
        page.value = last;
        return fetch();
      }
      return true;
    } catch (err) {
      if (abort.signal.aborted) return false;
      error.value = errorMessage(err);
      return false;
    } finally {
      if (fetchAbort === abort) {
        fetchAbort = null;
        loading.value = false;
      }
    }
  }

  /**
   * 新增租户（写前守卫 → createTenant → 回第一页刷新）。
   * 唯一性冲突（validation.name_exists）由 eiam 反馈，store 归位 error 供调用方渲染。
   * @returns 新 id；失败返回 null + 归位 error
   */
  async function create(payload: CreateTenantPayload): Promise<number | null> {
    // 写前守卫（Hard Rule：不得绕过）；不一致 → reload 自愈，返回 null
    if (!enforceWriteGuard()) return null;
    // 清空禁用被拒态（新操作重置）
    disableBlocked.value = null;
    try {
      const id = await createTenant(payload);
      // 新增后回到第一页刷新
      page.value = 1;
      await fetch();
      return id;
    } catch (err) {
      error.value = errorMessage(err);
      return null;
    }
  }

  /**
   * 更新租户（写前守卫 → updateTenant → 刷新）。
   * 唯一性冲突（validation.name_exists）/ 并发冲突（save.conflict）由 eiam 反馈。
   */
  async function update(payload: UpdateTenantPayload): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    disableBlocked.value = null;
    try {
      await updateTenant(payload);
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 禁用租户（G-4 降级承载）。
   *
   * 前端**不做**自算前置活跃会话数校验（无端点）——直接提交 update(status=disable)。
   * - 成功 → 刷新列表；
   * - 被 eiam 拒绝（活跃会话>0）→ 从拒绝消息提取 active_session_count，
   *   写入 disableBlocked 供调用方渲染 tenant.disable_blocked 契约（Hard Rule 硬门槛）。
   *
   * @returns true=禁用成功；false=被拒或失败（disableBlocked 携带活跃会话数）
   */
  async function disable(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    disableBlocked.value = null;
    const current = items.value.find((t) => t.id === id);
    try {
      // 全量回传（eiam UpdateTenantReq name/code required + dao 整体覆盖式落列）
      await updateTenant(fullUpdatePayload(current, "disable"));
      await fetch();
      return true;
    } catch (err) {
      const message = errorMessage(err);
      const count = extractActiveSessionCount(message);
      disableBlocked.value = { count, message, tenantId: id };
      error.value = message;
      return false;
    }
  }

  /** 启用租户（update status=active，无前置校验；同样需全量回传） */
  async function enable(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    disableBlocked.value = null;
    const current = items.value.find((t) => t.id === id);
    try {
      await updateTenant(fullUpdatePayload(current, "active"));
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 设置默认登录租户（当前登录用户自己的偏好，下次登录直接落入）。
   *
   * 操作的是「当前登录用户」的 default_tenant_id，不是改租户本身——eiam 经
   * user/default_tenant 端点持久化，switch 不覆盖。成功后本地同步 user store 的
   * defaultTenantId（避免重拉 profile；列表页据此标记当前默认项）。
   *
   * @returns true=设置成功；false=失败（error 归位）
   */
  async function setDefault(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    disableBlocked.value = null;
    try {
      await setDefaultTenant(id);
      // 本地同步 user store 的默认租户标记（不重拉 profile，避免副作用）
      useUserStore().defaultTenantId = id;
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 删除租户（写前守卫 → deleteTenant → E7 末页回退）。
   * 依赖删除由 eiam 服务端拒绝，重新抛出供调用方渲染。
   */
  async function remove(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    disableBlocked.value = null;
    try {
      await deleteTenant(id);
      const last = totalPages();
      if (page.value > 1 && page.value > last) {
        page.value = Math.max(1, last);
      }
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    }
  }

  // ---- 筛选/分页 UI 态 setters（切过滤重置 page=1，E7）----

  /** 设置关键词搜索（重置 page=1，E7） */
  function setKeyword(value: string): void {
    keyword.value = value;
    page.value = 1;
  }

  /**
   * 设置状态筛选（重置 page=1，与 setKeyword 同口径，E7 / 契约 §4.2）。
   * 非法值不在此处特判：非 0/1/2 由后端按契约返回空结果（§2.3），前端不臆造过滤。
   */
  function setStatus(value: number): void {
    status.value = value;
    page.value = 1;
  }

  /** 设置当前页（超界由 fetch 回落，E7） */
  function setPage(p: number): void {
    page.value = p < 1 ? 1 : p;
  }

  /** 设置页大小（重置 page=1） */
  function setPageSize(size: number): void {
    pageSize.value = clampPageSize(size);
    page.value = 1;
  }

  /** 清空禁用被拒态（关闭弹窗时调用） */
  function clearDisableBlocked(): void {
    disableBlocked.value = null;
  }

  /** 复位（401 收敛 / 离开页面由调用方触发） */
  function resetState(): void {
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
    items.value = [];
    total.value = 0;
    page.value = 1;
    pageSize.value = DEFAULT_PAGE_SIZE;
    loading.value = false;
    error.value = null;
    keyword.value = "";
    status.value = 0;
    disableBlocked.value = null;
  }

  // 自助注册 401 复位回调（router 2.6 单点扩展，避免守卫反向依赖本 store）
  registerUnauthorizedReset(resetState);

  return {
    // 统一契约 state
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    // 筛选 UI 态
    keyword,
    status,
    // 禁用被拒态（G-4）
    disableBlocked,
    // actions
    fetch,
    create,
    update,
    disable,
    enable,
    setDefault,
    remove,
    setKeyword,
    setStatus,
    setPage,
    setPageSize,
    clearDisableBlocked,
    resetState,
  };
});
