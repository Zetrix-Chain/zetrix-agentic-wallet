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

export type SsivcErrorKind =
  | 'payment_invalid'
  | 'facilitator_unavailable'
  | 'blob_already_settled'
  /**
   * SSIVC refused the request because this `agentName` is already in use — `409` + `status_code 26`.
   *
   * Split out of `blob_already_settled`: both arrive as HTTP 409, but this one is a
   * verdict about the NAME, so telling the user "your payment was already settled" would be wrong,
   * and retrying the same name can never succeed. It says nothing about whether a fee was taken.
   */
  | 'agent_name_in_use'
  | 'validation'
  /**
   * SSIVC cannot resolve this receipt's settlement either way — `400` + `status_code 69`.
   *
   * NOT a confirmed failure and NOT a confirmed success, so the wallet must neither pay again nor
   * discard the receipt on it. Their facilitator leaves a blob QUEUED until its payment window
   * elapses and then reports EXPIRED, which SSIVC does not model — hence "could not be confirmed".
   * Observed to persist for weeks, so it is also not reliably transient: see the orchestrator, which
   * distinguishes a fresh one from a permanently stuck one by the receipt's age, not by this code.
   */
  | 'settlement_unconfirmed'
  /**
   * SSIVC has declared this receipt VOID — `67` (the sponsored settlement expired) or `68` (it
   * failed). Terminal either way: replaying it can only fail, and `67`'s own text says "Payment
   * required again".
   *
   * Terminal about the RECEIPT, not about the money. A settlement can expire at the facilitator
   * after the transfer has already executed — observed on the stuck-settlement incident, where the fee left
   * the wallet and no credential was ever issued. So this licenses "stop replaying and ask the user
   * whether to pay again"; it does NOT license telling them nothing was charged.
   */
  | 'settlement_void'

/** SSIVC's settlement verdicts on the replay path, from the UAT OpenAPI spec + live probes. */
const SETTLEMENT_UNCONFIRMED_STATUS_CODE = '69'
const SETTLEMENT_EXPIRED_STATUS_CODE = '67'
const SETTLEMENT_FAILED_STATUS_CODE = '68'
const AGENT_NAME_IN_USE_STATUS_CODE = '26'

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
  /** Added by the wallet, not SSIVC: time left by the wallet's own clock. See session-expiry.ts. */
  expiresInSeconds?: number
  expiresIn?: string
}

/** A (re-)created session, plus the settlement receipt to persist for a possible future retry. */
export interface SsivcSessionSettled {
  session: SsivcSessionCreated
  paymentReceipt: string
}

/** Settlement is asynchronous under paymaster sponsorship: a 202 means "paid, not yet settled". */
export type SsivcSessionOutcome =
  | { kind: 'settled'; session: SsivcSessionCreated; paymentReceipt: string }
  | { kind: 'queued'; paymentReceipt: string; retryAfterSeconds: number }

/** Fallback wait when SSIVC's 202 carries no usable Retry-After. */
const DEFAULT_RETRY_AFTER_SECONDS = 15

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

/**
 * Opt-in wire tracing for the SSIVC exchange, enabled with `SSIVC_TRACE=1`.
 *
 * Exists because a settlement that stalls is almost never diagnosable from the wallet's own
 * reporting: the wallet only ever sees SSIVC's verdict, and when that verdict disagrees with the
 * facilitator there is no way to tell from here which side is wrong. Reproducing the call by hand
 * is not an option either — every request carries a `signedData` over a timestamp that must be
 * minutes old, signed by a key the wallet holds and no one can reach from a REST client. Printing
 * the exact request is the only way to get a replayable one.
 *
 * OFF by default, and deliberately not wired to any config file: the trace contains the payment
 * receipt and the request signature. The receipt is a bearer handle on a real payment — anyone
 * holding it can replay it — so this belongs in a terminal a developer is watching, never in a
 * shipped log pipeline. Turn it on for a reproduction, then turn it off.
 *
 * Writes to stderr, which is where MCP servers put diagnostics; stdout is the protocol channel and
 * writing there corrupts the session.
 */
const traceEnabled = (): boolean => process.env.SSIVC_TRACE === '1'

function traceRequest(method: string, url: string, headers: Record<string, string>, body?: unknown): void {
  if (!traceEnabled()) return
  try {
    const lines = [`[ssivc-trace] --> ${method} ${url}`]
    for (const [k, v] of Object.entries(headers)) lines.push(`[ssivc-trace] --> ${k}: ${v}`)
    if (body !== undefined) lines.push(`[ssivc-trace] --> body: ${JSON.stringify(body)}`)
    process.stderr.write(lines.join('\n') + '\n')
  } catch {
    // Tracing must never break a paid request.
  }
}

