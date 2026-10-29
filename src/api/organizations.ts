/**
 * 组织域 api 客户端（task 4.3，UF-5）—— 组织树/详情/增删改 + 成员列表。
 *
 * 端点证据等级（tech-design §Interfaces C 档 + parity-checklist §2.5/§3.2 分歧 D-1）：
 * - **D-1 改判（Phase 0 已核验回填）**：eiam **无 organization 端点族** —— 组织能力由
 *   **department（部门）** 承载。本模块直调 department 端点（eiam/internal/web/department/handler.go:26-53）：
 *   - `GET  /api/iam/department/list`        部门树（数组，DepartmentNode 嵌套 children）
 *   - `POST /api/iam/department/create`      创建部门 → 新 id
 *   - `POST /api/iam/department/update`      修改部门 → null
 *   - `DELETE /api/iam/department/delete/:id` 删除部门 → null（被拒 code=4010703）
 *   - `GET  /api/iam/department/detail/:id`   部门详情 → Department（扁平，无计数）
 *   - `POST /api/iam/department/members`      部门成员列表 → {total, members}
 *   - `POST /api/iam/department/assign`       添加部门成员 → null（feat-dept-members-mutation）
 *   - `POST /api/iam/department/remove`       移除部门成员 → null（feat-dept-members-mutation）
 *   路径口径 = 控制台外部统一前缀 `/api/iam/*`（nginx/vite 代理重写为 eiam 内部 `/api/*`，
 *   2026-10-09 修复：此前直连 `/api/department/*` 未经反代 → nginx location / 301 →
 *   eiam.unavailable「身份服务暂不可用」，records/6.3-org-prefix.md 落档）。
 * - **Phase-0-contingent**：删除被拒阻断计数（下属组织数/关联用户数，E11）的响应形态待响应样本核验
 *   （parity §2.5：eiam 删除被拒返回 code=4010703 + err.Error() msg，msg 为 Go 错误串、非结构化计数）。
 *   前端不依赖该形态：删除前置由 store 客户端预检（child_count 来自树、user_count 来自 members total），
 *   eiam 拒绝作为后置兜底（msg 透传文案契约回退）。形态核验后如 eiam 返回结构化计数，再收口于此层。
 *
 * 归一规则（Hard Rule：eiam 原生形状不经归一不越视图层）：
 * - 信封经 unwrapEnvelope<T>() 解包（api/request/eiam.ts 单一出口）；
 * - snake_case 原生键（parent_id / main_leader / ctime 等）一律 camelCase 归一；
 * - DepartmentVO 附加字段（sort/leaders/main_leader/ctime/utime）不进 v1 规范形 Organization
 *   （tech-design Data Models：规范形仅 id/name/parentId），UF-5 页面需要计数由 store 客户端计算。
 * - members 分页键 {total, members} → Page<DeptMember>.items。
 */
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import type {
  Envelope,
  ListQuery,
  Organization,
  OrganizationNode,
  Page,
} from "@/api/types";

// ---- eiam department 原生形状（私有，仅本模块映射用；snake_case 不越出本模块）----

interface EiamDepartmentRaw {
  id?: number;
  parent_id?: number;
  name?: string;
  sort?: number;
  leaders?: unknown[];
  main_leader?: string;
  ctime?: number;
  utime?: number;
}

interface EiamDepartmentNodeRaw extends EiamDepartmentRaw {
  children?: EiamDepartmentNodeRaw[];
}

interface EiamDeptUserRaw {
  id?: number;
  username?: string;
  nickname?: string;
  avatar?: string;
  email?: string;
  phone?: string;
}

interface EiamListMembersResult {
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
 * eiam department 原生节点 → 归一 OrganizationNode（snake_case → camelCase）。
 * 缺 id（核心标识）返回 null，由调用方降级过滤。附加字段（sort/leaders/main_leader/...）
 * 不进 v1 规范形（tech-design Data Models 三字段口径）。
 */
export function mapDepartmentNode(raw: unknown): OrganizationNode | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const dept = raw as EiamDepartmentNodeRaw;
  const children = Array.isArray(dept.children)
    ? dept.children
        .map(mapDepartmentNode)
        .filter((n): n is OrganizationNode => n !== null)
    : [];
  return {
    id,
    name: asString(dept.name) ?? "",
    parentId: asNumber(dept.parent_id) || undefined,
    children,
  };
}

/** 归一 department 树（顶层数组）→ OrganizationNode[]（过滤 null） */
function toOrganizationTree(raw: unknown): OrganizationNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(mapDepartmentNode)
    .filter((n): n is OrganizationNode => n !== null);
}

/** 部门成员（归一 DeptMember；eiam User VO：id/username/nickname/avatar/email/phone） */
export interface DeptMember {
  id: number;
  username: string;
  displayName: string;
  avatar?: string;
  email?: string;
  phone?: string;
}

function mapDeptMember(raw: unknown): DeptMember | null {
  if (!isRecord(raw)) return null;
  const id = asNumber(raw.id);
  if (id === 0) return null;
  const u = raw as EiamDeptUserRaw;
  const username = asString(u.username) ?? "";
  return {
    id,
    username,
    displayName: asString(u.nickname) ?? username,
    avatar: asString(u.avatar),
    email: asString(u.email),
    phone: asString(u.phone),
  };
}

/** 归一 eiam {total, members} → Page<DeptMember>（过滤 null，total 缺省按 items 长度） */
function toMemberPage(raw: unknown): Page<DeptMember> {
  if (!isRecord(raw)) return { total: 0, items: [] };
  const result = raw as EiamListMembersResult;
  const members = Array.isArray(result.members) ? result.members : [];
  const items = members
    .map(mapDeptMember)
    .filter((m): m is DeptMember => m !== null);
  return {
    total:
      typeof result.total === "number" && Number.isFinite(result.total)
        ? result.total
        : items.length,
    items,
  };
}

