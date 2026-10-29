<script setup lang="ts">
/**
 * 身份源详情抽屉（feat-identity-source-detail）。
 *
 * 为什么需要：列表只展示 名称 / 类型 / 启用 三列，运维排查登录问题需要的
 * URL、Bind DN、Base DN、属性映射只能通过**编辑表单**看到 —— 而"只为看一眼"就打开
 * 编辑表单，存在误改并提交的风险。本抽屉提供纯只读视图。
 *
 * 来源：`getIdentitySourceDetail` 早已实现（`GET /identity_source/detail/:id` 后端实存），
 * 但**没有任何视图调用**（全仓零调用 api 函数之一）；权限码 `iam:identity_source:detail`
 * 也一直零引用 —— 本组件把两者都用起来。
 *
 * 安全：后端 `toVo` 已把 `BindPassword` 置空（不回显密码），本抽屉只读且**不提供任何写入口**；
 * 密码字段显示为固定占位，避免用户误以为"密码为空"是异常。
 *
 * 降级：`mapEiamIdentitySource` 只接受 `type === "ldap"`（v1 规范形），
 * 非 LDAP 身份源会归一为 null —— 此时给出明确提示，而不是渲染空白抽屉。
 */
import { computed, ref, watch } from "vue";
import { getIdentitySourceDetail } from "@/api/identity-sources";
import { ApiError } from "@/api/types";
import type { IdentitySource } from "@/api/types/identity-source";
import { useDialogA11y } from "@/composables/useDialogA11y";

const props = defineProps<{
  /** 目标身份源 id；null = 抽屉关闭 */
  sourceId: number | null;
}>();

const emit = defineEmits<{ close: [] }>();

const isOpen = computed(() => props.sourceId !== null);
const overlayRef = ref<HTMLElement | null>(null);
useDialogA11y(overlayRef, { open: isOpen, onClose: () => emit("close") });

const source = ref<IdentitySource | null>(null);
const loading = ref(false);
const error = ref("");
const unsupported = ref(false);
let requestSeq = 0;

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

async function load(): Promise<void> {
  const id = props.sourceId;
  if (id === null) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  unsupported.value = false;
  try {
    const got = await getIdentitySourceDetail(id);
    if (seq !== requestSeq) return;
    source.value = got;
    // 归一返回 null ≠ 请求失败：可能是非 LDAP 类型（v1 规范形不支持）
    unsupported.value = got === null;
  } catch (err) {
    if (seq !== requestSeq) return;
    source.value = null;
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => props.sourceId,
  (id) => {
    if (id !== null) {
      source.value = null;
      error.value = "";
      unsupported.value = false;
      void load();
    } else {
      requestSeq++;
      loading.value = false;
      source.value = null;
      error.value = "";
      unsupported.value = false;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="sourceId !== null"
    ref="overlayRef"
    class="dialog-overlay dialog-overlay--drawer"
    data-testid="identity-source-detail"
    @click.self="emit('close')"
  >
    <aside
      class="drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="idsd-title"
      :aria-busy="loading"
    >
      <header class="drawer__head">
        <h3 id="idsd-title" class="drawer__title">
          {{ source?.name ?? "身份源详情" }}
        </h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭详情"
          data-testid="idsd-close"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>

      <div class="drawer__body">
        <p v-if="loading" class="muted" data-testid="idsd-loading">正在加载…</p>

        <p v-else-if="error" class="state-error" role="alert" data-testid="idsd-error">
          {{ error }}
          <button type="button" class="btn btn--text" data-testid="idsd-retry" @click="load">
            重试
          </button>
        </p>

        <p v-else-if="unsupported" class="muted" data-testid="idsd-unsupported">
          该身份源的配置暂不支持在此展示（当前仅支持 LDAP 类型）。请使用「编辑」查看完整配置。
        </p>

        <dl v-else-if="source" class="kv" data-testid="idsd-basic">
          <dt>名称</dt>
          <dd data-testid="idsd-name">{{ source.name || "—" }}</dd>
          <dt>类型</dt>
          <dd data-testid="idsd-type">{{ source.type.toUpperCase() }}</dd>
          <dt>状态</dt>
          <dd data-testid="idsd-enabled">{{ source.enabled ? "启用" : "停用" }}</dd>
          <dt>服务器地址</dt>
          <dd data-testid="idsd-url" class="mono">{{ source.conn.url || "—" }}</dd>
          <dt>Bind DN</dt>
          <dd data-testid="idsd-bind-dn" class="mono">{{ source.conn.bindDn || "—" }}</dd>
          <dt>Bind 密码</dt>
          <dd data-testid="idsd-password" class="muted">
            不显示（服务端不回显密码，避免泄露）
          </dd>
          <dt>Base DN</dt>
          <dd data-testid="idsd-base-dn" class="mono">{{ source.conn.baseDn || "—" }}</dd>
          <dt>用户名属性</dt>
          <dd data-testid="idsd-username-attr" class="mono">{{ source.conn.attrMap.username || "—" }}</dd>
          <dt>邮箱属性</dt>
          <dd data-testid="idsd-email-attr" class="mono">{{ source.conn.attrMap.email || "—" }}</dd>
        </dl>
      </div>

      <footer class="drawer__foot">
        <button type="button" class="btn btn--text" data-testid="idsd-footer-close" @click="emit('close')">
          关闭
        </button>
      </footer>
    </aside>
  </div>
</template>

<style scoped lang="scss">
.dialog-overlay--drawer {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 1050;
}

.drawer {
  width: 100%;
  max-width: 480px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-base);

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  &__title {
    margin: 0;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 16px 20px;
  }

  &__foot {
    padding: 12px 20px;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: flex-end;
  }
}

.kv {
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 10px 12px;
  margin: 0;

  dt {
    color: var(--text-muted);
    font-size: 13px;
  }

  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>
