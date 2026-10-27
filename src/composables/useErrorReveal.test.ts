// @vitest-environment happy-dom
// useErrorReveal 契约测试：
// - 错误文案从空变非空时，把错误节点滚入视口并聚焦
// - 空文案不触发（不打扰用户）
// - 目标节点缺失时不抛错
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { useErrorReveal } from './useErrorReveal'

function mountHarness(initial = '') {
  const error = ref(initial)
  const target = ref<HTMLElement | null>(null)
  const scrollSpy = vi.fn()

  const Comp = defineComponent({
    setup() {
      useErrorReveal(error, target)
      return () =>
        h('div', [
          error.value
            ? h(
                'p',
                {
                  id: 'err',
                  ref: target,
                  tabindex: -1,
                  role: 'alert',
                  // happy-dom 不实现布局，这里替换成可观测的 spy
                  scrollIntoView: scrollSpy,
                },
                error.value,
              )
            : null,
        ])
    },
  })

  const wrapper = mount(Comp, { attachTo: document.body })
  return { wrapper, error, scrollSpy }
}

describe('useErrorReveal', () => {
  it('错误出现时滚入视口并聚焦', async () => {
    const { wrapper, error, scrollSpy } = mountHarness()
    expect(scrollSpy).not.toHaveBeenCalled()

    error.value = '保存失败'
    await nextTick()
    await nextTick()

    expect(scrollSpy).toHaveBeenCalled()
    expect(document.activeElement?.id).toBe('err')
    wrapper.unmount()
  })

  it('空文案不触发滚动/聚焦', async () => {
    const { wrapper, error, scrollSpy } = mountHarness()
    error.value = ''
    await nextTick()
    expect(scrollSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('错误再次出现时会再次滚入（连续两次失败都要被看见）', async () => {
    const { wrapper, error, scrollSpy } = mountHarness()
    error.value = '第一次失败'
    await nextTick()
    await nextTick()
    const first = scrollSpy.mock.calls.length
    expect(first).toBeGreaterThan(0)

    error.value = ''
    await nextTick()
    error.value = '第二次失败'
    await nextTick()
    await nextTick()
    expect(scrollSpy.mock.calls.length).toBeGreaterThan(first)
    wrapper.unmount()
  })
})