// ---- 组织 CRUD ----

/**
 * 组织树（GET /api/iam/department/list，D-1 实核）。
 * 无载荷（GET 全量树，≤1000 节点/深度 ≤8 由前端 cap 拦截）；响应归一为 OrganizationNode[]。
 */
export async function listOrganizationTree(): Promise<OrganizationNode[]> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>("/api/iam/department/list"),
  );
  return toOrganizationTree(data);
}

/** 创建组织载荷（camelCase 规范形；api 层映射为 eiam CreateDeptRequest snake_case） */
export interface CreateOrganizationPayload {
  /** 父节点 id；根组织传 0 或 undefined（eiam 根 parent_id=0） */
  parentId?: number;
  /** 组织名（1–64 字符，前端拦截） */
  name: string;
}

/**
 * 创建组织（POST /api/iam/department/create，D-1 实核）。
 * 载荷 eiam CreateDeptRequest {parent_id, name, sort, leaders, main_leader}；
 * v1 仅传 parent_id + name（规范形两字段），附加字段缺省。返回新 id。
 */
export async function createOrganization(
  payload: CreateOrganizationPayload,
): Promise<number> {
  const id = await unwrapEnvelope<number>(
    eiamAxios.post<Envelope<number>>("/api/iam/department/create", {
      parent_id: payload.parentId ?? 0,
      name: payload.name,
    }),
  );
  return id;
}

/** 更新组织载荷（UpdateDeptRequest = id + name + parent_id + 附加字段） */
export interface UpdateOrganizationPayload {
  id: number;
  name: string;
  /** 父节点 id；根组织传 0 或 undefined */
  parentId?: number;
}

/** 更新组织（POST /api/iam/department/update，D-1 实核）；v1 仅传 id + name + parent_id */
export async function updateOrganization(
  payload: UpdateOrganizationPayload,
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/department/update", {
      id: payload.id,
      parent_id: payload.parentId ?? 0,
      name: payload.name,
    }),
  );
}

/**
 * 删除组织（DELETE /api/iam/department/delete/:id，D-1 实核）。
 * 依赖删除由 eiam 服务端拒绝（E11）：返回 code=4010703 + msg=err.Error()
 * （ErrDeleteDeptWithChildren / ErrDeleteDeptWithMembers）—— 计数未结构化，Phase-0-contingent。
 * 前端预检（child_count/user_count）由 store 承接，eiam 拒绝作后置兜底。
 */
export async function deleteOrganization(id: number): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.delete<Envelope<null>>(`/api/iam/department/delete/${id}`),
  );
}

/**
 * 组织详情（GET /api/iam/department/detail/:id，D-1 实核）。
 * 响应扁平 Department（无 child_count/user_count）—— 计数由 store 客户端计算（树 + members）。
 */
export async function getOrganizationDetail(
  id: number,
): Promise<Organization | null> {
  const data = await unwrapEnvelope<unknown>(
    eiamAxios.get<Envelope<unknown>>(`/api/iam/department/detail/${id}`),
  );
  if (!isRecord(data)) return null;
  const dept = data as EiamDepartmentRaw;
  const oid = asNumber(dept.id);
  if (oid === 0) return null;
  return {
    id: oid,
    name: asString(dept.name) ?? "",
    parentId: asNumber(dept.parent_id) || undefined,
  };
}

/**
 * 组织成员列表（POST /api/iam/department/members，D-1 实核）。
 * 载荷 {dept_id, offset, limit, keyword}；响应归一为 Page<DeptMember>。
 * total 即关联用户数（UF-5 详情面板 user_count + 删除预检数据源）。
 */
export async function listOrganizationMembers(
  deptId: number,
  q: ListQuery,
): Promise<Page<DeptMember>> {
  const data = await unwrapEnvelope<EiamListMembersResult>(
    eiamAxios.post<Envelope<EiamListMembersResult>>("/api/iam/department/members", {
      dept_id: deptId,
      offset: q.offset,
      limit: q.limit,
      keyword: q.keyword,
    }),
  );
  return toMemberPage(data);
}

// ---- 部门成员增删（feat-dept-members-mutation 契约 §1/§2.1）----

/**
 * 添加部门成员（POST /api/iam/department/assign，契约 §1）。
 * 载荷 `{dept_id, user_ids}` —— **user_ids 是数字数组（用户 id），不是 username 数组**；
 * 该端点无跨租户 Header（契约 §1 末条），故不经 tenantGuard 读写路径之外的改写。
 * 服务端拒绝（无权限 / 用户不存在等）→ unwrapEnvelope 抛 ApiError（msg 原文由调用方展示）。
 */
export async function assignOrganizationMembers(
  deptId: number,
  userIds: number[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/department/assign", {
      dept_id: deptId,
      user_ids: userIds,
    }),
  );
}

/**
 * 移除部门成员（POST /api/iam/department/remove，契约 §1）。
 * 载荷 `{dept_id, user_ids}`（数字数组，同 assign）；被拒抛 ApiError（msg 原文）。
 */
export async function removeOrganizationMembers(
  deptId: number,
  userIds: number[],
): Promise<void> {
  await unwrapEnvelope<null>(
    eiamAxios.post<Envelope<null>>("/api/iam/department/remove", {
      dept_id: deptId,
      user_ids: userIds,
    }),
  );
}
