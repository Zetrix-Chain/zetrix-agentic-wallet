/**
 * SsivcClient — HTTP client for myid's SSIVC "Applications - AI Birthcert" session API.
 *
 * Confirmed 2026-08-17 against the live UAT OpenAPI spec: neither endpoint requires a Bearer
 * token (`security: []` on both operations) — the earlier static-bearer model is superseded, see
 * docs/verified-birthcert-vc/ADDENDUM_X402_SESSION_GATING.md. `POST /sessions` is instead gated by
 * x402: an unpaid request always gets a 402 with a raw x402 `accepts[]` envelope; paying and
 * retrying with `X-Payment` returns the session plus an `X-Payment-Response` settlement receipt.
 * That receipt can be replayed (as `X-Payment-Response`, with NO `X-Payment`) to open a fresh
 * session against the same still-unconsumed payment when a prior session went terminal without
 * minting a credential — see verify-ai-birthcert.ts for the reuse-vs-pay-fresh decision. The two
 * payment headers are mutually exclusive; modeling them as two distinct methods
 * (createSessionSettle / createSessionWithReceipt) makes sending both structurally impossible
 * rather than relying on the server's 400 rejection.
 *
 * Every request also carries a body-level `signedData` detached Ed25519 signature (see
 * verify-ai-birthcert.ts) — that, not any header, is what binds the session to a specific agent key.
 */

import type { PayRequirement } from './mbi-client.js'

export type SsivcErrorKind = 'payment_invalid' | 'facilitator_unavailable' | 'blob_already_settled' | 'validation'

export class SsivcError extends Error {
  httpStatus?: number
  /** SSIVC's own `status_code` string (distinct from the HTTP status) — e.g. "50" signature invalid, "55" expired timestamp, "23" not found. */
  statusCode?: string
  /** Classifies the x402-era error responses — see ADDENDUM_X402_SESSION_GATING.md §6. Undefined for the older 400/404/malformed-envelope cases. */
  kind?: SsivcErrorKind
  constructor(message: string, httpStatus?: number, statusCode?: string, kind?: SsivcErrorKind) {
    super(message)
    this.name = 'SsivcError'
    this.httpStatus = httpStatus
    this.statusCode = statusCode
    this.kind = kind
  }
}

export interface SsivcSessionRequestBody {
  publicKey: string
  address: string
  timestamp: string
  signedData: string
  agentName: string
  id?: string
  agentPurpose?: string
  evidenceAssuranceLevel?: string
  ownerType?: string
  ownerVerified?: string
  ownerReference?: string
}

/** The raw x402 wire envelope from a phase-1 402 — not the SSIVC ResponseWrapper. */
export interface SsivcChallenge {
  x402Version: number
  accepts: PayRequirement[]
}

export interface SsivcSessionCreated {
  sessionId: string
  verificationUrl: string
  expiresAt: string
}

/** A (re-)created session, plus the settlement receipt to persist for a possible future retry. */
export interface SsivcSessionSettled {
  session: SsivcSessionCreated
  paymentReceipt: string
}

export interface SsivcSessionStatus {
  sessionId: string
  status: string
  expiresAt: string
  /** Present ONLY when status is "issued" — myid never returns this for any other status. */
  vcId?: string
}

interface SsivcEnvelope<T> {
  status_code?: string
  data?: T
  message?: string
  errors?: string[]
}

const SESSIONS_PATH = '/v2/verify/ai-birthcert/sessions'

