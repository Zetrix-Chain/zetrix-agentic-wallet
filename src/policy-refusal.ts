/**
 * How a Wallet BE POLICY refusal is recognised, bounded and worded — shared by every path that signs.
 *
 * Wallet BE is the policy enforcement point. It asks the policy decision service before it signs a
 * transaction that spends the signer's assets, and refuses with one of two numeric `errorCode`s:
 *
 *  - 1000033 — the decision service said DENY. A DECISION: retrying will not help.
 *  - 1000034 — the check could not be completed, so Wallet BE failed closed. TRANSIENT: trying again shortly is right.
 *
 * The check is on the signature, so it applies to EVERY transaction this wallet has signed — `transfer_token`
 * and the four x402 paths: `pay_and_fetch`, `subscribe_and_issue`, the Verified AI Birthcert
 * session fee and `write_policy`'s fee. A non-transaction blob (the x401 nonce, a VP, a login message) is not
 * checked, so those never produce either code.
 *
 * WHERE THE REFUSAL ARRIVES, and what that lets a message say. It arrives as the failure of `sign`, which every
 * paying path calls LAST — after the checks and the quote, before the X-PAYMENT header exists and before anything
 * is sent to be settled. So "nothing was signed and nothing was paid" is true of every refusal here, and each path
 * adds what it had already done before reaching the signature (a quote, a pre-check), none of which moves money.
 *
 * Matched on FIELDS, never on message text: a rewording on their side must not silently turn every denial back into
 * "signing failed". Failing to recognise a refusal is the safe direction — nothing is signed either way; only the
 * explanation is worse.
 */

import { WALLET_BE_POLICY_CHECK_UNAVAILABLE, WALLET_BE_POLICY_DENIED } from './clients/wallet-be-client.js'

/** The most characters of a remote failure message shown to the agent. */
export const MAX_REASON_CHARS = 300

/**
 * The failure text that reaches an LLM agent. It comes from another service, so it is BOUNDED and flattened — but
 * not SCRUBBED: markup in a remote message (an HTML error page, say) is still shown, as one short line.
 *
 *  - Whitespace and control characters collapse to single spaces, so a remote message cannot lay out fake lines
 *    (a newline followed by something that reads like an instruction) in what the agent reads.
 *  - Cut by CHARACTER (code point), not by UTF-16 unit, so a surrogate pair is never split into a lone half.
 *  - Total: it never throws. A rejection with a non-string `message`, a null-prototype object (`String()` throws on
 *    one) or a hostile `toString` all end in a fixed description rather than an exception out of the catch block
 *    that is trying to report a failure.
 */
export function boundedReason(e: unknown): string {
  let text: string
  try {
    const message = (e as { message?: unknown } | null)?.message
    text = typeof message === 'string' ? message : String(e)
  } catch {
    text = 'an error that could not be described'
  }
  const flat = text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > MAX_REASON_CHARS ? `${chars.slice(0, MAX_REASON_CHARS - 1).join('')}…` : flat
}

/**
 * Is this signing failure a POLICY DENIAL rather than the signer being unavailable?
 *
 * Wallet BE reports a DENY as `errorCode` 1000033; a structured `policyCode` is accepted too, in case a different
 * signer reports it that way. A bare HTTP 403 is NOT: it can come from any layer — a proxy, a WAF, an auth gateway —
 * and calling that "a decision, retrying will not help" would be the inverse of the bug this exists to fix. The code
 * is compared as the NUMBER Wallet BE sends: a string, or a near-miss such as 1000034 (a check that could not
 * complete, which is NOT a denial), does not count.
 */
export function isPolicyRefusal(e: unknown): boolean {
  const code = (e as { policyCode?: unknown } | null)?.policyCode
  if (typeof code === 'string' && code !== '') return true
  return (e as { errorCode?: unknown } | null)?.errorCode === WALLET_BE_POLICY_DENIED
}

/**
 * Did Wallet BE refuse to sign because it could not COMPLETE the policy check (errorCode 1000034)?
 *
 * It fails closed, so nothing was signed — but that says nothing about the payment itself, and it is the opposite of
 * a denial in what to do next: a denial is final until the policy changes, this is worth trying again shortly.
 * Reporting it as a denial would send the user to edit a policy that is not the problem.
 */
export function isPolicyCheckUnavailable(e: unknown): boolean {
  return (e as { errorCode?: unknown } | null)?.errorCode === WALLET_BE_POLICY_CHECK_UNAVAILABLE
}

export type PolicyRefusalKind = 'denied' | 'unavailable'

/**
 * A policy refusal, classified. Thrown by nothing: it is what `toPaymentPolicyError` returns so a path can branch on
 * `instanceof` the way it already does for `PaymentReadinessError`.
 */
export class PaymentPolicyError extends Error {
  readonly kind: PolicyRefusalKind
  /** Wallet BE's own words, bounded and flattened. */
  readonly reason: string

  constructor(kind: PolicyRefusalKind, reason: string, readonly cause?: unknown) {
    super(`policy ${kind}: ${reason}`)
    this.name = 'PaymentPolicyError'
    this.kind = kind
    this.reason = reason
  }
}

/**
 * Classify an error from a paying path's `sign`, or return null when it is not a policy refusal.
 *
 * Accepts an already-classified error unchanged, so a path may call this on whatever it caught whether or not
 * something upstream converted it first. Total: it never throws.
 */
export function toPaymentPolicyError(e: unknown): PaymentPolicyError | null {
  try {
    if (e instanceof PaymentPolicyError) return e
    if (isPolicyRefusal(e)) return new PaymentPolicyError('denied', boundedReason(e), e)
    if (isPolicyCheckUnavailable(e)) return new PaymentPolicyError('unavailable', boundedReason(e), e)
  } catch {
    // A hostile value (a getter that throws) is not a recognisable refusal; the caller rethrows the original.
  }
  return null
}

/**
 * The sentence an agent reads for a refusal, wrapped around what THIS path had already done.
 *
 * `done` says what happened before the signature and must itself be true of that path: it is where "no credential was
 * issued" or "no policy was written" goes. This function adds the part that is true of every path — nothing was
 * signed, nothing was paid — and the advice that differs between the two kinds.
 */
export function describePolicyRefusal(e: PaymentPolicyError, done: string): string {
  return e.kind === 'denied'
    ? `${done} Your spending policy refused the payment before anything was signed or paid: ${e.reason}. ` +
        `This is a decision, not a failure — retrying will not help. Review the policy with get_my_policy.`
    : `${done} The policy check could not be completed, so nothing was signed or paid: ${e.reason}. ` +
        `This is not a decision about this payment — it is transient, and trying again shortly is right. ` +
        `If it keeps happening, the policy service is unavailable.`
}

/** The flags every path's result carries, so an agent branches on a field and never on the prose. */
export function policyRefusalFlags(e: PaymentPolicyError): { policyDenied?: true; policyCheckUnavailable?: true } {
  return e.kind === 'denied' ? { policyDenied: true } : { policyCheckUnavailable: true }
}
