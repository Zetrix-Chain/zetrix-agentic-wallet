/**
 * The CI gate. These tests exist to stop a published plugin from disagreeing with itself — a skill
 * naming a tool the server does not expose, a manifest pointing at a file that isn't shipped, or
 * install instructions leaking into a skill that loads after installation is already complete.
 *
 * The wallet's tool list is read from the wallet's own source, so adding or renaming a tool there
 * fails these tests until the skill and manifest are updated with it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const pluginRoot = join(import.meta.dirname, '..')
const walletRoot = join(pluginRoot, '..')

const manifest = JSON.parse(readFileSync(join(pluginRoot, 'openclaw.plugin.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
// Normalised: the repo checks out CRLF on Windows, and none of these assertions are about newlines.
const skill = readFileSync(join(pluginRoot, 'skills', 'zetrix-agentic-wallet', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')

/** The seven tool names the wallet actually exposes, read from its tool descriptors. */
const walletToolNames = (() => {
  const src = readFileSync(join(walletRoot, 'src', 'index.ts'), 'utf8')
  return [...src.matchAll(/^\s{6}name: '([a-z_]+)',$/gm)].map((m) => m[1])
})()

describe('the wallet tool list is readable', () => {
  it('finds exactly the seven tools', () => {
    expect(walletToolNames.sort()).toEqual([
      'create_holder_account',
      'get_template_schema',
      'pay_and_fetch',
      'prove_identity',
      'query_contract',
      'subscribe_and_issue',
      'wallet_status',
    ])
  })
})

describe('manifest', () => {
  it('declares the required id and configSchema', () => {
    expect(manifest.id).toBe('zetrix-agentic-wallet')
    expect(manifest.configSchema?.type).toBe('object')
  })

  it('uses the same id as the MCP server name, so tool names are predictable', () => {
    // Tool names reach the agent as mcp__<server>__<tool>. Keeping the plugin id and the server name
    // identical is what makes the prefix knowable.
    const { SERVER_NAME } = require('../src/mcp-registration.ts') as never
    expect(manifest.id).toBe('zetrix-agentic-wallet')
    expect(SERVER_NAME ?? 'zetrix-agentic-wallet').toBe(manifest.id)
  })

  it('declares the bundled skill directory, and it exists', () => {
    expect(manifest.skills).toEqual(['./skills/zetrix-agentic-wallet'])
    expect(existsSync(join(pluginRoot, 'skills', 'zetrix-agentic-wallet', 'SKILL.md'))).toBe(true)
  })

  it('sets activation.onStartup deliberately', () => {
    expect(typeof manifest.activation?.onStartup).toBe('boolean')
  })

  it('defaults to testnet and a zero payment cap', () => {
    expect(manifest.configSchema.properties.network.default).toBe('zetrix:testnet')
    expect(manifest.configSchema.properties.maxPaymentAmount.default).toEqual({ '*': '0' })
  })

  it('declares no secret in configSchema — the wallet generates its own password', () => {
    const keys = Object.keys(manifest.configSchema.properties)
    expect(keys.some((k) => /password|secret|key$/i.test(k))).toBe(false)
  })

  it('does NOT declare mcpServers', () => {
    // It silently contributes nothing on OpenClaw 2026.7.1-2, and declaring it
    // alongside self-registration would risk a duplicate entry if it is ever fixed upstream.
    // Removing this assertion is the deliberate signal that the manifest route has been re-tested.
    expect(manifest.mcpServers).toBeUndefined()
  })
})

