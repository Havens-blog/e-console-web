// @vitest-environment happy-dom
// menuConfig 单测（task 2.8 基线 → P0 权限码驱动版）。
// 覆盖：
// - MENU_ITEMS 11 项结构 + 权限码声明（与路由守卫 meta.permissions 同源）
// - visibleMenuItems：adminOnly 双闸 / 权限码过滤 / restricted 仅工作台
// - inferRoleFromCodes：platform_admin / tenant_admin / readonly_audit / normal
// - groupedVisibleMenu：分组归集 + 空组滤除
// - findMenuItemByPath：精确 + 前缀（详情页归属）
import { describe, expect, it } from "vitest";
import {
  MENU_GROUPS,
  MENU_ITEMS,
  findMenuItemByPath,
  groupedVisibleMenu,
  inferRoleFromCodes,
  visibleMenuItems,
} from "./menuConfig";
import {
  IAM_ALL_CODES,
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
} from "@/config/permission-codes";

/** 测试样本：只读审计码集（5 个查看页的 view 码） */
const READONLY_CODES: readonly string[] = [
  IAM_USER.VIEW,
  IAM_DEPARTMENT.VIEW,
  IAM_IDENTITY_SOURCE.VIEW,
  IAM_ROLE.VIEW,
  IAM_PERMISSION.VIEW_AUTHORIZATIONS,
];

/** 测试样本：租户管理员码集（工作台/用户/角色/授权 + 管理动词，无组织/身份源/策略/租户） */
const TENANT_ADMIN_CODES: readonly string[] = [
  IAM_USER.VIEW,
  IAM_USER.ADD,
  IAM_USER.EDIT,
  IAM_ROLE.VIEW,
  IAM_ROLE.EDIT,
  IAM_ROLE.BATCH_ASSIGN,
  IAM_ROLE.BATCH_UNASSIGN,
  IAM_PERMISSION.VIEW_AUTHORIZATIONS,
];

describe("MENU_ITEMS 结构（P0 权限码声明）", () => {
  it("11 项 3 组，顺序稳定", () => {
    expect(MENU_ITEMS).toHaveLength(11);
    expect(MENU_GROUPS.map((g) => g.id)).toEqual([
      "overview",
      "identity",
      "permission",
    ]);
    const keys = MENU_ITEMS.map((i) => i.key);
    expect(keys).toEqual([
      "workbench",
      "users",
      "organizations",
      "groups",
      "tenants",
      "identity-sources",
      "invitations",
      "roles",
      "authorizations",
      "policies",
      "audit",
    ]);
  });

  it("10 个业务项声明权限码（与路由守卫 meta.permissions 同源），工作台无码", () => {
    const byKey = Object.fromEntries(MENU_ITEMS.map((i) => [i.key, i]));
    expect(byKey["workbench"]!.code).toBeUndefined();
    expect(byKey["users"]!.code).toBe(IAM_USER.VIEW);
    expect(byKey["organizations"]!.code).toBe(IAM_DEPARTMENT.VIEW);
    expect(byKey["groups"]!.code).toBe(IAM_GROUP.VIEW);
    expect(byKey["tenants"]!.code).toBe(IAM_TENANT.VIEW);
    expect(byKey["identity-sources"]!.code).toBe(IAM_IDENTITY_SOURCE.VIEW);
    expect(byKey["invitations"]!.code).toBe(IAM_INVITATION.VIEW);
    expect(byKey["roles"]!.code).toBe(IAM_ROLE.VIEW);
    expect(byKey["authorizations"]!.code).toBe(IAM_PERMISSION.VIEW_AUTHORIZATIONS);
    expect(byKey["policies"]!.code).toBe(IAM_POLICY.VIEW);
    expect(byKey["audit"]!.code).toBe(IAM_AUDIT.VIEW_AUTH);
  });

  it("用户组管理项：path=/groups，归属 identity 组，图标已挂载", () => {
    const item = MENU_ITEMS.find((i) => i.key === "groups")!;
    expect(item.label).toBe("用户组管理");
    expect(item.path).toBe("/groups");
    expect(item.group).toBe("identity");
    expect(item.code).toBe(IAM_GROUP.VIEW);
    expect(item.icon).toBeTruthy();
  });

  it("邀请管理项：path=/invitations，归属 identity 组，adminOnly，图标已挂载", () => {
    const item = MENU_ITEMS.find((i) => i.key === "invitations")!;
    expect(item.label).toBe("邀请管理");
    expect(item.path).toBe("/invitations");
    expect(item.group).toBe("identity");
    expect(item.code).toBe(IAM_INVITATION.VIEW);
    expect(item.adminOnly).toBe(true);
    expect(item.icon).toBeTruthy();
  });

  it("审计日志项：path=/audit，归属 permission 组，code=VIEW_AUTH，adminOnly，图标已挂载", () => {
    const item = MENU_ITEMS.find((i) => i.key === "audit")!;
    expect(item.label).toBe("审计日志");
    expect(item.path).toBe("/audit");
    expect(item.group).toBe("permission");
    expect(item.code).toBe(IAM_AUDIT.VIEW_AUTH);
    expect(item.adminOnly).toBe(true);
    expect(item.icon).toBeTruthy();
  });

  it("租户/策略管理 adminOnly 双保险保留", () => {
    const flags = Object.fromEntries(
      MENU_ITEMS.map((i) => [i.key, i.adminOnly ?? false]),
    );
    expect(flags.tenants).toBe(true);
    expect(flags.policies).toBe(true);
    expect(flags.users).toBe(false);
  });
});

