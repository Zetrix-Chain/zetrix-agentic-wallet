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
  /** Sidecar recording that we created the entry. */
  ownershipPath: string
  readFile: (path: string) => string
  writeFile: (path: string, contents: string) => void
  exists: (path: string) => boolean
  removeFile: (path: string) => void
  log: (message: string) => void
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

/** True when the sidecar says this plugin created the entry. */
function weOwnIt(deps: RegistrationDeps): boolean {
  return deps.exists(deps.ownershipPath)
}

export function registerServer(deps: RegistrationDeps, entry: McpServerEntry): void {
  const config = readConfig(deps)
  if (!config) return

  const existing = config.mcp?.servers?.[SERVER_NAME]
  if (existing && !weOwnIt(deps)) {
    deps.log(
      `mcp.servers["${SERVER_NAME}"] is already present and was not created by this plugin — ` +
        `leaving it untouched. Remove it if you want the plugin to manage the server instead.`,
    )
    return
  }

  config.mcp = config.mcp ?? {}
  config.mcp.servers = config.mcp.servers ?? {}
  config.mcp.servers[SERVER_NAME] = entry

  deps.writeFile(deps.configPath, `${JSON.stringify(config, null, 2)}\n`)
  deps.writeFile(
    deps.ownershipPath,
    `${JSON.stringify({ serverName: SERVER_NAME, note: 'Created by the Zetrix Agentic Wallet plugin. Deleting this file makes the plugin treat the mcp.servers entry as subscriber-owned.' }, null, 2)}\n`,
  )
  deps.log(existing ? `refreshed mcp.servers["${SERVER_NAME}"]` : `registered mcp.servers["${SERVER_NAME}"]`)
}

/**
 * Remove the entry on disable/uninstall — the caveat the spike's probe did not handle. An orphaned
 * entry pointing at a bundle inside a deleted plugin directory is a broken MCP server in the
 * subscriber's config with no plugin left to blame for it.
 */
export function unregisterServer(deps: RegistrationDeps): void {
  if (!weOwnIt(deps)) return

  const config = readConfig(deps)
  if (!config) return

  if (config.mcp?.servers && SERVER_NAME in config.mcp.servers) {
    delete config.mcp.servers[SERVER_NAME]
    deps.writeFile(deps.configPath, `${JSON.stringify(config, null, 2)}\n`)
    deps.log(`removed mcp.servers["${SERVER_NAME}"]`)
  }
  deps.removeFile(deps.ownershipPath)
}
