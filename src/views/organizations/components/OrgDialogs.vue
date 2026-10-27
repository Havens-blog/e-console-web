<script setup lang="ts">
/**
 * OrgDialogs —— 新增子组织 / 编辑组织 / 删除确认三个对话框
 *
 * 拆分来源：OrgList.vue 原模板 677-839 行 + 样式 .dialog* 段 + 脚本弹窗状态与提交逻辑。
 * 边界理由：三个弹窗共用同一套「打开 → 校验 → 提交 → 关闭」形态与同一套外壳样式，
 * 状态彼此独立且与页面其余部分无往来，故合并为一个组件而非拆三个；页面只经模板 ref
 * 调用其 open* 方法（对话框的触发点分散在组织树与详情卡片，由页面统一路由）。
 *
 * 关键硬规则（搬迁时保持不变）：
 * - E11：删除预检（precheckDelete 的 child_count/user_count）阻断时弹窗列出计数、
 *   确认按钮置灰且不提交；预检通过才提交；eiam 拒绝作后置兜底（msg 透传）。
 * - 上限保护：createBlockedReason 非空时「保存」置灰且 submitCreate 直接 return。
 * - 组织名 1–64 字符前端校验（validateName），错误落到各自 fieldErrors。
 */
import { computed, ref } from "vue";
import {
  ORG_NAME_MAX,
  ORG_NAME_MIN,
  useOrgListStore,
} from "@/stores/orgList";
import { ApiError, type OrganizationNode } from "@/api/types";
import { contractText, formatContractText } from "@/utils/copyContract";
import CopyContractText from "@/components/CopyContractText.vue";
import { useDialogA11y } from "@/composables/useDialogA11y";

const store = useOrgListStore();

// ---- 新增子组织 Dialog（AC-3 + 上限保护）----
const showCreate = ref(false);
const createLoading = ref(false);
const createError = ref<string>("");
const createFieldErrors = ref<Record<string, string>>({});
const createName = ref("");
/** 新增的目标父节点（null=根组织） */
const createParent = ref<OrganizationNode | null>(null);
/** 上限保护：是否禁建 + tooltip 原因 */
const createBlockedReason = ref<string>("");

function openCreateRoot(): void {
  createParent.value = null;
  prepareCreate();
}

function openCreateChild(parent: OrganizationNode): void {
  createParent.value = parent;
  prepareCreate();
}

function prepareCreate(): void {
  const check = store.canAddChild(createParent.value?.id ?? null);
  createBlockedReason.value = check.allowed ? "" : check.reason;
  createName.value = "";
  createError.value = "";
  createFieldErrors.value = {};
  showCreate.value = true;
}

function validateName(value: string): string | null {
  if (value.length < ORG_NAME_MIN || value.length > ORG_NAME_MAX) {
    return `组织名长度 ${ORG_NAME_MIN}–${ORG_NAME_MAX} 字符`;
  }
  return null;
}

async function submitCreate(): Promise<void> {
  if (createBlockedReason.value) return; // 上限保护硬拦截
  createError.value = "";
  createFieldErrors.value = {};
  const nameErr = validateName(createName.value);
  if (nameErr) {
    createFieldErrors.value = { name: nameErr };
    return;
  }
  createLoading.value = true;
  try {
    const id = await store.create({
      parentId: createParent.value?.id,
      name: createName.value,
    });
    if (id === null) {
      createError.value = store.error ?? "新增组织失败";
      return;
    }
    showCreate.value = false;
  } finally {
    createLoading.value = false;
  }
}

function closeCreate(): void {
  showCreate.value = false;
}

// ---- 编辑 Dialog ----
const showEdit = ref(false);
const editLoading = ref(false);
const editError = ref<string>("");
const editFieldErrors = ref<Record<string, string>>({});
const editName = ref("");
const editId = ref<number>(0);

function openEdit(node: OrganizationNode): void {
  editId.value = node.id;
  editName.value = node.name;
  editError.value = "";
  editFieldErrors.value = {};
  showEdit.value = true;
}

async function submitEdit(): Promise<void> {
  editError.value = "";
  editFieldErrors.value = {};
  const nameErr = validateName(editName.value);
  if (nameErr) {
    editFieldErrors.value = { name: nameErr };
    return;
  }
  editLoading.value = true;
  try {
    const node = store.nodeIndex.get(editId.value);
    const ok = await store.update({
      id: editId.value,
      name: editName.value,
      parentId: node?.parentId,
    });
    if (!ok) {
      editError.value = store.error ?? "更新组织失败";
      return;
    }
    showEdit.value = false;
  } finally {
    editLoading.value = false;
  }
}

