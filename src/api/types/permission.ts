/**
 * 权限管理域类型：角色 / 授权 / 策略（tech-design §Data Models + Phase 0 parity D-3/D-4/D-5 回填）。
 */
import type { Ref } from './common'

/**
 * 角色（UF-8）。eiam 实盘字段 id/code/name/desc —— 注意是 `desc` 非 `description`
 * （tech-design §Interfaces A 档实盘核验）。policies/users 两字段不在 role/list 直出：
 * 角色已绑策略 = POST /api/iam/policy/list/attached/role（载荷 role_code）、
 * 角色已绑用户 = POST /api/iam/user/list/attached/role（载荷 role_code）—— 均由 api 层回填
 * （parity 分歧 D-3：C 档推定的 role/attached/* 路径改判）。
 */
export interface Role {
  id: number
  /** 角色 code；分配与策略绑定均以 code 为准（batch_assign 载荷 role_codes、policy/list/attached/role 载荷 role_code） */
  code: string
  name: string
  desc: string
  tenantId: number
  /** 已绑策略引用（api 层经 policy/list/attached/role 回填） */
  policies: Ref[]
  /** 已绑用户引用（api 层经 user/list/attached/role 回填） */
  users: Ref[]
}

/**
 * 授权三元组（UF-9，词表自 eiam）。Phase 0 模型级改判（parity 分歧 D-4 + 缺口 G-6）：
 * eiam 授权模型为 **主体→目标（role|policy）二元绑定**（permission/authorizations →
 * `Authorization{subject, target, sub_type, obj_type}`），无 subject/resource/action 三元组 CRUD 端点。
 * G-6 语义映射（待业务 owner 书面确认）：「授权」页按两类绑定呈现 ——
 * 主体→策略（policy/batch-attach|batch-detach）+ 主体→角色（role/batch_assign|batch_unassign）。
 * 本类型保留设计形作为三元组词表枚举的视图形；UF-9 页面（task 5.2）随 G-6 定稿在 api 层修订映射。
 */
export interface Authorization {
  subject: string
  resource: string
  action: string
}

/**
 * 策略条件数组：每条 `{key, operator, values}`（tech-design Data Models）。
 * **Phase 0 核查项未结**：operator 词表 parity-checklist 无记录（eiam 侧 schema 词表未盘点），
 * 维持 string 直通（「待核验假设」原样保留）—— task 5.3 策略页联调时随 eiam 服务端 schema
 * 校验回填词表并登记 parity-checklist。
 */
export type PolicyCondition = Array<{
  key: string
  operator: string
  values: string[]
}>

/**
 * 单条声明；Effect 首字母大写对齐 UF-10 词表。
 * Phase 0 实核（parity 分歧 D-5，tech-design 重点核查项已结）：
 * - eiam 原生即 Statement 数组（`CreatePolicyReq.Statement []Statement`）—— Effect ∈ {"Allow","Deny"} ✓
 *   （domain/policy.go:27-31）；
 * - eiam 容器键为单数 `statement`（非 statements），成员键为单数 `effect/action/resource/condition`
 *   （非 actions/resources）+ 附加 `access_scope`（policy/vo.go:10,31-37）—— 类型层把单数键归一为
 *   本规范复数 camelCase 形；access_scope 不入 v1 规范形（需要时 api 层扩展）。
 */
export interface PolicyStatement {
  effect: 'Allow' | 'Deny'
  actions: string[]
  resources: string[]
  condition?: PolicyCondition
}

/**
 * 策略（UF-10）：策略 = Statement 数组，一条策略可同时含 Allow 与 Deny 声明。
 * 归一规则（Phase 0 已结 —— D-5）：实核 eiam 原生即 Statement[]，tech-design 预置的
 * 「扁平单 effect ≡ 恰含一条 Statement 的数组」兼容归一**无需触发**；若未来出现扁平形态仍按该规则归一
 * （顶层 effect + actions/resources ≡ 恰含一条 Statement 的数组），且扁平结构无法表达多 Statement 策略时
 * 上报 validation（不静默截断）。
 * eiam 端点以 **code** 为键（GET/DELETE /api/policy/detail|delete/:code）且 PolicyVO 携带 code 与
 * assignment_count（承载 E11 删除被拒的绑定计数提示）—— 本规范形保持设计最小字段集，
 * code/assignment_count 承载随 api 客户端（task 2.4 / 5.3）扩展（不提前扩形）。
 */
export interface Policy {
  id: number
  name: string
  statements: PolicyStatement[]
}
