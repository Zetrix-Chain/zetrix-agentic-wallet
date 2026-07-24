/**
 * VcCacheStore — local filesystem cache of issued VCs, keyed by templateId, so
 * `subscribe_and_issue` can skip paying + re-issuing for a credential the holder
 * already has. One JSON file per templateId; the caller (index.ts) is responsible
 * for scoping the base directory per network + holder, so different identities or
 * networks never share a cache.
 *
 * Filenames are a sha256 hash of templateId, not the templateId itself — a real
 * templateId is a `did:zid:...` string, and `:` is not a valid filename character
 * on Windows.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface CachedVc {
  templateId: string
  vc: unknown
  vcId?: string
  txHash?: string
  paidAsset?: string
  amountPaid?: string
  issuedAt: string
  /** From the VC's own `validUntil`, or the `expirationDate` requested at issuance. Absent = no known expiry. */
  validUntil?: string
}

export interface VcCacheStore {
  get(templateId: string): Promise<CachedVc | null>
  set(templateId: string, entry: CachedVc): Promise<void>
  list(): Promise<CachedVc[]>
}

function cacheFileName(templateId: string): string {
  return `${createHash('sha256').update(templateId).digest('hex')}.json`
}

/** Minimal shape check so a truncated/corrupt cache file is treated as a cache miss, not served as a credential. */
function isCachedVcShape(value: unknown): value is CachedVc {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).templateId === 'string' &&
    'vc' in value &&
    typeof (value as Record<string, unknown>).issuedAt === 'string'
  )
}

export function createFsVcCache(baseDir: string): VcCacheStore {
  return {
    async get(templateId) {
      try {
        const raw = await readFile(join(baseDir, cacheFileName(templateId)), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isCachedVcShape(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async set(templateId, entry) {
      // Owner-only: cached VCs carry credentialSubject claims (potential PII), so the
      // directory and file must not be world/group-readable.
      await mkdir(baseDir, { recursive: true, mode: 0o700 })
      await writeFile(join(baseDir, cacheFileName(templateId)), JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 })
    },

    async list() {
      let files: string[]
      try {
        files = await readdir(baseDir)
      } catch {
        return []
      }
      const entries = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => {
            try {
              const parsed: unknown = JSON.parse(await readFile(join(baseDir, f), 'utf8'))
              return isCachedVcShape(parsed) ? parsed : null
            } catch {
              return null
            }
          }),
      )
      return entries.filter((e): e is CachedVc => e !== null)
    },
  }
}

/**
 * True if `entry` has no known expiry, or its expiry is still in the future. Fails **closed**
 * on a malformed date — this gates whether a payment is skipped, so an unparseable expiry is
 * treated as expired (forcing re-issuance) rather than trusted indefinitely.
 */
export function isVcValid(entry: Pick<CachedVc, 'validUntil'>, now: Date = new Date()): boolean {
  if (!entry.validUntil) return true
  const expiry = new Date(entry.validUntil)
  if (Number.isNaN(expiry.getTime())) return false
  return expiry.getTime() > now.getTime()
}

/** Reads a freshly-issued VC's own `validUntil`, falling back to the expiry requested at issuance. */
export function extractValidUntil(vc: unknown, fallback?: string): string | undefined {
  if (typeof vc === 'object' && vc !== null && 'validUntil' in vc) {
    const v = (vc as Record<string, unknown>).validUntil
    if (typeof v === 'string') return v
  }
  return fallback
}
