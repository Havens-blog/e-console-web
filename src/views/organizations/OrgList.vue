<script setup lang="ts">
/**
 * 组织管理页（UF-5，task 4.3）—— 页面骨架 + 整页错误态 + 子区块编排。
 *
 * 参照：ui-design UF-5（Layout 2:3 双栏 / States / Interactions / Data Binding）+ tech-design
 * §Interfaces + parity-checklist §2.5/§3.2 分歧 D-1（组织=department）。
 *
 * 布局：左树 : 右侧（详情 + 成员）= 2:3，树最小宽 280px。
 *
 * 本文件已按大文件拆分手册拆分（原 1216 行），拆出：
 * - components/OrgTree.vue         左栏组织树（展开态 + 键盘导航，自持）
 * - components/OrgDetailCard.vue   右栏上·组织详情卡片
 * - components/OrgMembersCard.vue  右栏下·成员列表卡片
 * - components/OrgDialogs.vue      新增/编辑/删除三个对话框（自持全部弹窗状态）
 * - composables/useTreeNavigation.ts   树的展开态与键盘导航
 * - styles/_shared|_form|_dialog.scss  多组件共用的基础样式（说明见各 partial 头部）
 *
 * 页面自身只保留：布局骨架、整页错误态、以及把子区块的动作路由到对话框。
 * 上限保护（Hard Rule：树 ≤1000 节点/深度 ≤8）与删除 E11 硬规则仍由 store 与子组件实现，
 * 语义未变。
 */
import { computed, onMounted, ref } from "vue";
import { useOrgListStore } from "@/stores/orgList";
import type { OrganizationNode } from "@/api/types";
import { useCan } from "@/composables/useCan";
import { IAM_DEPARTMENT } from "@/config/permission-codes";
import CopyContractText from "@/components/CopyContractText.vue";
import OrgTree from "./components/OrgTree.vue";
import OrgDetailCard from "./components/OrgDetailCard.vue";
import OrgMembersCard from "./components/OrgMembersCard.vue";
import OrgDialogs from "./components/OrgDialogs.vue";

const store = useOrgListStore();

// P0 权限码按钮裁剪（词表 permission-codes.ts / parity §5；与菜单 & 路由守卫同口径）
const { can } = useCan();

/** 左树引用：数据到位后触发「默认展开并选中首个根节点」 */
const treeRef = ref<InstanceType<typeof OrgTree> | null>(null);
/** 对话框引用：树与详情卡片的动作经页面路由到对话框（对话框归属页面） */
const dialogsRef = ref<InstanceType<typeof OrgDialogs> | null>(null);

// ---- 状态迁移渲染辅助 ----
const isError = computed(
  () => store.error !== null && store.items.length === 0,
);

// ---- 子区块动作 → 对话框 ----
function onCreateRoot(): void {
  dialogsRef.value?.openCreateRoot();
}

function onCreateChild(node: OrganizationNode): void {
  dialogsRef.value?.openCreateChild(node);
}

function onEdit(node: OrganizationNode): void {
  dialogsRef.value?.openEdit(node);
}

function onDelete(node: OrganizationNode): void {
  dialogsRef.value?.openDelete(node);
}

onMounted(async () => {
  await store.fetch();
  // 默认展开首个根节点并选中（拆分前直接改写本页 expanded/focusIndex，现委托 OrgTree）
  treeRef.value?.expandAndSelectFirst();
});
</script>

<template>
  <section class="page-org-list" :aria-busy="store.loading">
    <header class="page-head">
      <h2 class="page-title">组织管理</h2>
      <button
        v-if="can(IAM_DEPARTMENT.ADD)"
        type="button"
        class="btn btn--primary"
        @click="onCreateRoot"
      >
        新增根组织
      </button>
    </header>

    <!-- 读屏播报：组织树初次加载与刷新都经此常驻区域播报（视觉不可见）。
         原先只有 aria-busy 与骨架，读屏得不到「正在加载」信息（与列表页 R5 同类问题）。 -->
    <p class="sr-only" role="status" aria-live="polite">
      {{ store.loading ? "正在加载组织树…" : "" }}
    </p>

    <!-- 错误态（重试） -->
    <p v-if="isError" class="state-error" role="alert">
      <CopyContractText code="eiam.unavailable" tag="span" />
      <button type="button" class="btn btn--text" @click="store.fetch">
        重试
      </button>
    </p>

    <div v-if="!isError" class="org-layout">
      <!-- 左：组织树（2/5，最小 280px） -->
      <OrgTree
        ref="treeRef"
        @create-child="onCreateChild"
        @edit="onEdit"
        @delete="onDelete"
      />

      <!-- 右：详情 + 成员（3/5）。
           这里原先是 <main>，但外壳 MainLayout 已有 <main class="layout-content">，
           而 HTML 规范禁止 <main> 嵌套（实测本页 mainCount=2、nested=1），
           会让读屏的「主内容」地标与跳转失效。改用 <section aria-label> 保留
           「可导航区域」语义，同时不再产生第二个 main 地标。 -->
      <section class="org-detail" aria-label="组织详情与成员">
        <!-- 详情卡片 -->
        <OrgDetailCard
          @create-child="onCreateChild"
          @edit="onEdit"
          @delete="onDelete"
        />

        <!-- 成员列表卡片 -->
        <OrgMembersCard />
      </section>
    </div>

    <OrgDialogs ref="dialogsRef" />
  </section>
</template>

<style scoped lang="scss">
@use "./styles/shared";

.page-org-list {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--text-primary);
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.page-title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

/* 仅供读屏的隐藏文本（视觉不可见但保留在无障碍树中） */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.org-layout {
  display: grid;
  grid-template-columns: 2fr 3fr;
  gap: 16px;
  align-items: start;
}

// 窄屏（≤900）：双栏改单栏堆叠。
// 原实现固定 2fr 3fr，叠加左栏 .org-tree{min-width:280px}，在 390px 视口下栅格最小宽度
// 超出内容区，而 .main-area 为 overflow:hidden——右栏「组织详情 / 成员列表」被直接裁掉
// 且无法横向滚动，等于不可达。单栏后左右两块按序堆叠，全部内容可滚动抵达。
@media (max-width: 900px) {
  .org-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.org-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

@media (max-width: 560px) {
  .page-org-list {
    padding: 16px;
  }
}
</style>
