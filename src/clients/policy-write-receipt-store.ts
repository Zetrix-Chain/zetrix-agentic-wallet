/**
 * PolicyWriteReceiptStore — the bookmark for a policy write that has been PAID FOR but not yet
 * collected.
 *
 * The agent stores a bookmark, not the truth. ms-zetrix holds the authoritative row: what was paid
 * for, what is to be written, and what state it is in. All this file keeps is enough to come back
 * and ask — `blobId`, `policyKey`, `ownerAddress`, and when it was taken.
 *
 * NO SECRET MATERIAL, EVER. Not the HSM password, not the signature, not the blob.
 * Phase 3 does require `ownerHsmPassword` on the wire — the permit is signed at the moment of
 * writing and `hsm.key_registry` will not release the key without it — but that password comes from
 * session configuration at call time and never passes through this store. If one of these files
 * leaks, all it reveals is that a write is pending.
 *
 * ONE FILE PER RECEIPT, NOT ONE FILE TOTAL. This is the R2-M01 lesson from
 * `ssivc-download-quarantine-store.ts`, and it matters more here than it did there: two policy
 * writes can legitimately be in flight at once (different keys, or the same key retried after a
 * void receipt), and a single shared slot would let the second one destroy the first one's
 * bookmark — for a write the user has already paid for.
 *
 * LOSING A BOOKMARK IS EMBARRASSING, NOT EXPENSIVE. The server-side reconciler completes the write
 * anyway, so the money is not wasted and the policy still appears; the agent simply will not know.
 * And if it tries again, phase 1 answers 409 BEFORE any payment — either `ALREADY_EXISTS` because
 * the write landed, or `ALREADY_IN_FLIGHT` handing the original receipt straight back. So the
 * worst case is a wallet that has to be told what it already bought, never a second charge.
 *
 * Entries are never expired here. A receipt is paid-for and its money is unrecoverable once the
 * bookmark is gone, so files living forever is the deliberate conservative choice — the same call
 * the quarantine store makes, for the same reason.
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Which paid write a receipt pays for. */
export type PolicyWriteOperation = 'CREATE' | 'UPDATE'

/**
 * What the chain should show once the paid write has landed. Saved with the receipt so that, when the collect step answers with
 * an error that says nothing about the write (a gateway timeout), the wallet can read the chain and see for itself, instead of
 * leaving the agent to ask again and spend one of the service's few collect retries.
 */
export interface PolicyWriteVerify {
  /** The attributes as submitted (raw values), exactly what the policy should hold. */
  attributes: Array<{ attributeName: string; value: string }>
  /** For an UPDATE: the policy's `updatedAtBlock` before it, so "the same attributes" is not mistaken for a no-op. */
  priorUpdatedAtBlock?: string
  /** The template the write was made against, so a later write of the same values to another template is not mistaken for this one. */
  templateId?: string
}

export interface PolicyWriteReceipt {
  /** The `X-PAYMENT-RECEIPT` value from phase 2. The only identifier phase 3 accepts. */
  blobId: string
  /** The key this write would create. Carried so a caller can say WHICH write is pending. */
  policyKey: string
  /**
   * The owner this receipt was bought for. Phase 3 sends it, and ms-zetrix checks it against the
   * recorded attempt — "the receipt identifies the write, it does not authorise it" — so a wallet
   * that guessed here would be told the receipt does not exist rather than collecting someone
   * else's write.
   */
  ownerAddress: string
  /** ISO timestamp of the phase-2 202. Context for a human, never used to expire anything. */
  paidAt: string
  /**
   * Which write this receipt paid for, so `check_policy_write` collects it on the matching route. Absent on a receipt
   * saved before updates existed, which reads as a CREATE (see {@link operationOf}).
   */
  operation?: PolicyWriteOperation
  /** See {@link PolicyWriteVerify}. Absent on a receipt saved before this existed, or paid elsewhere: nothing can be verified. */
  verify?: PolicyWriteVerify
}

/** The write a receipt pays for. A receipt with no operation is a CREATE: that is all there was before updates. */
export function operationOf(receipt: PolicyWriteReceipt): PolicyWriteOperation {
  return receipt.operation ?? 'CREATE'
}

