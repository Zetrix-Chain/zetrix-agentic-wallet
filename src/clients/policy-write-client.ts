/**
 * PolicyWriteClient — the three-phase, pay-gated policy write.
 *
 * ```
 *   POST /pay/policy/adopt-template           no X-PAYMENT        phase 1   402 | 409 | 400
 *   POST /pay/policy/adopt-template           X-PAYMENT           phase 2   202 + X-PAYMENT-RECEIPT
 *   POST /pay/policy/adopt-template/collect   X-PAYMENT-RECEIPT   phase 3   200 | 202 | 402 | 502 | 504
 * ```
 *
 * SETTLE FIRST, THEN WRITE. This deliberately does not use the stock x402 filter, which serves the
 * resource and settles asynchronously afterwards — on a write that would put a policy on chain
 * nobody paid for. Phase 2 ends in a 202 with NOTHING WRITTEN, and only a confirmed settlement in
 * phase 3 produces a policy. The wallet's side of that bargain is that a 202 is never reported as
 * a failure (the ticket's AC #1).
 *
 * WHAT THIS FILE DOES NOT DO, and the reason the ticket calls it assembly rather than capability:
 * no blob building, no permit digest, no canonical-attributes JSON, no node submission. ms-zetrix
 * computes and signs the permit with the owner's own HSM key, exactly as it already does on the
 * JWT path, and the paymaster POLICY pool pays the gas. A second canonical-JSON implementation in
 * TypeScript would have to match the contract's re-serialisation byte for byte, and a one-byte
 * difference is an invalid signature discovered only after gas is spent.
 *
 * FOUR PLACES WHERE THE SERVER DIFFERS FROM THE TICKET'S TEXT, all read from `developv2` 2026-09-28
 * and all recorded on the ticket:
 *
 *   1. Phase 3 requires `ownerHsmPassword`, which AC #8 says it must not send. The server signs
 *      the permit at write time and `hsm.key_registry` will not release the key without it. The AC
 *      that still holds, and is enforced here, is that the RECEIPT STORE keeps no secret.
 *   2. There is no 503. The real set is 200 / 202 / 402 / 502 / 504 — see `CollectOutcome`.
 *   3. A 409 has two meanings, and one of them hands back a receipt for a write already paid for.
 *   4. `X-PAYMENT-RESPONSE` cannot identify an attempt: it is base64 of
 *      `{success, network, transaction:null}`. `X-PAYMENT-RECEIPT` is the identifier.
 */

/** The x402 challenge body, as `PaymentRequiredResponse` puts it on the wire. */
export interface PaymentChallenge {
  x402Version?: number
  error?: string
  accepts?: unknown[]
}

/** Phase 1 — free. Either terms to pay, or the reason paying would be pointless. */
export type PrecheckResult =
  /** Pay to proceed. `accepts` goes to the wallet's existing quote selection untouched. */
  | { kind: 'payment_required'; challenge: PaymentChallenge }
  /** This owner already has a policy under that key. A real refusal; no payment was attempted. */
  | { kind: 'already_exists'; detail: string }
  /**
   * ALREADY PAID FOR — collect it. The server returns the existing receipt rather than a fresh
   * 402, because "a settlement that hangs must never turn into a second charge". This is also how
   * a wallet that lost its bookmark gets it back, so it is a RECOVERY path, not a failure.
   */
  | { kind: 'already_in_flight'; blobId: string; detail: string }
  /** Malformed, or refused by the write validator. Free, and paying would not have helped. */
  | { kind: 'refused'; status: number; detail: string }
  /** We could not tell. Never treated as "no policy exists" and never as permission to pay. */
  | { kind: 'unreachable'; detail: string }

/** Phase 2 — payment accepted, key reserved, NOTHING WRITTEN. */
export type PayResult =
  | { kind: 'paid'; blobId: string; detail: string }
  /**
   * The worst shape in the flow: the service ACCEPTED the payment and named no receipt, so the
   * money has moved and this wallet cannot say which write it bought. Distinct from
   * {@link PayResult}  on purpose — the service was reached and did answer, and
   * saying otherwise would send someone looking for a network fault that is not there.
   */
  | { kind: 'paid_untrackable'; detail: string }
  | { kind: 'refused'; status: number; detail: string }
  | { kind: 'unreachable'; detail: string }

/**
 * Phase 3 — the only phase that can produce a policy.
 *
 * `submitted` is the one worth reading twice. It arrives as a 202 CARRYING A txHash, and the
 * server's own comment says the caller "must not read that as a written policy": the transaction
 * is on chain but the block has not decided. Reporting success there would tell a user their
 * policy exists before it does.
 */
