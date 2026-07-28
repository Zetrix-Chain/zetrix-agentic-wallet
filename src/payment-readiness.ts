/**
 * Payment-readiness — reshapes x402-zetrix-client's InsufficientBalanceError (thrown by
 * PaymentEngine.pay's internal checkBalance, BEFORE any transaction blob is built or signed)
 * into a structured shortfall the calling agent can relay to the human, instead of a generic
 * flattened error message. No balance/fee logic is duplicated here — PaymentEngine.pay already
 * ran the real check; this only reshapes what it threw.
 */

import { InsufficientBalanceError } from 'x402-zetrix-client'

export interface PaymentShortfall {
  asset: string
  required: string
  available: string
  reason: 'gas' | 'resource_payment'
}

export class PaymentReadinessError extends Error {
  readonly shortfall: PaymentShortfall
  constructor(message: string, shortfall: PaymentShortfall) {
    super(message)
    this.name = 'PaymentReadinessError'
    this.shortfall = shortfall
  }
}

/**
 * Map an error from PaymentEngine.pay to a PaymentReadinessError, or return null when it
 * isn't an InsufficientBalanceError (caller should rethrow the original in that case).
 *
 * checkBalance reports a gas shortfall under asset "ZTX" even when the payment itself is in
 * a ZTP20 token — comparing the reported asset against the originally requested asset is how
 * "gas short" is told apart from "resource-payment token short". When the requested asset
 * itself IS ZTX, checkBalance's single combined check (amount + fee) is reported as
 * "resource_payment" (it's the payment itself that's short, gas is inseparable from it).
 */
export function toPaymentReadinessError(err: unknown, requestedAsset: string): PaymentReadinessError | null {
  if (!(err instanceof InsufficientBalanceError)) return null
  const reason: PaymentShortfall['reason'] = err.asset === 'ZTX' && requestedAsset !== 'ZTX' ? 'gas' : 'resource_payment'
  return new PaymentReadinessError(err.message, {
    asset: err.asset,
    required: err.required,
    available: err.available,
    reason,
  })
}

/** Wrap a raw PaymentEngine.pay call: success passes through; InsufficientBalanceError becomes PaymentReadinessError. */
export async function payWithReadinessCheck(requestedAsset: string, rawPay: () => Promise<string>): Promise<string> {
  try {
    return await rawPay()
  } catch (err) {
    const readinessError = toPaymentReadinessError(err, requestedAsset)
    if (readinessError) throw readinessError
    throw err
  }
}
