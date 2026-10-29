// @vitest-environment happy-dom
/**
 * tenant store（2.7）契约测试。
 *
 * 覆盖 AC：
 * - currentTenantId + 切换动作（调 tenant/switch 后整页 location.replace）
 * - 租户上下文唯一归属于此 store（setCurrentTenantId 写真值 ref）
 * - fetch 前 AbortController 中断在途请求（axios throwIfCancellationRequested 在 adapter
 *   前据 signal.aborted 拒绝，store catch 据 abort.signal.aborted 归位 false）
 * - 不声明 persist（会话态不落 localStorage）
 */
import { URL as NodeURL } from "node:url";
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "vue";
import { useTenantStore } from "./tenant";
import { eiamAxios } from "@/api/request/eiam";

// ---- window.location 替身（happy-dom 原生 href 赋值会触发真实导航；同 eiam.test.ts 手法） ----
function stubLocation(initialHref: string): { replaced: string[] } {
  let current = new NodeURL(initialHref);
  const replaced: string[] = [];
  const fake = {
    get href(): string {
      return current.href;
    },
    set href(value: string) {
      current = new NodeURL(value, current);
    },
    get origin(): string {
      return current.origin;
    },
    replace(value: string) {
      replaced.push(value);
      current = new NodeURL(value, current);
    },
    toString(): string {
      return current.href;
    },
  };
  Object.defineProperty(window, "location", {
    value: fake,
    configurable: true,
    writable: true,
  });
  return { replaced };
}

const realLocation = window.location;

function restoreLocation(original: Location): void {
  Object.defineProperty(window, "location", {
    value: original,
    configurable: true,
    writable: true,
  });
}

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

/**
 * fresh pinia + eiamAxios adapter 替身。replyFor 返回同步 MockReply（abort 由 axios
 * throwIfCancellationRequested 在 adapter 前处理，无需 adapter 主动 reject）。
 */
async function freshStore(
  replyFor: (config: InternalAxiosRequestConfig) => MockReply,
) {
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
  return { store: useTenantStore() };
}

afterEach(() => {
  restoreLocation(realLocation);
  eiamAxios.defaults.adapter = undefined;
});

beforeEach(() => {
  localStorage.clear();
});

describe("tenant store（2.7 AC-2 + AC-3 + AC-4）", () => {
  it("currentTenantId 初值 0；setCurrentTenantId 写真值 ref（唯一归属）", async () => {
    const { store } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "", data: null },
    }));
    expect(store.currentTenantId).toBe(0);
    store.setCurrentTenantId(7);
    expect(store.currentTenantId).toBe(7);
  });

  it("switchTenant 成功：POST /api/iam/tenant/switch 携带 X-Active-Tenant-ID，随后 location.replace 整页 reload", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    const { replaced } = stubLocation(
      "http://localhost:8888/console/workbench",
    );
    const { store } = await freshStore((config) => {
      captured.push(config);
      return { status: 200, body: { code: 0, msg: "ok", data: null } };
    });

    const ok = await store.switchTenant(4);
    expect(ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.headers?.["X-Active-Tenant-ID"]).toBe("4");
    expect(captured[0]?.url).toBe("/api/iam/tenant/switch");
      // 必须发送请求体 {tenant_id}：后端 SwitchTenantReq 读取的是 body 的 tenant_id，
      // 只发送 X-Active-Tenant-ID 头会让 gin 绑定失败 → HTTP 400，
      // 从而导致该切换入口完全不可用（页面还不会报错）。
      expect(JSON.parse(String(captured[0]?.data))).toEqual({ tenant_id: 4 });
    expect(replaced).toEqual(["http://localhost:8888/console/workbench"]);
  });

  it("switchTenant 2xx 业务错误（code!=0）：归位 error 回退 envelope msg 原文，不 reload", async () => {
    const { replaced } = stubLocation(
      "http://localhost:8888/console/workbench",
    );
    const { store } = await freshStore(() => ({
      status: 200,
      body: { code: 4010505, msg: "原始后端文案", data: null },
    }));

    const ok = await store.switchTenant(4);
    expect(ok).toBe(false);
    expect(store.switching).toBe(false);
    // 未知 code（4010505 不在契约表）→ contractText 返回 null → 回退 ApiError.message（envelope msg）
    expect(store.error).toBe("原始后端文案");
    expect(replaced).toHaveLength(0);
  });

  it("switchTenant 网络故障 → error 取 axios 诊断，不 reload", async () => {
    const { replaced } = stubLocation(
      "http://localhost:8888/console/workbench",
    );
    const { store } = await freshStore(() => ({
      networkFailure: { code: "ERR_NETWORK", message: "Network Error" },
    }));

    const ok = await store.switchTenant(4);
    expect(ok).toBe(false);
    expect(store.switching).toBe(false);
    expect(store.error).toBe("Network Error");
    expect(replaced).toHaveLength(0);
  });

  it("switchTenant fetch 前中断在途：第二次 abort 第一次，第一次返回 false 不 reload，第二次成功 reload", async () => {
    const captured: InternalAxiosRequestConfig[] = [];
    const { replaced } = stubLocation(
      "http://localhost:8888/console/workbench",
    );
    const { store } = await freshStore((config) => {
      captured.push(config);
      return { status: 200, body: { code: 0, msg: "ok", data: null } };
    });

    // 两次 switchTenant 立即并发触发：第一次的 AbortController 被第二次 abort；
    // axios throwIfCancellationRequested 在 adapter 前据 signal.aborted 拒绝第一次。
    const first = store.switchTenant(4);
    const second = store.switchTenant(5);
    const [firstOk, secondOk] = await Promise.all([first, second]);

    expect(firstOk).toBe(false); // 被中断
    expect(secondOk).toBe(true); // 成功 → location.replace
    // 两次请求都经 adapter（第一次虽被 abort，axios 仍可能在 adapter 前或中拒绝；
    // 关键断言：只 reload 一次 = 第二次成功）
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toBe("http://localhost:8888/console/workbench");
    expect(
      captured.some((c) => c.headers?.["X-Active-Tenant-ID"] === "5"),
    ).toBe(true);
  });

  it("不声明 persist：setCurrentTenantId 不落 localStorage", async () => {
    const { store } = await freshStore(() => ({
      status: 200,
      body: { code: 0, msg: "", data: null },
    }));
    store.setCurrentTenantId(9);
    const keys = Object.keys(localStorage);
    expect(keys.some((k) => k.includes("tenant"))).toBe(false);
  });

  it("resetState 复位 currentTenantId / switching / error", async () => {
    const { store } = await freshStore(() => ({
      status: 200,
      body: { code: 1, msg: "err", data: null },
    }));
    await store.switchTenant(4); // 失败
    store.setCurrentTenantId(5);
    expect(store.currentTenantId).toBe(5);
    store.resetState();
    expect(store.currentTenantId).toBe(0);
    expect(store.switching).toBe(false);
    expect(store.error).toBeNull();
  });
});
