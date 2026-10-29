/**
 * 能力码词表 —— 前端权限三级裁剪（菜单 / 路由守卫 / 按钮显隐）的单一事实源（P0 定稿）。
 *
 * 词表来源 = eiam capability 注册实录（证据-R/S，落档于 docs/features/platform-console/parity-checklist.md §5）：
 *   eiam/internal/web/{user,role,policy,tenant,department,identity_source,permission,group,invitation}/*.go
 * 码格式（eiam/pkg/web/capability/api.go normalizeCode:189-201）：
 *   verb 含 ":" → `iam:<verb>`；否则 → `iam:<module>:<verb>`。service 恒为 "iam"（eiam/ioc 装配，
 *   capability.NewRegistry("iam", <module>, ...)）。
 *   例：Capability("创建用户","add") → `iam:user:add`；Capability("授权治理列表","view_authorizations")
 *       → `iam:permission:view_authorizations`。
 *
 * 语义层级（BIZ-auth-001）：本词表驱动的菜单/路由/按钮裁剪仅**体验层**，可被直调接口绕过；
 * 安全边界唯一 = eiam OPA 服务端强制校验（403 原地，不跳登录页）。前端裁剪不得作为权限判定凭据。
 *
 * 维护口径（BIZ-auth-009）：本词表即是 eiam 契约基线的前端投影；eiam 侧新增/变更任一端点的
 * 能力码（含字段语义调整）须提前 ≥5 个工作日通知，并同步更新本文件与 parity-check-list §5。
 */

/** 用户管理（eiam/internal/web/user/user.go:107-144） */
export const IAM_USER = {
  VIEW: 'iam:user:view',
  ADD: 'iam:user:add',
  EDIT: 'iam:user:edit',
  GET: 'iam:user:get',
  DELETE: 'iam:user:delete',
  BATCH_DELETE: 'iam:user:batch_delete',
  VIEW_ROLE_MEMBERS: 'iam:user:view_role_members',
  LDAP_SEARCH: 'iam:user:ldap_search',
  LDAP_SYNC: 'iam:user:ldap_sync',
  MANAGE_IDENTITY: 'iam:user:manage_identity',
  UNBIND_IDENTITY: 'iam:user:unbind_identity',
} as const

/** 部门/组织管理（eiam/internal/web/department/handler.go:29-50） */
export const IAM_DEPARTMENT = {
  VIEW: 'iam:department:view',
  ADD: 'iam:department:add',
  EDIT: 'iam:department:edit',
  GET: 'iam:department:get',
  DELETE: 'iam:department:delete',
  ASSIGN: 'iam:department:assign',
  REMOVE: 'iam:department:remove',
  MEMBERS: 'iam:department:members',
} as const

/** 租户管理（eiam/internal/web/tenant/handler.go:44-110） */
export const IAM_TENANT = {
  VIEW_MINE: 'iam:tenant:view_mine',
  SWITCH: 'iam:tenant:switch',
  VIEW: 'iam:tenant:view',
  ADD: 'iam:tenant:add',
  EDIT: 'iam:tenant:edit',
  GET: 'iam:tenant:get',
  DELETE: 'iam:tenant:delete',
  VIEW_MEMBERS: 'iam:tenant:view_members',
  ASSIGN: 'iam:tenant:assign',
  UNASSIGN: 'iam:tenant:unassign',
  BATCH_ASSIGN: 'iam:tenant:batch_assign',
  BATCH_UNASSIGN: 'iam:tenant:batch_unassign',
  VIEW_USER_TENANTS: 'iam:tenant:view_user_tenants',
} as const

/** 身份源管理（eiam/internal/web/identity_source/handler.go:20,32-47；平台级 ScopeSystem） */
export const IAM_IDENTITY_SOURCE = {
  VIEW: 'iam:identity_source:view',
  SAVE: 'iam:identity_source:save',
  DETAIL: 'iam:identity_source:detail',
  DELETE: 'iam:identity_source:delete',
  TEST: 'iam:identity_source:test',
  TOGGLE: 'iam:identity_source:toggle',
} as const

/** 角色管理（eiam/internal/web/role/handler.go:41-98） */
export const IAM_ROLE = {
  VIEW: 'iam:role:view',
  ADD: 'iam:role:add',
  EDIT: 'iam:role:edit',
  GET: 'iam:role:get',
  DELETE: 'iam:role:delete',
  BATCH_DELETE: 'iam:role:batch_delete',
  BATCH_ASSIGN: 'iam:role:batch_assign',
  BATCH_UNASSIGN: 'iam:role:batch_unassign',
  UNASSIGN: 'iam:role:unassign',
  ADD_PARENT: 'iam:role:add_parent',
  REMOVE_PARENT: 'iam:role:remove_parent',
  VIEW_PARENTS: 'iam:role:view_parents',
  VIEW_MINE: 'iam:role:view_mine',
  VIEW_USER_ROLES: 'iam:role:view_user_roles',
} as const

