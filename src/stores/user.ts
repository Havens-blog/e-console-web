/**
 * 用户/会话 store —— 全局 3 个 store 之一（tech-design Architecture Store 清单）。
 *
 * 职责：拉取 `GET /api/iam/user/profile` 并归一为 ProfileData（user/permissions/tenants/
 * currentTenantId/isAdmin/mustSelectTenant）。**租户上下文不在此持有**——currentTenantId
 * 是经 tenant store 的只读委托（Hard Rule：租户上下文唯一归属 tenant.ts）。
 *
 * Phase 0 finding **F-1**（parity §6.1.4 / §6.2.1）：profile 的 `must_select_tenant` 字段
 * **恒 false**（profile handler 未赋值、零值序列化）——多租户分流判定**不得依赖该字段**，
 * 改由前端自算 `tenants.length > 1`（e-cam-web TenantSelector.vue:3 同款佐证）。本 store
 * 的 `mustSelectTenant` 即此计算值，profile 原字段不参与。
 *
 * 错误渲染口径（task 2.4 eiam error-shape）：profile 失败归位 error，文案取
 * `contractText(String(code))`（已知业务码契约文案）/ `ApiError.message`（未知回退），
 * 零二次映射。
 *
 * fetch 前中断在途请求（AbortController，AC-3）。
 *
 * 持久化口径（Hard Rule）：会话态不落 localStorage——本 store **不声明 persist**。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import { ApiError, type Tenant } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import { useTenantStore } from "./tenant";

// ---- profile 归一结果 ----

/**
 * profile 拉取后的「我的信息」（工作台 UF-3 渲染源）。
 * 仅取 profile user 对象的展示字段（camelCase 归一）；域 User 模型的 roles/tenantId/
 * loginMethod/passkeyRegistered 等属用户管理页（UF-4）数据源，不在此回填。
 */
export interface ProfileUser {
  id: number;
  username: string;
  /** nickname 缺失或空串时回退 username（避免界面空白用户名，e-cam-web user-mapper 同款） */
  displayName: string;
  email?: string;
  avatar?: string;
  title?: string;
  phone?: string;
}

/** profile 归一结果（ProfileData 形状，tech-design §Interfaces） */
export interface ProfileData {
  user: ProfileUser;
  permissions: string[];
  tenants: Tenant[];
  /** 0 = 无租户上下文（零租户用户 / profile 未拉取） */
  currentTenantId: number;
  /** 用户个人偏好的默认登录租户（0=未设置）；下次登录 eiam 优先落入 */
  defaultTenantId: number;
  isAdmin: boolean;
  /** 多租户分流信号；F-1：前端自算 tenants.length > 1，不取 profile 恒 false 字段 */
  mustSelectTenant: boolean;
}

// ---- eiam 原生形状（私有，仅本 store 映射用；snake_case 不越出本模块）----

interface EiamProfileUser {
  id?: number;
  username?: string;
  nickname?: string;
  email?: string;
  avatar?: string;
  job_title?: string;
  phone?: string;
}

interface EiamProfileData {
  user?: EiamProfileUser;
  permissions?: unknown;
  tenants?: { id?: number; name?: string; code?: string; domain?: string }[];
  current_tenant_id?: number;
  default_tenant_id?: number;
  is_admin?: boolean;
  // must_select_tenant 恒 false（F-1），不读取
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

function mapTenants(v: unknown): Tenant[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isRecord).map((t) => ({
    id: asNumber(t.id),
    name: asString(t.name) ?? "",
    code: asString(t.code) ?? "",
    domain: asString(t.domain) ?? "",
  }));
}

/**
 * eiam profile data → 归一 ProfileData。输入非法（缺 user / 缺 user.id）返回 null，
 * 由调用方决定降级行为（与 e-cam-web mapEiamProfile 同款契约）。
 */
function mapProfile(rawData: unknown): ProfileData | null {
  if (!isRecord(rawData)) return null;
  const rawUser = rawData.user;
  if (!isRecord(rawUser)) return null;
  if (typeof rawUser.id !== "number") return null;

  const username = asString(rawUser.username) ?? "";
  const tenants = mapTenants(rawData.tenants);
  return {
    user: {
      id: rawUser.id,
      username,
      displayName: asString(rawUser.nickname) ?? username,
      email: asString(rawUser.email),
      avatar: asString(rawUser.avatar),
      title: asString((rawUser as Record<string, unknown>).job_title),
      phone: asString((rawUser as Record<string, unknown>).phone),
    },
    permissions: Array.isArray(rawData.permissions)
      ? rawData.permissions.filter((p): p is string => typeof p === "string")
      : [],
    tenants,
    currentTenantId: asNumber(rawData.current_tenant_id),
    defaultTenantId: asNumber(rawData.default_tenant_id),
    isAdmin: rawData.is_admin === true,
    // F-1：profile must_select_tenant 恒 false，前端自算 tenants.length > 1
    mustSelectTenant: tenants.length > 1,
  };
}

/**
 * 任意抛出值 → ApiError → 文案（contractText(code)/message 回退，task 2.4）。
 * 已知业务码取契约逐字文案；未知 code 回退 ApiError.message 原文，零二次映射。
 */
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
    : "获取用户信息失败";
}

