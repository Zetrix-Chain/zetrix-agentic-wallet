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

import type { MbiClient, MbiApplyBody, PayRequirement } from '../clients/mbi-client.js'
import { zetrixHexStringToBytes } from '../zetrix-hex.js'
import { type VcCacheStore, isVcValid, extractValidUntil } from '../clients/vc-cache.js'
import type { TemplateFields } from '../clients/template-info-client.js'

export interface SubscribeDeps {
  mbi: Pick<MbiClient, 'applyChallenge' | 'applySettle'>
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
  /** The template's declared mandatory attribute keys (from chain), so a caller sees what to supply. */
  requiredAttributes?: string[]
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
}

export async function subscribeAndIssue(deps: SubscribeDeps, opts: SubscribeOpts): Promise<SubscribeResult> {
  // MBI settles payment in applySettle *before* checking the template exists, so a bad
  // templateId (e.g. a DCQL requirementsId label like "agent-identity" instead of the real
  // credential-definition DID) burns real x402 funds for a guaranteed failure. Every real MBI
  // templateId observed is a `did:zid:...` string — reject anything else before paying.
  if (!/^did:zid:/.test(opts.templateId)) {
    return { issued: false, reason: `templateId must be a did:zid:... credential-definition id, got "${opts.templateId}"` }
  }

  // Reuse a still-valid previously-issued VC instead of paying + issuing again. Skipped by
  // forceReissue (fresh regardless of what's cached) and by dryRun (quoting a fresh price is
  // independent of, and free relative to, whatever happens to be cached).
  if (deps.cache && !opts.forceReissue && !opts.dryRun) {
    const cached = await deps.cache.get(opts.templateId)
    if (cached && isVcValid(cached)) {
      return {
        issued: true,
        vcId: cached.vcId,
        vc: cached.vc,
        txHash: cached.txHash,
        paidAsset: cached.paidAsset,
        amountPaid: cached.amountPaid,
        fromCache: true,
      }
    }
  }

  // Read the template's declared attributes from chain BEFORE deciding whether to auto-fill
  // agentDid or checking for missing required fields — both guards need this same lookup, and the
  // agentDid decision below depends on knowing the full declared key set, not just the required
  // subset. Resolved once here (before sign/applyChallenge) so the real-path guards and the dryRun
  // quote all share it.
  const fields = deps.resolveTemplateFields ? await deps.resolveTemplateFields(opts.templateId) : null

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

  // Check the template's mandatory attributes are present BEFORE paying — MBI validates required
  // fields only in applySettle (post-payment), so a missing one would burn funds on a guaranteed
  // failure. Fail-open: a null `fields` (node down, template not found, malformed applyFormat)
  // falls through to the normal flow — this guard can only prevent a spend, never cause a bad one
  // (unlike the agentDid auto-fill above, which is fail-closed). The guard runs against
  // `attributes`, so an auto-filled agentDid already satisfies its own requirement when applicable.
  if (!opts.dryRun && fields) {
    const attrs = attributes as Record<string, unknown>
    const missing = fields.required.filter((k) => attrs[k] === undefined || attrs[k] === null || attrs[k] === '')
    if (missing.length > 0) {
      return {
        issued: false,
        reason: `template requires attribute(s) not supplied: ${missing.join(', ')} — no payment made`,
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

  const challenge = await deps.mbi.applyChallenge(body)

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
      ...(opts.dryRun
        ? { reason: 'this template requires no payment — MBI issues synchronously at phase 1, so dryRun could not prevent this issuance' }
        : {}),
    }
  }

  const accept = challenge.accepts[0]
  if (!accept) return { issued: false, reason: 'MBI 402 returned no payment options' }

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
        ...(fields ? { requiredAttributes: fields.required } : {}),
      },
    }
  }

  const xPayment = await deps.pay(accept)

  const issued = await deps.mbi.applySettle({ ...body, paymentId: challenge.paymentId }, xPayment)

  // Report the real fee asset: an `accept.asset` is either "ZTX" or a ZTP20 contract
  // address — resolve the latter to its on-chain symbol so the caller isn't shown a
  // raw address (or left to guess). Falls back to the raw string if unresolved.
  const rawAsset = String(accept.asset ?? '')
  const paidAsset = deps.resolveSymbol ? await deps.resolveSymbol(rawAsset) : rawAsset
  const amountPaid = String(accept.maxAmountRequired ?? '')

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
  }
}
