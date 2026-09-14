import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolvePluginPaths } from '../src/paths.js'

const ROOT = join('C:', 'Users', 'x', '.openclaw', 'extensions', 'zetrix-agentic-wallet')
const p = resolvePluginPaths(ROOT)

describe('resolvePluginPaths', () => {
  it('derives the gateway config two levels above the plugin root', () => {
    expect(p.configPath).toBe(join('C:', 'Users', 'x', '.openclaw', 'openclaw.json'))
  })

  it('keeps the ownership sidecar OUTSIDE the plugin, so an update cannot orphan the entry', () => {
    expect(p.ownershipPath).toBe(join('C:', 'Users', 'x', '.openclaw', 'zetrix-agentic-wallet', '.mcp-registration.json'))
    expect(p.ownershipPath.startsWith(ROOT)).toBe(false)
  })

  it('keeps wallet state OUTSIDE the plugin, so a plugin update cannot destroy the account', () => {
    expect(p.walletStateDir).toBe(join('C:', 'Users', 'x', '.openclaw', 'zetrix-agentic-wallet', 'state'))
    expect(p.walletStateDir.startsWith(ROOT)).toBe(false)
  })

  it('points the config entry at a stable runtime OUTSIDE the plugin, so uninstall leaves a working server not a broken one', () => {
    expect(p.walletBundlePath).toBe(join('C:', 'Users', 'x', '.openclaw', 'zetrix-agentic-wallet', 'runtime', 'server-bundle.cjs'))
    expect(p.walletBundlePath.startsWith(ROOT)).toBe(false)
  })

  it('works for a non-default profile directory too', () => {
    const dev = resolvePluginPaths(join('C:', 'Users', 'x', '.openclaw-dev', 'extensions', 'zetrix-agentic-wallet'))
    expect(dev.configPath).toBe(join('C:', 'Users', 'x', '.openclaw-dev', 'openclaw.json'))
    expect(dev.walletStateDir).toBe(join('C:', 'Users', 'x', '.openclaw-dev', 'zetrix-agentic-wallet', 'state'))
  })
})
