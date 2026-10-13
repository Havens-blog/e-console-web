// drift-check.mjs — 拷贝面漂移防线（tech-design Architecture「拷贝面漂移防线」承接）
//
// 从 e-cam-web checkout 对应源文件重算 sha256，比对 shared-hashes.json 登记值。
// 不一致 → 红（exit 1）。
//
// Hard Rule：漂移对比只能以 e-cam-web 对应 commit 源文件为准。
//
// hash 归一化说明（见 shared-hashes.json 各条 note）：
//   - 字节级拷贝（theme-variables.scss / element-theme.scss）：sha256 字段 = 工作区形态（注册时 CRLF）
//   - 模式文件（eiam.ts）：sourceSha256 字段 = e-cam-web 源 git blob（LF）形态
// 为兼容两种归一化与跨平台（CI Linux LF / 本地 Windows CRLF），脚本对每个源文件
// 同时计算 LF 与 CRLF 两种形态 sha256，任一与登记参考值一致即视为「未漂移」——
// 只检测真实内容漂移，不因行尾差异误红。

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 计算内容的 sha256（hex）。
 * @param {string|Buffer} content
 * @returns {string}
 */
export function sha256OfContent(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * 将内容归一化为 LF（去掉所有 \r），返回 sha256。
 * @param {Buffer} buf
 * @returns {string}
 */
export function sha256Lf(buf) {
  const lf = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return sha256OfContent(lf)
}

/**
 * 将内容归一化为 CRLF（每行以 \r\n 结尾），返回 sha256。
 * @param {Buffer} buf
 * @returns {string}
 */
export function sha256Crlf(buf) {
  const lf = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  return sha256OfContent(crlf)
}

/**
 * 读取并解析 shared-hashes.json。
 * @param {string} jsonPath shared-hashes.json 绝对/相对路径
 * @returns {{ sourceRepo?: string, sourceRepoRoot?: string, files: Array, pending?: Array }}
 */
export function loadHashes(jsonPath) {
  if (!existsSync(jsonPath)) {
    throw new Error(`shared-hashes.json not found: ${jsonPath}`)
  }
  return JSON.parse(readFileSync(jsonPath, 'utf8'))
}

/**
 * 取某条登记的参考 hash。
 * 模式文件（含 sourceSha256）以 sourceSha256 为准（e-cam-web 源形态）；
 * 字节级拷贝（仅 sha256）以 sha256 为准。
 * @param {object} entry shared-hashes.files[i]
 * @returns {string}
 */
export function referenceHash(entry) {
  return entry.sourceSha256 || entry.sha256
}

/**
 * 对单个 e-cam-web 源文件做漂移比对。
 * @param {object} entry shared-hashes.files[i]
 * @param {string} sourceRoot e-cam-web 仓库根（含 src/）
 * @returns {DriftResult}
 */
export function checkOne(entry, sourceRoot) {
  const abs = join(sourceRoot, entry.sourcePath)
  const out = {
    path: entry.path,
    sourcePath: entry.sourcePath,
    sourceCommit: entry.sourceCommit,
    reference: referenceHash(entry),
    lf: '',
    crlf: '',
    drifted: false,
    note: entry.note,
  }
  if (!existsSync(abs)) {
    out.drifted = true
    out.error = `源文件不存在: ${abs}`
    return out
  }
  const buf = readFileSync(abs)
  out.lf = sha256Lf(buf)
  out.crlf = sha256Crlf(buf)
  // 任一形态匹配参考值 → 未漂移
  out.drifted = out.lf !== out.reference && out.crlf !== out.reference
  return out
}

/**
 * 全量漂移比对。
 * @param {string} jsonPath shared-hashes.json 路径
 * @param {string} sourceRoot e-cam-web 仓库根（默认从 json.sourceRepoRoot 或 ../e-cam-web）
 * @returns {DriftCheckResult}
 */
export function checkDrift(jsonPath, sourceRoot) {
  const json = loadHashes(jsonPath)
  const root = sourceRoot || json.sourceRepoRoot || '../e-cam-web'
  const results = json.files.map((entry) => checkOne(entry, root))
  return {
    passed: results.every((r) => !r.drifted),
    results,
    sourceRepo: json.sourceRepo || 'e-cam-web',
    sourceRoot: root,
  }
}

/**
 * 格式化漂移报告。
 */
export function formatReport(result) {
  const lines = []
  lines.push(`拷贝面漂移比对（源仓: ${result.sourceRepo} @ ${result.sourceRoot}）`)
  lines.push('─'.repeat(60))
  for (const r of result.results) {
    const status = r.drifted ? 'DRIFT' : 'OK'
    lines.push(`[${status}] ${r.path}`)
    lines.push(`    sourceCommit : ${r.sourceCommit || '(未登记)'}`)
    lines.push(`    reference    : ${r.reference}`)
    if (r.error) {
      lines.push(`    error        : ${r.error}`)
    } else {
      lines.push(`    lf  sha256   : ${r.lf}`)
      lines.push(`    crlf sha256  : ${r.crlf}`)
    }
  }
  lines.push('─'.repeat(60))
  if (result.passed) {
    lines.push(`✅ 漂移比对通过（${result.results.length} 个拷贝面源文件与登记 hash 一致）`)
  } else {
    lines.push('❌ 漂移检出（Hard Rule：以 e-cam-web 源文件为准）')
    lines.push('')
    lines.push('恢复绿必须完成以下步骤（见 tech-design 拷贝面漂移防线）:')
    lines.push('  1. 人工评估 e-cam-web 侧差异（是否需同步拷贝）')
    lines.push('  2. 同步拷贝到 haven-console 对应文件')
    lines.push('  3. 更新 shared-hashes.json（sha256 / sourceSha256 / sourceCommit）')
    lines.push('  4. 跑一条主题冒烟 E2E（2.12 起）')
    lines.push('  5. 将漂移来源 commit 记入变更记录')
  }
  return lines.join('\n')
}

// ── CLI 入口 ──────────────────────────────────────────────
// 用法: node scripts/drift-check.mjs [shared-hashes.json] [e-cam-web-root]
export function main(argv = process.argv) {
  const jsonPath = argv[2] || 'shared-hashes.json'
  const result = checkDrift(jsonPath, argv[3])
  console.log(formatReport(result))
  if (!result.passed) process.exit(1)
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) main()
