/**
 * 租户「治理配置」列纯展示逻辑单测（feat-tenant-usage-stats，契约 §4.2）。
 *
 * 覆盖「用量 / 上限」四类分支：
 * 1. 正常：用量已知 + 配额 > 0 → '5 / 50'
 * 2. 不限：配额 = 0（eiam 语义不限制）→ '5 / 不限'
 * 3. 统计不可用：用量 undefined → '— / 50'（不得显示 0）
 * 4. 超限：用量 > 配额 > 0 → over=true + 「超出配额」标记
 *
 * 另锁定：0（真实为零）与 undefined（不可用）展示不同；不限永远不会「超限」；
 * 厂商 / 开关段沿用上一轮文案。
 */
import { describe, expect, it } from "vitest";
import type { Tenant } from "@/api/types";
import {
  OVER_QUOTA_TEXT,
  QUOTA_UNLIMITED_TEXT,
  QUOTA_UNLIMITED_TEXT_DETAIL,
  USAGE_PLACEHOLDER,
  formatQuota,
  formatUsage,
  governanceSegments,
  governanceSummary,
  isUsageOver,
} from "./usage";

/** 测试用租户（默认值 = 上一轮治理配置齐全 + 用量已知） */
function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 1,
    name: "测试租户",
    code: "test",
    domain: "",
    status: "active",
    maxAccounts: 10,
    maxUsers: 50,
    maxUserGroups: 20,
    featureSwitch: {},
    allowedVendors: [],
    ...overrides,
  };
}

describe("formatQuota（上限文案）", () => {
  it("正数 → 原值", () => {
    expect(formatQuota(50)).toBe("50");
  });

  it("0 / 负数 / undefined → '不限'（eiam 零值即无约束）", () => {
    expect(formatQuota(0)).toBe("不限");
    expect(formatQuota(-1)).toBe("不限");
    expect(formatQuota(undefined)).toBe("不限");
  });
});

describe("formatUsage（用量 / 上限）", () => {
  it("用量已知 + 配额 > 0 → '5 / 50'", () => {
    expect(formatUsage(5, 50)).toBe("5 / 50");
  });

  it("用量已知 + 配额 = 0 → '5 / 不限'", () => {
    expect(formatUsage(5, 0)).toBe("5 / 不限");
  });

  it("用量 undefined → '— / 50'（统计不可用不渲染 0）", () => {
    expect(formatUsage(undefined, 50)).toBe(`${USAGE_PLACEHOLDER} / 50`);
    expect(formatUsage(undefined, 50)).toBe("— / 50");
  });

  it("用量 0（真实为零）→ '0 / 50'，与 undefined 的 '— / 50' 不同", () => {
    expect(formatUsage(0, 50)).toBe("0 / 50");
    expect(formatUsage(0, 50)).not.toBe(formatUsage(undefined, 50));
  });

  it("用量与配额都缺省 → '— / 不限'", () => {
    expect(formatUsage(undefined, undefined)).toBe("— / 不限");
  });
});

describe("formatQuota：详情抽屉口径（feat-tenant-detail-ui 契约 §2.3）", () => {
  it("传详情文案 → 0 / 缺失显示「不限制」，正数仍为原值", () => {
    expect(formatQuota(0, QUOTA_UNLIMITED_TEXT_DETAIL)).toBe("不限制");
    expect(formatQuota(undefined, QUOTA_UNLIMITED_TEXT_DETAIL)).toBe("不限制");
    expect(formatQuota(50, QUOTA_UNLIMITED_TEXT_DETAIL)).toBe("50");
  });

  it("列表列口径不变（默认「不限」）", () => {
    expect(QUOTA_UNLIMITED_TEXT).toBe("不限");
    expect(formatQuota(0)).toBe("不限");
  });

  it("formatUsage 传详情文案 → 上限段用「不限制」，用量 '—' 口径不变", () => {
    expect(formatUsage(5, 0, QUOTA_UNLIMITED_TEXT_DETAIL)).toBe("5 / 不限制");
    expect(formatUsage(undefined, 50, QUOTA_UNLIMITED_TEXT_DETAIL)).toBe(
      "— / 50",
    );
  });
});

describe("isUsageOver（超限判定）", () => {
  it("用量 > 配额 > 0 → true", () => {
    expect(isUsageOver(51, 50)).toBe(true);
    expect(isUsageOver(6, 5)).toBe(true);
  });

  it("用量 = 配额 → false（用满不算超）", () => {
    expect(isUsageOver(50, 50)).toBe(false);
  });

  it("配额 0（不限）→ false（不限没有「超」的概念）", () => {
    expect(isUsageOver(999, 0)).toBe(false);
    expect(isUsageOver(999, undefined)).toBe(false);
  });

  it("用量未知（undefined）→ false（不臆造超限）", () => {
    expect(isUsageOver(undefined, 50)).toBe(false);
    expect(isUsageOver(undefined, 0)).toBe(false);
  });
});

