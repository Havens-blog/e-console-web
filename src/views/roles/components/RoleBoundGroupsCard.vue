<script setup lang="ts">
/**
 * 角色详情页「关联用户组」只读区块（feat-role-bound-groups 契约 §2.3）。
 *
 * 补齐角色侧三元反查的最后一元：一屏回答「这个角色绑了哪些**策略**、哪些**用户**、
 * 哪些**用户组**」。后端零改动（`POST /group/list/attached/role` 已存在），
 * 本区块**纯只读**：不得出现任何增/删/改入口（组与角色的绑定变更属用户组域的
 * 「组角色分配」，已有既有入口），故结构上没有任何输入控件或写按钮 —— 唯一的按钮是
 * 错误态的「重试」。
 *
 * 数据流（契约 §2.2 / §2.3）：
 * - `roleCode` 变化（打开详情页）→ `listGroupsForRole(roleCode, {offset:0, limit:100, keyword:""})`
 *   取前若干条（manifest：本区块不做分页）；
 * - 请求序号丢弃迟到响应（换角色后旧响应不回写），与 RoleInheritanceCard /
 *   UserPermissionSources 同款范式；
 * - 错误 → 服务端 msg **原文** + 「重试」（只重拉本区块）。
 *
 * 权限（词表 `config/permission-codes.ts`；仅体验层裁剪，OPA 为唯一安全边界）：
 * - 按 `IAM_GROUP.VIEW_ROLE_GROUPS` 渲染；**缺码 → 整块不渲染且不发请求**。
 *
 * 样式语言沿用上一轮 `RoleInheritanceCard.vue`（原生元素 + `.btn` / `.muted` / `.mono`），
 * **不使用 Element Plus 组件、不引入新依赖**。所有按钮 `type="button"`
 * （详情页有 `<form>`，避免冒泡触发提交）。
 */
import { computed, ref, watch } from "vue";
import { listGroupsForRole } from "@/api/groups";
import { ApiError, type TenantGroup } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_GROUP } from "@/config/permission-codes";

const props = defineProps<{
  /** 目标角色 code（attached/role 端点以 code 为键，非 id） */
  roleCode: string;
}>();

/** 本区块不做分页：按接口上限取前若干条（与用户侧「权限来源」同口径） */
const LIST_LIMIT = 100;

// ---- 权限门：缺 iam:group:view_role_groups → 不渲染、不请求 ----
const { can } = useCan();
const canView = computed<boolean>(() => can(IAM_GROUP.VIEW_ROLE_GROUPS));

/** 服务端拒绝原因 / 网络错误 message **原文**展示（不套通用文案、不做二次改写） */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

const groups = ref<TenantGroup[]>([]);
const loading = ref<boolean>(false);
const error = ref<string>("");
/** 请求序号：换角色 / 重复重试时，旧响应一律丢弃 */
let requestSeq = 0;

async function load(): Promise<void> {
  // 缺码 或 roleCode 为空 → 直接返回（不渲染即零请求，双保险）
  if (!canView.value || props.roleCode === "") return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const page = await listGroupsForRole(props.roleCode, {
      offset: 0,
      limit: LIST_LIMIT,
      keyword: "",
    });
    if (seq !== requestSeq) return;
    groups.value = page.items;
  } catch (err) {
    if (seq !== requestSeq) return;
    // 独立降级：只清本区块数据并置错误态（可重试）
    groups.value = [];
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

/**
 * 打开 / 换角色 / 权限码变化 → 清空后重拉。
 * 只观察标量（不观察对象身份），避免父页重渲染造成无意义重拉。
 */
watch(
  () => `${props.roleCode}|${canView.value}`,
  () => {
    groups.value = [];
    error.value = "";
    loading.value = false;
    if (!canView.value || props.roleCode === "") {
      // 失效态：让在途响应作废
      requestSeq++;
      return;
    }
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <section
    v-if="canView && roleCode !== ''"
    class="bound-groups-card"
    data-testid="role-bound-groups"
    aria-label="关联用户组"
    :aria-busy="loading"
  >
    <header class="bound-groups-card__head">
      <h3 class="bound-groups-card__title">关联用户组</h3>
      <span class="muted">{{ groups.length }} 项</span>
    </header>
    <p class="muted bound-groups-card__hint">
      该角色被以下用户组关联（只读）；组的成员与角色分配请到用户组页操作。
    </p>

    <!-- 错误：服务端 msg 原文 + 重试（只重拉本区块） -->
    <p
      v-if="error"
      class="state-error"
      role="alert"
      data-testid="role-bound-groups-error"
    >
      {{ error }}
      <button type="button" class="btn btn--text" @click="load">重试</button>
    </p>

    <!-- 加载态 -->
    <div v-else-if="loading" class="skeleton" aria-hidden="true">
      <div v-for="i in 2" :key="i" class="skeleton__row" />
    </div>

    <!-- 空态 -->
    <p
      v-else-if="groups.length === 0"
      class="state-empty"
      data-testid="role-bound-groups-empty"
    >
      该角色未被任何用户组关联
    </p>

    <!-- 条目：组名 / 标识码（等宽）/ 描述 -->
    <ul v-else class="bound-groups-list">
      <li
        v-for="g in groups"
        :key="g.id"
        class="bound-groups-row"
        data-testid="role-bound-group-item"
        :data-group-code="g.code"
      >
        <span class="bound-groups-row__name">{{ g.name || g.code }}</span>
        <span class="bound-groups-row__code mono">{{ g.code }}</span>
        <span class="bound-groups-row__desc">{{ g.desc || "—" }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.bound-groups-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text-primary);
}

.bound-groups-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.bound-groups-card__title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-regular);
}

.bound-groups-card__hint {
  margin: 0;
  line-height: 1.5;
}

.bound-groups-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bound-groups-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-regular);

  &__name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__code {
    color: var(--text-secondary);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__desc {
    flex: 1 1 160px;
    min-width: 0;
    color: var(--text-secondary);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.btn {
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;

  &--text {
    background: transparent;
    color: var(--accent-blue);
    height: auto;
    padding: 2px 4px;
  }
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.muted {
  color: var(--text-secondary);
  font-size: 12px;
}

.state-empty {
  margin: 0;
  padding: 16px 8px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.state-error {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
  color: var(--color-danger);
  font-size: 13px;
}

.skeleton__row {
  height: 32px;
  margin: 6px 0;
  background: var(--tag-bg);
  border-radius: 6px;
}

/* 窄屏：条目换行不挤压 */
@media (max-width: 480px) {
  .bound-groups-card {
    padding: 12px;
  }
}
</style>
