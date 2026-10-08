/**
 * MbiClient — HTTP client for the MBI RS x402 VC-issuance API.
 *
 * MBI is both the x402 resource server AND the MYID issuer: it returns the 402,
 * verifies/settles the payment via the facilitator, and issues the VC directly.
 * Two-phase `POST /v1/vc/pay/apply` (payment-required=true):
 *   phase 1 (no X-PAYMENT) → 402 x402-wire challenge (+ accepts[].extra.paymentId)
 *   phase 2 (X-PAYMENT + paymentId in body) → 200 { vcId, verifiableCredential, txHash }
 *
 * NOTE: the 402 challenge is RAW x402 wire format (not the MBI ResponseWrapper),
 * so generic x402 clients can consume `accepts[]` directly; success/errors ARE wrapped.
 */

import { createHash } from 'node:crypto'

export class MbiError extends Error {
  httpStatus?: number
  /**
   * MBI's own numeric code from the ResponseWrapper body — finer-grained than the HTTP status
   * and the only reliable way to tell a *definitive* post-payment failure from an indeterminate
   * one. Undefined when the body carries no numeric `status`.
   */
  mbiStatus?: number
  constructor(message: string, httpStatus?: number, mbiStatus?: number) {
    super(message)
    this.name = 'MbiError'
    this.httpStatus = httpStatus
    this.mbiStatus = mbiStatus
  }
}

/**
 * `X402_SETTLEMENT_INDETERMINATE` (HTTP 502). The facilitator `/settle` outcome came back
 * UNKNOWN: MBI stopped listening, but the payment may well have settled on chain, so it
 * deliberately does NOT mark the row failed — the outcome stays recoverable via
 * `GET /v1/vc/pay/status/{paymentId}`. Never retry a payment on this code; look it up instead.
 */
export const MBI_SETTLEMENT_INDETERMINATE = 4012

/** One x402 `accepts[]` entry — passed as-is to x402-zetrix-client's PaymentEngine.pay. */
export type PayRequirement = Record<string, unknown> & {
  asset?: string
  payTo?: string
  maxAmountRequired?: string
  extra?: { paymentId?: string } & Record<string, unknown>
}

export interface MbiChallenge {
  x402Version: number
  accepts: PayRequirement[]
  /** From accepts[0].extra.paymentId — echo into the phase-2 body. */
  paymentId?: string
  /**
   * Set when this template requires no payment: MBI issues synchronously inside phase 1
   * (HTTP 200 instead of 402) and there is no phase-2 settle step. The VC in here has
   * already been created on chain by the time the caller sees this — issuance is not
   * something a caller can preview or decline after the fact.
   */
  issued?: MbiIssuedVc
}

export interface MbiApplyBody {
  data: string
  signData: string
  publicKey: string
  expirationDate?: string
}

export interface MbiIssuedVc {
  vcId: string
  paymentId?: string
  txHash?: string
  verifiableCredential: unknown
}

export interface MbiStatus {
  paymentId: string
  status: string
  txHash?: string
  vcId?: string
}

/**
 * Signs a UTF-8 message with the holder's key (Wallet BE `sign-message`) and returns the hex signature
 * plus the public key. MbiClient uses it to log in each `/ext` request (see {@link MbiClient}).
 */
export type MbiRequestSigner = (message: string) => Promise<{ signBlob: string; publicKey: string }>

export interface MbiVpCreateBody {
  vc: unknown
  revealAttributes: string[]
  rangeProof?: unknown
}

export interface MbiVpCreateResult {
  blobId: string
  blob: string
}

export interface MbiVpSubmitBody {
  blobId: string
  signedBlob: string
  publicKey: string
  vpExpiry?: number
  /** When true, the response also carries the finished `vp`. */
  includeVp?: boolean
}

export interface MbiVpSubmitResult {
  id: string
  vp?: unknown
}

/**
 * `POST /v1/vc/pay/quote` — the same `accepts[]` shape the 402 carries, plus the canonical bytes a
 * real apply would sign. `extra.paymentId` is always null here: a quote is not payable.
 */
export interface MbiQuote {
  accepts: PayRequirement[]
  signPayload?: string
  /**
   * Whether `/apply` will actually charge — mirrors MBI's service-wide `payment-required` flag.
   * `accepts[]` cannot answer this: MBI builds it identically in free mode, quoting a
   * price nobody will be asked to pay.
   *
   * Optional because an older MBI without this field omits it. Absent means "unknown", NOT "free" — the
   * quoted amount should then be reported as unconfirmed rather than as a certain charge.
   */
  paymentRequired?: boolean
}

/** One entry from `POST /v1/vc/ext/download` — every VC the holder has, not just one. */
export interface MbiVcEntry {
  vc: unknown
  extraData?: unknown
}

