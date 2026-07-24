/**
 * payAndFetch — x402 pay-per-use orchestrator.
 *
 * Thin, testable seam over an injected x402 payer: fetch a URL, auto-pay on 402,
 * return the body. The real `payer` is wired in index.ts from
 * x402-zetrix-client — `createX402Fetch` / `PaymentEngine.pay(…, signerFn)` with a
 * Wallet-BE signer (self-pay via Wallet BE HSM). Keeping it injected here
 * means the orchestrator unit-tests without a live node or signer.
 */

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
}

export type PayFetch = (req: PayRequest) => Promise<PayResult>

export function payAndFetch(payer: PayFetch, req: PayRequest): Promise<PayResult> {
  return payer(req)
}
