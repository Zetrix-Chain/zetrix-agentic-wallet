import { describe, it, expect } from 'vitest'
import { QuoteBook, QUOTE_TTL_MS, QUOTE_TERMS, asPriceConfirmation } from '../price-confirmation'

// a confirmation is the quote the wallet gave, for one request, for a limited time, once.
describe('QuoteBook', () => {
  const price = { asset: 'ZTX', maxAmountRequired: '1000', payTo: 'ZTX3Pay', gasModel: 'self' as const }
  const binding = { tool: 'subscribe_and_issue' as const, subject: 'did:zid:t-1', details: '{"agentName":"A"}' }
  const clock = (start = 0) => {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('a quote it gave, for the same request and price, within its time, is ok', () => {
    const c = clock()
    const book = new QuoteBook(c.now)
    const { quoteId } = book.issue(binding, price)
    expect(book.check(quoteId, binding, price)).toBe('ok')
  })

  it('an id it never gave is unknown', () => {
    expect(new QuoteBook().check('invented', binding, price)).toBe('unknown')
  })

  it('expires after the time limit', () => {
    const c = clock()
    const book = new QuoteBook(c.now)
    const { quoteId, expiresAt } = book.issue(binding, price)
    expect(expiresAt).toBe(QUOTE_TTL_MS)
    c.advance(QUOTE_TTL_MS + 1)
    expect(book.check(quoteId, binding, price)).toBe('expired')
  })

  it.each([
    ['another tool', { ...binding, tool: 'request_ai_birthcert_verification' as const }],
    ['another credential', { ...binding, subject: 'did:zid:t-2' }],
    ['other details', { ...binding, details: '{"agentName":"B"}' }],
  ])('is refused for %s', (_n, other) => {
    const book = new QuoteBook()
    const { quoteId } = book.issue(binding, price)
    expect(book.check(quoteId, other, price)).toBe('other_request')
  })

  it.each([['amount', { maxAmountRequired: '999' }], ['payee', { payTo: 'X' }], ['token', { asset: 'Y' }], ['gas', { gasModel: 'sponsored' as const }]])(
    'is refused when the echoed %s was changed',
    (_n, change) => {
      const book = new QuoteBook()
      const { quoteId } = book.issue(binding, price)
      expect(book.check(quoteId, binding, { ...price, ...change })).toBe('changed')
    },
  )

  it('can be used once', () => {
    const book = new QuoteBook()
    const { quoteId } = book.issue(binding, price)
    book.consume(quoteId)
    expect(book.check(quoteId, binding, price)).toBe('used')
  })

  it('forgets quotes once they have expired, so it does not grow without bound', () => {
    const c = clock()
    const book = new QuoteBook(c.now)
    for (let i = 0; i < 50; i++) book.issue(binding, price)
    c.advance(QUOTE_TTL_MS + 1)
    book.issue(binding, price)
    expect(book.size).toBe(1)
  })
})

describe('asPriceConfirmation needs the quoteId', () => {
  const price = { asset: 'ZTX', maxAmountRequired: '1000', payTo: 'ZTX3Pay', gasModel: 'self' }

  it('a quote without a quoteId is not a confirmation', () => {
    expect(asPriceConfirmation(price)).toBeUndefined()
  })

  it('a quote with one is, and keeps the id', () => {
    expect(asPriceConfirmation({ ...price, quoteId: 'q-1' })).toMatchObject({ quoteId: 'q-1', maxAmountRequired: '1000' })
  })
})

// Review R1.
describe('QuoteBook R1', () => {
  const price = { asset: 'ZTX', maxAmountRequired: '1000', payTo: 'ZTX3Pay', gasModel: 'self' as const }
  const binding = { tool: 'subscribe_and_issue' as const, subject: 'did:zid:t-1', details: '{}' }

  it('spending one quote spends every other open quote for the same request, and no other', () => {
    const book = new QuoteBook()
    const q1 = book.issue(binding, price).quoteId
    const q2 = book.issue(binding, price).quoteId
    const otherBinding = { ...binding, subject: 'did:zid:t-2' }
    const other = book.issue(otherBinding, price).quoteId
    book.consume(q1)
    expect(book.check(q2, binding, price)).toBe('superseded')
    expect(book.check(other, otherBinding, price)).toBe('ok')
  })

  it('the end of the window is already expired', () => {
    let t = 0
    const book = new QuoteBook(() => t)
    const { quoteId, expiresAt } = book.issue(binding, price)
    t = expiresAt
    expect(book.check(quoteId, binding, price)).toBe('expired')
  })

  it('the stated time comes from the time limit', () => {
    expect(QUOTE_TERMS).toContain(String(QUOTE_TTL_MS / 60000) + ' minutes')
  })
})