export class SsivcClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** Phase 1 — POST with no payment headers. SSIVC always responds 402 with the raw x402 envelope. */
  async createSessionChallenge(body: SsivcSessionRequestBody): Promise<SsivcChallenge> {
    const res = await this.fetch('POST', SESSIONS_PATH, body)
    if (res.status !== 402) throw await this.error(res, 'createSessionChallenge: expected 402 payment_required')
    const raw = (await res.json()) as { x402Version: number; error?: string; accepts?: PayRequirement[] }
    return { x402Version: raw.x402Version, accepts: raw.accepts ?? [] }
  }

  /** Fresh pay — retry with `X-Payment`. Returns the session plus the settlement receipt to persist. */
  createSessionSettle(body: SsivcSessionRequestBody, xPayment: string): Promise<SsivcSessionSettled> {
    return this.createSessionPaid(body, { 'X-Payment': xPayment })
  }

  /** Retry after a failed-issuance terminal session — replays a still-unconsumed settlement receipt. Never sent alongside `X-Payment`. */
  createSessionWithReceipt(body: SsivcSessionRequestBody, paymentReceipt: string): Promise<SsivcSessionSettled> {
    return this.createSessionPaid(body, { 'X-Payment-Response': paymentReceipt })
  }

  private async createSessionPaid(body: SsivcSessionRequestBody, paymentHeader: Record<string, string>): Promise<SsivcSessionSettled> {
    const res = await this.fetch('POST', SESSIONS_PATH, body, paymentHeader)
    if (!res.ok) throw await this.error(res, 'createSession (paid) failed')
    const env = (await res.json()) as SsivcEnvelope<{ sessionId: string; verification_url: string; expiresAt: string }>
    const data = env.data
    if (!data || typeof data !== 'object' || !data.sessionId || !data.verification_url || !data.expiresAt) {
      throw new SsivcError('SSIVC createSession succeeded (2xx) but returned a malformed data envelope', res.status)
    }
    const paymentReceipt = res.headers.get('x-payment-response')
    if (!paymentReceipt) {
      throw new SsivcError('SSIVC createSession succeeded (2xx) but returned no X-Payment-Response settlement receipt header', res.status)
    }
    return {
      session: { sessionId: data.sessionId, verificationUrl: data.verification_url, expiresAt: data.expiresAt },
      paymentReceipt,
    }
  }

  async getSession(sessionId: string): Promise<SsivcSessionStatus> {
    const res = await this.fetch('GET', `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`)
    if (!res.ok) throw await this.error(res)
    const env = (await res.json()) as SsivcEnvelope<SsivcSessionStatus>
    const data = env.data
    if (!data || typeof data !== 'object' || typeof data.sessionId !== 'string' || typeof data.status !== 'string') {
      throw new SsivcError('SSIVC getSession succeeded (2xx) but returned a malformed data envelope', res.status)
    }
    return data
  }

  private fetch(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).catch((e) => {
      throw new SsivcError(`SSIVC ${path} request failed: ${(e as Error).message}`)
    })
  }

  private async error(res: Response, context?: string): Promise<SsivcError> {
    const text = await res.text().catch(() => '')
    let msg = text
    let statusCode: string | undefined
    // Classified by HTTP status alone where possible, so a non-JSON body (e.g. a proxy's HTML 409
    // page) never loses the classification a caller relies on (e.g. blob_already_settled mapping
    // to a clean { error } instead of an unhandled throw).
    let kind: SsivcErrorKind | undefined
    if (res.status === 409) kind = 'blob_already_settled'
    else if (res.status === 400 || res.status === 422) kind = 'validation'
    try {
      const j = JSON.parse(text) as SsivcEnvelope<unknown> & { error?: string }
      statusCode = j.status_code
      msg = j.errors?.length ? j.errors.join('; ') : (j.message ?? j.error ?? text)
      if (res.status === 402 && j.error === 'payment_invalid') kind = 'payment_invalid'
      else if (res.status === 503 && j.error === 'facilitator_unavailable') kind = 'facilitator_unavailable'
    } catch {
      /* keep raw text; kind is already set above for the status-only cases */
    }
    const prefix = context ? `${context} — ` : ''
    return new SsivcError(`${prefix}SSIVC request failed — HTTP ${res.status}: ${msg}`, res.status, statusCode, kind)
  }
}
