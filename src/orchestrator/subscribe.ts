/**
 * subscribeAndIssue — MBI x402 VC-issuance orchestrator.
 *
 * Full paid flow (payment-required=true, `/quote` skipped — build `data` deterministically):
 *   1. data = canonical VC payload  [{ templateId, metadata }]
 *   2. holder-sign `data` (Ed25519 via Wallet BE)              → { signData, publicKey }
 *   3. MBI applyChallenge { data, signData, publicKey }        → 402 { accepts, paymentId }
 *   4. self-pay the x402 challenge (Wallet BE signer)          → X-PAYMENT
 *   5. MBI applySettle { …, paymentId } + X-PAYMENT            → issued VC
 * MBI verifies/settles on-chain and issues the VC itself; the wallet returns it to the
 * client (client-held).
 *
 * `sign` and `pay` are injected (wired to Wallet BE + x402 in index.ts), so this
 * unit-tests without a live signer or node.
 *
 * The asset in step 3's 402 challenge is not fixed — MBI may quote the native ZETRIX
 * token (asset code `ZTX`) or a ZTP20 token (e.g. `JMYR`); never assume which one before
 * reading `accepts[0].asset`. `opts.dryRun` stops after this free phase-1 quote so a
 * caller can see the actual asset/amount before step 4 spends real funds.
 *
 * The `data` field sent to MBI is the **raw canonical JSON string** `[{templateId, metadata}]`,
 * NOT hex. MBI is self-consistent on this: it issues via `objectMapper.readTree(data)` AND both
 * signs and verifies the holder
 * signature over `HexFormat.hexStringToBytes(data)` — a LENIENT decode of the raw-JSON string
 * (see src/zetrix-hex.ts), NOT `utf8(data)`.
 *
 * So the holder must sign exactly those `hexStringToBytes(data)` bytes. Wallet BE `/sign-blob`
 * signs `hexStringToBytes(blob)`, so we pass the **canonical hex of the pre-computed bytes** as the
 * blob → the HSM signs the same bytes MBI verifies, regardless of the HSM's own hex leniency.
 * (Two earlier misfires: hex-encoding the whole `data` field broke issuance `readTree`; signing
 * `utf8(data)` gave `401 X402_SIGNATURE_INVALID`.) `data`'s key order `{templateId, metadata}`
 * must be byte-identical to MBI's `constructSignData`.
 */

import {
  MbiError,
  MBI_SETTLEMENT_INDETERMINATE,
  type MbiClient,
  type MbiApplyBody,
  type PayRequirement,
} from '../clients/mbi-client.js'
import { zetrixHexStringToBytes } from '../zetrix-hex.js'
import { type VcCacheStore, isVcValid, extractValidUntil, extractAttributeKeys } from '../clients/vc-cache.js'
import type { TemplateFields } from '../clients/template-info-client.js'
import { PaymentReadinessError, type PaymentShortfall } from '../payment-readiness.js'