/** 策略管理（eiam/internal/web/policy/handler.go:43-94；attach 端点已注释停用，不入词表） */
export const IAM_POLICY = {
  VIEW: 'iam:policy:view',
  ADD: 'iam:policy:add',
  EDIT: 'iam:policy:edit',
  GET: 'iam:policy:get',
  DETACH: 'iam:policy:detach',
  BATCH_ATTACH: 'iam:policy:batch_attach',
  BATCH_DETACH: 'iam:policy:batch_detach',
  DELETE: 'iam:policy:delete',
  VIEW_USER_POLICIES: 'iam:policy:view_user_policies',
  VIEW_ROLE_POLICIES: 'iam:policy:view_role_policies',
  VIEW_GROUP_POLICIES: 'iam:policy:view_group_policies',
} as const

/** 权限管理（eiam/internal/web/permission/handler.go:51-67） */
export const IAM_PERMISSION = {
  MANIFEST: 'iam:permission:manifest',
  VIEW_AUTHORIZATIONS: 'iam:permission:view_authorizations',
  SEARCH_SUBJECTS: 'iam:permission:search_subjects',
  MENUS_BY_URNS: 'iam:permission:menus_by_urns',
} as const

/** 用户组管理（eiam/internal/web/group/handler.go:30-66；P1 上页，端点现成） */
export const IAM_GROUP = {
  VIEW: 'iam:group:view',
  ADD: 'iam:group:add',
  EDIT: 'iam:group:edit',
  GET: 'iam:group:get',
  DELETE: 'iam:group:delete',
  ASSIGN_MEMBERS: 'iam:group:assign_members',
  REMOVE_MEMBERS: 'iam:group:remove_members',
  MEMBERS: 'iam:group:members',
  ASSIGN_ROLE: 'iam:group:assign_role',
  REMOVE_ROLE: 'iam:group:remove_role',
  ROLES: 'iam:group:roles',
  /**
   * 查询用户所属分组（eiam group/handler.go:58 `Define("查询用户所属分组", "view_user_groups")`）。
   * 用户详情页「权限来源」面板的分组区块按此码裁剪（feat-user-permission-sources 契约 §1）。
   */
  VIEW_USER_GROUPS: 'iam:group:view_user_groups',
  /**
   * 查询角色关联分组（eiam group/handler.go:61 `Define("查询角色关联分组", "view_role_groups")`）。
   * 角色详情页「关联用户组」区块按此码裁剪（feat-role-bound-groups 契约 §2.1）；与
   * VIEW_USER_GROUPS 同为**只读反查**码，同处 IAM_VIEW_CODES。
   */
  VIEW_ROLE_GROUPS: 'iam:group:view_role_groups',
} as const

/** 邀请管理（eiam/internal/web/invitation/handler.go:45-63；P1 上页，端点现成） */
export const IAM_INVITATION = {
  VIEW: 'iam:invitation:view',
  ADD: 'iam:invitation:add',
  DELETE: 'iam:invitation:delete',
  BATCH_DELETE: 'iam:invitation:batch_delete',
  VIEW_REQUESTS: 'iam:invitation:view_requests',
  HANDLE_REQUEST: 'iam:invitation:handle_request',
} as const

/**
 * 审计日志（eiam/internal/web/audit/handler.go:104,107；feat-audit-logs 契约 §1.3 实测）。
 *
 * 码值经 `eiam/pkg/contract/permission/zz_generated_perms.go:12-13` 核实：
 * 认证审计 `iam:audit:view_auth`、操作审计 `iam:audit:view_operation`。
 * 两者均为**只读**码（审计日志不可编辑/删除），故同处 IAM_VIEW_CODES。
 */
export const IAM_AUDIT = {
  /** 查看认证审计（eiam audit/handler.go:104 `Define("查看认证审计", "view_auth")`） */
  VIEW_AUTH: 'iam:audit:view_auth',
  /** 查看操作审计（eiam audit/handler.go:107 `Define("查看操作审计", "view_operation")`） */
  VIEW_OPERATION: 'iam:audit:view_operation',
} as const

/**
 * 读类码全集（visibility 语义）：持有任一即具备「可查看治理数据」的身份面，
 * 供菜单/工作台角色档位推断（inferRoleFromCodes）与测试样本复用。
 */