export const useUserStore = defineStore("user", () => {
  const profile = ref<ProfileUser | null>(null);
  const permissions = ref<string[]>([]);
  const tenants = ref<Tenant[]>([]);
  const isAdmin = ref<boolean>(false);
  /** 用户个人偏好的默认登录租户（0=未设置）；由 fetchProfile 从 profile 同步 */
  const defaultTenantId = ref<number>(0);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);
  /**
   * eiam 鉴权服务不可用（profile 拉取失败且 kind=unavailable，即 5xx/网络错，非 401 未认证）。
   * 守卫据此裁决：401→跳登录 vs 5xx→放行工作台渲染降级横幅（watchalert F 产品缺口，tech-design §7）。
   */
  const authUnavailable = ref<boolean>(false);

  /**
   * 多租户分流信号（F-1：前端自算 tenants.length > 1，不取 profile 恒 false 字段）。
   * computed over tenants，tenants 变即重算。
   */
  const mustSelectTenant = computed<boolean>(() => tenants.value.length > 1);

  /**
   * 当前租户上下文（Hard Rule：唯一归属 tenant.ts）。本 store 不持有独立 ref，
   * 经 tenant store 只读委托——router 守卫（2.6）按 Integration 6 读「user store 的
   * currentTenantId」即此委托，真值 ref 在 tenant store。
   */
  const currentTenantId = computed<number>(
    () => useTenantStore().currentTenantId,
  );

  /** 在途 profile 拉取的 AbortController（fetch 前中断在途请求，AC-3） */
  let profileAbort: AbortController | null = null;

  /**
   * 拉取 eiam profile 并归一。
   * - fetch 前中断在途请求（AbortController）；
   * - 成功 → 写入 profile/permissions/tenants/isAdmin + 同步 currentTenantId 到 tenant store
   *   （租户上下文唯一归属 tenant.ts）；
   * - 失败 → 归位 error（contractText 回退）+ 复位派生字段（避免渲染陈旧会话数据）；
   * - 返回布尔成功值（router 守卫 2.6 据此决定跳登录 / 放行）。
   */
  async function fetchProfile(): Promise<boolean> {
    if (profileAbort) {
      profileAbort.abort();
    }
    const abort = new AbortController();
    profileAbort = abort;

    loading.value = true;
    error.value = null;
    try {
      const data = await unwrapEnvelope<EiamProfileData>(
        eiamAxios.get("/api/iam/user/profile", { signal: abort.signal }),
      );
      const mapped = mapProfile(data);
      if (!mapped) {
        // 载荷无法解析：按未登录处理（与 e-cam-web user-mapper 同款降级）
        resetDerivedState();
        error.value = "获取用户信息失败";
        return false;
      }
      profile.value = mapped.user;
      permissions.value = mapped.permissions;
      tenants.value = mapped.tenants;
      isAdmin.value = mapped.isAdmin;
      authUnavailable.value = false;
      // 租户上下文同步到 tenant store（唯一归属）——经 setCurrentTenantId 写入
      useTenantStore().setCurrentTenantId(mapped.currentTenantId);
      defaultTenantId.value = mapped.defaultTenantId;
      return true;
    } catch (err) {
      // 被 abort 的在途请求不算错误（新一轮 fetch 已接管）
      if (abort.signal.aborted) return false;
      resetDerivedState();
      error.value = errorMessage(err);
      // 401/业务错 → unauthorized 等（守卫跳登录）；5xx/网络错 → unavailable（守卫放行工作台降级横幅）
      authUnavailable.value = err instanceof ApiError && err.kind === "unavailable";
      return false;
    } finally {
      // 仅当本请求仍是当前在途请求时复位 loading/profileAbort；
      // 被更新的 fetchProfile 中断后，loading 由新请求接管，此处不复位避免覆盖。
      if (profileAbort === abort) {
        profileAbort = null;
        loading.value = false;
      }
    }
  }

  /** 复位派生会话字段（profile 失败 / 登出 / 401 收敛由调用方触发） */
  function resetDerivedState(): void {
    profile.value = null;
    permissions.value = [];
    tenants.value = [];
    isAdmin.value = false;
    defaultTenantId.value = 0;
    error.value = null;
    authUnavailable.value = false;
  }

  /** 权限码判定（菜单裁剪 / 按钮隐藏 / 路由守卫 ③ 裁剪同口径） */
  function hasPermission(code: string): boolean {
    return permissions.value.includes(code);
  }

  /** 完整复位（登出链路：复位本 store 派生字段 + tenant store 上下文） */
  function resetState(): void {
    if (profileAbort) {
      profileAbort.abort();
      profileAbort = null;
    }
    resetDerivedState();
    loading.value = false;
    useTenantStore().resetState();
  }

  return {
    profile,
    permissions,
    tenants,
    isAdmin,
    mustSelectTenant,
    currentTenantId,
    defaultTenantId,
    loading,
    error,
    authUnavailable,
    fetchProfile,
    hasPermission,
    resetState,
  };
});
