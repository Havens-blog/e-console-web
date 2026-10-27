<script setup lang="ts">
/**
 * 租户详情抽屉（feat-tenant-detail-ui 契约 §2.2 / §2.3）。
 *
 * 入口：TenantList 行内「详情」按钮（权限 iam:tenant:get）。
 * 结构：遮罩 + 右侧抽屉；沿用 tenants 目录既有 dialog-overlay / btn / drawer 原生元素
 * 样式语言（与 TenantMembersDrawer.vue 同款，不引入 Element Plus 组件）。
 *
 * 数据流（契约 §1）：tenant 非 null（打开）→ getTenantDetail(tenant.id)（复用既有 api，
 * 后端已含用量统计）→ 归一 Tenant → 三块只读信息：
 *   ① 基本信息（名称 / 编码 / 域名 / 状态 / 创建时间）
 *   ② 治理配置（3 配额 / 云厂商白名单 / 功能开关）
 *   ③ 用量（用户 / 用户组：用量 / 上限 + 超限标记）
 * 响应缺 id（null）按「未找到」处理；失败（404 / 无权限 / 网络）展示服务端文案 + 重试。
 *
 * **严格只读**：本组件不含任何提交 / 保存 / 删除入口，也不引用任何写 api。
 *
 * 展示口径（契约 §2.3，与列表列同源）：
 * - 配额 0 / 缺失 → '不限制'（列表列口径为 '不限'，同一判定在 ./usage 的 formatQuota）；
 * - 白名单空 → '全部允许'；开关空 → '无'（k=启用/禁用）；
 * - 用量 undefined → '—'（不渲染 0）；用量 > 配额 > 0 → 危险色 + '超出配额'；
 * - 创建时间缺失 / 0 → '—'，有效值 → 本地时间 'YYYY-MM-DD HH:mm:ss'。
 *
 * 关闭（tenant 变 null）只作废在途响应，不再发起新请求（不留残留请求）。
 */
import { computed, ref, watch } from "vue";
import { getTenantDetail } from "@/api/tenants";
import { ApiError, type Tenant } from "@/api/types";
import StatusBadge from "@/components/StatusBadge.vue";
import { useDialogA11y } from "@/composables/useDialogA11y";
import { formatEpochMs } from "./timestamp";
import {
  OVER_QUOTA_TEXT,
  QUOTA_UNLIMITED_TEXT_DETAIL,
  USAGE_PLACEHOLDER,
  formatQuota,
  formatUsage,
  isUsageOver,
} from "./usage";

const props = defineProps<{
  /** 目标租户（id 用于取数、name 用于标题占位）；null = 抽屉关闭 */
  tenant: { id: number; name: string } | null;
}>();

const emit = defineEmits<{
  /** 关闭抽屉（父级把 tenant 置 null） */
  close: [];
}>();

const isOpen = computed(() => props.tenant !== null);

// ---- 详情 state ----
const detail = ref<Tenant | null>(null);
const loading = ref<boolean>(false);
const error = ref<string>("");

/** 响应缺 id（后端「未找到」/ 脏数据）时的固定文案 —— 断言出口见 detail-error */
const NOT_FOUND_TEXT = "未找到该租户，可能已被删除";

/**
 * 请求序号：关闭抽屉 / 新请求发起后，旧响应一律丢弃 ——
 * 避免「关闭后迟到响应把详情写回已关闭的抽屉」。
 */
let requestSeq = 0;

function errorMessage(err: unknown): string {
  // 服务端拒绝原因（eiam msg）必须原文展示，不套通用文案（契约 §2.3 / PRD T6）
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载租户详情失败";
}

