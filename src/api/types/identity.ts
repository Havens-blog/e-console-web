/**
 * 身份治理域类型：用户 / 租户 / 组织（tech-design §Data Models + Phase 0 parity 回填）。
 */
import type { Ref, RoleRef } from "./common";

/**
 * 用户（UF-4 用户管理页主模型）。
 */
export interface User {
  id: number;
  username: string;
  displayName: string;
  /** 所属租户 id（eiam 禁止用户-租户 M:N，单租户归属 —— parity §2.1 A 档实核） */
  tenantId: number;
  /** 已绑角色引用（分配以 code 为准，见 RoleRef）；role/list 不直出时由 api 层经 role/list/attached/user 回填 */
  roles: RoleRef[];
  /**
   * eiam 原值为 'active' | 'disable'（ParseStatus 未知串归一 'unknown'）；写错会静默降级、启停操作失效。
   * Phase 0 锁定态核查结论（parity G-9）：锁定为登录期 redis 失败计数（lockoutKey + 24h TTL，
   * cache/user.go:68-89），不上 user 模型/VO、无查询端点 —— 状态词表收敛为 active|disable|unknown，
   * **不引入 'locked' 值**；列表状态列不展示锁定，锁定提示由登录页错误文案承接（B-2 中性固定文案口径）。
   */
  status: "active" | "disable" | "unknown";
  loginMethod: "password" | "ldap" | "passkey";
  /**
   * passkey 注册态显式字段。Phase 0 结论（parity G-2/G-3、§6.3.3）：eiam user 模型/VO 无直出字段，
   * 绑定态查询承接 = GET /api/iam/user/identity/list（L1 #24）—— api 层据其映射回填；
   * 管理员代发起注册/撤销（G-2/G-3）转 eiam 排期，v1 仅展示绑定态。
   */
  passkeyRegistered: boolean;
  /**
   * 首登强制改密标记（E1）。Phase 0 结论（parity G-8）：eiam 全链路无承载
   * （grep must_change|MustChange|force_password 0 命中），v1 不做首登强制改密拦截 ——
   * 字段保留为可选占位，待 eiam 排期补齐（建议与 G-1 重置密码一并）后由 api 层回填。
   */
  mustChangePassword?: boolean;
  /**
   * 所属组织引用（eval 残留 #2 承接，Phase 0 已核验回填）：eiam 用户域**无组织 ref 数据源**
   * （parity §6.3：租户 ref 已覆盖（C-16~C-18）、组织无）—— 组织承载为 department（D-1，见 Organization），
   * 用户表单 v1 不并入组织选择。字段保留为可选占位，待 eiam 补组织 ref 后由 api 层回填；
   * 该项由「待核验假设」改判为「无数据源（G 类缺口）」。
   */
  orgRef?: Ref;
}

/**
 * 租户（UF-6；eiam 实盘形状 = TenantVO：id/name/code/domain/status/ctime，parity §3.2 line 319 实核）。
 * tech-design Data Models 基线形为 {id,name,code,domain}；UF-6 Data Binding（ui-design）要求状态列
 * （status 启用/禁用 badge），故规范形并入 status（与 User.status 同款归一词表，复用 StatusBadge）。
 *
 * UF-6 禁用前置「未过期会话数 = 0」Phase 0 结论（parity G-4）：eiam 无任何会话计数端点 →
 * tech-design Data Models 预置降级生效：禁用直接提交（tenant/update status=disable），
 * 被拒时展示 eiam 拒绝消息中的活跃会话数（tenant.disable_blocked 契约 {n}=active_session_count）；
 * 前端不做自算前置校验。活跃会话数列无 list 数据源 → 表格列降级 '—'，
 * 计数仅在禁用被拒时从 eiam 拒绝消息中提取展示（与列同源 = 同一 active_session_count 字段）。
 */
export interface Tenant {
  id: number;
  name: string;
  code: string;
  domain: string;
  /**
   * 启用/禁用状态（UF-6 状态列 + 禁用 lever）。
   * eiam 原值为 int（1=活跃 / 2=禁用，parity §3.2 line 321），api 层归一为字符串词表，
   * 未知值归一 'unknown'（与 User.status 同款 normalizeStatus 口径，复用 StatusBadge）。
   *
   * 可选：profile 的 tenants 列表（UF-11 选择器）不携带 status（RetrieveUser.tenants 仅
   * id/name/code/domain），仅 tenant/list 端点（TenantVO）返回。TenantSelector 不渲染状态列；
   * UF-6 列表页经 listTenants 归一后必填，视图层用 `?? 'unknown'` 兜底防御。
   */
  status?: "active" | "disable" | "unknown";

  /**
   * 创建时间（秒级时间戳）；缺失 / `0` 由视图显示 '—'（feat-tenant-detail-ui 契约 §2.1）。
   * eiam TenantVO 原样出参（`ctime`），列表与详情同源；缺失不补 0（0 无展示意义）。
   */
  ctime?: number;

