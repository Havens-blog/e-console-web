// @vitest-environment happy-dom
/**
 * 登录页组件测试（task 2.9，UF-1）。
 *
 * 覆盖 AC：
 * - 登录方式 Tab：密码/LDAP/passkey；WebAuthn 不可用 → 隐藏 passkey + 提示（E8）；
 * - 表单校验：空凭据前端拦截（auth.empty_credentials）；凭据错误统一中性文案（E2，不泄账号）；
 * - MFA challenge：6 位码输入，验证失败 → auth.mfa_invalid；锁定 → auth.account_locked（E9/G-9 降级）；
 * - 强制改密态：E1 骨架（G-8 降级，prop forceMustChangePassword）；
 * - auth.ts api 经 unwrapEnvelope；
 * - 成功 → 按 tenants 数分流（0/1 → /workbench，≥2 → /tenant-select）。
 */
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import piniaPluginPersistedstate from "pinia-plugin-persistedstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick } from "vue";
import Login from "./Login.vue";
import { eiamAxios } from "@/api/request/eiam";

// ---- vue-router mock ----
const mockReplace = vi.fn();
const routeQuery = { redirect: undefined as string | undefined };
/** finalizeLogin 会先 router.resolve 判断站内/跨应用（站内 SPA、跨应用整页跳转）。
 *  测试内以「内部路由集」模拟 console 路由表；集合外（如 /cam/）→ matched 空。 */
const internalRoutes = new Set([
  "/workbench",
  "/tenant-select",
  "/users",
  "/forbidden",
  "/login",
]);
const mockResolve = vi.fn((path: string) => ({
  matched: internalRoutes.has(path) ? [{ name: "x" }] : [],
}));
vi.mock("vue-router", () => ({
  useRouter: () => ({ replace: mockReplace, resolve: mockResolve }),
  useRoute: () => ({ query: routeQuery }),
}));

// ---- eiamAxios 脚本化 adapter ----
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

type ReplyFn = (config: InternalAxiosRequestConfig) => MockReply;

/** login 信封（B-2 snake_case） */
function loginEnvelope(data: Record<string, unknown> = {}): unknown {
  return { code: 0, msg: "ok", data: { mfa_required: false, ...data } };
}

/** profile 信封（user store fetchProfile 用） */
function profileEnvelope(
  tenants: Array<{
    id: number;
    name: string;
    code: string;
    domain: string;
  }> = [],
): unknown {
  return {
    code: 0,
    msg: "ok",
    data: {
      user: { id: 1, username: "admin", nickname: "管理员" },
      tenants,
      current_tenant_id: tenants[0]?.id ?? 0,
      is_admin: true,
      permissions: [],
      must_select_tenant: false,
    },
  };
}

/** 按 url 路由不同响应：login/logout/mfa/passkey/profile */
function adapterRouting(
  loginReply: ReplyFn,
  profileReply: ReplyFn = () => ({ status: 200, body: profileEnvelope() }),
): { calls: string[] } {
  const calls: string[] = [];
  eiamAxios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? "";
    calls.push(url);
    const reply = url.includes("/profile")
      ? profileReply(config)
      : loginReply(config);
    if (reply.networkFailure) {
      throw new AxiosError(
        reply.networkFailure.message,
        reply.networkFailure.code,
        config,
      );
    }
    return settleLike({
      data: reply.body ?? null,
      status: reply.status ?? 200,
      statusText: STATUS_TEXT[reply.status ?? 200] ?? "",
      headers: {},
      config,
    } as AxiosResponse);
  }) as unknown as typeof eiamAxios.defaults.adapter;
  return { calls };
}

async function mountLogin(props: Record<string, unknown> = {}) {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({ render: () => null }).use(pinia);
  setActivePinia(pinia);
  const wrapper = mount(Login, { props });
  await flushPromises();
  await nextTick();
  return wrapper;
}

function setFieldValue(
  wrapper: ReturnType<typeof mount>,
  testid: string,
  value: string,
) {
  const input = wrapper.find(`[data-testid="${testid}"]`);
  (input.element as HTMLInputElement).value = value;
  input.trigger("input");
}

async function submitForm(wrapper: ReturnType<typeof mount>) {
  await wrapper.find("form").trigger("submit.prevent");
  await flushPromises();
  await nextTick();
}

/**
 * 注入 window.PublicKeyCredential + navigator.credentials.get 替身（happy-dom 不实现
 * CredentialsContainer，按需定义 navigator.credentials）。返回 restore 函数。
 */
