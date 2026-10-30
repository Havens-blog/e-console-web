// @vitest-environment happy-dom
/**
 * user store（2.7）契约测试。
 *
 * 覆盖 AC：
 * - profile 拉取（GET /api/iam/user/profile 归一 ProfileData）、permissions、currentTenantId、
 *   isAdmin/mustSelectTenant
 * - fetch 前 AbortController 中断在途请求；profile 失败归位 error（contractText(code)/message 回退）
 * - 不声明 persist（会话态不落 localStorage）
 * - F-1（parity §6.1.4）：mustSelectTenant 由 tenants.length>1 自算，不依赖 profile 恒 false 字段
 * - 租户上下文唯一归属 tenant.ts：currentTenantId 经 tenant store 委托
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "vue";
import { useUserStore } from "./user";
import { useTenantStore } from "./tenant";
import { eiamAxios } from "@/api/request/eiam";
import { IAM_USER } from "@/config/permission-codes";

const STATUS_TEXT: Partial<Record<number, string>> = {
  200: "OK",
  500: "Internal Server Error",
};

interface MockReply {
  status?: number;
  body?: unknown;
  networkFailure?: { code: string; message: string };
}

function settleLike(response: AxiosResponse): AxiosResponse {
  const validate =
    response.config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  if (validate(response.status)) return response;
  throw new AxiosError(
    `Request failed with status code ${response.status}`,
    AxiosError.ERR_BAD_REQUEST,
    response.config,
    undefined,
    response,
  );
}

/** live 形状样本（parity §6.1.4）：profile data 顶层键 */
function sampleProfileData(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    user: {
      id: 1,
      username: "admin",
      nickname: "管理员",
      email: "admin@example.com",
      avatar: "/a.png",
      job_title: "平台管理员",
      phone: "13800000000",
      status: "active",
      source: "local",
    },
    tenants: [
      { id: 1, name: "系统租户", code: "system", domain: "sys.example.com" },
      { id: 4, name: "个人空间", code: "personal", domain: "p.example.com" },
    ],
    current_tenant_id: 4,
    is_admin: true,
    permissions: [IAM_USER.VIEW, IAM_USER.ADD],
    must_select_tenant: false, // F-1：恒 false，store 不读此字段
    ...overrides,
  };
}

async function freshStore(
  replyFor: (config: InternalAxiosRequestConfig) => MockReply,
) {
  // 直接 patch 共享 eiamAxios 实例（store 静态 import 同一实例，patch 即生效）。
  // abort 由 axios throwIfCancellationRequested 在 adapter 前据 signal.aborted 处理。
  eiamAxios.defaults.adapter = ((config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve, reject) => {
      const reply = replyFor(config);
      if (reply.networkFailure) {
        reject(
          new AxiosError(
            reply.networkFailure.message,
            reply.networkFailure.code,
            config,
          ),
        );
        return;
      }
      try {
        resolve(
          settleLike({
            data: reply.body ?? null,
            status: reply.status ?? 200,
            statusText: STATUS_TEXT[reply.status ?? 200] ?? "",
            headers: {},
            config,
          } as AxiosResponse),
        );
      } catch (e) {
        reject(e);
      }
    })) as unknown as typeof eiamAxios.defaults.adapter;
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  return { user: useUserStore(), tenant: useTenantStore() };
}

afterEach(() => {
  // 还原 adapter（避免影响其他用例）
  eiamAxios.defaults.adapter = undefined;
});

beforeEach(() => {
  localStorage.clear();
});

