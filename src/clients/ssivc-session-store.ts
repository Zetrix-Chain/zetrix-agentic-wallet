/**
 * SsivcSessionStore — persists the most recently requested AI Birthcert session, so
 * check_ai_birthcert_verification survives an MCP restart, and so request_ai_birthcert_verification
 * can decide whether to replay a still-settled-but-unconsumed payment receipt instead of paying
 * again (see verify-ai-birthcert.ts and docs/verified-birthcert-vc/ADDENDUM_X402_SESSION_GATING.md
 * §4). Same shape and owner-only permissions as account-store.ts.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredSsivcSession {
  sessionId: string
  agentName: string
  createdAt: string
  /** The verification_url originally returned for this session — reused when the session is still pending. */
  verificationUrl: string
  /** The X-Payment-Response settlement receipt — replayable while the payment is settled-but-unconsumed. */
  paymentReceipt: string
}

export interface SsivcSessionStore {
  get(): Promise<StoredSsivcSession | null>
  set(session: StoredSsivcSession): Promise<void>
}

function isStoredSessionShape(value: unknown): value is StoredSsivcSession {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionId === 'string' &&
    typeof v.agentName === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.verificationUrl === 'string' &&
    typeof v.paymentReceipt === 'string'
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
  }
}
