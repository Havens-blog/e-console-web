// @vitest-environment happy-dom
/**
 * eiam 时间戳格式化单测（./timestamp.ts）。
 *
 * 本文件的存在意义：此前两个抽屉都把 eiam 的**毫秒**时间戳当**秒**处理（`new Date(v*1000)`），
 * 界面上把年份显示成 58563 年。为防回归，这里锁三件事：
 * 1. 毫秒输入 → 正确的本地时间；
 * 2. 「误当秒」的输入（形如 1.7e9）→ 因年份越界降级为 `—`，绝不显示荒谬年份；
 * 3. 缺失 / 0 / 非有限 → `—`。
 */
import { describe, expect, it } from "vitest";
import { formatEpochMs, TIMESTAMP_PLACEHOLDER } from "./timestamp";

/** 构造本地时间，避免测试受时区影响（格式化为本地时间，构造也用本地时间） */
function localMs(
  y: number, mo: number, d: number, h: number, mi: number, s: number,
): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

describe("formatEpochMs（eiam 时间戳 = Unix 毫秒）", () => {
  it("毫秒输入 → 'YYYY-MM-DD HH:mm:ss'（本地时间）", () => {
    const ms = localMs(2026, 10, 27, 14, 5, 9);
    expect(formatEpochMs(ms)).toBe("2026-10-27 14:05:09");
  });

  it("withSeconds=false → 只到分钟（成员列表列较窄）", () => {
    const ms = localMs(2026, 10, 27, 14, 5, 9);
    expect(formatEpochMs(ms, false)).toBe("2026-10-27 14:05");
  });

  it("回归护栏：把毫秒误当秒的输入（1.7e9 级）→ 降级 '—'，不显示荒谬年份", () => {
    // 1_730_000_000 当作毫秒 = 1970-01-21，年份越界 → '—'
    expect(formatEpochMs(1_730_000_000)).toBe(TIMESTAMP_PLACEHOLDER);
    // 若实现写成 new Date(v*1000)，会得到 58563 年——这里必须挡住
    expect(formatEpochMs(1_790_000_000_000)).not.toMatch(/^5\d{4}/);
  });

  it("缺失 / 0 / 负数 / 非有限 → '—'（0 表示未记录）", () => {
    expect(formatEpochMs(undefined)).toBe(TIMESTAMP_PLACEHOLDER);
    expect(formatEpochMs(0)).toBe(TIMESTAMP_PLACEHOLDER);
    expect(formatEpochMs(-1)).toBe(TIMESTAMP_PLACEHOLDER);
    expect(formatEpochMs(Number.NaN)).toBe(TIMESTAMP_PLACEHOLDER);
    expect(formatEpochMs(Number.POSITIVE_INFINITY)).toBe(TIMESTAMP_PLACEHOLDER);
  });

  it("年份恒在 2000–2100 之间（任何输入都不产出越界年份）", () => {
    const samples = [localMs(2000, 1, 1, 0, 0, 0), localMs(2100, 12, 31, 23, 59, 59), localMs(2026, 10, 27, 0, 0, 0)];
    for (const ms of samples) {
      const text = formatEpochMs(ms);
      const year = Number(text.slice(0, 4));
      expect(year).toBeGreaterThanOrEqual(2000);
      expect(year).toBeLessThanOrEqual(2100);
    }
  });
});
