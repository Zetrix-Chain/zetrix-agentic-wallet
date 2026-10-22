/**
 * AccountStore — persists the holder HSM account (zetrixAddress/holderDid/hsmPassword)
 * created via create_holder_account or first-run auto-create, so it survives a server
 * restart without requiring the user to hand-edit their MCP host's config file (whose path
 * this stdio-spawned process can't reliably discover — see onboard.ts). An explicit
 * `ZETRIX_ADDRESS`/`HSM_PASSWORD` from env always takes precedence over this store (see
 * index.ts); this is purely a convenience fallback for the account this MCP itself created.
 *
 * The password is the same one the human already supplied (to create_holder_account, or via
 * env on first run) — this module never generates or invents one, only caches it for reuse.
 * It's still a plaintext secret at rest, same as it already is in the MCP host's own env
 * config; the file is owner-only (0600) to match that risk level, not exceed it.
 *
 * The file holds the only copy of an account's signing password, so nothing here replaces one silently:
 * a file that cannot be read is reported as unreadable rather than as absent, a new file is created
 * exclusively, and an overwrite that would change the account keeps the old content beside it.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredAccount {
  zetrixAddress: string
  holderDid: string
  hsmPassword: string
  label?: string
  purpose?: string
  /** The network this account belongs to. Absent on an account saved before accounts were kept per network. */
  network?: string
  createdAt: string
}

export interface AccountStore {
  get(): Promise<StoredAccount | null>
  set(account: StoredAccount): Promise<void>
}

/** Minimal shape check so a truncated/corrupt store file is never mistaken for an account. */
function isStoredAccountShape(value: unknown): value is StoredAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).zetrixAddress === 'string' &&
    typeof (value as Record<string, unknown>).holderDid === 'string' &&
    typeof (value as Record<string, unknown>).hsmPassword === 'string'
  )
}

/** What a read of an account file found. `unreadable` is NOT `absent`: the file is there and may hold a recoverable password. */
export type AccountRead =
  | { kind: 'absent' }
  | { kind: 'ok'; account: StoredAccount }
  | { kind: 'unreadable'; reason: string }

export async function readAccountFile(filePath: string): Promise<AccountRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', reason: `${code ?? 'read error'}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unreadable', reason: 'it is not valid JSON' }
  }
  return isStoredAccountShape(parsed) ? { kind: 'ok', account: parsed } : { kind: 'unreadable', reason: 'it has no address, DID or password' }
}

/**
 * Creates the file only if it does not exist yet. Returns false when it already did, so the caller can use what is
 * there instead of replacing it.
 */
export async function createAccountFileExclusive(filePath: string, account: StoredAccount): Promise<boolean> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  try {
    await writeFile(filePath, JSON.stringify(account, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

export function createFsAccountStore(filePath: string): AccountStore {
  return {
    async get() {
      const read = await readAccountFile(filePath)
      return read.kind === 'ok' ? read.account : null
    },

    async set(account) {
      // Owner-only: the stored address/DID identify the holder, so the directory and file
      // must not be world/group-readable.
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      // An overwrite that changes what the file holds keeps the old content beside it: it may be the only copy of an
      // account's signing password.
      const existing = await readFile(filePath, 'utf8').catch(() => null)
      const next = JSON.stringify(account, null, 2)
      if (existing !== null && existing !== next) {
        await copyFile(filePath, `${filePath}.replaced-${Date.now()}`)
      }
      await writeFile(filePath, next, { encoding: 'utf8', mode: 0o600 })
    },
  }
}
