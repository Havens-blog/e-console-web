import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  classifyBucket,
  collectGzFiles,
  summarizeGz,
  checkBudget,
  formatReport,
  BUDGETS,
  TOTAL_LIMIT_KB,
} from '../gzip-budget.mjs'

// 构造一个临时 dist 树做断言
function makeDist(root) {
  mkdirSync(join(root, 'js'), { recursive: true })
  // dist/index.html.gz (entry)
  writeFileSync(join(root, 'index.html.gz'), Buffer.alloc(1000))
  // dist/js/index-abc.js.gz (entry)
  writeFileSync(join(root, 'js', 'index-abc.js.gz'), Buffer.alloc(5 * 1024))
  // dist/js/element-plus-xyz.js.gz (element-plus)
  writeFileSync(join(root, 'js', 'element-plus-xyz.js.gz'), Buffer.alloc(10 * 1024))
  // dist/js/vue-vendor-abc.js.gz (vue-ecosystem)
  writeFileSync(join(root, 'js', 'vue-vendor-abc.js.gz'), Buffer.alloc(3 * 1024))
  // dist/js/vendor-abc.js.gz (remainder)
  writeFileSync(join(root, 'js', 'vendor-abc.js.gz'), Buffer.alloc(2 * 1024))
  // dist/css/index-abc.css.gz (remainder)
  mkdirSync(join(root, 'css'), { recursive: true })
  writeFileSync(join(root, 'css', 'index-abc.css.gz'), Buffer.alloc(4 * 1024))
}

describe('classifyBucket', () => {
  it('classifies index.html as entry', () => {
    expect(classifyBucket('index.html.gz')).toBe('entry')
    expect(classifyBucket('index.html')).toBe('entry')
  })
  it('classifies js/index-*.js as entry', () => {
    expect(classifyBucket('js/index-HASH.js.gz')).toBe('entry')
  })
  it('classifies js/element-plus-*.js as element-plus', () => {
    expect(classifyBucket('js/element-plus-HASH.js.gz')).toBe('element-plus')
  })
  it('classifies js/vue-vendor-*.js as vue-ecosystem', () => {
    expect(classifyBucket('js/vue-vendor-HASH.js.gz')).toBe('vue-ecosystem')
  })
  it('classifies js/vendor-*.js as remainder', () => {
    expect(classifyBucket('js/vendor-HASH.js.gz')).toBe('remainder')
  })
  it('classifies named view chunks (lazy routes) as routes', () => {
    expect(classifyBucket('js/PolicyList-HASH.js.gz')).toBe('routes')
    expect(classifyBucket('js/MainLayout-HASH.js.gz')).toBe('routes')
    expect(classifyBucket('js/auth-HASH.js.gz')).toBe('routes')
  })
  it('classifies css as remainder', () => {
    expect(classifyBucket('css/index-HASH.css.gz')).toBe('remainder')
  })
  it('classifies unknown non-js as remainder', () => {
    expect(classifyBucket('fonts/icon-HASH.woff2.gz')).toBe('remainder')
  })
})

describe('collectGzFiles', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gz-budget-'))
    makeDist(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  it('collects all .gz files sorted', () => {
    const files = collectGzFiles(dir)
    expect(files).toContain('index.html.gz')
    expect(files).toContain('js/index-abc.js.gz')
    expect(files).toContain('js/element-plus-xyz.js.gz')
    expect(files).toContain('js/vue-vendor-abc.js.gz')
    expect(files).toContain('js/vendor-abc.js.gz')
    expect(files).toContain('css/index-abc.css.gz')
    // sorted
    const sorted = [...files].sort()
    expect(files).toEqual(sorted)
  })
  it('returns empty for non-existent dir', () => {
    expect(collectGzFiles(join(dir, 'nope'))).toEqual([])
  })
})

