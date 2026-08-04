/**
 * Zetrix Agentic Wallet — OpenClaw plugin entry point.
 *
 * The plugin's whole job is to make the wallet's MCP server available without the subscriber
 * hand-writing an `mcp.servers` entry — which they cannot do at all on a hosted gateway they do not
 * own. It contributes no tools of its own; the wallet's seven tools come from the MCP server.
 *
 * Three findings from testing against OpenClaw 2026.7.1-2 shape this file:
 *
 *  1. The documented `mcpServers` manifest field silently contributes nothing on OpenClaw 2026.7.1-2,
 *     and native `api.registerTool` tools never reach a `claude-cli` harness. Writing the entry into
 *     `mcp.servers` is the only route that works, so that is what this does.
 *  2. `plugins install` is a directory copy, not an npm install, so the wallet must ship inside the
 *     plugin. But it is copied OUT to a stable location before being referenced, because…
 *  3. …OpenClaw exposes no uninstall hook. `api.lifecycle` offers only `registerRuntimeLifecycle`, and
 *     a disabled plugin is never loaded, so no cleanup code of ours can ever run. Pointing the config
 *     entry at the plugin's own directory would therefore leave a broken server behind on uninstall.
 *     Pointing it at a stable copy leaves a working one instead.
 *
 * Nothing here handles a secret. The wallet generates and stores its own HSM password, so there is no
 * credential to place in config, in the manifest, or in this code.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePluginPaths, type PluginPaths } from './paths.js'
import { buildServerEntry, registerServer, type PluginConfig, type RegistrationDeps } from './mcp-registration.js'

/** The subset of OpenClaw's plugin API this plugin uses. */
interface PluginApi {
  rootDir: string
  pluginConfig?: PluginConfig
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
}

function makeDeps(paths: PluginPaths, log: (m: string) => void): RegistrationDeps {
  return {
    configPath: paths.configPath,
    ownershipPath: paths.ownershipPath,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, c) => writeFileSync(p, c, { encoding: 'utf8', mode: 0o600 }),
    exists: (p) => existsSync(p),
    removeFile: (p) => rmSync(p, { force: true }),
    log,
  }
}

/**
 * Copy the shipped runtime out to its stable home, but only when the version differs — the copy is
 * ~160 packages and runs on every gateway start otherwise. The VERSION file written by the build
 * script is what makes the comparison cheap.
 */
function syncRuntime(paths: PluginPaths, log: (m: string) => void): boolean {
  const shippedVersionFile = join(paths.shippedRuntimeDir, 'VERSION')
  if (!existsSync(shippedVersionFile)) {
    log(`the plugin is missing its wallet runtime at ${paths.shippedRuntimeDir} — reinstall the plugin`)
    return false
  }
  const shipped = readFileSync(shippedVersionFile, 'utf8').trim()
  const installedVersionFile = join(paths.runtimeDir, 'VERSION')
  const installed = existsSync(installedVersionFile) ? readFileSync(installedVersionFile, 'utf8').trim() : null

  if (installed === shipped && existsSync(paths.walletBundlePath)) return true

  // VERSION is `name@version` plus a `sha256:` line. The hash is what makes two builds of the same
  // wallet version distinguishable — without it a rebuilt wallet was silently never installed.
  const describe = (v: string | null) => {
    if (!v) return 'none'
    const [nameVersion, hashLine = ''] = v.split('\n')
    const short = hashLine.replace('sha256:', '').slice(0, 12)
    return short ? `${nameVersion} (${short})` : nameVersion
  }

  try {
    mkdirSync(paths.homeDir, { recursive: true })
    rmSync(paths.runtimeDir, { recursive: true, force: true })
    cpSync(paths.shippedRuntimeDir, paths.runtimeDir, { recursive: true })
    log(
      installed
        ? `updated the wallet runtime: ${describe(installed)} -> ${describe(shipped)}`
        : `installed the wallet runtime ${describe(shipped)}`,
    )
    return true
  } catch (e) {
    log(`could not install the wallet runtime into ${paths.runtimeDir}: ${(e as Error).message}`)
    return false
  }
}

export function register(api: PluginApi): void {
  const paths = resolvePluginPaths(api.rootDir)
  // stderr, not stdout: stdout on a plugin-spawned process carries MCP protocol frames.
  const log = (m: string) => {
    const line = `zetrix-agentic-wallet: ${m}`
    if (api.logger?.info) api.logger.info(line)
    else process.stderr.write(`${line}\n`)
  }
  const deps = makeDeps(paths, log)

  if (!syncRuntime(paths, log)) {
    // Fail loudly but never throw: a plugin that crashes the gateway is worse than one that reports
    // it is unusable.
    log('the plugin is installed but cannot provide wallet tools')
    return
  }

  registerServer(deps, buildServerEntry(paths.walletBundlePath, api.pluginConfig ?? {}, paths.walletStateDir))
}

export default { register }
