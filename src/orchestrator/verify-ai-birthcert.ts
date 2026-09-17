/**
 * verify-ai-birthcert — drives myid's SSIVC "AI Birthcert" session API to obtain a Verified AI
 * Birthcert VC. The human owner completes MyDigital ID verification out-of-band (they open the
 * returned verificationUrl); this module only creates the session and later checks its status.
 *
 * The only thing a caller supplies is `agentName` — everything else in the SSIVC request body is
 * auto-filled: `id` is a literal copy of `agentName` (mirrors template-aliases.ts's `id` <-
 * `agentUsername` derivation for the Basic Birthcert), and `ownerReference` is this wallet's own
 * `holderDid`. `agentName` must be unique across all Verified AI Birthcert sessions myid has seen
 * — reusing one that is already taken causes issuance to fail downstream.
 */

import { createHash } from 'node:crypto'
import { canonicalizeJson } from '../canonical-json.js'
import {
  SsivcError,
  type SsivcClient,
  type SsivcSessionRequestBody,
  type SsivcSessionCreated,
  type SsivcSessionStatus,
  type SsivcSessionOutcome,
} from '../clients/ssivc-client.js'
import { orderAccepts, isSponsored, type GasPreference } from '../accept-selection.js'
import type { PayRequirement } from '../clients/mbi-client.js'
import type { SsivcSessionStore } from '../clients/ssivc-session-store.js'
import type { DownloadQuarantineStore } from '../clients/ssivc-download-quarantine-store.js'
import type { MbiClient, MbiVcEntry, MbiVpAuth } from '../clients/mbi-client.js'
import { type VcCacheStore, extractValidUntil, isVcValid } from '../clients/vc-cache.js'
import { extractVcPassBase64, writeVcPassImages } from '../clients/vc-pass-image.js'
import { PaymentReadinessError, type PaymentShortfall } from '../payment-readiness.js'
import { PaymentCapError, type PaymentCapDetail } from '../payment-guard.js'

export interface VerifyAiBirthcertDeps {
  ssivc: Pick<SsivcClient, 'createSessionChallenge' | 'createSessionSettle' | 'createSessionWithReceipt' | 'getSession'>
  /** Ed25519-signs a hex blob (-> Wallet BE `/sign-blob`) — reused as-is from the rest of the wallet. */
  signHexBlob: (blobHex: string) => Promise<{ signBlob: string; publicKey: string }>
  /** Signs a UTF-8 message (-> Wallet BE `/sign-message`) — used for MBI's `/vc/ext/download` auth, same scheme as `/vp/ext/*`. */
  messageSigner: (message: string) => Promise<{ signBlob: string; publicKey: string }>
  /** MBI client — only `downloadVcs` is used here. */
  mbi: Pick<MbiClient, 'downloadVcs'>
  /**
   * Self-pay an x402 `accepts[]` entry -> the `X-Payment` header value. The SAME closure
   * `pay_and_fetch`/`subscribe_and_issue` use (wired once in index.ts via PaymentEngine.pay),
   * so the MAX_PAYMENT_AMOUNT cap and insufficient-funds mapping apply here too.
   */
  pay: (accept: PayRequirement) => Promise<string>
  /** The agent holder's own hex-encoded Zetrix public key (see resolve-holder.ts's `publicKeyHex`). */
  publicKeyHex: string
  /** The agent holder's Zetrix address. */
  address: string
  /** The agent holder's own DID — sent as `ownerReference`, and checked against a downloaded VC's `credentialSubject.id`. */
  holderDid: string
  /** Injectable clock so tests don't depend on wall-clock time. */
  now: () => Date
  sessionStore: SsivcSessionStore
  /**
   * The Verified AI Birthcert's own on-chain templateId — distinct from the Basic Birthcert's, so the
   * two never collide in the cache (`vc-cache.ts` keys on `sha256(templateId)`). Auto-derived per
   * network in config.ts from the deployed template (PLAN.md T-16, confirmed 2026-08-05) — always set
   * in practice, kept optional here only so a test can exercise the `cacheError` fallback.
   */
  verifiedTemplateId?: string
  /** Local cache of issued VCs — same store `subscribe_and_issue` writes to, under a different templateId. */
  cache?: VcCacheStore
  /**
   * Persists MBI's raw `/v1/vc/ext/download` response BEFORE any validation — SEC-11/APP-C01. The
   * download is one-shot; a rejection or crash after it but before caching must never destroy the
   * credential. Required, not optional: this is a money-safety property of the download path, not
   * a nice-to-have.
   */
  quarantine: DownloadQuarantineStore
  /** Injectable for tests; defaults to a real timer (`setTimeout`). */
  sleep?: (ms: number) => Promise<void>
  /** Which side pays gas when SSIVC offers a choice. Defaults to 'sponsored'. */
  gasPreference?: GasPreference
  /** Retry budget for a queued sponsored settlement (see {@link DEFAULT_MAX_SETTLEMENT_ATTEMPTS}). */
  maxSettlementAttempts?: number
  /**
   * Renders a raw base-unit amount as "raw (human SYMBOL)" — the SAME closure `pay_and_fetch` uses
   * for its own insufficient-funds/cap messages (index.ts's `formatAssetAmount`). Used by
   * {@link toFacilitatorInsufficientFundsError} so a facilitator-reported shortfall reads as e.g.
   * "1000000 (1 JMYR)" instead of a bare base-unit count against a raw contract address — without
   * it, a caller reading only the raw number is misled into topping up by that many WHOLE tokens
   * (a 1,000,000x overshoot for a 6-decimal asset). Optional so tests can omit it and get the raw
   * fallback, same as before this existed.
   */
  formatAssetAmount?: (asset: string, raw: string) => Promise<string>
  /**
   * Directory to write the MBI pass-design PNG(s) into, decoded from `extraData.vcPassBase64` on
   * the matched download entry. Optional — when unset, the pass image is simply not written
   * (`vcPassImagePaths` stays absent); caching/returning the VC itself is unaffected either way.
   */
  passImagesDir?: string
}

