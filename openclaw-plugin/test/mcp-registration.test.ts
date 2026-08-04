import { describe, it, expect } from 'vitest'
import { buildServerEntry, registerServer, unregisterServer, SERVER_NAME } from '../src/mcp-registration.js'

const BUNDLE = 'C:/plugins/zetrix/node_modules/agentic-wallet-mcp/dist/server-bundle.cjs'
const STATE = 'C:/Users/x/.openclaw/zetrix-agentic-wallet'

/** In-memory filesystem so the registration logic is tested without touching a real config. */
function fakeFs(initial: Record<string, string> = {}) {
  const files = { ...initial }
  const logs: string[] = []
  return {
    files,
    logs,
    deps: {
      configPath: '/cfg/openclaw.json',
      ownershipPath: '/plugin/.mcp-registration.json',
      readFile: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT: ${p}`)
        return files[p]
      },
      writeFile: (p: string, c: string) => {
        files[p] = c
      },
      renameFile: (from: string, to: string) => {
        if (!(from in files)) throw new Error(`ENOENT: ${from}`)
        files[to] = files[from]
        delete files[from]
      },
      exists: (p: string) => p in files,
      removeFile: (p: string) => {
        delete files[p]
      },
      log: (m: string) => logs.push(m),
    },
  }
}

const entry = buildServerEntry(BUNDLE, { network: 'zetrix:testnet', maxPaymentAmount: { '*': '0' } }, STATE)

describe('buildServerEntry', () => {
  it('builds a stdio entry pointing at the packaged wallet bundle', () => {
    expect(entry.command).toBe('node')
    expect(entry.args).toEqual([BUNDLE])
  })

  it('passes the subscriber network and cap through as env', () => {
    expect(entry.env.ZETRIX_NETWORK).toBe('zetrix:testnet')
    expect(entry.env.MAX_PAYMENT_AMOUNT).toBe('{"*":"0"}')
  })

  it('points the wallet state directory outside the plugin, so a plugin update cannot destroy the wallet', () => {
    expect(entry.env.ZETRIX_WALLET_STATE_DIR).toBe(STATE)
    expect(entry.env.ZETRIX_WALLET_STATE_DIR).not.toContain('node_modules')
  })

  it('never puts a secret in the entry — the wallet generates its own password', () => {
    expect(JSON.stringify(entry)).not.toMatch(/password/i)
    expect(entry.env.HSM_PASSWORD).toBeUndefined()
  })

  it('falls back to testnet and a zero cap when the subscriber set nothing', () => {
    const e = buildServerEntry(BUNDLE, {}, STATE)
    expect(e.env.ZETRIX_NETWORK).toBe('zetrix:testnet')
    expect(e.env.MAX_PAYMENT_AMOUNT).toBe('{"*":"0"}')
  })

  it('includes ZETRIX_ADDRESS only when the subscriber pinned one', () => {
    expect(entry.env.ZETRIX_ADDRESS).toBeUndefined()
    expect(buildServerEntry(BUNDLE, { zetrixAddress: 'ZTX3Pinned' }, STATE).env.ZETRIX_ADDRESS).toBe('ZTX3Pinned')
  })
})

describe('registerServer', () => {
  it('writes the entry into an empty config and records ownership', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp.servers[SERVER_NAME].command).toBe('node')
    expect(files['/plugin/.mcp-registration.json']).toBeDefined()
  })

  it('preserves every other key in the config', () => {
    const { files, deps } = fakeFs({
      '/cfg/openclaw.json': JSON.stringify({ gateway: { mode: 'local' }, mcp: { servers: { other: { command: 'uvx' } } } }),
    })
    registerServer(deps, entry)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.gateway.mode).toBe('local')
    expect(cfg.mcp.servers.other.command).toBe('uvx')
  })

  it('does NOT overwrite an entry the subscriber created themselves', () => {
    const theirs = { command: 'node', args: ['their/own/path.js'] }
    const { files, deps, logs } = fakeFs({
      '/cfg/openclaw.json': JSON.stringify({ mcp: { servers: { [SERVER_NAME]: theirs } } }),
    })
    registerServer(deps, entry)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp.servers[SERVER_NAME]).toEqual(theirs)
    expect(files['/plugin/.mcp-registration.json']).toBeUndefined()
    expect(logs.join(' ')).toMatch(/already present/i)
  })

  it('refreshes its own entry when the subscriber changes config', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const changed = buildServerEntry(BUNDLE, { network: 'zetrix:mainnet', maxPaymentAmount: { ZTX: '500' } }, STATE)
    registerServer(deps, changed)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp.servers[SERVER_NAME].env.ZETRIX_NETWORK).toBe('zetrix:mainnet')
    expect(cfg.mcp.servers[SERVER_NAME].env.MAX_PAYMENT_AMOUNT).toBe('{"ZTX":"500"}')
  })

  it('does not crash the gateway when the config file is missing', () => {
    const { deps, logs } = fakeFs()
    expect(() => registerServer(deps, entry)).not.toThrow()
    expect(logs.join(' ')).toMatch(/could not/i)
  })

  it('does not crash the gateway when the config file is malformed', () => {
    const { deps, logs } = fakeFs({ '/cfg/openclaw.json': 'not json' })
    expect(() => registerServer(deps, entry)).not.toThrow()
    expect(logs.join(' ')).toMatch(/could not/i)
  })

  it('never writes a partial config — a failed parse leaves the file untouched', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': 'not json' })
    registerServer(deps, entry)
    expect(files['/cfg/openclaw.json']).toBe('not json')
  })
})

describe('unregisterServer', () => {
  it('removes the entry it created, and its ownership record', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    unregisterServer(deps)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp?.servers?.[SERVER_NAME]).toBeUndefined()
    expect(files['/plugin/.mcp-registration.json']).toBeUndefined()
  })

  it('leaves a subscriber-owned entry alone — no ownership record means not ours', () => {
    const theirs = { command: 'node', args: ['their/own/path.js'] }
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': JSON.stringify({ mcp: { servers: { [SERVER_NAME]: theirs } } }) })
    unregisterServer(deps)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp.servers[SERVER_NAME]).toEqual(theirs)
  })

  it('preserves other servers when removing its own', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': JSON.stringify({ mcp: { servers: { other: { command: 'uvx' } } } }) })
    registerServer(deps, entry)
    unregisterServer(deps)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    expect(cfg.mcp.servers.other.command).toBe('uvx')
  })

  it('is a no-op when nothing was ever registered', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    expect(() => unregisterServer(deps)).not.toThrow()
    expect(files['/cfg/openclaw.json']).toBe('{}')
  })
})

describe('security fixes', () => {
  it('writes the config atomically — via a temp file, never in place', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    const writes: string[] = []
    const spied = { ...deps, writeFile: (p: string, c: string) => { writes.push(p); deps.writeFile(p, c) } }
    registerServer(spied, entry)
    // A truncated openclaw.json stops the gateway starting at all, so the config is never the target
    // of a direct write: a temp file is written and renamed over it.
    expect(writes).toContain('/cfg/openclaw.json.zetrix-tmp')
    expect(writes).not.toContain('/cfg/openclaw.json')
    expect(files['/cfg/openclaw.json.zetrix-tmp']).toBeUndefined()
    expect(JSON.parse(files['/cfg/openclaw.json']).mcp.servers[SERVER_NAME]).toEqual(entry)
  })

  it('does not touch the config at all when the entry is already correct', () => {
    const { deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const writes: string[] = []
    const spied = { ...deps, writeFile: (p: string, c: string) => { writes.push(p); deps.writeFile(p, c) } }
    registerServer(spied, entry)
    // The hook runs on every gateway start and every CLI plugin load. Rewriting an identical config
    // each time is pure risk for no benefit.
    expect(writes).not.toContain('/cfg/openclaw.json.zetrix-tmp')
    expect(writes).toEqual(['/plugin/.mcp-registration.json'])
  })

  it('will not reclaim an entry the subscriber edited after we wrote it', () => {
    const { files, deps, logs } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)

    // Subscriber hand-edits the entry — e.g. repoints it at their own build.
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    cfg.mcp.servers[SERVER_NAME].args = ['/their/own/wallet.cjs']
    files['/cfg/openclaw.json'] = JSON.stringify(cfg)

    registerServer(deps, entry)
    // The marker still exists, so presence alone would have let us overwrite them. The fingerprint is
    // what stops it.
    expect(JSON.parse(files['/cfg/openclaw.json']).mcp.servers[SERVER_NAME].args).toEqual(['/their/own/wallet.cjs'])
    expect(logs.join(' ')).toMatch(/changed since/i)
  })

  it('still updates its own entry when the subscriber changes plugin config', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const changed = buildServerEntry(BUNDLE, { network: 'zetrix:mainnet' }, STATE)
    registerServer(deps, changed)
    expect(JSON.parse(files['/cfg/openclaw.json']).mcp.servers[SERVER_NAME].env.ZETRIX_NETWORK).toBe('zetrix:mainnet')
  })

  it('treats a corrupt ownership marker as "not ours" rather than assuming ownership', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    files['/plugin/.mcp-registration.json'] = 'not json'
    const theirs = { command: 'node', args: ['/theirs.cjs'], env: {} }
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    cfg.mcp.servers[SERVER_NAME] = theirs
    files['/cfg/openclaw.json'] = JSON.stringify(cfg)
    registerServer(deps, entry)
    expect(JSON.parse(files['/cfg/openclaw.json']).mcp.servers[SERVER_NAME]).toEqual(theirs)
  })

  it('unregister leaves an entry the subscriber has since edited', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const cfg = JSON.parse(files['/cfg/openclaw.json'])
    cfg.mcp.servers[SERVER_NAME].args = ['/their/own/wallet.cjs']
    files['/cfg/openclaw.json'] = JSON.stringify(cfg)
    unregisterServer(deps)
    expect(JSON.parse(files['/cfg/openclaw.json']).mcp.servers[SERVER_NAME]).toBeDefined()
  })

  it('records the entry as a fingerprint in the marker', () => {
    const { files, deps } = fakeFs({ '/cfg/openclaw.json': '{}' })
    registerServer(deps, entry)
    const marker = JSON.parse(files['/plugin/.mcp-registration.json'])
    expect(marker.entry).toEqual(entry)
    expect(marker.serverName).toBe(SERVER_NAME)
  })
})
