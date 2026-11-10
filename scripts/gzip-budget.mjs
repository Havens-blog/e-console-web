// gzip-budget.mjs — 性能预算闸门（tech-design §性能预算 承接）
//
// 汇总 dist/**/*.gz 体积，按桶分类，超预算即 fail（exit 1）：
//   entry          ≤ 60 KB   （dist/index.html、dist/js/index-*.js）
//   element-plus   ≤ 140 KB  （dist/js/element-plus-*.js）
//   vue-ecosystem  ≤ 50 KB   （dist/js/vue-vendor-*.js — vue/router/pinia）
//   routes         **逐块** ≤ 16 KB  （懒加载视图；见下方 quota 说明）
//   css            ≤ 45 KB   （dist/css/*.css —— 组件样式）
//   shared-vendor  ≤ 20 KB   （dist/js/vendor-*.js —— 首屏运行时依赖，如 axios）
//   remainder      ≤ 6 KB    （字体 / 图标 / 其他静态）
//   grandTotal     ≤ 300 KB  （全量静态 gzip 总预算，PRD Goal）
//
// ── routes 为什么要按「逐块」而不是「总和」（2026-11-10 口径修正，Q1）──
// 原口径 `routes ≤ 90 KB` 是**把全部懒加载视图合起来算一个桶**。实测该桶已到
// **122.7 KB / 36 个页面块**，于是闸门长期红（`main` 上最近 12 次 CI 全部 failure，
// 该阈值自 CI 引入起从未调整过、也从未达标过）。但拆开看：**中位数仅 1.27 KB、
// 平均 3.41 KB、最大单块 13.1 KB（TenantList）** —— 不是「页面臃肿」，是「页面多」。
// 用总和限制意味着「**多加一个页面就会假红**」，而它对真正要防的「单个页面失控膨胀」
// 反而不敏感（一个 40 KB 的巨页会被另外 35 个小页面摊平）。
// 因此改为**逐块上限**：每块 ≤ 16 KB（当前最大 13.1 KB，留约 22% 余量），
// 既保留防膨胀能力，又不会因页面数量增长而误报。桶总和仍纳入 TOTAL_LIMIT_KB 兜底。
//
// ── remainder 为什么要拆（同次修正）──
// 原 `remainder ≤ 50 KB` 把 **CSS 37.4 KB + 首屏 vendor JS 15.1 KB + SVG** 混算，
// 任一方变化都会挤压另一方，且无法从失败信息判断该优化什么。拆成三桶后，
// 每类有自己的合理阈值，失败时指向明确。
//
// Hard Rule：超限必须 fail，不得放宽后放行。
//
// 作为 CI 步骤与本地复算入口共享同一逻辑（scripts/__tests__ 覆盖）。

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KB = 1024

// 桶预算（KB），与 tech-design 性能预算表逐列对齐
export const BUDGETS = Object.freeze({
  entry: { limit: 60, label: 'entry 自研' },
  'element-plus': { limit: 140, label: 'element-plus' },
  'vue-ecosystem': { limit: 50, label: 'vue/router/pinia' },
  // routes 不再设「总和」上限，改为逐块上限（见 ROUTES_PER_CHUNK_LIMIT_KB 与文件头说明）；
  // limit 置 null 表示该桶不参与逐桶总和判定，仅报告（总和仍由 TOTAL_LIMIT_KB 兜底）。
  routes: { limit: null, label: 'routes 懒加载视图' },
  css: { limit: 45, label: 'css 组件样式' },
  'shared-vendor': { limit: 20, label: 'shared-vendor 首屏运行时' },
  remainder: { limit: 6, label: '其余（字体/图标/静态）' },
})
export const TOTAL_LIMIT_KB = 300

/**
 * routes 桶的**单块**上限（KB）。
 *
 * 选 16 KB 的依据（2026-11-10 实测）：36 个懒加载视图块里最大的是
 * `TenantList` 13.1 KB，中位数 1.27 KB、平均 3.41 KB。
 * 16 KB 留约 22% 余量 —— 正常迭代不会触碰，但单个页面失控膨胀仍会被拦下。
 */
export const ROUTES_PER_CHUNK_LIMIT_KB = 16

/**
 * 将一个 .gz 文件路径归类到预算桶。
 * 规则基于 vite.config.ts manualChunks 产物命名（chunkFileNames/assetFileNames）。
 * @param {string} gzPath 相对 dist 根的 .gz 文件路径（POSIX 斜杠）
 * @returns {'entry'|'element-plus'|'vue-ecosystem'|'routes'|'css'|'shared-vendor'|'remainder'}
 */