export interface RequestAiBirthcertVerificationInput {
  agentName: string
  agentPurpose?: string
  evidenceAssuranceLevel?: string
  ownerType?: string
  ownerVerified?: string
  /** Per-call override of `deps.gasPreference` for this request only. Omit to use the configured default. */
  gasPayer?: GasPreference
  /**
   * Stop after SSIVC's free phase-1 quote and report it, instead of paying. Mirrors
   * `subscribe_and_issue`'s `dryRun`, so both issuance paths can be priced the same way.
   *
   * Verified live against SSIVC UAT (2026-09-04): a correctly signed session request with no
   * `X-Payment` header returns 402 carrying the full quote, repeatably, and creates **no**
   * server-side session. It does cost one Wallet-BE signing call — SSIVC validates the signature
   * before issuing the challenge — but no funds move.
   *
   * `agentName` is still required (SSIVC rejects a body without one, `422`), but the fee is
   * **name-independent** — two different names return byte-identical quotes. A caller pricing the
   * credential before the user has chosen a name may therefore pass a placeholder, so long as it
   * never presents that placeholder as the name that will be used.
   *
   * A quote does NOT reserve anything and does NOT check name availability — SSIVC's uniqueness
   * check runs at issuance, not at challenge time (a name already taken still quotes cleanly).
   */
  dryRun?: boolean
}

/**
 * SSIVC's free phase-1 price for a Verified AI Birthcert. `maxAmountRequired` is in the asset's raw
 * base units — the same unit the cap is compared in — so a caller rendering it for a human must
 * resolve decimals first.
 */
export interface VerificationQuote {
  /** Native `ZTX`, or a ZTP20 **contract address**. Not fixed — read it rather than assuming. */
  asset: string
  /** Raw base units. */
  maxAmountRequired: string
  payTo?: string
  /** Which side pays network gas for the option that would actually be used. */
  gasModel: 'sponsored' | 'self'
}

/**
 * A failed request. `error` is the human-readable reason; the structured fields carry the same
 * facts in machine-readable form so a caller does not have to parse the sentence — matching what
 * `subscribe_and_issue` already returns as `insufficientFunds`, so the skill can render one set of
 * guidance regardless of which issuance path failed.
 */
export interface RequestVerificationFailure {
  error: string
  /** Set when the wallet lacks funds for gas or the payment itself. See payment-readiness.ts. */
  insufficientFunds?: PaymentShortfall
  /** Set when the spending cap refused the payment — includes which cap key was applied. */
  paymentCap?: PaymentCapDetail
}

export type RequestVerificationResult = SsivcSessionCreated | RequestVerificationFailure | { quote: VerificationQuote }

export type CheckVerificationResult =
  | { status: 'no_session'; message: string }
  | (SsivcSessionStatus & { vc?: unknown; cacheError?: string; verificationUrl?: string; vcPassImagePaths?: string[] })

/** True iff `entry.vc.credentialSubject.id` equals `holderDid`. */
function subjectMatches(vc: unknown, holderDid: string): boolean {
  if (typeof vc !== 'object' || vc === null) return false
  const subject = (vc as Record<string, unknown>).credentialSubject
  const subjectId = typeof subject === 'object' && subject !== null ? (subject as Record<string, unknown>).id : undefined
  return subjectId === holderDid
}

/** Extracts `vc.credentialSubject.id` for a diagnosable mismatch message — "missing" when it can't be found. */
function observedSubjectId(vc: unknown): string {
  if (typeof vc !== 'object' || vc === null) return 'missing'
  const subject = (vc as Record<string, unknown>).credentialSubject
  const subjectId = typeof subject === 'object' && subject !== null ? (subject as Record<string, unknown>).id : undefined
  return typeof subjectId === 'string' && subjectId ? subjectId : 'missing'
}

/** ISO 8601 UTC with second precision, matching the SSIVC API's own example format exactly. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** `getSession`, but a confirmed 404 (the session record itself is gone) is reported as `'gone'` instead of thrown. Any other error propagates — it is NOT confirmed terminal. */
async function getConfirmedStatus(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc'>,
  sessionId: string,
): Promise<SsivcSessionStatus | 'gone'> {
  try {
    return await deps.ssivc.getSession(sessionId)
  } catch (err) {
    if (!(err instanceof SsivcError) || err.httpStatus !== 404) throw err
    return 'gone'
  }
}

/**
 * Decide whether a prior stored session means "replay its settlement receipt" (terminal without a
 * mint — the payment stays settled-but-unconsumed, see SPEC.md §5.1b), "return it as-is" (still
 * pending — do not spawn a second session against the same payment), "pay fresh" (no stored
 * session, or the prior session for this exact agentName already reached `issued` — its receipt is
 * consumed and dead), or "blocked" (the store holds a DIFFERENT agent's still-unconsumed session —
 * APP-M01: overwriting it would silently orphan that receipt or verification link).
 */
type PriorSessionDecision =
  | { kind: 'still_pending'; result: SsivcSessionCreated }
  | { kind: 'replay_receipt'; receipt: string }
  | { kind: 'pay_fresh' }
  | { kind: 'blocked'; message: string }

