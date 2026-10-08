/**
 * payAndFetch — x402 pay-per-use orchestrator.
 *
 * Thin, testable seam over an injected x402 payer: fetch a URL, auto-pay on 402,
 * return the body. The real `payer` is wired in index.ts from
 * x402-zetrix-client — `createX402Fetch` / `PaymentEngine.pay(…, signerFn)` with a
 * Wallet-BE signer (self-pay via Wallet BE HSM). Keeping it injected here
 * means the orchestrator unit-tests without a live node or signer.
 */

import { PaymentReadinessError, type PaymentShortfall } from '../payment-readiness.js'
import { describePolicyRefusal, policyRefusalFlags, toPaymentPolicyError } from '../policy-refusal.js'
import type { PayRequirement } from '../clients/mbi-client.js'

export interface PayRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface PayResult {
  status: number
  body: string
  paymentMade: boolean
  amountPaid: string
  amountPaidHuman: string
  asset: string
  /** Set instead of paying when the wallet lacks funds for gas or the resource payment. See payment-readiness.ts. */
  insufficientFunds?: PaymentShortfall
  /**
   * Wallet BE refused to sign the payment because the owner's spending policy DENIED it. A decision, not a failure:
   * retrying will not help. Nothing was signed or paid. See policy-refusal.ts.
   */
  policyDenied?: true
  /**
   * Wallet BE could not complete the policy check, so it refused to sign and nothing was paid. Transient: trying
   * again shortly is right.
   */
  policyCheckUnavailable?: true
  /** Set with `policyDenied` / `policyCheckUnavailable`: what happened and what to do, in words. */
  reason?: string
}

export type PayFetch = (req: PayRequest) => Promise<PayResult>

export function payAndFetch(payer: PayFetch, req: PayRequest): Promise<PayResult> {
  return payer(req)
}

export interface PayerDeps {
  /** Builds the X-PAYMENT header for one accept — the capped payer. Signing happens inside it. */
  pay: (accept: PayRequirement) => Promise<string>
  /** The real token symbol for an `asset` (a ZTP20 contract address), for the result. */
  resolveSymbol: (asset: string) => Promise<string>
  fetchFn: typeof fetch
  /**
   * Returns a reason to refuse this URL outright, or undefined. Used to keep `pay_and_fetch` from paying the policy-write
   * service, whose fee is only to be paid through `write_policy` after a person has confirmed. Best effort: a URL
   * the prefix check does not recognise is not refused, so this is never the only guard.
   */
  refuseUrl?: (url: string) => string | undefined
}

/**
 * The refusal for a URL under the policy-write service's paid paths, or undefined. Case-insensitive on the whole URL, and
 * tolerant of a trailing slash on the configured base. Not a security boundary on its own (a redirect or a different host
 * name for the same service is not caught).
 */
export function policyWriteUrlRefusal(policyWriteUrl: string | undefined): (url: string) => string | undefined {
  if (!policyWriteUrl) return () => undefined
  const prefix = `${policyWriteUrl.replace(/\/+$/, '').toLowerCase()}/pay/policy/`
  return (url) =>
    String(url).trim().toLowerCase().startsWith(prefix)
      ? 'pay_and_fetch does not pay the policy-write service. A policy is a spending limit: use write_policy, which asks the user to confirm.'
      : undefined
}

/**
 * pay_and_fetch: fetch → on 402, pay → retry.
 *
 * A refusal to sign is reported as a RESULT, like insufficient funds, and not thrown: it arrives at the signature,
 * which is the last step before the X-PAYMENT header exists, so the wallet sent one unpaid request and paid nothing
 * — and which of the two kinds it is (a decision, or a check that could not complete) decides whether trying again
 * can help. Every other failure still throws, as before.
 */
export function createPayer(deps: PayerDeps): PayFetch {
  return async (req) => {
    const refusal = deps.refuseUrl?.(req.url)
    if (refusal) throw new Error(refusal)
    const init: RequestInit = { method: req.method ?? 'GET', headers: req.headers, body: req.body }
    const res = await deps.fetchFn(req.url, init)
    if (res.status !== 402) {
      return { status: res.status, body: await res.text(), paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '' }
    }
    const parsed = (await res.json()) as { accepts?: PayRequirement[] }
    const accept = parsed.accepts?.[0]
    if (!accept) throw new Error('pay_and_fetch: 402 had no accepts[]')
    let xPayment: string
    try {
      xPayment = await deps.pay(accept)
    } catch (err) {
      if (err instanceof PaymentReadinessError) {
        return { status: 402, body: '', paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '', insufficientFunds: err.shortfall }
      }
      const refusal = toPaymentPolicyError(err)
      if (refusal) {
        return {
          status: 402, body: '', paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '',
          ...policyRefusalFlags(refusal),
          reason: describePolicyRefusal(refusal, 'The URL asked for payment and the wallet did not pay it.'),
        }
      }
      throw err
    }
    const retry = await deps.fetchFn(req.url, { ...init, headers: { ...(req.headers ?? {}), 'x-payment': xPayment } })
    // Report the real token symbol (resolved from the ZTP20 contract's contractInfo),
    // not the raw contract address the 402 challenge carries in `asset`.
    const asset = await deps.resolveSymbol(String(accept.asset ?? ''))
    return {
      status: retry.status, body: await retry.text(), paymentMade: true,
      amountPaid: String(accept.maxAmountRequired ?? ''), amountPaidHuman: '', asset,
    }
  }
}
