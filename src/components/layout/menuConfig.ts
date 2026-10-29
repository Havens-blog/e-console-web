// 主布局侧边栏分组菜单配置 + 权限码裁剪（task 2.8 基线 → P0 权限码驱动版）。
//
// 三组 11 项：
//   概览 —— 工作台
//   身份治理 —— 用户管理 / 组织管理 / 用户组管理 / 租户管理 / 身份源管理 / 邀请管理
//   权限管理 —— 角色管理 / 授权管理 / 策略管理 / 审计日志
//
// 裁剪口径（P0 定稿，词表 = src/config/permission-codes.ts / parity §5）：
//   - 菜单项经 `code` 声明所需能力码（undefined = 登录态即可，现仅工作台）；
//   - 可见 = 持有对应码 && 非 adminOnly 或 isAdmin；
//   - `restricted`（零租户受限态：!isAdmin && 无所属租户）→ 仅渲染无码项（工作台），
//     与 UF-2 受限视图口径一致；
//   - **tenant_admin 档自此由权限码自然得出**（原 inferRole(isAdmin/tenantsCount) 三分支
//     无法区分租户管理员与只读审计——非管理员一律落入 readonly_audit 最宽集，已修复）；
//   - adminOnly（租户/策略管理）双保险保留：权限码 + isAdmin 两道闸。
//
// 三态收敛（MainLayout）：
//   - 403 原地 toast（请求层 forbidden → ElMessage 契约文案）
//   - 401 跳登录（eiamAxios 拦截器）
//   - 零租户受限态：侧边栏仅工作台 + header 租户选择器禁用占位 + 应用切换器隐藏
import {
  Connection,
  Document,
  HomeFilled,
  Key,
  Lock,
  Notebook,
  OfficeBuilding,
  Promotion,
  User,
  UserFilled,
} from '@element-plus/icons-vue'
import type { Component } from 'vue'
import {
  IAM_AUDIT,
  IAM_DEPARTMENT,
  IAM_GROUP,
  IAM_IDENTITY_SOURCE,
  IAM_INVITATION,
  IAM_MANAGE_CODES,
  IAM_PERMISSION,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
  IAM_VIEW_CODES,
} from '@/config/permission-codes'

/** 菜单组（组标题 uppercase 11px 灰色，UF-2） */
export interface MenuGroup {
  id: string
  title: string
}

/** 菜单项（40px 高，图标 18px + 标题 14px，UF-2） */
export interface MenuItem {
  key: string
  label: string
  path: string
  icon: Component
  group: MenuGroup['id']
  /** 所需能力码（undefined = 登录态即可；词表 permission-codes.ts，parity §5） */
  code?: string
  /** 平台管理员独占（Hard Rule：租户管理 / 策略管理；与 code 双保险） */
  adminOnly?: boolean
}

/** 三组（顺序即渲染顺序） */
export const MENU_GROUPS: MenuGroup[] = [
  { id: 'overview', title: '概览' },
  { id: 'identity', title: '身份治理' },
  { id: 'permission', title: '权限管理' },
]

/** 11 项（顺序即组内渲染顺序；code = 路由守卫 meta.permissions 同源） */
export const MENU_ITEMS: MenuItem[] = [
  {
    key: 'workbench',
    label: '工作台',
    path: '/workbench',
    icon: HomeFilled,
    group: 'overview',
  },
  {
    key: 'users',
    label: '用户管理',
    path: '/users',
    icon: User,
    group: 'identity',
    code: IAM_USER.VIEW,
  },
  {
    key: 'organizations',
    label: '组织管理',
    path: '/organizations',
    icon: OfficeBuilding,
    group: 'identity',
    code: IAM_DEPARTMENT.VIEW,
  },
  {
    // 用户组管理（feat-group-management 契约 §2.4）：图标沿用既有图标集
    // （@element-plus/icons-vue —— 本仓 MenuItem.icon 为 Component，无 iconfont 类）；
    // 取 UserFilled（组/人群语义）与「用户管理」的 User 区分
    key: 'groups',
    label: '用户组管理',
    path: '/groups',
    icon: UserFilled,
    group: 'identity',
    code: IAM_GROUP.VIEW,
    // 与路由 meta.requiresAdmin 保持一致：该页仅平台管理员可用。
    // 否则持有 iam:group:view 的非管理员会看到菜单、点进来却被守卫送到 /forbidden（
    // 同组成员「租户管理」「策略管理」均已如此声明）。
    adminOnly: true,
  },
  {
    key: 'tenants',
    label: '租户管理',
    path: '/tenants',
    icon: Connection,
    group: 'identity',
    code: IAM_TENANT.VIEW,
    adminOnly: true,
  },
  {
    key: 'identity-sources',
    label: '身份源管理',
    path: '/identity-sources',
    icon: Key,
    group: 'identity',
    code: IAM_IDENTITY_SOURCE.VIEW,
  },
  {
    // 邀请管理（feat-invitation-management 契约 §2.3）：图标沿用既有图标集
    // （@element-plus/icons-vue —— 本仓 MenuItem.icon 为 Component，无 iconfont 类）；
    // 取 Promotion（邀请/推广语义）与同组其他项区分
    key: 'invitations',
    label: '邀请管理',
    path: '/invitations',
    icon: Promotion,
    group: 'identity',
    code: IAM_INVITATION.VIEW,
    // 与路由 meta.requiresAdmin 保持一致：该页仅平台管理员可用。
    // 否则持有 iam:invitation:view 的非管理员会看到菜单、点进来却被守卫送到 /forbidden
    // （与用户组管理同款口径）。
    adminOnly: true,
  },
  {
    key: 'roles',
    label: '角色管理',
    path: '/roles',
    icon: Lock,
    group: 'permission',
    code: IAM_ROLE.VIEW,
  },
  {
    key: 'authorizations',
    label: '授权管理',
    path: '/authorizations',
    icon: Document,
    group: 'permission',
    code: IAM_PERMISSION.VIEW_AUTHORIZATIONS,
  },
  {
    key: 'policies',
    label: '策略管理',
    path: '/policies',
    icon: Connection,
    group: 'permission',
    code: IAM_POLICY.VIEW,
    adminOnly: true,
  },
  {
    // 审计日志（feat-audit-logs 契约 §2.4）：图标沿用既有图标集
    // （@element-plus/icons-vue —— 本仓 MenuItem.icon 为 Component，无 iconfont 类）；
    // 取 Notebook（日志本语义）与同组其他项区分。
    key: 'audit',
    label: '审计日志',
    path: '/audit',
    // code 取 VIEW_AUTH（契约 §2.4 建议）；页面内两页签各自再按 view_auth /
    // view_operation 显隐，故持有任一审计码即可从菜单进入。
    code: IAM_AUDIT.VIEW_AUTH,
    icon: Notebook,
    group: 'permission',
    // 与路由 meta.requiresAdmin 保持一致：该页仅平台管理员可用。
    // 否则持有 iam:audit:view_auth 的非管理员会看到菜单、点进来却被守卫送到 /forbidden
    // （与用户组管理 / 邀请管理同款口径）。
    adminOnly: true,
  },
]

