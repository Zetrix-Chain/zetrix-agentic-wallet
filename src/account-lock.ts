/**
 * A lock around creating a wallet account, so two processes starting at once on a fresh state folder do not both
 * create one. Each creation mints an account on Wallet BE and writes its password to the network's account file;
 * without the lock the second write wins and the first account is orphaned with no password anywhere.
 *
 * The process that gets the lock creates the account. A process that finds the lock taken waits for the account
 * file to appear and uses that account instead. A lock whose holder crashed is recognised by its age and removed.
 */

import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StoredAccount } from './clients/account-store.js'

export interface CreationLockDeps {
  /** Creates the lock file exclusively. False when it already exists. */
  tryCreate(): Promise<boolean>
  /** How old the lock file is, or null when it is not there. */
  ageMs(): Promise<number | null>
  remove(): Promise<void>
  /** The account file this lock protects, once someone has written it. Nothing while it is absent or half-written. */
  readAccount(): Promise<StoredAccount | null>
  sleep(ms: number): Promise<void>
}

export type CreationLock = { kind: 'acquired'; release: () => Promise<void> } | { kind: 'found'; account: StoredAccount }

export class CreationLockTimeoutError extends Error {
  constructor(lockName: string, waitedMs: number) {
    super(
      `Another wallet process has been creating an account for ${Math.round(waitedMs / 1000)}s and has not finished. ` +
        `If none is running, delete ${lockName} in the wallet's state folder and restart.`,
    )
    this.name = 'CreationLockTimeoutError'
  }
}

export interface CreationLockOptions {
  lockName: string
  pollMs?: number
  waitMs?: number
  /** A lock older than this was left by a process that died. */
  staleMs?: number
}

export async function acquireCreationLock(deps: CreationLockDeps, opts: CreationLockOptions): Promise<CreationLock> {
  const pollMs = opts.pollMs ?? 500
  const waitMs = opts.waitMs ?? 45_000
  const staleMs = opts.staleMs ?? 120_000
  let waited = 0
  for (;;) {
    const existing = await deps.readAccount()
    if (existing) return { kind: 'found', account: existing }

    if (await deps.tryCreate()) {
      // The other process may have finished between the read and taking the lock.
      const settled = await deps.readAccount()
      if (settled) {
        await deps.remove()
        return { kind: 'found', account: settled }
      }
      return { kind: 'acquired', release: () => deps.remove() }
    }

    const age = await deps.ageMs()
    if (age !== null && age > staleMs) {
      await deps.remove()
      continue
    }
    if (waited >= waitMs) throw new CreationLockTimeoutError(opts.lockName, waited)
    await deps.sleep(pollMs)
    waited += pollMs
  }
}

export function createFsCreationLock(
  lockPath: string,
  readAccount: () => Promise<StoredAccount | null>,
  sleep: (ms: number) => Promise<void>,
): CreationLockDeps {
  return {
    async tryCreate() {
      await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
      try {
        await writeFile(lockPath, String(process.pid), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      }
    },
    async ageMs() {
      try {
        return Date.now() - (await stat(lockPath)).mtimeMs
      } catch {
        return null
      }
    },
    async remove() {
      await unlink(lockPath).catch(() => undefined)
    },
    readAccount,
    sleep,
  }
}
