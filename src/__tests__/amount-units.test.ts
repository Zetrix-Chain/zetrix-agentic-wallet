import { describe, it, expect } from 'vitest'
import { toBaseUnits, toHumanAmount } from '../amount-units'

// The 1-vs-1000000 mistake is the worst thing that can happen on a transfer, so conversion is
// string/BigInt arithmetic throughout — never floats. Number('0.07') * 1e6 is 70000.00000000001,
// and 2^53 is only ~9e15, which an 18-decimal token exceeds with 10 whole units.
describe('toBaseUnits', () => {
  it('scales a whole amount by the token decimals', () => {
    expect(toBaseUnits('1', 6)).toBe('1000000')
    expect(toBaseUnits('473', 6)).toBe('473000000')
  })

  it('scales a fractional amount', () => {
    expect(toBaseUnits('1.5', 6)).toBe('1500000')
    expect(toBaseUnits('473.9999', 6)).toBe('473999900')
  })

  it('handles the smallest representable unit', () => {
    expect(toBaseUnits('0.000001', 6)).toBe('1')
  })

  it('pads a short fraction rather than truncating it', () => {
    expect(toBaseUnits('0.1', 6)).toBe('100000')
  })

  it('handles a zero-decimals token', () => {
    expect(toBaseUnits('42', 0)).toBe('42')
  })

  it('tolerates leading zeros and a leading +', () => {
    expect(toBaseUnits('0012.5', 6)).toBe('12500000')
  })

  it('stays exact for values a float would mangle', () => {
    expect(toBaseUnits('0.07', 6)).toBe('70000')
    expect(toBaseUnits('10.000000000000001', 18)).toBe('10000000000000001000')
  })

  it('refuses more fractional digits than the token has decimals — that would silently lose value', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow(/more than 6 decimal/i)
  })

  // Caught by the format check rather than the positivity check — the accepted grammar has no
  // sign at all, so "-1" never reaches the numeric comparison. Refused either way.
  it('refuses a negative amount', () => {
    expect(() => toBaseUnits('-1', 6)).toThrow(/not a valid/i)
  })

  it('refuses zero', () => {
    expect(() => toBaseUnits('0', 6)).toThrow(/positive/i)
  })

  it('refuses anything that is not a plain decimal number', () => {
    expect(() => toBaseUnits('1,5', 6)).toThrow(/not a valid/i)
    expect(() => toBaseUnits('1e6', 6)).toThrow(/not a valid/i)
    expect(() => toBaseUnits('', 6)).toThrow(/not a valid/i)
    expect(() => toBaseUnits('abc', 6)).toThrow(/not a valid/i)
    expect(() => toBaseUnits('1.2.3', 6)).toThrow(/not a valid/i)
  })
})

describe('toHumanAmount', () => {
  it('divides by the token decimals', () => {
    expect(toHumanAmount('1000000', 6)).toBe('1')
    expect(toHumanAmount('473999900', 6)).toBe('473.9999')
  })

  it('renders sub-unit amounts without losing precision', () => {
    expect(toHumanAmount('1', 6)).toBe('0.000001')
    expect(toHumanAmount('70000', 6)).toBe('0.07')
  })

  it('renders zero as zero', () => {
    expect(toHumanAmount('0', 6)).toBe('0')
  })

  it('passes through a zero-decimals token', () => {
    expect(toHumanAmount('42', 0)).toBe('42')
  })

  it('stays exact well past what a float can hold', () => {
    expect(toHumanAmount('10000000000000001000', 18)).toBe('10.000000000000001')
  })

  it('round-trips with toBaseUnits', () => {
    for (const human of ['1', '1.5', '0.000001', '473.9999', '0.07']) {
      expect(toHumanAmount(toBaseUnits(human, 6), 6)).toBe(human)
    }
  })

  it('refuses a non-integer raw value — base units are always whole', () => {
    expect(() => toHumanAmount('1.5', 6)).toThrow(/whole/i)
  })
})
