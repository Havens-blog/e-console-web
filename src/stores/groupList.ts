/**
 * groupList store（feat-group-management）—— 统一 list store 契约承载用户组管理。
 *
 * 统一契约（TECH-frontend-state-002，与 tenantList/userList/roleList 同款）：
 * state `{items, total, page, pageSize(默认 20、上限 100), loading, error}` +
 * `fetch/create/update/remove`；AbortController —— fetch 前中断在途（AC-3）。
 *
 * 分页边界（E7）：
 * - page 超出总页数 → 回落最后页重查；
 * - 删除使当前页变空（末页唯一记录被删）→ 回退上一页重查；
 * - 切换 keyword → page 重置 1。
 *
 * 与 tenantList 的刻意差异：
 * - **无写前租户守卫**（enforceWriteGuard）：group 端点按会话租户隔离，请求不带
 *   `X-Active-Tenant-ID`，不存在「页面呈现 X 租户、请求打 Y 租户」的跨租户风险面；
 * - **无治理配置全量回传**：eiam UpdateGroupReq 仅 `{id, name, desc}`，无「未携带即清空」的列。
 *
 * 持久化口径（Hard Rule）：列表态不落 localStorage —— 本 store 不声明 persist。
 * 401 收敛：经 registerUnauthorizedReset 自助注册复位回调（router 2.6）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  createGroup,
  deleteGroup,
  listGroups,
  updateGroup,
  type CreateGroupPayload,
  type UpdateGroupPayload,
} from "@/api/groups";
import { ApiError, type TenantGroup } from "@/api/types";
import { contractText } from "@/utils/copyContract";
import { registerUnauthorizedReset } from "@/router";

/** 默认页大小（TECH-frontend-state-002：默认 20） */
const DEFAULT_PAGE_SIZE = 20;
/** 页大小上限（TECH-frontend-state-002：上限 100） */
const MAX_PAGE_SIZE = 100;

/** 组名长度约束（契约 §2.3：1–64） */
export const GROUP_NAME_MIN = 1;
export const GROUP_NAME_MAX = 64;
/** 标识码长度约束（契约 §2.3：≤32） */
export const GROUP_CODE_MAX = 32;
/** 描述长度约束（契约 §2.3：≤512） */
export const GROUP_DESC_MAX = 512;

function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(size), MAX_PAGE_SIZE);
}

/** 任意抛出值 → 文案（contractText(code) 回退 ApiError.message，与 tenantList 同款口径） */
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
    : "用户组操作失败";
}

export const useGroupListStore = defineStore("groupList", () => {
  // ---- 统一契约 state ----
  const items = ref<TenantGroup[]>([]);
  const total = ref<number>(0);
  const page = ref<number>(1);
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  // ---- 筛选 UI 态 ----
  /** 关键词搜索（空串 = 不过滤） */
  const keyword = ref<string>("");

  /** 在途 fetch 的 AbortController（fetch 前中断在途，AC-3） */
  let fetchAbort: AbortController | null = null;

  /** 当前页总页数（上取整；total=0 时为 1 以便空态回落） */
  function totalPages(): number {
    if (total.value <= 0) return 1;
    return Math.ceil(total.value / pageSize.value);
  }

  /**
   * 拉取用户组列表。
   * - fetch 前中断在途请求（AbortController，慢响应不覆盖新结果）；
   * - 成功 → 写入 state；
   * - page 超界 → 回落最后页重查（E7）；
   * - 失败 → 归位 error（contractText 回退），不复位 items（保留上一次可见数据）。
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
      const result = await listGroups({
        offset,
        limit: pageSize.value,
        keyword: keyword.value,
      });
      if (abort.signal.aborted) return false;
      items.value = result.items;
      total.value = result.total;
      // E7：page 超出总页数 → 回落最后页重查（仅当 total>0）
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
   * 新建用户组（createGroup → 回第一页刷新）。
   * eiam 拒绝（名称/标识码唯一性等）由 store 归位 error 供调用方渲染原文。
   *
   * @returns true=成功；false=失败（error 已归位）
   */
  async function create(payload: CreateGroupPayload): Promise<boolean> {
    try {
      await createGroup(payload);
      // 新增后回到第一页刷新（新记录是否落在首页由服务端排序决定，前端不臆造）
      page.value = 1;
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /** 更新用户组（updateGroup → 当前页刷新；标识码不可改，载荷不含 code） */
  async function update(payload: UpdateGroupPayload): Promise<boolean> {
    try {
      await updateGroup(payload);
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 删除用户组（deleteGroup → E7 末页回退 → 刷新）。
   * 服务端拒绝（如组内仍有成员）时**重新抛出**，供调用方在弹窗内原样展示 msg。
   */
  async function remove(id: number): Promise<boolean> {
    try {
      await deleteGroup(id);
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
    // actions
    fetch,
    create,
    update,
    remove,
    setKeyword,
    setPage,
    setPageSize,
    resetState,
  };
});