async function decidePriorSession(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'sessionStore'>,
  agentName: string,
): Promise<PriorSessionDecision> {
  const stored = await deps.sessionStore.get()
  if (!stored) return { kind: 'pay_fresh' }

  // An empty sessionId means "we paid, sponsored settlement was still queued when we gave up, and
  // no session was ever created" (see the SettlementStillQueuedError catch below) — there is no
  // real session id to look up, and SSIVC's own routing 301-redirects a lookup against an empty
  // path segment rather than 404ing it, so calling getConfirmedStatus here would either rethrow an
  // opaque error or silently misbehave. Short-circuit BEFORE any network call: replaying the
  // receipt is the correct resume action regardless of which agentName is on the stored record —
  // same reasoning as R2-L03 below, the receipt is bound to the request body's signature, not to
  // agentName.
  if (stored.sessionId === '') return { kind: 'replay_receipt', receipt: stored.paymentReceipt }

  if (stored.agentName !== agentName) {
    // APP-M01: the store holds exactly one record. Overwriting it below would silently destroy the
    // OTHER agent's settlement receipt (and its verificationUrl) if that payment hasn't been
    // consumed yet. Only proceed once we can confirm it's already dead (issued) or genuinely gone
    // (404). Anything still live and not issued (most concretely: `pending`, per the scenario this
    // fix was written for) blocks the switch.
    const otherStatus = await getConfirmedStatus(deps, stored.sessionId)
    // R2-L03: a 404'd session means a settled-but-orphaned receipt, exactly as in the same-agentName
    // case below — so treat it identically and replay the receipt rather than paying again. The
    // receipt is scoped to the request body's signature (see ssivc-client.ts: `signedData` is what
    // binds a session to a specific agent key), not to agentName at the payment layer, so replaying
    // it under the new agentName's body is the same operation createSessionWithReceipt already does.
    if (otherStatus === 'gone') return { kind: 'replay_receipt', receipt: stored.paymentReceipt }
    if (otherStatus.status === 'pending') {
      return {
        kind: 'blocked',
        message:
          `a verification session for a different agent ("${stored.agentName}") is still in ` +
          `progress (status: "pending") and its payment has not been consumed yet — starting a new ` +
          `session for "${agentName}" would lose track of it. Call check_ai_birthcert_verification ` +
          `to resolve or confirm it first.`,
      }
    }
    if (otherStatus.status === 'issued') return { kind: 'pay_fresh' }
    // Any other confirmed terminal status (e.g. "expired" — confirmed live 2026-08-28: an owner who
    // never completes the MyDigital ID link before the session's TTL elapses) is, per SEC-13
    // (SPEC.md §634), a "settled but unconsumed" case exactly like the 404/"gone" branch above — the
    // receipt is ONLY consumed once a session reaches "issued". Same R2-L03 reasoning applies: safe
    // to replay under the new agentName's signed body regardless of the exact status string.
    return { kind: 'replay_receipt', receipt: stored.paymentReceipt }
  }

  const status = await getConfirmedStatus(deps, stored.sessionId)
  if (status === 'gone') return { kind: 'replay_receipt', receipt: stored.paymentReceipt }
  if (status.status === 'pending') {
    return {
      kind: 'still_pending',
      result: { sessionId: stored.sessionId, verificationUrl: stored.verificationUrl, expiresAt: status.expiresAt },
    }
  }
  if (status.status === 'issued') return { kind: 'pay_fresh' } // receipt consumed — dead
  // APP-M03 / SEC-13: only `issued` consumes the settlement receipt (SPEC.md §634) — every other
  // confirmed terminal status ("expired" — confirmed live 2026-08-28 for a session whose TTL elapsed
  // before the owner completed MyDigital ID verification; and by the same SEC-13 reasoning any other
  // terminal-not-issued value myid may return, e.g. a declined/failed equivalent, SPEC.md D8) leaves
  // the receipt unconsumed. Treat it exactly like the 404/"gone" branch above — replay it — rather
  // than failing closed. `pending` (still in flight) and `issued` (dead receipt) remain the only two
  // statuses handled specially; everything else funnels here.
  return { kind: 'replay_receipt', receipt: stored.paymentReceipt }
}

/** Serializes the decide → pay → persist critical section (APP-M02) — the MCP host does not
 * serialize tool calls, so two concurrent requests could otherwise both read "safe to pay" before
 * either writes, double-charging the wallet. Scoped to the whole process: the session store is a
 * single slot regardless of agentName, so only one AI Birthcert verification can usefully be
 * in flight at a time anyway. */
let requestQueue: Promise<unknown> = Promise.resolve()
function withRequestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(fn, fn)
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Thrown by {@link payAndCreateSession} when SSIVC's 402 challenge carries no payment option — mapped to a `{ error }` result by the caller, same as subscribe.ts's identical "MBI 402 returned no payment options" case. */
class NoPaymentOptionsError extends Error {}

/**
 * Wait budget for sponsored settlement. ms-zetrix submits via AMQP; testnet paymaster latency is
 * high, so a modest number of quick failures is not enough — but it must still terminate.
 */
const DEFAULT_MAX_SETTLEMENT_ATTEMPTS = 20

/**
 * Defensive ceiling on any single retry delay. `retryAfterSeconds` is server-supplied (from SSIVC's
 * `Retry-After` header) and is only guaranteed finite and > 0 — a misbehaving or malicious value
 * (e.g. 999999999) must not be honoured verbatim, or a single attempt could hang for hours. 60s is
 * generous relative to the observed testnet paymaster latency (SSIVC defaults to a 15s suggestion)
 * while keeping the worst case for the whole loop bounded (20 attempts * 60s = 20 minutes).
 */
