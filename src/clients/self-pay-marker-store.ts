/**
 * SelfPayMarkerStore — a note that a self-paid policy write has been SENT and its outcome is not settled.
 *
 * A self-paid write is signed and submitted by this wallet itself. When the node's answer never arrives, the transaction may or may not
 * be on chain, and the only thing this wallet could do was refuse to say. Without a record, a repeat call could only look at the chain, and
 * a transaction that landed just after that look could be followed by a second one. So the wallet writes one note per (owner, policy key)
 * BEFORE it submits: the nonce, the transaction hash, and the ledger after which the transaction can no longer be included
 * (`ceilLedgerSeq`, set on the transaction itself). A repeat call reads the note first: while the transaction can still land it does not
 * send; once it has landed, failed or can no longer land, the note is cleared.
 *
 * NO SECRET MATERIAL, EVER: nothing here is a password, a signature or a blob. One file per note, written to a temp file, fsynced and renamed
 * with owner-only permissions.
 *
 * FAILS CLOSED. Only a file that does not exist means "no note". A file that cannot be read, or is empty, truncated, not JSON or not a valid
 * note (what a crash leaves behind) THROWS, naming the file: the caller refuses to send, because reading it as "no note" is exactly how a
 * second transaction would be sent on top of the first. A person can delete the named file once a send can no longer be in flight (60 ledgers
 * after the file was last changed: at least 15 minutes, with the chain producing ledgers) or once get_my_policy shows the write; get_my_policy
 * alone cannot show a send still in flight.
 *
 * ONE PROCESS. Compare-and-delete here is read-then-unlink. Every caller that clears a note holds the per-key lock of its own process, so within
 * one process nothing can write a newer note between the two steps. Two wallet processes sharing one state directory have no lock between them;
 * that is accepted, and the second send is still bounded by the nonce.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export interface SelfPayMarker {
  policyKey: string
  ownerAddress: string
  operation: 'CREATE' | 'UPDATE'
  /** The transaction nonce it was sent with. */
  nonce: string
  /** SHA-256 of the transaction blob: the hash the node uses. */
  txHash: string
  /** The last ledger the transaction can be included in (digits). After it, it can never land. */
  ceilLedgerSeq: string
  /** ISO 8601 timestamp of the send. Context for a human, never used to expire anything. */
  submittedAt: string
}

export interface SelfPayMarkerStore {
  /** The note, or `null` when there is none. THROWS when a note exists and cannot be trusted (see the file docblock). */
  get(ownerAddress: string, policyKey: string): Promise<SelfPayMarker | null>
  /** Throws when it cannot be written: the caller must not send in that case. */
  set(marker: SelfPayMarker): Promise<void>
  /**
   * Removes the note. With `expectedTxHash` it removes ONLY a note for that transaction (compare-and-delete), so a call that read an older note
   * can never delete a newer one. Already gone is fine; any other failure throws.
   */
  remove(ownerAddress: string, policyKey: string, expectedTxHash?: string): Promise<void>
}

export function markerFileName(ownerAddress: string, policyKey: string): string {
  return `${createHash('sha256').update(`${ownerAddress}\n${policyKey}`).digest('hex')}.json`
}

/** A ledger number or a nonce: at most 18 digits, which is what the rest of the wallet reads as a ledger. */
const DIGITS = /^\d{1,18}$/
const HEX64 = /^[0-9a-fA-F]{64}$/
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

function isRealDate(iso: string): boolean {
  const t = Date.parse(iso)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso.slice(0, 10)
}

export function isMarkerShape(value: unknown): value is SelfPayMarker {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.policyKey === 'string' &&
    v.policyKey !== '' &&
    typeof v.ownerAddress === 'string' &&
    v.ownerAddress !== '' &&
    (v.operation === 'CREATE' || v.operation === 'UPDATE') &&
    typeof v.nonce === 'string' &&
    DIGITS.test(v.nonce) &&
    typeof v.txHash === 'string' &&
    HEX64.test(v.txHash) &&
    typeof v.ceilLedgerSeq === 'string' &&
    DIGITS.test(v.ceilLedgerSeq) &&
    typeof v.submittedAt === 'string' &&
    ISO_8601.test(v.submittedAt) &&
    isRealDate(v.submittedAt)
  )
}

const DIRECTORY_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'ENOSYS', 'EBADF'])

const errorCode = (e: unknown): string | undefined => (typeof e === 'object' && e !== null ? (e as { code?: string }).code : undefined)

function unreadable(file: string, why: string): Error {
  return new Error(
    `the note of an earlier self-paid send (${file}) cannot be trusted: ${why}. A send can still land for 60 ledgers: delete that file only once at least 15 minutes ` +
      `have passed since it was last changed and the chain is producing ledgers, or once get_my_policy shows the write`,
  )
}

export function createFsSelfPayMarkerStore(baseDir: string): SelfPayMarkerStore {
  const pathFor = (owner: string, key: string) => join(baseDir, markerFileName(owner, key))

  async function read(ownerAddress: string, policyKey: string): Promise<SelfPayMarker | null> {
    const file = pathFor(ownerAddress, policyKey)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return null
      throw unreadable(file, `it could not be read (${errorCode(e) ?? 'unknown error'})`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw unreadable(file, raw === '' ? 'it is empty' : 'it is not valid JSON')
    }
    // The file name is derived from the owner and key, but the content must agree with them too.
    if (!isMarkerShape(parsed) || parsed.ownerAddress !== ownerAddress || parsed.policyKey !== policyKey) {
      throw unreadable(file, 'it is not a valid note for this owner and key')
    }
    return parsed
  }

  return {
    get: read,

    async set(marker) {
      if (!isMarkerShape(marker)) throw new Error('refusing to save a malformed self-pay marker')
      await mkdir(baseDir, { recursive: true, mode: 0o700 })
      const filePath = pathFor(marker.ownerAddress, marker.policyKey)
      const tmpPath = `${filePath}.tmp-${randomUUID()}`
      try {
        const handle = await open(tmpPath, 'w', 0o600)
        try {
          await handle.writeFile(JSON.stringify(marker, null, 2), 'utf8')
          // The note must survive the host losing power right after the submit.
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(tmpPath, filePath)
      } catch (e) {
        await unlink(tmpPath).catch(() => undefined)
        throw e
      }
      try {
        const dir = await open(baseDir, 'r')
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
      } catch (e) {
        // Not every platform can fsync a directory (Windows cannot); the file itself is already synced. A real I/O error is not that.
        if (!DIRECTORY_FSYNC_UNSUPPORTED.has(errorCode(e) ?? '')) throw e
      }
    },

    async remove(ownerAddress, policyKey, expectedTxHash) {
      if (expectedTxHash !== undefined) {
        const current = await read(ownerAddress, policyKey)
        if (current === null || current.txHash !== expectedTxHash) return
      }
      try {
        await unlink(pathFor(ownerAddress, policyKey))
      } catch (e) {
        if (errorCode(e) !== 'ENOENT') throw e
      }
    },
  }
}
