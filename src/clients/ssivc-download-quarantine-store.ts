/**
 * DownloadQuarantineStore — persists MBI's `/v1/vc/ext/download` raw response BEFORE any
 * validation (subject match, `validUntil` presence, vcId lookup).
 *
 * SEC-11 / APP-C01: the download is one-shot — a second live call for the same `vcId` returns 404,
 * not the credential again (see docs/verified-birthcert-vc/SPEC.md §5.4 REQ-25). A validation
 * rejection, a `cache.set` failure, or a process crash between download and cache must never
 * destroy a credential that was already paid for and fetched. Writing the raw response here,
 * immediately after it's received, means `checkAiBirthcertVerification` can always re-validate from
 * this local copy instead of re-hitting MBI — and a human can recover the raw entries from disk even
 * if every automated path rejects them.
 *
 * R2-M01: keyed by `vcId`, one file per vcId (mirroring `vc-cache.ts`'s per-templateId files), NOT a
 * single shared slot. With a single slot, quarantining agent 2's download would silently destroy
 * agent 1's still-needed preserved credential. Entries are never expired or cleaned up — a
 * quarantined credential is paid-for and irrecoverable once deleted, so files living forever is the
 * deliberate conservative choice.
 *
 * Filenames are a sha256 hash of the vcId, not the vcId itself — a real vcId is a `did:zid:...`
 * string, and `:` is not a valid filename character on Windows.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface QuarantinedDownload {
  /** The vcId this download was fetched for — lets a later call recognize "already have this one". */
  vcId: string
  /** The raw, unvalidated entries array from MBI's response — every entry, not just the matched one. */
  entries: unknown
  downloadedAt: string
}

export interface DownloadQuarantineStore {
  get(vcId: string): Promise<QuarantinedDownload | null>
  set(entry: QuarantinedDownload): Promise<void>
  /** The concrete on-disk path a given vcId's raw response lives at — surfaced in operator-facing error messages. */
  filePathFor(vcId: string): string
}

/** sha256 of the vcId — see the module docstring on why the raw vcId can't be a filename. */
export function quarantineFileName(vcId: string): string {
  return `${createHash('sha256').update(vcId).digest('hex')}.json`
}

function isQuarantinedDownloadShape(value: unknown): value is QuarantinedDownload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.vcId === 'string' && 'entries' in v && typeof v.downloadedAt === 'string'
}

export function createFsDownloadQuarantineStore(baseDir: string): DownloadQuarantineStore {
  const pathFor = (vcId: string) => join(baseDir, quarantineFileName(vcId))
  return {
    filePathFor: pathFor,

    async get(vcId) {
      try {
        const raw = await readFile(pathFor(vcId), 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isQuarantinedDownloadShape(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async set(entry) {
      // Write-then-rename, same as ssivc-session-store.ts — a crash mid-write must never leave a
      // torn file that reads as "nothing quarantined" right when the recovery copy is needed most.
      await mkdir(baseDir, { recursive: true, mode: 0o700 })
      const filePath = pathFor(entry.vcId)
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmpPath, JSON.stringify(entry, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmpPath, filePath)
    },
  }
}