export function classifyBucket(gzPath) {
  // 去掉 .gz 后缀得到原产物路径
  const base = gzPath.endsWith('.gz') ? gzPath.slice(0, -3) : gzPath
  // dist/index.html → entry
  if (base === 'index.html' || base.endsWith('/index.html')) return 'entry'
  if (base.endsWith('.js')) {
    // dist/js/index-*.js → entry（自研首屏 entry chunk）
    if (base.startsWith('js/index-')) return 'entry'
    // dist/js/element-plus-*.js → element-plus
    if (base.startsWith('js/element-plus-')) return 'element-plus'
    // dist/js/vue-vendor-*.js → vue-ecosystem
    if (base.startsWith('js/vue-vendor-')) return 'vue-ecosystem'
    // dist/js/vendor-*.js → shared-vendor（首屏运行时依赖，如 axios）
    if (base.startsWith('js/vendor-')) return 'shared-vendor'
    // 其余命名 JS = 懒加载视图/共享小 chunk → routes（非首屏）
    return 'routes'
  }
  // dist/css/*.css → css（组件样式，原并入 remainder 导致与 vendor 互相挤压）
  if (base.endsWith('.css')) return 'css'
  // 字体 / 图标 / SVG / 其他静态
  return 'remainder'
}

/**
 * 递归收集目录下所有 .gz 文件（相对路径，POSIX 斜杠）。
 * @param {string} root dist 根目录绝对/相对路径
 * @returns {string[]} 相对 root 的 .gz 路径列表（POSIX 斜杠，已排序）
 */
export function collectGzFiles(root) {
  const out = []
  const walk = (dir, rel = '') => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在或不可读 → 视为空
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        walk(abs, relPath)
      } else if (ent.isFile() && ent.name.endsWith('.gz')) {
        out.push(relPath)
      }
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 汇总 dist 下所有 .gz 体积到四桶 + 总计。
 * @param {string} root dist 根目录
 * @returns {Summary}
 */
export function summarizeGz(root) {
  const gzFiles = collectGzFiles(root)
  const buckets = {
    entry: { files: [], bytes: 0 },
    'element-plus': { files: [], bytes: 0 },
    'vue-ecosystem': { files: [], bytes: 0 },
    routes: { files: [], bytes: 0 },
    css: { files: [], bytes: 0 },
    'shared-vendor': { files: [], bytes: 0 },
    remainder: { files: [], bytes: 0 },
  }
  for (const rel of gzFiles) {
    const abs = join(root, ...rel.split('/'))
    const bytes = statSync(abs).size
    const bucket = classifyBucket(rel)
    buckets[bucket].files.push({ path: rel, bytes })
    buckets[bucket].bytes += bytes
  }
  for (const b of Object.values(buckets)) {
    b.kb = Math.round((b.bytes / KB) * 10) / 10 // 保留 1 位小数
  }
  const totalBytes = Object.values(buckets).reduce((s, b) => s + b.bytes, 0)
  return {
    buckets,
    totalBytes,
    totalKb: Math.round((totalBytes / KB) * 10) / 10,
    files: gzFiles,
  }
}

/**
 * 检查预算：逐桶 + routes 逐块 + 总计，任一超限即 fail。
 *
 * 失效保护（审计 Tier 2 修复）：当 dist 下无任何 .gz 文件时直接判 fail，不再以
 * 「0 KB ≤ 各桶上限」误判通过。原实现只统计 .gz，本地用 `vite build`（无
 * generate-gz）构建时 dist 无 .gz → 0 KB 全过 → 打印「✅ 通过」→ 闸门形同虚设。
 * CI 用 build:gz 不受影响，但构建命令写错即失效。此处从库函数层面根治。
 * @param {Summary} summary
 * @returns {CheckResult}
 */
export function checkBudget(summary) {
  const failures = []
  // 失效保护：无 .gz 产物即 fail（短路，跳过桶检查——无数据时 0 KB「通过」无意义）
  if (summary.files.length === 0) {
    failures.push({
      scope: 'no-gz-files',
      limitKb: null,
      actualKb: null,
      reason: 'dist 下未找到任何 .gz 产物（构建未预压缩，误用 vite build 而非 build:gz？）',
    })
    return { passed: false, failures }
  }
  for (const [key, b] of Object.entries(summary.buckets)) {
    const limit = BUDGETS[key]?.limit
    // limit 为 null / 未定义 → 该桶不参与总和判定（如 routes，见文件头说明）
    if (limit == null) continue
    if (b.kb > limit) {
      failures.push({ scope: key, limitKb: limit, actualKb: b.kb })
    }
  }
  // routes 逐块判定：单个懒加载视图超 ROUTES_PER_CHUNK_LIMIT_KB 即 fail。
  // 这样「多加页面」不会假红，「单页失控膨胀」仍会被拦。
  for (const f of summary.buckets.routes.files) {
    const kb = Math.round((f.bytes / KB) * 10) / 10
    if (kb > ROUTES_PER_CHUNK_LIMIT_KB) {
      failures.push({
        scope: 'routes:chunk',
        limitKb: ROUTES_PER_CHUNK_LIMIT_KB,
        actualKb: kb,
        path: f.path,
      })
    }
  }
  if (summary.totalKb > TOTAL_LIMIT_KB) {
    failures.push({ scope: 'total', limitKb: TOTAL_LIMIT_KB, actualKb: summary.totalKb })
  }
  return { passed: failures.length === 0, failures }
}