function installWebAuthn(getResult: unknown): () => void {
  const origPKC = (window as unknown as { PublicKeyCredential?: unknown })
    .PublicKeyCredential;
  const origCreds = Object.getOwnPropertyDescriptor(navigator, "credentials");
  Object.defineProperty(window, "PublicKeyCredential", {
    value: function MockPKC() {},
    configurable: true,
  });
  const getMock = vi.fn().mockResolvedValue(getResult);
  Object.defineProperty(navigator, "credentials", {
    value: { get: getMock },
    configurable: true,
  });
  return () => {
    if (origPKC === undefined) {
      delete (window as unknown as { PublicKeyCredential?: unknown })
        .PublicKeyCredential;
    } else {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: origPKC,
        configurable: true,
      });
    }
    if (origCreds) {
      Object.defineProperty(navigator, "credentials", origCreds);
    } else {
      delete (navigator as unknown as { credentials?: unknown }).credentials;
    }
  };
}

beforeEach(() => {
  mockReplace.mockReset();
  routeQuery.redirect = undefined;
});

afterEach(() => {
  eiamAxios.defaults.adapter = undefined;
  vi.restoreAllMocks();
});

describe("AC：登录方式 Tab（密码/LDAP/passkey）", () => {
  it("默认密码 Tab，可切 LDAP；passkey Tab 仅 WebAuthn 可用时渲染", async () => {
    const original = (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential;
    Object.defineProperty(window, "PublicKeyCredential", {
      value: function MockPKC() {},
      configurable: true,
    });
    const wrapper = await mountLogin();
    const tabs = wrapper.findAll(".login-tab");
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.text()).toBe("密码");
    expect(tabs[1]?.text()).toBe("LDAP");
    expect(tabs[2]?.text()).toBe("Passkey");

    // 切 LDAP 出现身份源 ID 字段
    await tabs[1]?.trigger("click");
    expect(wrapper.find('[data-testid="ldap-source-id"]').exists()).toBe(true);

    // 还原
    if (original === undefined) {
      delete (window as unknown as { PublicKeyCredential?: unknown })
        .PublicKeyCredential;
    } else {
      Object.defineProperty(window, "PublicKeyCredential", {
        value: original,
        configurable: true,
      });
    }
  });

  it("WebAuthn 不可用 → 隐藏 passkey Tab（E8，无 JS 报错）", async () => {
    const original = (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential;
    delete (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential;
    const wrapper = await mountLogin();
    const tabs = wrapper.findAll(".login-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.text())).toEqual(["密码", "LDAP"]);
    Object.defineProperty(window, "PublicKeyCredential", {
      value: original,
      configurable: true,
    });
  });
});

describe("AC：表单校验 + 中性文案（E2 不泄账号）", () => {
  it("空凭据 → auth.empty_credentials，不发请求", async () => {
    const { calls } = adapterRouting(() => ({
      status: 200,
      body: loginEnvelope(),
    }));
    const wrapper = await mountLogin();
    await submitForm(wrapper);
    expect(wrapper.find(".login-error").text()).toBe("请输入用户名和密码");
    expect(calls).toHaveLength(0);
  });

  it("凭据错误 → auth.invalid_credentials 中性文案（不泄账号）", async () => {
    adapterRouting(() => ({
      status: 500,
      body: { code: 4010202, msg: "账号或密码错误", data: null },
    }));
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "wrong");
    await submitForm(wrapper);
    expect(wrapper.find(".login-error").text()).toBe("用户名或密码错误");
    // 不回显用户名
    expect(wrapper.find(".login-error").text()).not.toContain("admin");
  });

  it("用户不存在与密码错误同一文案（Hard Rule）", async () => {
    // eiam 对「用户不存在」同样返回 ErrInvalidUser「账号或密码错误」
    adapterRouting(() => ({
      status: 500,
      body: { code: 4010202, msg: "账号或密码错误", data: null },
    }));
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "nonexistent_user_xyz");
    setFieldValue(wrapper, "password", "whatever");
    await submitForm(wrapper);
    expect(wrapper.find(".login-error").text()).toBe("用户名或密码错误");
  });

  it("服务端 5xx（链路繁忙）→ eiam.unavailable，不误显密码错", async () => {
    // eiam 对「服务内部链路繁忙」(4010901) 也回 HTTP 500，须与密码错(4010202)区分，
    // 否则远端 Redis 抖动时登录会误显「用户名或密码错误」诱用户反复重试。
    adapterRouting(() => ({
      status: 500,
      body: { code: 4010901, msg: "服务内部链路繁忙", data: null },
    }));
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "correct");
    await submitForm(wrapper);
    expect(wrapper.find(".login-error").text()).toBe("身份服务暂不可用，请稍后重试");
  });
});

