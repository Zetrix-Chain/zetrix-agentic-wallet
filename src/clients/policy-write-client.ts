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
 * a failure.
 *
 * WHAT THIS FILE DOES NOT DO, and the reason the ticket calls it assembly rather than capability:
 * no blob building, no permit digest, no canonical-attributes JSON, no node submission. ms-zetrix
 * computes and signs the permit with the owner's own HSM key, exactly as it already does on the
 * JWT path, and the paymaster POLICY pool pays the gas. A second canonical-JSON implementation in
 * TypeScript would have to match the contract's re-serialisation byte for byte, and a one-byte
 * difference is an invalid signature discovered only after gas is spent.
 *
 * FOUR PLACES WHERE THE SERVER DIFFERS FROM THE SPEC'S TEXT, all read from `developv2` 2026-09-28
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
  /** POLICY_PAID_WRITE_IN_FLIGHT: a paid write for this policy is still being completed and no receipt came with it. Not "it exists". */
  | { kind: 'in_progress'; detail: string }
  /**
   * ALREADY PAID FOR — collect it. The server returns the existing receipt rather than a fresh
   * 402, because "a settlement that hangs must never turn into a second charge". This is also how
   * a wallet that lost its bookmark gets it back, so it is a RECOVERY path, not a failure.
   */
  | { kind: 'already_in_flight'; blobId: string; operation?: 'CREATE' | 'UPDATE'; detail: string }
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
   * six keys wide and a failure consumes one, so a client that retries into an
   * unrecognised status can exhaust the series for a write that has already been paid for.
   */
  | { kind: 'unrecognised'; status: number; detail: string }
  /**
   * A 5xx that is NOT the service reporting a money state. The service's own 502 and 504 always
   * carry JSON with `state: "WRITE_FAILED"` / `"UNKNOWN"`; anything else — a Spring default error
   * body, a Cloudflare "origin returned an invalid response" page, a bare 503 — means the result
   * of the write was NEVER SEEN. `gateway` is true when something in front of the service answered
   * instead of it. Reading a gateway 502 as the service's "the chain rejected it" tells a user a
   * paid write failed on chain when nobody knows what happened to it.
   */
  | { kind: 'server_error'; status: number; gateway: boolean; detail: string }
  | { kind: 'unreachable'; detail: string }

/** What an UPDATE records when the payment is taken. No template fields (the server carries the current one forward) and no requestKey (the server derives it). */
export interface UpdateRequest {
  ownerAddress: string
  policyKey: string
  /** The full replacement set. */
  attributes: Array<{ attributeName: string; attributeType?: string; value: string }>
  /** Sent as given, never defaulted: an omitted bound would strip an existing one. */
  validFromBlock?: string
  validToBlock?: string
  /** The policy's `updatedAtBlock` as the caller read it, as a string. A mismatch is refused before any charge. */
  expectedUpdatedAtBlock: string
}

/** Which paid route a payment or a receipt belongs to. */
export type WriteRoute = 'adopt-template' | 'update'

/** Phase 1 of an update — free. Everything but `payment_required` means nothing was asked of the wallet's money. */
export type UpdatePrecheckResult =
  | { kind: 'payment_required'; challenge: PaymentChallenge }
  /** A paid write for this policy is waiting to be collected. `operation` says which write the receipt pays for; it may not be the one just asked for. */
  | { kind: 'already_in_flight'; blobId: string; operation?: 'CREATE' | 'UPDATE'; detail: string }
  /** POLICY_KEY_NOT_FOUND: there is nothing to update. */
  | { kind: 'not_found'; detail: string }
  /** POLICY_MODIFIED: the policy changed since `expectedUpdatedAtBlock` was read. */
  | { kind: 'modified'; detail: string }
  /** POLICY_TEMPLATE_NOT_FOUND: the template the policy references no longer exists. */
  | { kind: 'template_unavailable'; detail: string }
  /** POLICY_PAID_WRITE_IN_FLIGHT: a write for this policy is still in progress, and no receipt came with it. */
  | { kind: 'in_progress'; detail: string }
  | { kind: 'refused'; status: number; detail: string }
  | { kind: 'unreachable'; detail: string }

/** The free remove. `submitted` is NOT removed: only a chain read showing the policy gone says that. */
export type RemoveResult =
  | { kind: 'submitted'; txHash?: string; policyKey?: string; state?: string; retryAfterSeconds: number }
  /** There was no such policy: it never existed, or it has already been removed. */
  | { kind: 'not_found'; detail: string }
  /** A paid update for this policy has not been collected yet. */
  | { kind: 'in_progress'; detail: string }
  | { kind: 'refused'; status: number; detail: string }
  | { kind: 'server_error'; status: number; gateway: boolean; detail: string }
  /** A 2xx that is not the documented 202: whether the removal went through is NOT known. */
  | { kind: 'unrecognised'; status: number; detail: string }
  | { kind: 'unreachable'; detail: string }

/** The service's numeric error codes (ms-zetrix `ErrorCode`), as they arrive in `messages[].errorCode`. */
const ERROR_POLICY_MODIFIED = 461503
const ERROR_POLICY_KEY_NOT_FOUND = 461505
const ERROR_POLICY_TEMPLATE_NOT_FOUND = 461512
const ERROR_PAID_WRITE_IN_FLIGHT = 461529