export class MbiClient {
  private readonly baseUrl: string
  /** Per-request deadline in ms. See {@link MbiClient.DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs: number

  /**
   * MBI's own facilitator read timeout is 60s, and `/settle` submits
   * a transaction on chain. A client deadline at or below that would abort a settle MBI is
   * still legitimately waiting on — manufacturing exactly the indeterminate outcome that MR
   * exists to prevent, except on our side where nothing records it. Sits above 60s so MBI
   * always gets to answer first; raise it in step if MBI's own timeout is ever raised.
   */
  static readonly DEFAULT_TIMEOUT_MS = 90_000

  constructor(baseUrl: string, opts?: { timeoutMs?: number }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = opts?.timeoutMs ?? MbiClient.DEFAULT_TIMEOUT_MS
  }

  /**
   * Phase 1 — POST /v1/vc/pay/apply without X-PAYMENT; expects the 402 challenge.
   * A free template short-circuits this: MBI issues the VC synchronously and returns
   * 200 instead, with no phase-2 settle to follow — surfaced via the `issued` field.
   */
  async applyChallenge(body: MbiApplyBody): Promise<MbiChallenge> {
    const res = await this.fetch('POST', '/v1/vc/pay/apply', body)
    if (res.status === 200) {
      const issued = await this.unwrap<MbiIssuedVc>(res)
      return { x402Version: 1, accepts: [], issued }
    }
    if (res.status !== 402) {
      throw await this.error(res, 'apply (phase 1) expected 402')
    }
    const raw = (await res.json()) as { x402Version: number; accepts: PayRequirement[] }
    const accepts = raw.accepts ?? []
    return { x402Version: raw.x402Version, accepts, paymentId: accepts[0]?.extra?.paymentId }
  }

  /** Phase 2 — POST /v1/vc/pay/apply with X-PAYMENT (+ paymentId echoed in body); returns the issued VC. */
  async applySettle(body: MbiApplyBody & { paymentId?: string }, xPayment: string): Promise<MbiIssuedVc> {
    const res = await this.fetch('POST', '/v1/vc/pay/apply', body, { 'X-PAYMENT': xPayment })
    if (!res.ok) throw await this.error(res, 'apply (phase 2) failed')
    return this.unwrap<MbiIssuedVc>(res)
  }

  /**
   * POST /v1/vc/pay/quote — the price for a template, with no issuance and no payment record.
   *
   * Unlike `applyChallenge`, this cannot mint anything: MBI resolves the template, builds the
   * canonical sign payload, and reads its configured price. Notably a FREE template does not
   * short-circuit into synchronous issuance here, which is what makes this safe to call purely to
   * find out a cost — `applyChallenge` is not (see its docstring).
   *
   * `data` is required to be non-empty by MBI's DTO but does not affect the price, which comes from
   * MBI's own asset config keyed by the resolved template. A caller pricing a credential before it
   * has collected any attribute therefore passes a throwaway value, and must not present it as
   * anything the user supplied.
   */
  async quote(templateId: string, data: Record<string, unknown>): Promise<MbiQuote> {
    const res = await this.fetch('POST', '/v1/vc/pay/quote', { templateId, data })
    if (!res.ok) throw await this.error(res, 'quote failed')
    return this.unwrap<MbiQuote>(res)
  }

  /** Idempotent recovery — GET /v1/vc/pay/status/{paymentId}. */
  async getStatus(paymentId: string): Promise<MbiStatus> {
    const res = await this.fetch('GET', `/v1/vc/pay/status/${encodeURIComponent(paymentId)}`)
    if (!res.ok) throw await this.error(res, 'status lookup failed')
    return this.unwrap<MbiStatus>(res)
  }

  /** POST /v1/vp/ext/create — derive the unsigned VP blob for external signing. */
  async createVp(body: MbiVpCreateBody, sign: MbiRequestSigner): Promise<MbiVpCreateResult> {
    const res = await this.signedFetch('POST', '/v1/vp/ext/create', body, sign)
    if (!res.ok) throw await this.error(res, 'vp/ext/create failed')
    return this.unwrap<MbiVpCreateResult>(res)
  }

  /** POST /v1/vp/ext/submit — submit the signed VP blob; `includeVp: true` returns the finished VP too. */
  async submitVp(body: MbiVpSubmitBody, sign: MbiRequestSigner): Promise<MbiVpSubmitResult> {
    const res = await this.signedFetch('POST', '/v1/vp/ext/submit', body, sign)
    if (!res.ok) throw await this.error(res, 'vp/ext/submit failed')
    return this.unwrap<MbiVpSubmitResult>(res)
  }

