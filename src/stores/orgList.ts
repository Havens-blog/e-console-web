/**
 * orgList store（task 4.3，UF-5）—— 组织树 store，7 个 list store 之一。
 *
 * 统一契约（TECH-frontend-state-002）：state{items, total, page, pageSize, loading, error}
 * + fetch/create/update/remove；AbortController fetch 前中断在途（AC-3）。
 *
 * 组织为**树**（非分页列表）：`GET /api/department/list` 返回全量树（≤1000 节点/深度 ≤8）。
 * - `items` = 顶层组织节点（OrganizationNode[]）；`total` = 全量节点数（cap 校验用）；
 * - `page`/`pageSize` 为契约占位（树无分页），不参与 tree fetch；
 * - 成员列表（members）为分页集合，挂于本 store 二级态（members/membersTotal/membersPage...）。
 *
 * 跨标签租户一致性（tech-design §Integration Specs 6，task 3.1 接入）：
 * - 响应回读：department/list 响应无租户标识 → 跳过此层（return true 放行）；
 * - 写前守卫：create/update/remove 提交前 enforceWriteGuard（Hard Rule：不得绕过）。
 *
 * 上限保护（Hard Rule：树 ≤1000 节点/深度 ≤8 前端硬拦截）：
 * - canAddChild(parent)：parent 深度 ≥8 或全量节点 ≥1000 → 禁建子级；
 * - 深度：根节点 depth=1，子节点 depth=parent+1；最大允许 depth=8（子节点 depth≤8）。
 *
 * 删除前置预检（Hard Rule：删除校验通过前不得放行提交）：
 * - child_count 由树客户端计算（直接子节点数）；user_count 由 members total 承载；
 * - 二者均 0 方可提交 delete；任一 >0 → 调用方渲染 E11 阻断弹窗、确认置灰（不提交）。
 * - eiam 拒绝（code=4010703）作后置兜底（Phase-0-contingent，形态待核验）。
 *
 * 持久化口径（Hard Rule）：列表态不落 localStorage——本 store 不声明 persist。
 * 401 收敛：经 registerUnauthorizedReset 自助注册复位回调（router 2.6）。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useUserStore } from "./user";
import {
  createOrganization,
  deleteOrganization,
  getOrganizationDetail,
  listOrganizationMembers,
  listOrganizationTree,
  updateOrganization,
  type CreateOrganizationPayload,
  type DeptMember,
  type UpdateOrganizationPayload,
} from "@/api/organizations";
import { IAM_DEPARTMENT } from "@/config/permission-codes";
import {
  ApiError,
  type Organization,
  type OrganizationNode,
} from "@/api/types";
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
/** 树节点数上限（PRD 上限保护：≤1000 节点） */
export const MAX_ORG_NODES = 1000;
/** 树深度上限（PRD 上限保护：深度 ≤8；根 depth=1，最大允许 depth=8） */
export const MAX_ORG_DEPTH = 8;
/** 组织名长度约束（UF-5 Data Binding：1–64 字符） */
export const ORG_NAME_MIN = 1;
export const ORG_NAME_MAX = 64;

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
    : "组织操作失败";
}

/** 计算节点深度（根=1；沿 parentId 上溯） */
function depthOf(
  node: OrganizationNode,
  byId: Map<number, OrganizationNode>,
): number {
  let depth = 1;
  let cur: OrganizationNode | undefined = node;
  const guard = new Set<number>();
  while (cur?.parentId !== undefined) {
    if (guard.has(cur.id)) break; // 环保护
    guard.add(cur.id);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
    depth++;
    if (depth > MAX_ORG_DEPTH + 2) break; // 兜底
  }
  return depth;
}

