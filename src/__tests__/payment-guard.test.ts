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

  // A caller with symbol/decimals resolution (index.ts's `pay`) reads `.detail` to rebuild a
  // human-readable message instead of the raw asset + bare integer this module deliberately works in.
  it('attaches structured detail (asset, requiredRaw, capRaw) when the cap is exceeded', () => {
    const caps = { ZTX: '1000000000' }
    try {
      assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, caps)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentCapError)
      expect((err as InstanceType<typeof PaymentCapError>).detail).toEqual({
        asset: 'ZTX', requiredRaw: '1000000001', capRaw: '1000000000',
      })
    }
  })

  it('leaves detail undefined for a configuration-shaped failure (no cap entry, no amount to render)', () => {
    const caps = { ZTX: '1000000000' }
    try {
      assertWithinPaymentCap({ asset: 'JMYR', maxAmountRequired: '1' }, caps)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as InstanceType<typeof PaymentCapError>).detail).toBeUndefined()
    }
  })
})

describe('a universal-only cap', () => {
  // The user guide offers `{"*": "N"}` as the simple alternative to a per-token allowlist, so the
  // behaviour it describes needs pinning — including the downside, which is the reason the guide
  // recommends per-token once real money is involved.
  const universal = { '*': '1000000000' }

  it('permits any asset under the limit', () => {
    for (const asset of ['ZTX', 'JMYR']) {
      expect(() => assertWithinPaymentCap({ asset, maxAmountRequired: '500' }, universal)).not.toThrow()
    }
  })

  it('permits an asset the wallet has never seen — the reason per-token is safer', () => {
    expect(() => assertWithinPaymentCap({ asset: 'ZTX3UnknownToken', maxAmountRequired: '500' }, universal)).not.toThrow()
  })

  it('still refuses anything over the limit', () => {
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, universal)).toThrow(PaymentCapError)
  })
})

describe('the cap key format for ZTP20 tokens', () => {
  // The 402 challenge's `asset` is 'ZTX' for the native coin or a CONTRACT ADDRESS for a ZTP20 token
  // (x402-zetrix-client blob-builder). The cap is checked against that raw value before any symbol
  // resolution, so a cap keyed by symbol silently does not apply — it falls through to '*'. Docs
  // previously suggested {"JMYR": "..."}, which would never have matched a real payment.
  const jmyrAddress = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

  it('matches a ZTP20 cap keyed by contract address', () => {
    const caps = { [jmyrAddress]: '5000000', '*': '0' }
    expect(() => assertWithinPaymentCap({ asset: jmyrAddress, maxAmountRequired: '4999999' }, caps)).not.toThrow()
    expect(() => assertWithinPaymentCap({ asset: jmyrAddress, maxAmountRequired: '5000001' }, caps)).toThrow(PaymentCapError)
  })

  it('does NOT match a cap keyed by symbol — it falls through to the "*" fallback', () => {
    const capsBySymbol = { JMYR: '5000000', '*': '0' }
    expect(() => assertWithinPaymentCap({ asset: jmyrAddress, maxAmountRequired: '1' }, capsBySymbol)).toThrow(
      PaymentCapError,
    )
  })
})
