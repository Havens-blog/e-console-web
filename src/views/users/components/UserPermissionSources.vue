<script setup lang="ts">
/**
 * 用户详情页「权限来源」只读面板（feat-user-permission-sources 契约 §2.2）。
 *
 * 排障诉求：一屏回答「这个用户的权限从哪来」—— 所属**角色**、**分组**、直接**策略**、
 * 所属**租户**四段来源（AGENTS.md：Casbin 维护 User → Group → Role，OPA 负责策略决策）。
 * 后端零改动：四个 attached/user 端点均已存在（契约 §1），本面板**纯只读**，
 * **不含任何增删改入口**（角色绑定 / 组成员 / 策略绑定 / 租户分配各有既有页面）。
 *
 * 数据流与降级（契约 §2.2）：
 * - 挂载 / `userId` 变化 / 权限码变化 → 各区块**并行**拉取；
 * - **区块级独立降级**：每个区块各有 loading / error / empty / items 四态，
 *   一个区块失败只把该区块置为错误态（可重试），其余区块照常渲染 ——
 *   绝不共用一个整体 loading 或一个全局 error；
 * - 请求序号丢弃迟到响应（换用户后旧响应不回写），与 RoleInheritanceCard 同款范式。
 *
 * 权限（词表 `config/permission-codes.ts`；仅体验层裁剪，OPA 为唯一安全边界）：
 * - 角色 → `iam:role:view_user_roles`；分组 → `iam:group:view_user_groups`；
 *   策略 → `iam:policy:view_user_policies`；租户 → `iam:tenant:view_user_tenants`；
 * - 缺码 → **该区块不渲染且不发请求**；四码全缺 → 整卡不渲染（同样零请求）。
 *
 * 交互 / 样式语言沿用 `views/roles/components/RoleInheritanceCard.vue`：原生元素 +
 * `.btn` / `.muted` 语汇，**不使用 Element Plus 组件、不引入新依赖**。
 * 所有按钮均 `type="button"`（本面板可能被嵌在详情页表单内，避免冒泡触发提交）。
 */
