/**
 * SsivcSessionStore — persists the most recently requested AI Birthcert session, so
 * check_ai_birthcert_verification survives an MCP restart, and so request_ai_birthcert_verification
 * can decide whether to replay a still-settled-but-unconsumed payment receipt instead of paying
 * again (see verify-ai-birthcert.ts and docs/verified-birthcert-vc/ADDENDUM_X402_SESSION_GATING.md
 * §4). Same shape and owner-only permissions as account-store.ts.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredSsivcSession {
  sessionId: string
  agentName: string
  createdAt: string
  /** The verification_url originally returned for this session — reused when the session is still pending. */
  verificationUrl: string
  /** The X-Payment-Response settlement receipt — replayable while the payment is settled-but-unconsumed. */
  paymentReceipt: string
  /**
   * The optional request fields this session was PAID for.
   *
   * `check_ai_birthcert_verification` can now replay a stuck receipt, and it has no user input to
   * rebuild the request body from — only this record. Without these, a replay would resend a body
   * missing whatever the user originally supplied, and the credential would be issued without it:
   * silent data loss, visible only once they read their birthcert. Absent on older records,
   * and absent whenever the caller simply did not supply them — both are indistinguishable
   * here and both are correct.
   */
  agentPurpose?: string
  evidenceAssuranceLevel?: string
  ownerType?: string
  ownerVerified?: string
}

export interface SsivcSessionStore {
  get(): Promise<StoredSsivcSession | null>
  set(session: StoredSsivcSession): Promise<void>
  /**
   * Discard the stored session entirely.
   *
   * DESTRUCTIVE: if the record held an unconsumed settlement receipt, that payment becomes
   * unrecoverable — the receipt is the only handle on it. Exists because the alternative was worse:
   * the only escape from a stuck receipt used to be deleting this file on the gateway by hand,
   * which a hosted Avatar subscriber cannot do. Callers must confirm with the user first; see
   * clearStuckPaymentReceipt.
   *
   * Idempotent — clearing when nothing is stored is a no-op, not an error.
   */
  clear(): Promise<void>
}

/** Absent is fine (older records, and callers who supplied nothing); present-but-not-a-string is not. */
const isAbsentOrString = (v: unknown): boolean => v === undefined || typeof v === 'string'

function isStoredSessionShape(value: unknown): value is StoredSsivcSession {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionId === 'string' &&
    typeof v.agentName === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.verificationUrl === 'string' &&
    typeof v.paymentReceipt === 'string' &&
    isAbsentOrString(v.agentPurpose) &&
    isAbsentOrString(v.evidenceAssuranceLevel) &&
    isAbsentOrString(v.ownerType) &&
    isAbsentOrString(v.ownerVerified)
  )
}

export function createFsSsivcSessionStore(filePath: string): SsivcSessionStore {
  return {
    async get() {
      try {
        const raw = await readFile(filePath, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        return isStoredSessionShape(parsed) ? parsed : null
      } catch {
        return null
      }
    },

    async set(session) {
      // APP-M02: write-then-rename, not a direct write. A crash mid-write must never leave a
      // torn/corrupt file — get() would map that to "no session" and a caller would pay again for
      // a session that may already have a settled, unconsumed receipt.
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
      const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
      await writeFile(tmpPath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(tmpPath, filePath)
    },

    async clear() {
      // force: true makes a missing file a no-op rather than ENOENT — "already gone" is exactly the
      // outcome the caller wants, so it must not read as a failure.
      await rm(filePath, { force: true })
    },
  }
}
