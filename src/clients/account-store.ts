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
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredAccount {
  zetrixAddress: string
  holderDid: string
  hsmPassword: string
  label?: string
  purpose?: string
  createdAt: string
}

export interface AccountStore {
  get(): Promise<StoredAccount | null>
  set(account: StoredAccount): Promise<void>
}

/** Minimal shape check so a truncated/corrupt store file is treated as "no stored account". */
function isStoredAccountShape(value: unknown): value is StoredAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).zetrixAddress === 'string' &&
    typeof (value as Record<string, unknown>).holderDid === 'string' &&
    typeof (value as Record<string, unknown>).hsmPassword === 'string'
  )
}

export function createFsAccountStore(filePath: string): AccountStore {
  return {
    async get() {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isStoredAccountShape(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async set(account) {
      // Owner-only: the stored address/DID identify the holder, so the directory and file
      // must not be world/group-readable.
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      await writeFile(filePath, JSON.stringify(account, null, 2), { encoding: 'utf8', mode: 0o600 })
    },
  }
}
