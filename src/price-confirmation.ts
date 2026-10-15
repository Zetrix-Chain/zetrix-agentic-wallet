/**
 * The user's yes, tied to the price they saw.
 *
 * A plain `confirm: true` said only that the user agreed to something: the confirmed call then fetched a fresh payment
 * request and paid whatever it said, and the Verified birthcert could switch from sponsored to self-paid gas on the
 * way. Now `confirm` is the quote itself, echoed back, and the wallet pays only when the payment request it is about to
 * pay matches it field for field. Anything else stops before payment and asks again with the new price.
 */

import { isSponsored } from './accept-selection.js'
import type { PayRequirement } from './clients/mbi-client.js'

/** The quote a paid tool returns with `needsConfirmation`, and the value `confirm` must echo back. */
export interface PriceConfirmation {
  /** The raw asset: a ZTP20 contract address or "ZTX". Never the symbol, which two contracts can share (review R2). */
  asset: string
  /** Raw base units, exactly as quoted. */
  maxAmountRequired: string
  /** Who is paid. Empty when the quote named no one. */
  payTo: string
  /** Who pays network gas. Decides which payment option is used. */
  gasModel: 'sponsored' | 'self'
}

/**
 * `confirm` as a price confirmation, or undefined when it is not one. `true`, the string "true" and a partial object
 * are not: they say nothing about the price, so a call carrying them stops at the price like an unconfirmed one.
 */
export function asPriceConfirmation(value: unknown): PriceConfirmation | undefined {
  // Some hosts send an object argument as a JSON string (review R2). "true" parses to true and is still refused below.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.asset !== 'string' || v.asset === '') return undefined
  if (typeof v.maxAmountRequired !== 'string' || v.maxAmountRequired === '') return undefined
  if (v.gasModel !== 'sponsored' && v.gasModel !== 'self') return undefined
  if (v.payTo !== undefined && typeof v.payTo !== 'string') return undefined
  return { asset: v.asset, maxAmountRequired: v.maxAmountRequired, payTo: v.payTo ?? '', gasModel: v.gasModel }
}

/** The quote for a payment option, in the shape `confirm` echoes back. */
export function quoteOf(accept: PayRequirement): PriceConfirmation {
  return {
    asset: String(accept.asset ?? ''),
    maxAmountRequired: String(accept.maxAmountRequired ?? ''),
    payTo: String(accept.payTo ?? ''),
    gasModel: isSponsored(accept) ? 'sponsored' : 'self',
  }
}

/** How the payment request about to be paid differs from what the user confirmed, in words, or undefined when it does not. */
export function priceMismatch(confirmed: PriceConfirmation, actual: PriceConfirmation): string | undefined {
  const differences: string[] = []
  if (confirmed.asset !== actual.asset) {
    differences.push(`the token is ${actual.asset}, not ${confirmed.asset}`)
  }
  if (confirmed.maxAmountRequired !== actual.maxAmountRequired) {
    differences.push(`the amount is ${actual.maxAmountRequired}, not ${confirmed.maxAmountRequired} (raw base units)`)
  }
  if (confirmed.payTo !== actual.payTo) differences.push(`the payee is ${actual.payTo || '(none)'}, not ${confirmed.payTo || '(none)'}`)
  if (confirmed.gasModel !== actual.gasModel) differences.push(`network gas is ${actual.gasModel}, not ${confirmed.gasModel}`)
  return differences.length > 0 ? differences.join('; ') : undefined
}

/**
 * What a self-paid price in a token leaves out: the network gas, which this wallet pays in ZTX on top (review R2 nit).
 * Empty for a sponsored price (the paymaster covers gas) and for a price already in ZTX.
 */
export function gasNote(quote: Pick<PriceConfirmation, 'asset' | 'gasModel'>): string {
  return quote.gasModel === 'self' && quote.asset !== 'ZTX' ? ', plus network gas paid in ZTX' : ''
}