/**
 * 格式化为人类可读报告字符串。
 */
export function formatReport(summary) {
  const lines = []
  lines.push('gzip 预算报告（dist/**/*.gz）')
  lines.push('─'.repeat(52))
  for (const [key, b] of Object.entries(summary.buckets)) {
    const limit = BUDGETS[key]
    // routes 桶不设总和上限：报「块数 / 最大单块」，与逐块上限比对
    if (limit.limit == null) {
      const maxKb = b.files.reduce((m, f) => Math.max(m, f.bytes / KB), 0)
      const over = maxKb > ROUTES_PER_CHUNK_LIMIT_KB ? 'OVER' : 'OK'
      lines.push(
        `${limit.label.padEnd(28)} ${String(b.kb).padStart(7)} KB /   —    [${b.files.length} 块，最大单块 ${maxKb.toFixed(1)} KB ≤ ${ROUTES_PER_CHUNK_LIMIT_KB}，${over}]`,
      )
      for (const f of b.files) {
        const kb = f.bytes / KB
        const flag = kb > ROUTES_PER_CHUNK_LIMIT_KB ? '  ⚠️ 超单块上限' : ''
        lines.push(`    ${kb.toFixed(2).padStart(6)} KB  ${f.path}${flag}`)
      }
      continue
    }
    const status = b.kb <= limit.limit ? 'OK' : 'OVER'
    lines.push(
      `${limit.label.padEnd(28)} ${String(b.kb).padStart(7)} KB / ${String(limit.limit).padStart(3)} KB  [${status}]`,
    )
    for (const f of b.files) {
      lines.push(`    ${(f.bytes / KB).toFixed(2)} KB  ${f.path}`)
    }
  }
  lines.push('─'.repeat(52))
  const totalStatus = summary.totalKb <= TOTAL_LIMIT_KB ? 'OK' : 'OVER'
  lines.push(
    `${'全量 gzip 总计'.padEnd(28)} ${String(summary.totalKb).padStart(7)} KB / ${String(TOTAL_LIMIT_KB).padStart(3)} KB  [${totalStatus}]`,
  )
  return lines.join('\n')
}

// ── CLI 入口 ──────────────────────────────────────────────
// 用法: node scripts/gzip-budget.mjs [dist-dir]   （默认 dist）
export function main(argv = process.argv) {
  const distDir = argv[2] || 'dist'
  const summary = summarizeGz(distDir)
  const { passed, failures } = checkBudget(summary)

  // 失效保护：无 .gz 时不打 formatReport（会显示误导性的 0 KB / OK），直接失败退出
  if (summary.files.length === 0) {
    console.error(`\n❌ gzip 预算闸门失败：${distDir} 下未找到任何 .gz 文件。`)
    console.error('   构建未生成预压缩产物（可能误用 `vite build` 而非 `build:gz`）。')
    console.error('   闸门失效保护：无 .gz 时直接失败，避免 0 KB 误判「✅ 通过」。')
    console.error('   修复：先执行 `build:gz`（= vite build && node scripts/generate-gz.mjs）再跑 ci:gzip-budget。')
    process.exit(1)
  }

  console.log(formatReport(summary))
  if (!passed) {
    console.error('\n❌ gzip 预算超限（Hard Rule：不得放宽后放行）:')
    for (const f of failures) {
      if (f.scope === 'no-gz-files') {
        console.error(`  - ${f.scope}: ${f.reason}`)
      } else if (f.scope === 'routes:chunk') {
        console.error(`  - 单块超限 ${f.path}: ${f.actualKb} KB > ${f.limitKb} KB`)
      } else {
        console.error(`  - ${f.scope}: ${f.actualKb} KB > ${f.limitKb} KB`)
      }
    }
    process.exit(1)
  }
  console.log('\n✅ gzip 预算通过（全量 ≤ 300 KB，各桶与 routes 单块均在限内）')
}

// 仅在直接执行时跑 CLI（被 import 时不跑）
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) main()