const MAX_RETRY_DELAY_MS = 60_000

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Thrown when sponsored settlement is still queued after the retry budget is exhausted. This is an
 * INDETERMINATE outcome, not a failure: the payment may yet land at the facilitator. Callers must
 * never treat it as "safe to re-pay" (see Task 5's self-pay-fallback rule). `paymentReceipt` carries
 * the still-live settlement receipt so the caller can persist it (REQ-35) — losing it would mean a
 * later resume attempt paying twice for the same work.
 */
class SettlementStillQueuedError extends Error {
  constructor(message: string, public readonly paymentReceipt: string) {
    super(message)
    this.name = 'SettlementStillQueuedError'
  }
}

/**
 * Thrown when a receipt-retry call (`createSessionWithReceipt`) fails with anything other than a
 * recognized `queued`/`settled` outcome, or the already-handled `blob_already_settled` 409 (see the
 * outer catch's dedicated branch for that one). This covers, among other things, a genuine
 * settlement-failure response from SSIVC — proposed as a 402 with `status_code: "64"` in
 * docs/verified-birthcert-vc/SSIVC_PAYMASTER_CHANGES.md §3.8, but still UNCONFIRMED (open decisions
 * D-P5/S-8) — so this must NOT be assumed to mean "definitively failed, safe to pay fresh". It is
 * an INDETERMINATE outcome, exactly like {@link SettlementStillQueuedError}: we don't know whether
 * the settlement actually failed or is merely still in flight, and guessing wrong risks a double
 * payment. `paymentReceipt` carries the receipt this failed attempt was made against, so the caller
 * can report it and leave the stored record untouched rather than losing track of it. UNLIKE
 * `SettlementStillQueuedError`, this case must never be phrased as "try again shortly" — that wording
 * is only correct when the state is known-recoverable, which an unrecognized error does not confirm.
 */
class SettlementOutcomeUnknownError extends Error {
  constructor(message: string, public readonly paymentReceipt: string) {
    super(message)
    this.name = 'SettlementOutcomeUnknownError'
  }
}

/**
 * Drives a possibly-already-started settlement to a terminal `settled` outcome, retrying with the
 * receipt (never `X-Payment` — REQ-32) until it is or the retry budget runs out. Every retry
 * re-invokes `buildBody`, never reuses a signed envelope: SSIVC rejects a `timestamp` older than 5
 * minutes (error `55`, REQ-28b), and a sponsored settlement can easily outlive that window.
 *
 * `onQueued` is invoked with the receipt the FIRST time (and again any time a later retry returns
 * a DIFFERENT receipt for) a `queued` outcome is observed — not only at give-up. A transient error
 * (a 5xx, a network blip) escaping mid-loop, or the process crashing, must not lose a receipt that
 * was never persisted anywhere else; the give-up write on `SettlementStillQueuedError` alone leaves
 * every attempt before the last one — which is the dominant failure mode over a loop that can run
 * up to 20 minutes — unprotected (REQ-35).
 */
async function resolveSettlement(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'sleep' | 'maxSettlementAttempts'>,
  buildBody: () => Promise<SsivcSessionRequestBody>,
  initialOutcome: SsivcSessionOutcome,
  onQueued: (receipt: string) => Promise<void>,
): Promise<{ session: SsivcSessionCreated; paymentReceipt: string }> {
  const sleep = deps.sleep ?? defaultSleep
  const maxAttempts = deps.maxSettlementAttempts ?? DEFAULT_MAX_SETTLEMENT_ATTEMPTS

  let outcome = initialOutcome
  let lastPersistedReceipt: string | undefined
  if (outcome.kind === 'queued') {
    lastPersistedReceipt = outcome.paymentReceipt
    await onQueued(outcome.paymentReceipt)
  }

  for (let attempt = 0; outcome.kind === 'queued' && attempt < maxAttempts; attempt++) {
    const delayMs = Math.min(outcome.retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS)
    await sleep(delayMs)
    const receiptSent = outcome.paymentReceipt
    try {
      outcome = await deps.ssivc.createSessionWithReceipt(await buildBody(), receiptSent)
    } catch (err) {
      // Anything other than a clean queued/settled outcome here is indeterminate — see
      // SettlementOutcomeUnknownError's docstring. Never silently swallow it or guess a terminal
      // classification; surface it distinctly so the caller (requestAiBirthcertVerificationLocked's
      // outer catch) can report it without touching the stored receipt.
      throw new SettlementOutcomeUnknownError(
        `the settlement outcome for payment receipt ${receiptSent} could not be determined — the ` +
          `receipt-retry call itself failed (${err instanceof Error ? err.message : String(err)})`,
        receiptSent,
      )
    }
    if (outcome.kind === 'queued' && outcome.paymentReceipt !== lastPersistedReceipt) {
      lastPersistedReceipt = outcome.paymentReceipt
      await onQueued(outcome.paymentReceipt)
    }
  }

  if (outcome.kind === 'queued') {
    throw new SettlementStillQueuedError(
      'the sponsored payment is being processed and has not settled yet — no funds are lost and the ' +
        'receipt has been kept; run request_ai_birthcert_verification again shortly to resume',
      outcome.paymentReceipt,
    )
  }
  return { session: outcome.session, paymentReceipt: outcome.paymentReceipt }
}

/**
 * Sponsorship refused before any money moved — safe to retry as self-pay.
 *
 * Classified on the facilitator's NUMERIC error code. `FacilitatorPrepareClient` throws on
 * `!response.ok` before it unwraps the envelope, so the raw error body — including `errorCode` —
 * ends up inside the thrown `Error`'s message (SSIVC_PAYMASTER_CHANGES.md §9.6). The codes are a
 * stable contract; the prose beside them is not.
 */
const DEFINITIVE_PREPARE_REFUSALS = new Set([
  461411, // X402_UNSUPPORTED_NETWORK  — this network is not sponsored
  461414, // X402_RATE_LIMIT_EXCEEDED  — pool rate limit, or the per-address active-prepare cap (default 5)
  461415, // X402_UNSUPPORTED_ASSET    — sponsorship is ZTP-20 only
])

/** Facilitator's `X402_INSUFFICIENT_FUNDS` — see {@link toFacilitatorInsufficientFundsError}. */
const FACILITATOR_INSUFFICIENT_FUNDS_CODE = 461407

function facilitatorErrorCode(err: unknown): number | undefined {
  const m = /"errorCode"\s*:\s*(\d{6})/.exec(err instanceof Error ? err.message : String(err))
  return m ? Number(m[1]) : undefined
}

/**
 * Wraps an error thrown by `deps.pay` specifically — i.e. provably before any settlement was
 * submitted to SSIVC. Without this boundary, a `4614xx`-shaped code arriving from a LATER stage
 * (e.g. SSIVC relaying a facilitator envelope verbatim inside a `createSessionSettle` error body —
 * see `SsivcClient.error()`'s `text` fallback) would be indistinguishable from a genuine /prepare
 * refusal and could trigger a second `deps.pay(...)` after money already moved. `.cause` is
 * unwrapped back out in the outer catch so no existing error mapping/messages change for callers.
 */
class PrepareStageError extends Error {
  constructor(public readonly cause: unknown) {
    super('prepare stage failed')
    this.name = 'PrepareStageError'
  }
}

function isDefinitiveSponsorshipFailure(err: unknown): boolean {
  // Only an error thrown by deps.pay itself is provably pre-money. Anything from
  // createSessionSettle/resolveSettlement — even one that happens to contain the same error-code
  // shape — arrives AFTER the X-Payment blob was submitted and must never be classified as safe to
  // re-pay.
  if (!(err instanceof PrepareStageError)) return false
  const cause = err.cause
  if (cause instanceof SettlementStillQueuedError) return false // indeterminate — never re-pay
  const code = facilitatorErrorCode(cause)
  // Fail CLOSED. An unrecognised error might mean the payment is in flight; re-paying would
  // double-charge. Only the three codes above are provably pre-money.
  if (code === undefined) return false
  return DEFINITIVE_PREPARE_REFUSALS.has(code)
}

// Deliberately NOT definitive:
//   461407 X402_INSUFFICIENT_FUNDS — the wallet lacks the TOKEN, not the gas. Self-pay needs the same
//          token plus ZTX on top, so falling back fails again, slower. Surface it to the user (see
//          toFacilitatorInsufficientFundsError below — it's not a plain "let it throw" case, because
//          the facilitator's own error carries no asset/amount, only a bare "insufficient_funds").
//   461413 X402_UNEXPECTED_ERROR   — indeterminate by definition.

/**
 * The facilitator's own pre-flight ZTP20-balance check (`POST /prepare`) failed with
 * `X402_INSUFFICIENT_FUNDS` (461407) — provably pre-money (see {@link PrepareStageError}), so this
 * never gets a self-pay retry (see the "Deliberately NOT definitive" note above). ms-zetrix's own
 * `ErrorCode.X402_INSUFFICIENT_FUNDS` message can be a bare `"insufficient_funds"` on an
 * older/unfixed facilitator — naming neither the asset nor an amount — so this reshapes it using
 * the ONE thing the wallet has in hand REGARDLESS of what the facilitator returns: the `accept`
 * entry that was being paid, whose `asset`/`maxAmountRequired` are exactly what the facilitator
 * checked against. The raw facilitator text is still appended verbatim (`rawMessage`), and a
 * current facilitator's own balance detail is also parsed out where available (see
 * {@link extractFacilitatorBalance}).
 *
 * Amounts are rendered HUMAN-readable when `formatAssetAmount` is available (resolves the ZTP20
 * contract's real symbol/decimals — e.g. "1 JMYR" instead of "1000000 of asset
 * ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b") — without it, callers were led to top up by the RAW base-
 * unit count as if it were whole tokens (a 1,000,000x overshoot for a 6-decimal asset). Falls back to
 * raw asset/amount when no formatter is configured (e.g. in tests), same as before this existed.
 */
class FacilitatorInsufficientFundsError extends Error {
  constructor(requiredHuman: string, availableHuman: string | undefined, rawMessage: string) {
    super(
      `insufficient funds: the sponsored payment requires ${requiredHuman}` +
        (availableHuman !== undefined ? ` — this wallet currently holds ${availableHuman}` : ' and this wallet does not hold enough of it') +
        ` (facilitator: ${rawMessage})`,
    )
    this.name = 'FacilitatorInsufficientFundsError'
  }
}

/**
 * Extracts the `available` balance the facilitator reported for a 461407, preferring the
 * STRUCTURED `messages[0].detail` field (`[contractAddress, requiredAmount, balance]` — ms-zetrix
 * passes `ApplicationException.getArgs()` straight through) over the bracketed TEXT
 * (`"insufficient_funds [<contractAddress>, <requiredAmount>, <balance>]"`) baked into `message` —
 * that text is free-form prose with no format guarantee, whereas `detail` is a real field on the
 * response schema. Falls back to the text regex for an older facilitator that only emits the
 * bracketed text, and returns `undefined` if neither is present (an older/unfixed facilitator, or
 * the response was truncated — the raw HTTP client caps the captured error body at 300 chars).
 */
function extractFacilitatorBalance(rawMessage: string): string | undefined {
  const braceIdx = rawMessage.indexOf('{')
  if (braceIdx !== -1) {
    try {
      const body = JSON.parse(rawMessage.slice(braceIdx)) as { messages?: Array<{ detail?: unknown }> }
      const detail = body.messages?.[0]?.detail
      // [contractAddress, requiredAmount, balance] — index 2 is the balance (see
      // FacilitatorPrepareService.checkZtp20Balance's ApplicationException args order).
      if (Array.isArray(detail) && detail.length >= 3 && detail[2] !== null && detail[2] !== undefined) {
        return String(detail[2])
      }
    } catch {
      // Truncated or malformed JSON — fall through to the text regex below.
    }
  }
  const m = /insufficient_funds \[[^,]+,\s*[^,]+,\s*([^\]]+)\]/.exec(rawMessage)
  return m ? m[1].trim() : undefined
}

