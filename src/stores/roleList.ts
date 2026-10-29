/**
 * roleList store（task 5.1，UF-8）—— 7 个 list store 之一，统一契约（TECH-frontend-state-002）。
 *
 * 统一契约：state{items, total, page, pageSize(默认 20、上限 100), loading, error}
 * + fetch/create/update/remove；AbortController fetch 前中断在途（AC-3）。
 * feat-role-batch-delete 增量：batchRemove(ids)（写前守卫 → role/batch_delete → 重拉）。
 *
 * 跨标签租户一致性（tech-design §Integration Specs 6，task 3.1 接入）：
 * - 响应回读：fetch 成功后 assertResponseTenantMatch（role/list 响应无租户标识 → 跳过此层，
 *   return true 放行渲染）；
 * - 写前守卫：create/update/remove 提交前 enforceWriteGuard（快照 vs currentTenantId，
 *   不一致 → reload 自愈 + 返回 false/阻断本次写）—— Hard Rule：写前守卫不得绕过。
 *
 * 计数 enrichment（AC-2 绑定策略数/绑定用户数列）：
 * role/list 不直出 policy_count/user_count；fetch 基本列表后并行回填——
 * - 策略数：listPoliciesForRole(code) → policyCounts[code]（cap 100，超限显示 100+）；
 * - 用户数：listUsersByRole(code, {offset:0, limit:1, keyword:""}) → userCounts[code] = total。
 * enrichment 失败降级为 0（不阻断列表渲染），与 userList 角色降级同款口径。
 *
 * 分页边界（E7）：page 超出总页数 → 回落最后页重查；删除使末页变空 → 回退上一页；
 * 切 keyword → page 重置 1。
 *
 * 持久化口径（Hard Rule）：列表态不落 localStorage——本 store 不声明 persist。
 *
 * 401 收敛：经 registerUnauthorizedReset 自助注册复位回调（router 2.6），避免守卫反向依赖。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  assignUsersToRole,
  attachPoliciesToRole,
  batchDeleteRoles,
  createRole,
  deleteRole,
  detachPoliciesFromRole,
  listPoliciesForRole,
  listRolesPage,
  unassignUsersFromRole,
  updateRole,
  type CreateRolePayload,
  type UpdateRolePayload,
} from "@/api/roles";
import { listUsersByRole } from "@/api/users";
import { ApiError, type Role } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import {
  assertResponseTenantMatch,
  enforceWriteGuard,
} from "@/utils/tenantGuard";
import { registerUnauthorizedReset } from "@/router";

/** 默认页大小（TECH-frontend-state-002：默认 20） */
const DEFAULT_PAGE_SIZE = 20;
/** 页大小上限（TECH-frontend-state-002：上限 100） */
const MAX_PAGE_SIZE = 100;
/** 策略计数 enrichment 上限（超限显示 100+） */
const POLICY_COUNT_CAP = 100;

function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

/** 任意抛出值 → 文案（contractText(code)/message 回退，与 userList store 同款口径） */
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
    : "角色操作失败";
}