import {
  computed,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { listRolesForUser } from "@/api/roles";
import { listGroupsForUser } from "@/api/groups";
import { listPoliciesForUser, type PolicyWithMeta } from "@/api/policies";
import { listTenantsForUser } from "@/api/tenants";
import {
  ApiError,
  type Role,
  type Tenant,
  type TenantGroup,
} from "@/api/types";
import { useCan } from "@/composables/useCan";
import {
  IAM_GROUP,
  IAM_POLICY,
  IAM_ROLE,
  IAM_TENANT,
} from "@/config/permission-codes";
import { formatUsage } from "@/views/tenants/usage";

const props = defineProps<{
  /** 目标用户 id（路由参数）；<= 0 时不发任何请求（详情页未加载完的防御） */
  userId: number;
}>();

/** 策略 / 租户按接口上限取前若干条（manifest：本面板不做分页） */
const SOURCE_PAGE_SIZE = 100;

// ---- 权限门：每区块一枚码，缺码即不渲染、不请求 ----
const { can } = useCan();
const canRoles = computed<boolean>(() => can(IAM_ROLE.VIEW_USER_ROLES));
const canGroups = computed<boolean>(() => can(IAM_GROUP.VIEW_USER_GROUPS));
const canPolicies = computed<boolean>(() =>
  can(IAM_POLICY.VIEW_USER_POLICIES),
);
const canTenants = computed<boolean>(() => can(IAM_TENANT.VIEW_USER_TENANTS));

/** 四码全缺 → 整卡不渲染（不渲染 = 零请求） */
const hasAnySection = computed<boolean>(
  () =>
    canRoles.value || canGroups.value || canPolicies.value ||
    canTenants.value,
);

/** 区块状态（每区块一份独立实例，互不共享） */
interface SourceSection<T> {
  items: Ref<T[]>;
  loading: Ref<boolean>;
  error: Ref<string>;
  load: () => Promise<void>;
}

/** 服务端拒绝原因 / 网络错误 message **原文**展示（不套通用文案、不做二次改写） */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

/**
 * 造一个独立区块：被禁用（缺码）或 userId 非法时 `load` 直接返回（不发请求）。
 * `fetcher` 在调用时才读取 props，保证换用户后拿到的是新 id。
 */
function createSection<T>(
  enabled: ComputedRef<boolean>,
  fetcher: () => Promise<T[]>,
): SourceSection<T> {
  const items = ref<T[]>([]) as Ref<T[]>;
  const loading = ref<boolean>(false);
  const error = ref<string>("");
  /** 请求序号：换用户 / 重复重试时，旧响应一律丢弃 */
  let requestSeq = 0;

  async function load(): Promise<void> {
    if (!enabled.value || props.userId <= 0) return;
    const seq = ++requestSeq;
    loading.value = true;
    error.value = "";
    try {
      const list = await fetcher();
      if (seq !== requestSeq) return;
      items.value = list;
    } catch (err) {
      if (seq !== requestSeq) return;
      // 该区块独立降级：只清本区块数据并置错误态，不影响其它区块
      items.value = [];
      error.value = errorMessage(err);
    } finally {
      if (seq === requestSeq) loading.value = false;
    }
  }

  return { items, loading, error, load };
}

const {
  items: roleItems,
  loading: rolesLoading,
  error: rolesError,
  load: loadRoles,
} = createSection<Role>(canRoles, () => listRolesForUser(props.userId));

const {
  items: groupItems,
  loading: groupsLoading,
  error: groupsError,
  load: loadGroups,
} = createSection<TenantGroup>(canGroups, () =>
  listGroupsForUser(props.userId),
);

const {
  items: policyItems,
  loading: policiesLoading,
  error: policiesError,
  load: loadPolicies,
} = createSection<PolicyWithMeta>(canPolicies, async () => {
  const page = await listPoliciesForUser(props.userId, {
    offset: 0,
    limit: SOURCE_PAGE_SIZE,
    keyword: "",
  });
  return page.items;
});

const {
  items: tenantItems,
  loading: tenantsLoading,
  error: tenantsError,
  load: loadTenants,
} = createSection<Tenant>(canTenants, async () => {
  const page = await listTenantsForUser(props.userId, {
    offset: 0,
    limit: SOURCE_PAGE_SIZE,
    keyword: "",
  });
  return page.items;
});

/**
 * 触发重算的唯一键：用户 id 或四枚权限码任一变化 → 清空各区块后并行重拉。
 * 只观察标量（不观察对象身份），避免父页重渲染造成无意义重拉。
 */
const requestKey = computed<string>(
  () =>
    `${props.userId}|${canRoles.value}|${canGroups.value}|${canPolicies.value}|${canTenants.value}`,
);

watch(
  requestKey,
  () => {
    // 换用户先清空，防止旧用户的条目在新请求返回前短暂串到新用户身上
    roleItems.value = [];
    groupItems.value = [];
    policyItems.value = [];
    tenantItems.value = [];
    void loadRoles();
    void loadGroups();
    void loadPolicies();
    void loadTenants();
  },
  { immediate: true },
);
</script>

<template>
  <section
    v-if="hasAnySection && userId > 0"
    class="permission-sources"
    data-testid="user-permission-sources"
    aria-label="权限来源"
  >
    <header class="permission-sources__head">
      <h3 class="permission-sources__title">权限来源</h3>
      <p class="muted permission-sources__hint">
        该用户的权限来源汇总（只读）。角色 / 分组的权限由 Casbin 层级继承，直接策略由 OPA
        决策；变更请到对应管理页操作。
      </p>
    </header>

    <div class="permission-sources__grid">
      <!-- 角色：iam:role:view_user_roles -->
      <section
        v-if="canRoles"
        class="source-block"
        data-testid="ups-roles"
        :aria-busy="rolesLoading"
      >
        <header class="source-block__head">
          <h4 class="source-block__title">角色</h4>
          <span class="muted">{{ roleItems.length }} 项</span>
        </header>
        <p
          v-if="rolesError"
          class="source-block__error"
          role="alert"
          data-testid="ups-roles-error"
        >
          {{ rolesError }}
          <button type="button" class="btn btn--text" @click="loadRoles">
            重试
          </button>
        </p>
        <div
          v-else-if="rolesLoading"
          class="skeleton"
          aria-hidden="true"
        >
          <div v-for="i in 2" :key="i" class="skeleton__row" />
        </div>
        <p
          v-else-if="roleItems.length === 0"
          class="muted source-block__empty"
          data-testid="ups-roles-empty"
        >
          该用户未分配角色
        </p>
        <ul v-else class="source-block__list">
          <li
            v-for="r in roleItems"
            :key="r.code || String(r.id)"
            class="source-block__item"
            data-testid="ups-role-item"
          >
            <span class="source-block__name">{{ r.name || r.code }}</span>
            <span v-if="r.code" class="source-block__code mono">{{ r.code }}</span>
          </li>
        </ul>
      </section>

      <!-- 分组：iam:group:view_user_groups -->
      <section
        v-if="canGroups"
        class="source-block"
        data-testid="ups-groups"
        :aria-busy="groupsLoading"
      >
        <header class="source-block__head">
          <h4 class="source-block__title">分组</h4>
          <span class="muted">{{ groupItems.length }} 项</span>
        </header>
        <p
          v-if="groupsError"
          class="source-block__error"
          role="alert"
          data-testid="ups-groups-error"
        >
          {{ groupsError }}
          <button type="button" class="btn btn--text" @click="loadGroups">
            重试
          </button>
        </p>
        <div
          v-else-if="groupsLoading"
          class="skeleton"
          aria-hidden="true"
        >
          <div v-for="i in 2" :key="i" class="skeleton__row" />
        </div>
        <p
          v-else-if="groupItems.length === 0"
          class="muted source-block__empty"
          data-testid="ups-groups-empty"
        >
          该用户未加入任何分组
        </p>
        <ul v-else class="source-block__list">
          <li
            v-for="g in groupItems"
            :key="g.code || String(g.id)"
            class="source-block__item"
            data-testid="ups-group-item"
          >
            <span class="source-block__name">{{ g.name || g.code }}</span>
            <span v-if="g.code" class="source-block__code mono">{{ g.code }}</span>
          </li>
        </ul>
      </section>

      <!-- 直接策略：iam:policy:view_user_policies -->
      <section
        v-if="canPolicies"
        class="source-block"
        data-testid="ups-policies"
        :aria-busy="policiesLoading"
      >
        <header class="source-block__head">
          <h4 class="source-block__title">策略</h4>
          <span class="muted">{{ policyItems.length }} 项</span>
        </header>
        <p
          v-if="policiesError"
          class="source-block__error"
          role="alert"
          data-testid="ups-policies-error"
        >
          {{ policiesError }}
          <button type="button" class="btn btn--text" @click="loadPolicies">
            重试
          </button>
        </p>
        <div
          v-else-if="policiesLoading"
          class="skeleton"
          aria-hidden="true"
        >
          <div v-for="i in 2" :key="i" class="skeleton__row" />
        </div>
        <p
          v-else-if="policyItems.length === 0"
          class="muted source-block__empty"
          data-testid="ups-policies-empty"
        >
          该用户无直接绑定的策略
        </p>
        <ul v-else class="source-block__list">
          <li
            v-for="p in policyItems"
            :key="p.code || String(p.id)"
            class="source-block__item"
            data-testid="ups-policy-item"
          >
            <span class="source-block__name">{{ p.name || p.code }}</span>
            <span v-if="p.code" class="source-block__code mono">{{ p.code }}</span>
          </li>
        </ul>
      </section>

      <!-- 所属租户：iam:tenant:view_user_tenants -->
      <section
        v-if="canTenants"
        class="source-block"
        data-testid="ups-tenants"
        :aria-busy="tenantsLoading"
      >
        <header class="source-block__head">
          <h4 class="source-block__title">所属租户</h4>
          <span class="muted">{{ tenantItems.length }} 项</span>
        </header>
        <p
          v-if="tenantsError"
          class="source-block__error"
          role="alert"
          data-testid="ups-tenants-error"
        >
          {{ tenantsError }}
          <button type="button" class="btn btn--text" @click="loadTenants">
            重试
          </button>
        </p>
        <div
          v-else-if="tenantsLoading"
          class="skeleton"
          aria-hidden="true"
        >
          <div v-for="i in 2" :key="i" class="skeleton__row" />
        </div>
        <p
          v-else-if="tenantItems.length === 0"
          class="muted source-block__empty"
          data-testid="ups-tenants-empty"
        >
          该用户不属于任何租户
        </p>
        <ul v-else class="source-block__list">
          <li
            v-for="t in tenantItems"
            :key="t.code || String(t.id)"
            class="source-block__item"
            data-testid="ups-tenant-item"
          >
            <span class="source-block__name">{{ t.name || t.code }}</span>
            <span v-if="t.code" class="source-block__code mono">{{ t.code }}</span>
            <!-- 复用租户用量口径：用量 undefined → '—'（不渲染 0），配额 0 → '不限' -->
            <span class="muted source-block__meta">
              用户 {{ formatUsage(t.userCount, t.maxUsers) }}
            </span>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style scoped lang="scss">
.permission-sources {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--text-primary);
  max-width: 880px;
}

.permission-sources__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.permission-sources__title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-regular);
}

.permission-sources__hint {
  margin: 0;
  line-height: 1.5;
}

.permission-sources__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.source-block {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.source-block__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.source-block__title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-regular);
}

.source-block__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-block__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--tag-bg);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-regular);
}

.source-block__name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-block__code {
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-block__meta {
  margin-left: auto;
  font-size: 12px;
}

.source-block__empty {
  margin: 0;
  padding: 8px 4px;
}

.source-block__error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  padding: 8px 10px;
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

/* 窄屏：区块单列、条目换行不挤压 */
@media (max-width: 480px) {
  .permission-sources {
    padding: 12px;
  }
}
</style>