/**
 * Reshape a `461407` failure from `attemptCandidate`'s `PrepareStageError` into
 * {@link FacilitatorInsufficientFundsError}; any other error passes through unchanged. Also passes
 * through unchanged if `accept` itself is missing `asset`/`maxAmountRequired` — both are optional on
 * `PayRequirement`, and a message built from empty strings would be worse than the raw error it's
 * meant to replace.
 */
async function toFacilitatorInsufficientFundsError(
  err: unknown,
  accept: PayRequirement,
  formatAssetAmount?: (asset: string, raw: string) => Promise<string>,
): Promise<unknown> {
  if (!(err instanceof PrepareStageError)) return err
  if (facilitatorErrorCode(err.cause) !== FACILITATOR_INSUFFICIENT_FUNDS_CODE) return err
  const asset = accept.asset ?? ''
  const maxAmountRequired = accept.maxAmountRequired ?? ''
  if (!asset || !maxAmountRequired) return err
  const rawMessage = err.cause instanceof Error ? err.cause.message : String(err.cause)

  const requiredHuman = formatAssetAmount ? await formatAssetAmount(asset, maxAmountRequired) : `${maxAmountRequired} of asset "${asset}"`
  const availableRaw = extractFacilitatorBalance(rawMessage)
  const availableHuman = availableRaw !== undefined && formatAssetAmount ? await formatAssetAmount(asset, availableRaw) : availableRaw

  return new FacilitatorInsufficientFundsError(requiredHuman, availableHuman, rawMessage)
}

/** Pays a single candidate through to a settled session. Threads `onQueued` to {@link resolveSettlement}
 * so a queued receipt is persisted exactly as robustly whether this is the primary or the self-pay
 * fallback attempt. */
async function attemptCandidate(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'pay' | 'sleep' | 'maxSettlementAttempts'>,
  accept: PayRequirement,
  buildBody: () => Promise<SsivcSessionRequestBody>,
  onQueued: (receipt: string) => Promise<void>,
): Promise<{ session: SsivcSessionCreated; paymentReceipt: string }> {
  let xPayment: string
  try {
    xPayment = await deps.pay(accept)
  } catch (err) {
    throw new PrepareStageError(err)
  }
  const initialOutcome = await deps.ssivc.createSessionSettle(await buildBody(), xPayment)
  return resolveSettlement(deps, buildBody, initialOutcome, onQueued)
}

async function payAndCreateSession(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'pay' | 'sleep' | 'gasPreference' | 'maxSettlementAttempts' | 'formatAssetAmount'>,
  buildBody: () => Promise<SsivcSessionRequestBody>,
  onQueued: (receipt: string) => Promise<void>,
): Promise<{ session: SsivcSessionCreated; paymentReceipt: string }> {
  const challenge = await deps.ssivc.createSessionChallenge(await buildBody())
  const candidates = orderAccepts(challenge.accepts, deps.gasPreference ?? 'sponsored')
  const primary = candidates[0]
  if (!primary) throw new NoPaymentOptionsError('SSIVC 402 returned no usable payment options')

  try {
    return await attemptCandidate(deps, primary, buildBody, onQueued)
  } catch (err) {
    // Fall back sponsored -> self-pay ONLY. Never the reverse: if the caller asked to self-pay we
    // must not silently spend platform-subsidised gas instead. And never on an indeterminate
    // outcome, where the first payment may still settle (see Global Constraints).
    const fallback = candidates[1]
    if (!fallback || !isSponsored(primary) || isSponsored(fallback) || !isDefinitiveSponsorshipFailure(err)) {
      throw await toFacilitatorInsufficientFundsError(err, primary, deps.formatAssetAmount)
    }
    return await attemptCandidate(deps, fallback, buildBody, onQueued)
  }
}

