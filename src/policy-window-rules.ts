/**
 * The pairing rules between a cap attribute and its window, and what a cap silently means when its
 * window is left out.
 *
 * SOURCE: `Windows.java` (and `AttributeClassifier`, `strategy/impl/*Evaluator`) in the ms-zetrix
 * policy registry. These rules are NOT served by any API — `GET /policy/vocabulary` returns only
 * `{name, type, appliesTo}`, a projection of `AttributeName.values()` with no pairing information
 * at all — so they are hardcoded here by the decision of 2026-09-21, to avoid blocking work that
 * can otherwise start immediately.
 *
 * Because they are a copy, `src/__tests__/policy-window-rules.test.ts` pins all three verbatim and
 * names this source. That is a TRIPWIRE, NOT A GUARANTEE: there is no shared CI between the two
 * repos, so nothing fails automatically when `Windows.java` changes. It raises the chance someone
 * notices; it does not ensure it. See the policy write review for what an untripwired copied rule cost last time —
 * a javadoc claiming cross-repo agreement that had not been true for a long while.
 *
 * The real fix is to extend `/policy/vocabulary` with `pairsWith` / `pairingRule` /
 * `withoutPairMeans` / `emptyMeans`, derived from the evaluators rather than hand-maintained, with
 * tests that die when the served data and `Windows`/`SpendAggregator` diverge. Not ticketed yet.
 */

/**
 * What the cap means when its window is absent. The three are deliberately DIFFERENT — that
 * asymmetry is the entire reason these rules cannot be guessed. Do not collapse them.
 */
export type WindowRuleOutcome =
  /** Still enforced, but over the policy's whole lifetime rather than per period. */
  | 'lifetime'
  /** Rejected by the chain as VALUE_INVALID. A rate limit with no period is meaningless. */
  | 'denied'
  /** Not a limit at all — the dimension was never asked for. NOT "lifetime count". */
  | 'not-requested'

export interface WindowRule {
  cap: string
  window: string
  outcome: WindowRuleOutcome
  /** Plain words shown to the user verbatim, completing "…means <this>". */
  withoutWindowMeans: string
}

export const WINDOW_RULES: readonly WindowRule[] = [
  {
    cap: 'cumulativeMax',
    window: 'cumulativeWindow',
    outcome: 'lifetime',
    withoutWindowMeans:
      'a cap for the entire lifetime of this policy, not per period — "RM500 a month" written ' +
      'this way silently means "RM500 ever"',
  },
  {
    cap: 'velocityCap',
    window: 'velocityWindow',
    outcome: 'denied',
    withoutWindowMeans:
      'rejected outright as VALUE_INVALID — a rate limit with no period is meaningless, so ' +
      'unlike a cumulative cap it is not quietly treated as lifetime',
  },
  {
    cap: 'maxTransactionCount',
    window: 'countWindow',
    outcome: 'not-requested',
    withoutWindowMeans:
      'not a limit at all — without its window this dimension was not asked for, which is NOT ' +
      'the same as an unlimited-period count',
  },
]

export function windowRuleFor(attributeName: string): WindowRule | undefined {
  return WINDOW_RULES.find((rule) => rule.cap === attributeName)
}

/**
 * Always INFORMATIONAL, never enforced. Presenting either as a control is false assurance, so
 * preflight says so in words whenever one appears in a draft.
 */
export const INFORMATIONAL_ATTRIBUTES: ReadonlySet<string> = new Set(['approvalPolicy', 'settlementChannel'])

/**
 * Attributes that qualify other rules but enforce nothing alone. A policy built only from these
 * answers NO_ENFORCEABLE_CONSTRAINTS — a fail-closed DENY, so the agent could spend nothing at all.
 */
export const QUALIFIER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'assetScope',
  'unknownAttributePolicy',
  ...WINDOW_RULES.map((rule) => rule.window),
])

/**
 * An empty one of these denies everything: `[].contains(recipient)` is always false.
 *
 * BOTH naming conventions are matched, deliberately. The first cut required an underscore
 * (`RECIPIENT_LIST`), but every attribute name this repo actually handles is camelCase
 * (`cumulativeMax`, `assetScope`), so a camelCase `recipientAllowList` holding `[]` sailed past the
 * deny-everything blocker AND still counted as enforceable, so the qualifiers-only check did not
 * catch it either (APP-M03).
 *
 * The real on-chain casing is NOT yet confirmed — no template is registered on testnet, so there is
 * nothing to read it from. Matching both is the fail-safe reading: the cost of a false positive is
 * one explainable blocker on an empty list, and the cost of a false negative is a policy that
 * silently denies everything.
 */
export function isListAttribute(attributeName: string): boolean {
  return /_list$/i.test(attributeName) || /[a-z0-9]List$/.test(attributeName)
}