export type CollectResult =
  | { kind: 'written'; policyKey?: string; txHash?: string; detail: string }
  /** Still in the facilitator queue. Retry after `retryAfterSeconds`. */
  | { kind: 'settling'; retryAfterSeconds: number; detail: string }
  /** On chain, block not in yet. Also a 202, but a longer wait — and it carries a txHash. */
  | { kind: 'submitted'; txHash?: string; retryAfterSeconds: number; detail: string }
  /** 402 — the receipt is spent and bought nothing. Paying again IS the right next move. */
  | { kind: 'void'; detail: string }
  /**
   * 502 — paid, submitted, and rejected by the block. Distinct from `void` because paying again
   * would NOT help: "the cause is ours (gas, fee limit, a bad permit), not the caller's".
   */
  | { kind: 'write_failed'; txHash?: string; detail: string }
  /** 504 — the money state is genuinely unknown. Report the receipt; never guess. */
  | { kind: 'unknown'; detail: string }
  /**
   * A status this flow does not define — a 404 or 410 for a receipt the sweeper has already
   * cleared, say. TERMINAL, not retryable: round 1 reported it as `unreachable`, which made the
   * poll loop keep going and re-present the HSM password each time. The server's retry series is
   * six keys wide and a failure consumes one (the ticket), so a client that retries into an
   * unrecognised status can exhaust the series for a write that has already been paid for.
   */
  | { kind: 'unrecognised'; status: number; detail: string }
  | { kind: 'unreachable'; detail: string }

/** Mirrors `fetch`, injected so tests exercise the status handling rather than the network. */
export type HttpSend = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/** Everything the server needs to record what the payment buys. No signature, no blob. */
export interface AdoptTemplateRequest {
  ownerAddress: string
  policyKey: string
  attributes: Array<{ attributeName: string; attributeType?: string; value: string }>
  templateContractAddress: string
  templateId: string
  validFromBlock?: string
  validToBlock?: string
  requestKey: string
}

const HEADER_PAYMENT = 'X-PAYMENT'
const HEADER_RECEIPT = 'X-PAYMENT-RECEIPT'

/** A 202 with no `Retry-After` still has to wait for something. */
const DEFAULT_RETRY_AFTER_SECONDS = 5

export class PolicyWriteClient {
  private readonly baseUrl: string
  private readonly send: HttpSend