export interface SubscribeDeps {
  /**
   * `getStatus` is optional: without it an indeterminate settle is reported but not
   * investigated (the prior behaviour). With it, the orchestrator polls
   * `/v1/vc/pay/status/{paymentId}` to find out whether the payment actually landed.
   */
  mbi: Pick<MbiClient, 'applyChallenge' | 'applySettle'> & Partial<Pick<MbiClient, 'getStatus'>>
  /** Holder-signs the canonical VC-payload `data` (Ed25519 via Wallet BE). */
  sign: (data: string) => Promise<{ signBlob: string; publicKey: string }>
  /** Self-pay the x402 challenge and return the `X-PAYMENT` header value. */
  pay: (accept: PayRequirement) => Promise<string>
  /**
   * Resolve the paid asset's display symbol from chain (a ZTP20 contract address →
   * its `contractInfo.symbol`; `"ZTX"` passes through). Optional — when omitted, the
   * raw `accept.asset` string is reported as-is.
   */
  resolveSymbol?: (asset: string) => Promise<string>
  /**
   * The wallet's own resolved holder DID. Auto-filled into `attributes.agentDid` when the
   * caller omits it AND `resolveTemplateFields` confirms the template declares `agentDid` as a
   * valid key — the wallet already knows this from onboarding (resolve-holder.ts), so the caller
   * shouldn't have to guess it. See `resolveTemplateFields` below for why this auto-fill is
   * gated on the template's declared schema rather than unconditional.
   */
  holderDid: string
  /**
   * Resolve a template's declared attribute keys from chain (the issuer-registered `applyFormat`,
   * read via the node's getAccountMetaData) — both the mandatory subset and the full declared key
   * set. Optional — when omitted, or when it returns `null` (node error / template not found /
   * malformed), the missing-required-field check below is skipped (fail-open; MBI stays the
   * validation backstop). The `agentDid` auto-fill above, however, is fail-CLOSED on this same
   * `null`: MBI rejects unknown attribute keys (but only after payment settles), so auto-filling
   * `agentDid` on an unconfirmed guess would burn funds on a guaranteed failure for any template
   * that doesn't declare it — confirmed live against the AI Birthcert template. See
   * template-info-client.ts.
   */
  resolveTemplateFields?: (templateId: string) => Promise<TemplateFields | null>
  /**
   * Local cache of previously-issued VCs, keyed by templateId. Optional — when omitted,
   * every call pays and issues fresh (the prior behaviour). When present, a still-valid
   * cached VC is returned instead of paying again; a fresh issuance is written back to it.
   */
  cache?: VcCacheStore
  /** Delay between recovery polls. Injectable so tests don't wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

export interface SubscribeOpts {
  templateId: string
  attributes: Record<string, unknown>
  expirationDate?: string
  /** Stop after MBI's free phase-1 quote and report it, instead of paying + settling. */
  dryRun?: boolean
  /** Skip the cache and pay + issue fresh regardless of what's cached. */
  forceReissue?: boolean
}

export interface Quote {
  /** The asset MBI is actually charging for this template — native ZETRIX ("ZTX") or a ZTP20 token (e.g. "JMYR"). Not fixed; read this rather than assuming. */
  asset?: string
  maxAmountRequired?: string
  payTo?: string
}

/** The template's full declared schema (from chain) — both what's required and what's merely available. */
export interface TemplateSchema {
  required: string[]
  optional: string[]
}