export async function requestAiBirthcertVerification(
  deps: VerifyAiBirthcertDeps,
  input: RequestAiBirthcertVerificationInput,
): Promise<RequestVerificationResult> {
  if (!input.agentName || !input.agentName.trim()) {
    throw new Error('requestAiBirthcertVerification: agentName is required')
  }
  const agentName = input.agentName.trim()

  // A quote takes NEITHER the request lock NOR the prior-session check, deliberately. Both exist to
  // stop two paying requests colliding (APP-M02) or one silently orphaning another's receipt
  // (APP-M01) — neither hazard applies to a call that cannot spend and cannot create a session.
  // Routing a quote through them would make preflight unanswerable exactly while a session is in
  // flight, which is when a user most wants to know the price.
  if (input.dryRun) return quoteVerification(deps, agentName, input)

  // withRequestLock must be the very next thing that happens, before any await, so a second
  // concurrent call queues behind this one instead of racing it (APP-M02) — see its docstring.
  return withRequestLock(() => requestAiBirthcertVerificationLocked(deps, agentName, input))
}

/**
 * The signed SSIVC request body. Shared by the paid path and the quote so both send byte-identical
 * bodies — SSIVC verifies `signedData` over the canonical JSON of every other field, and a quote
 * that differed from what would later be paid would be pricing a different request.
 *
 * Rebuilt (and re-signed) on EVERY attempt, never reused: SSIVC rejects a `timestamp` older than 5
 * minutes (error `55`, REQ-28b), and a sponsored settlement retry loop can easily outlive that
 * window.
 */
async function buildSessionBody(
  deps: VerifyAiBirthcertDeps,
  agentName: string,
  input: RequestAiBirthcertVerificationInput,
): Promise<SsivcSessionRequestBody> {
  const fields: Record<string, string> = {
    publicKey: deps.publicKeyHex,
    address: deps.address,
    timestamp: isoSeconds(deps.now()),
    agentName,
    id: agentName,
    ownerReference: deps.holderDid,
  }
  if (input.agentPurpose) fields.agentPurpose = input.agentPurpose
  if (input.evidenceAssuranceLevel) fields.evidenceAssuranceLevel = input.evidenceAssuranceLevel
  if (input.ownerType) fields.ownerType = input.ownerType
  if (input.ownerVerified) fields.ownerVerified = input.ownerVerified

  // signedData covers every field above (never signedData itself) — see canonical-json.ts.
  const digestHex = createHash('sha256').update(canonicalizeJson(fields), 'utf8').digest('hex')
  const { signBlob: signedData } = await deps.signHexBlob(digestHex)
  return { ...fields, signedData } as SsivcSessionRequestBody
}

/** Phase-1 challenge only: no payment header, no settle, no session store, no lock. */
async function quoteVerification(
  deps: VerifyAiBirthcertDeps,
  agentName: string,
  input: RequestAiBirthcertVerificationInput,
): Promise<RequestVerificationResult> {
  const requestedGasPayer = input.gasPayer === 'self' || input.gasPayer === 'sponsored' ? input.gasPayer : undefined
  const body = await buildSessionBody(deps, agentName, input)
  const challenge = await deps.ssivc.createSessionChallenge(body)
  const chosen = orderAccepts(challenge.accepts, requestedGasPayer ?? deps.gasPreference ?? 'sponsored')[0]
  if (!chosen) return { error: 'SSIVC 402 returned no usable payment options' }

  return {
    quote: {
      asset: String(chosen.asset ?? ''),
      maxAmountRequired: String(chosen.maxAmountRequired ?? ''),
      ...(chosen.payTo ? { payTo: String(chosen.payTo) } : {}),
      // Report the option that would actually be paid, not merely what was offered — the ranking
      // already discards a sponsored quote we could not act on.
      gasModel: isSponsored(chosen) ? 'sponsored' : 'self',
    },
  }
}

