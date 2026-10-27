import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * 自建弹窗的键盘与焦点可访问性（UF 通用）。
 *
 * 背景：控制台 11 处弹窗此前都是「遮罩 + 卡片 + @click.self 关闭」的手写形态，
 * 一致缺失三件事，且每处各写一遍：
 *   ① Escape 无法关闭 —— 只有 ✕ / 取消 / 点遮罩能关，键盘用户被卡住；
 *   ② 打开后焦点不进入弹窗 —— 首焦点仍在触发按钮上，键盘需 Tab 数次才进得来，
 *      读屏器也不会播报弹窗内容（未声明 aria-modal）；
 *   ③ Tab 会走出弹窗落到背景页 —— 背景被遮罩盖住却仍可聚焦，属"焦点逃逸"。
 * 本 composable 把这三件事收敛为一份实现，各弹窗只声明「开关 ref + 关闭函数」。
 *
 * 用法：
 *   const dialogRef = ref<HTMLElement | null>(null)
 *   useDialogA11y(dialogRef, { open: showCreate, onClose: closeCreate })
 *   <div ref="dialogRef" class="dialog" role="dialog" aria-modal="true" ...>
 *
 * 行为约定：
 * - 打开：记住触发元素 → 把焦点放到弹窗内首个输入控件（无输入则首个可聚焦元素）；
 * - 打开期间：捕获阶段监听 keydown，Escape 关闭、Tab/Shift+Tab 在弹窗内循环；
 * - 关闭：把焦点归还触发元素（若该元素已从 DOM 移除则跳过，避免焦点丢失到 body）。
 * 不改变点击遮罩关闭、✕ / 取消关闭等既有路径，也不接管页面滚动。
 */

/** 可聚焦元素选择器（排除 disabled 与 tabindex="-1"） */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** 首选初始焦点：表单类弹窗应直接落在第一个输入项，而非右上角 ✕ */
const PREFERRED_SELECTOR = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'

export interface DialogA11yOptions {
  /** 弹窗开关（普通 ref 或 computed 均可） */
  open: Readonly<Ref<boolean>>
  /** 关闭回调：由调用方复用其既有关闭函数（保证与 ✕ / 取消 同一路径） */
  onClose: () => void
  /** 覆盖初始焦点选择器（默认首个输入控件） */
  initialFocus?: string
}

export function useDialogA11y(
  dialogRef: Ref<HTMLElement | null>,
  options: DialogA11yOptions,
): void {
  /** 打开前的焦点元素，关闭时归还 */
  let restoreTarget: HTMLElement | null = null

  function focusables(): HTMLElement[] {
    const root = dialogRef.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
  }

  function focusInitial(): void {
    const root = dialogRef.value
    if (!root) return
    const preferred = options.initialFocus
      ? root.querySelector<HTMLElement>(options.initialFocus)
      : root.querySelector<HTMLElement>(PREFERRED_SELECTOR)
    focusEl(preferred ?? focusables()[0] ?? root)
  }

  /** 让任意元素可聚焦并聚焦（容器本身没有 tabindex 时补一个，避免 focus() 静默失效） */
  function focusEl(el: HTMLElement): void {
    if (!el.hasAttribute('tabindex') && el === dialogRef.value) {
      el.setAttribute('tabindex', '-1')
    }
    el.focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!options.open.value) return
    const root = dialogRef.value
    if (!root) return

    if (event.key === 'Escape') {
      // 弹窗内若有「展开中的浮层」（Element Plus el-select / 下拉等以 aria-expanded=true
      // 标记），首次 Esc 只应收起该浮层，不能连带把整个弹窗关掉——否则用户输入的表单
      // 内容会凭空丢失。此处直接放行，交给浮层自己的 Esc 处理。
      const target = event.target as HTMLElement | null
      if (target?.closest?.('[aria-expanded="true"]')) return
      // 已被其它组件（如命令面板在 window 捕获阶段）处理过的 Esc 不再重复关窗
      if (event.defaultPrevented) return
      // 捕获阶段拦截：避免同一次 Esc 既关闭弹窗又被页面其他监听消费
      event.preventDefault()
      event.stopPropagation()
      options.onClose()
      return
    }

    if (event.key !== 'Tab') return

    const items = focusables()
    if (items.length === 0) {
      // 无可聚焦元素时把焦点留在弹窗容器上，不落回背景
      event.preventDefault()
      focusEl(root)
      return
    }

    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement as HTMLElement | null
    const inside = active !== null && root.contains(active)

    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault()
      first.focus()
    }
  }

  watch(
    options.open,
    async (open) => {
      if (open) {
        restoreTarget = document.activeElement as HTMLElement | null
        document.addEventListener('keydown', onKeydown, true)
        // 等 v-if 真正渲染出弹窗节点再取焦点目标
        await nextTick()
        focusInitial()
      } else {
        document.removeEventListener('keydown', onKeydown, true)
        // 先把归还目标取出来并清空：await 之后若又打开了新弹窗，
        // 不能把焦点从新弹窗抢回上一个触发按钮（关→立刻重开的竞态）。
        const target = restoreTarget
        restoreTarget = null
        await nextTick()
        if (options.open.value) return
        if (target && target.isConnected) target.focus()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
  })
}
