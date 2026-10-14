import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  sha256OfContent,
  sha256Lf,
  sha256Crlf,
  loadHashes,
  referenceHash,
  localReferenceHash,
  checkDrift,
  formatReport,
} from '../drift-check.mjs'

// 固定内容样本
const SAMPLE_LF = 'line1\nline2\nline3\n'
const SAMPLE_CRLF = 'line1\r\nline2\r\nline3\r\n'
const BUF_LF = Buffer.from(SAMPLE_LF, 'utf8')
const BUF_CRLF = Buffer.from(SAMPLE_CRLF, 'utf8')

describe('sha256 helpers', () => {
  it('sha256OfContent is stable hex', () => {
    const h = sha256OfContent('hello')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(sha256OfContent('hello'))
  })
  it('sha256Lf normalizes CRLF to LF', () => {
    // CRLF buffer normalized to LF should equal LF buffer hash
    expect(sha256Lf(BUF_CRLF)).toBe(sha256Lf(BUF_LF))
  })
  it('sha256Crlf normalizes LF to CRLF', () => {
    expect(sha256Crlf(BUF_LF)).toBe(sha256Crlf(BUF_CRLF))
  })
  it('LF and CRLF forms differ', () => {
    expect(sha256Lf(BUF_LF)).not.toBe(sha256Crlf(BUF_LF))
  })
})

describe('referenceHash / localReferenceHash', () => {
  it('referenceHash prefers sourceSha256 when present (pattern file)', () => {
    expect(referenceHash({ sha256: 'aaa', sourceSha256: 'bbb' })).toBe('bbb')
  })
  it('referenceHash falls back to sha256 for byte-copy', () => {
    expect(referenceHash({ sha256: 'aaa' })).toBe('aaa')
  })
  it('localReferenceHash always uses sha256 (local form)', () => {
    expect(localReferenceHash({ sha256: 'aaa', sourceSha256: 'bbb' })).toBe('aaa')
  })
})