export interface SubscribeResult {
  issued: boolean
  vcId?: string
  vc?: unknown
  txHash?: string
  reason?: string
  /** Free phase-1 quote — present when `dryRun` is set (asset symbol resolved from chain). */
  quote?: Quote
  /** The fee asset actually paid — the on-chain token symbol (e.g. `JMYR`), not the contract address. */
  paidAsset?: string
  /** The fee amount paid, in the asset's smallest raw unit. */
  amountPaid?: string
  /** True when this VC was served from the local cache — no payment was made on this call. */
  fromCache?: boolean
  /**
   * What the *original* issuance of a cached VC cost, when known. Only set alongside
   * `fromCache` — deliberately kept out of `txHash`/`paidAsset`/`amountPaid` so a free cache
   * hit can never be mistaken for (or summed as) a fresh charge.
   */
  originalPayment?: { txHash?: string; asset?: string; amount?: string }
  /**
   * The payment that had already been made when issuance failed. Phase 2 (`applySettle`) runs
   * *after* the x402 payment is on chain, so a failure there — e.g. MBI 4006 "Facilitator
   * settlement failed: timeout" — still costs real funds while returning no VC. MBI's error
   * body carries no amount or txHash, so without this the debit is invisible to the caller.
   * Never set for a phase-1 failure, which happens before anything is paid.
   *
   * `paymentId` is the handle for MBI's idempotent recovery endpoint
   * (`GET /v1/vc/pay/status/{paymentId}`) — without it the debit cannot be reconciled at all.
   */
  paymentAttempted?: { asset?: string; amount?: string; paymentId?: string }
  /**
   * Outcome of polling MBI's `/status` after an *indeterminate* settle (4012). `ISSUED` means
   * the payment landed and the credential exists after all — note `/status` returns only its
   * `vcId`, not the credential body, so `vc` stays unset and the VC must be fetched separately.
   * `FAILED` is MBI's own terminal verdict. `REQUIRED`/`SETTLED` mean still unresolved when the
   * poll budget ran out, and `UNKNOWN` means `/status` itself could not be reached.
   */
  recovery?: { status: string; txHash?: string; vcId?: string; polls: number }
  /**
   * Set on a cache hit when the held VC no longer lines up with the template's currently-declared
   * schema — `missing` are required attributes it hasn't got, `dropped` are attributes it carries
   * that the template no longer declares. Absent when the held VC still satisfies the template,
   * and absent when the schema can't be read (fail-open).
   *
   * `isVcValid` only answers "has it expired?", so without this a stale VC looks perfectly good
   * and the caller finds out only by attempting an issuance and being rejected.
   */
  staleAttributes?: { missing: string[]; dropped: string[] }
  /** Set instead of issuing when the wallet lacks funds for gas or the resource payment. See payment-readiness.ts. */
  insufficientFunds?: PaymentShortfall
  /**
   * The template's full declared schema (from chain) — attached whenever `resolveTemplateFields`
   * resolves it, on every outcome (success, dry-run quote, or missing-attribute error), so the
   * caller always sees the complete required+optional field list rather than only what went wrong.
   */
  schema?: TemplateSchema
  /** The HTTP status MBI returned, set when `reason` comes from a caught MbiError (e.g. 404 template not found/inactive, 400 validation). */
  httpStatus?: number
}

/**
 * Compare a held VC's actual claim keys against the template's currently-declared schema.
 * Returns `undefined` when the VC still satisfies the template, so the caller only ever sees
 * this field when there is genuinely something to act on.
 *
 * `missing` is what a reissue would need supplied that the held VC hasn't got — the signal that
 * would have saved the reported failed attempt. `dropped` is what the VC carries that the
 * template no longer declares; harmless to hold, but it explains *why* a reissue is needed and
 * is exactly the "what changed" list an agent otherwise has to derive by hand.
 */
function diffAgainstTemplate(
  vc: unknown,
  fields: TemplateFields,
): { missing: string[]; dropped: string[] } | undefined {
  const held = new Set(extractAttributeKeys(vc))
  const missing = fields.required.filter((k) => !held.has(k))
  const dropped = [...held].filter((k) => !fields.allKeys.includes(k))
  return missing.length > 0 || dropped.length > 0 ? { missing, dropped } : undefined
}

/** `/status` values that settle the question — anything else is still in flight. */
const TERMINAL_SETTLEMENT_STATUSES = new Set(['ISSUED', 'FAILED'])
/** Poll budget for an indeterminate settle. Bounded: this runs inside a single tool call. */
const RECOVERY_MAX_POLLS = 5
const RECOVERY_POLL_DELAY_MS = 2_000

/**
 * Ask MBI what actually happened to a payment whose settle came back indeterminate. Polls
 * `GET /v1/vc/pay/status/{paymentId}` until it reports a terminal outcome or the budget runs
 * out. Never throws: a `/status` that is itself unreachable reports `UNKNOWN` rather than
 * masking the (already known) fact that funds moved.
 */
async function pollSettlementOutcome(
  deps: SubscribeDeps,
  paymentId: string,
): Promise<{ status: string; txHash?: string; vcId?: string; polls: number } | undefined> {
  if (!deps.mbi.getStatus) return undefined
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  let last: { status: string; txHash?: string; vcId?: string } | undefined
  for (let polls = 1; polls <= RECOVERY_MAX_POLLS; polls++) {
    let status
    try {
      status = await deps.mbi.getStatus(paymentId)
    } catch {
      return { status: 'UNKNOWN', ...(last ? { txHash: last.txHash, vcId: last.vcId } : {}), polls }
    }
    last = { status: status.status, txHash: status.txHash, vcId: status.vcId }
    if (TERMINAL_SETTLEMENT_STATUSES.has(status.status)) {
      return { status: status.status, txHash: status.txHash, vcId: status.vcId, polls }
    }
    if (polls < RECOVERY_MAX_POLLS) await sleep(RECOVERY_POLL_DELAY_MS)
  }
  return { ...last!, polls: RECOVERY_MAX_POLLS }
}

