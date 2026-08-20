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
 * (asset code `ZTX`) or a ZTP20 token — so cap whichever you expect, e.g.
 * `{"ZTX":"1000000000","ZTX3Wein…c1e6b":"5000000","*":"0"}`. `"*"` is the fallback cap
 * for any asset without its own entry.
 *
 * **Key by contract address, not by symbol.** The challenge identifies a ZTP20 token by its
 * contract address (`x402-zetrix-client` blob-builder: `"ZTX"` for the native coin, otherwise
 * a contract address), and the cap is checked against that raw value before any symbol
 * resolution. A cap written as `{"JMYR":"…"}` therefore never matches — it falls through to
 * `"*"` and is refused, which looks like the cap working when it was never consulted.
 *
 * config.ts defaults it to `{"*":"0"}` when unset, so an unconfigured wallet refuses every
 * payment. `assertWithinPaymentCap` still no-ops on `undefined` caps, which is now reachable
 * only by a caller that constructs config by hand rather than through loadConfig.
 */

export class PaymentCapError extends Error {
  /**
   * Set only when the failure is "requested amount exceeds the configured cap" — carries the raw
   * asset identifier and raw base-unit amounts so a caller with symbol/decimals resolution (e.g.
   * index.ts's `pay`) can rebuild a human-readable message without re-deriving these numbers.
   * Undefined for configuration-shaped failures (missing cap entry, malformed input), which have
   * no amount to render more legibly.
   */
  readonly detail?: { asset: string; requiredRaw: string; capRaw: string }

  constructor(message: string, detail?: { asset: string; requiredRaw: string; capRaw: string }) {
    super(message)
    this.name = 'PaymentCapError'
    this.detail = detail
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
    throw new PaymentCapError(
      `payment blocked: requested ${required} ${asset || '(unknown asset)'} exceeds configured MAX_PAYMENT_AMOUNT ${cap}`,
      { asset, requiredRaw: required.toString(), capRaw: cap.toString() },
    )
  }
}