  // ---- 三类治理配置（tenant-management spec 需求 2 / 6 / 7）----
  //
  // eiam TenantVO 原样出参（eiam/internal/web/tenant/vo.go:65-78），零值即「无约束」语义：
  // 配额 0 = 不限制、白名单空 = 全部允许、开关空表 = 未启用差异化开关。
  // 缺省为 undefined 仅出现在 profile tenants（UF-11 选择器，不携带治理配置）场景；
  // tenant/list 归一后一律补齐为 0/[]/{}，避免视图层区分「无配置」与「未加载」。

  /** 最大云账号数（0 = 不限制） */
  maxAccounts?: number;
  /** 最大用户数（0 = 不限制） */
  maxUsers?: number;
  /** 最大用户组数（0 = 不限制） */
  maxUserGroups?: number;
  /** 功能开关映射表（空表 = 未启用差异化开关） */
  featureSwitch?: Record<string, boolean>;
  /** 允许使用的云厂商白名单（空 = 全部允许） */
  allowedVendors?: string[];

  // ---- 用量统计（tenant-management spec 需求 5；feat-tenant-usage-stats）----
  //
  // 口径**故意与上方治理配置相反**：治理配置零值补齐为 0/[]/{}，计数**不补齐**。
  // undefined = 统计不可用（后端未提供该字段 / 字段缺失），视图渲染 '—'；
  // 0 = 真实为零（后端统计成功且该租户确实无用户 / 用户组），视图渲染 '0'。
  // 二者展示不同（'—' vs '0'），故 api 层只有在拿到 number 时才映射，不得补 0。
  // 云账号数（maxAccounts 的对应用量）本轮不做——属 cam 域数据（需求卡「不包含」）。

  /** 该租户当前用户数（undefined = 统计不可用，0 = 真实为零，二者展示不同） */
  userCount?: number;
  /** 该租户当前用户组数（undefined = 统计不可用，0 = 真实为零，二者展示不同） */
  userGroupCount?: number;
}

/**
 * 租户成员（feat-tenant-members-ui 契约 §2.1）。
 *
 * 来源：`POST /api/iam/tenant/members`（跨租户读取，请求头 `X-Active-Tenant-ID`），
 * 响应 `{total, members}` 由 api 层归一为 `Page<TenantMember>`；snake_case 原生键
 * （job_title / last_login_at）与 status int（1/2）均在 api 层归一，不越视图层。
 * 字段与 eiam MemberVO 一致，缺 id 的记录由 api 层过滤。
 */
export interface TenantMember {
  /** 用户 id（eiam 主键；移除成员时作为 `user_id` 提交） */
  id: number;
  /** 登录名 */
  username: string;
  /** 昵称（缺失 → 空串，视图渲染 '—'） */
  nickname: string;
  /** 头像 URL（缺失 / 空串 → undefined） */
  avatar?: string;
  /** 邮箱（缺失 / 空串 → undefined） */
  email?: string;
  /** 成员状态（eiam status int 1/2 归一；未知 → 'unknown'，复用 normalizeTenantStatus 口径） */
  status?: "active" | "disable" | "unknown";
  /** 职位（eiam job_title，缺失 → undefined） */
  jobTitle?: string;
  /** 最近登录时间（秒级时间戳；缺失 → undefined） */
  lastLoginAt?: number;
  /** 创建时间（秒级时间戳；缺失 → undefined） */
  ctime?: number;
}

/**
 * 组织（UF-5）。Phase 0 改判（parity 分歧 D-1，tech-design「eiam 可能为 department」已结）：
 * eiam **无 organization 端点族** —— 组织能力由 **department（部门）** 承载，端点域标注：
 * `GET /api/department/list`（树形）+ create/update/delete/:id/detail/:id + assign/remove/members
 * （eiam/internal/web/department/handler.go:26-51）。
 * eiam DepartmentVO 实盘为 `{id, parent_id, name, sort, leaders, main_leader, ...}` —— 规范形仅取
 * 设计三字段（parent_id → parentId 归一）；eiam 附加字段（sort/leaders/main_leader）不进 v1 规范形，
 * UF-5 页面需要时在 api 映射层扩展。≤1000 节点/深度 ≤8 限制无 eiam 侧校验证据（前端拦截待登记）。
 */
export interface Organization {
  id: number;
  name: string;
  /** 父节点 id（eiam 原值 parent_id）；根节点缺省 */
  parentId?: number;
}

/**
 * 组织树节点（UF-5）。Organization + 子节点数组（递归）。
 * eiam DepartmentNode = Department + {children?: DepartmentNode[]}（vo.go:48-51）；
 * 规范形仅取 id/name/parentId/children，附加字段不进 v1。
 */
export interface OrganizationNode extends Organization {
  children: OrganizationNode[];
}