describe("governanceSegments（治理配置列分段）", () => {
  it("正常：用户 / 组段均为「用量 / 上限」，且不含超限标记", () => {
    const segs = governanceSegments(
      makeTenant({ userCount: 5, userGroupCount: 3 }),
    );
    expect(segs.map((s) => s.key)).toEqual([
      "accounts",
      "users",
      "groups",
      "vendors",
      "switches",
    ]);
    expect(segs.find((s) => s.key === "users")).toMatchObject({
      text: "用户 5 / 50",
      over: false,
    });
    expect(segs.find((s) => s.key === "groups")).toMatchObject({
      text: "组 3 / 20",
      over: false,
    });
    // 账号段无用量数据源（cam 域本轮不做）→ 只显示上限
    expect(segs.find((s) => s.key === "accounts")?.text).toBe("账号 10");
  });

  it("不限：配额 0 → '用户 5 / 不限'，且不判定超限", () => {
    const segs = governanceSegments(
      makeTenant({ userCount: 5, maxUsers: 0, userGroupCount: 3, maxUserGroups: 0 }),
    );
    expect(segs.find((s) => s.key === "users")?.text).toBe("用户 5 / 不限");
    expect(segs.find((s) => s.key === "users")?.over).toBe(false);
    expect(segs.find((s) => s.key === "groups")?.text).toBe("组 3 / 不限");
    expect(segs.find((s) => s.key === "groups")?.over).toBe(false);
  });

  it("统计不可用：用量 undefined → '用户 — / 50'，且不判定超限", () => {
    const segs = governanceSegments(
      makeTenant({ userCount: undefined, userGroupCount: undefined }),
    );
    expect(segs.find((s) => s.key === "users")?.text).toBe("用户 — / 50");
    expect(segs.find((s) => s.key === "users")?.over).toBe(false);
    expect(segs.find((s) => s.key === "groups")?.text).toBe("组 — / 20");
  });

  it("超限：用量 > 配额 → 该段 over=true（其它段不受影响）", () => {
    const segs = governanceSegments(
      makeTenant({ userCount: 51, maxUsers: 50, userGroupCount: 3 }),
    );
    expect(segs.find((s) => s.key === "users")).toMatchObject({
      text: "用户 51 / 50",
      over: true,
    });
    expect(segs.find((s) => s.key === "groups")?.over).toBe(false);
    // 超限标记文案（视图徽标）
    expect(OVER_QUOTA_TEXT).toBe("超出配额");
  });

  it("用户组段独立判定超限", () => {
    const segs = governanceSegments(
      makeTenant({ userCount: 5, maxUsers: 50, userGroupCount: 21 }),
    );
    expect(segs.find((s) => s.key === "users")?.over).toBe(false);
    expect(segs.find((s) => s.key === "groups")).toMatchObject({
      text: "组 21 / 20",
      over: true,
    });
  });

  it("厂商 / 开关段沿用上一轮文案；空配置显示「全部厂商 / 无开关」", () => {
    const withConfig = governanceSegments(
      makeTenant({ allowedVendors: ["aliyun", "aws"], featureSwitch: { cdn: true } }),
    );
    expect(withConfig.find((s) => s.key === "vendors")?.text).toBe("2 家厂商");
    expect(withConfig.find((s) => s.key === "switches")?.text).toBe("1 项开关");

    const empty = governanceSegments(makeTenant({ allowedVendors: [], featureSwitch: {} }));
    expect(empty.find((s) => s.key === "vendors")?.text).toBe("全部厂商");
    expect(empty.find((s) => s.key === "switches")?.text).toBe("无开关");
  });

  it("profile 形态租户（治理配置全缺省）→ 全「不限」且用量 '—'，不抛错", () => {
    const t: Tenant = { id: 2, name: "裸租户", code: "bare", domain: "" };
    const segs = governanceSegments(t);
    expect(segs.find((s) => s.key === "accounts")?.text).toBe("账号 不限");
    expect(segs.find((s) => s.key === "users")?.text).toBe("用户 — / 不限");
    expect(segs.find((s) => s.key === "groups")?.text).toBe("组 — / 不限");
  });
});

describe("governanceSummary（整行文本）", () => {
  it("五段以 ' · ' 连接，用量与上限之间为 ' / '", () => {
    const summary = governanceSummary(
      makeTenant({
        userCount: 5,
        userGroupCount: 3,
        allowedVendors: ["aliyun", "aws"],
        featureSwitch: { cdn: true },
      }),
    );
    expect(summary).toBe(
      "账号 10 · 用户 5 / 50 · 组 3 / 20 · 2 家厂商 · 1 项开关",
    );
  });

  it("超限行整行文本仍可读（超限信息由 .is-over + 徽标承载）", () => {
    const summary = governanceSummary(makeTenant({ userCount: 51 }));
    expect(summary).toBe("账号 10 · 用户 51 / 50 · 组 — / 20 · 全部厂商 · 无开关");
  });
});