describe('summarizeGz + checkBudget', () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gz-budget-'))
    makeDist(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('sums bytes per bucket and total', () => {
    const s = summarizeGz(dir)
    expect(s.buckets.entry.bytes).toBe(1000 + 5 * 1024)
    expect(s.buckets['element-plus'].bytes).toBe(10 * 1024)
    expect(s.buckets['vue-ecosystem'].bytes).toBe(3 * 1024)
    expect(s.buckets.remainder.bytes).toBe(2 * 1024 + 4 * 1024)
    expect(s.buckets.routes.bytes).toBe(0)
    const expectedTotal = 1000 + 5 * 1024 + 10 * 1024 + 3 * 1024 + 2 * 1024 + 4 * 1024
    expect(s.totalBytes).toBe(expectedTotal)
  })

  it('passes when all buckets within budget', () => {
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(true)
    expect(r.failures).toEqual([])
  })

  it('fails when entry bucket exceeds 60KB', () => {
    writeFileSync(join(dir, 'js', 'index-huge.js.gz'), Buffer.alloc(70 * 1024))
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'entry')).toBe(true)
  })

  it('fails when element-plus exceeds 140KB', () => {
    writeFileSync(join(dir, 'js', 'element-plus-huge.js.gz'), Buffer.alloc(150 * 1024))
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'element-plus')).toBe(true)
  })

  it('fails when vue-ecosystem exceeds 50KB', () => {
    writeFileSync(join(dir, 'js', 'vue-vendor-huge.js.gz'), Buffer.alloc(55 * 1024))
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'vue-ecosystem')).toBe(true)
  })

  it('fails when remainder exceeds 50KB', () => {
    writeFileSync(join(dir, 'js', 'vendor-huge.js.gz'), Buffer.alloc(60 * 1024))
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'remainder')).toBe(true)
  })

  it('fails when routes exceeds 90KB', () => {
    writeFileSync(join(dir, 'js', 'PolicyList-huge.js.gz'), Buffer.alloc(95 * 1024))
    const s = summarizeGz(dir)
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'routes')).toBe(true)
  })

  it('fails when total exceeds 300KB even if each bucket ok', () => {
    // 让四桶各接近上限但总和超 300
    const dir2 = mkdtempSync(join(tmpdir(), 'gz-total-'))
    try {
      writeFileSync(join(dir2, 'index.html.gz'), Buffer.alloc(1))
      mkdirSync(join(dir2, 'js'), { recursive: true })
      mkdirSync(join(dir2, 'css'), { recursive: true })
      writeFileSync(join(dir2, 'js', 'index-x.js.gz'), Buffer.alloc(60 * 1024)) // entry 60
      writeFileSync(join(dir2, 'js', 'element-plus-x.js.gz'), Buffer.alloc(140 * 1024)) // ep 140
      writeFileSync(join(dir2, 'js', 'vue-vendor-x.js.gz'), Buffer.alloc(50 * 1024)) // vue 50
      writeFileSync(join(dir2, 'js', 'vendor-x.js.gz'), Buffer.alloc(51 * 1024)) // remainder 51 → remainder 桶也会超
      const s = summarizeGz(dir2)
      const r = checkBudget(s)
      expect(r.passed).toBe(false)
      expect(r.failures.some((f) => f.scope === 'total')).toBe(true)
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('Hard Rule: total over 300KB always fails', () => {
    expect(TOTAL_LIMIT_KB).toBe(300)
    expect(BUDGETS.entry.limit).toBe(60)
    expect(BUDGETS['element-plus'].limit).toBe(140)
    expect(BUDGETS['vue-ecosystem'].limit).toBe(50)
    expect(BUDGETS.routes.limit).toBe(90)
    expect(BUDGETS.remainder.limit).toBe(50)
  })

  it('formatReport renders OK status', () => {
    const s = summarizeGz(dir)
    const report = formatReport(s)
    expect(report).toContain('gzip 预算报告')
    expect(report).toContain('OK')
    expect(report).toContain('300 KB')
  })

  it('formatReport renders OVER when over', () => {
    writeFileSync(join(dir, 'js', 'index-huge.js.gz'), Buffer.alloc(70 * 1024))
    const s = summarizeGz(dir)
    const report = formatReport(s)
    expect(report).toContain('OVER')
  })
})

// 失效保护（审计 Tier 2 修复）：原实现只统计 .gz，dist 无 .gz 时 0 KB 全过 →
// 「✅ 通过」误判。checkBudget 现在必须对「无 .gz 产物」直接判 fail。
describe('失效保护：无 .gz 产物时闸门必须 fail', () => {
  it('checkBudget fails when dist exists but has no .gz files', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gz-empty-'))
    try {
      // 建一个空 dist 目录（无任何 .gz）——模拟误用 vite build（无 generate-gz）的产物
      const s = summarizeGz(empty)
      expect(s.files).toEqual([])
      expect(s.totalBytes).toBe(0)
      const r = checkBudget(s)
      expect(r.passed).toBe(false)
      expect(r.failures.some((f) => f.scope === 'no-gz-files')).toBe(true)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('checkBudget fails when dist dir does not exist', () => {
    const missing = join(tmpdir(), 'gz-definitely-missing-' + process.pid)
    const s = summarizeGz(missing)
    expect(s.files).toEqual([])
    const r = checkBudget(s)
    expect(r.passed).toBe(false)
    expect(r.failures.some((f) => f.scope === 'no-gz-files')).toBe(true)
  })

  it('no-gz failure short-circuits (no bucket failures listed alongside)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gz-empty-sc-'))
    try {
      const r = checkBudget(summarizeGz(empty))
      // 短路：只应有 no-gz-files 一个失败，不附带空桶的「超限」噪音
      expect(r.failures).toHaveLength(1)
      expect(r.failures[0].scope).toBe('no-gz-files')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
