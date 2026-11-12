/**
 * 行内操作按钮「可访问名含行标识」守卫（iter372）
 *
 * 背景：表格的操作列常常是「每行一组、可见文本相同的短按钮」（编辑 / 删除 / 移除 / 解绑…）。
 * 读屏用户按 Tab 遍历时听到的是连续的「编辑 按钮」「编辑 按钮」「编辑 按钮」，
 * **无法知道当前这个按钮作用在哪一行** —— 属 WCAG 2.4.6（标题和标签）、2.5.3（标签包含名称）取向。
 *
 * 修法：给行内按钮加 `:aria-label`，把行标识拼进去（可见文本保持不变）。
 * 本仓既有范式见 `identity-sources/IdpList.vue:403`：
 *
 *     <!-- 行内按钮带行标识的可访问名：否则读屏只会连续念「编辑 按钮」「删除 按钮」 -->
 *     <button :aria-label="`编辑身份源 ${src.name}`">编辑</button>
 *
 * ── 判据为什么用 `data-testid` 而不是「短词文本」 ──
 * 我第一版按可见文本白名单（详情/编辑/删除/重置…）匹配，两个问题：
 *   ① **误报**：「重置」在多个页面的**注释里**出现，被当成按钮文本（未剥离 HTML 注释）；
 *   ② **漏报**：白名单外的「策略」「角色」「撤回」「通过」「拒绝」全都没被扫到。
 * 改用 `<td>` 内 + 有 `data-testid` 的按钮作为判据（`data-testid` 是明确的行内操作按钮标记），
 * 命中数从 9 涨到 15 —— **白名单判据漏了 6 个**。
 *
 * ── 已知未覆盖（本守卫的边界，写清楚而不是假装全覆盖）──
 *   ① 没有 `data-testid` 的行内按钮不会被检查（本仓新页面约定要加 testid，故可接受）；
 *   ② 只检查「有没有 aria-label」，**不检查它是否真的含行标识**（那需要知道每行的数据字段名，
 *      静态分析做不到；用组件测试逐个断言更可靠，参见 `tenants/TenantList.aria.test.ts`）。
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('../../**/*.vue', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * **已知待补的遗留清单**。
 *
 * 刻意逐条列出（而不是整体豁免），这样每修一个就必须删一行 ——
 * 与 `live-announcement-guard` 的 KNOWN_GAPS 同一手法：**清单只会变短，不会被忘记**。
 *
 * iter372 修了 GroupList（5 个）与 PolicyList（2 个）；**iter373 补齐剩余 8 个，清单已清空**。
 */
const KNOWN_GAPS: readonly string[] = [
  // iter373：本轮把所有剩余项都修了，清单清空。
  // 保留这个空数组是有意的 —— 守卫的第二条用例会在「清单里有条目但已修好」时报错，
  // 将来若发现新的豁免，加到这里即可；**清单只应变短，不应重新变长**。
]

/** 提取模板并剥离 HTML 注释 */
function templateOf(src: string): string {
  const t0 = src.indexOf('<template>')
  const t1 = src.lastIndexOf('</template>')
  if (t0 < 0 || t1 <= t0) return ''
  return src.slice(t0, t1).replace(/<!--[\s\S]*?-->/g, '')
}

/** 找出「在 <td> 内、带 data-testid、但没有 aria-label」的按钮 */
function findUnlabeledInlineButtons(tpl: string): string[] {
  const out: string[] = []
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g
  let m: RegExpExecArray | null
  while ((m = btnRe.exec(tpl))) {
    const attrs = m[1] ?? ''
    if (!/data-testid=/.test(attrs)) continue
    if (/aria-label/.test(attrs)) continue
    // 必须在 <td> 内：按钮之前最近的 <td 比最近的 </td> 更近
    const before = tpl.slice(0, m.index)
    const open = before.lastIndexOf('<td')
    const close = before.lastIndexOf('</td>')
    if (open < 0 || open < close) continue
    const tid = (attrs.match(/data-testid="([^"]+)"/) ?? [])[1] ?? '?'
    out.push(tid)
  }
  return out
}

/**
 * 从 glob key 归一化出 `views/...` 形式的相对路径。
 *
 * **实测（iter372）**：本文件位于 `src/views/__tests__/`，所以 glob 的相对 key 是
 * `../groups/GroupList.vue` —— **根本没有 `views/` 这一段**。
 *
 * 我第一版写的是 `p.indexOf('views/')` → 全部返回 `null` → **所有文件被跳过**，
 * 于是第一条用例「通过」了，而它**没有检查任何文件**（假绿）。
 * 这是 S201 的第四次复发：**「零命中」必须能区分「真没有」与「什么都没扫」。**
 *
 * 现在的做法：剥掉若干层 `../` 后，前缀补上 `views/`；若 key 直接指向 `../../App.vue` 这类
 * 非 views 文件，返回 null（本守卫只关心 views 下的页面）。
 */
function normalizeKey(p: string): string | null {
  const idx = p.indexOf('views/')
  if (idx >= 0) return p.slice(idx)
  // `../groups/x.vue` → 剥一层 → 补 `views/`
  let rest = p
  let depth = 0
  while (rest.startsWith('../')) {
    rest = rest.slice(3)
    depth++
  }
  // 本文件在 src/views/__tests__/：一层 ../ 就到 views/ 下
  if (depth === 1) return 'views/' + rest
  // `../../App.vue`（depth 2）不是 views 下的页面，跳过
  return null
}

describe('行内操作按钮可访问名守卫（iter372）', () => {
  it('表格 <td> 内带 data-testid 的按钮必须有 aria-label', () => {
    const offenders: string[] = []

    for (const [path, src] of Object.entries(sources)) {
      if (/\.(test|spec)\./.test(path)) continue
      const rel = normalizeKey(path)
      if (!rel) continue
      if (KNOWN_GAPS.includes(rel)) continue
      const tpl = templateOf(src)
      if (!tpl || !/v-for/.test(tpl)) continue // 只看有循环的（行内按钮）

      const missing = findUnlabeledInlineButtons(tpl)
      if (missing.length) offenders.push(`${rel}  →  ${missing.join(', ')}`)
    }

    expect(
      offenders,
      '以下表格行内按钮缺少 aria-label —— 读屏会把每行的同名按钮念成一样的，无法区分行。\n' +
        '修法：加 `:aria-label="`操作名 ${行变量.name}`"`，可见文本保持不变：\n  ' +
        offenders.join('\n  '),
    ).toEqual([])
  })

  it('KNOWN_GAPS 里的条目必须仍然存在（防止清单过期后掩盖新问题）', () => {
    const stale: string[] = []

    for (const gap of KNOWN_GAPS) {
      const hit = Object.entries(sources).some(([path, src]) => {
        if (/\.(test|spec)\./.test(path)) return false
        if (normalizeKey(path) !== gap) return false
        const tpl = templateOf(src)
        return tpl ? findUnlabeledInlineButtons(tpl).length > 0 : false
      })
      if (!hit) stale.push(gap)
    }

    expect(
      stale,
      '这些条目已经没有「缺 aria-label 的行内按钮」了，请从 KNOWN_GAPS 删掉（清单只应变短）：\n  ' +
        stale.join('\n  '),
    ).toEqual([])
  })
})
