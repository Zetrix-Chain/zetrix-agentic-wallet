/**
 * Path resolution, split out so it is testable without a live gateway.
 *
 * `api.rootDir` is the only writable location OpenClaw exposes to a plugin — there is no
 * `pluginDataDir`, `dataDir` or storage API on OpenClaw 2026.7.1-2. It resolves to
 * `<gatewayStateDir>/extensions/<pluginId>`, which gives us everything else by walking up.
 */

import { join } from 'node:path'

export interface PluginPaths {
  /** The gateway's state directory, e.g. ~/.openclaw — holds openclaw.json. */
  gatewayStateDir: string
  /** The gateway config we register into. */
  configPath: string
  /**
   * Sidecar marking that we created the mcp.servers entry. Deliberately OUTSIDE the plugin directory.
   * It first lived inside, and a `plugins install --force` wiped it — after which the plugin saw its
   * own entry as subscriber-owned and refused to manage it, orphaning the entry on every update.
   */
  ownershipPath: string
  /** Where our home directory sits: `<gatewayStateDir>/zetrix-agentic-wallet`. */
  homeDir: string
  /** The wallet runtime, copied out of the plugin to a stable location. See `walletBundlePath`. */
  runtimeDir: string
  /** The runtime as shipped inside the plugin, i.e. the copy source. */
  shippedRuntimeDir: string
  /**
   * Where the wallet keeps `account.json` and its VC cache. Deliberately OUTSIDE the plugin
   * directory: it holds the holder identity and the generated HSM password, and a plugin update
   * replaces the plugin directory. State kept inside would be destroyed by an upgrade, taking the
   * wallet's only signing credential with it.
   */
  walletStateDir: string
  /**
   * The wallet the `mcp.servers` entry points at — inside `runtimeDir`, **not** inside the plugin.
   *
   * The wallet is vendored into the plugin because `openclaw plugins install` is a directory copy, not
   * an npm install (tested on 2026.7.1-2: a declared dependency produced no `node_modules` in the
   * installed copy). But pointing the config entry *at the plugin's own copy* would mean an uninstall
   * leaves an entry aimed at a deleted file — a broken MCP server the subscriber cannot attribute to
   * anything. OpenClaw exposes no uninstall hook a plugin can use to tidy up: `api.lifecycle` offers
   * only `registerRuntimeLifecycle`, and a disabled plugin is not loaded at all, so nothing of ours
   * can ever run at removal time.
   *
   * So the runtime is copied out to a stable location on registration. An orphaned entry then still
   * *works* — the worst case becomes a wallet that keeps functioning after its plugin is gone, which
   * a subscriber can remove with one `openclaw mcp unset` when they choose to.
   */
  walletBundlePath: string
}

export function resolvePluginPaths(rootDir: string): PluginPaths {
  const gatewayStateDir = join(rootDir, '..', '..')
  const homeDir = join(gatewayStateDir, 'zetrix-agentic-wallet')
  const runtimeDir = join(homeDir, 'runtime')
  return {
    gatewayStateDir,
    configPath: join(gatewayStateDir, 'openclaw.json'),
    ownershipPath: join(homeDir, '.mcp-registration.json'),
    homeDir,
    runtimeDir,
    shippedRuntimeDir: join(rootDir, 'dist', 'runtime'),
    walletStateDir: join(homeDir, 'state'),
    walletBundlePath: join(runtimeDir, 'server-bundle.cjs'),
  }
}
