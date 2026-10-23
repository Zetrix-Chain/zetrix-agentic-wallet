/**
 * Fails the build when a bundle carries a path from the machine that built it.
 *
 * esbuild writes the path of every bundled module into a comment. When node_modules is reached through a link
 * (a junction or symlink to another folder), those comments hold the real path, which includes the builder's user name
 * and folders. That happened in the 0.17.0 wallet bundle and the 0.8.1 plugin bundle: 449 and 995 lines naming a local
 * user folder, published to npm and ClawHub. A bundle built in a checkout with its own node_modules has only relative
 * paths such as node_modules/ajv/dist/...
 *
 * Usage: node scripts/check-bundle.mjs <file> [<file> ...]
 */

import { readFileSync } from 'node:fs'

/** A path that starts at a user's home folder, in either slash style, or climbs out of the project into one. */
export const LOCAL_PATH = /(?:[A-Za-z]:[\\/]+|(?:\.\.[\\/]+)+|[\\/])(?:Users|home)[\\/]+[^\\/\s"'`)]+/

/** The first lines of text that carry such a path, with their line numbers. */
export function findLocalPaths(text, limit = 3) {
  const found = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && found.length < limit; i++) {
    const m = LOCAL_PATH.exec(lines[i])
    if (m) found.push({ line: i + 1, match: m[0] })
  }
  return found
}

const isMain = typeof process.argv[1] === 'string' && /check-bundle\.mjs$/.test(process.argv[1])
if (isMain) {
  const files = process.argv.slice(2)
  let failed = false
  for (const file of files) {
    const hits = findLocalPaths(readFileSync(file, 'utf8'))
    if (hits.length > 0) {
      failed = true
      console.error(`${file}: carries a path from the machine that built it:`)
      for (const h of hits) console.error(`  line ${h.line}: ${h.match}`)
    }
  }
  if (failed) {
    console.error(
      'Build in a checkout whose node_modules is a real folder inside it (npm ci), not a link to another folder, then build again.',
    )
    process.exit(1)
  }
  console.log(`checked ${files.length} bundle(s): no local paths`)
}