describe("visibleMenuItems（权限码驱动）", () => {
  const unrestricted = { restricted: false };

  it("平台管理员 + 全码：11 项全渲染", () => {
    const items = visibleMenuItems({
      codes: IAM_ALL_CODES,
      isAdmin: true,
      ...unrestricted,
    });
    expect(items).toHaveLength(11);
    expect(items.map((i) => i.key)).toContain("tenants");
    expect(items.map((i) => i.key)).toContain("policies");
    expect(items.map((i) => i.key)).toContain("groups");
    expect(items.map((i) => i.key)).toContain("invitations");
    expect(items.map((i) => i.key)).toContain("audit");
  });

  it("adminOnly 双闸：非管理员即使持有租户/策略码也不渲染", () => {
    const items = visibleMenuItems({
      codes: IAM_ALL_CODES,
      isAdmin: false,
      ...unrestricted,
    });
    const keys = items.map((i) => i.key);
    expect(keys).not.toContain("tenants");
    expect(keys).not.toContain("policies");
  });

  it("只读审计码集：渲染 6 项（工作台 + 5 个查看页），无租户/策略", () => {
    const items = visibleMenuItems({
      codes: READONLY_CODES,
      isAdmin: false,
      ...unrestricted,
    });
    expect(items.map((i) => i.key)).toEqual([
      "workbench",
      "users",
      "organizations",
      "identity-sources",
      "roles",
      "authorizations",
    ]);
  });

  it("租户管理员码集：渲染 4 项（工作台/用户/角色/授权）——原 inferRole 两档缺陷修复验证", () => {
    const items = visibleMenuItems({
      codes: TENANT_ADMIN_CODES,
      isAdmin: false,
      ...unrestricted,
    });
    expect(items.map((i) => i.key)).toEqual([
      "workbench",
      "users",
      "roles",
      "authorizations",
    ]);
  });

  it("无任何 iam 码（消费侧）：仅工作台", () => {
    const items = visibleMenuItems({
      codes: [],
      isAdmin: false,
      ...unrestricted,
    });
    expect(items.map((i) => i.key)).toEqual(["workbench"]);
  });

  it("restricted（零租户受限态）：即使持码也仅工作台", () => {
    const items = visibleMenuItems({
      codes: IAM_ALL_CODES,
      isAdmin: false,
      restricted: true,
    });
    expect(items.map((i) => i.key)).toEqual(["workbench"]);
  });

  it("缺失单个页码只隐藏对应项（码级粒度）", () => {
    const items = visibleMenuItems({
      codes: READONLY_CODES.filter((c) => c !== IAM_ROLE.VIEW),
      isAdmin: false,
      ...unrestricted,
    });
    const keys = items.map((i) => i.key);
    expect(keys).not.toContain("roles");
    expect(keys).toContain("users");
  });

  it("用户组管理项需 iam:group:view 且为管理员（与路由 requiresAdmin 一致）", () => {
    // 有码但缺权限码 → 不渲染
    const withoutGroupView = visibleMenuItems({
      codes: IAM_ALL_CODES.filter((c) => c !== IAM_GROUP.VIEW),
      isAdmin: true,
      ...unrestricted,
    });
    expect(withoutGroupView.map((i) => i.key)).not.toContain("groups");

    // 有码但**非管理员** → 不渲染（否则点进去会被路由守卫送到 /forbidden）
    const nonAdmin = visibleMenuItems({
      codes: [IAM_GROUP.VIEW],
      isAdmin: false,
      ...unrestricted,
    });
    expect(nonAdmin.map((i) => i.key)).not.toContain("groups");

    // 管理员 + 有码 → 渲染
    const admin = visibleMenuItems({
      codes: [IAM_GROUP.VIEW],
      isAdmin: true,
      ...unrestricted,
    });
    expect(admin.map((i) => i.key)).toEqual(["workbench", "groups"]);
  });

  it("邀请管理项需 iam:invitation:view 且为管理员（与路由 requiresAdmin 一致）", () => {
    // 有码但缺权限码 → 不渲染
    const withoutView = visibleMenuItems({
      codes: IAM_ALL_CODES.filter((c) => c !== IAM_INVITATION.VIEW),
      isAdmin: true,
      ...unrestricted,
    });
    expect(withoutView.map((i) => i.key)).not.toContain("invitations");

    // 有码但**非管理员** → 不渲染（否则点进去会被路由守卫送到 /forbidden）
    const nonAdmin = visibleMenuItems({
      codes: [IAM_INVITATION.VIEW],
      isAdmin: false,
      ...unrestricted,
    });
    expect(nonAdmin.map((i) => i.key)).not.toContain("invitations");

    // 管理员 + 有码 → 渲染
    const admin = visibleMenuItems({
      codes: [IAM_INVITATION.VIEW],
      isAdmin: true,
      ...unrestricted,
    });
    expect(admin.map((i) => i.key)).toEqual(["workbench", "invitations"]);
  });

  it("审计日志项需 iam:audit:view_auth 且为管理员（与路由 requiresAdmin 一致）", () => {
    // 缺权限码 → 不渲染
    const withoutView = visibleMenuItems({
      codes: IAM_ALL_CODES.filter((c) => c !== IAM_AUDIT.VIEW_AUTH),
      isAdmin: true,
      ...unrestricted,
    });
    expect(withoutView.map((i) => i.key)).not.toContain("audit");

    // 有码但**非管理员** → 不渲染（否则点进去会被路由守卫送到 /forbidden）
    const nonAdmin = visibleMenuItems({
      codes: [IAM_AUDIT.VIEW_AUTH, IAM_AUDIT.VIEW_OPERATION],
      isAdmin: false,
      ...unrestricted,
    });
    expect(nonAdmin.map((i) => i.key)).not.toContain("audit");

    // 管理员 + 有码 → 渲染
    const admin = visibleMenuItems({
      codes: [IAM_AUDIT.VIEW_AUTH],
      isAdmin: true,
      ...unrestricted,
    });
    expect(admin.map((i) => i.key)).toEqual(["workbench", "audit"]);
  });
});

