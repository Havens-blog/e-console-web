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

describe('referenceHash', () => {
  it('prefers sourceSha256 when present (pattern file)', () => {
    expect(referenceHash({ sha256: 'aaa', sourceSha256: 'bbb' })).toBe('bbb')
  })
  it('falls back to sha256 for byte-copy', () => {
    expect(referenceHash({ sha256: 'aaa' })).toBe('aaa')
  })
})

describe('checkOne + checkDrift', () => {
  let workdir
  let sourceRoot
  let jsonPath

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'drift-'))
    sourceRoot = join(workdir, 'e-cam-web')
    mkdirSync(join(sourceRoot, 'src', 'assets', 'styles'), { recursive: true })
    mkdirSync(join(sourceRoot, 'src', 'api', 'request'), { recursive: true })
    jsonPath = join(workdir, 'shared-hashes.json')

    // 写三个源文件（LF 形态），构造登记值与之一致
    const themeBuf = BUF_LF
    const elemBuf = Buffer.from('/* element theme */\nbody{color:#fff}\n', 'utf8')
    const eiamBuf = BUF_LF
    writeFileSync(join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'), themeBuf)
    writeFileSync(join(sourceRoot, 'src', 'assets', 'styles', 'element-theme.scss'), elemBuf)
    writeFileSync(join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'), eiamBuf)

    const themeCrlfHash = sha256Crlf(themeBuf) // 字节拷贝登记用 CRLF 形态
    const elemCrlfHash = sha256Crlf(elemBuf)
    const eiamLfHash = sha256Lf(eiamBuf) // 模式文件 sourceSha256 登记用 LF 形态

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
          sha256: '9999', // 控制台本体 hash（与漂移比对无关）
          sourceSha256: eiamLfHash,
          note: '模式文件',
        },
      ],
    }
    writeFileSync(jsonPath, JSON.stringify(json, null, 2))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('passes when all source files match registered hashes', () => {
    const r = checkDrift(jsonPath, sourceRoot)
    expect(r.passed).toBe(true)
    expect(r.results).toHaveLength(3)
    expect(r.results.every((x) => !x.drifted)).toBe(true)
  })

  it('passes regardless of source file line-ending (CRLF source matches LF-registered via dual form)', () => {
    // 把 eiam.ts 改写为 CRLF 形态，sourceSha256 登记的是 LF —— 双形态比对仍应通过
    writeFileSync(
      join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'),
      SAMPLE_CRLF,
    )
    const r = checkDrift(jsonPath, sourceRoot)
    expect(r.passed).toBe(true)
    const eiamResult = r.results.find((x) => x.path.endsWith('eiam.ts'))
    expect(eiamResult.drifted).toBe(false)
  })

  it('fails when a byte-copy source drifts (content changed)', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'),
      '/* CHANGED */\nbody{color:#000}\n',
    )
    const r = checkDrift(jsonPath, sourceRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.drifted).toBe(true)
  })

  it('fails when pattern-file source drifts', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'api', 'request', 'eiam.ts'),
      '/* eiam changed */\nexport const x = 1\n',
    )
    const r = checkDrift(jsonPath, sourceRoot)
    expect(r.passed).toBe(false)
    const eiamResult = r.results.find((x) => x.path.endsWith('eiam.ts'))
    expect(eiamResult.drifted).toBe(true)
  })

  it('reports missing source file as drift', () => {
    rmSync(join(sourceRoot, 'src', 'assets', 'styles', 'theme-variables.scss'))
    const r = checkDrift(jsonPath, sourceRoot)
    expect(r.passed).toBe(false)
    const themeResult = r.results.find((x) => x.path.endsWith('theme-variables.scss'))
    expect(themeResult.drifted).toBe(true)
    expect(themeResult.error).toMatch(/源文件不存在/)
  })

  it('formatReport renders remediation runbook on drift', () => {
    writeFileSync(
      join(sourceRoot, 'src', 'assets', 'styles', 'element-theme.scss'),
      '/* drifted */\n',
    )
    const r = checkDrift(jsonPath, sourceRoot)
    const report = formatReport(r)
    expect(report).toContain('DRIFT')
    expect(report).toContain('漂移检出')
    expect(report).toContain('同步拷贝')
    expect(report).toContain('主题冒烟 E2E')
    expect(report).toContain('漂移来源 commit')
  })

  it('formatReport renders OK when no drift', () => {
    const r = checkDrift(jsonPath, sourceRoot)
    const report = formatReport(r)
    expect(report).toContain('OK')
    expect(report).toContain('漂移比对通过')
  })

  it('loadHashes throws on missing json', () => {
    expect(() => loadHashes(join(workdir, 'nope.json'))).toThrow(/not found/)
  })
})