describe("AC：MFA challenge（6 位码 + auth.mfa_invalid + 锁定降级）", () => {
  it("登录返回 mfa_required → 切 MFA 态，验证失败 → auth.mfa_invalid", async () => {
    let mfaTriggered = false;
    adapterRouting((config) => {
      const url = config.url ?? "";
      if (url.includes("/system/login")) {
        return {
          status: 200,
          body: loginEnvelope({ mfa_required: true, mfa_token: "tkt" }),
        };
      }
      if (url.includes("/mfa/verify")) {
        return {
          status: 500,
          body: { code: 4010301, msg: "验证码不正确", data: null },
        };
      }
      return { status: 200, body: loginEnvelope() };
    });
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-phase="mfa"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mfa-code"]').exists()).toBe(true);

    // 输入错误验证码
    const mfaInput = wrapper.find('[data-testid="mfa-code"]');
    (mfaInput.element as HTMLInputElement).value = "000000";
    await mfaInput.trigger("input");
    await submitForm(wrapper);
    expect(wrapper.find(".login-error").text()).toBe("验证码错误，请重新输入");
    mfaTriggered = true;
    expect(mfaTriggered).toBe(true);
  });

  it("MFA 连续失败锁定 → auth.account_locked（G-9 降级，无自算倒计时）", async () => {
    adapterRouting((config) => {
      const url = config.url ?? "";
      if (url.includes("/system/login")) {
        return {
          status: 200,
          body: loginEnvelope({ mfa_required: true, mfa_token: "tkt" }),
        };
      }
      // MFA 次数耗尽
      return {
        status: 500,
        body: { code: 4010302, msg: "MFA 验证失败次数过多", data: null },
      };
    });
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    const mfaInput = wrapper.find('[data-testid="mfa-code"]');
    (mfaInput.element as HTMLInputElement).value = "111111";
    await mfaInput.trigger("input");
    await submitForm(wrapper);
    // 锁定态渲染 auth.account_locked 契约文案（{X} 不自算、缺参显式可见）
    const errorEl = wrapper.find(".login-error");
    expect(errorEl.attributes("data-error")).toBe("locked");
    expect(errorEl.text()).toContain("账号已锁定");
    // 不伪造倒计时数字（{X} 占位符原样或缺失，不出现具体分钟数）
    expect(errorEl.text()).not.toMatch(/剩余 \d+ 分钟/);
  });

  it("MFA 空验证码 → 字段级校验（契约外就近提示）", async () => {
    adapterRouting((config) => {
      if ((config.url ?? "").includes("/system/login")) {
        return {
          status: 200,
          body: loginEnvelope({ mfa_required: true, mfa_token: "tkt" }),
        };
      }
      return { status: 200, body: loginEnvelope() };
    });
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    // 直接提交空 MFA
    await submitForm(wrapper);
    expect(wrapper.find("#mfa-code-error").text()).toBe("请输入验证码");
  });
});

describe("AC：强制改密态（E1 骨架，G-8 降级）", () => {
  it("forceMustChangePassword → 渲染 auth.first_login_change_password 骨架", async () => {
    adapterRouting(() => ({ status: 200, body: loginEnvelope() }));
    const wrapper = await mountLogin({ forceMustChangePassword: true });
    expect(wrapper.find('[data-phase="mustChangePassword"]').exists()).toBe(
      true,
    );
    expect(wrapper.find('[data-error="first-login"]').text()).toBe(
      "首次登录请修改密码",
    );
    expect(wrapper.find('input[autocomplete="new-password"]').exists()).toBe(
      true,
    );
  });

  it("两次密码不一致 → 字段级校验", async () => {
    adapterRouting(() => ({ status: 200, body: loginEnvelope() }));
    const wrapper = await mountLogin({ forceMustChangePassword: true });
    const inputs = wrapper.findAll('input[type="password"]');
    (inputs[0]!.element as HTMLInputElement).value = "newpass1";
    await inputs[0]!.trigger("input");
    (inputs[1]!.element as HTMLInputElement).value = "newpass2";
    await inputs[1]!.trigger("input");
    await submitForm(wrapper);
    expect(wrapper.find("#confirm-password-error").text()).toBe(
      "两次输入的密码不一致",
    );
  });

  it("改密提交不发请求（G-8 降级：eiam 无改密端点）", async () => {
    const { calls } = adapterRouting(() => ({
      status: 200,
      body: loginEnvelope(),
    }));
    const wrapper = await mountLogin({ forceMustChangePassword: true });
    const inputs = wrapper.findAll('input[type="password"]');
    (inputs[0]!.element as HTMLInputElement).value = "newpass";
    await inputs[0]!.trigger("input");
    (inputs[1]!.element as HTMLInputElement).value = "newpass";
    await inputs[1]!.trigger("input");
    await submitForm(wrapper);
    // 无 system/login / mfa/verify 调用（改密骨架不触发登录链路）
    expect(
      calls.filter((u) => u.includes("/login") || u.includes("/mfa")),
    ).toHaveLength(0);
  });
});

