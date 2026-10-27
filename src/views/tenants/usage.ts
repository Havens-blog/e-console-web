/**
 * 租户列表「治理配置」列的纯展示逻辑（feat-tenant-usage-stats，契约 §4.2）。
 *
 * 从 TenantList.vue 抽出为纯函数，便于单测覆盖「用量 / 上限」四类分支
 * （正常 / 不限 / 统计不可用 '—' / 超限），无需挂载组件。
 *
 * 数据语义（契约 §2.3 + §4.1）：
 * - 用量 undefined = 统计不可用 → 渲染 '—'（不得渲染 0，避免误读为「该租户无用户」）；
 * - 用量 0 = 后端统计成功且真实为零 → 渲染 '0'；
 * - 配额 0（或负数）= eiam 语义「不限制」→ 渲染 '不限'。
 *
 * 云账号数用量本轮**不做**（属 eam/cam 域数据，需求卡「不包含」）——
 * 账号段只显示上限，不显示用量，避免把缺失误读为「无云账号」。
 */
import type { Tenant } from "@/api/types";

/** 统计不可用占位符（与页面既有活跃会话数列降级口径一致） */
export const USAGE_PLACEHOLDER = "—";

/** 超出配额标记文案 */
export const OVER_QUOTA_TEXT = "超出配额";

/**
 * 「无上限」文案（两处口径，语义相同、措辞按契约各自固定）：
 * - 列表「治理配置」列：'不限'（feat-tenant-usage-stats 既有口径，不改）；
 * - 详情抽屉：'不限制'（feat-tenant-detail-ui 契约 §2.3 逐字要求）。
 * 判定（配额 > 0 才算设了上限）只有一份实现，见 formatQuota。
 */
export const QUOTA_UNLIMITED_TEXT = "不限";
export const QUOTA_UNLIMITED_TEXT_DETAIL = "不限制";

/**
 * 配额上限文案：>0 → 原值；0 / 负数 / 缺失 → 无上限文案（默认 '不限'；
 * 详情抽屉传 QUOTA_UNLIMITED_TEXT_DETAIL 得 '不限制'）。
 */
export function formatQuota(
  quota: number | undefined,
  unlimitedText: string = QUOTA_UNLIMITED_TEXT,
): string {
  return typeof quota === "number" && quota > 0 ? String(quota) : unlimitedText;
}

/**
 * 是否超出配额：三个条件同时成立才算——
 * 用量已知（undefined 不参与比较）、配额 > 0（不限没有「超」的概念）、用量 > 配额。
 */
export function isUsageOver(
  used: number | undefined,
  quota: number | undefined,
): boolean {
  return (
    typeof used === "number" &&
    typeof quota === "number" &&
    quota > 0 &&
    used > quota
  );
}

/**
 * 用量 / 上限文案（契约 §4.2）：
 * - 用量已知 + 配额 > 0 → '5 / 50'
 * - 用量已知 + 配额 = 0 → '5 / 不限'
 * - 用量未知（undefined）→ '— / 50'
 */
export function formatUsage(
  used: number | undefined,
  quota: number | undefined,
  unlimitedText: string = QUOTA_UNLIMITED_TEXT,
): string {
  const usedText =
    typeof used === "number" ? String(used) : USAGE_PLACEHOLDER;
  return `${usedText} / ${formatQuota(quota, unlimitedText)}`;
}

/** 治理配置列的段标识（视图据此渲染 + 测试定位 .is-over 段） */
export type GovernanceSegmentKey =
  | "accounts"
  | "users"
  | "groups"
  | "vendors"
  | "switches";

export interface GovernanceSegment {
  key: GovernanceSegmentKey;
  /** 该段展示文本，如 '用户 5 / 50' */
  text: string;
  /** 是否超出配额（true → 视图加 .is-over + 「超出配额」标记） */
  over: boolean;
}

/**
 * 治理配置列分段（账号 / 用户 / 组 / 厂商 / 开关）。
 * 视图按段渲染，超限段单独着色；各段之间由视图插入 ' · ' 分隔。
 * 顺序与上一轮摘要保持一致，仅在用户 / 组两段内新增「用量 / 上限」。
 */
export function governanceSegments(t: Tenant): GovernanceSegment[] {
  const vendors = t.allowedVendors ?? [];
  const switches = Object.keys(t.featureSwitch ?? {});
  return [
    // 账号：无用量数据源（cam 域，本轮不做）→ 只显示上限
    { key: "accounts", text: `账号 ${formatQuota(t.maxAccounts)}`, over: false },
    {
      key: "users",
      text: `用户 ${formatUsage(t.userCount, t.maxUsers)}`,
      over: isUsageOver(t.userCount, t.maxUsers),
    },
    {
      key: "groups",
      text: `组 ${formatUsage(t.userGroupCount, t.maxUserGroups)}`,
      over: isUsageOver(t.userGroupCount, t.maxUserGroups),
    },
    {
      key: "vendors",
      text: vendors.length > 0 ? `${vendors.length} 家厂商` : "全部厂商",
      over: false,
    },
    {
      key: "switches",
      text: switches.length > 0 ? `${switches.length} 项开关` : "无开关",
      over: false,
    },
  ];
}

/**
 * 治理配置列整行纯文本（分隔 ' · '）。
 * 视图用作单元格 title（悬停可读全文），同时作为单测断言整行排版的入口。
 */
export function governanceSummary(t: Tenant): string {
  return governanceSegments(t)
    .map((s) => s.text)
    .join(" · ");
}