export async function subscribeAndIssue(deps: SubscribeDeps, opts: SubscribeOpts): Promise<SubscribeResult> {
  // MBI settles payment in applySettle *before* checking the template exists, so a bad
  // templateId (e.g. a DCQL requirementsId label like "agent-identity" instead of the real
  // credential-definition DID) burns real x402 funds for a guaranteed failure. Every real MBI
  // templateId observed is a `did:zid:...` string — reject anything else before paying.
  if (!/^did:zid:/.test(opts.templateId)) {
    return { issued: false, reason: `templateId must be a did:zid:... credential-definition id, got "${opts.templateId}"` }
  }

  // Read the template's declared attributes from chain BEFORE anything else — the agentDid
  // auto-fill and the required-fields guard below both need it, and so does the cache hit: a held
  // VC whose fields no longer match the template is invisible to isVcValid, which only checks
  // expiry. Reported live — an agent reissued using the fields it already had and discovered a
  // newly-required attribute only by failing an issuance first.
  const fields = deps.resolveTemplateFields ? await deps.resolveTemplateFields(opts.templateId) : null

  // The template's full declared schema — attached to every return below so the caller always
  // sees the complete required+optional field list, not just what happened to go wrong. Absent
  // when resolveTemplateFields is unwired or fails (fields === null); fail-open like the guard below.
  const schema: TemplateSchema | undefined = fields
    ? { required: fields.required, optional: fields.allKeys.filter((k) => !fields.required.includes(k)) }
    : undefined

  // Reuse a still-valid previously-issued VC instead of paying + issuing again. Skipped by
  // forceReissue (fresh regardless of what's cached) and by dryRun (quoting a fresh price is
  // independent of, and free relative to, whatever happens to be cached).
  if (deps.cache && !opts.forceReissue && !opts.dryRun) {
    const cached = await deps.cache.get(opts.templateId)
    if (cached && isVcValid(cached)) {
      // Serving from cache costs nothing, so txHash/paidAsset/amountPaid stay unset — they
      // describe the original issuance, not this call, and reporting them at the top level
      // made a free hit look like a fresh charge. They move under originalPayment instead.
      const originalPayment = { txHash: cached.txHash, asset: cached.paidAsset, amount: cached.amountPaid }
      // A free template caches paidAsset:'none'/amountPaid:'0' rather than leaving them unset
      // (see the challenge.issued branch below), so an undefined-check alone would report an
      // originalPayment for a VC nobody paid for. Keyed on the amount: no amount, or a zero
      // one, means no charge to report.
      const paidOriginally = cached.amountPaid !== undefined && cached.amountPaid !== '0'
      const staleAttributes = fields ? diffAgainstTemplate(cached.vc, fields) : undefined
      return {
        issued: true,
        vcId: cached.vcId,
        vc: cached.vc,
        fromCache: true,
        ...(paidOriginally ? { originalPayment } : {}),
        ...(schema ? { schema } : {}),
        ...(staleAttributes ? { staleAttributes } : {}),
      }
    }
  }

  // agentDid is the credential's self-referential subject — the wallet already knows its own
  // holderDid, so auto-fill it rather than making the caller guess. But MBI rejects unknown
  // attribute keys (only in applySettle, i.e. after payment), so auto-filling agentDid for a
  // template that doesn't declare it would burn funds on a guaranteed failure — confirmed live
  // against the AI Birthcert template, whose schema has no agentDid at all. So: auto-fill ONLY
  // when the lookup positively confirms `agentDid` is a declared key. A failed/unavailable lookup
  // (`fields === null`) does NOT default to auto-filling — unlike the required-fields guard below,
  // this specific check is fail-CLOSED, since guessing wrong here is exactly the bug being fixed.
  // A truthy caller-supplied value always wins regardless of what the template declares; a
  // missing/empty one is treated as not-supplied (opts.attributes itself may be omitted by a
  // non-schema-compliant caller, so normalize it first rather than risk a raw TypeError).
  const { agentDid, ...rest } = opts.attributes ?? {}
  const shouldAutoFillAgentDid = !agentDid && fields !== null && fields.allKeys.includes('agentDid')
  const attributes = shouldAutoFillAgentDid ? { agentDid: deps.holderDid, ...rest } : (opts.attributes ?? {})

  // Check the template's mandatory attributes are present BEFORE ever calling MBI — MBI validates
  // required fields only inside applyChallenge/applySettle, and for a free template applyChallenge
  // IS the real (synchronous, on-chain) issuance, not a preview — so this must run for dryRun too,
  // not just the real path, or a dry run against a free template with a missing field would trigger
  // a genuine failed issuance attempt instead of a clean local check. Fail-open: a null `fields`
  // (node down, template not found, malformed applyFormat) falls through to the normal flow — this
  // guard can only prevent a spend/attempt, never cause a bad one (unlike the agentDid auto-fill
  // above, which is fail-closed). The guard runs against `attributes`, so an auto-filled agentDid
  // already satisfies its own requirement when applicable.
  if (fields) {
    const attrs = attributes as Record<string, unknown>
    const missing = fields.required.filter((k) => attrs[k] === undefined || attrs[k] === null || attrs[k] === '')
    if (missing.length > 0) {
      return {
        issued: false,
        reason: `template requires attribute(s) not supplied: ${missing.join(', ')} — no payment made`,
        ...(schema ? { schema } : {}),
      }
    }
  }

  // `data` on the wire is the raw canonical JSON (MBI JSON-parses it during issuance).
  const data = JSON.stringify([{ templateId: opts.templateId, metadata: attributes }])
  // MBI verifies the holder signature over HexFormat.hexStringToBytes(data). /sign-blob signs
  // hexStringToBytes(blob), so blob = canonical hex of those exact bytes → HSM signs what MBI checks.
  const blob = zetrixHexStringToBytes(data).toString('hex')

  const { signBlob: signData, publicKey } = await deps.sign(blob)

  const body: MbiApplyBody = { data, signData, publicKey }
  if (opts.expirationDate) body.expirationDate = opts.expirationDate

  let challenge
  try {
    challenge = await deps.mbi.applyChallenge(body)
  } catch (err) {
    // MBI validates the template itself (exists/active/right issuer) and the attributes
    // (unknown/missing keys) inside applyChallenge — for a free template this is also where
    // real synchronous issuance happens, so a bad templateId or a schema mismatch our own
    // fail-open `fields` lookup didn't catch surfaces here. Report it as a clean result instead
    // of an uncaught exception blowing up as a raw MCP error.
    if (err instanceof MbiError) {
      return { issued: false, reason: err.message, httpStatus: err.httpStatus, ...(schema ? { schema } : {}) }
    }
    throw err
  }

  // Free template — MBI issued synchronously inside phase 1 (no 402, no phase-2 settle).
  // This has already happened on chain by the time we observe it, so dryRun cannot preview
  // or prevent it; report what actually occurred rather than a hypothetical quote.
  if (challenge.issued) {
    const issued = challenge.issued
    if (deps.cache) {
      await deps.cache.set(opts.templateId, {
        templateId: opts.templateId,
        vc: issued.verifiableCredential,
        vcId: issued.vcId,
        txHash: issued.txHash,
        paidAsset: 'none',
        amountPaid: '0',
        issuedAt: new Date().toISOString(),
        validUntil: extractValidUntil(issued.verifiableCredential, opts.expirationDate),
      })
    }
    return {
      issued: true,
      vcId: issued.vcId,
      vc: issued.verifiableCredential,
      txHash: issued.txHash,
      paidAsset: 'none',
      amountPaid: '0',
      ...(schema ? { schema } : {}),
      ...(opts.dryRun
        ? { reason: 'this template requires no payment — MBI issues synchronously at phase 1, so dryRun could not prevent this issuance' }
        : {}),
    }
  }

  const accept = challenge.accepts[0]
  if (!accept) return { issued: false, reason: 'MBI 402 returned no payment options', ...(schema ? { schema } : {}) }

  // applyChallenge (phase 1) is free — MBI hasn't charged anything yet, only quoted the price.
  // Let the caller see the actual asset/amount before committing to applySettle's real payment.
  // Resolve the quoted asset to its on-chain symbol too, so the preview isn't a raw contract address.
  if (opts.dryRun) {
    const quotedRaw = String(accept.asset ?? '')
    const quotedAsset = deps.resolveSymbol ? await deps.resolveSymbol(quotedRaw) : quotedRaw
    return {
      issued: false,
      reason: 'dry run — quoted only, no payment made',
      quote: {
        asset: quotedAsset,
        maxAmountRequired: accept.maxAmountRequired,
        payTo: accept.payTo,
      },
      ...(schema ? { schema } : {}),
    }
  }

  let xPayment: string
  try {
    xPayment = await deps.pay(accept)
  } catch (err) {
    if (err instanceof PaymentReadinessError) {
      return { issued: false, reason: `insufficient funds: ${err.message}`, insufficientFunds: err.shortfall }
    }
    throw err
  }

  // Report the real fee asset: an `accept.asset` is either "ZTX" or a ZTP20 contract
  // address — resolve the latter to its on-chain symbol so the caller isn't shown a
  // raw address (or left to guess). Falls back to the raw string if unresolved.
  // Resolved BEFORE applySettle so the failure path below can name what was already paid.
  const rawAsset = String(accept.asset ?? '')
  const paidAsset = deps.resolveSymbol ? await deps.resolveSymbol(rawAsset) : rawAsset
  const amountPaid = String(accept.maxAmountRequired ?? '')

  let issued
  try {
    issued = await deps.mbi.applySettle({ ...body, paymentId: challenge.paymentId }, xPayment)
  } catch (err) {
    if (err instanceof MbiError) {
      // deps.pay already put the payment on chain above, so funds have moved regardless of the
      // error. Surface what was paid AND the paymentId — MBI's error body carries neither, and
      // the paymentId is the only handle its /status recovery endpoint accepts.
      const paymentAttempted = { asset: paidAsset, amount: amountPaid, paymentId: challenge.paymentId }
      // 4012 means the settle outcome was UNKNOWN, not failed: MBI leaves the row recoverable
      // precisely so we can ask. Giving up here would discard a VC already paid for.
      const recovery =
        err.mbiStatus === MBI_SETTLEMENT_INDETERMINATE && challenge.paymentId
          ? await pollSettlementOutcome(deps, challenge.paymentId)
          : undefined
      return {
        issued: false,
        reason: err.message,
        httpStatus: err.httpStatus,
        ...(schema ? { schema } : {}),
        paymentAttempted,
        ...(recovery ? { recovery } : {}),
      }
    }
    throw err
  }

  if (deps.cache) {
    await deps.cache.set(opts.templateId, {
      templateId: opts.templateId,
      vc: issued.verifiableCredential,
      vcId: issued.vcId,
      txHash: issued.txHash,
      paidAsset,
      amountPaid,
      issuedAt: new Date().toISOString(),
      validUntil: extractValidUntil(issued.verifiableCredential, opts.expirationDate),
    })
  }

  return {
    issued: true,
    vcId: issued.vcId,
    vc: issued.verifiableCredential,
    txHash: issued.txHash,
    paidAsset,
    amountPaid,
    ...(schema ? { schema } : {}),
  }
}
