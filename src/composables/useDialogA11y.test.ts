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

  /**
   * 背景隔离：焦点陷阱只解决 Tab，管不住读屏虚拟光标。
   * 实测弹窗打开时背景仍有 35 个可聚焦元素能被脚本聚焦，读屏可「读穿」弹窗。
   */
  it('打开后把弹窗外节点标记为 inert + aria-hidden', async () => {
    // 额外放一个「背景」节点，模拟页面主体
    const background = document.createElement('main')
    background.id = 'bg'
    background.innerHTML = '<button id="bg-btn">bg</button>'
    document.body.appendChild(background)

    const { wrapper } = mountDialog()
    const trigger = document.getElementById('trigger') as HTMLElement
    trigger.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()

    // 背景节点被隔离
    expect(background.hasAttribute('inert')).toBe(true)
    expect(background.getAttribute('aria-hidden')).toBe('true')
    // 弹窗自身不受影响
    const dlg = document.getElementById('dlg') as HTMLElement
    expect(dlg.hasAttribute('inert')).toBe(false)
    expect(dlg.hasAttribute('aria-hidden')).toBe(false)

    pressKey('Escape')
    await nextTick()
    await nextTick()

    // 关闭后完全还原
    expect(background.hasAttribute('inert')).toBe(false)
    expect(background.hasAttribute('aria-hidden')).toBe(false)

    background.remove()
    wrapper.unmount()
  })

  it('关闭后还原时保留节点原有的 aria-hidden 值', async () => {
    const background = document.createElement('main')
    background.id = 'bg'
    // 原本就带 aria-hidden 的节点（例如装饰层），关闭后不能被清成无属性
    background.setAttribute('aria-hidden', 'false')
    document.body.appendChild(background)

    const { wrapper } = mountDialog()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()
    expect(background.getAttribute('aria-hidden')).toBe('true')

    pressKey('Escape')
    await nextTick()
    await nextTick()

    expect(background.hasAttribute('inert')).toBe(false)
    expect(background.getAttribute('aria-hidden')).toBe('false')

    background.remove()
    wrapper.unmount()
  })

  /**
   * 触发元素消失时的兜底（R10）。
   * 实测：删除成功后整行被移除，原「删除」按钮 isConnected=false，
   * 焦点落回 <body>，按 Tab 也停在 body —— 键盘用户彻底失去位置。
   */
  it('触发元素已被移除时，焦点落到兜底落点而非 body', async () => {
    const heading = document.createElement('h2')
    heading.className = 'page-title'
    heading.textContent = '用户管理'
    document.body.appendChild(heading)

    const { wrapper } = mountDialog()
    const trigger = document.getElementById('trigger') as HTMLElement
    trigger.focus()
    await wrapper.find('#trigger').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.activeElement?.id).toBe('field')

    // 模拟「删除成功后整行消失」：把触发按钮从 DOM 移除
    trigger.remove()

    pressKey('Escape')
    await nextTick()
    await nextTick()

    expect(document.activeElement).not.toBe(document.body)
    expect(document.activeElement).toBe(heading)
    // 兜底落点需补 tabindex=-1 才能被聚焦
    expect(heading.getAttribute('tabindex')).toBe('-1')

    heading.remove()
    wrapper.unmount()
  })

  it('可用 fallbackFocus 覆盖兜底落点', async () => {
    const custom = document.createElement('div')
    custom.id = 'custom-fallback'
    custom.textContent = '列表区'
    document.body.appendChild(custom)

    const onClose = vi.fn()
    const Comp = defineComponent({
      setup() {
        const open = ref(false)
        const dialogRef = ref<HTMLElement | null>(null)
        useDialogA11y(dialogRef, {
          open,
          fallbackFocus: '#custom-fallback',
          onClose: () => {
            onClose()
            open.value = false
          },
        })
        return () =>
          h('div', [
            h('button', { id: 't2', onClick: () => (open.value = true) }, 'open'),
            open.value
              ? h('div', { id: 'dlg2', ref: dialogRef, role: 'dialog', 'aria-modal': 'true' }, [
                  h('input', { id: 'f2' }),
                ])
              : null,
          ])
      },
    })
    const wrapper = mount(Comp, { attachTo: document.body })
    const t2 = document.getElementById('t2') as HTMLElement
    t2.focus()
    await wrapper.find('#t2').trigger('click')
    await nextTick()
    await nextTick()

    t2.remove()
    pressKey('Escape')
    await nextTick()
    await nextTick()

    expect(document.activeElement).toBe(custom)

    custom.remove()
    wrapper.unmount()
  })

  /**
   * 弹窗栈（R11）：两个弹窗并存时，Esc 必须关最上层，且底层关闭不能解除上层仍需要的隔离。
   * 实测修复前：Esc 关掉的是底层「先注册」的弹窗，且 inert 被清成 0。
   */
  it('两个弹窗并存时，Esc 只关最上层；隔离归属栈顶', async () => {
    const background = document.createElement('main')
    background.id = 'bg'
    document.body.appendChild(background)

    const closed: string[] = []

    /** 独立挂一个弹窗组件（与真实页面一致：每个弹窗各自 useDialogA11y） */
    const mountOne = (id: string) => {
      const Comp = defineComponent({
        setup() {
          const open = ref(false)
          const dialogRef = ref<HTMLElement | null>(null)
          useDialogA11y(dialogRef, {
            open,
            onClose: () => {
              closed.push(id)
              open.value = false
            },
          })
          return { open, dialogRef }
        },
        render() {
          return h('div', [
            h('button', { id: `open-${id}`, onClick: () => (this.open = true) }, `open-${id}`),
            this.open
              ? h(
                  'div',
                  { id: `dlg-${id}`, ref: 'dialogRef', role: 'dialog', 'aria-modal': 'true' },
                  [h('input', { id: `field-${id}` })],
                )
              : null,
          ])
        },
      })
      return mount(Comp, { attachTo: document.body })
    }

    const wA = mountOne('a')
    const wB = mountOne('b')

    await wA.find('#open-a').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.getElementById('dlg-a')).not.toBeNull()
    expect(background.hasAttribute('inert')).toBe(true)

    // 再开第二个（模拟「新增弹窗开着时删除确认又打开」的并存态）
    await wB.find('#open-b').trigger('click')
    await nextTick()
    await nextTick()
    expect(document.getElementById('dlg-b')).not.toBeNull()

    // 第一次 Esc：只关最上层 b
    pressKey('Escape')
    await nextTick()
    await nextTick()
    expect(closed).toEqual(['b'])
    expect(document.getElementById('dlg-b')).toBeNull()
    expect(document.getElementById('dlg-a')).not.toBeNull()
    // a 仍在 → 背景必须继续隔离（修复前此处 inert 被清成 0）
    expect(background.hasAttribute('inert')).toBe(true)

    // 第二次 Esc：关 a
    pressKey('Escape')
    await nextTick()
    await nextTick()
    expect(closed).toEqual(['b', 'a'])
    expect(background.hasAttribute('inert')).toBe(false)

    background.remove()
    wA.unmount()
    wB.unmount()
  })
})
