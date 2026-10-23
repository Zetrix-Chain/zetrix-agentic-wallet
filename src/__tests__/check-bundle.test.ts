import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The build refuses a bundle that carries a path from the machine that built it. The 0.17.0 wallet bundle and the 0.8.1
 * plugin bundle shipped with the builder's user folder in their module comments, because node_modules was reached through a
 * link to another folder. This runs the real script against small files.
 */
const script = join(import.meta.dirname, '..', '..', 'scripts', 'check-bundle.mjs')

function check(content: string): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'check-bundle-'))
  const file = join(dir, 'bundle.cjs')
  try {
    writeFileSync(file, content)
    try {
      const out = execFileSync(process.execPath, [script, file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, output: out }
    } catch (e) {
      const err = e as { status?: number; stderr?: string; stdout?: string }
      return { code: err.status ?? 1, output: `${err.stderr ?? ''}${err.stdout ?? ''}` }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('check-bundle', () => {
  it('passes a bundle with only relative module paths', () => {
    const { code, output } = check('// node_modules/ajv/dist/compile/index.js\nvar x = 1\n// ../shared/util.js\n')
    expect(code).toBe(0)
    expect(output).toMatch(/no local paths/)
  })

  it.each([
    ['a path that climbs into a Windows user folder', '// ../../Users/someone/Desktop/project/node_modules/ajv/dist/index.js'],
    ['a path that climbs further out', '// ../../../Users/someone/Desktop/project/node_modules/x/index.js'],
    ['an absolute Windows path', 'var p = "C:\\\\Users\\\\someone\\\\project"'],
    ['an absolute forward-slash Windows path', 'var p = "C:/Users/someone/project"'],
    ['a macOS home path', 'var p = "/Users/someone/project/node_modules/x"'],
    ['a Linux home path', '// ../../home/someone/project/node_modules/x/index.js'],
  ])('fails on %s', (_name, line) => {
    const { code, output } = check(`var ok = 1\n${line}\n`)
    expect(code).toBe(1)
    expect(output).toMatch(/carries a path from the machine that built it/)
    expect(output).toMatch(/line 2/)
    expect(output).toMatch(/npm ci/)
  })

  it('does not trip on the word users or home in ordinary text', () => {
    const { code } = check('var s = "list of users"\n// the home page\nvar t = "/api/users/me"\n')
    expect(code).toBe(0)
  })
})
