/**
 * `.sr-only` 去重守卫（iter362）
 *
 * 背景：这段 9 行标准隐藏样式在本仓被**逐字复制了 11 次**（分布 11 个页面组件）。
 * 更值得记的是 —— 其中几处的注释**自己就写着**「与 users/UserList.vue、
 * organizations/OrgList.vue 的 .sr-only 逐字一致」：**重复是被明知故犯地记录下来的，
 * 但没人去合并**。
 *
 * 而且已经开始漂移了：`AuthorizationList.vue` 那份写的是 `clip: rect(0, 0, 0, 0)`（带逗号），
 * 其余 10 份写的是 `clip: rect(0 0 0 0)`（不带逗号）。语义等价，但**这正是副本会走向不一致的
 * 第一个证据** —— 如果再多放几轮，迟早会出现真正不同的实现。
 *
 * 现在统一定义在 `src/assets/styles/utilities.scss`，由 `main.ts` 全局引入。
 *
 * 本守卫锁两件事：
 *   ① 页面组件里**不得再出现** `.sr-only { ... }` 定义（要用就用全局的）；
 *   ② 全局定义**必须存在**（否则删了定义、页面静默失去隐藏效果，视觉上能看到一堆辅助文本）。
 *
 * 第二条是防「守卫被绕过」：如果只断言「页面里没有定义」，那**把所有定义连同全局一起删掉**
 * 也能全绿 —— 但那时 `.sr-only` 就彻底失效了。（同 S198：守卫只保证「没有违规」，
 * 自我对照才保证「守卫还在工作」。）
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** 所有页面组件源码（?raw，不做编译） */
const views = import.meta.glob('../../**/*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * 全局样式源码。
 *
 * **必须用 `fs.readFileSync` 而不是 `import.meta.glob(..., { query: '?raw' })`**：
 * 实测（iter362）vitest 把 `.scss` 交给 CSS 插件处理，`?raw` 读出来的**每一个 scss 都是空字符串**
 * —— 连既有的 `theme-variables.scss` 也是 0 长度。
 * 若用 glob 版本，本守卫会**永远报「找不到定义」**（假红），或者反过来在别处永远通过（假绿）。
 * 这正是 S197「零命中必须先过阳性对照」要防的情况：**读不到 ≠ 不存在。**
 */
function readGlobalStyles(): Record<string, string> {
  const dir = path.resolve(process.cwd(), 'src/assets/styles')
  const out: Record<string, string> = {}
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.scss')) out[name] = fs.readFileSync(path.join(dir, name), 'utf8')
  }
  return out
}

const globalStyles = readGlobalStyles()

describe('.sr-only 去重守卫（iter362）', () => {
  it('页面组件里不得再定义 .sr-only（应使用全局 utilities.scss）', () => {
    const offenders: string[] = []

    for (const [path, src] of Object.entries(views)) {
      if (/\.(test|spec)\./.test(path)) continue
      src.split('\n').forEach((line, i) => {
        // 命中形如 `.sr-only {` 的**定义**行（不是使用、不是注释）
        if (/^\s*\.sr-only\s*\{/.test(line)) {
          const rel = path.replace(/^.*?\.\.\/\.\.\//, '')
          offenders.push(`${rel}:${i + 1}`)
        }
      })
    }

    expect(
      offenders,
      '页面组件里出现了 .sr-only 定义。\n' +
        '请删掉局部定义，改用全局 `src/assets/styles/utilities.scss` 里的同名类：\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('全局定义必须存在（防止「定义与用法的副本一起被删」）', () => {
    const allGlobal = Object.values(globalStyles).join('\n')

    // ① 定义存在
    expect(
      /\.sr-only\s*\{/.test(allGlobal),
      '全局样式里找不到 .sr-only 定义 —— 页面仍在使用 class="sr-only"，' +
        '若定义缺失，这些「仅供读屏」的文本会直接显示在界面上。',
    ).toBe(true)

    // ② 关键属性齐全（缺一个就会导致「看得见」或「读屏读不到」）
    const block = allGlobal.match(/\.sr-only\s*\{([^}]*)\}/)?.[1] ?? ''
    const required = ['position', 'width', 'height', 'overflow', 'clip', 'border']
    const missing = required.filter((prop) => !new RegExp(`(^|[\\s;])${prop}\\s*:`).test(block))
    expect(
      missing,
      '.sr-only 定义缺少关键属性（少一个就会出现「视觉可见」或「读屏读不到」）：' + missing.join(', '),
    ).toEqual([])
  })

  it('页面里仍在使用的 .sr-only 都有全局定义兜底（用法与定义对得上）', () => {
    const usedInViews = Object.entries(views)
      .filter(([path]) => !/\.(test|spec)\./.test(path))
      .some(([, src]) => /class="[^"]*\bsr-only\b[^"]*"/.test(src))

    const definedGlobally = /\.sr-only\s*\{/.test(Object.values(globalStyles).join('\n'))

    // 要么没人用（也允许），要么有人在用 → 必须有全局定义
    if (usedInViews) {
      expect(definedGlobally, '页面在用 .sr-only 但全局没有定义').toBe(true)
    } else {
      expect(true).toBe(true)
    }
  })
})
