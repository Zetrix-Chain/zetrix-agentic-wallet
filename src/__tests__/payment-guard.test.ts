import { describe, it, expect, vi } from 'vitest'
import { parsePaymentCaps, assertWithinPaymentCap, describePaymentCap, PaymentCapError } from '../payment-guard'

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
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, caps)).toThrow(/the limit that applies is 1000000000/)
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
  it('attaches structured detail (asset, requiredRaw, capRaw, matchedKey) when the cap is exceeded', () => {
    const caps = { ZTX: '1000000000' }
    try {
      assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000001' }, caps)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentCapError)
      expect((err as InstanceType<typeof PaymentCapError>).detail).toEqual({
        asset: 'ZTX', requiredRaw: '1000000001', capRaw: '1000000000', matchedKey: 'ZTX',
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

describe('hybrid cap keys: contract address -> symbol -> "*" (R8c)', () => {
  const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
  const resolveSymbol = (s: string) => (s.toUpperCase() === 'JMYR' ? JMYR : undefined)
  const parse = (json: string, onWarn?: (w: string) => void) => parsePaymentCaps(json, { resolveSymbol, onWarn })

  it('lets a limit written as a ticker apply to the contract address the challenge quotes', () => {
    const caps = parse('{"JMYR":"5000000","*":"0"}')
    expect(() => assertWithinPaymentCap({ asset: JMYR, maxAmountRequired: '1000000' }, caps)).not.toThrow()
  })

  it('gives the contract address precedence when both are written', () => {
    const caps = parse(`{"JMYR":"5000000","${JMYR}":"10","*":"0"}`)
    // The address says 10, the ticker says 5000000. The address wins, so 1000000 is refused.
    expect(() => assertWithinPaymentCap({ asset: JMYR, maxAmountRequired: '1000000' }, caps)).toThrow(PaymentCapError)
  })

  it('leaves an unresolvable ticker alone — it still falls through to "*"', () => {
    const caps = parse('{"NOSUCHTOKEN":"5000000","*":"0"}')
    expect(() => assertWithinPaymentCap({ asset: 'ZTX3Unknown', maxAmountRequired: '1' }, caps)).toThrow(PaymentCapError)
  })

  it('leaves ZTX alone — the native coin is matched by its code, not an address', () => {
    const caps = parse('{"ZTX":"1000000","*":"0"}')
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1000000' }, caps)).not.toThrow()
  })

  it('warns when a ticker resolves LOOSER than what currently applies — the one dangerous case', () => {
    const warn = vi.fn()
    parse('{"JMYR":"5000000","*":"0"}', warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/JMYR/)
    expect(warn.mock.calls[0][0]).toMatch(/5000000/)
  })

  it('does not warn when the ticker is no looser than the fallback it replaces', () => {
    const warn = vi.fn()
    parse('{"JMYR":"0","*":"1000000"}', warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn when an explicit address entry already governed the asset', () => {
    const warn = vi.fn()
    parse(`{"JMYR":"5000000","${JMYR}":"10","*":"0"}`, warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('still refuses everything by default when nothing is configured for an asset', () => {
    const caps = parse('{"JMYR":"5000000"}')
    expect(() => assertWithinPaymentCap({ asset: 'ZTX3Other', maxAmountRequired: '1' }, caps)).toThrow(/no MAX_PAYMENT_AMOUNT entry/)
  })

  it('resolves without a resolver exactly as before, so existing callers are unaffected', () => {
    expect(parsePaymentCaps('{"JMYR":"5000000","*":"0"}')).toEqual({ JMYR: '5000000', '*': '0' })
  })
})

describe('describePaymentCap — answering "would this pass?" without attempting it (R8b)', () => {
  const jmyr = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

  it('reports the applicable limit and that it would pass', () => {
    expect(describePaymentCap(jmyr, '1000000', { [jmyr]: '5000000', '*': '0' })).toEqual({
      asset: jmyr, capRaw: '5000000', matchedKey: jmyr, wouldPass: true,
    })
  })

  it('reports wouldPass false without throwing, so preflight can report rather than fail', () => {
    expect(describePaymentCap(jmyr, '1000000', { [jmyr]: '10', '*': '0' })).toMatchObject({ wouldPass: false })
  })

  it('names the "*" fallback as the matched key, so a mis-keyed cap is visible before paying', () => {
    expect(describePaymentCap(jmyr, '1000000', { JMYR: '5000000', '*': '0' })).toMatchObject({
      matchedKey: '*', capRaw: '0', wouldPass: false,
    })
  })

  it('reports no configured limit when caps are unset (the feature is off)', () => {
    expect(describePaymentCap(jmyr, '1000000', undefined)).toEqual({ asset: jmyr, capRaw: null, matchedKey: null, wouldPass: true })
  })

  it('reports no applicable entry when nothing matches and there is no fallback', () => {
    expect(describePaymentCap(jmyr, '1', { ZTX: '100' })).toEqual({
      asset: jmyr, capRaw: null, matchedKey: null, wouldPass: false,
    })
  })

  it('agrees with assertWithinPaymentCap — the check and the description cannot disagree', () => {
    const cases: Array<[Record<string, string> | undefined, string]> = [
      [{ [jmyr]: '5000000', '*': '0' }, '1000000'],
      [{ [jmyr]: '10', '*': '0' }, '1000000'],
      [{ JMYR: '5000000', '*': '0' }, '1000000'],
      [{ ZTX: '100' }, '1'],
      [undefined, '999999999'],
      [{ '*': '1000000' }, '1000000'],
    ]
    for (const [caps, required] of cases) {
      let threw = false
      try {
        assertWithinPaymentCap({ asset: jmyr, maxAmountRequired: required }, caps)
      } catch {
        threw = true
      }
      expect(describePaymentCap(jmyr, required, caps).wouldPass).toBe(!threw)
    }
  })
})

describe('a refusal says WHICH cap key it applied', () => {
  // Without this, raising a mis-keyed limit produces a byte-identical message however high it goes,
  // so "your limit is too low" and "the key you wrote was never read" are indistinguishable — and the
  // only move that visibly changes anything is disabling the cap with a wildcard.
  const jmyrAddress = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
  const quote = { asset: jmyrAddress, maxAmountRequired: '1000000' }

  function refusal(caps: Record<string, string>): PaymentCapError {
    try {
      assertWithinPaymentCap(quote, caps)
    } catch (e) {
      return e as PaymentCapError
    }
    throw new Error('expected the cap to refuse this payment')
  }

  it('reports the "*" fallback as the matched key when no entry exists for the asset', () => {
    expect(refusal({ '*': '0' }).detail?.matchedKey).toBe('*')
  })

  it('reports the asset as the matched key when an explicit entry exists', () => {
    expect(refusal({ [jmyrAddress]: '10', '*': '999999999' }).detail?.matchedKey).toBe(jmyrAddress)
  })

  it('says the fallback was used, and names the key that would have matched', () => {
    const message = refusal({ JMYR: '5000000', '*': '0' }).message
    expect(message).toMatch(/no limit is set for this asset/i)
    expect(message).toContain('"*"')
    expect(message).toContain(jmyrAddress)
  })

  it('does not claim a fallback when an explicit entry was applied', () => {
    const message = refusal({ [jmyrAddress]: '10', '*': '999999999' }).message
    expect(message).not.toMatch(/no limit is set for this asset/i)
  })

  it('distinguishes a mis-keyed cap from a genuinely too-low one, at the SAME effective limit', () => {
    // Both refuse with an effective limit of 0 against the same 1 JMYR quote, so the numbers in the
    // message are identical and only the explanation can tell them apart. Today they are byte-for-byte
    // the same message — which is why the transcript's user kept raising a limit that was never read.
    const misKeyed = refusal({ JMYR: '5000000', '*': '0' }).message
    const genuinelyTooLow = refusal({ [jmyrAddress]: '0', '*': '999999999' }).message
    expect(misKeyed).not.toBe(genuinelyTooLow)
  })
})
