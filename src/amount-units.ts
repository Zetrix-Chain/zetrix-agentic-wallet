/**
 * Amount conversion between a token's raw base units and its human-readable form.
 *
 * All arithmetic is string/BigInt — never floating point. `Number('0.07') * 1e6` is
 * 70000.00000000001, and `Number.MAX_SAFE_INTEGER` (~9.007e15) is exceeded by just 10 whole
 * units of an 18-decimal token, so a float round-trip can both mis-round and silently lose
 * magnitude. On a transfer that is the difference between sending 1 JMYR and 1,000,000 JMYR.
 *
 * Base units are the unit the chain and x402 both speak (`maxAmountRequired`, `balanceOf`), so
 * they stay the canonical form; the human string exists for display and for confirming intent.
 */

/** A plain decimal number: digits, optionally one dot with digits after it. No sign, no exponent. */
const PLAIN_DECIMAL = /^\d+(\.\d+)?$/

/**
 * Convert a human-readable amount to raw base units.
 *
 * Refuses more fractional digits than the token has decimals rather than truncating — silently
 * dropping a digit changes the amount being sent, so it must be the caller's problem to fix.
 *
 * @throws if `human` isn't a plain decimal, is zero/negative, or is more precise than `decimals`
 */
export function toBaseUnits(human: string, decimals: number): string {
  const trimmed = (human ?? '').trim()
  if (!PLAIN_DECIMAL.test(trimmed)) {
    throw new Error(`amount "${human}" is not a valid decimal number (digits and at most one "." only, no sign, no exponent)`)
  }
  const [whole, fraction = ''] = trimmed.split('.')
  if (fraction.length > decimals) {
    throw new Error(
      `amount "${human}" has more than ${decimals} decimal places, which this token cannot represent — ` +
        `round it to ${decimals} decimals first rather than losing value silently`,
    )
  }
  const scaled = `${whole}${fraction.padEnd(decimals, '0')}`
  const value = BigInt(scaled)
  if (value <= 0n) throw new Error(`amount "${human}" must be positive`)
  return value.toString()
}

/**
 * Convert raw base units to a human-readable amount, trailing zeros trimmed.
 *
 * @throws if `raw` is not a whole number — base units are indivisible by definition
 */
export function toHumanAmount(raw: string, decimals: number): string {
  const trimmed = (raw ?? '').trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`raw amount "${raw}" must be a whole number of base units`)
  }
  if (decimals === 0) return BigInt(trimmed).toString()
  const padded = trimmed.padStart(decimals + 1, '0')
  const whole = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return fraction ? `${BigInt(whole)}.${fraction}` : BigInt(whole).toString()
}
