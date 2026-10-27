// @vitest-environment happy-dom
// useDialogA11y 契约测试：
// - Escape 关闭（仅在打开时；关闭态不误触发）
// - 打开后焦点进入弹窗首个输入控件（而不是留在触发按钮 / 右上角 ✕）
// - Tab / Shift+Tab 在弹窗内循环，不逃逸到背景页
// - 关闭后焦点归还触发元素（元素已移除时不报错）
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDialogA11y } from './useDialogA11y'

function pressKey(key: string, init: KeyboardEventInit = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
  )
}

/** 挂一个最小弹窗：触发按钮 + (v-if) 弹窗（input + button + ✕ 式关闭按钮） */
function mountDialog() {
  const onClose = vi.fn()
  const Comp = defineComponent({
    setup() {
      const open = ref(false)
      const dialogRef = ref<HTMLElement | null>(null)
      useDialogA11y(dialogRef, {
        open,
        onClose: () => {
          onClose()
          open.value = false
        },
      })
      return () =>
        h('div', [
          h(
            'button',
            { id: 'trigger', onClick: () => (open.value = true) },
            'open',
          ),
          open.value
            ? h(
                'div',
                { id: 'dlg', ref: dialogRef, role: 'dialog', 'aria-modal': 'true' },
                [
                  h('input', { id: 'field' }),
                  h('button', { id: 'cancel', onClick: () => (open.value = false) }, '取消'),
                ],
              )
            : null,
        ])
    },
  })
  const wrapper = mount(Comp, { attachTo: document.body })
  return { wrapper, onClose }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useDialogA11y', () => {
  it('打开后 Escape 关闭弹窗（捕获阶段生效）', async () => {
    const { wrapper, onClose } = mountDialog()
    document.getElementById('trigger')!.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.getElementById('dlg')).not.toBeNull()

    pressKey('Escape')
    await nextTick()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.getElementById('dlg')).toBeNull()
    wrapper.unmount()
  })

  it('关闭态下 Escape 不触发关闭回调（不误触发）', () => {
    const { wrapper, onClose } = mountDialog()
    pressKey('Escape')
    expect(onClose).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('打开后焦点进入首个输入控件', async () => {
    const { wrapper } = mountDialog()
    document.getElementById('trigger')!.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()

    expect(document.activeElement?.id).toBe('field')
    wrapper.unmount()
  })

  it('Tab 在弹窗内循环，不逃逸到背景页', async () => {
    const { wrapper } = mountDialog()
    document.getElementById('trigger')!.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()

    // 落在最后一个可聚焦元素上再 Tab → 回到第一个
    document.getElementById('cancel')!.focus()
    pressKey('Tab')
    expect(document.activeElement?.id).toBe('field')

    // Shift+Tab 从第一个 → 回到最后一个
    pressKey('Tab', { shiftKey: true })
    expect(document.activeElement?.id).toBe('cancel')

    wrapper.unmount()
  })

  it('关闭后焦点归还触发元素', async () => {
    const { wrapper } = mountDialog()
    const trigger = document.getElementById('trigger') as HTMLElement
    trigger.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('field')

    pressKey('Escape')
    await nextTick()
    await nextTick()

    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })
})
