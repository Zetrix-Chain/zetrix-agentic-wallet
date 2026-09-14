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
 * When unset, config.ts defaults it to the 1 JMYR credential fee keyed to that network's JMYR
 * contract, plus `"*":"0"` — so an unconfigured wallet can buy exactly one credential and refuses
 * every other asset and any larger amount. This now applies on mainnet too, by product decision:
 * the cap is PER CALL and not cumulative, so an unconfigured mainnet wallet can pay that fee
 * repeatedly. Set `MAX_PAYMENT_AMOUNT` explicitly to lock a wallet down.
 * `assertWithinPaymentCap` still no-ops on `undefined` caps, which is now reachable
 * only by a caller that constructs config by hand rather than through loadConfig.
 */

/**
 * Which configured key the applied limit came from.
 *
 * `matchedKey` is load-bearing for the message, not decoration: the lookup is
 * `caps[asset] ?? caps['*']`, so a limit written under a key that never matches (a ZTP20 symbol
 * instead of its contract address) silently falls through to `"*"`. Reporting only the resulting
 * NUMBER makes "your limit is too low" and "the key you wrote was never read" byte-identical — so
 * raising the wrong key changes nothing visible, and disabling the cap with a wildcard becomes the
 * only move that appears to work.
 */
export interface PaymentCapDetail {
  asset: string
  requiredRaw: string
  capRaw: string
  /** The key whose value was applied — the asset itself, or `'*'` when the fallback was used. */
  matchedKey: string
}

export class PaymentCapError extends Error {
  /**
   * Set only when the failure is "requested amount exceeds the configured cap" — carries the raw
   * asset identifier and raw base-unit amounts so a caller with symbol/decimals resolution (e.g.
   * index.ts's `pay`) can rebuild a human-readable message without re-deriving these numbers.
   * Undefined for configuration-shaped failures (missing cap entry, malformed input), which have
   * no amount to render more legibly.
   */
  readonly detail?: PaymentCapDetail

  constructor(message: string, detail?: PaymentCapDetail) {
    super(message)
    this.name = 'PaymentCapError'
    this.detail = detail
  }
}

/**
 * The refusal message for an over-cap payment. Shared so the raw-unit message thrown here and the
 * symbol-resolved one index.ts rebuilds cannot drift apart — `renderRequired`/`renderCap` let the
 * caller substitute human-readable amounts without restating the explanation.
 */
export function formatCapRefusal(
  detail: PaymentCapDetail,
  renderRequired: string = detail.requiredRaw,
  renderCap: string = detail.capRaw,
): string {
  const asset = detail.asset || '(unknown asset)'
  const base = `payment blocked: this call needs ${renderRequired} of asset "${asset}", but the limit that applies is ${renderCap}`
  return detail.matchedKey === detail.asset
    ? `${base}, set for that asset.`
    : `${base}. No limit is set for this asset, so the "*" fallback applies — set a limit keyed by "${asset}" to allow it.`
}

function isNonNegativeIntegerString(v: string): boolean {
  return /^\d+$/.test(v)
}

/**
 * Parse the `MAX_PAYMENT_AMOUNT` env value. Throws on malformed JSON or non-numeric
 * entries — a broken cap must fail loud at startup, not silently disable itself.
 */
export interface ParsePaymentCapsOptions {
  /** Symbol -> ZTP20 contract address for the active network. Omit to leave keys exactly as written. */
  resolveSymbol?: (symbol: string) => string | undefined
  /** Called once per symbol key that grants MORE than what previously applied. See {@link parsePaymentCaps}. */
  onWarn?: (message: string) => void
}

/**
 * Parse `MAX_PAYMENT_AMOUNT`, and — given a resolver — expand ticker keys to the contract addresses
 * a 402 challenge actually quotes.
 *
 * **Resolution order is contract address -> symbol -> `"*"`.** Expansion happens once here rather
 * than on every check, so the enforcement path stays a plain lookup and the two cannot drift.
 *
 * An address key always wins over a ticker for the same asset: the address is what the challenge
 * names, so someone who wrote both meant the specific one.
 *
 * **The warning exists for one narrow case.** Before ticker keys resolved, `{"JMYR":"5000000"}`
 * matched nothing and fell through to `"*"` — so a config written that way *refused* JMYR. Making
 * tickers work turns that same untouched file into a 5 JMYR allowance. For most people that is the
 * system finally doing what they meant; the exception is a ticker written, seen not to work, and
 * abandoned in place, which silently becomes live spending power. So warn only where a ticker
 * resolves *looser* than what currently applies — never on a config that merely starts working.
 */
