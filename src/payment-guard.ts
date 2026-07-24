/**
 * Payment cap guard.
 *
 * `pay_and_fetch` and `subscribe_and_issue` both auto-pay whatever `maxAmountRequired`
 * the remote server's x402 402 challenge demands, with no upper bound. A prompt-injected
 * or misled agent calling either tool against a hostile endpoint would pay whatever
 * amount that endpoint asks for, bounded only by the HSM account balance (confused-deputy
 * wallet drain). Asking the agent to "confirm first" isn't a real boundary — the same
 * untrusted content that talked it into the call can just as easily talk it into
 * confirming. This is a hard, code-enforced ceiling that holds regardless of agent
 * behavior; it is checked once, in the wiring shared by both tools (see index.ts).
 *
 * Configured via `MAX_PAYMENT_AMOUNT` — a JSON object mapping asset -> max raw-unit
 * string. The 402 challenge's asset is not fixed — it may be the native ZETRIX token
 * (asset code `ZTX`) or a ZTP20 token (e.g. `JMYR`) — so cap whichever you expect, e.g.
 * `{"ZTX":"1000000000","JMYR":"5000000","*":"0"}`. `"*"` is the fallback cap for any
 * asset without its own entry. Left unset entirely, no cap is enforced — see README for
 * why this must be set before pointing the wallet at mainnet/real funds.
 */

export class PaymentCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentCapError'
  }
}

function isNonNegativeIntegerString(v: string): boolean {
  return /^\d+$/.test(v)
}

/**
 * Parse the `MAX_PAYMENT_AMOUNT` env value. Throws on malformed JSON or non-numeric
 * entries — a broken cap must fail loud at startup, not silently disable itself.
 */
export function parsePaymentCaps(json: string | undefined): Record<string, string> | undefined {
  if (json === undefined) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new PaymentCapError(`MAX_PAYMENT_AMOUNT is not valid JSON: ${(e as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PaymentCapError('MAX_PAYMENT_AMOUNT must be a JSON object of { asset: "maxRawUnits" }')
  }

  const caps: Record<string, string> = {}
  for (const [asset, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof raw !== 'string' || !isNonNegativeIntegerString(raw)) {
      throw new PaymentCapError(`MAX_PAYMENT_AMOUNT["${asset}"] must be a non-negative integer string, got ${JSON.stringify(raw)}`)
    }
    caps[asset] = raw
  }
  return caps
}

export interface PaymentRequirement {
  asset?: string
  maxAmountRequired?: string
}

/**
 * Enforce the configured cap for one x402 payment requirement.
 *
 * No-op when `caps` is undefined (feature not configured). Once configured, an asset with
 * no explicit entry and no `"*"` fallback is DENIED, not allowed through — turning the
 * feature on makes it an allowlist, not merely a ceiling on assets you thought to list.
 */
export function assertWithinPaymentCap(accept: PaymentRequirement, caps: Record<string, string> | undefined): void {
  if (caps === undefined) return

  const asset = accept.asset ?? ''
  const capRaw = caps[asset] ?? caps['*']
  if (capRaw === undefined) {
    throw new PaymentCapError(`payment blocked: no MAX_PAYMENT_AMOUNT entry for asset "${asset}" and no "*" fallback configured`)
  }

  const requiredRaw = accept.maxAmountRequired ?? '0'
  if (!isNonNegativeIntegerString(requiredRaw)) {
    throw new PaymentCapError(`payment blocked: maxAmountRequired "${requiredRaw}" is not a non-negative integer string`)
  }

  const required = BigInt(requiredRaw)
  const cap = BigInt(capRaw)
  if (required > cap) {
    throw new PaymentCapError(`payment blocked: requested ${required} ${asset || '(unknown asset)'} exceeds configured MAX_PAYMENT_AMOUNT ${cap}`)
  }
}
