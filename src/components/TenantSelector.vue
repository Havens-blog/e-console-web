<script setup lang="ts">
// 租户选择器共享组件（task 3.1）—— 主布局 header + 租户选择页（3.2）复用。
//
// 读取 user store 所属租户列表，勾选目标 → tenant store switchTenant
// （POST /api/iam/tenant/switch + X-Active-Tenant-ID 头 + 整页 location.replace）。
// Hard Rule：切租户必走 tenant/switch + 整页 reload，禁止仅换 store 不刷页的 SPA 路径。
//
// 三态（与 e-cam-web TenantSelector.vue 同款 + 零租户受限态）：
//   - tenants.length === 0 → 禁用占位「无所属租户」（契约 tenant.none，零租户受限态）
//   - tenants.length === 1 → 静态文本当前租户名（无可切换）
//   - tenants.length > 1  → el-select 勾选切换
//
// 切换失败：tenant store error 经 ElMessage 提示（契约文案未知 code 回退原文，零二次映射）。
import { computed, watch } from "vue";
import { ElMessage } from "element-plus";
import { useUserStore } from "@/stores/user";
import { useTenantStore } from "@/stores/tenant";
import { COPY_CONTRACT } from "@/utils/copyContract";

interface Props {
  /** 宽度（header 默认 160px；租户选择页 3.2 可传更宽） */
  width?: string;
  /** el-select 占位文案 */
  placeholder?: string;
  /** size 透传 el-select（header 用 small，租户选择页可用 default） */
  size?: "small" | "default" | "large";
}
const props = withDefaults(defineProps<Props>(), {
  width: "160px",
  placeholder: "选择租户",
  size: "small",
});

const userStore = useUserStore();
const tenantStore = useTenantStore();

const tenants = computed(() => userStore.tenants);
const currentId = computed(() => userStore.currentTenantId);
const hasMultiple = computed(() => tenants.value.length > 1);
const hasNone = computed(() => tenants.value.length === 0);

/** 当前租户名（找不到时回退 `租户 #<id>`，与 e-cam-web TenantSelector 同款） */
const currentName = computed(() => {
  const t = tenants.value.find((x) => x.id === currentId.value);
  if (t?.name) return t.name;
  return currentId.value ? `租户 #${currentId.value}` : "";
});

/** 零租户占位文案（契约 tenant.none = '无所属租户'，逐字引用契约常量，零硬编码措辞） */
const noneLabel = COPY_CONTRACT["tenant.none"];

async function onSwitch(targetId: number | string): Promise<void> {
  const id = typeof targetId === "number" ? targetId : Number(targetId);
  // 0（无）或与当前相同 → 不切换（防重复 reload）
  if (!id || id === currentId.value) return;
  // Hard Rule：切租户必走 tenant/switch + 整页 reload（tenant store 内部完成 location.replace）
  await tenantStore.switchTenant(id);
}

// 切换失败提示：tenant store error 变化时弹契约文案（未知 code 回退原文，零二次映射）。
// 成功路径 reload 后整页销毁，watch 自然不复触发。
watch(
  () => tenantStore.error,
  (msg) => {
    if (msg) ElMessage.error(msg);
  },
);
</script>

<template>
  <div class="tenant-selector" :style="{ width: props.width }">
    <el-select
      v-if="hasMultiple"
      :model-value="currentId"
      :placeholder="props.placeholder"
      :loading="tenantStore.switching"
      :disabled="tenantStore.switching"
      :size="props.size"
      @change="onSwitch"
    >
      <el-option
        v-for="t in tenants"
        :key="t.id"
        :label="(t.name || `租户 #${t.id}`) + (t.status === 'disable' ? '（已停用）' : '')"
        :value="t.id"
        :disabled="t.status === 'disable'"
      />
    </el-select>
    <span v-else-if="hasNone" class="tenant-selector-none" :title="noneLabel">
      {{ noneLabel }}
    </span>
    <span v-else class="tenant-selector-current" :title="currentName">
      {{ currentName }}
    </span>
  </div>
</template>

<style scoped lang="scss">
.tenant-selector {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.tenant-selector-none,
.tenant-selector-current {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tenant-selector-none {
  border: 1px dotted var(--border-base);
  color: var(--text-tertiary);
  opacity: 0.7;
}

.tenant-selector-current {
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
}
</style>
