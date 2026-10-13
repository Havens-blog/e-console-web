// gzip-budget.mjs — 性能预算闸门（tech-design §性能预算 承接）
//
// 汇总 dist/**/*.gz 体积，按桶分类，超预算即 fail（exit 1）：
//   entry          ≤ 60 KB   （dist/index.html、dist/js/index-*.js）
//   element-plus   ≤ 140 KB  （dist/js/element-plus-*.js）
//   vue-ecosystem  ≤ 50 KB   （dist/js/vue-vendor-*.js — vue/router/pinia）
//   routes         ≤ 90 KB   （懒加载视图/共享小 chunk —— 非首屏，2026-10-09 口径修正：
//                             原归类 remainder 与首屏混淆，见 tech-design §性能预算 routes 行）
//   remainder      ≤ 50 KB   （vendor chunk + css + 字体 + 图标）
//   grandTotal     ≤ 300 KB  （全量静态 gzip 总预算，PRD Goal）
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
  routes: { limit: 90, label: 'routes 懒加载视图' },
  remainder: { limit: 50, label: '其余（vendor/css/字体/图标）' },
})
export const TOTAL_LIMIT_KB = 300

/**
 * 将一个 .gz 文件路径归类到预算桶。
 * 规则基于 vite.config.ts manualChunks 产物命名（chunkFileNames/assetFileNames）。
 * @param {string} gzPath 相对 dist 根的 .gz 文件路径（POSIX 斜杠）
 * @returns {'entry'|'element-plus'|'vue-ecosystem'|'routes'|'remainder'}
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
    // dist/js/vendor-*.js → remainder（首屏运行时依赖，当前 axios）
    if (base.startsWith('js/vendor-')) return 'remainder'
    // 其余命名 JS = 懒加载视图/共享小 chunk → routes（非首屏）
    return 'routes'
  }
  // 非 JS 一律 remainder（vendor chunk / css / 字体 / 图标 / 其他静态）
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
 * 检查预算：逐桶 + 总计，任一超限即 fail。
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
    const limit = BUDGETS[key].limit
    if (b.kb > limit) {
      failures.push({ scope: key, limitKb: limit, actualKb: b.kb })
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
      } else {
        console.error(`  - ${f.scope}: ${f.actualKb} KB > ${f.limitKb} KB`)
      }
    }
    process.exit(1)
  }
  console.log('\n✅ gzip 预算通过（全量 ≤ 300 KB，各桶均在限内）')
}

// 仅在直接执行时跑 CLI（被 import 时不跑）
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) main()