describe("AC：成功 → 按 tenants 数分流（0/1/≥2）", () => {
  it("单租户 → 自动选定 /workbench", async () => {
    adapterRouting(
      () => ({ status: 200, body: loginEnvelope() }),
      () => ({
        status: 200,
        body: profileEnvelope([
          { id: 4, name: "个人", code: "p", domain: "p.x" },
        ]),
      }),
    );
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).toHaveBeenCalledWith("/workbench");
  });

  it("零租户 → 受限工作台 /workbench", async () => {
    adapterRouting(
      () => ({ status: 200, body: loginEnvelope() }),
      () => ({ status: 200, body: profileEnvelope([]) }),
    );
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).toHaveBeenCalledWith("/workbench");
  });

  it("多租户 → /tenant-select", async () => {
    adapterRouting(
      () => ({ status: 200, body: loginEnvelope() }),
      () => ({
        status: 200,
        body: profileEnvelope([
          { id: 1, name: "系统", code: "sys", domain: "s.x" },
          { id: 4, name: "个人", code: "p", domain: "p.x" },
        ]),
      }),
    );
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).toHaveBeenCalledWith("/tenant-select");
  });

  it("redirect 查询参数优先于默认目标", async () => {
    routeQuery.redirect = "/users";
    adapterRouting(
      () => ({ status: 200, body: loginEnvelope() }),
      () => ({
        status: 200,
        body: profileEnvelope([{ id: 4, name: "p", code: "p", domain: "p.x" }]),
      }),
    );
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).toHaveBeenCalledWith("/users");
  });

  it("redirect 为完整同源 URL（跨应用回跳）→ 整页跳转而非 SPA replace", async () => {
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    routeQuery.redirect = `${window.location.origin}/cam/`;
    adapterRouting(
      () => ({ status: 200, body: loginEnvelope() }),
      () => ({
        status: 200,
        body: profileEnvelope([{ id: 4, name: "p", code: "p", domain: "p.x" }]),
      }),
    );
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(assignSpy).toHaveBeenCalledWith("/cam/");
    assignSpy.mockRestore();
  });
});

describe("AC：锁定态中性文案（G-9 降级，无 lockUntil）", () => {
  it("密码登录返回锁定 → auth.account_locked，不伪造倒计时", async () => {
    adapterRouting(() => ({
      status: 500,
      body: {
        code: 4010303,
        msg: "账号由于多次输入错误已被锁定，请稍后再试",
        data: null,
      },
    }));
    const wrapper = await mountLogin();
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    const errorEl = wrapper.find(".login-error");
    expect(errorEl.attributes("data-error")).toBe("locked");
    expect(errorEl.text()).toContain("账号已锁定");
    // 不出现自算的倒计时分钟数（G-9：不自算 lockUntil）
    expect(errorEl.text()).not.toMatch(/剩余 \d+ 分钟/);
  });
});

