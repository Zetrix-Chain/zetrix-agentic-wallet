/**
 * The user's yes, tied to the price they saw.
 *
 * A plain `confirm: true` said only that the user agreed to something: the confirmed call then fetched a fresh payment
 * request and paid whatever it said, and the Verified birthcert could switch from sponsored to self-paid gas on the
 * way. Now `confirm` is the quote itself, echoed back, and the wallet pays only when the payment request it is about to
 * pay matches it field for field. Anything else stops before payment and asks again with the new price.
 *
 * the quote also carries a `quoteId` the wallet gave it, kept in a {@link QuoteBook}: bound to the tool and the
 * request (credential and details), good for {@link QUOTE_TTL_MS}, and usable once. A reused, invented, edited or
 * stale quote stops at the price again, so a price that merely happens to match no longer pays.
 */

import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
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

/** A confirmation as `confirm` carries it: the quoted price and the id the wallet gave that quote. */
export interface ConfirmedQuote extends PriceConfirmation {
  quoteId: string
}

/**
 * `confirm` as a price confirmation, or undefined when it is not one. `true`, the string "true", a partial object and a
 * quote without its `quoteId` are not: a call carrying them stops at the price like an unconfirmed one.
 */
export function asPriceConfirmation(value: unknown): ConfirmedQuote | undefined {
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
  if (typeof v.quoteId !== 'string' || v.quoteId === '') return undefined
  return { asset: v.asset, maxAmountRequired: v.maxAmountRequired, payTo: v.payTo ?? '', gasModel: v.gasModel, quoteId: v.quoteId }
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

/** How long a quote can be confirmed for. Long enough to ask the user; short enough that the price is still current. */
export const QUOTE_TTL_MS = 10 * 60 * 1000
/** The same time limit in whole minutes, for the words the agent is given. */
export const QUOTE_TTL_MINUTES = QUOTE_TTL_MS / 60000

/** What a quote was given for: the tool, the credential (template id or agent name) and the request's details, canonical. */
export interface QuoteBinding {
  tool: 'request_ai_birthcert_verification' | 'subscribe_and_issue'
  subject: string
  details: string
}

/** Why a confirmation was not accepted, or 'ok'. */
export type QuoteVerdict = 'ok' | 'unknown' | 'expired' | 'other_request' | 'changed' | 'used' | 'superseded'

interface QuoteRecord {
  binding: QuoteBinding
  price: PriceConfirmation
  expiresAt: number
  /** 'used': this quote's payment was signed. 'superseded': another quote for the same request's was (review R1). */
  state: 'open' | 'used' | 'superseded'
}

function sameRequest(a: QuoteBinding, b: QuoteBinding): boolean {
  return a.tool === b.tool && a.subject === b.subject && a.details === b.details
}

/**
 * The quotes this wallet has given. In memory on purpose: a restart forgets them, which fails safe (the next
 * confirmed call is not recognised and stops at the price again). Expired quotes are dropped whenever one is given or
 * checked. Time is a monotonic clock, so a change to the system clock neither extends nor cuts a quote's life (review R1).
 */
export class QuoteBook {
  private readonly quotes = new Map<string, QuoteRecord>()

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly ttlMs: number = QUOTE_TTL_MS,
  ) {}

  /** Drops quotes whose window has closed. A spent or superseded one stays until then, so it is refused by name. */
  private prune(now: number): void {
    for (const [id, q] of this.quotes) if (q.expiresAt <= now) this.quotes.delete(id)
  }

  /** Records a quote for `binding` at `price` and returns its id. */
  issue(binding: QuoteBinding, price: PriceConfirmation): { quoteId: string; expiresAt: number } {
    const now = this.now()
    this.prune(now)
    const quoteId = randomUUID()
    const expiresAt = now + this.ttlMs
    this.quotes.set(quoteId, { binding, price: { ...price }, expiresAt, state: 'open' })
    return { quoteId, expiresAt }
  }

  /** Whether `quoteId` may be paid for this request at this echoed price. Checks only; {@link consume} spends it. */
  check(quoteId: string, binding: QuoteBinding, price: PriceConfirmation): QuoteVerdict {
    const now = this.now()
    const q = this.quotes.get(quoteId)
    if (!q) return 'unknown'
    if (q.state === 'used') return 'used'
    if (q.state === 'superseded') return 'superseded'
    // The window is half-open: at expiresAt the quote has already expired (review R1).
    if (q.expiresAt <= now) {
      this.prune(now)
      return 'expired'
    }
    if (!sameRequest(q.binding, binding)) return 'other_request'
    if (priceMismatch(q.price, price) !== undefined) return 'changed'
    return 'ok'
  }

  /**
   * Spends a quote once its payment is signed, and with it every other open quote for the same request (review R1):
   * each unconfirmed call gives a fresh quote, so two were easy to hold, and a second call carrying the other one, waiting
   * behind a first whose settle then failed, would otherwise have paid again.
   */
  consume(quoteId: string): void {
    const q = this.quotes.get(quoteId)
    if (!q) return
    q.state = 'used'
    for (const other of this.quotes.values()) {
      if (other !== q && other.state === 'open' && sameRequest(other.binding, q.binding)) other.state = 'superseded'
    }
  }

  /** How many quotes are held, for tests. */
  get size(): number {
    return this.quotes.size
  }
}

/** The wallet's quote book when none is injected: one per process, like the request lock. */
export const defaultQuoteBook = new QuoteBook()

/** Why a confirmation was refused, in words, as the opening of the price stop's message. */
export function quoteVerdictLead(verdict: Exclude<QuoteVerdict, 'ok'>): string {
  switch (verdict) {
    case 'unknown':
      return 'the confirmed quote is not one this wallet gave (or it was given before the wallet restarted), so nothing was paid. A new quote: '
    case 'expired':
      return `the confirmed quote has expired (a quote is good for ${QUOTE_TTL_MINUTES} minutes), so nothing was paid. A new quote: `
    case 'other_request':
      return 'the confirmed quote was for a different request (another credential, name or details), so nothing was paid. A new quote: '
    case 'changed':
      return 'the confirmed quote was changed from the one the wallet gave, so nothing was paid. A new quote: '
    case 'used':
      return 'the confirmed quote was already used for a payment, so nothing was paid. A new quote: '
    case 'superseded':
      return (
        'another quote for this same request was already used for a payment, so this one was not paid. Check what the ' +
        'earlier payment did before paying again. A new quote: '
      )
  }
}

/** The opening shared by both tools' price-stop messages about the quote itself. */
export const QUOTE_TERMS = `The quote, with its quoteId, is good for ${QUOTE_TTL_MINUTES} minutes, only for this request, and can be used once.`