export function parsePaymentCaps(
  json: string | undefined,
  opts: ParsePaymentCapsOptions = {},
): Record<string, string> | undefined {
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
  return opts.resolveSymbol ? expandSymbolKeys(caps, opts.resolveSymbol, opts.onWarn) : caps
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
/**
 * Rewrite ticker keys to the contract addresses a challenge quotes. An explicit address entry wins,
 * and the ticker key is dropped once expanded so the resulting map contains only keys that can
 * actually match an asset.
 */
function expandSymbolKeys(
  caps: Record<string, string>,
  resolveSymbol: (symbol: string) => string | undefined,
  onWarn?: (message: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  const pendingSymbols: Array<[symbol: string, address: string, value: string]> = []

  for (const [key, value] of Object.entries(caps)) {
    // '*' is the fallback and 'ZTX' is the native code — neither is a ticker to resolve.
    const address = key === '*' || key === 'ZTX' ? undefined : resolveSymbol(key)
    if (address === undefined) out[key] = value
    else pendingSymbols.push([key, address, value])
  }

  for (const [symbol, address, value] of pendingSymbols) {
    if (out[address] !== undefined) continue // an explicit address entry was written; it wins
    out[address] = value

    // Previously this key matched nothing, so the asset was governed by '*' — or refused outright
    // when there was no '*', which is equally strict. Only a genuine loosening is worth a warning.
    const previous = caps['*'] ?? '0'
    if (BigInt(value) > BigInt(previous)) {
      onWarn?.(
        `MAX_PAYMENT_AMOUNT: the limit written as "${symbol}" now applies to ${address} and permits ${value}. ` +
          `Until this version a ticker matched nothing, so that asset was limited to ${previous}. ` +
          `If you did not intend to allow ${value}, change or remove the "${symbol}" entry.`,
      )
    }
  }
  return out
}

/** What the cap says about a payment, without attempting it. See {@link describePaymentCap}. */
export interface PaymentCapDescription {
  asset: string
  /** The limit that applies, in raw base units. `null` means none applies — see `matchedKey`. */
  capRaw: string | null
  /** The key the limit came from, `'*'` for the fallback, or `null` when nothing applies. */
  matchedKey: string | null
  /** Whether `requiredRaw` would be permitted. */
  wouldPass: boolean
}

/**
 * Read-only counterpart to {@link assertWithinPaymentCap}: answers "what limit applies, where did it
 * come from, and would this amount pass?" without throwing and without attempting a payment.
 *
 * This exists so a caller can tell a user their wallet is not ready *before* collecting anything,
 * rather than discovering it by attempting to spend. Resolution is deliberately delegated to
 * {@link resolveCap}, which the enforcer also uses — a second implementation of "which key applies"
 * would eventually disagree with the one that actually guards the money, and a preflight that says
 * "this will work" when it will not is worse than no preflight.
 *
 * `capRaw: null` with `wouldPass: true` means caps are unconfigured (the feature is off).
 * `capRaw: null` with `wouldPass: false` means caps are configured but nothing matches this asset.
 */
export function describePaymentCap(
  asset: string,
  requiredRaw: string,
  caps: Record<string, string> | undefined,
): PaymentCapDescription {
  if (caps === undefined) return { asset, capRaw: null, matchedKey: null, wouldPass: true }

  const { capRaw, matchedKey } = resolveCap(asset, caps)
  if (capRaw === undefined) return { asset, capRaw: null, matchedKey: null, wouldPass: false }

  const wouldPass = isNonNegativeIntegerString(requiredRaw) && BigInt(requiredRaw) <= BigInt(capRaw)
  return { asset, capRaw, matchedKey, wouldPass }
}

/** The single place "which cap key applies" is decided, shared by the enforcer and the describer. */
function resolveCap(asset: string, caps: Record<string, string>): { capRaw: string | undefined; matchedKey: string } {
  const explicit = caps[asset]
  return explicit !== undefined ? { capRaw: explicit, matchedKey: asset } : { capRaw: caps['*'], matchedKey: '*' }
}

export function assertWithinPaymentCap(accept: PaymentRequirement, caps: Record<string, string> | undefined): void {
  if (caps === undefined) return

  const asset = accept.asset ?? ''
  const { capRaw, matchedKey } = resolveCap(asset, caps)
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
    const detail: PaymentCapDetail = {
      asset,
      requiredRaw: required.toString(),
      capRaw: cap.toString(),
      matchedKey,
    }
    throw new PaymentCapError(formatCapRefusal(detail), detail)
  }
}
