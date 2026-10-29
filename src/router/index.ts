import type { RouteLocation, RouteLocationRaw, RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'
import { hasSessionCookie } from '@/api/request/eiam'
import { useUserStore } from '@/stores/user'
import {
  IAM_AUDIT,
  IAM_DEPARTMENT,
  IAM_GROUP,
  IAM_IDENTITY_SOURCE,
  IAM_INVITATION,
  IAM_PERMISSION,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
  IAM_USER,
} from '@/config/permission-codes'

/**
 * 路由表 + 全局守卫链（task 2.6）。
 *
 * 守卫链为唯一权限裁剪入口（Hard Rule），与 ui-design UF-2 菜单可见性口径逐项一致：
 *   ① cookie 缺失 / profile 拉取失败 → /console/login（带 redirect 回跳）
 *   ② mustSelectTenant（F-1：tenants.length>1）且 currentTenantId===0 → /tenant-select
 *   ③ permissions 裁剪不通过 → /forbidden（与菜单裁剪同口径，文案契约 forbidden）
 *   ④ 放行 → 记录 currentTenantId 入模块级单值快照（Integration 6 写前守卫取值）
 *
 * 权限码口径（P0，词表已定稿）：每条业务路由经 meta.permissions 声明所需 eiam 能力码
 * （单一事实源 src/config/permission-codes.ts，落档 parity §5）；requiresAdmin
 * （/tenants、/policies 平台管理员独占）为独立双保险，与权限码一起构成「两道闸俱过」。
 *
 * 路由全部 `import()` 懒加载（性能预算：11 页路由级代码分割）。
 * 快照非持久化、非第二份租户真相存储（Hard Rule）——仅页面进入时刻的观测值，
 * 真值唯一在服务端共享 session + tenant store currentTenantId。
 */

// ---- route meta 契约 ----

declare module 'vue-router' {
  interface RouteMeta {
    /** 公开路由，跳过全部守卫（登录页 / 403 页） */
    public?: boolean
    /** 租户选择页：经 ① cookie/profile 守卫，但跳过 ② mustSelectTenant 与 ③ 权限裁剪 */
    skipTenantGuard?: boolean
    /** 仅平台管理员可访问（ui-design：租户/策略管理仅平台管理员） */
    requiresAdmin?: boolean
    /** 所需 eiam 权限码（判定模式见 permissionMode，默认须具备全部；词表 = config/permission-codes.ts，parity §5 定稿） */
    permissions?: string[]
    /**
     * `permissions` 的判定模式，默认 `'all'`（须全部持有，既有路由口径不变）。
     *
     * 为何需要它：像 /audit 这类「一个页面多个页签、每个页签各需一码」的路由，
     * 若用 'all'，只持其中一码的用户会在路由层被拦到 /forbidden，
     * 而页面本身已按码裁剪页签 —— 两者矛盾。故此类路由声明 'any'。
     */
    permissionMode?: 'all' | 'any'
    /** 页面标题（feat-group-management 契约 §2.4；文档/面包屑兜底用，非守卫判据） */
    title?: string
  }
}

// ---- 路由表（17 条：13 页 + 2 子页 + 403 页 + 根重定向）----

export const routes: RouteRecordRaw[] = [
  {
    // 默认落地：登录态直接进根路径 `/` 时无页面组件，须重定向到工作台，否则空白页；
    // 未登录态由守卫 ① 先拦到 /login（redirect 于守卫前解析，落点最终由守卫再判）。
    path: '/',
    redirect: '/workbench',
  },
  {
    path: '/login',
    component: () => import('@/views/login/Login.vue'),
    meta: { public: true },
  },
  {
    path: '/workbench',
    component: () => import('@/views/workbench/Workbench.vue'),
  },
  {
    path: '/users',
    component: () => import('@/views/users/UserList.vue'),
    meta: { permissions: [IAM_USER.VIEW] },
  },
  {
    path: '/users/:id',
    component: () => import('@/views/users/UserDetail.vue'),
    meta: { permissions: [IAM_USER.VIEW] },
  },
  {
    path: '/organizations',
    component: () => import('@/views/organizations/OrgList.vue'),
    meta: { permissions: [IAM_DEPARTMENT.VIEW] },
  },
  {
    path: '/tenants',
    component: () => import('@/views/tenants/TenantList.vue'),
    meta: { requiresAdmin: true, permissions: [IAM_TENANT.VIEW] },
  },
  {
    path: '/identity-sources',
    component: () => import('@/views/identity-sources/IdpList.vue'),
    meta: { permissions: [IAM_IDENTITY_SOURCE.VIEW] },
  },
  {
    // 用户组管理（feat-group-management 契约 §2.4）：平台管理员独占 + iam:group:view 双闸
    path: '/groups',
    component: () => import('@/views/groups/GroupList.vue'),
    meta: {
      requiresAdmin: true,
      permissions: [IAM_GROUP.VIEW],
      title: '用户组管理',
    },
  },
  {
    // 邀请管理（feat-invitation-management 契约 §2.3）：平台管理员独占 + iam:invitation:view 双闸
    path: '/invitations',
    component: () => import('@/views/invitations/InvitationList.vue'),
    meta: {
      requiresAdmin: true,
      permissions: [IAM_INVITATION.VIEW],
      title: '邀请管理',
    },
  },
  {
    path: '/roles',
    component: () => import('@/views/roles/RoleList.vue'),
    meta: { permissions: [IAM_ROLE.VIEW] },
  },
  {
    path: '/roles/:id',
    component: () => import('@/views/roles/RoleDetail.vue'),
    meta: { permissions: [IAM_ROLE.VIEW] },
  },
  {
    path: '/authorizations',
    component: () => import('@/views/authorizations/AuthorizationList.vue'),
    meta: { permissions: [IAM_PERMISSION.VIEW_AUTHORIZATIONS] },
  },
  {
    path: '/policies',
    component: () => import('@/views/policies/PolicyList.vue'),
    meta: { requiresAdmin: true, permissions: [IAM_POLICY.VIEW] },
  },
  {
    // 审计日志（feat-audit-logs 契约 §2.4）：平台管理员独占 + 两个只读审计码双闸。
    // 页内两个页签各自按 view_auth / view_operation 显隐（缺码不渲染且不请求）。
    path: '/audit',
    component: () => import('@/views/audit/AuditLogList.vue'),
    meta: {
      requiresAdmin: true,
      permissions: [IAM_AUDIT.VIEW_AUTH, IAM_AUDIT.VIEW_OPERATION],
      // 任一码即可进入：页内两个页签各自按码显隐（缺码不渲染且不请求）。
      // 若用默认 'all'，只持 view_auth 的用户会在路由层就被送 /forbidden，
      // 与「页面按码单页签渲染」的设计自相矛盾。
      permissionMode: 'any',
      title: '审计日志',
    },
  },
  {
    path: '/tenant-select',
    component: () => import('@/views/tenant-select/TenantSelect.vue'),
    meta: { skipTenantGuard: true },
  },
  {
    path: '/forbidden',
    name: 'forbidden',
    component: () => import('@/views/error/Forbidden.vue'),
    meta: { public: true },
  },
]

export const router = createRouter({
  // BASE_URL 来自 vite base '/console/'，与 nginx 同域反代形态一致
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// ---- 模块级租户快照（Integration 6 写前守卫取值，task 3.1 消费）----

/**
 * 进入当前页面时观测到的租户 id（守卫 ④ 在每次放行后写入）。
 * 非持久化、非第二份租户真相存储——仅页进入时刻的观测值，真值在服务端共享 session
 * + tenant store currentTenantId。写前守卫（3.1）比对 create/update/remove 提交前的快照
 * 与 currentTenantId，不一致先刷新再提交，阻断「标签 B 呈现 X 租户数据、发出 Y 租户请求」。
 */
let pageEnterTenantSnapshot = 0

/** 读取进入页面时的租户快照（写前守卫 3.1 取值） */
export function getPageEnterTenantSnapshot(): number {
  return pageEnterTenantSnapshot
}

/** 测试复位用：清空快照（生产路径不经此） */
export function __resetPageEnterTenantSnapshot(): void {
  pageEnterTenantSnapshot = 0
}

// ---- 401 收敛：中断在途状态 + list store 复位 loading/error ----

/**
 * 401 收敛时复位在途 store 状态（tech-design §Error Handling：401 后中断在途路由请求、
 * list store 复位 loading/error；403 原地不跳转，二者区分）。
 *
 * 当前复位 user store（fetchProfile 在途 AbortController + 派生会话字段）与 tenant store
 * （switch 在途 + 上下文）。7 个 list store（4.x/5.x 落地后）经 registerUnauthorizedReset
 * 自助注册复位回调，避免守卫模块反向依赖未实现的 store——单点扩展、零硬编码清单。
 */
type UnauthorizedReset = () => void
const unauthorizedResets: UnauthorizedReset[] = []

/** list store 自助注册 401 复位回调（4.x/5.x list store 落地时调用） */
export function registerUnauthorizedReset(fn: UnauthorizedReset): void {
  unauthorizedResets.push(fn)
}

function resetStoresOnUnauthorized(): void {
  // user.resetState 复位 user 派生字段 + 调用 tenant.resetState（租户上下文唯一归属）
  useUserStore().resetState()
  for (const fn of unauthorizedResets) {
    try {
      fn()
    } catch {
      // 单个 store 复位失败不阻断其余复位（韧性：401 收敛路径不可因复位抛错而中断跳转）
    }
  }
}

// ---- 全局守卫链（beforeEach 四步）----

/**
 * 登录跳转目标构造（带 redirect 回跳，与 eiam.ts redirectToLogin 同款语义但走 SPA 导航）。
 * 守卫的 ① 路径（cookie 缺失 / profile 失败）用此做 SPA 跳转，避免硬 window.location 跳转
 * 丢失 SPA 状态；请求层 401（list fetch 等非守卫路径）仍由 eiam.ts redirectToLogin 硬跳。
 */
function redirectToLogin(to: RouteLocation): RouteLocationRaw {
  resetStoresOnUnauthorized()
  return { path: '/login', query: { redirect: to.fullPath } }
}

/** 403 跳转目标（守卫 ③ 裁剪不通过 → 403 页，文案契约 forbidden；缺失码经 query 透传 403 页展示） */
function redirectToForbidden(missing: readonly string[]): RouteLocationRaw {
  return missing.length > 0
    ? { name: 'forbidden', query: { required: missing.join(',') } }
    : { name: 'forbidden' }
}

/**
 * 权限裁剪（守卫 ③，与菜单裁剪同口径）。
 * - requiresAdmin：!isAdmin → 403（ui-design：租户/策略管理仅平台管理员；缺失码记 'is_admin'）
 * - permissions：用户须具备全部所需权限码（hasPermission 逐项；词表 = permission-codes.ts，parity §5 定稿）
 * 返回缺失码清单（空数组 = 放行），供守卫决策与 403 页展示（原型口径：展示所需码）。
 */
function missingPermissionCodes(to: RouteLocation): string[] {
  const userStore = useUserStore()
  const missing: string[] = []
  if (to.meta.requiresAdmin && !userStore.isAdmin) missing.push('is_admin')
  const required = to.meta.permissions
  if (required && required.length > 0) {
    if (to.meta.permissionMode === 'any') {
      // 任一命中即通过（多页签页面各需一码的场景）；全缺才记缺失。
      if (!required.some((code) => userStore.hasPermission(code))) {
        missing.push(...required)
      }
    } else {
      for (const code of required) {
        if (!userStore.hasPermission(code)) missing.push(code)
      }
    }
  }
  return missing
}

function passesPermissionCheck(to: RouteLocation): boolean {
  return missingPermissionCodes(to).length === 0
}

router.beforeEach(async (to) => {
  // 公开路由（登录页 / 403 页）跳过全部守卫
  if (to.meta.public) return true

  // ① cookie 缺失 → 跳登录（同步判定，避免明知无凭据仍发 profile 请求触发 401 硬跳）
  if (!hasSessionCookie()) {
    return redirectToLogin(to)
  }

  const userStore = useUserStore()

  // ① profile 拉取：未加载则拉取；失败按 kind 裁决（401→登录 / 5xx·网络→降级放行）。
  //    仅在 profile 为空且非在途时触发，避免每次导航重复拉取。
  if (!userStore.profile && !userStore.loading) {
    const ok = await userStore.fetchProfile()
    if (!ok) {
      // 401/未认证（含载荷无法解析的未登录兜底）：守卫 SPA 跳登录 + 复位在途状态。
      // 注：若失败源于 401，eiam.ts 响应拦截器已置 isRedirectingToLogin 并触发硬跳；
      //    此处 SPA 跳转与硬跳同向 /console/login，不冲突（硬跳胜出亦无碍）。
      if (!userStore.authUnavailable) {
        return redirectToLogin(to)
      }
      // 5xx/网络错（eiam 不可用）——F 产品缺口裁决：401→登录 vs 5xx→降级（tech-design §7）。
      // 不跳登录，继续走 ②③④：/workbench 无权限要求 → 放行并渲染降级横幅；
      // 权限页因空权限在 ③ fail-closed 拦到 /forbidden（只读降级，不越权）。
    }
  }

  // ② mustSelectTenant（F-1：tenants.length>1）且 currentTenantId===0 → 跳租户选择页
  //    currentTenantId===0 防止选中租户后（switch+reload → profile.current_tenant_id>0）循环。
  //    租户选择页自身 skipTenantGuard，不被此步拦回。
  if (!to.meta.skipTenantGuard) {
    if (userStore.mustSelectTenant && userStore.currentTenantId === 0) {
      return { path: '/tenant-select' }
    }
  }

  // ③ permissions 裁剪不通过 → 403 页（与菜单裁剪同口径；缺失码透传展示）
  if (!passesPermissionCheck(to)) {
    return redirectToForbidden(missingPermissionCodes(to))
  }

  // ④ 放行 → 记录 currentTenantId 入模块级单值快照（写前守卫 3.1 取值）
  pageEnterTenantSnapshot = userStore.currentTenantId

  return true
})
