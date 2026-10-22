// Regenerates docs/TOOLS.md from the tool definitions the server registers (buildToolList).
// Run: npm run docs:tools. A test fails when docs/TOOLS.md is stale.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Bundled inside the repo (git-ignored node_modules) so the bundle resolves the externals it requires.
const cache = join(root, 'node_modules', '.cache', 'docs-tools')
mkdirSync(cache, { recursive: true })
const out = join(cache, 'gen.cjs')

await build({
  stdin: {
    contents: `
      import { buildToolList } from './src/index'
      import { renderToolReference } from './src/tool-reference'
      module.exports = { render: () => renderToolReference(buildToolList()) }
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['zetrix-sdk-nodejs'],
  outfile: out,
  logLevel: 'error',
})

// index.ts starts the server unless NODE_ENV is 'test'; only the tool definitions are wanted here.
process.env.NODE_ENV = 'test'
const { render } = createRequire(import.meta.url)(out)
const target = join(root, 'docs', 'TOOLS.md')
writeFileSync(target, render(), 'utf8')
console.log('wrote', target)