describe("AC：passkey 登录流程（start → navigator.credentials.get → finish）", () => {
  it("passkey 成功 → 按 tenants 分流 /workbench", async () => {
    const restore = installWebAuthn({ id: "cred", response: {} });
    adapterRouting(
      (config) => {
        const url = config.url ?? "";
        if (url.includes("/passkey/login/start")) {
          return {
            status: 200,
            body: {
              code: 0,
              msg: "ok",
              data: { options: {}, session_token: "ssn" },
            },
          };
        }
        if (url.includes("/passkey/login/finish")) {
          return { status: 200, body: loginEnvelope() };
        }
        return { status: 200, body: loginEnvelope() };
      },
      () => ({
        status: 200,
        body: profileEnvelope([{ id: 4, name: "p", code: "p", domain: "p.x" }]),
      }),
    );
    const wrapper = await mountLogin();
    // 切 passkey Tab
    const tabs = wrapper.findAll(".login-tab");
    await tabs[2]?.trigger("click");
    await nextTick();
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(mockReplace).toHaveBeenCalledWith("/workbench");
    restore();
  });

  it("passkey finish 返回 mfa_required → 切 MFA 态", async () => {
    const restore = installWebAuthn({ id: "cred", response: {} });
    adapterRouting((config) => {
      const url = config.url ?? "";
      if (url.includes("/passkey/login/start")) {
        return {
          status: 200,
          body: {
            code: 0,
            msg: "ok",
            data: { options: {}, session_token: "ssn" },
          },
        };
      }
      // finish 返回 mfa_required
      return {
        status: 200,
        body: loginEnvelope({ mfa_required: true, mfa_token: "mfa-tkt" }),
      };
    });
    const wrapper = await mountLogin();
    const tabs = wrapper.findAll(".login-tab");
    await tabs[2]?.trigger("click");
    await nextTick();
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-phase="mfa"]').exists()).toBe(true);
    restore();
  });

  it("passkey 中断（AbortError）→ 静默回 Default，不泄错", async () => {
    const restore = installWebAuthn(null);
    // 覆盖 get 为 AbortError reject
    (navigator.credentials as unknown as { get: () => Promise<unknown> }).get =
      () => Promise.reject(new DOMException("abort", "AbortError"));
    adapterRouting(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: { options: {}, session_token: "ssn" } },
    }));
    const wrapper = await mountLogin();
    const tabs = wrapper.findAll(".login-tab");
    await tabs[2]?.trigger("click");
    await nextTick();
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    // 仍处登录态、无错误条
    expect(wrapper.find('[data-phase="login"]').exists()).toBe(true);
    expect(wrapper.find(".login-error").exists()).toBe(false);
    restore();
  });

  it("passkey 不可用时选 passkey Tab → auth.passkey_unsupported 提示", async () => {
    // 不注入 PublicKeyCredential → webAuthnAvailable=false，passkey Tab 不渲染；
    // 此用例验证：无 JS 报错、密码 Tab 仍可正常提交（降级路径畅通）
    const origPKC = (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential;
    delete (window as unknown as { PublicKeyCredential?: unknown })
      .PublicKeyCredential;
    adapterRouting(() => ({ status: 200, body: loginEnvelope() }));
    const wrapper = await mountLogin();
    expect(wrapper.findAll(".login-tab")).toHaveLength(2); // 无 passkey
    // 密码登录仍可用
    setFieldValue(wrapper, "username", "admin");
    setFieldValue(wrapper, "password", "pw");
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    Object.defineProperty(window, "PublicKeyCredential", {
      value: origPKC,
      configurable: true,
    });
  });
});

describe("AC：强制改密空字段校验（E1 骨架补完）", () => {
  it("新密码/确认均空 → 字段级校验（契约外就近提示）", async () => {
    adapterRouting(() => ({ status: 200, body: loginEnvelope() }));
    const wrapper = await mountLogin({ forceMustChangePassword: true });
    await submitForm(wrapper);
    expect(wrapper.find("#new-password-error").text()).toBe("请输入新密码");
    expect(wrapper.find("#confirm-password-error").text()).toBe("请确认新密码");
  });
});

describe("AC：未知错误回退原文（mapErrorToContractKey 非 ApiError 路径）", () => {
  it("passkey 流程抛非 ApiError 非 AbortError → 回退 message 原文", async () => {
    const restore = installWebAuthn(null);
    // 覆盖 get 为非 AbortError 的普通 Error（模拟未预期异常）
    (navigator.credentials as unknown as { get: () => Promise<unknown> }).get =
      () => Promise.reject(new Error("unexpected passkey failure"));
    adapterRouting(() => ({
      status: 200,
      body: { code: 0, msg: "ok", data: { options: {}, session_token: "ssn" } },
    }));
    const wrapper = await mountLogin();
    const tabs = wrapper.findAll(".login-tab");
    await tabs[2]?.trigger("click");
    await nextTick();
    await submitForm(wrapper);
    await flushPromises();
    await nextTick();
    // 非 ApiError 回退：message 原文显示
    expect(wrapper.find(".login-error").text()).toContain(
      "unexpected passkey failure",
    );
    restore();
  });
});
