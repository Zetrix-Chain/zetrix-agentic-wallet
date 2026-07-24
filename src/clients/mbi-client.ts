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

export class MbiError extends Error {
  httpStatus?: number
  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'MbiError'
    this.httpStatus = httpStatus
  }
}

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

/** `/v1/vp/ext/*` message-signing auth — Ed25519 signature over the holder's own address (UTF-8), not a hex blob. */
export interface MbiVpAuth {
  signedData: string
  publicKey: string
}

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

export class MbiClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
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

  /** Idempotent recovery — GET /v1/vc/pay/status/{paymentId}. */
  async getStatus(paymentId: string): Promise<MbiStatus> {
    const res = await this.fetch('GET', `/v1/vc/pay/status/${encodeURIComponent(paymentId)}`)
    if (!res.ok) throw await this.error(res, 'status lookup failed')
    return this.unwrap<MbiStatus>(res)
  }

  /** POST /v1/vp/ext/create — derive the unsigned VP blob for external signing. */
  async createVp(body: MbiVpCreateBody, auth: MbiVpAuth): Promise<MbiVpCreateResult> {
    const res = await this.fetch('POST', '/v1/vp/ext/create', body, { signedData: auth.signedData, publicKey: auth.publicKey })
    if (!res.ok) throw await this.error(res, 'vp/ext/create failed')
    return this.unwrap<MbiVpCreateResult>(res)
  }

  /** POST /v1/vp/ext/submit — submit the signed VP blob; `includeVp: true` returns the finished VP too. */
  async submitVp(body: MbiVpSubmitBody, auth: MbiVpAuth): Promise<MbiVpSubmitResult> {
    const res = await this.fetch('POST', '/v1/vp/ext/submit', body, { signedData: auth.signedData, publicKey: auth.publicKey })
    if (!res.ok) throw await this.error(res, 'vp/ext/submit failed')
    return this.unwrap<MbiVpSubmitResult>(res)
  }

  private fetch(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(extraHeaders ?? {}) }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).catch((e) => {
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
    try {
      const j = JSON.parse(text) as { message?: string; error?: string }
      const truncated =
        text.length > MbiClient.ERROR_BODY_MAX_LEN
          ? `${text.slice(0, MbiClient.ERROR_BODY_MAX_LEN)}… (truncated, ${text.length} bytes total)`
          : text
      msg = `${j.message ?? j.error ?? text} | full body: ${truncated}`
    } catch {
      /* keep raw text */
    }
    return new MbiError(`MBI ${context} — HTTP ${res.status}: ${msg}`, res.status)
  }
}
