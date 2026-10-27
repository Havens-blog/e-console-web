import { nextTick, watch, type Ref } from 'vue'

/**
 * 让「提交失败提示」真正被用户看见（UF 通用）。
 *
 * 背景：详情页把保存错误渲染在表单顶部（`.form-error`），而提交按钮在页面底部/页头。
 * 用户在窄屏或长表单滚到底后点保存，失败提示出现在视口之外，且没有 toast、没有焦点迁移——
 * 于是「保存失败」和「没反应」无法区分。审计实测：390×844 滚到底提交时，
 * 错误提示的 getBoundingClientRect().top 为 -369 / -110（完全在视口外），
 * 焦点停在 BODY，按钮复位成「保存」。
 *
 * 本 composable 把「错误出现 → 滚入视口 → 聚焦」收敛成一处：
 * - watch 错误文案，非空时等一次 nextTick（v-if 渲染完成）；
 * - smooth 滚到可视区中部（不支持 smooth 的环境退化为瞬时滚动）；
 * - 聚焦错误节点（需在模板上给该节点 tabindex="-1"），键盘/读屏用户下一次 Tab 从提示处继续；
 * - 不改变任何提交逻辑，也不吞掉原有 role="alert" 的播报。
 */
export function useErrorReveal(
  error: Readonly<Ref<string>>,
  target: Ref<HTMLElement | null>,
): void {
  watch(error, async (message) => {
    if (!message) return
    await nextTick()
    const el = target.value
    if (!el) return
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch {
      // 老环境或测试环境（happy-dom）没有 scrollIntoView 选项支持：退回普通滚动
      el.scrollIntoView?.()
    }
    el.focus({ preventScroll: true })
  })
}
