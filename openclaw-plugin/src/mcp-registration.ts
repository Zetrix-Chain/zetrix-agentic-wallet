/**
 * Self-registration of the wallet's MCP server.
 *
 * OpenClaw documents `mcpServers` in the plugin manifest as the way a plugin contributes an MCP
 * server. On 2026.7.1-2 that silently does nothing — the declared server is never spawned and no
 * diagnostic is emitted. Native `api.registerTool` tools register but never reach a `claude-cli`
 * harness, so an agent cannot call them. What does work, verified end to end, is writing the entry a
 * human would otherwise type into `mcp.servers`. All three were verified against OpenClaw 2026.7.1-2.
 *
 * This mutates operator-authoritative config, so it is written to be conservative:
 *
 *  - An entry we did not create is NEVER overwritten. The subscriber's own config wins.
 *  - Ownership is recorded in a sidecar file beside the plugin. Its presence is the only thing that
 *    licenses us to modify or remove the entry later.
 *  - Every other config key survives, by round-tripping the parsed object.
 *  - A missing or malformed config is logged and skipped, never partially written. A plugin must not
 *    be able to corrupt the gateway's config or stop it starting.
 */

export const SERVER_NAME = 'zetrix-agentic-wallet'

/** Subscriber-facing settings, as validated by `configSchema` and delivered via `api.pluginConfig`. */
export interface PluginConfig {
  network?: string
  maxPaymentAmount?: Record<string, string>
  zetrixAddress?: string
}

export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

export interface RegistrationDeps {
  /** Path to the gateway's openclaw.json. */
  configPath: string
  /** Sidecar recording the entry we created, so we can tell ours from the subscriber's. */
  ownershipPath: string
  readFile: (path: string) => string
  writeFile: (path: string, contents: string) => void
  /**
   * Atomic move. Config is written to a temp file and renamed over the original, so a crash, a full
   * disk, or two plugin loads racing each other cannot leave a truncated `openclaw.json` behind — that
   * would stop the gateway starting at all, which is a far worse outcome than the wallet not working.
   * OpenClaw's own config writer guards against truncation with a size-drop check; writing the file
   * directly bypasses that guard, so we have to supply the equivalent ourselves.
   */
  renameFile: (from: string, to: string) => void
  exists: (path: string) => boolean
  removeFile: (path: string) => void
  log: (message: string) => void
}

/** What the ownership sidecar stores. `entry` is the fingerprint — see `weOwnIt`. */
interface OwnershipRecord {
  serverName: string
  entry?: McpServerEntry
  note: string
}

/**
 * Build the `mcp.servers` entry.
 *
 * `stateDir` must be OUTSIDE the plugin directory. The wallet stores its holder identity and its
 * generated HSM password there, and that password is the only thing that can authorize signing for
 * the account — a plugin update wipes the plugin directory, so state kept inside it would take the
 * wallet with it. Verified during the spike: our `ZETRIX_*` names do survive OpenClaw's env-key
 * filter when set here.
 *
 * No secret appears in this entry, and there is nowhere for one to go: the wallet generates and
 * stores its own password.
 */
export function buildServerEntry(walletBundlePath: string, config: PluginConfig, stateDir: string): McpServerEntry {
  return {
    command: 'node',
    args: [walletBundlePath],
    env: {
      // Fail-safe defaults, matching the wallet's own: testnet, and a cap that refuses everything.
      ZETRIX_NETWORK: config.network ?? 'zetrix:testnet',
      MAX_PAYMENT_AMOUNT: JSON.stringify(config.maxPaymentAmount ?? { '*': '0' }),
      ZETRIX_WALLET_STATE_DIR: stateDir,
      ...(config.zetrixAddress ? { ZETRIX_ADDRESS: config.zetrixAddress } : {}),
    },
  }
}

interface OpenclawConfig {
  mcp?: { servers?: Record<string, unknown> }
  [key: string]: unknown
}

function readConfig(deps: RegistrationDeps): OpenclawConfig | null {
  let raw: string
  try {
    raw = deps.readFile(deps.configPath)
  } catch (e) {
    deps.log(`could not read ${deps.configPath}: ${(e as Error).message} — skipping MCP registration`)
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      deps.log(`could not use ${deps.configPath}: not a JSON object — skipping MCP registration`)
      return null
    }
    return parsed as OpenclawConfig
  } catch (e) {
    deps.log(`could not parse ${deps.configPath}: ${(e as Error).message} — skipping MCP registration`)
    return null
  }
}