export interface PolicyWriteReceiptStore {
  get(blobId: string): Promise<PolicyWriteReceipt | null>
  set(receipt: PolicyWriteReceipt): Promise<void>
  /** Every pending receipt, newest first. `check_policy_write` with no argument resumes from these. */
  list(): Promise<PolicyWriteReceipt[]>
  /** Called ONLY once the write is finished — written, or the receipt provably bought nothing. */
  remove(blobId: string): Promise<void>
  /** The concrete path, for operator-facing messages when something has to be recovered by hand. */
  filePathFor(blobId: string): string
}

/**
 * sha256 of the blobId rather than the blobId itself.
 *
 * A blobId is server-generated and this wallet has no guarantee about its alphabet — the same
 * reasoning as the quarantine store, where a `did:zid:` identifier carried a `:` that Windows will
 * not accept in a filename. Hashing removes the question entirely.
 */
export function receiptFileName(blobId: string): string {
  return `${createHash('sha256').update(blobId).digest('hex')}.json`
}

/** Bounded and strict: a malformed `verify` is dropped, never trusted, and never allowed to make the receipt itself unreadable. */
export function isVerifyShape(value: unknown): value is PolicyWriteVerify {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.attributes) || v.attributes.length === 0 || v.attributes.length > 64) return false
  const names = new Set<string>()
  for (const a of v.attributes) {
    if (typeof a !== 'object' || a === null) return false
    const { attributeName, value: val } = a as Record<string, unknown>
    if (typeof attributeName !== 'string' || attributeName === '' || attributeName.length > 100 || names.has(attributeName)) return false
    if (typeof val !== 'string' || val.length > 4000) return false
    names.add(attributeName)
  }
  if (v.templateId !== undefined && (typeof v.templateId !== 'string' || v.templateId === '' || v.templateId.length > 200)) return false
  return v.priorUpdatedAtBlock === undefined || (typeof v.priorUpdatedAtBlock === 'string' && /^\d{1,30}$/.test(v.priorUpdatedAtBlock))
}

function withValidVerify(receipt: PolicyWriteReceipt): PolicyWriteReceipt {
  if (receipt.verify === undefined || isVerifyShape(receipt.verify)) return receipt
  const { verify: _dropped, ...rest } = receipt
  return rest
}

function isReceiptShape(value: unknown): value is PolicyWriteReceipt {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.blobId === 'string' &&
    v.blobId !== '' &&
    typeof v.policyKey === 'string' &&
    typeof v.ownerAddress === 'string' &&
    typeof v.paidAt === 'string' &&
    // Absent, or one of the two the service knows. Anything else is not a receipt this wallet can collect.
    (v.operation === undefined || v.operation === 'CREATE' || v.operation === 'UPDATE')
  )
}

export function createFsPolicyWriteReceiptStore(baseDir: string): PolicyWriteReceiptStore {
  const pathFor = (blobId: string) => join(baseDir, receiptFileName(blobId))

  return {
    filePathFor: pathFor,

    async get(blobId) {
      try {
        const parsed: unknown = JSON.parse(await readFile(pathFor(blobId), 'utf8'))
        return isReceiptShape(parsed) ? withValidVerify(parsed) : null
      } catch {
        return null
      }
    },

    async set(receipt) {
      // Write-then-rename, as every other persisted store here does. A crash mid-write must never
      // leave a torn file that reads as "nothing pending" at the exact moment the bookmark for a
      // paid-for write is needed most.
      await mkdir(baseDir, { recursive: true, mode: 0o700 })
      const filePath = pathFor(receipt.blobId)
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmpPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmpPath, filePath)
    },

    async list() {
      let names: string[]
      try {
        names = await readdir(baseDir)
      } catch {
        return []
      }
      const found: PolicyWriteReceipt[] = []
      for (const name of names) {
        // `.tmp-*` files are half-written by definition. Skipping them by suffix rather than
        // relying on the shape check means a torn file is never even parsed.
        if (!name.endsWith('.json')) continue
        try {
          const parsed: unknown = JSON.parse(await readFile(join(baseDir, name), 'utf8'))
          if (isReceiptShape(parsed)) found.push(withValidVerify(parsed))
        } catch {
          // One unreadable file must not hide every other pending receipt.
        }
      }
      return found.sort((a, b) => b.paidAt.localeCompare(a.paidAt))
    },

    async remove(blobId) {
      try {
        await unlink(pathFor(blobId))
      } catch {
        // Already gone is the desired state.
      }
    },
  }
}
