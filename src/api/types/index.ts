/**
 * 控制台数据模型类型总出口（task 2.3 数据模型 + task 2.4 错误契约）。
 * 除错误契约 ApiError（运行时 class，支撑视图层唯一 instanceof catch）外均为纯类型。
 * 视图层 / api 客户端 / stores 统一从 `@/api/types` 引入；
 * eiam 原生形状（snake_case 键、单数 statement 键、{total,users} 分页键等）仅在 api 映射层出现，
 * 未经归一不得越过本目录直出视图层（Hard Rule）。
 */
export type { Envelope, ListQuery, Page, Ref, RoleRef } from "./common";
export type {
  LoginResult,
  PasskeyRegistrationSession,
  SessionClaims,
} from "./auth";
export type {
  Organization,
  OrganizationNode,
  Tenant,
  TenantMember,
  User,
} from "./identity";
export type { ConnParams, IdentitySource } from "./identity-source";
export type {
  Authorization,
  Policy,
  PolicyCondition,
  PolicyStatement,
  Role,
} from "./permission";
export { ApiError } from "./errors";
export type { ErrorKind, FieldErrors } from "./errors";