describe('package metadata', () => {
  it('declares both the source and the built entry point', () => {
    // `extensions` is the source entry; `runtimeExtensions` is the built JS and is preferred when
    // loading an npm package. Shipping only `extensions` risks the wrong file being loaded.
    expect(pkg.openclaw.extensions).toEqual(['./src/index.ts'])
    expect(pkg.openclaw.runtimeExtensions).toEqual(['./dist/index.js'])
  })

  it('declares OpenClaw compatibility metadata', () => {
    expect(pkg.openclaw.compat?.pluginApi).toBeTruthy()
    expect(pkg.openclaw.build?.openclawVersion).toBeTruthy()
  })

  it('ships the manifest, the skill and dist', () => {
    for (const f of ['dist', 'skills', 'openclaw.plugin.json']) expect(pkg.files).toContain(f)
  })

  it('points public metadata at the GitHub mirror, never the internal host', () => {
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\//)
    expect(pkg.repository.url).toMatch(/^https:\/\/github\.com\//)
    // The internal GitLab host specifically — the company name in `author` is legitimate and
    // matches the wallet package. This metadata is visible on the public npm page.
    expect(JSON.stringify(pkg)).not.toMatch(/git\.myeg|myeg\.com\.my/i)
  })
})

describe('the build script', () => {
  const buildScript = readFileSync(join(pluginRoot, 'scripts', 'build.mjs'), 'utf8')

  it('vendors the wallet as CJS, never ESM', () => {
    // Load-bearing, and verified the hard way. The SDK and its transitive dependencies use dynamic
    // `require`, which esbuild cannot express in ESM output — an ESM bundle dies at first use with
    // "Dynamic require of \"buffer\" is not supported". CJS keeps `require` native and both
    // account.getInfo and the protobufjs-heavy contract.call work. If this assertion ever fails,
    // the vendored wallet is broken at call time even though it loads.
    const walletBuild = buildScript.slice(buildScript.indexOf('// 2. Vendor the wallet'))
    expect(walletBuild).toMatch(/format:\s*'cjs'/)
    expect(walletBuild).not.toMatch(/format:\s*'esm'/)
  })

  it('records a content hash in VERSION, not just name@version', () => {
    // Found by testing an actual rebuild. The plugin only re-copies its runtime when VERSION's
    // contents differ, and `name@version` is identical between two builds of the same wallet version.
    // A plugin carrying a rebuilt wallet therefore installed cleanly and kept the OLD bundle:
    // the fix was in the tarball and never reached the runtime the MCP entry points at. Hashing the
    // bundle is what makes a rebuild visible.
    expect(buildScript).toMatch(/createHash\('sha256'\)/)
    expect(buildScript).toMatch(/sha256:\$\{digest\}/)
  })

  it('vendors a single file, because a many-file tarball cannot be installed', () => {
    // An npm-installed tree of ~8,250 files produced a tarball OpenClaw refused:
    // "failed to extract archive: Error: extract tar timed out after 120000ms".
    // Asserted on executable code rather than text, since the docblock legitimately discusses npm.
    const code = buildScript.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/child_process|execFileSync/)
    expect(code).toMatch(/server-bundle\.cjs/)
  })
})

describe('SKILL.md', () => {
  it('names only tools the wallet actually exposes', () => {
    const mentioned = [...skill.matchAll(/`([a-z_]{4,})`/g)].map((m) => m[1])
    const toolish = mentioned.filter((n) => n.includes('_') && !n.startsWith('mcp__'))
    const unknown = toolish.filter(
      (n) => !walletToolNames.includes(n) && !['not_activated', 'resource_payment', 'export_credentials'].includes(n),
    )
    expect(unknown).toEqual([])
  })

  it('mentions every paid tool, so neither can be used without the spend rules', () => {
    for (const t of ['pay_and_fetch', 'subscribe_and_issue']) expect(skill).toContain(t)
  })

  it('contains no install or host-configuration instructions', () => {
    // Installation is complete by the time the skill loads; telling the agent to install anything is
    // both useless and a host-execution risk. Prohibitions are exempt — the skill SHOULD say "do not
    // run openclaw mcp set", so lines that forbid are stripped before scanning. Anything left is an
    // instruction rather than a rule.
    const instructions = skill
      .split('\n')
      .filter((line) => !/\b(do not|don't|never|cannot)\b/i.test(line))
      .join('\n')
    expect(instructions).not.toMatch(/openclaw mcp set|npm install|openclaw plugins install/)
    // The one permitted `npx` is the credential-backup command the user runs themselves.
    expect(instructions).not.toMatch(/\bnpx\b(?!\s+agentic-wallet-mcp export-credentials)/)
  })

  it('forbids handling secrets rather than merely omitting the topic', () => {
    expect(skill).toMatch(/never request, display, log or pass an HSM password/i)
  })

  it('tells the agent the cap is the boundary and not to retry around it', () => {
    expect(skill).toMatch(/do not retry/i)
    expect(skill).toMatch(/cap/i)
  })

  it('carries the frontmatter OpenClaw needs', () => {
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toMatch(/^name: zetrix-agentic-wallet$/m)
    expect(skill).toMatch(/^description: >/m)
  })
})
