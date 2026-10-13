/**
 * 身份源域类型（UF-7；tech-design §Data Models + Phase 0 parity D-2 回填）。
 */

/**
 * UF-7 连接参数规范形（六字段）。
 * Phase 0 形状分歧（parity D-2）：eiam 实际载荷为嵌套 `{id, name, type, enabled, ldap{...}}`
 * （save 为 upsert，无独立 create/update）；LDAPVO 实盘
 * `{url, base_dn, bind_dn, bind_password, username_attribute, mail_attribute, display_name_attribute,
 * title_attribute, user_filter, sync_user_filter}` —— **无独立 port（含于 url）、无 timeoutSec 载荷位**。
 * 处置（D-2）：UF-7 表单 port/超时 → 前端仅入 url 组装与本地校验，或并入 G 类缺口处置（随 eiam owner 意见定）。
 * 本类型为控制台规范形；eiam 嵌套形 ↔ 规范形双向映射收敛在 api 层（task 2.4 / 4.5）。
 */
export interface ConnParams {
  /** ldap:// 或 ldaps://host:port；eiam 无独立 port 字段（D-2），端口组装进 url */
  url: string
  /** 端口 1–65535；eiam 无独立载荷位（D-2）—— 仅作表单组装与本地校验 */
  port: number
  /** Bind DN，必填（eiam 原值 bind_dn） */
  bindDn: string
  /** Bind 密码（eiam 原值 bind_password）；**仅写入**，响应掩码不回显，编辑态占位 '******' */
  password: string
  /** Base DN，必填（eiam 原值 base_dn） */
  baseDn: string
  /** 属性映射：用户名属性必填（eiam 原值 username_attribute / mail_attribute / display_name_attribute；
   * eiam 另有 title_attribute、user_filter、sync_user_filter 不入 v1 规范形） */
  attrMap: {
    username: string
    email?: string
    dn?: string
  }
  /** 超时 1–30 秒，默认 5；eiam 无对应载荷位（D-2）—— 仅本地校验用 */
  timeoutSec: number
}

/**
 * 身份源（UF-7）。type 词表当前仅 'ldap'（eiam LDAPVO 实核）；
 * eiam 载荷嵌套 `{id, name, type, enabled, ldap{...}}`、save 语义 upsert（D-2）→ conn 即 ldap 子对象归一形。
 */
export interface IdentitySource {
  id: number
  name: string
  type: 'ldap'
  conn: ConnParams
  enabled: boolean
}
