/**
 * PresentedNonceStore: the verifier challenges (nonces) this wallet has already answered, so it never answers the same one twice.
 *
 * An x401 challenge carries a one-time nonce. A resource server, or anything that can hand the agent a PROOF-REQUEST, could ask the same
 * nonce again to get a second presentation signed for it. So the first answer claims the nonce and a second one is refused, whatever the
 * holder's key would have signed.
 *
 * A claim is given back (`release`) only when the presentation failed before the holder was asked to sign anything: nothing was produced for
 * that nonce, so the challenge may still be answered. Once the signature has been asked for the claim stays, even if the call or a later step
 * failed (the signing service may have signed); the agent asks the resource for a fresh challenge.
 *
 * ONE FILE PER CLAIM, CREATED EXCLUSIVELY. A claim is a file named by the SHA-256 of the nonce, created with `wx` (create, fail if it exists).
 * The operating system lets exactly one creator win, so two wallet processes sharing a state directory (every Claude Code session starts its
 * own) cannot both claim the same nonce, and no process can erase another's claim by writing over a shared file. The file holds only the time
 * of the claim, written with owner-only permissions. Nothing secret is stored: not the nonce, a key, a password or a signature.
 *
 * A claim expires after a time to live (24 hours: a verifier's challenge is long dead by then). Expired claims are removed by a sweep, which
 * runs on the first claim and then every so many claims, and past a cap removes the oldest. An existing claim ALWAYS refuses the same nonce:
 * nothing replaces a claim on the claim path, because two processes that both found it expired could each replace it and both win. A nonce does
 * not legitimately come back after a day, so a claim that has not been swept yet refusing it is the right answer.
 *
 * FAILS CLOSED. A claim file that cannot be created for any reason other than "it exists" THROWS naming the path: the caller refuses to
 * present, because guessing "not claimed" is how a challenge would be answered twice. A claim file whose content is not a time is still a
 * claim (the sweep dates it by its modification time), never an absent one.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface PresentedNonceStore {
  /** True: the nonce is now claimed. False: it was already claimed (answered). Throws when the record cannot be trusted. */
  claim(nonce: string): Promise<boolean>
  /** Gives a claim back, because nothing was signed for it. Not claimed is fine. Throws when the claim cannot be removed. */
  release(nonce: string): Promise<void>
}

export interface PresentedNonceStoreOptions {
  /** How long a claim is kept (default 24 hours). */
  ttlMs?: number
  /** The most claims kept after a sweep; beyond it the oldest go (default 5000). */
  maxEntries?: number
  /** Epoch milliseconds; the clock claims are dated and expired by. */
  now?: () => number
  /** A sweep runs on the first claim and then after this many claims (default 100). */
  sweepEvery?: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 5000
const DEFAULT_SWEEP_EVERY = 100
const CLAIM_FILE = /^[0-9a-f]{64}$/

const hashOf = (nonce: string): string => createHash('sha256').update(nonce, 'utf8').digest('hex')
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code

export function createFsPresentedNonceStore(dir: string, options: PresentedNonceStoreOptions = {}): PresentedNonceStore {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const now = options.now ?? Date.now
  const sweepEvery = options.sweepEvery ?? DEFAULT_SWEEP_EVERY
  let sinceSweep = Number.POSITIVE_INFINITY // so the first claim sweeps

  /** When the claim at `path` was made: its content when that is a time, otherwise its modification time. Throws when it cannot be read. */
  async function claimedAt(path: string): Promise<number> {
    try {
      const n = Number((await readFile(path, 'utf8')).trim())
      if (Number.isFinite(n) && n > 0) return n
      return (await stat(path)).mtimeMs
    } catch (e) {
      if (code(e) === 'ENOENT') return Number.NEGATIVE_INFINITY // removed meanwhile: treat as expired, the caller retries the create
      throw new Error(`presented-nonce claim ${path} cannot be read (${(e as Error).message}); delete it if it is stale`)
    }
  }

  /** Creates the claim file; false when it already exists. Any other failure throws. */
  async function create(path: string): Promise<boolean> {
    let handle
    try {
      handle = await open(path, 'wx', 0o600)
    } catch (e) {
      if (code(e) === 'EEXIST') return false
      throw new Error(`presented-nonce claim ${path} cannot be created (${(e as Error).message})`)
    }
    try {
      await handle.writeFile(String(now()))
    } finally {
      await handle.close()
    }
    return true
  }

  /** Removes expired claims and, past the cap, the oldest. Best effort: a failure here never decides a claim. */
  async function sweep(): Promise<void> {
    try {
      const entries: Array<{ path: string; at: number }> = []
      for (const name of await readdir(dir)) {
        if (!CLAIM_FILE.test(name)) continue
        const path = join(dir, name)
        try {
          entries.push({ path, at: await claimedAt(path) })
        } catch {
          // an unreadable claim is left alone: it still counts as a claim
        }
      }
      const cutoff = now() - ttlMs
      const live = entries.filter((e) => e.at > cutoff)
      await Promise.all(entries.filter((e) => e.at <= cutoff).map((e) => unlink(e.path).catch(() => undefined)))
      if (live.length > maxEntries) {
        const oldest = live.sort((a, b) => a.at - b.at).slice(0, live.length - maxEntries)
        await Promise.all(oldest.map((e) => unlink(e.path).catch(() => undefined)))
      }
    } catch {
      // the directory could not be listed: nothing to sweep
    }
  }

  return {
    async claim(nonce) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, hashOf(nonce))
      // Created exclusively: the operating system lets one creator win. An existing claim refuses, whatever its age.
      if (!(await create(path))) return false
      if (++sinceSweep >= sweepEvery) {
        sinceSweep = 0
        await sweep()
      }
      return true
    },

    async release(nonce) {
      const path = join(dir, hashOf(nonce))
      await unlink(path).catch((e) => {
        if (code(e) !== 'ENOENT') throw new Error(`presented-nonce claim ${path} cannot be removed (${(e as Error).message})`)
      })
    },
  }
}