function closeEdit(): void {
  showEdit.value = false;
}

// ---- 删除（E11，Hard Rule：删除校验通过前不得放行提交）----
const deleteTarget = ref<{ id: number; name: string } | null>(null);
const deleteLoading = ref(false);
/** 阻断计数（precheckDelete 结果）；null = 未阻断可提交 */
const deleteBlocked = ref<{ childCount: number; userCount: number } | null>(
  null,
);
/** eiam 后置拒绝消息（兜底，Phase-0-contingent） */
const deleteRejectMsg = ref<string>("");

function openDelete(node: OrganizationNode): void {
  // 选中目标节点加载详情/成员（确保 child_count/user_count 已就绪）
  void store.loadDetail(node.id).then(() => {
    deleteTarget.value = { id: node.id, name: node.name };
    deleteRejectMsg.value = "";
    deleteLoading.value = false;
    // 前端预检（Hard Rule：校验通过前不得放行提交）
    deleteBlocked.value = store.precheckDelete();
  });
}

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  if (deleteBlocked.value) return; // 阻断态确认置灰（不可确认）
  deleteLoading.value = true;
  try {
    const deletedId = deleteTarget.value.id;
    const ok = await store.remove(deletedId);
    if (ok) {
      // 删除后若选中节点被删，清空选中
      if (store.selectedId === deletedId) {
        store.clearSelection();
      }
      deleteTarget.value = null;
    }
  } catch (err) {
    // eiam 后置拒绝（code=4010703，Phase-0-contingent）：msg 透传文案回退
    deleteRejectMsg.value = errorMessage(err);
  } finally {
    deleteLoading.value = false;
  }
}

function closeDelete(): void {
  deleteTarget.value = null;
  deleteBlocked.value = null;
  deleteRejectMsg.value = "";
}

/** 删除阻断文案（delete.blocked_org 契约插值，{n}=childCount/{m}=userCount） */
const deleteBlockedText = computed(() => {
  if (!deleteBlocked.value) return "";
  return formatContractText(contractText("delete.blocked_org") ?? "", {
    n: deleteBlocked.value.childCount,
    m: deleteBlocked.value.userCount,
  });
});

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code !== null) {
      const text = contractText(String(err.code));
      if (text) return text;
    }
    return err.message;
  }
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "操作失败";
}

// 页面经模板 ref 调用（触发点：组织树行内按钮、详情卡片动作按钮、页头「新增根组织」）
defineExpose({ openCreateRoot, openCreateChild, openEdit, openDelete });

// ---- 弹窗键盘 / 焦点可访问性（Escape 关闭、焦点入窗、Tab 不逃逸、关闭归还焦点）----
const createDialogRef = ref<HTMLElement | null>(null);
const editDialogRef = ref<HTMLElement | null>(null);
const deleteDialogRef = ref<HTMLElement | null>(null);
useDialogA11y(createDialogRef, { open: showCreate, onClose: closeCreate });
useDialogA11y(editDialogRef, { open: showEdit, onClose: closeEdit });
useDialogA11y(deleteDialogRef, {
  open: computed(() => deleteTarget.value !== null),
  onClose: closeDelete,
  // 危险操作弹窗：初始焦点落在「取消」，避免回车误删
  initialFocus: "[data-dialog-cancel]",
});
</script>