describe("inferRoleFromCodes（工作台角色档位标签）", () => {
  it("isAdmin → platform_admin（无论码集）", () => {
    expect(
      inferRoleFromCodes({ codes: [], isAdmin: true, restricted: false }),
    ).toBe("platform_admin");
  });

  it("restricted（零租户）→ normal", () => {
    expect(
      inferRoleFromCodes({
        codes: IAM_ALL_CODES,
        isAdmin: false,
        restricted: true,
      }),
    ).toBe("normal");
  });

  it("持有 mutation 码 → tenant_admin", () => {
    expect(
      inferRoleFromCodes({
        codes: TENANT_ADMIN_CODES,
        isAdmin: false,
        restricted: false,
      }),
    ).toBe("tenant_admin");
  });

  it("仅 view 码 → readonly_audit", () => {
    expect(
      inferRoleFromCodes({
        codes: READONLY_CODES,
        isAdmin: false,
        restricted: false,
      }),
    ).toBe("readonly_audit");
  });

  it("无 iam 码 → normal", () => {
    expect(
      inferRoleFromCodes({ codes: ["cmdb:read"], isAdmin: false, restricted: false }),
    ).toBe("normal");
  });
});

describe("groupedVisibleMenu（分组归集）", () => {
  it("组顺序稳定 + 空组滤除", () => {
    const groups = groupedVisibleMenu({
      codes: TENANT_ADMIN_CODES,
      isAdmin: false,
      restricted: false,
    });
    expect(groups.map((g) => g.group.id)).toEqual([
      "overview",
      "identity",
      "permission",
    ]);
    // identity 组仅 users（organizations/tenants/identity-sources 均无码）
    expect(groups[1]!.items.map((i) => i.key)).toEqual(["users"]);
  });

  it("消费侧：仅工作台一组", () => {
    const groups = groupedVisibleMenu({
      codes: [],
      isAdmin: false,
      restricted: false,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.group.id).toBe("overview");
    expect(groups[0]!.items.map((i) => i.key)).toEqual(["workbench"]);
  });
});

describe("findMenuItemByPath", () => {
  it("精确匹配", () => {
    expect(findMenuItemByPath("/roles")!.key).toBe("roles");
  });

  it("前缀匹配（详情页 /users/:id 归属 /users，取最长前缀）", () => {
    expect(findMenuItemByPath("/users/42")!.key).toBe("users");
    expect(findMenuItemByPath("/roles/r-code")!.key).toBe("roles");
  });

  it("未知路径 → undefined", () => {
    expect(findMenuItemByPath("/nope")).toBeUndefined();
  });
});