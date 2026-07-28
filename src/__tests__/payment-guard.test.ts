import { describe, it, expect } from 'vitest'
import { parsePaymentCaps, assertWithinPaymentCap, PaymentCapError } from '../payment-guard'

describe('parsePaymentCaps', () => {
  it('returns undefined when unset (no cap enforced)', () => {
    expect(parsePaymentCaps(undefined)).toBeUndefined()
  })

  it('parses a JSON object of asset -> max raw-unit string', () => {
    expect(parsePaymentCaps('{"ZTX":"1000000000","JMYR":"5000000"}')).toEqual({
      ZTX: '1000000000',
      JMYR: '5000000',
    })
  })

  it('accepts a "*" wildcard entry', () => {
    expect(parsePaymentCaps('{"*":"0"}')).toEqual({ '*': '0' })
  })

  it('throws PaymentCapError on invalid JSON', () => {
    expect(() => parsePaymentCaps('not json')).toThrow(PaymentCapError)
    expect(() => parsePaymentCaps('not json')).toThrow(/not valid JSON/)
  })

  it('throws when the value is not a JSON object', () => {
    expect(() => parsePaymentCaps('[1,2,3]')).toThrow(/must be a JSON object/)
    expect(() => parsePaymentCaps('"just a string"')).toThrow(/must be a JSON object/)
    expect(() => parsePaymentCaps('null')).toThrow(/must be a JSON object/)
  })

  it('throws naming the asset when a cap value is not a non-negative integer string', () => {
    expect(() => parsePaymentCaps('{"ZTX":"abc"}')).toThrow(/ZTX/)
    expect(() => parsePaymentCaps('{"ZTX":-5}')).toThrow(/ZTX/)
    expect(() => parsePaymentCaps('{"ZTX":"1.5"}')).toThrow(/ZTX/)
  })
})

describe('assertWithinPaymentCap', () => {
  it('is a no-op when caps is undefined (feature not configured)', () => {
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '999999999999' }, undefined)).not.toThrow()
  })

  it('allows a payment at or under the per-asset cap', () => {
    const caps = { ZTX: '1000000000' }
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000000' }, caps)).not.toThrow()
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1' }, caps)).not.toThrow()
  })

  it('blocks a payment over the per-asset cap', () => {
    const caps = { ZTX: '1000000000' }
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, caps)).toThrow(PaymentCapError)
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, caps)).toThrow(/exceeds configured MAX_PAYMENT_AMOUNT/)
  })

  it('falls back to the "*" cap for an asset without its own entry', () => {
    const caps = { ZTX: '1000000000', '*': '5' }
    expect(() => assertWithinPaymentCap({ asset: 'JMYR', maxAmountRequired: '5' }, caps)).not.toThrow()
    expect(() => assertWithinPaymentCap({ asset: 'JMYR', maxAmountRequired: '6' }, caps)).toThrow(PaymentCapError)
  })

  it('denies (does not silently allow) an asset with no entry and no "*" fallback once caps are configured', () => {
    const caps = { ZTX: '1000000000' }
    expect(() => assertWithinPaymentCap({ asset: 'JMYR', maxAmountRequired: '1' }, caps)).toThrow(/no MAX_PAYMENT_AMOUNT entry/)
  })

  it('blocks a malformed maxAmountRequired rather than silently coercing it', () => {
    const caps = { ZTX: '1000000000' }
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: 'not-a-number' }, caps)).toThrow(/not a non-negative integer string/)
  })

  it('treats a missing maxAmountRequired as 0 (allowed under any configured cap)', () => {
    const caps = { ZTX: '0' }
    expect(() => assertWithinPaymentCap({ asset: 'ZTX' }, caps)).not.toThrow()
  })
})
