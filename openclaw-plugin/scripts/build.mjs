/**
 * Build the plugin: bundle its own code, then vendor the wallet as ONE self-contained file.
 *
 * Why vendor at all: `openclaw plugins install` is a **directory copy**, not an npm install. Tested
 * on 2026.7.1-2 — a `dependencies` entry in the plugin's package.json produced no `node_modules` in
 * the installed copy, and `files` was ignored. So anything the plugin needs at runtime must already
 * be inside the directory. This also delivers the concept doc's goal: no registry access at install
 * or at runtime.
 *
 * Why a single bundle rather than a real `npm install` tree — and this was the second attempt.
 * Vendoring an npm-installed tree is more faithful, because the wallet publishes with
 * `zetrix-sdk-nodejs` external and that is the configuration it is tested in. But it produced a
 * tarball of ~8,250 files that **OpenClaw cannot install**:
 *
 *     failed to extract archive: Error: extract tar timed out after 120000ms
 *
 * A tarball is how ClawHub ships, so an unextractable package is fatal, not merely slow. Bundling
 * everything into one ~3.4 MB file extracts instantly.
 *
 * The risk that argued against this is real and must stay tested: bundling rewrites the SDK's module
 * graph, so a lazy `require` inside a transitive dependency (protobufjs) could fail only here, and
 * only at call time rather than at load. `npm test` in this package therefore includes a live check
 * that an SDK-dependent tool call works through the bundle, not just that it loads.
 */

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// zetrix-sdk-nodejs's proto._buildOperation does `require(`./operation/${type}`)` with no
// extension. esbuild bundles that dynamic require into a static glob-require map, but keys that
// map with the resolved file names INCLUDING their extension (e.g. "./operation/payCoin.js").
// At runtime the lookup is done with the extension-less string from the template literal, so it
// never matches the map (unlike Node's real require, which tries appending .js on a miss) — every
// on-chain operation build inside the bundle throws "Operation cannot be resolved".
// Fix: rewrite the require call at load time so the string handed to esbuild's glob-require
// already carries the .js extension the generated map key expects.
const fixZetrixSdkGlobRequire = {
  name: 'fix-zetrix-sdk-glob-require',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /zetrix-sdk-nodejs[\\/]lib[\\/]common[\\/]util\.js$/ }, ({ path }) => {
      const original = readFileSync(path, 'utf8')
      const patched = original.replace(
        'require(`./operation/${type}`)(data);',
        'require(`./operation/${type}.js`)(data);',
      )
      if (patched === original) {
        throw new Error(
          `fix-zetrix-sdk-glob-require: expected pattern not found in ${path} — ` +
            'zetrix-sdk-nodejs may have changed; update this plugin.',
        )
      }
      return { contents: patched, loader: 'js' }
    })
  },
}

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const walletRoot = join(pluginRoot, '..')

const walletPkg = JSON.parse(readFileSync(join(walletRoot, 'package.json'), 'utf8'))
const walletBundle = join(walletRoot, 'dist', 'server-bundle.cjs')

if (!existsSync(walletBundle)) {
  console.error(`error: wallet bundle not found at ${walletBundle}\nRun "npm run build" in the repo root first.`)
  process.exit(1)
}

// 1. The plugin's own code. Only uses node: builtins, so this bundles to a single self-contained file.
mkdirSync(join(pluginRoot, 'dist'), { recursive: true })
await build({
  entryPoints: [join(pluginRoot, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: join(pluginRoot, 'dist', 'index.js'),
})

// 2. Vendor the wallet as one self-contained file: NO externals, so the SDK and all 163 of its
// transitive dependencies are inlined. This is what keeps the tarball extractable (see docblock).
const runtimeDir = join(pluginRoot, 'dist', 'runtime')
rmSync(runtimeDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })

await build({
  entryPoints: [join(walletRoot, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: join(runtimeDir, 'server-bundle.cjs'),
  plugins: [fixZetrixSdkGlobRequire],
})

// 3. Record what was vendored — name@version AND a content hash.
//
// The hash is load-bearing, not decoration. The plugin only re-copies its runtime when this file's
// contents differ, and `name@version` alone does not change between two builds of the same wallet
// version. That silently shipped a stale runtime: a plugin carrying a rebuilt wallet installed
// cleanly and kept the previous bundle, because both said `agentic-wallet-mcp@0.6.1`. Hashing the
// bundle makes any content change visible, including an unreleased fix or a rebuild.
const bundlePath = join(runtimeDir, 'server-bundle.cjs')
const digest = createHash('sha256').update(readFileSync(bundlePath)).digest('hex')
writeFileSync(join(runtimeDir, 'VERSION'), `${walletPkg.name}@${walletPkg.version}\nsha256:${digest}\n`, 'utf8')

const bytes = statSync(bundlePath).size
console.log(
  `built plugin; vendored ${walletPkg.name}@${walletPkg.version} as a single ${(bytes / 1024 / 1024).toFixed(1)} MB bundle`,
)