  /** POST /v1/vc/ext/download — holder-authenticated; returns EVERY VC for the address, not one. */
  async downloadVcs(body: { address: string }, sign: MbiRequestSigner): Promise<MbiVcEntry[]> {
    const res = await this.signedFetch('POST', '/v1/vc/ext/download', body, sign)
    if (!res.ok) throw await this.error(res, 'vc/ext/download failed')
    const raw = await this.unwrap<unknown>(res)
    // Confirmed live (2026-08-17): MBI's real response double-wraps the list —
    // `{ data: { data: [...] } }` — NOT `{ data: [...] }` as SPEC.md's documented example assumed
    // (that example was never verified live until now). Accept either shape: the confirmed live
    // one (`raw.data` is the array) and the originally-documented one (`raw` itself is the array),
    // rather than trusting unwrap's bare type cast — so a genuinely malformed envelope still fails
    // cleanly instead of crashing the caller with a raw TypeError (e.g.
    // checkAiBirthcertVerification's entries.find).
    const nested = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).data : undefined
    const data = Array.isArray(raw) ? raw : Array.isArray(nested) ? nested : undefined
    if (!data) {
      throw new MbiError(`MBI vc/ext/download succeeded (2xx) but returned a non-array data envelope: ${JSON.stringify(raw)}`, res.status)
    }
    return data as MbiVcEntry[]
  }

  /**
   * An `/ext` request logged in with MBI's request-bound signing: the holder signs
   * `METHOD|PATH|sha256hex(body)|timestamp` and MBI re-derives the same string from what it receives.
   *
   * The signature covers the body bytes that are actually sent, so the body is serialised once and
   * that exact text is both hashed and sent. A fresh timestamp and signature are produced on every call:
   * MBI treats each signed request as single-use, so one signature cannot be reused for a second call
   * (and the legacy scheme, which signed the caller's own address, was replayable indefinitely).
   * `path` is the API path (`/v1/...`) exactly as MBI sees it. The default base URLs have no path prefix;
   * a base URL that does carry one is sent as given and the prefix is NOT part of the signature, which only
   * works where a gateway in front of MBI strips it before MBI verifies the request.
   *
   * Redirects are not followed: a redirected POST would be replayed with the same signature and timestamp,
   * which MBI refuses as already used, so a redirect is surfaced as an error instead.
   */
  private async signedFetch(method: string, path: string, body: unknown, sign: MbiRequestSigner): Promise<Response> {
    const bodyText = JSON.stringify(body)
    const timestamp = this.nextTimestamp()
    const canonical = `${method}|${path}|${createHash('sha256').update(bodyText, 'utf8').digest('hex')}|${timestamp}`
    const signed = await sign(canonical)
    if (!signed?.signBlob || !signed?.publicKey) {
      // Empty headers would reach MBI as an opaque 401/403, and for the one-shot VC download that burns the call.
      throw new MbiError(`MBI ${path} request was not sent: the signer returned no signature or public key`)
    }
    return this.send(method, path, bodyText, { signedData: signed.signBlob, publicKey: signed.publicKey, timestamp }, 'error')
  }

  private lastSignedAtMs = 0

  /**
   * An ISO-8601 instant that is strictly later than the one before it from this client. MBI treats a signed
   * request as single-use, keyed on the signed string, so two identical requests in the same millisecond
   * would otherwise sign the same string and the second would be refused as already used.
   */
  private nextTimestamp(): string {
    const ms = Math.max(Date.now(), this.lastSignedAtMs + 1)
    this.lastSignedAtMs = ms
    return new Date(ms).toISOString()
  }

  private fetch(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    return this.send(method, path, body !== undefined ? JSON.stringify(body) : undefined, extraHeaders)
  }

  private send(
    method: string,
    path: string,
    bodyText?: string,
    extraHeaders?: Record<string, string>,
    redirect?: RequestRedirect,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) }
    if (bodyText !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      ...(redirect !== undefined ? { redirect } : {}),
    }).catch((e) => {
      // With redirect:'error' undici reports a redirect as a bare "fetch failed" whose cause names it.
      const cause = (e as { cause?: { message?: string } }).cause?.message ?? ''
      if (redirect === 'error' && /redirect/i.test(cause)) {
        throw new MbiError(`MBI ${path} answered with a redirect, which is not followed for signed requests; check MBI_BASE_URL`)
      }
      throw new MbiError(`MBI ${path} request failed: ${(e as Error).message}`)
    })
  }

  /** Unwrap the MBI ResponseWrapper `{ status, message, data }`. */
  private async unwrap<T>(res: Response): Promise<T> {
    const body = (await res.json()) as { data?: T }
    return body.data as T
  }

  private static readonly ERROR_BODY_MAX_LEN = 500

  private async error(res: Response, context: string): Promise<MbiError> {
    const text = await res.text().catch(() => '')
    let msg = text
    let mbiStatus: number | undefined
    try {
      const j = JSON.parse(text) as { message?: string; error?: string; status?: unknown }
      // MBI's ResponseWrapper `status` is its own code (e.g. 4006 vs 4012), not the HTTP status.
      // Callers branch on it, so keep it structured instead of only inside the message string.
      if (typeof j.status === 'number') mbiStatus = j.status
      const truncated =
        text.length > MbiClient.ERROR_BODY_MAX_LEN
          ? `${text.slice(0, MbiClient.ERROR_BODY_MAX_LEN)}… (truncated, ${text.length} bytes total)`
          : text
      msg = `${j.message ?? j.error ?? text} | full body: ${truncated}`
    } catch {
      /* keep raw text */
    }
    return new MbiError(`MBI ${context} — HTTP ${res.status}: ${msg}`, res.status, mbiStatus)
  }
}
