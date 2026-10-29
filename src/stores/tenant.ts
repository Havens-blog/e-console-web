/**
 * 租户上下文 store —— 全局 3 个 store 之一（tech-design Architecture Store 清单）。
 *
 * 职责边界（Hard Rule）：**租户上下文唯一归属本 store**——currentTenantId 的真值 ref
 * 在此，api 层零租户状态，任何其他 store 不得另存一份 currentTenantId。
 * user store 的 currentTenantId 是经本 store 的只读委托（computed），不持有独立 ref。
 *
 * 切换动作（tech-design Integration 6 + §Architecture）：调 `POST /api/iam/tenant/switch`
 * （header `X-Active-Tenant-ID: <id>`）成功后**整页 location.replace()**——杜绝 SPA 内只换 store
 * 不刷页（eiam 销毁旧 session 重签 JWT + Set-Cookie 下发新 cookie，reload 后路由守卫重拉
 * profile 获得新租户上下文）。
 *
 * 持久化口径（Hard Rule）：会话态不落 localStorage——本 store **不声明 persist**。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { eiamAxios, unwrapEnvelope } from "@/api/request/eiam";
import { ApiError } from "@/api/types";
import { contractText } from "@/utils/copyContract";

/** tenant/switch 请求头键（eiam 常量 ActiveTenantHeaderKey，parity §6.1.6 实核） */
const ACTIVE_TENANT_HEADER = "X-Active-Tenant-ID";

/**
 * 把任意抛出值归一为 ApiError 并取文案（contractText(code)/message 回退口径，task 2.4）。
 * 与 user store 同款逻辑；未知 code 回退 ApiError.message 原文，零二次映射。
 */
function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code !== null) {
      const text = contractText(String(error.code));
      if (text) return text;
    }
    return error.message;
  }
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : "租户切换失败";
}

export const useTenantStore = defineStore("tenant", () => {
  /** 当前租户 id；0 = 无租户上下文（登录前 / profile 未拉取 / 零租户用户） */
  const currentTenantId = ref<number>(0);
  /** 切换中标记（防 UI 重复触发） */
  const switching = ref<boolean>(false);
  /** 切换失败文案（contractText 回退）；null = 无错误 */
  const error = ref<string | null>(null);

  /** 在途 switch 的 AbortController（fetch 前中断在途请求，tech-design AC-3） */
  let switchAbort: AbortController | null = null;

  /**
   * 由 user store 在 profile 拉取成功后调用，把 profile 的 current_tenant_id 同步到
   * 本 store（租户上下文唯一归属）。外部除 user store 外不应直接调用——切换走 switchTenant。
   */
  function setCurrentTenantId(id: number): void {
    currentTenantId.value = id;
  }

  /**
   * 切换租户：调 eiam tenant/switch（header X-Active-Tenant-ID）成功后整页 reload。
   * - fetch 前中断在途 switch（AbortController）；
   * - 成功 → location.replace()（tech-design Integration 6「整页 reload」约定，与
   *   e-cam-web TenantSelector.vue 同款）；
   * - 失败 → 归位 error（contractText 回退），不 reload，switching 复位。
   */
  async function switchTenant(id: number): Promise<boolean> {
    // 中断在途 switch（避免快速双击发出两次销毁重签）
    if (switchAbort) {
      switchAbort.abort();
    }
    const abort = new AbortController();
    switchAbort = abort;

    switching.value = true;
    error.value = null;
    try {
      await unwrapEnvelope<void>(
        eiamAxios.post(
          "/api/iam/tenant/switch",
          // 必须发送请求体：后端 SwitchTenantReq 读取的是 body 的 tenant_id
          // （ginx.BS[SwitchTenantReq]，tenant/handler.go）。
          // 此前只发 X-Active-Tenant-ID 头、请求体传 null → 后端拿不到 tenant_id
          // → gin 绑定失败返回 HTTP 400，导致**该切换入口从未生效**（且页面不报错）。
          { tenant_id: id },
          {
            headers: { [ACTIVE_TENANT_HEADER]: String(id) },
            signal: abort.signal,
          },
        ),
      );
      // eiam 已销毁旧 session 重签 JWT + Set-Cookie 下发新 cookie（parity §6.1.6）。
      // 整页 reload：reload 后路由守卫重拉 profile 获得新租户上下文，杜绝 SPA 内只换 store。
      // location.replace 不留历史条目（与 e-cam-web TenantSelector.vue:47 同款语义）。
      window.location.replace(window.location.href);
      return true;
    } catch (err) {
      // 被 abort 的在途请求不算错误（新一轮 switch 已接管）
      if (abort.signal.aborted) return false;
      error.value = errorMessage(err);
      switching.value = false;
      if (switchAbort === abort) switchAbort = null;
      return false;
    }
  }

  /** 复位（登出 / 401 收敛后由调用方触发；归零租户上下文） */
  function resetState(): void {
    if (switchAbort) {
      switchAbort.abort();
      switchAbort = null;
    }
    currentTenantId.value = 0;
    switching.value = false;
    error.value = null;
  }

  return {
    currentTenantId,
    switching,
    error,
    setCurrentTenantId,
    switchTenant,
    resetState,
  };
});
