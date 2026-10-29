<script setup lang="ts">
/**
 * 角色详情页「关联用户」只读区块（feat-role-users）。
 *
 * 为什么需要：角色页已有「关联用户组」与「已绑定策略」两个反查区块，却**没有**「关联用户」——
 * 而"这个角色当前赋给了哪些人"恰恰是管理员最常问的问题（离职审计、变更影响面评估）。
 * 此前只能打开**编辑表单**看勾选状态，属于"为了看一眼而进入可提交的表单"。
 *
 * 来源：后端 `POST /user/list/attached/role` 早已存在（编辑表单的回显就在用它），
 * 但权限码 `iam:user:view_role_members` 一直**零引用**（全仓仅出现在词表里）——本轮启用。
 *
 * 纯只读：增删用户↔角色绑定走既有编辑表单（本区块不提供任何写入口）。
 *
 * 数据流：roleCode 变化 → listUsersByRole(roleCode, {offset:0, limit:100, keyword:""})；
 * 请求序号丢弃迟到响应（换角色后旧响应不回写），与 RoleBoundGroupsCard 同款范式。
 */
import { computed, ref, watch } from "vue";
import { listUsersByRole } from "@/api/users";
import { ApiError, type User } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_USER } from "@/config/permission-codes";

const props = defineProps<{
  /** 目标角色 code（attached/role 端点以 code 为键，非 id） */
  roleCode: string;
}>();

/** 本区块不做分页：按接口上限取前若干条（与相邻区块同口径） */
const LIST_LIMIT = 100;

const { can } = useCan();
const canView = computed<boolean>(() => can(IAM_USER.VIEW_ROLE_MEMBERS));

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "加载失败";
}

const users = ref<User[]>([]);
const total = ref(0);
const loading = ref(false);
const error = ref("");
let requestSeq = 0;

async function load(): Promise<void> {
  if (!canView.value || props.roleCode === "") return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    // 必须显式传 limit：eiam 对 limit<=0 会回落为 10
    const page = await listUsersByRole(props.roleCode, {
      offset: 0,
      limit: LIST_LIMIT,
      keyword: "",
    });
    if (seq !== requestSeq) return;
    users.value = page.items;
    total.value = page.total;
  } catch (err) {
    if (seq !== requestSeq) return;
    users.value = [];
    total.value = 0;
    error.value = errorMessage(err);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(() => props.roleCode, load, { immediate: true });

/** 是否因上限而截断（避免让人误以为这就是全部） */
const truncated = computed(() => total.value > users.value.length);
</script>

<template>
  <section v-if="canView" class="card" data-testid="role-users">
    <header class="card__head">
      <h3 class="card__title">关联用户</h3>
      <button type="button" class="btn btn--text" data-testid="role-users-refresh" @click="load">
        刷新
      </button>
    </header>

    <p v-if="loading" class="muted" data-testid="role-users-loading">正在加载关联用户…</p>

    <p v-else-if="error" class="state-error" role="alert" data-testid="role-users-error">
      {{ error }}
      <button type="button" class="btn btn--text" data-testid="role-users-retry" @click="load">
        重试
      </button>
    </p>

    <p v-else-if="users.length === 0" class="muted" data-testid="role-users-empty">
      该角色尚未赋给任何用户。
    </p>

    <template v-else>
      <ul class="user-list">
        <li v-for="u in users" :key="u.id" class="user-row" data-testid="role-user-item">
          <span class="user-name">{{ u.username || "—" }}</span>
          <span v-if="u.displayName" class="user-nick muted">{{ u.displayName }}</span>
        </li>
      </ul>
      <p v-if="truncated" class="muted" data-testid="role-users-truncated">
        共 {{ total }} 人，此处仅显示前 {{ users.length }} 人；完整名单请用「编辑」查看。
      </p>
    </template>
  </section>
</template>

<style scoped lang="scss">
.card {
  margin-top: 24px;
}

.card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.card__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.user-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.user-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 6px;
  min-width: 0;
}

.user-name {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.user-nick {
  font-size: 12px;
}
</style>
