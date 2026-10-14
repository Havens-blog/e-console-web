// drift-check.mjs — 拷贝面漂移防线（tech-design Architecture「拷贝面漂移防线」承接，双向校验）
//
// 从 e-cam-web checkout 对应源文件重算 sha256，比对 shared-hashes.json 登记值（方向 1：源漂移）；
// 同时从本仓拷贝重算 sha256 比对登记值（方向 2：本仓漂移）。任一侧不一致 → 红（exit 1）。
//
// Hard Rule：源漂移只能以 e-cam-web 对应 commit 源文件为准；本仓漂移以本仓拷贝为准。
//
// 为什么补方向 2：早期版本只做源漂移，抓得到「源变了、本仓没同步」，抓不到「本仓被改、
// 源没变」——单边改动会静默漏网。与 e-cmdb-web/scripts/drift-check.mjs 同口径补齐。
//
// hash 归一化说明（见 shared-hashes.json 各条 note）：
//   - 字节级拷贝（theme-variables.scss / element-theme.scss）：sha256 字段 = 工作区形态（注册时 CRLF）
//   - 模式文件（eiam.ts）：sourceSha256 字段 = e-cam-web 源 git blob（LF）形态；sha256 = 本仓文件体形态
// 为兼容两种归一化与跨平台（CI Linux LF / 本地 Windows CRLF），脚本对每个文件
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
 * 取某条登记的「源漂移」参考 hash（用于比对 e-cam-web 源文件）。
 * 模式文件（含 sourceSha256）以 sourceSha256 为准（e-cam-web 源形态）；
 * 字节级拷贝（仅 sha256）以 sha256 为准。
 * @param {object} entry shared-hashes.files[i]
 * @returns {string}
 */
export function referenceHash(entry) {
  return entry.sourceSha256 || entry.sha256
}

/**
 * 取某条登记的「本仓漂移」参考 hash（用于比对本仓拷贝）。
 * sha256 恒登记本仓文件体形态（字节拷贝 = 工作区形态；模式文件 = 本仓文件体），
 * 故一律取 entry.sha256。
 * @param {object} entry shared-hashes.files[i]
 * @returns {string}
 */
export function localReferenceHash(entry) {
  return entry.sha256
}

/**
 * 对单个文件做漂移比对：既比 e-cam-web 源文件，也比本仓拷贝。
 * @param {object} entry shared-hashes.files[i]
 * @param {string} sourceRoot e-cam-web 仓库根（含 src/）
 * @param {string} localRoot 本仓仓库根（含 src/）
 * @returns {DriftResult}
 */
export function checkOne(entry, sourceRoot, localRoot) {
  const out = {
    path: entry.path,
    sourcePath: entry.sourcePath,
    sourceCommit: entry.sourceCommit,
    reference: referenceHash(entry),
    lf: '',
    crlf: '',
    drifted: false,
    localReference: localReferenceHash(entry),
    localLf: '',
    localCrlf: '',
    localDrifted: false,
    note: entry.note,
  }

  // ── 方向 1：源漂移（e-cam-web 源文件）───────────────────────────
  const srcAbs = join(sourceRoot, entry.sourcePath)
  if (!existsSync(srcAbs)) {
    out.drifted = true
    out.error = `源文件不存在: ${srcAbs}`
  } else {
    const buf = readFileSync(srcAbs)
    out.lf = sha256Lf(buf)
    out.crlf = sha256Crlf(buf)
    // 任一形态匹配参考值 → 未漂移
    out.drifted = out.lf !== out.reference && out.crlf !== out.reference
  }

  // ── 方向 2：本仓漂移（haven-console 拷贝）───────────────────────
  const localAbs = join(localRoot, entry.path)
  if (!existsSync(localAbs)) {
    out.localDrifted = true
    out.localError = `本仓文件不存在: ${localAbs}`
  } else {
    const buf = readFileSync(localAbs)
    out.localLf = sha256Lf(buf)
    out.localCrlf = sha256Crlf(buf)
    out.localDrifted = out.localLf !== out.localReference && out.localCrlf !== out.localReference
  }

  return out
}

/**
 * 默认本仓根：脚本位于 <repo>/scripts/drift-check.mjs，父目录即仓根。
 * 对直接执行与 import 两种用法都成立。
 * @returns {string}
 */