/** 拉取详情（打开时 / 重试时调用）。 */
async function load(): Promise<void> {
  const tenant = props.tenant;
  if (!tenant) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const result = await getTenantDetail(tenant.id);
    // 迟到的旧响应 / 抽屉已关闭 → 丢弃，不写 state
    if (seq !== requestSeq || !props.tenant) return;
    if (result === null) {
      // 未找到：明确告知，不渲染半截信息
      detail.value = null;
      error.value = NOT_FOUND_TEXT;
      return;
    }
    detail.value = result;
  } catch (err) {
    if (seq !== requestSeq || !props.tenant) return;
    detail.value = null;
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

// ---- 抽屉焦点 / Escape ----
const drawerRef = ref<HTMLElement | null>(null);
useDialogA11y(drawerRef, { open: isOpen, onClose: () => close() });

// ---- 打开即拉取 / 关闭清理（tenant 是唯一开关）----
watch(
  () => props.tenant,
  (tenant) => {
    if (tenant) {
      detail.value = null;
      error.value = "";
      void load();
    } else {
      // 关闭：作废在途请求、清空内容；不发起任何新请求
      requestSeq++;
      loading.value = false;
      detail.value = null;
      error.value = "";
    }
  },
  { immediate: true },
);

function close(): void {
  emit("close");
}

// ---- 展示辅助（契约 §2.3）----
/** 标题：详情已加载用服务端名称，未加载时用列表行名称占位 */
const displayName = computed(
  () => detail.value?.name || props.tenant?.name || "租户详情",
);

const codeText = computed(() => detail.value?.code || USAGE_PLACEHOLDER);
const domainText = computed(() => detail.value?.domain || USAGE_PLACEHOLDER);

/** 创建时间：eiam ctime 为 Unix 毫秒（见 ./timestamp.ts 说明）；缺失/异常 → '—' */
const ctimeText = computed(() => formatEpochMs(detail.value?.ctime));

/** 三项配额（0 / 缺失 = 不限制） */
const quotas = computed(() => {
  const t = detail.value;
  return [
    {
      key: "accounts",
      label: "最大云账号数",
      text: formatQuota(t?.maxAccounts, QUOTA_UNLIMITED_TEXT_DETAIL),
    },
    {
      key: "users",
      label: "最大用户数",
      text: formatQuota(t?.maxUsers, QUOTA_UNLIMITED_TEXT_DETAIL),
    },
    {
      key: "groups",
      label: "最大用户组数",
      text: formatQuota(t?.maxUserGroups, QUOTA_UNLIMITED_TEXT_DETAIL),
    },
  ];
});

/** 云厂商白名单（空 = 全部允许；按 eiam 原值逐个展示，不做本地改名） */
const vendors = computed(() => detail.value?.allowedVendors ?? []);

/** 功能开关（空 = 无；键按字典序稳定展示，值 → 启用/禁用） */
const switches = computed(() =>
  Object.entries(detail.value?.featureSwitch ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, on]) => ({ key, text: `${key}=${on ? "启用" : "禁用"}` })),
);

/** 用量段（用量 / 上限；undefined 用量 → '—'，超限规则见 ./usage isUsageOver） */
const usageRows = computed(() => {
  const t = detail.value;
  return [
    {
      key: "users",
      label: "用户",
      text: formatUsage(
        t?.userCount,
        t?.maxUsers,
        QUOTA_UNLIMITED_TEXT_DETAIL,
      ),
      over: isUsageOver(t?.userCount, t?.maxUsers),
    },
    {
      key: "groups",
      label: "用户组",
      text: formatUsage(
        t?.userGroupCount,
        t?.maxUserGroups,
        QUOTA_UNLIMITED_TEXT_DETAIL,
      ),
      over: isUsageOver(t?.userGroupCount, t?.maxUserGroups),
    },
  ];
});
</script>