function readOwnership(deps: RegistrationDeps): OwnershipRecord | null {
  if (!deps.exists(deps.ownershipPath)) return null
  try {
    return JSON.parse(deps.readFile(deps.ownershipPath)) as OwnershipRecord
  } catch {
    // A corrupt marker must not be read as "we own this". Treat it as absent, which is the safe
    // direction: we leave the subscriber's entry alone rather than overwriting it.
    return null
  }
}

/**
 * Do we own the entry currently in the config?
 *
 * Presence of the marker is not enough. The marker lives outside the plugin so it survives updates
 * (inside, `install --force` wiped it and the plugin then disowned its own entry) — but surviving means
 * it also outlives an uninstall. Without a fingerprint the sequence
 *
 *   uninstall -> subscriber edits mcp.servers by hand -> reinstall
 *
 * would see the stale marker, assume ownership, and silently overwrite their edit. So the marker
 * records the entry we wrote, and we only claim ownership while the config still matches it. Any
 * divergence means someone changed it after us, and their version wins.
 */
function weOwnIt(deps: RegistrationDeps, existing: McpServerEntry | undefined): boolean {
  const record = readOwnership(deps)
  if (!record) return false
  if (!existing) return true
  // Older markers carry no fingerprint; fall back to presence so an upgrade does not disown itself.
  if (!record.entry) return true
  return JSON.stringify(record.entry) === JSON.stringify(existing)
}

function writeOwnership(deps: RegistrationDeps, entry: McpServerEntry): void {
  const record: OwnershipRecord = {
    serverName: SERVER_NAME,
    entry,
    note:
      'Created by the Zetrix Agentic Wallet plugin. The entry above is a fingerprint: the plugin only ' +
      'manages mcp.servers while the live entry still matches it, so a hand-edited entry is never ' +
      'overwritten. Deleting this file makes the plugin treat the entry as subscriber-owned.',
  }
  deps.writeFile(deps.ownershipPath, `${JSON.stringify(record, null, 2)}\n`)
}

/** Write the config atomically: temp file, then rename over the original. */
function writeConfigAtomically(deps: RegistrationDeps, config: OpenclawConfig): void {
  const tmp = `${deps.configPath}.zetrix-tmp`
  deps.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`)
  deps.renameFile(tmp, deps.configPath)
}

export function registerServer(deps: RegistrationDeps, entry: McpServerEntry): void {
  const config = readConfig(deps)
  if (!config) return

  const existing = config.mcp?.servers?.[SERVER_NAME] as McpServerEntry | undefined
  if (existing && !weOwnIt(deps, existing)) {
    deps.log(
      `mcp.servers["${SERVER_NAME}"] is already present and was not created by this plugin (or was ` +
        `changed since) — leaving it untouched. Remove it if you want the plugin to manage the server.`,
    )
    return
  }

  // Nothing to do when the live entry is already exactly what we would write. This is the common case
  // on every gateway start and every CLI plugin load, so skipping it removes almost all writes to the
  // subscriber's config — the less this plugin touches that file, the less it can break.
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    writeOwnership(deps, entry)
    return
  }

  config.mcp = config.mcp ?? {}
  config.mcp.servers = config.mcp.servers ?? {}
  config.mcp.servers[SERVER_NAME] = entry

  writeConfigAtomically(deps, config)
  writeOwnership(deps, entry)
  deps.log(existing ? `refreshed mcp.servers["${SERVER_NAME}"]` : `registered mcp.servers["${SERVER_NAME}"]`)
}

/**
 * Remove the entry on disable/uninstall — the caveat the spike's probe did not handle. An orphaned
 * entry pointing at a bundle inside a deleted plugin directory is a broken MCP server in the
 * subscriber's config with no plugin left to blame for it.
 */
export function unregisterServer(deps: RegistrationDeps): void {
  const config = readConfig(deps)
  if (!config) return

  const existing = config.mcp?.servers?.[SERVER_NAME] as McpServerEntry | undefined
  if (!weOwnIt(deps, existing)) return

  if (config.mcp?.servers && SERVER_NAME in config.mcp.servers) {
    delete config.mcp.servers[SERVER_NAME]
    writeConfigAtomically(deps, config)
    deps.log(`removed mcp.servers["${SERVER_NAME}"]`)
  }
  deps.removeFile(deps.ownershipPath)
}