export function defaultLocalRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * 全量漂移比对（双向）。
 * @param {string} jsonPath shared-hashes.json 路径
 * @param {string} sourceRoot e-cam-web 仓库根（默认从 json.sourceRepoRoot 或 ../e-cam-web）
 * @param {string} localRoot 本仓仓库根（默认脚本所在仓根）
 * @returns {DriftCheckResult}
 */
export function checkDrift(jsonPath, sourceRoot, localRoot) {
  const json = loadHashes(jsonPath)
  const srcRoot = sourceRoot || json.sourceRepoRoot || '../e-cam-web'
  const locRoot = localRoot || defaultLocalRoot()
  const results = json.files.map((entry) => checkOne(entry, srcRoot, locRoot))
  return {
    passed: results.every((r) => !r.drifted && !r.localDrifted),
    sourcePassed: results.every((r) => !r.drifted),
    localPassed: results.every((r) => !r.localDrifted),
    results,
    sourceRepo: json.sourceRepo || 'e-cam-web',
    sourceRoot: srcRoot,
    localRoot: locRoot,
  }
}

/**
 * 格式化漂移报告（双向）。
 */
export function formatReport(result) {
  const lines = []
  const sourceDrifted = result.results.filter((r) => r.drifted)
  const localDrifted = result.results.filter((r) => r.localDrifted)
  lines.push(`拷贝面漂移比对（源仓: ${result.sourceRepo} @ ${result.sourceRoot}；本仓 @ ${result.localRoot}）`)
  lines.push('─'.repeat(60))
  for (const r of result.results) {
    const status = r.drifted && r.localDrifted ? 'DRIFT(双)' : r.drifted ? 'DRIFT(源)' : r.localDrifted ? 'DRIFT(本仓)' : 'OK'
    lines.push(`[${status}] ${r.path}`)
    lines.push(`    sourceCommit : ${r.sourceCommit || '(未登记)'}`)
    lines.push(`    reference(源): ${r.reference}`)
    if (r.error) {
      lines.push(`    error        : ${r.error}`)
    } else {
      lines.push(`    lf  sha256   : ${r.lf}`)
      lines.push(`    crlf sha256  : ${r.crlf}`)
    }
    lines.push(`    reference(本) : ${r.localReference}`)
    if (r.localError) {
      lines.push(`    localError   : ${r.localError}`)
    } else {
      lines.push(`    local lf     : ${r.localLf}`)
      lines.push(`    local crlf   : ${r.localCrlf}`)
    }
  }
  lines.push('─'.repeat(60))
  if (result.passed) {
    lines.push(`✅ 漂移比对通过（${result.results.length} 个拷贝面，源/本仓两侧与登记 hash 均一致）`)
  } else {
    if (sourceDrifted.length) {
      lines.push(`❌ 源漂移 ${sourceDrifted.length}/${result.results.length}（e-cam-web 源文件与登记值不一致）`)
    }
    if (localDrifted.length) {
      lines.push(`❌ 本仓漂移 ${localDrifted.length}/${result.results.length}（本仓拷贝与登记值不一致）`)
    }
    lines.push('')
    lines.push('恢复绿必须完成以下步骤（见 tech-design 拷贝面漂移防线）:')
    lines.push('  1. 人工评估差异（是平台统一口径的改进需同步，还是本仓特有需求需显式分叉）')
    lines.push('  2. 同步拷贝到 haven-console 对应文件，或在 shared-hashes.json 该条 note 里写明分叉理由')
    lines.push('  3. 更新 shared-hashes.json（sha256 / sourceSha256 / sourceCommit）')
    lines.push('  4. 跑一条主题冒烟 E2E（2.12 起）')
    lines.push('  5. 将漂移来源 commit 记入变更记录')
  }
  return lines.join('\n')
}

// ── CLI 入口 ──────────────────────────────────────────────
// 用法: node scripts/drift-check.mjs [shared-hashes.json] [e-cam-web-root] [local-root]
export function main(argv = process.argv) {
  const jsonPath = argv[2] || 'shared-hashes.json'
  const result = checkDrift(jsonPath, argv[3], argv[4])
  console.log(formatReport(result))
  if (!result.passed) process.exit(1)
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirect) main()