/** 收集树全部节点（扁平，含根与子孙） */
function flatten(nodes: OrganizationNode[]): OrganizationNode[] {
  const out: OrganizationNode[] = [];
  const walk = (list: OrganizationNode[]): void => {
    for (const n of list) {
      out.push(n);
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export const useOrgListStore = defineStore("orgList", () => {
  // ---- 统一契约 state ----
  /** 顶层组织节点（树）；items 即 tree roots */
  const items = ref<OrganizationNode[]>([]);
  /** 全量节点数（cap 校验：≤1000） */
  const total = ref<number>(0);
  /** 契约占位（树无分页，不参与 fetch） */
  const page = ref<number>(1);
  const pageSize = ref<number>(DEFAULT_PAGE_SIZE);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  // ---- 组织树派生态 ----
  /** 选中节点 id（右侧详情/成员数据源） */
  const selectedId = ref<number | null>(null);
  /** 选中节点详情（detail 端点回读，扁平 Organization；计数由树/members 计算） */
  const detail = ref<Organization | null>(null);
  /** 选中节点的直接子节点数（来自树，删除预检 child_count） */
  const selectedChildCount = ref<number>(0);

  // ---- 成员分页态（右侧成员列表，二级集合）----
  const members = ref<DeptMember[]>([]);
  const membersTotal = ref<number>(0);
  const membersPage = ref<number>(1);
  const membersPageSize = ref<number>(DEFAULT_PAGE_SIZE);
  const membersLoading = ref<boolean>(false);
  const membersError = ref<string | null>(null);
  /** 成员关键词搜索（空串 = 不过滤） */
  const membersKeyword = ref<string>("");

  /** 在途 fetch 的 AbortController（fetch 前中断在途，AC-3） */
  let fetchAbort: AbortController | null = null;
  /** 在途 members fetch 的 AbortController */
  let membersAbort: AbortController | null = null;

  /** 全量节点扁平索引（id → node），depth/child_count 计算用 */
  const nodeIndex = computed(() => {
    const map = new Map<number, OrganizationNode>();
    for (const n of flatten(items.value)) map.set(n.id, n);
    return map;
  });

  /** 当前选中节点（来自树，同步可读） */
  const selectedNode = computed<OrganizationNode | null>(() => {
    if (selectedId.value === null) return null;
    return nodeIndex.value.get(selectedId.value) ?? null;
  });

  /**
   * 拉取组织树（GET /api/department/list，D-1）。
   * - fetch 前中断在途请求（AbortController）；
   * - 成功 → 响应回读（无租户标识跳过）→ 写入 state；
   * - 失败 → 归位 error（contractText 回退），不复位 items。
   */
  async function fetch(): Promise<boolean> {
    if (fetchAbort) fetchAbort.abort();
    const abort = new AbortController();
    fetchAbort = abort;

    loading.value = true;
    error.value = null;
    try {
      const tree = await listOrganizationTree();
      if (abort.signal.aborted) return false;
      // 响应回读：department/list 响应无租户标识 → 跳过此层（return true 放行）
      assertResponseTenantMatch(undefined);
      items.value = tree;
      total.value = flatten(tree).length;
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
   * 加载选中节点详情 + 成员（右侧面板数据源）。
   * - detail 端点回读扁平 Organization（无计数）；
   * - child_count 由树客户端计算（selectedChildCount）；
   * - members 分页拉取（membersTotal 即 user_count）。
   * 不经写前守卫（读路径）。
   */
  async function loadDetail(id: number): Promise<void> {
    selectedId.value = id;
    // child_count 来自树（同步可读）
    const node = nodeIndex.value.get(id);
    selectedChildCount.value = node ? node.children.length : 0;
    membersPage.value = 1;
    membersKeyword.value = "";
    await Promise.all([fetchDetail(id), fetchMembers(id)]);
  }

  async function fetchDetail(id: number): Promise<void> {
    try {
      detail.value = await getOrganizationDetail(id);
    } catch (err) {
      // detail 失败不阻断成员列表（降级：detail 为 null，调用方显示节点名）
      detail.value = null;
      void err;
    }
  }

  /**
   * 拉取成员列表（POST /api/department/members，D-1）。
   * - fetch 前中断在途 members 请求；
   * - total 即关联用户数（详情面板 user_count + 删除预检数据源）。
   */
  async function fetchMembers(deptId: number): Promise<boolean> {
    // 缺 `iam:department:members` 时直接跳过：该端点由服务端强制校验，发了必然 403；
    // 成员卡片本身也按同一能力码裁剪（OrgMembersCard 的 v-if），故跳过不会造成"卡片空白"。
    if (!useUserStore().permissions.includes(IAM_DEPARTMENT.MEMBERS)) {
      return true;
    }

    if (membersAbort) membersAbort.abort();
    const abort = new AbortController();
    membersAbort = abort;

    membersLoading.value = true;
    membersError.value = null;
    try {
      const offset = (membersPage.value - 1) * membersPageSize.value;
      const result = await listOrganizationMembers(deptId, {
        offset,
        limit: membersPageSize.value,
        keyword: membersKeyword.value,
      });
      if (abort.signal.aborted) return false;
      members.value = result.items;
      membersTotal.value = result.total;
      return true;
    } catch (err) {
      if (abort.signal.aborted) return false;
      membersError.value = errorMessage(err);
      return false;
    } finally {
      if (membersAbort === abort) {
        membersAbort = null;
        membersLoading.value = false;
      }
    }
  }

  /**
   * 删除前置预检（Hard Rule：删除校验通过前不得放行提交）。
   * - child_count 来自树（selectedChildCount，已加载）；
   * - user_count 来自 members total（membersTotal，已加载）；
   * - 二者均 0 → 返回 null（可提交）；任一 >0 → 返回阻断计数（调用方渲染 E11 弹窗、确认置灰）。
   */
  function precheckDelete(): { childCount: number; userCount: number } | null {
    const childCount = selectedChildCount.value;
    const userCount = membersTotal.value;
    if (childCount > 0 || userCount > 0) {
      return { childCount, userCount };
    }
    return null;
  }

  /**
   * 新增子组织（写前守卫 → createOrganization → 树刷新）。
   * 上限保护（Hard Rule）：canAddChild 预检，超限返回 false + 归位 error（调用方 tooltip 提示）。
   */
  async function create(
    payload: CreateOrganizationPayload,
  ): Promise<number | null> {
    if (!enforceWriteGuard()) return null;
    try {
      const id = await createOrganization(payload);
      await fetch();
      return id;
    } catch (err) {
      error.value = errorMessage(err);
      return null;
    }
  }

  /**
   * 更新组织（写前守卫 → updateOrganization → 树 + 详情刷新）。
   */
  async function update(payload: UpdateOrganizationPayload): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      await updateOrganization(payload);
      await fetch();
      if (selectedId.value === payload.id) {
        await loadDetail(payload.id);
      }
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      return false;
    }
  }

  /**
   * 删除组织（写前守卫 → deleteOrganization → 树刷新）。
   * 调用方应先调 precheckDelete()；预检阻断时不提交（Hard Rule）。
   * eiam 拒绝（code=4010703）作后置兜底，重新抛出供调用方渲染。
   */
  async function remove(id: number): Promise<boolean> {
    if (!enforceWriteGuard()) return false;
    try {
      await deleteOrganization(id);
      await fetch();
      return true;
    } catch (err) {
      error.value = errorMessage(err);
      throw err;
    }
  }

  // ---- 上限保护（Hard Rule：≤1000 节点/深度 ≤8）----

  /**
   * 是否可新增子组织（上限保护）。
   * - parent 深度已达 8（子级将为 9）→ 禁建；
   * - 全量节点已达 1000 → 禁建；
   * - 返回 {allowed, reason} 供调用方 tooltip 提示。
   */
  function canAddChild(parentId: number | null): {
    allowed: boolean;
    reason: string;
  } {
    if (total.value >= MAX_ORG_NODES) {
      return { allowed: false, reason: `节点数已达上限 ${MAX_ORG_NODES}` };
    }
    // 根组织（parentId=null）无深度限制（depth 1）
    if (parentId === null) return { allowed: true, reason: "" };
    const parent = nodeIndex.value.get(parentId);
    if (!parent) return { allowed: true, reason: "" };
    const parentDepth = depthOf(parent, nodeIndex.value);
    if (parentDepth >= MAX_ORG_DEPTH) {
      return {
        allowed: false,
        reason: `组织深度已达上限 ${MAX_ORG_DEPTH} 层`,
      };
    }
    return { allowed: true, reason: "" };
  }

  // ---- 成员分页/筛选 UI 态 setters ----

  function setMembersKeyword(value: string): void {
    membersKeyword.value = value;
    membersPage.value = 1;
  }

  function setMembersPage(p: number): void {
    membersPage.value = p < 1 ? 1 : p;
  }

  function setMembersPageSize(size: number): void {
    membersPageSize.value = clampPageSize(size);
    membersPage.value = 1;
  }

  // ---- 契约占位 setters（树无分页，仅满足统一契约 shape）----
  function setPage(p: number): void {
    page.value = p < 1 ? 1 : p;
  }
  function setPageSize(size: number): void {
    pageSize.value = clampPageSize(size);
  }

  /** 清空选中（删除选中节点后调用，复位右侧详情/成员态） */
  function clearSelection(): void {
    selectedId.value = null;
    detail.value = null;
    selectedChildCount.value = 0;
    members.value = [];
    membersTotal.value = 0;
    membersError.value = null;
  }

  /** 复位（401 收敛 / 离开页面由调用方触发） */
  function resetState(): void {
    if (fetchAbort) {
      fetchAbort.abort();
      fetchAbort = null;
    }
    if (membersAbort) {
      membersAbort.abort();
      membersAbort = null;
    }
    items.value = [];
    total.value = 0;
    page.value = 1;
    pageSize.value = DEFAULT_PAGE_SIZE;
    loading.value = false;
    error.value = null;
    selectedId.value = null;
    detail.value = null;
    selectedChildCount.value = 0;
    members.value = [];
    membersTotal.value = 0;
    membersPage.value = 1;
    membersPageSize.value = DEFAULT_PAGE_SIZE;
    membersLoading.value = false;
    membersError.value = null;
    membersKeyword.value = "";
  }

  // 自助注册 401 复位回调（router 2.6 单点扩展）
  registerUnauthorizedReset(resetState);

  return {
    // 统一契约 state
    items,
    total,
    page,
    pageSize,
    loading,
    error,
    // 组织树派生态
    selectedId,
    detail,
    selectedChildCount,
    selectedNode,
    nodeIndex,
    // 成员分页态
    members,
    membersTotal,
    membersPage,
    membersPageSize,
    membersLoading,
    membersError,
    membersKeyword,
    // actions
    fetch,
    loadDetail,
    fetchMembers,
    precheckDelete,
    clearSelection,
    create,
    update,
    remove,
    canAddChild,
    setMembersKeyword,
    setMembersPage,
    setMembersPageSize,
    setPage,
    setPageSize,
    resetState,
  };
});