export const IAM_VIEW_CODES: readonly string[] = [
  IAM_USER.VIEW,
  IAM_USER.GET,
  IAM_USER.VIEW_ROLE_MEMBERS,
  IAM_DEPARTMENT.VIEW,
  IAM_DEPARTMENT.GET,
  IAM_DEPARTMENT.MEMBERS,
  IAM_TENANT.VIEW,
  IAM_TENANT.VIEW_MINE,
  IAM_TENANT.GET,
  IAM_TENANT.VIEW_MEMBERS,
  IAM_TENANT.VIEW_USER_TENANTS,
  IAM_IDENTITY_SOURCE.VIEW,
  IAM_IDENTITY_SOURCE.DETAIL,
  IAM_ROLE.VIEW,
  IAM_ROLE.GET,
  IAM_ROLE.VIEW_PARENTS,
  IAM_ROLE.VIEW_MINE,
  IAM_ROLE.VIEW_USER_ROLES,
  IAM_POLICY.VIEW,
  IAM_POLICY.GET,
  IAM_POLICY.VIEW_USER_POLICIES,
  IAM_POLICY.VIEW_ROLE_POLICIES,
  IAM_POLICY.VIEW_GROUP_POLICIES,
  IAM_PERMISSION.MANIFEST,
  IAM_PERMISSION.VIEW_AUTHORIZATIONS,
  IAM_PERMISSION.SEARCH_SUBJECTS,
  IAM_GROUP.VIEW,
  IAM_GROUP.GET,
  IAM_GROUP.MEMBERS,
  IAM_GROUP.ROLES,
  IAM_GROUP.VIEW_USER_GROUPS,
  IAM_GROUP.VIEW_ROLE_GROUPS,
  IAM_INVITATION.VIEW,
  IAM_INVITATION.VIEW_REQUESTS,
  // 审计日志（只读角色应能看到审计页；契约 §2.1）
  IAM_AUDIT.VIEW_AUTH,
  IAM_AUDIT.VIEW_OPERATION,
]

/**
 * 管理类码全集（mutation 语义）：持有任一即具备「可治理（增删改等）」的身份面，
 * 供工作台角色档位推断（inferRoleFromCodes）与测试样本复用。
 * 与 IAM_VIEW_CODES 互斥且并为全量词表（写入档 = 管理，读取档 = 查看）。
 */
export const IAM_MANAGE_CODES: readonly string[] = [
  IAM_USER.ADD,
  IAM_USER.EDIT,
  IAM_USER.DELETE,
  IAM_USER.BATCH_DELETE,
  IAM_USER.LDAP_SEARCH,
  IAM_USER.LDAP_SYNC,
  IAM_USER.MANAGE_IDENTITY,
  IAM_USER.UNBIND_IDENTITY,
  IAM_DEPARTMENT.ADD,
  IAM_DEPARTMENT.EDIT,
  IAM_DEPARTMENT.DELETE,
  IAM_DEPARTMENT.ASSIGN,
  IAM_DEPARTMENT.REMOVE,
  IAM_TENANT.SWITCH,
  IAM_TENANT.ADD,
  IAM_TENANT.EDIT,
  IAM_TENANT.DELETE,
  IAM_TENANT.ASSIGN,
  IAM_TENANT.UNASSIGN,
  IAM_TENANT.BATCH_ASSIGN,
  IAM_TENANT.BATCH_UNASSIGN,
  IAM_IDENTITY_SOURCE.SAVE,
  IAM_IDENTITY_SOURCE.DELETE,
  IAM_IDENTITY_SOURCE.TEST,
  IAM_IDENTITY_SOURCE.TOGGLE,
  IAM_ROLE.ADD,
  IAM_ROLE.EDIT,
  IAM_ROLE.DELETE,
  IAM_ROLE.BATCH_DELETE,
  IAM_ROLE.BATCH_ASSIGN,
  IAM_ROLE.BATCH_UNASSIGN,
  IAM_ROLE.UNASSIGN,
  IAM_ROLE.ADD_PARENT,
  IAM_ROLE.REMOVE_PARENT,
  IAM_POLICY.ADD,
  IAM_POLICY.EDIT,
  IAM_POLICY.DETACH,
  IAM_POLICY.BATCH_ATTACH,
  IAM_POLICY.BATCH_DETACH,
  IAM_POLICY.DELETE,
  IAM_GROUP.ADD,
  IAM_GROUP.EDIT,
  IAM_GROUP.DELETE,
  IAM_GROUP.ASSIGN_MEMBERS,
  IAM_GROUP.REMOVE_MEMBERS,
  IAM_GROUP.ASSIGN_ROLE,
  IAM_GROUP.REMOVE_ROLE,
  IAM_INVITATION.ADD,
  IAM_INVITATION.DELETE,
  IAM_INVITATION.BATCH_DELETE,
  IAM_INVITATION.HANDLE_REQUEST,
]

/** 全量词表（读写并集；测试样本 / 平台管理员全码种子用） */
export const IAM_ALL_CODES: readonly string[] = [
  ...IAM_VIEW_CODES,
  ...IAM_MANAGE_CODES,
]