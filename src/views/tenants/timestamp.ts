/**
 * eiam 时间戳格式化（单一实现，租户详情 / 成员抽屉共用）。
 *
 * 单位是硬知识（不可猜）：eiam 的 `tenant.ctime`（`dao/tenant.go` 的 `time.Now().UnixMilli()`）
 * 与 `user.last_login_at`（`service/user/coordinator.go` 的 `time.Now().UnixMilli()`）
 * 都是 **Unix 毫秒**。因此直接 `new Date(ms)`，**绝不能再乘 1000**。
 *
 * 背景：此前的实现按「秒」处理（`new Date(seconds * 1000)`），把年份推到了 58563 年。
 * 该缺陷由浏览器验收（详情抽屉「创建时间」显示异常）发现，而后发现成员抽屉「最近登录」同源同病。
 *
 * 合理性护栏：eiam 只可能记录 2000–2100 之间的时间；越界一律降级 `—`，
 * 这样即使将来有人再次搞错单位，界面上也只会"看不到时间"，不会显示荒谬年份。
 */

/** 无值占位（与本页其他降级口径一致） */
export const TIMESTAMP_PLACEHOLDER = "—";

/** 可接受的年份区间（越界视为单位/脏数据异常） */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/**
 * Unix 毫秒 → 本地 `YYYY-MM-DD HH:mm(:ss)`。
 *
 * @param ms Unix 毫秒时间戳
 * @param withSeconds 是否带秒（成员列表列较窄，用 false 只到分钟）
 * @returns 缺失 / 非有限 / <=0 / 年份越界 → `—`
 */
export function formatEpochMs(ms?: number, withSeconds = true): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return TIMESTAMP_PLACEHOLDER;
  }
  const date = new Date(ms);
  const year = date.getFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    return TIMESTAMP_PLACEHOLDER;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  const base = `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}