/** 角色档位（工作台「我的信息·角色」展示标签用；与裁剪层同信号源） */
export type MenuRole =
  'platform_admin' | 'readonly_audit' | 'tenant_admin' | 'normal'

/** 菜单可见性信号（由 user store 派生，纯数据便于单测） */
export interface MenuVisibility {
  /** 当前用户能力码全集（profile.permissions） */
  codes: readonly string[]
  /** 平台管理员（profile.is_admin，eiam 权威） */
  isAdmin: boolean
  /** 零租户受限态（!isAdmin && 无所属租户）：仅渲染无码项（工作台） */
  restricted: boolean
}

/**
 * 由权限码推断角色档位（P0 词表驱动，替代 inferRole(isAdmin/tenantsCount) 三分支）。
 *
 * - isAdmin → platform_admin（全量）
 * - restricted（零租户受限态）→ normal（仅工作台）
 * - 持有任一 mutation 码 → tenant_admin（可治理）
 * - 持有任一 view 码 → readonly_audit（可查看）
 * - 无 iam:* 码 → normal（消费侧）
 */
export function inferRoleFromCodes(v: MenuVisibility): MenuRole {
  if (v.isAdmin) return 'platform_admin'
  if (v.restricted) return 'normal'
  const owned = new Set(v.codes)
  if (IAM_MANAGE_CODES.some((c) => owned.has(c))) return 'tenant_admin'
  if (IAM_VIEW_CODES.some((c) => owned.has(c))) return 'readonly_audit'
  return 'normal'
}

/**
 * 按权限码裁剪后的可见菜单项（保留组内顺序）。
 *
 * 判定链：restricted → 仅无码项（工作台）；
 * code 未持有 → 隐藏；adminOnly 非 isAdmin → 隐藏（Hard Rule 双保险：权限码 + 管理员两道闸）。
 */
export function visibleMenuItems(v: MenuVisibility): MenuItem[] {
  const owned = new Set(v.codes)
  return MENU_ITEMS.filter((item) => {
    if (v.restricted) return item.code === undefined
    if (item.code !== undefined && !owned.has(item.code)) return false
    if (item.adminOnly && !v.isAdmin) return false
    return true
  })
}

/** 按组归集可见项（供侧边栏分组渲染；空组滤除） */
export function groupedVisibleMenu(
  v: MenuVisibility,
): { group: MenuGroup; items: MenuItem[] }[] {
  const items = visibleMenuItems(v)
  return MENU_GROUPS.map((group) => ({
    group,
    items: items.filter((i) => i.group === group.id),
  })).filter((entry) => entry.items.length > 0)
}

/** 按 path 找菜单项（面包屑「当前页」取 active 项文案用） */
export function findMenuItemByPath(path: string): MenuItem | undefined {
  // 精确匹配优先；其次前缀匹配（详情页 /users/:id 归属 /users）
  const exact = MENU_ITEMS.find((i) => i.path === path)
  if (exact) return exact
  return MENU_ITEMS.filter(
    (i) => path.startsWith(i.path + '/') || path === i.path,
  ).sort((a, b) => b.path.length - a.path.length)[0]
}