// @vitest-environment happy-dom
// 应用装配冒烟（2.2）：main.ts 须以「persistedstate 插件 + theme store 恢复」接线，
// 并引入两份主题样式（拷贝自 e-cam-web）。动态 import 执行装配副作用，
// sass 编译失败 / persist 装配缺失会在此暴露。
import { describe, expect, it } from 'vitest'

describe('main 装配（2.2 主题接线）', () => {
  it('装配完成：默认深色（html 无 light class），无持久化选择时不写入 hc_theme', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    localStorage.clear()
    document.documentElement.className = ''

    await import('./main')

    expect(document.querySelector('#app')).not.toBeNull()
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(localStorage.getItem('hc_theme')).toBeNull()
    // 显式放宽超时：本用例动态 import('./main') 执行真实装配副作用（挂载 Vue 应用、注入两份主题样式），
    // 在**全量套件并行**环境下实测约 4.3–5s，贴着 vitest 默认 5s 上限 → 偶发超时（单跑恒通过）。
    // 放宽超时只消除抖动，不改任何断言语义。
  }, 20000)
})