<template>
  <div
    v-if="tenant"
    class="dialog-overlay dialog-overlay--drawer"
    data-testid="tenant-detail-drawer"
    @click.self="close"
  >
    <aside
      ref="drawerRef"
      class="drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="`${displayName} · 详情`"
    >
      <header class="drawer__head">
        <h3 class="drawer__title">{{ displayName }} · 详情</h3>
        <button
          type="button"
          class="btn btn--text"
          aria-label="关闭详情抽屉"
          data-testid="detail-close"
          @click="close"
        >
          ✕
        </button>
      </header>

      <div class="drawer__body" :aria-busy="loading">
        <!-- 加载态（T5：不空白、不闪错） -->
        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="i in 4" :key="i" class="skeleton__row" />
        </div>

        <!-- 失败 / 未找到（T6）：服务端 msg 原文 + 重试 -->
        <div
          v-else-if="error"
          class="state-error"
          role="alert"
          data-testid="detail-error"
        >
          <p class="state-error__text">{{ error }}</p>
          <button
            type="button"
            class="btn btn--ghost"
            data-testid="detail-retry"
            @click="load"
          >
            重试
          </button>
        </div>

        <template v-else-if="detail">
          <!-- ① 基本信息 -->
          <section class="section" data-testid="detail-basic">
            <h4 class="section__title">基本信息</h4>
            <dl class="kv">
              <div class="kv__row">
                <dt class="kv__key">名称</dt>
                <dd class="kv__value" data-testid="detail-name">
                  {{ detail.name || USAGE_PLACEHOLDER }}
                </dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">编码</dt>
                <dd class="kv__value" data-testid="detail-code">
                  {{ codeText }}
                </dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">域名</dt>
                <dd class="kv__value" data-testid="detail-domain">
                  {{ domainText }}
                </dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">状态</dt>
                <dd class="kv__value">
                  <StatusBadge :status="detail.status ?? 'unknown'" size="sm" />
                </dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">创建时间</dt>
                <dd class="kv__value" data-testid="detail-ctime">
                  {{ ctimeText }}
                </dd>
              </div>
            </dl>
          </section>

          <!-- ② 治理配置（只读：配额 / 白名单 / 开关） -->
          <section class="section" data-testid="detail-governance">
            <h4 class="section__title">治理配置</h4>
            <dl class="kv">
              <div
                v-for="q in quotas"
                :key="q.key"
                class="kv__row"
                :data-testid="`detail-quota-${q.key}`"
              >
                <dt class="kv__key">{{ q.label }}</dt>
                <dd class="kv__value">{{ q.text }}</dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">云厂商白名单</dt>
                <dd class="kv__value" data-testid="detail-vendors">
                  <template v-if="vendors.length > 0">
                    <span
                      v-for="v in vendors"
                      :key="v"
                      class="tag"
                      data-testid="detail-vendor"
                      >{{ v }}</span
                    >
                  </template>
                  <span v-else class="muted">全部允许</span>
                </dd>
              </div>
              <div class="kv__row">
                <dt class="kv__key">功能开关</dt>
                <dd class="kv__value" data-testid="detail-switches">
                  <template v-if="switches.length > 0">
                    <span
                      v-for="sw in switches"
                      :key="sw.key"
                      class="tag"
                      data-testid="detail-switch"
                      >{{ sw.text }}</span
                    >
                  </template>
                  <span v-else class="muted">无</span>
                </dd>
              </div>
            </dl>
          </section>

          <!-- ③ 用量（用量 / 上限；超限危险色 + 「超出配额」） -->
          <section class="section" data-testid="detail-usage">
            <h4 class="section__title">用量</h4>
            <dl class="kv">
              <div
                v-for="row in usageRows"
                :key="row.key"
                class="kv__row"
                :data-testid="`detail-usage-${row.key}`"
              >
                <dt class="kv__key">{{ row.label }}</dt>
                <dd
                  class="kv__value"
                  :class="{ 'is-over': row.over }"
                  :data-testid="`detail-usage-${row.key}-value`"
                >
                  {{ row.text }}
                  <span
                    v-if="row.over"
                    class="over-badge"
                    data-testid="detail-over-quota"
                    >{{ OVER_QUOTA_TEXT }}</span
                  >
                </dd>
              </div>
            </dl>
          </section>
        </template>
      </div>

      <!-- 只读视图：底部仅「关闭」，无任何写入口 -->
      <footer class="drawer__foot">
        <button type="button" class="btn btn--ghost" @click="close">
          关闭
        </button>
      </footer>
    </aside>
  </div>
</template>

<style scoped lang="scss">
/* 遮罩：沿用租户列表 .dialog-overlay 语言，抽屉贴右 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;

  &--drawer {
    justify-content: flex-end;
  }
}

.drawer {
  width: min(560px, 100%);
  height: 100%;
  max-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-base);
  min-width: 0;

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
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  &__foot {
    display: flex;
    justify-content: flex-end;
    padding: 10px 20px 16px;
    border-top: 1px solid var(--border-subtle);
  }
}

.section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;

  &__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: none;
  }
}

/* 键值行：窄屏 key 列不压字，value 允许换行（375px 不横向破版） */
.kv {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;

  &__row {
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    font-size: 13px;
    line-height: 1.6;
  }

  &__key {
    color: var(--text-secondary);
    white-space: nowrap;
  }

  &__value {
    margin: 0;
    color: var(--text-primary);
    min-width: 0;
    word-break: break-word;

    &.is-over {
      color: var(--color-danger);
      font-weight: 600;
    }
  }
}

.tag {
  display: inline-block;
  margin: 0 6px 4px 0;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--tag-bg);
  color: var(--text-regular);
  font-size: 12px;
  line-height: 1.6;
}

.over-badge {
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.6;
  background: var(--color-danger);
  color: #fff;
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.btn {
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &--ghost {
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-regular);
  }
  &--text {
    background: transparent;
    color: var(--accent-blue);
    height: auto;
    padding: 4px 8px;
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.state-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 28px 8px;
  text-align: center;
  color: var(--text-secondary);

  &__text {
    margin: 0;
    color: var(--color-danger);
  }
}

.skeleton__row {
  height: 40px;
  margin: 8px 0;
  background: var(--tag-bg);
  border-radius: 6px;
}

/* 窄屏 375px：抽屉占满视口、键值行收紧（M8/T8 不横向破版） */
@media (max-width: 480px) {
  .drawer {
    width: 100%;

    &__head,
    &__body,
    &__foot {
      padding-left: 12px;
      padding-right: 12px;
    }
  }

  .kv__row {
    grid-template-columns: 88px minmax(0, 1fr);
  }
}
</style>