/** The first numeric `errorCode` in the service's error envelope `{ messages: [{ errorCode, message }] }`. */
function errorCodeOf(body: string): number | undefined {
  // `messages` is only trusted when it really is an array: a string, object or number there (a gateway, a non-standard body)
  // has no `.find`, and this runs after a payment may have been presented, so it must never throw.
  const messages = (parseJson<unknown>(body) as { messages?: unknown } | null | undefined)?.messages
  if (!Array.isArray(messages)) return undefined
  for (const m of messages) {
    const code = (m as { errorCode?: unknown } | null)?.errorCode
    if (typeof code === 'number') return code
  }
  return undefined
}

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
      const body = parseJson<{ state?: string; receipt?: string; operation?: string; detail?: string }>(res.body)
      // Two meanings, and they could not be further apart: one says the write is impossible, the
      // other says it is already bought and waiting to be collected.
      if (body?.state === 'ALREADY_IN_FLIGHT' && typeof body.receipt === 'string' && body.receipt !== '') {
        return {
          kind: 'already_in_flight',
          blobId: body.receipt,
          // Which write the receipt pays for. It may not be the one just asked for, and it decides the collect route.
          ...(body.operation === 'CREATE' || body.operation === 'UPDATE' ? { operation: body.operation } : {}),
          detail: body.detail ?? 'this write has already been paid for — collect it',
        }
      }
      // POLICY_PAID_WRITE_IN_FLIGHT (461529): a paid write for this policy is still being completed and no receipt came with
      // it. That is not "the policy already exists", and "nothing was paid" is NOT true of it.
      if (errorCodeOf(res.body) === ERROR_PAID_WRITE_IN_FLIGHT) return { kind: 'in_progress', detail: describe(res.status, res.body) }
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
   * signs anything and never sees the HSM password. `route` is the paid route being paid for; it defaults to the create.
   */
  async pay(request: AdoptTemplateRequest | UpdateRequest, paymentHeader: string, route: WriteRoute = 'adopt-template'): Promise<PayResult> {
    const res = await this.post(`/pay/policy/${route}`, request, { [HEADER_PAYMENT]: paymentHeader })
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
  async collect(
    blobId: string,
    ownerAddress: string,
    ownerHsmPassword: string,
    operation: 'CREATE' | 'UPDATE' = 'CREATE',
  ): Promise<CollectResult> {
    const res = await this.post(
      operation === 'UPDATE' ? '/pay/policy/update/collect' : '/pay/policy/adopt-template/collect',
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
    // 502 and 504 are the SERVICE's only when its body says so. A bare status code is not enough: a
    // proxy in front of it returns the same codes with an HTML page, and for 502 that is the
    // difference between "the chain rejected the write" and "we never heard back".
    const serviceState = typeof body?.state === 'string' ? body.state : undefined
    if (res.status === 502 && serviceState === 'WRITE_FAILED') return { kind: 'write_failed', txHash: body?.txHash, detail }
    if (res.status === 504 && serviceState === 'UNKNOWN') return { kind: 'unknown', detail }
    // The service answered with a state this wallet does not know: its word, but not one we can read.
    // Unrecognised (terminal, receipt kept), NOT a gateway fault — nothing intervened.
    if (res.status >= 500 && serviceState !== undefined) {
      return { kind: 'unrecognised', status: res.status, detail: `unexpected ${res.status} from collect: ${clip(res.body)}` }
    }
    if (res.status >= 500) {
      const html = looksLikeHtml(res.body)
      const gateway = serviceState === undefined && (html || [502, 503, 504].includes(res.status) || res.status >= 520)
      return {
        kind: 'server_error',
        status: res.status,
        gateway,
        // An HTML error page is markup, not a message: show its text, bounded.
        detail: html ? clip(stripTags(res.body), 160) : clip(res.body),
      }
    }

    // Anything else is not a state this flow defines, and it is NOT an outage — the service
    // answered. Terminal, so the caller stops rather than spending another retry key on it.
    return { kind: 'unrecognised', status: res.status, detail: `unexpected ${res.status} from collect: ${clip(res.body)}` }
  }

  /**
   * Phase 1 of an UPDATE. Free, and it never sends a payment header. The same shape as {@link precheck}, with the
   * refusals an update adds: the policy is not there, it changed since `expectedUpdatedAtBlock` was read, or the
   * template it references is gone. Each of those is answered BEFORE any charge, so none of them can cost money.
   */
  async precheckUpdate(request: UpdateRequest): Promise<UpdatePrecheckResult> {
    const res = await this.post('/pay/policy/update', request)
    if (!res.reached) return { kind: 'unreachable', detail: res.detail }

    if (res.status === 402) {
      const challenge = parseJson<PaymentChallenge>(res.body)
      if (!challenge || !Array.isArray(challenge.accepts) || challenge.accepts.length === 0) {
        return { kind: 'unreachable', detail: `the 402 carried no usable terms: ${clip(res.body)}` }
      }
      return { kind: 'payment_required', challenge }
    }

    const code = errorCodeOf(res.body)
    const detail = describe(res.status, res.body)

    if (res.status === 409) {
      const body = parseJson<{ state?: string; receipt?: string; operation?: string; detail?: string }>(res.body)
      if (body?.state === 'ALREADY_IN_FLIGHT' && typeof body.receipt === 'string' && body.receipt !== '') {
        return {
          kind: 'already_in_flight',
          blobId: body.receipt,
          ...(body.operation === 'CREATE' || body.operation === 'UPDATE' ? { operation: body.operation } : {}),
          detail: body.detail ?? 'a paid write for this policy is waiting to be collected',
        }
      }
      if (code === ERROR_POLICY_MODIFIED) return { kind: 'modified', detail }
      if (code === ERROR_PAID_WRITE_IN_FLIGHT) return { kind: 'in_progress', detail }
      return { kind: 'refused', status: res.status, detail }
    }
    if (res.status === 404) {
      if (code === ERROR_POLICY_KEY_NOT_FOUND) return { kind: 'not_found', detail }
      if (code === ERROR_POLICY_TEMPLATE_NOT_FOUND) return { kind: 'template_unavailable', detail }
      return { kind: 'refused', status: res.status, detail }
    }
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'unreachable', detail: `unexpected ${res.status} from the free pre-check: ${clip(res.body)}` }
    }
    // A 5xx or a gateway page is the service not answering, not a refusal of this update. Nothing was paid either way.
    if (res.status >= 500) {
      return { kind: 'unreachable', detail: `the service answered HTTP ${res.status} instead of a decision: ${looksLikeHtml(res.body) ? clip(stripTags(res.body), 160) : detail}` }
    }
    return { kind: 'refused', status: res.status, detail }
  }

  /**
   * The free, one-call REMOVE (`POST /pay/policy/remove`). No payment and no collect: the permit is signed in this
   * call, so the password travels with it and is used for this call alone.
   *
   * A 202 means SUBMITTED. The policy is gone only once the block confirms it, and the server says the same: "read it
   * back to be sure". Repeating the call never submits a second removal, so a retry is safe.
   */
  async remove(ownerAddress: string, policyKey: string, ownerHsmPassword: string): Promise<RemoveResult> {
    const res = await this.post('/pay/policy/remove', { ownerAddress, policyKey, ownerHsmPassword })
    if (!res.reached) return { kind: 'unreachable', detail: res.detail }

    if (res.status === 202) {
      const body = parseJson<{ state?: string; policyKey?: string; txHash?: string }>(res.body)
      return {
        kind: 'submitted',
        ...(typeof body?.txHash === 'string' ? { txHash: body.txHash } : {}),
        ...(typeof body?.policyKey === 'string' ? { policyKey: body.policyKey } : {}),
        ...(typeof body?.state === 'string' ? { state: body.state } : {}),
        retryAfterSeconds: retrySeconds(res.headers.get('Retry-After')),
      }
    }

    const code = errorCodeOf(res.body)
    const detail = describe(res.status, res.body)
    if (res.status === 404 && code === ERROR_POLICY_KEY_NOT_FOUND) return { kind: 'not_found', detail }
    if (res.status === 409 && code === ERROR_PAID_WRITE_IN_FLIGHT) return { kind: 'in_progress', detail }
    // A 2xx that is not the documented 202 may well mean the removal went through: it is UNKNOWN, never "nothing was removed".
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'unrecognised', status: res.status, detail: `unexpected ${res.status} from remove: ${clip(res.body)}` }
    }
    if (res.status >= 500) {
      const html = looksLikeHtml(res.body)
      return {
        kind: 'server_error',
        status: res.status,
        gateway: html || [502, 503, 504].includes(res.status) || res.status >= 520,
        detail: html ? clip(stripTags(res.body), 160) : detail,
      }
    }
    return { kind: 'refused', status: res.status, detail }
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
  const parsed = parseJson<unknown>(body)
  const obj = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  // The service's error envelope keeps its words in messages[].message. Only an ARRAY is read (see errorCodeOf), and a
  // malformed one falls through to the next source instead of throwing: this is called after a payment may have been presented.
  let fromEnvelope: string | undefined
  if (Array.isArray(obj?.messages)) {
    for (const m of obj.messages as unknown[]) {
      const t = text((m as { message?: unknown } | null)?.message)
      if (t !== undefined) {
        fromEnvelope = t
        break
      }
    }
  }
  return text(obj?.detail) ?? text(obj?.message) ?? (fromEnvelope !== undefined ? clip(fromEnvelope) : undefined) ?? `HTTP ${status}${body ? `: ${clip(body)}` : ''}`
}

/** Upstream text reaches an LLM agent as tool output, so it is bounded here rather than downstream. */
/** Does this body look like an HTML page rather than the JSON this API speaks? */
function looksLikeHtml(text: string): boolean {
  return /^\s*<(!doctype|html|head|body)\b/i.test(text)
}

/** Text content of an HTML page, whitespace collapsed. Good enough to quote, not to parse. */
function stripTags(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
