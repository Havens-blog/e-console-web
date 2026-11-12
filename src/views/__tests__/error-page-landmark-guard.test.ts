/**
 * 错误页 landmark 守卫（iter364）
 *
 * 背景：这条「404 页缺 `<main>`」我在 BACKLOG 里记了**好几轮**，而且记的内容是错的
 * —— 我写的是「cmdb 和 CAM 有，console 没有」。本轮实测纠正：
 *
 * | 站 | 404 的 mainCount | 为什么 |
 * | --- | --- | --- |
 * | console | **0**（用 `<section>`）| 顶层路由，**不套 MainLayout** → 真缺口 |
 * | CAM | **1**（`<main class="error-page">`）| 顶层路由，**早就对了** |
 * | cmdb | **1**（`<main class="app-main">`，来自 AppShell）| **渲染在 AppShell 里**，外壳已有 main |
 *
 * **关键洞察：404 该不该有 `<main>`，取决于它套不套外壳。**
 *   · 不套外壳（console / CAM）→ 必须自带一个，否则全页零 landmark，读屏用户无法「跳到主内容」；
 *   · 套外壳（cmdb）→ **不能**加，加了就是 `<main>` 嵌套，HTML 规范禁止。
 *
 * 本仓 `views/organizations/OrgList.vue` 的注释就记录过这个坑：
 * 「这里原先是 `<main>`，但外壳 MainLayout 已有 `<main class="layout-content">`，
 * 而 HTML 规范禁止 `<main>` 嵌套（实测本页 mainCount=2、nested=1）」。
 *
 * 所以守卫锁两件事：
 *   ① 外壳之外的页面（错误页）**必须有** `<main>`；
 *   ② 外壳之内的页面**不得**再有 `<main>`（防嵌套）。
 *
 * ② 是防「守卫被绕过」的另一半：若只断言「错误页有 main」，有人可能顺手给
 * 套外壳的页面也加一个 —— 用例照样绿，但页面变成嵌套 main。**两个方向都要封。**
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../../**/*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** 外壳之外的整页（不套 MainLayout，需自带 main landmark） */
const SHELL_LESS_PAGES = [
  'error/NotFound.vue',
  'error/Forbidden.vue',
] as const

/**
 * 按**路径段**取文件。
 *
 * **不能用 `endsWith`**：`import.meta.glob` 的 key 前缀**不统一** ——
 * 同样是 views 下的文件，有的是 `../error/NotFound.vue`（相对 `src/views/__tests__/`），
 * 有的（如 App.vue）是 `../../App.vue`。所以 `endsWith('views/error/NotFound.vue')` 永远匹配不到。
 * 实测（iter364 阳性对照）：46 个 key 里，错误页是 `../error/NotFound.vue`、`../error/Forbidden.vue`，
 * 外壳是 `../../layouts/MainLayout.vue`。
 */
function get(pathFragment: string): { rel: string; src: string } | null {
  // pathFragment 形如 'error/NotFound.vue' 或 'layouts/MainLayout.vue'
  const segs = pathFragment.replace(/^views\//, '').split('/')
  for (const [p, src] of Object.entries(sources)) {
    const norm = p.replace(/^\.\.\/\.\.\//, '').replace(/^\.\.\//, '')
    if (norm === segs.join('/') || norm.endsWith('/' + segs.join('/'))) {
      return { rel: norm, src }
    }
  }
  return null
}

/**
 * 模板部分，且**已剥离 HTML 注释**。
 *
 * 为什么必须剥离：iter364 做 RED 验证时踩到 —— 我在根元素上方写了一段注释解释
 * 「根元素是 <main> 而不是 <section>」，结果守卫的 `/<main[\s>]/` 匹到了**注释里的文字**，
 * 于是「把真实标签改回 <section>」后用例**依然通过**（假绿）。
 * **注释里提到一个标签名，不等于那个标签存在。**（同 S201：读不到/读到假象都要分开证明。）
 */
function templateOf(src: string): string {
  const s = src.indexOf('<template>')
  const e = src.lastIndexOf('</template>')
  if (s < 0 || e <= s) return ''
  return src.slice(s, e).replace(/<!--[\s\S]*?-->/g, '')
}

describe('错误页 landmark 守卫（iter364）', () => {
  it('外壳之外的错误页必须自带 <main>（否则全页零 landmark）', () => {
    const offenders: string[] = []

    for (const pathFragment of SHELL_LESS_PAGES) {
      const page = get(pathFragment)
      if (!page) { offenders.push(pathFragment + '（文件不存在）'); continue }
      const tpl = templateOf(page.src)
      if (!/<main[\s>]/.test(tpl)) {
        offenders.push(page.rel + '（无 <main>，当前根元素是 ' + (tpl.match(/<(section|div)\s+class="([^"]+)"/)?.[2] ?? '?') + '）')
      }
    }

    expect(
      offenders,
      '以下「不套外壳」的整页缺少 <main> landmark —— 读屏用户无法用「跳到主内容」绕过内容块：\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('错误页的 <main> 必须保留原有 ARIA 属性（role/live/labelledby）', () => {
    const offenders: string[] = []

    for (const pathFragment of SHELL_LESS_PAGES) {
      const page = get(pathFragment)
      if (!page) continue
      const tpl = templateOf(page.src)
      // 只匹配**真实的标签行**（行首缩进 + <main + 至少一个属性），排除注释里提到的裸 `<main>`：
      const m = tpl.match(/^\s*<main\s+[^>]*>/m)
      if (!m) continue
      const tag = m[0]
      for (const attr of ['role="alert"', 'aria-live="polite"', 'aria-labelledby=']) {
        if (!tag.includes(attr)) offenders.push(page.rel + ' 缺 ' + attr)
      }
    }

    expect(
      offenders,
      '改成 <main> 时把原有 ARIA 属性丢了（会退化成无播报的静态页）：\n  ' + offenders.join('\n  '),
    ).toEqual([])
  })

  it('套外壳的页面不得自带 <main>（防嵌套，HTML 规范禁止）', () => {
    // 本仓主内容区由 layouts/MainLayout.vue 提供唯一 <main>
    const layout = get('layouts/MainLayout.vue')
    expect(
      layout && /<main[\s>]/.test(templateOf(layout.src)),
      'MainLayout.vue 里找不到 <main> —— 若外壳不再提供 main，则上面两条的前提失效，需重新评估本守卫。',
    ).toBe(true)

    // 页面级（不含 error/，那两页是外壳之外的）不应再有 <main>：
    // 它们都渲染在 MainLayout 的 <router-view> 里。
    //
    // **不能靠 key 里是否含 "/views/" 来筛**：glob key 前缀不统一
    // （`../users/UserList.vue` vs `../../App.vue`），含 "/views/" 的一个都没有。
    // 改用「排除法」：排掉 App.vue / components/ / layouts/ / error/。
    const offenders: string[] = []
    for (const [p, src] of Object.entries(sources)) {
      if (/\.(test|spec)\./.test(p)) continue
      const norm = p.replace(/^\.\.\/\.\.\//, '').replace(/^\.\.\//, '')
      if (/^(App\.vue|components\/|layouts\/|error\/)/.test(norm)) continue
      if (/<main[\s>]/.test(templateOf(src))) offenders.push(norm)
    }

    expect(
      offenders,
      '这些页面渲染在 MainLayout 内部（外壳已有 <main>），自带 <main> 会造成嵌套：\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })
})