async function requestAiBirthcertVerificationLocked(
  deps: VerifyAiBirthcertDeps,
  agentName: string,
  input: RequestAiBirthcertVerificationInput,
): Promise<RequestVerificationResult> {
  const decision = await decidePriorSession(deps, agentName)
  if (decision.kind === 'still_pending') return decision.result
  if (decision.kind === 'blocked') return { error: decision.message }

  // Rebuilt (and re-signed) on EVERY attempt, never reused — SSIVC rejects a `timestamp` older than
  // 5 minutes (error `55`, REQ-28b), and a sponsored settlement retry loop can easily outlive that
  // window. This is why a thunk is threaded through payAndCreateSession/resolveSettlement instead
  // of a single pre-built body.
  const buildBody = (): Promise<SsivcSessionRequestBody> => buildSessionBody(deps, agentName, input)

  // REQ-35: the receipt is the only handle on a real, already-paid settlement. Persisted the moment
  // ANY queued outcome is first observed (see resolveSettlement) — not only at give-up — so a
  // transient error mid-loop (a 5xx, a network blip) or the process crashing never loses a receipt
  // that was never written anywhere else. No session/verificationUrl exist yet at that point
  // (settlement never reached a terminal state), so those fields are left blank; resuming
  // automatically from this exact state is tracked as an open decision (D-P9).
  //
  // BEST-EFFORT, deliberately: this write is a real filesystem operation (mkdir/writeFile/rename,
  // see ssivc-session-store.ts) that can transiently reject — ENOSPC, EPERM, an antivirus/file-lock
  // on the rename, all real hazards on Windows. `resolveSettlement` awaits this unguarded at both
  // its call sites, and by the time it runs `deps.pay` has already spent money. A rejection here must
  // NEVER abort the retry loop or surface as an opaque error in place of a graceful
  // SettlementStillQueuedError — completing the settlement the user already paid for matters more
  // than this attempt's durability write landing; the give-up write below remains the backstop that
  // (normally) persists the same receipt anyway.
  const persistQueuedReceipt = async (receipt: string): Promise<void> => {
    try {
      await deps.sessionStore.set({
        sessionId: '',
        agentName,
        createdAt: deps.now().toISOString(),
        verificationUrl: '',
        paymentReceipt: receipt,
      })
    } catch {
      // Swallowed intentionally — see the comment above. Nothing to log to today (no logging
      // convention exists elsewhere in this file); the give-up write is the backstop.
    }
  }

  // MCP schema enum validation is advisory in many hosts — a caller can send any string here, not
  // just the two documented literals. Anything else must be treated as absent so it falls through
  // to deps.gasPreference (which itself falls back to 'sponsored' for any unrecognised value — see
  // config.ts / README), never silently coerced into self-pay by orderAccepts's `!== 'sponsored'`
  // check.
  const requestedGasPayer = input.gasPayer === 'self' || input.gasPayer === 'sponsored' ? input.gasPayer : undefined

  let paid: { session: SsivcSessionCreated; paymentReceipt: string }
  try {
    if (decision.kind === 'replay_receipt') {
      let initialOutcome: SsivcSessionOutcome
      try {
        initialOutcome = await deps.ssivc.createSessionWithReceipt(await buildBody(), decision.receipt)
      } catch (err) {
        // Same indeterminate-outcome treatment as the in-loop retry in resolveSettlement (see
        // SettlementOutcomeUnknownError's docstring) — this is the OTHER call site that replays a
        // receipt via createSessionWithReceipt, so it needs the identical guard.
        throw new SettlementOutcomeUnknownError(
          `the settlement outcome for payment receipt ${decision.receipt} could not be determined — ` +
            `the receipt-replay call itself failed (${err instanceof Error ? err.message : String(err)})`,
          decision.receipt,
        )
      }
      paid = await resolveSettlement(deps, buildBody, initialOutcome, persistQueuedReceipt)
    } else {
      paid = await payAndCreateSession(
        { ...deps, gasPreference: requestedGasPayer ?? deps.gasPreference },
        buildBody,
        persistQueuedReceipt,
      )
    }
  } catch (rawErr) {
    // PrepareStageError is purely an internal classification boundary for payAndCreateSession's
    // fallback decision (see its docstring) — invisible outside it. Unwrap before the existing
    // instanceof ladder so no error mapping/messages change for callers.
    const err = rawErr instanceof PrepareStageError ? rawErr.cause : rawErr
    if (err instanceof PaymentReadinessError) return { error: `insufficient funds: ${err.message}`, insufficientFunds: err.shortfall }
    if (err instanceof PaymentCapError) return { error: err.message, ...(err.detail ? { paymentCap: err.detail } : {}) }
    if (err instanceof NoPaymentOptionsError) return { error: err.message }
    if (err instanceof FacilitatorInsufficientFundsError) return { error: err.message }
    if (err instanceof SettlementStillQueuedError) {
      // Redundant refresh: the receipt was already persisted by persistQueuedReceipt the moment it
      // first appeared as queued (see above). Kept as a belt-and-braces final write in case the very
      // last observed receipt differs from what's already stored (it never should, but this is
      // free and keeps the store's invariant — "reflects the latest known live receipt" — obviously
      // true by inspection here rather than by relying on resolveSettlement's bookkeeping alone).
      //
      // GUARDED, unlike persistQueuedReceipt's own try/catch might suggest is redundant: if the
      // store is failing for a systemic reason (ENOSPC, EPERM, an antivirus file-lock on Windows),
      // persistQueuedReceipt already swallowed that SAME failure silently earlier in this loop — so
      // the receipt was never actually saved anywhere, even though nothing threw at that point. If
      // this write also throws and we let it propagate, it would replace the graceful "run again to
      // resume" message with a raw filesystem exception that never mentions a payment happened —
      // the caller would have no record and no receipt, and their next call would see an empty store
      // and double-pay. Fall back to the same graceful message with the receipt appended instead.
      try {
        await deps.sessionStore.set({
          sessionId: '',
          agentName,
          createdAt: deps.now().toISOString(),
          verificationUrl: '',
          paymentReceipt: err.paymentReceipt,
        })
      } catch {
        return {
          error:
            err.message +
            ` (could not save the receipt locally — keep this value to resume manually: ${err.paymentReceipt})`,
        }
      }
      return { error: err.message }
    }
    // REQ-37/AC-17 (SPEC.md §5.1/§11): a 409 means our fresh X-Payment blob was already settled —
    // most likely a prior attempt's settlement succeeded but its response was lost before we could
    // persist the receipt (§9's documented "lost 2xx" gap). SSIVC doesn't tell us the receipt on a
    // 409 (open decision D11), so we can't auto-recover it here — but we MUST NOT let this surface
    // as an unhandled/opaque error either. Report it distinctly so the caller knows retrying blindly
    // won't help and a human may need to check whether the payment actually went through.
    if (err instanceof SsivcError && err.kind === 'blob_already_settled') {
      return { error: `payment already settled for this attempt: ${err.message}` }
    }
    // Indeterminate settlement outcome from a receipt-retry/replay call (see
    // SettlementOutcomeUnknownError's docstring). We deliberately do NOT touch the session store
    // here: the existing sessionId: ''/receipt record (persisted by persistQueuedReceipt the moment
    // settlement was first observed as queued) is left exactly as-is. Clearing or overwriting it
    // would let a future call treat this as "safe to pay fresh" — that is precisely the guess this
    // fix must not make, since we cannot confirm whether the settlement genuinely failed or is still
    // in flight. Report it plainly instead of letting it surface as an opaque unhandled throw, and
    // point at manual/operator investigation rather than "try again" — unlike
    // SettlementStillQueuedError, this state is not known-recoverable.
    if (err instanceof SettlementOutcomeUnknownError) {
      return {
        error:
          `could not determine whether the sponsored settlement succeeded or failed for payment ` +
          `receipt ${err.paymentReceipt} (${err.message}) — this is NOT a confirmed failure, so the ` +
          `receipt has been kept as-is and no new payment has been attempted; this requires manual ` +
          `investigation by an operator before retrying, rather than calling ` +
          `request_ai_birthcert_verification again`,
      }
    }
    throw err
  }

  await deps.sessionStore.set({
    sessionId: paid.session.sessionId,
    agentName,
    createdAt: deps.now().toISOString(),
    verificationUrl: paid.session.verificationUrl,
    paymentReceipt: paid.paymentReceipt,
  })

  return paid.session
}