  constructor(baseUrl: string, send: HttpSend) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.send = send
  }

  /** Phase 1. Free, and it never sends a payment header. */
  async precheck(request: AdoptTemplateRequest): Promise<PrecheckResult> {
    const res = await this.post('/pay/policy/adopt-template', request)
    if (!res.reached) return { kind: 'unreachable', detail: res.detail }

    if (res.status === 402) {
      const challenge = parseJson<PaymentChallenge>(res.body)
      // The challenge is what the wallet's quote selection reads. A 402 we cannot parse is not a
      // reason to pay blind.
      if (!challenge || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
        return { kind: 'unreachable', detail: `the 402 carried no usable terms: ${clip(res.body)}` }
      }
      return { kind: 'payment_required', challenge }
    }

    if (res.status === 409) {
      const body = parseJson<{ state?: string; receipt?: string; detail?: string }>(res.body)
      // Two meanings, and they could not be further apart: one says the write is impossible, the
      // other says it is already bought and waiting to be collected.
      if (body?.state === 'ALREADY_IN_FLIGHT' && typeof body.receipt === 'string' && body.receipt !== '') {
        return {
          kind: 'already_in_flight',
          blobId: body.receipt,
          detail: body.detail ?? 'this write has already been paid for — collect it',
        }
      }
      return { kind: 'already_exists', detail: body?.detail ?? clip(res.body) }
    }

    if (res.status >= 200 && res.status < 300) {
      // Phase 1 has no success shape: it either quotes a price or explains why it will not.
      return { kind: 'unreachable', detail: `unexpected ${res.status} from the free pre-check: ${clip(res.body)}` }
    }

    return { kind: 'refused', status: res.status, detail: describe(res.status, res.body) }
  }

  /**
   * Phase 2. The payment header is built by the wallet's own payment path — this client never
   * signs anything and never sees the HSM password.
   */
  async pay(request: AdoptTemplateRequest, paymentHeader: string): Promise<PayResult> {
    const res = await this.post('/pay/policy/adopt-template', request, { [HEADER_PAYMENT]: paymentHeader })
    if (!res.reached) return { kind: 'unreachable', detail: res.detail }

    if (res.status === 202) {
      // The header first, the body second. X-PAYMENT-RESPONSE is returned too, for convention,
      // but it carries no identifier at all — it cannot say which attempt this is.
      // Trimmed and emptiness-checked before the fallback: `??` only steps aside for null and
      // undefined, so an empty header would have skipped the body and landed on
      // `paid_untrackable` while the receipt sat in the body all along (APP-L05).
      const fromHeader = res.headers.get(HEADER_RECEIPT)?.trim()
      const blobId = fromHeader !== undefined && fromHeader !== ''
        ? fromHeader
        : parseJson<{ receipt?: string }>(res.body)?.receipt?.trim()
      if (typeof blobId !== 'string' || blobId === '') {
        // The worst shape in the whole flow: the money has moved and we cannot name the write.
        return {
          kind: 'paid_untrackable',
          detail:
            `the payment was accepted but no ${HEADER_RECEIPT} came back, so this write cannot be ` +
            `collected by this wallet. The server will still complete it; ask again for the same ` +
            `policyKey to be handed the receipt (${clip(res.body)}).`,
        }
      }
      return {
        kind: 'paid',
        blobId,
        detail: parseJson<{ detail?: string }>(res.body)?.detail ?? 'payment accepted, settlement in progress',
      }
    }

    if (res.status >= 200 && res.status < 300) {
      return { kind: 'unreachable', detail: `unexpected ${res.status} where a 202 was expected: ${clip(res.body)}` }
    }

    return { kind: 'refused', status: res.status, detail: describe(res.status, res.body) }
  }

  /**
   * Phase 3. Takes the password because the server signs the permit here and cannot without it —
   * see the file header. It is used for this one call and never stored.
   */
  async collect(blobId: string, ownerAddress: string, ownerHsmPassword: string): Promise<CollectResult> {
    const res = await this.post(
      '/pay/policy/adopt-template/collect',
      { ownerAddress, ownerHsmPassword },
      { [HEADER_RECEIPT]: blobId },
    )
    if (!res.reached) return { kind: 'unreachable', detail: res.detail }

    const body = parseJson<{ state?: string; policyKey?: string; txHash?: string; detail?: string }>(res.body)
    const detail = body?.detail ?? clip(res.body)
    const retryAfter = retrySeconds(res.headers.get('Retry-After'))

    if (res.status === 200) {
      return { kind: 'written', policyKey: body?.policyKey, txHash: body?.txHash, detail }
    }
    if (res.status === 202) {
      // Both 202s mean "come back", and they are told apart by STATE, not by the status code.
      // WRITE_SUBMITTED carries a txHash and is NOT a written policy.
      return body?.state === 'WRITE_SUBMITTED'
        ? { kind: 'submitted', txHash: body?.txHash, retryAfterSeconds: retryAfter, detail }
        : { kind: 'settling', retryAfterSeconds: retryAfter, detail }
    }
    if (res.status === 402) return { kind: 'void', detail }
    if (res.status === 502) return { kind: 'write_failed', txHash: body?.txHash, detail }
    if (res.status === 504) return { kind: 'unknown', detail }

    // Anything else is not a state this flow defines, and it is NOT an outage — the service
    // answered. Terminal, so the caller stops rather than spending another retry key on it.
    return { kind: 'unrecognised', status: res.status, detail: `unexpected ${res.status} from collect: ${clip(res.body)}` }
  }

  private async post(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<
    | { reached: true; status: number; body: string; headers: { get(name: string): string | null } }
    | { reached: false; detail: string }
  > {
    try {
      const res = await this.send(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
        body: JSON.stringify(body),
      })
      return { reached: true, status: res.status, body: await res.text().catch(() => ''), headers: res.headers }
    } catch (e) {
      return { reached: false, detail: `${path} request failed — ${(e as Error).message}` }
    }
  }
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** `Retry-After` is advisory and may be absent, non-numeric, or absurd. */
function retrySeconds(header: string | null): number {
  const n = Number(header)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_AFTER_SECONDS
  // A server asking us to wait an hour is not a reason to hold an MCP call open for an hour; the
  // caller's own polling budget decides when to stop, and it needs a sane interval to work with.
  return Math.min(n, 60)
}

function describe(status: number, body: string): string {
  const detail = parseJson<{ detail?: string; message?: string }>(body)
  return detail?.detail ?? detail?.message ?? `HTTP ${status}${body ? `: ${clip(body)}` : ''}`
}

/** Upstream text reaches an LLM agent as tool output, so it is bounded here rather than downstream. */
function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
