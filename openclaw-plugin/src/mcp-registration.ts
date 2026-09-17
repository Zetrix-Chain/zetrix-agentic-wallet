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
 * Is this cap the refuse-all value plugin <=0.3.2 planted, rather than a limit anyone chose?
 *
 * That version defaulted the cap to `{"*":"0"}` in two places — the value written into the entry, and
 * a `configSchema` default OpenClaw materialises into subscriber config (SPIKE-0.4-FINDINGS.md §2.1).
 * Both were dropped in 0.3.3, but an upgrade removes neither from a gateway that already has them, and
 * an explicit cap — even one that permits nothing — shadows the wallet's own network-aware default.
 * The result was a 0 JMYR limit nobody set, on the current plugin, with no way for a hosted subscriber
 * to clear it. Observed on a live gateway, September 2026.
 *
 * An empty object counts too: it is "configured" as far as the wallet is concerned, and refuses
 * everything for the same reason.
 *
 * A refuse-all cap that NAMES an asset (`{"*":"0","JMYR":"0"}`) is still forwarded — nothing ever
 * generated that shape, so it can only have been typed deliberately. That is how to express "refuse
 * everything" now that the bare value is read as a leftover.
 */
function isLegacyRefuseAllCap(caps: Record<string, string>): boolean {
  const keys = Object.keys(caps)
  return keys.length === 0 || (keys.length === 1 && keys[0] === '*' && caps['*'] === '0')
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
      ZETRIX_NETWORK: config.network ?? 'zetrix:testnet',
      // Deliberately absent when unconfigured, rather than defaulted here.
      //
      // The wallet's own default is network-aware — testnet allows exactly the credential fee,
      // mainnet refuses everything, because the cap is per call and nothing limits how many calls
      // are made. This layer cannot know the network at config time, so anything sent from here
      // would shadow that and pin every subscriber to one behaviour.
      //
      // The manifest declares no `default` for the same reason: OpenClaw materialises configSchema
      // defaults into plugin config with no operator action (SPIKE-0.4-FINDINGS.md §2.1), so a
      // declared default would arrive here as a real value and never reach this branch.
      ...(config.maxPaymentAmount && !isLegacyRefuseAllCap(config.maxPaymentAmount)
        ? { MAX_PAYMENT_AMOUNT: JSON.stringify(config.maxPaymentAmount) }
        : {}),
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

/**
 * Is `existing` an entry THIS plugin wrote in an older version, still carrying the legacy refuse-all
 * cap? Both halves matter: the entry must launch the wallet runtime we manage (so it cannot be a
 * subscriber's own server that happens to share the name), and its cap must be the exact value
 * `isLegacyRefuseAllCap` describes. A real limit is left alone whatever its fingerprint says — a
 * subscriber's ceiling is theirs, and silently raising one is the failure direction that matters.
 */
function carriesLegacyCap(existing: McpServerEntry, ours: McpServerEntry): boolean {
  if (existing.command !== ours.command || existing.args?.[0] !== ours.args[0]) return false
  const raw = existing.env?.MAX_PAYMENT_AMOUNT
  if (typeof raw !== 'string') return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    return isLegacyRefuseAllCap(parsed as Record<string, string>)
  } catch {
    return false
  }
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
    if (!carriesLegacyCap(existing, entry)) {
      deps.log(
        `mcp.servers["${SERVER_NAME}"] is already present and was not created by this plugin (or was ` +
          `changed since) — leaving it untouched. Remove it if you want the plugin to manage the server.`,
      )
      return
    }
    // The one exception to "never touch an entry we do not own". This entry IS ours — it launches the
    // wallet runtime this plugin installs — and the only reason ownership stopped matching is that an
    // older version wrote it with a different fingerprint. Declining to touch it is exactly what left
    // upgraded subscribers pinned to a 0 JMYR limit, unfixable on a gateway they cannot shell into.
    deps.log(
      `mcp.servers["${SERVER_NAME}"] still carried the refuse-all spending limit an older version of ` +
        `this plugin wrote. Removing it so the wallet's own default applies — set a limit in plugin ` +
        `config if you want a different one.`,
    )
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