describe("user store（2.7 AC-1 + AC-3 + AC-4）", () => {
  it("fetchProfile 成功：归一 ProfileData，写 permissions/tenants/isAdmin，同步 currentTenantId 到 tenant store", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    const { user, tenant } = await freshStore((config) => {
      captured.push(config);
      return {
        status: 200,
        body: { code: 0, msg: "ok", data: sampleProfileData() },
      };
    });

    const ok = await user.fetchProfile();
    expect(ok).toBe(true);
    expect(captured[0]?.url).toBe("/api/iam/user/profile");
    expect(user.profile).not.toBeNull();
    expect(user.profile?.id).toBe(1);
    expect(user.profile?.username).toBe("admin");
    expect(user.profile?.displayName).toBe("管理员"); // nickname → displayName
    expect(user.profile?.email).toBe("admin@example.com");
    expect(user.profile?.title).toBe("平台管理员"); // job_title → title
    expect(user.permissions).toEqual([IAM_USER.VIEW, IAM_USER.ADD]);
    expect(user.tenants).toHaveLength(2);
    expect(user.tenants[0]).toEqual({
      id: 1,
      name: "系统租户",
      code: "system",
      domain: "sys.example.com",
      // 新增：租户状态经 normalizeTenantStatus 归一（1→active / 2→disable / 缺省→unknown）
      status: "unknown",
    });
    expect(user.isAdmin).toBe(true);
    // currentTenantId 经 tenant store 委托（唯一归属）
    expect(user.currentTenantId).toBe(4);
    expect(tenant.currentTenantId).toBe(4); // 同步到 tenant store 真值 ref
    expect(user.loading).toBe(false);
    expect(user.error).toBeNull();
  });

  it("nickname 缺失时 displayName 回退 username（避免界面空白）", async () => {
    const { user } = await freshStore(() => ({
      status: 200,
      body: {
        code: 0,
        msg: "ok",
        data: sampleProfileData({ user: { id: 2, username: "bob" } }),
      },
    }));
    const ok = await user.fetchProfile();
    expect(ok).toBe(true);
    expect(user.profile?.displayName).toBe("bob");
  });

  it("F-1：mustSelectTenant 由 tenants.length>1 自算，不读 profile 恒 false 字段", async () => {
    // 单租户 + profile 字段伪造 true → store 仍应 false（证明不依赖该字段）
    const { user: u1 } = await freshStore(() => ({
      status: 200,
      body: {
        code: 0,
        msg: "ok",
        data: sampleProfileData({
          tenants: [{ id: 4, name: "个人", code: "p", domain: "p.x" }],
          must_select_tenant: true, // 伪造：store 须忽略
        }),
      },
    }));
    await u1.fetchProfile();
    expect(u1.tenants).toHaveLength(1);
    expect(u1.mustSelectTenant).toBe(false); // 自算 false，忽略 profile 伪造的 true

    // 多租户 + profile 字段 false → store 须 true
    const { user: u2 } = await freshStore(() => ({
      status: 200,
      body: {
        code: 0,
        msg: "ok",
        data: sampleProfileData({ must_select_tenant: false }),
      },
    }));
    await u2.fetchProfile();
    expect(u2.tenants).toHaveLength(2);
    expect(u2.mustSelectTenant).toBe(true); // 自算 true
  });

  it("fetchProfile 2xx 业务错误（未知 code）：归位 error 回退 envelope msg 原文，复位派生字段", async () => {
    const { user, tenant } = await freshStore(() => ({
      status: 200,
      body: { code: 4010505, msg: "后端原始文案", data: null },
    }));

    const ok = await user.fetchProfile();
    expect(ok).toBe(false);
    expect(user.profile).toBeNull();
    expect(user.permissions).toEqual([]);
    expect(user.tenants).toEqual([]);
    expect(user.isAdmin).toBe(false);
    // 未知 numeric code → contractText(String(4010505)) = null → 回退 ApiError.message（envelope msg）
    expect(user.error).toBe("后端原始文案");
    expect(user.loading).toBe(false);
    // 租户上下文不在失败时被本 store 触碰（唯一归属 tenant.ts；router 守卫决定后续）
    void tenant;
  });

  it("fetchProfile 非 2xx 可解析信封：归位 error 取 envelope msg", async () => {
    const { user } = await freshStore(() => ({
      status: 500,
      body: { code: 0, msg: "服务端 500 文案", data: null },
    }));
    const ok = await user.fetchProfile();
    expect(ok).toBe(false);
    expect(user.error).toBe("服务端 500 文案");
  });

  it("fetchProfile 网络故障：error 取 axios 诊断", async () => {
    const { user } = await freshStore(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "Network Error" },
    }));
    const ok = await user.fetchProfile();
    expect(ok).toBe(false);
    expect(user.error).toBe("Network Error");
  });

  it("fetchProfile 载荷无法解析（缺 user）：归位 error，返回 false", async () => {
    const { user } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: { permissions: ["x"] } }, // 缺 user
    }));
    const ok = await user.fetchProfile();
    expect(ok).toBe(false);
    expect(user.error).toBe("获取用户信息失败");
    expect(user.profile).toBeNull();
  });

  it("fetch 前 AbortController 中断在途：第二次 abort 第一次，第一次返回 false，第二次结果落地", async () => {
    // 两次 fetchProfile 立即并发触发：第一次的 AbortController 被第二次 abort；
    // axios throwIfCancellationRequested 在 adapter 前据 signal.aborted 拒绝第一次。
    const { user } = await freshStore(() => ({
      status: 200,
      body: {
        code: 0,
        msg: "ok",
        data: sampleProfileData({ current_tenant_id: 9 }),
      },
    }));

    const first = user.fetchProfile();
    const second = user.fetchProfile();
    const [firstOk, secondOk] = await Promise.all([first, second]);
    expect(firstOk).toBe(false); // 被中断
    expect(secondOk).toBe(true); // 第二次成功
    expect(user.currentTenantId).toBe(9); // 第二次结果落地（同步到 tenant store）
    expect(user.profile?.id).toBe(1); // 第二次的 profile 落地，非第一次残留
  });

  it("hasPermission 按权限码判定", async () => {
    const { user } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: sampleProfileData() },
    }));
    await user.fetchProfile();
    expect(user.hasPermission(IAM_USER.VIEW)).toBe(true);
    expect(user.hasPermission(IAM_USER.DELETE)).toBe(false);
  });

  it("currentTenantId 经 tenant store 委托：setCurrentTenantId 改 tenant → user 读到新值", async () => {
    const { user, tenant } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: sampleProfileData() },
    }));
    await user.fetchProfile();
    expect(user.currentTenantId).toBe(4);
    tenant.setCurrentTenantId(1);
    expect(user.currentTenantId).toBe(1); // 委托生效
  });

  it("不声明 persist：fetchProfile 后 localStorage 无 user/会话键", async () => {
    const { user } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: sampleProfileData() },
    }));
    await user.fetchProfile();
    const keys = Object.keys(localStorage);
    // 仅 theme store 持久化（hc_theme），user/tenant 不落盘
    expect(keys.some((k) => k.includes("user"))).toBe(false);
  });

  it("resetState 复位本 store 派生字段 + tenant store 上下文（登出链路）", async () => {
    const { user, tenant } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: sampleProfileData() },
    }));
    await user.fetchProfile();
    expect(user.profile).not.toBeNull();
    expect(tenant.currentTenantId).toBe(4);
    user.resetState();
    expect(user.profile).toBeNull();
    expect(user.permissions).toEqual([]);
    expect(user.tenants).toEqual([]);
    expect(user.isAdmin).toBe(false);
    expect(user.error).toBeNull();
    expect(tenant.currentTenantId).toBe(0); // tenant store 一并复位
  });
});