async function traceResponse(method: string, url: string, res: Response): Promise<void> {
  if (!traceEnabled()) return
  try {
    // clone() because the caller still has to read this body — reading it here would leave them a
    // consumed stream and turn a diagnostic into an outage.
    const text = await res.clone().text()
    const receipt = res.headers.get('x-payment-response')
    process.stderr.write(
      `[ssivc-trace] <-- ${res.status} ${method} ${url}\n` +
        (receipt ? `[ssivc-trace] <-- X-Payment-Response: ${receipt}\n` : '') +
        `[ssivc-trace] <-- body: ${text}\n`,
    )
  } catch {
    // As above.
  }
}

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
  createSessionSettle(body: SsivcSessionRequestBody, xPayment: string): Promise<SsivcSessionOutcome> {
    return this.createSessionPaid(body, { 'X-Payment': xPayment })
  }

  /** Retry after a failed-issuance terminal session — replays a still-unconsumed settlement receipt. Never sent alongside `X-Payment`. */
  createSessionWithReceipt(body: SsivcSessionRequestBody, paymentReceipt: string): Promise<SsivcSessionOutcome> {
    return this.createSessionPaid(body, { 'X-Payment-Response': paymentReceipt })
  }

  private async createSessionPaid(body: SsivcSessionRequestBody, paymentHeader: Record<string, string>): Promise<SsivcSessionOutcome> {
    const res = await this.fetch('POST', SESSIONS_PATH, body, paymentHeader)
    if (!res.ok) throw await this.error(res, 'createSession (paid) failed')

    // The receipt is required for BOTH outcomes: on 200 it is the settled-but-unconsumed
    // receipt (SPEC §5.1b), on 202 it is the only handle for the settlement retry.
    const paymentReceipt = res.headers.get('x-payment-response')
    if (!paymentReceipt) {
      throw new SsivcError('SSIVC createSession succeeded (2xx) but returned no X-Payment-Response settlement receipt header', res.status)
    }

    // 202 — sponsored settlement queued at the facilitator; no session exists yet.
    if (res.status === 202) {
      const header = Number(res.headers.get('retry-after'))
      const retryAfterSeconds = Number.isFinite(header) && header > 0 ? header : DEFAULT_RETRY_AFTER_SECONDS
      return { kind: 'queued', paymentReceipt, retryAfterSeconds }
    }

    const env = (await res.json()) as SsivcEnvelope<{ sessionId: string; verification_url: string; expiresAt: string }>
    const data = env.data
    if (!data || typeof data !== 'object' || !data.sessionId || !data.verification_url || !data.expiresAt) {
      throw new SsivcError('SSIVC createSession succeeded (2xx) but returned a malformed data envelope', res.status)
    }
    return {
      kind: 'settled',
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
    const url = `${this.baseUrl}${path}`
    traceRequest(method, url, headers, body)
    return fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
      .then(async (res) => {
        await traceResponse(method, url, res)
        return res
      })
      .catch((e) => {
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
      // Only a 409 that SSIVC itself labels 26: a bare/non-JSON 409 keeps the blob_already_settled
      // classification set above, which is the one that stays cautious about the money.
      if (res.status === 409 && statusCode === AGENT_NAME_IN_USE_STATUS_CODE) kind = 'agent_name_in_use'
      else if (res.status === 402 && j.error === 'payment_invalid') kind = 'payment_invalid'
      else if (res.status === 503 && j.error === 'facilitator_unavailable') kind = 'facilitator_unavailable'
      // Scoped to the 400 SSIVC actually ships it on: on any other status this code is not
      // a settlement verdict, and misreading a 5xx as one would let a server fault look terminal.
      else if (res.status === 400 && statusCode === SETTLEMENT_UNCONFIRMED_STATUS_CODE) kind = 'settlement_unconfirmed'
      else if (
        res.status === 400 &&
        (statusCode === SETTLEMENT_EXPIRED_STATUS_CODE || statusCode === SETTLEMENT_FAILED_STATUS_CODE)
      ) {
        kind = 'settlement_void'
      }
    } catch {
      /* keep raw text; kind is already set above for the status-only cases */
    }
    const prefix = context ? `${context} — ` : ''
    return new SsivcError(`${prefix}SSIVC request failed — HTTP ${res.status}: ${msg}`, res.status, statusCode, kind)
  }
}