describe('checkOne + checkDrift（双向）', () => {
  let workdir
  let sourceRoot
  let localRoot
  let jsonPath

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'drift-'))
    sourceRoot = join(workdir, 'e-cam-web')   // 源仓
    localRoot = join(workdir, 'haven-console') // 本仓
    mkdirSync(join(sourceRoot, 'src', 'assets', 'styles'), { recursive: true })
    mkdirSync(join(sourceRoot, 'src', 'api', 'request'), { recursive: true })
    mkdirSync(join(localRoot, 'src', 'assets', 'styles'), { recursive: true })
    mkdirSync(join(localRoot, 'src', 'api', 'request'), { recursive: true })
    jsonPath = join(workdir, 'shared-hashes.json')

    // 源文件（LF 形态）
    const themeBuf = BUF_LF
    const elemBuf = Buffer.from('/* element theme */\nbody{color:#fff}\n', 'utf8')
    const eiamSrcBuf = BUF_LF
    writeFileSync(join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'), themeBuf)
    writeFileSync(join(sourceRoot, 'src', 'assets', 'styles', 'element-theme.scss'), elemBuf)
    writeFileSync(join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'), eiamSrcBuf)

    // 本仓拷贝：字节拷贝 = 与源相同；模式文件 = 本仓自包含适配（内容不同于源）
    const eiamLocalBuf = Buffer.from('// console eiam adapted\n', 'utf8')
    writeFileSync(join(localRoot, 'src', 'assets', 'styles', 'theme-variables.scss'), themeBuf)
    writeFileSync(join(localRoot, 'src', 'assets', 'styles', 'element-theme.scss'), elemBuf)
    writeFileSync(join(localRoot, 'src', 'api', 'request', 'eiam.ts'), eiamLocalBuf)

    const themeCrlfHash = sha256Crlf(themeBuf) // 字节拷贝登记用 CRLF 形态
    const elemCrlfHash = sha256Crlf(elemBuf)
    const eiamSrcLfHash = sha256Lf(eiamSrcBuf) // 模式文件 sourceSha256 登记用 LF 形态
    const eiamLocalHash = sha256Lf(eiamLocalBuf) // 模式文件 sha256 = 本仓文件体（LF 形态）

    const json = {
      sourceRepo: 'e-cam-web',
      sourceRepoRoot: sourceRoot,
      files: [
        {
          path: 'src/assets/styles/theme-variables.scss',
          sourcePath: 'src/assets/styles/theme-variables.scss',
          sourceCommit: 'aaaaaaa',
          sha256: themeCrlfHash,
        },
        {
          path: 'src/assets/styles/element-theme.scss',
          sourcePath: 'src/assets/styles/element-theme.scss',
          sourceCommit: 'bbbbbbb',
          sha256: elemCrlfHash,
        },
        {
          path: 'src/api/request/eiam.ts',
          sourcePath: 'src/api/request/eiam.ts',
          sourceCommit: 'ccccccc',
          sha256: eiamLocalHash,
          sourceSha256: eiamSrcLfHash,
          note: '模式文件',
        },
      ],
    }
    writeFileSync(jsonPath, JSON.stringify(json, null, 2))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('passes when both source and local copies match registered hashes', () => {
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(true)
    expect(r.results).toHaveLength(3)
    expect(r.results.every((x) => !x.drifted)).toBe(true)
    expect(r.results.every((x) => !x.localDrifted)).toBe(true)
  })

  it('passes regardless of source file line-ending (CRLF source matches LF-registered via dual form)', () => {
    // 把源 eiam.ts 改写为 CRLF 形态，sourceSha256 登记的是 LF —— 双形态比对仍应通过
    writeFileSync(
      join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'),
      SAMPLE_CRLF,
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(true)
    const eiamResult = r.results.find((x) => x.path.endsWith('eiam.ts'))
    expect(eiamResult.drifted).toBe(false)
  })

  it('fails when a byte-copy source drifts (content changed)', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'),
      '/* CHANGED */\nbody{color:#000}\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.drifted).toBe(true)
    expect(themeResult.localDrifted).toBe(false) // 本仓侧未动，不应误红
  })

  it('fails when pattern-file source drifts', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'),
      '/* eiam changed */\nexport const x = 1\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const eiamResult = r.results.find((x) => x.path.endsWith('eiam.ts'))
    expect(eiamResult.drifted).toBe(true)
  })

  it('reports missing source file as drift', () => {
    rmSync(join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'))
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.drifted).toBe(true)
    expect(themeResult.error).toMatch(/源文件不存在/)
  })

  // ── 方向 2：本仓漂移 ─────────────────────────────────────────────
  it('fails when a byte-copy local copy drifts (content changed)', () => {
    writeFileSync(
      join(localRoot, 'src', 'assets', 'styles', 'theme-variables.scss'),
      '/* LOCAL CHANGED */\nbody{color:#000}\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.drifted).toBe(false) // 源侧未动
    expect(themeResult.localDrifted).toBe(true)
  })

  it('fails when local pattern-file drifts', () => {
    writeFileSync(
      join(localRoot, 'src', 'api', 'request', 'eiam.ts'),
      '// console eiam changed locally\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const eiamResult = r.results.find((x) => x.path.endsWith('eiam.ts'))
    expect(eiamResult.localDrifted).toBe(true)
  })

  it('reports missing local file as drift', () => {
    rmSync(join(localRoot, 'src', 'assets', 'styles', 'theme-variables.scss'))
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.localDrifted).toBe(true)
    expect(themeResult.localError).toMatch(/本仓文件不存在/)
  })

  it('passes regardless of local line-ending (LF local matches CRLF-registered via dual form)', () => {
    // 字节拷贝 sha256 登记的是 CRLF 形态；本仓写 LF 形态 —— 双形态比对仍应通过
    writeFileSync(
      join(localRoot, 'src', 'assets', 'styles', 'element-theme.scss'),
      '/* element theme */\nbody{color:#fff}\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    expect(r.passed).toBe(true)
    const elemResult = r.results.find((x) => x.path.endsWith('element-theme.scss'))
    expect(elemResult.localDrifted).toBe(false)
  })

  // ── 报告 ─────────────────────────────────────────────────────────
  it('formatReport renders remediation runbook on drift', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'assets', 'styles', 'element-theme.scss'),
      '/* drifted */\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    const report = formatReport(r)
    expect(report).toContain('DRIFT')
    expect(report).toContain('源漂移')
    expect(report).toContain('同步拷贝')
    expect(report).toContain('主题冒烟 E2E')
    expect(report).toContain('漂移来源 commit')
  })

  it('formatReport distinguishes local drift from source drift', () => {
    writeFileSync(
      join(localRoot, 'src', 'assets', 'styles', 'theme-variables.scss'),
      '/* local only */\n',
    )
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    const report = formatReport(r)
    expect(report).toContain('DRIFT(本仓)')
    expect(report).toContain('本仓漂移')
  })

  it('formatReport renders OK when no drift', () => {
    const r = checkDrift(jsonPath, sourceRoot, localRoot)
    const report = formatReport(r)
    expect(report).toContain('OK')
    expect(report).toContain('漂移比对通过')
  })

  it('loadHashes throws on missing json', () => {
    expect(() => loadHashes(join(workdir, 'nope.json'))).toThrow(/not found/)
  })
})