<template>
  <!-- 新增子组织 Dialog -->
  <div v-if="showCreate" class="dialog-overlay" @click.self="closeCreate">
    <div
      ref="createDialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="新增组织"
    >
      <header class="dialog__head">
        <h3>
          {{
            createParent ? `新增子组织（${createParent.name}）` : "新增根组织"
          }}
        </h3>
        <button type="button" class="btn btn--text" @click="closeCreate">
          ✕
        </button>
      </header>
      <form class="dialog__body" @submit.prevent="submitCreate">
        <!-- 上限保护阻断提示 -->
        <p v-if="createBlockedReason" class="delete-blocked" role="alert">
          {{ createBlockedReason }}（不可再建子级）
        </p>
        <p v-if="createError" class="form-error" role="alert">
          <CopyContractText :code="createError" tag="span" />
        </p>
        <label class="field">
          <span class="field__label"
            >组织名<span class="required">*</span></span
          >
          <input
            v-model="createName"
            type="text"
            class="input"
            data-testid="create-org-name"
            :maxlength="ORG_NAME_MAX"
            :aria-describedby="
              createFieldErrors.name ? 'create-org-name-error' : undefined
            "
            :aria-invalid="!!createFieldErrors.name"
          />
          <span class="muted"
            >{{ ORG_NAME_MIN }}–{{ ORG_NAME_MAX }} 字符</span
          >
          <span
            v-if="createFieldErrors.name"
            id="create-org-name-error"
            class="field__error"
            role="alert"
            >{{ createFieldErrors.name }}</span
          >
        </label>
        <div class="dialog__actions">
          <button type="button" class="btn btn--ghost" @click="closeCreate">
            取消
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            :disabled="createLoading || !!createBlockedReason"
            data-testid="create-org-submit"
          >
            {{ createLoading ? "提交中…" : "保存" }}
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- 编辑 Dialog -->
  <div v-if="showEdit" class="dialog-overlay" @click.self="closeEdit">
    <div
      ref="editDialogRef"
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="编辑组织"
    >
      <header class="dialog__head">
        <h3>编辑组织</h3>
        <button type="button" class="btn btn--text" @click="closeEdit">
          ✕
        </button>
      </header>
      <form class="dialog__body" @submit.prevent="submitEdit">
        <p v-if="editError" class="form-error" role="alert">
          <CopyContractText :code="editError" tag="span" />
        </p>
        <label class="field">
          <span class="field__label"
            >组织名<span class="required">*</span></span
          >
          <input
            v-model="editName"
            type="text"
            class="input"
            data-testid="edit-org-name"
            :maxlength="ORG_NAME_MAX"
            :aria-describedby="
              editFieldErrors.name ? 'edit-org-name-error' : undefined
            "
            :aria-invalid="!!editFieldErrors.name"
          />
          <span class="muted"
            >{{ ORG_NAME_MIN }}–{{ ORG_NAME_MAX }} 字符</span
          >
          <span
            v-if="editFieldErrors.name"
            id="edit-org-name-error"
            class="field__error"
            role="alert"
            >{{ editFieldErrors.name }}</span
          >
        </label>
        <div class="dialog__actions">
          <button type="button" class="btn btn--ghost" @click="closeEdit">
            取消
          </button>
          <button
            type="submit"
            class="btn btn--primary"
            :disabled="editLoading"
            data-testid="edit-org-submit"
          >
            {{ editLoading ? "提交中…" : "保存" }}
          </button>
        </div>
      </form>
    </div>
  </div>

  <!-- 删除确认 Dialog（E11：阻断计数 + 确认置灰） -->
  <div v-if="deleteTarget" class="dialog-overlay" @click.self="closeDelete">
    <div
      ref="deleteDialogRef"
      class="dialog dialog--sm"
      role="alertdialog"
      aria-modal="true"
      :aria-label="`删除组织 ${deleteTarget.name}`"
    >
      <header class="dialog__head">
        <h3>删除组织</h3>
        <button type="button" class="btn btn--text" @click="closeDelete">
          ✕
        </button>
      </header>
      <div class="dialog__body">
        <p>
          确认删除组织 <strong>{{ deleteTarget.name }}</strong
          >？此操作不可撤销。
        </p>
        <!-- E11 前端预检阻断：弹窗列下属组织数/关联用户数、确认置灰 -->
        <p v-if="deleteBlocked" class="delete-blocked" role="alert">
          {{ deleteBlockedText }}
        </p>
        <!-- eiam 后置拒绝（兜底，Phase-0-contingent） -->
        <p v-if="deleteRejectMsg" class="delete-blocked" role="alert">
          {{ deleteRejectMsg }}
        </p>
      </div>
      <div class="dialog__actions">
        <button
          type="button"
          class="btn btn--ghost"
          data-dialog-cancel
          @click="closeDelete"
        >
          取消
        </button>
        <button
          type="button"
          class="btn btn--danger"
          :disabled="deleteLoading || !!deleteBlocked"
          data-testid="delete-org-confirm"
          @click="confirmDelete"
        >
          {{ deleteLoading ? "删除中…" : "确认删除" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "../styles/shared";
@use "../styles/form";
@use "../styles/dialog";
</style>
