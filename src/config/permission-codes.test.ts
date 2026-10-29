/**
 * 权限码词表 · 角色关联分组（feat-role-bound-groups 契约 §2.1）。
 *
 * 词表是菜单 / 路由守卫 / 按钮裁剪的单一事实源，码值或归档位错一处就会让整块静默消失，
 * 故用单测锁死三件事：
 * - 码值与 eiam `group/handler.go:61` 的 `view_role_groups` 一致（`iam:group:` 前缀）；
 * - 归入「查看类集合」（IAM_VIEW_CODES，与 VIEW_USER_GROUPS 同处）→ 角色档位推断口径一致；
 * - 不出现在「管理类集合」（IAM_MANAGE_CODES）→ 只读码不得被当成可写能力。
 */
import { describe, expect, it } from "vitest";
import {
  IAM_ALL_CODES,
  IAM_GROUP,
  IAM_MANAGE_CODES,
  IAM_VIEW_CODES,
} from "./permission-codes";

describe("IAM_GROUP.VIEW_ROLE_GROUPS（角色关联分组）", () => {
  it("码值与 eiam view_role_groups 一致", () => {
    expect(IAM_GROUP.VIEW_ROLE_GROUPS).toBe("iam:group:view_role_groups");
  });

  it("纳入查看类码集合（与 VIEW_USER_GROUPS 同处）且不进管理类", () => {
    expect(IAM_VIEW_CODES).toContain(IAM_GROUP.VIEW_USER_GROUPS);
    expect(IAM_VIEW_CODES).toContain(IAM_GROUP.VIEW_ROLE_GROUPS);
    expect(IAM_MANAGE_CODES).not.toContain(IAM_GROUP.VIEW_ROLE_GROUPS);
    expect(IAM_ALL_CODES).toContain(IAM_GROUP.VIEW_ROLE_GROUPS);
  });

  it("查看 / 管理两集合仍互斥，且全量无重复（新增码未打破既有不变量）", () => {
    expect(
      IAM_VIEW_CODES.filter((code) => IAM_MANAGE_CODES.includes(code)),
    ).toEqual([]);
    expect(new Set(IAM_ALL_CODES).size).toBe(IAM_ALL_CODES.length);
  });
});