export async function checkAiBirthcertVerification(
  deps: Pick<
    VerifyAiBirthcertDeps,
    'ssivc' | 'sessionStore' | 'mbi' | 'messageSigner' | 'address' | 'holderDid' | 'verifiedTemplateId' | 'cache' | 'quarantine' | 'passImagesDir'
  >,
): Promise<CheckVerificationResult> {
  const stored = await deps.sessionStore.get()
  if (!stored) {
    return {
      status: 'no_session',
      message: 'No verification session found for this wallet — call request_ai_birthcert_verification first.',
    }
  }
  // Same root cause as decidePriorSession's empty-sessionId short-circuit: this record means a
  // sponsored payment was made and settlement was still queued when the caller gave up — no session
  // was ever created, so there is no sessionId to look up (SSIVC 301-redirects a lookup against an
  // empty path segment instead of 404ing it). Report this distinctly rather than calling getSession.
  if (stored.sessionId === '') {
    return {
      status: 'no_session',
      message:
        'a sponsored payment is still settling and no verification session exists yet — the payment ' +
        'receipt has been kept, so calling request_ai_birthcert_verification again resumes it and ' +
        'will not pay twice.',
    }
  }
  const status = await deps.ssivc.getSession(stored.sessionId)
  // R13: replay the link we stored at creation. SSIVC issues `verification_url` exactly once, in the
  // create response — `getSession` never returns it — so this store is the only place it survives.
  // Without this, "where is my link again?" can only be answered by request_ai_birthcert_verification,
  // which is the *paid* tool: it would not charge on the still-pending path, but it would prompt the
  // user to approve a payment in order to re-read a link they have already bought.
  //
  // Only while the session can still be acted on. Once myid has issued, the link is spent, and
  // handing it back would send the owner into a MyDigital ID flow that is already finished.
  if (status.status !== 'issued' && stored.verificationUrl) {
    return { ...status, verificationUrl: stored.verificationUrl }
  }
  if (status.status !== 'issued' || !status.vcId) return status
  const vcId = status.vcId

  // Already fetched and cached by an earlier call — no need to hit MBI again, as long as that
  // cached entry hasn't since expired (an expired cache hit falls through to re-fetch below).
  if (deps.verifiedTemplateId && deps.cache) {
    const cached = await deps.cache.get(deps.verifiedTemplateId)
    if (cached && cached.vcId === status.vcId && isVcValid(cached)) return { ...status, vc: cached.vc }
  }

  if (!deps.verifiedTemplateId || !deps.cache) {
    return { ...status, cacheError: 'AI Birthcert verified-template id is not configured — cannot fetch or cache the credential yet.' }
  }

  // SEC-11/APP-C01: MBI's /v1/vc/ext/download is one-shot — a second live call for the same vcId
  // returns 404, not the credential again (SPEC.md §5.4 REQ-25). If a prior call already downloaded
  // and quarantined this exact vcId, re-validate from that copy instead of hitting MBI again — a
  // fresh call at this point would just fail, permanently, for no reason.
  // R2-M01: the store is keyed by vcId, so this lookup either returns THIS vcId's quarantined
  // download or null — it can never hand back some other agent's entry.
  //
  // Locked per vcId (APP-L03): a bare get-then-download-then-set here lets two concurrent
  // check_ai_birthcert_verification calls for the same vcId both miss the `get` and both hit MBI's
  // one-shot download — one gets a 404. withLock serializes them so the second (now-queued) caller's
  // `get` sees the first caller's `set`.
  const quarantineFilePath = deps.quarantine.filePathFor(vcId)
  const locked = await deps.quarantine.withLock(vcId, async (): Promise<{ entries: MbiVcEntry[] } | { error: string }> => {
    const quarantined = await deps.quarantine.get(vcId)
    if (quarantined) return { entries: quarantined.entries as MbiVcEntry[] }

    const auth: MbiVpAuth = await deps.messageSigner(deps.address).then((r) => ({ signedData: r.signBlob, publicKey: r.publicKey }))
    let downloaded: MbiVcEntry[]
    try {
      downloaded = await deps.mbi.downloadVcs({ address: deps.address }, auth)
    } catch (err) {
      // APP-L02 (prior review): this is exactly the "transient MBI error" the tool description already
      // promises becomes a cacheError, not a throw — so a caller can safely retry check_ai_birthcert_verification.
      return { error: `failed to fetch credential from MBI: ${err instanceof Error ? err.message : String(err)}` }
    }
    // Persist BEFORE any validation below — a rejection or a crash from here on must never destroy
    // a credential that was already paid for and fetched (SEC-11). Every entry is quarantined, not
    // just the one matching this vcId, since a single download response can carry more than one VC.
    await deps.quarantine.set({ vcId, entries: downloaded, downloadedAt: new Date().toISOString() })
    return { entries: downloaded }
  })
  if ('error' in locked) return { ...status, cacheError: locked.error }
  const entries = locked.entries

  const match = entries.find((e) => typeof e.vc === 'object' && e.vc !== null && (e.vc as Record<string, unknown>).id === status.vcId)

  if (!match) {
    return {
      ...status,
      cacheError:
        `no matching credential found in MBI's download for vcId ${status.vcId} — raw response ` +
        `preserved for recovery at ${quarantineFilePath}`,
    }
  }
  if (!subjectMatches(match.vc, deps.holderDid)) {
    return {
      ...status,
      cacheError:
        `downloaded credential subject (${observedSubjectId(match.vc)}) does not match this wallet's ` +
        `holderDid (${deps.holderDid}) — refusing to cache; raw response preserved for recovery at ` +
        `${quarantineFilePath}`,
    }
  }

  const validUntil = extractValidUntil(match.vc)
  if (!validUntil) {
    return {
      ...status,
      cacheError:
        `downloaded credential has no validUntil — refusing to cache indefinitely; raw response ` +
        `preserved for recovery at ${quarantineFilePath}`,
    }
  }
  // R2-M02: the cache-hit branch above already refuses an expired entry, so caching + returning an
  // already-expired credential here would make this tool report success on something `prove_identity`
  // (which applies the same isVcValid gate) refuses — and the next call would reject the cache entry
  // and land right back here, forever. Reject it once, consistently, instead.
  if (!isVcValid({ validUntil })) {
    return {
      ...status,
      cacheError:
        `downloaded credential expired at ${validUntil} — refusing to cache or return; raw response ` +
        `preserved for recovery at ${quarantineFilePath}`,
    }
  }

  // Best-effort: MBI's pass-design PNG(s) for this VC, when configured and present. Never blocks
  // or fails the (already-validated, already-paid-for) credential above it — a write failure
  // (e.g. an unwritable pass-images dir) must degrade to undefined rather than reject (APP-M01).
  const vcPassImagePaths = deps.passImagesDir
    ? await (async () => {
        try {
          const base64Images = extractVcPassBase64(match.extraData)
          return base64Images ? await writeVcPassImages(deps.passImagesDir!, status.vcId!, base64Images) : undefined
        } catch {
          return undefined
        }
      })()
    : undefined

  await deps.cache.set(deps.verifiedTemplateId, {
    templateId: deps.verifiedTemplateId,
    vc: match.vc,
    vcId: status.vcId,
    issuedAt: new Date().toISOString(),
    validUntil,
    ...(vcPassImagePaths ? { vcPassImagePaths } : {}),
  })

  return { ...status, vc: match.vc, ...(vcPassImagePaths ? { vcPassImagePaths } : {}) }
}
