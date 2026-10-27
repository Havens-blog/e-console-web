/**
 * 统一归一类型（tech-design §Interfaces「统一请求/归一类型」+ §2.1 A 档信封实盘核验）。
 *
 * Hard Rule：eiam 原生形状未经归一不得直出视图层 —— 归一收敛在 api/类型层（本目录）：
 * - 信封字段为 `msg`（非 `message`，e-cam-web eiam-mapper.ts 实盘核验）；
 * - eiam 分页键 `{total, users|roles|tenants|...}` 归一为 `Page<T>.items`；
 * - snake_case 原生键（mfa_required / bind_token / parent_id / bind_dn 等）一律归一 camelCase。
 */

/** ginx 信封：所有 eiam 响应统一包裹；成功 code === 0（api 层经 unwrapEnvelope<T>() 解包，task 2.4） */
export interface Envelope<T> {
  /** 业务码；0 = 成功，非 0 原值透传给文案契约 key（tech-design §Error Handling） */
  code: number
  /** 提示消息（eiam 原生即 `msg`） */
  msg: string
  /** 业务载荷 */
  data: T
}

/** 统一列表查询入参：全部 list 端点共用（视图层 → api 客户端唯一查询形） */
export interface ListQuery {
  /** 分页偏移（显式传参，不设默认值） */
  offset: number
  /** 页大小 */
  limit: number
  /** 关键字（空串 = 不过滤） */
  keyword: string
  /**
   * 状态筛选（仅租户列表等支持该维度的端点消费；缺省 / 0 = 不过滤）。
   * 语义：0=全部、1=启用(active)、2=禁用(disable)；其他值由后端返回空结果（契约 §2.3）。
   * 可选：各 list 端点按自身能力决定是否放进请求体（租户见 api/tenants.ts listTenants）。
   */
  status?: number
}

/** 统一分页归一形：api 层把 eiam 的 `{total, users|roles|tenants|...}` 收敛为 items */
export interface Page<T> {
  /** 满足条件的总条数（分页器数据源） */
  total: number
  /** 当前页数据（归一键，视图层只认 items） */
  items: T[]
}

// ---- 共享引用类型 ----

/** 通用引用（id + name） */
export interface Ref {
  id: number
  name: string
}

/**
 * 角色引用；eiam 角色分配以 code 为准（实盘：role/batch_assign 载荷为 role_codes —— parity §2.1 A 档实核）。
 */
export interface RoleRef {
  id: number
  /** 角色 code；batch_assign/batch_unassign 载荷键 role_codes 即此值 */
  code: string
  name: string
}
