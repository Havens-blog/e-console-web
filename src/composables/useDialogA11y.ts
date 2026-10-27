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
  // 背景隔离的还原函数（关闭弹窗时调用；无背景可隔离时为 null）
  let releaseBackground: (() => void) | null = null

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
        releaseBackground = dialogRef.value ? isolateBackground(dialogRef.value) : null
        focusInitial()
      } else {
        document.removeEventListener('keydown', onKeydown, true)
        // 先把归还目标取出来并清空：await 之后若又打开了新弹窗，
        // 不能把焦点从新弹窗抢回上一个触发按钮（关→立刻重开的竞态）。
        const target = restoreTarget
        restoreTarget = null
        await nextTick()
        if (options.open.value) return
        releaseBackground?.()
        releaseBackground = null
        if (target && target.isConnected) target.focus()
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown, true)
    releaseBackground?.()
    releaseBackground = null
  })
}

/**
 * 背景隔离：弹窗打开时，把「弹窗所在链路之外的兄弟节点」标记为 inert + aria-hidden。
 *
 * 为什么需要：焦点陷阱只解决 Tab 键，管不住读屏虚拟光标。实测弹窗打开时
 * 背景仍有 35 个可聚焦元素能被脚本聚焦（activeElement 一度落在侧栏 logo 上），
 * 读屏用户可以「读穿」弹窗继续浏览后面的页面。
 *
 * 为什么沿祖先链逐层标记：弹窗可能渲染在组件树任意层级（也可能被 Teleport 到 body）。
 * 只标记 body 的直接子节点会漏；把祖先链一起标记又会隔离掉弹窗自身。
 * 逐层「跳过自己在链上的那个子节点、标记其余兄弟」可同时覆盖两种情况且不误伤。
 *
 * 返回还原函数：关闭时按原值恢复（原本就有 aria-hidden 的保留其原值），
 * 且跳过已被他人标记 inert 的节点，避免解除别人的隔离。
 */
function isolateBackground(root: HTMLElement): (() => void) | null {
  if (!root.isConnected) return null
  const changed: Array<{ el: HTMLElement; prevAria: string | null }> = []

  let node: HTMLElement | null = root
  while (node && node !== document.body && node.parentElement) {
    const parent: HTMLElement = node.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node) continue
      if (!(sibling instanceof HTMLElement)) continue
      // 已是 inert 的不接管，避免关闭时把别人的隔离解除掉
      if (sibling.hasAttribute('inert')) continue
      changed.push({ el: sibling, prevAria: sibling.getAttribute('aria-hidden') })
      sibling.setAttribute('inert', '')
      sibling.setAttribute('aria-hidden', 'true')
    }
    node = parent
  }

  if (changed.length === 0) return null
  return () => {
    for (const { el, prevAria } of changed) {
      el.removeAttribute('inert')
      if (prevAria === null) el.removeAttribute('aria-hidden')
      else el.setAttribute('aria-hidden', prevAria)
    }
  }
}