export const useRoleListStore = defineStore("roleList", () => {
  // ---- 统一契约 state ----
  const items = ref<Role[]>([]);
  const total = ref<number>(0);
  const page = ref<number>(1);
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  // ---- 筛选 UI 态 ----
  /** 关键词搜索（空串 = 不过滤） */
  const keyword = ref<string>("");

  // ---- 计数 enrichment（AC-2 绑定策略数/绑定用户数；role/list 不直出）----
  /** 角色 code → 绑定策略数（cap POLICY_COUNT_CAP；enrichment 失败缺省 0） */
  const policyCounts = ref<Record<string, number>>({});
  /** 角色 code → 绑定用户数（listUsersByRole total；enrichment 失败缺省 0） */
  const userCounts = ref<Record<string, number>>({});

  /** 在途 fetch 的 AbortController（fetch 前中断在途，AC-3） */
  let fetchAbort: AbortController | null = null;

  /** 当前页总页数（上取整；total=0 时为 1 以便空态回落） */
  function totalPages(): number {
    if (total.value <= 0) return 1;
    return Math.ceil(total.value / pageSize.value);
  }

  /**
   * 回填计数（AC-2 列：绑定策略数/绑定用户数）。
   * 并行 Promise.allSettled 容错——单项失败降级 0，不阻断列表渲染。
   */
  async function enrichCounts(roles: Role[]): Promise<void> {
    const codes = roles.map((r) => r.code).filter((c) => c !== "");
    if (codes.length === 0) return;
    const policyResults = await Promise.allSettled(
      codes.map((c) => listPoliciesForRole(c)),
    );
    const userResults = await Promise.allSettled(
      codes.map((c) => listUsersByRole(c, { offset: 0, limit: 1, keyword: "" })),
    );
    const pc: Record<string, number> = {};
    const uc: Record<string, number> = {};
    codes.forEach((code, i) => {
      const pr = policyResults[i];
      if (pr && pr.status === "fulfilled") {
        pc[code] = Math.min(pr.value.length, POLICY_COUNT_CAP);
      } else {
        pc[code] = 0;
      }
      const ur = userResults[i];
      if (ur && ur.status === "fulfilled") {
        uc[code] = ur.value.total;
      } else {
        uc[code] = 0;
      }
    });
    policyCounts.value = pc;
    userCounts.value = uc;
  }

  /**
   * 拉取角色列表 + 计数 enrichment。
   * - fetch 前中断在途请求（AbortController）；
   * - 成功 → 响应回读（无租户标识跳过）→ 写入 state → enrichCounts 回填计数；
   * - page 超界 → 回落最后页重查（E7）；
   * - 失败 → 归位 error，不复位 items。
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
      const q = { offset, limit: pageSize.value, keyword: keyword.value };
      const result = await listRolesPage(q);
      // 被 abort 的在途请求不算错误（新一轮 fetch 已接管）
      if (abort.signal.aborted) return false;
      // 响应回读：role/list 响应无 response 级租户标识 → 跳过此层（return true 放行）
      assertResponseTenantMatch(undefined);
      items.value = result.items;
      total.value = result.total;
      // E7：page 超出总页数 → 回落最后页重查
      const last = totalPages();
      if (page.value > last && total.value > 0) {
        page.value = last;
        return fetch();
      }
      // 计数 enrichment（不阻断渲染；失败降级 0）
      void enrichCounts(result.items);
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
   * 新增角色（写前守卫 → createRole）。
   * @returns 新角色 id；失败返回 null + 归位 error
   */
  async function create(payload: CreateRolePayload): Promise<number | null> {
    // 写前守卫（Hard Rule：不得绕过）；不一致 → reload 自愈，返回 null
    if (!enforceWriteGuard()) return null;
    try {
      const id = await createRole(payload);
      // 新增后回到第一页刷新（新记录在第一页或搜索排序首位）
      page.value = 1;
      await fetch();
      return id;
    } catch (err) {
      error.value = errorMessage(err);
      return null;
    }
  }

  /**
   * 更新角色（写前守卫 → updateRole）。
   * 策略/用户绑定 diff 由视图层计算后经专用绑定函数提交（本 update 不承载绑定 diff，
   * 与 userList.update 角色 diff 模式一致——绑定落点各自独立）。
   */
  async function update(payload: UpdateRolePayload): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      await updateRole(payload);
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 删除角色（写前守卫 → deleteRole → E7 末页回退）。
   * 依赖删除由 eiam 服务端拒绝（E11）：返回 conflict kind，调用方据 catch 渲染阻断弹窗
   * （文案契约 delete.blocked_role：无法删除：该角色已绑定 {n} 个用户）。
   */
  async function remove(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      await deleteRole(id);
      // E7：删除使当前页变空（末页唯一记录被删）→ 回退上一页重查
      const last = totalPages();
      if (page.value > 1 && page.value > last) {
        page.value = Math.max(1, last);
      }
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      // 重新抛出供调用方据 kind 渲染 E11 阻断弹窗（conflict kind = 依赖删除被拒）
      throw err;
    }
  }

  /**
   * 批量删除角色（feat-role-batch-delete 契约 §2.2：写前守卫 → batchDeleteRoles → 重拉）。
   *
   * - 写前守卫不得绕过（Hard Rule）：快照与 currentTenantId 不一致 → 返回 false 且不发请求；
   * - 成功后 `fetch()` 重拉（fetch 内建 E7：批量删除使末页变空 → 回落最后页重查），
   *   分页/筛选态由 store 自持，天然保持当前页与关键词；
   * - 被拒（如角色仍被用户/策略引用）**重新抛出**：store.error 经 contractText 归一，
   *   不能作为「服务端 msg 原文」来源 —— 调用方须用 ApiError.message 原文展示。
   * @param ids 待删除角色 id 列表（数字数组）
   * @returns 是否成功（被拒时抛出，不返回 false）
   */
  async function batchRemove(ids: number[]): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      await batchDeleteRoles(ids);
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      // 重新抛出：调用方展示 ApiError.message 原文（契约 §2.2 被拒口径，不得改写）
      throw err;
    }
  }

  // ---- 策略/用户绑定（写前守卫 + 失败归位 error）----

  /**
   * 绑定策略 diff（写前守卫 → attachPoliciesToRole + detachPoliciesFromRole）。
   * @param roleCode 角色 code
   * @param added 待绑定策略 code 列表
   * @param removed 待解绑策略 code 列表
   */
  async function applyPolicyDelta(
    roleCode: string,
    added: string[],
    removed: string[],
  ): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      if (added.length > 0) {
        await attachPoliciesToRole(roleCode, added);
      }
      if (removed.length > 0) {
        await detachPoliciesFromRole(roleCode, removed);
      }
      // 绑定后刷新计数（不重新 fetch 列表，仅 enrich 当前可见项）
      const current = items.value.find((r) => r.code === roleCode);
      if (current) {
        void enrichCounts([current]);
      }
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 绑定用户 diff（写前守卫 → assignUsersToRole + unassignUsersFromRole）。
   * @param roleCode 角色 code
   * @param added 待绑定用户名列表
   * @param removed 待解绑用户名列表
   */
  async function applyUserDelta(
    roleCode: string,
    added: string[],
    removed: string[],
  ): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      if (added.length > 0) {
        await assignUsersToRole(roleCode, added);
      }
      if (removed.length > 0) {
        await unassignUsersFromRole(roleCode, removed);
      }
      const current = items.value.find((r) => r.code === roleCode);
      if (current) {
        void enrichCounts([current]);
      }
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  // ---- 筛选/分页 UI 态 setters（切过滤重置 page=1，E7）----

  /** 设置关键词搜索（重置 page=1，E7） */
  function setKeyword(value: string): void {
    keyword.value = value;
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
    policyCounts.value = {};
    userCounts.value = {};
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
    // 计数 enrichment
    policyCounts,
    userCounts,
    // actions
    fetch,
    create,
    update,
    remove,
    batchRemove,
    applyPolicyDelta,
    applyUserDelta,
    setKeyword,
    setPage,
    setPageSize,
    resetState,
  };
});
