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
} from '../clients/ssivc-client.js'
import type { PayRequirement } from '../clients/mbi-client.js'
import type { SsivcSessionStore } from '../clients/ssivc-session-store.js'
import type { DownloadQuarantineStore } from '../clients/ssivc-download-quarantine-store.js'
import type { MbiClient, MbiVcEntry, MbiVpAuth } from '../clients/mbi-client.js'
import { type VcCacheStore, extractValidUntil, isVcValid } from '../clients/vc-cache.js'
import { PaymentReadinessError } from '../payment-readiness.js'
import { PaymentCapError } from '../payment-guard.js'

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
}

export interface RequestAiBirthcertVerificationInput {
  agentName: string
  agentPurpose?: string
  evidenceAssuranceLevel?: string
  ownerType?: string
  ownerVerified?: string
}

export type RequestVerificationResult = SsivcSessionCreated | { error: string }

export type CheckVerificationResult =
  | { status: 'no_session'; message: string }
  | (SsivcSessionStatus & { vc?: unknown; cacheError?: string })

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
    if (otherStatus.status !== 'issued') {
      return {
        kind: 'blocked',
        message:
          `a verification session for a different agent ("${stored.agentName}") is still in ` +
          `progress (status: "${otherStatus.status}") and its payment has not been consumed yet — ` +
          `starting a new session for "${agentName}" would lose track of it. Call ` +
          `check_ai_birthcert_verification to resolve or confirm it first.`,
      }
    }
    return { kind: 'pay_fresh' }
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
  // APP-M03: only `pending`/`issued` are confirmed statuses (SPEC.md D8 is open on the rest). An
  // unrecognized status might be a genuinely terminal one, or an in-flight state we've never seen —
  // guessing "safe to replay" here could open a second session against a payment that's about to be
  // consumed. Fail closed instead of defaulting to replay.
  throw new Error(
    `requestAiBirthcertVerification: unrecognized prior session status "${status.status}" for session ` +
      `${stored.sessionId} — refusing to guess whether its settlement receipt is safe to replay (see SPEC.md D8)`,
  )
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

async function payAndCreateSession(
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'pay'>,
  body: SsivcSessionRequestBody,
): Promise<{ session: SsivcSessionCreated; paymentReceipt: string }> {
  const challenge = await deps.ssivc.createSessionChallenge(body)
  const accept = challenge.accepts[0]
  if (!accept) throw new NoPaymentOptionsError('SSIVC 402 returned no payment options')
  const xPayment = await deps.pay(accept)
  return deps.ssivc.createSessionSettle(body, xPayment)
}

export async function requestAiBirthcertVerification(
  deps: VerifyAiBirthcertDeps,
  input: RequestAiBirthcertVerificationInput,
): Promise<RequestVerificationResult> {
  if (!input.agentName || !input.agentName.trim()) {
    throw new Error('requestAiBirthcertVerification: agentName is required')
  }
  const agentName = input.agentName.trim()
  // withRequestLock must be the very next thing that happens, before any await, so a second
  // concurrent call queues behind this one instead of racing it (APP-M02) — see its docstring.
  return withRequestLock(() => requestAiBirthcertVerificationLocked(deps, agentName, input))
}

async function requestAiBirthcertVerificationLocked(
  deps: VerifyAiBirthcertDeps,
  agentName: string,
  input: RequestAiBirthcertVerificationInput,
): Promise<RequestVerificationResult> {
  const decision = await decidePriorSession(deps, agentName)
  if (decision.kind === 'still_pending') return decision.result
  if (decision.kind === 'blocked') return { error: decision.message }

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
  const body: SsivcSessionRequestBody = { ...fields, signedData } as SsivcSessionRequestBody

  let paid: { session: SsivcSessionCreated; paymentReceipt: string }
  try {
    paid =
      decision.kind === 'replay_receipt'
        ? await deps.ssivc.createSessionWithReceipt(body, decision.receipt)
        : await payAndCreateSession(deps, body)
  } catch (err) {
    if (err instanceof PaymentReadinessError) return { error: `insufficient funds: ${err.message}` }
    if (err instanceof PaymentCapError) return { error: err.message }
    if (err instanceof NoPaymentOptionsError) return { error: err.message }
    // REQ-37/AC-17 (SPEC.md §5.1/§11): a 409 means our fresh X-Payment blob was already settled —
    // most likely a prior attempt's settlement succeeded but its response was lost before we could
    // persist the receipt (§9's documented "lost 2xx" gap). SSIVC doesn't tell us the receipt on a
    // 409 (open decision D11), so we can't auto-recover it here — but we MUST NOT let this surface
    // as an unhandled/opaque error either. Report it distinctly so the caller knows retrying blindly
    // won't help and a human may need to check whether the payment actually went through.
    if (err instanceof SsivcError && err.kind === 'blob_already_settled') {
      return { error: `payment already settled for this attempt: ${err.message}` }
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
  deps: Pick<VerifyAiBirthcertDeps, 'ssivc' | 'sessionStore' | 'mbi' | 'messageSigner' | 'address' | 'holderDid' | 'verifiedTemplateId' | 'cache' | 'quarantine'>,
): Promise<CheckVerificationResult> {
  const stored = await deps.sessionStore.get()
  if (!stored) {
    return {
      status: 'no_session',
      message: 'No verification session found for this wallet — call request_ai_birthcert_verification first.',
    }
  }
  const status = await deps.ssivc.getSession(stored.sessionId)
  if (status.status !== 'issued' || !status.vcId) return status

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
  const quarantined = await deps.quarantine.get(status.vcId)
  const quarantineFilePath = deps.quarantine.filePathFor(status.vcId)
  let entries: MbiVcEntry[]
  if (quarantined) {
    entries = quarantined.entries as MbiVcEntry[]
  } else {
    const auth: MbiVpAuth = await deps.messageSigner(deps.address).then((r) => ({ signedData: r.signBlob, publicKey: r.publicKey }))
    try {
      entries = await deps.mbi.downloadVcs({ address: deps.address }, auth)
    } catch (err) {
      // APP-L02: this is exactly the "transient MBI error" the tool description already promises
      // becomes a cacheError, not a throw — so a caller can safely retry check_ai_birthcert_verification.
      return { ...status, cacheError: `failed to fetch credential from MBI: ${err instanceof Error ? err.message : String(err)}` }
    }
    // Persist BEFORE any validation below — a rejection or a crash from here on must never destroy
    // a credential that was already paid for and fetched (SEC-11). Every entry is quarantined, not
    // just the one matching this vcId, since a single download response can carry more than one VC.
    await deps.quarantine.set({ vcId: status.vcId, entries, downloadedAt: new Date().toISOString() })
  }

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

  await deps.cache.set(deps.verifiedTemplateId, {
    templateId: deps.verifiedTemplateId,
    vc: match.vc,
    vcId: status.vcId,
    issuedAt: new Date().toISOString(),
    validUntil,
  })

  return { ...status, vc: match.vc }
}
