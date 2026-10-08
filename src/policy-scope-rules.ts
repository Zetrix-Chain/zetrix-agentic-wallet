/**
 * The write service's SCOPE rules, restated so preflight can refuse for free what the service
 * would refuse anyway.
 *
 * WHY THIS EXISTS. A real transcript (2026-09-30) drafted "a 10 JMYR per-transaction max" as
 * `native-v1` with `assetScope: "JMYR"`. Preflight answered `ready: true` and described the scope as
 * "limited to JMYR". The write service refuses that draft at its free pre-check — twice over — so
 * the user was handed a confident green light for something that could never be written. That is
 * the false-assurance class that took many review rounds to remove, arriving by a different door:
 * preflight only checked a draft against the TEMPLATE's vocabulary, and these three rules are not
 * in the template. They live in the service.
 *
 * THE THREE RULES, each from ms-zetrix `PolicyWriteValidator` (read from `developv2`, 2026-09-30):
 *
 *  1. `assetScope`, when present, must be a scope the service recognises — `native` or `ztp20`,
 *     exact wire literals. The service's own comment explains why it matters: a wrong value is
 *     accepted and then silently matches nothing at decision time, so "the owner got a 200 and
 *     believes their cap is live". A token symbol such as JMYR is not a scope.
 *  2. A `ztp20` policy must name WHICH token in `tokenAddress`. Without one the cap does not limit
 *     "ztp20 spending" — the spend aggregator sums per (owner, scope, tokenAddress), so every token
 *     gets its own full-sized budget, the opposite of what one cap intends.
 *  3. Any amount or count cap needs a recognised `assetScope`. `cumulativeMax: "1000"` with no asset
 *     is 1000 of nothing.
 *
 * TRIPWIRE, NOT A GUARANTEE — the same honesty `WINDOW_RULES` carries. ms-zetrix is not vendored in
 * this repo and there is no shared CI, so nothing fails automatically if the service changes these.
 * What the tests buy is that changing them here is a deliberate edit to a file that names its
 * source. They do not prove the two repos agree.
 *
 * DELIBERATELY STRICTER than the service in one place. The service TRIMS the scope before matching,
 * so " native " is accepted on write. Whether the stored value keeps the padding is not known from
 * here, and the decision path compares the raw stored value against the exact wire literal — so a
 * padded scope is treated as unrecognised. A needless refusal costs one retry; a false pass costs a
 * paid policy that never matches.
 */

/** The scopes the service recognises, as exact wire literals. */
export const ASSET_SCOPES = ['native', 'ztp20'] as const
export type AssetScope = (typeof ASSET_SCOPES)[number]

/**
 * Exact match. No trimming and no case folding — "NATIVE" is not "native", and that one capital
 * letter is precisely the mistake the service's own comment describes.
 */
export function isAssetScope(value: unknown): value is AssetScope {
  return typeof value === 'string' && (ASSET_SCOPES as readonly string[]).includes(value)
}

/**
 * The caps denominated in an asset, so meaningless without a scope — the service's
 * `AttributeName.ASSET_DENOMINATED_CAPS`. The window attributes are not here: a window qualifies a
 * cap and measures nothing on its own.
 */
export const ASSET_DENOMINATED_CAPS: readonly string[] = [
  'perTransactionMax',
  'cumulativeMax',
  'velocityCap',
  'maxTransactionCount',
]

/**
 * The caps whose value is an AMOUNT of the asset, in its base units — as opposed to
 * `maxTransactionCount`, which is asset-denominated only in the sense that it needs a scope.
 * Preflight states what these mean in whole tokens; it would be nonsense for a count.
 */
export const AMOUNT_CAPS: readonly string[] = ['perTransactionMax', 'cumulativeMax', 'velocityCap']

export function isAmountCap(attributeName: string): boolean {
  return AMOUNT_CAPS.includes(attributeName)
}

export function isAssetDenominatedCap(attributeName: string): boolean {
  return ASSET_DENOMINATED_CAPS.includes(attributeName)
}
