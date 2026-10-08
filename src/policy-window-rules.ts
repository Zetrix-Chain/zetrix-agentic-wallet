/**
 * The pairing rules between a cap attribute and its window, and what a cap silently means when its
 * window is left out.
 *
 * SOURCE: `Windows.java` (and `AttributeClassifier`, `strategy/impl/*Evaluator`) in the ms-zetrix
 * policy registry. They were hardcoded here by the decision of 2026-09-21 because no API served them.
 * Since 2026-10 `GET /policy/vocabulary` does (`pairsWith`, `withoutPairMeans`, `emptyMeans`, `role`),
 * and the wallet reads it when it can. These copies remain as the FALLBACK when that read
 * fails — a Cloudflare challenge, a timeout, an unknown version — and as the thing the tests compare
 * the recorded vocabulary against, so a disagreement is visible instead of silent. One is pinned in
 * `policy-vocabulary-checks.test.ts`: the service says `maxTransactionCount` without `countWindow` is
 * UNENFORCEABLE, while the rule below says `not-requested`.
 *
 * Because they are a copy, `src/__tests__/policy-window-rules.test.ts` pins all three verbatim and
 * names this source. That is a TRIPWIRE, NOT A GUARANTEE: there is no shared CI between the two
 * repos, so nothing fails automatically when `Windows.java` changes. It raises the chance someone
 * notices; it does not ensure it. See the policy write review for what an untripwired copied rule cost last time —
 * a javadoc claiming cross-repo agreement that had not been true for a long while.
 *
 * `not-requested` is no longer a quiet interpretation: preflight refuses a cap with that outcome, because the owner
 * does not get the limit they wrote.
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
 *
 * BOTH CONFIRMED REAL in the v1 vocabulary — `AttributeName` in the ms-zetrix policy registry
 * (`developv2`, read 2026-09-25) declares `SETTLEMENT_CHANNEL` and `APPROVAL_POLICY`. That read is
 * UNVERIFIED from this repo: ms-zetrix is not vendored here, so the citation is the whole of the
 * evidence.
 *
 * Neither appears in `native-v1` or `ztp20-v1`, and being honest about why: nothing explains it.
 * `approvalPolicy` is ZTP20_ONLY so `native-v1` could never carry it, but that says nothing about
 * `ztp20-v1`, and `settlementChannel` applies to BOTH scopes and is in neither. A template declares
 * a SUBSET of the vocabulary and needs no reason to omit a name, so the likeliest answer is simply
 * that these two were not wanted in the first two templates. Keeping this logic rather than deleting
 * it on the evidence of two templates was still the right call.
 *
 * What makes them informational is negative evidence, so it is worth stating: `AttributeEvaluator`
 * has no implementation for either — there is no SettlementChannelEvaluator and no
 * ApprovalPolicyEvaluator — so nothing in the decision path can refuse on them.
 */
export const INFORMATIONAL_ATTRIBUTES: ReadonlySet<string> = new Set(['approvalPolicy', 'settlementChannel'])

/**
 * Attributes that qualify other rules but enforce nothing alone. A policy built only from these
 * answers NO_ENFORCEABLE_CONSTRAINTS — a fail-closed DENY, so the agent could spend nothing at all.
 */
export const QUALIFIER_ATTRIBUTES: ReadonlySet<string> = new Set([
  'assetScope',
  'unknownAttributePolicy',
  // The service's vocabulary calls it a QUALIFIER (it says WHICH token a policy governs and caps nothing
  // itself). It was missing here until this set was compared this set with the recorded vocabulary, so a
  // policy of `assetScope` + `tokenAddress` alone counted as having an enforceable constraint.
  'tokenAddress',
  ...WINDOW_RULES.map((rule) => rule.window),
])

/**
 * The attribute TYPES the deployed Template contract accepts, as its own `VALID_ATTRIBUTE_TYPES`
 * declares them. Read from the contract payload 2026-09-25, not from a field guide.
 */
export const ATTRIBUTE_TYPES = {
  ADDRESS: 'ADDRESS',
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  ADDRESS_LIST: 'ADDRESS_LIST',
  STRING_LIST: 'STRING_LIST',
  NUMBER_LIST: 'NUMBER_LIST',
} as const

/**
 * Which way a list POINTS. The type says a value is a list; it says nothing about whether listing
 * something permits it or blocks it, and those are opposite meanings.
 *
 * SOURCE: `policyregistry/strategy/impl/*Evaluator.java` in the ms-zetrix policy registry, read
 * from `developv2` on 2026-09-25. Each evaluator IS the polarity, in one line:
 *
 * ```java
 * RecipientAllowlistEvaluator  allowlist.contains(recipient) -> allow, else RECIPIENT_NOT_ALLOWLISTED
 * RecipientDenylistEvaluator   denylist.contains(recipient)  -> RECIPIENT_DENYLISTED
 * PayToAllowlistEvaluator      allowlist.contains(payTo)     -> allow, else PAY_TO_NOT_ALLOWLISTED
 * AllowedMethodsEvaluator      allowed.contains(method)      -> allow, else METHOD_NOT_ALLOWED
 * ```
 *
 * This replaces an earlier inference. The four rows were originally derived from the English in the
 * attribute names, which is exactly the kind of guess that reading the real chain data exists to stamp
 * out — the names happened to be honest, and that is luck rather than method. The evaluators are the
 * authority, so they are cited.
 *
 * It is NOT obtainable from chain: `getTemplate` returns only `{attributeName, attributeType}` and
 * `templateAttributeIds`, with no `role`, `polarity` or `emptyMeans` field anywhere in the payload.
 *
 * TRIPWIRE, NOT A GUARANTEE — the same honesty {@link WINDOW_RULES} carries. There is no shared CI
 * with ms-zetrix, so nothing here fails automatically when an evaluator changes. Changing polarity
 * on this side means deliberately editing a test that names those files, which raises the chance
 * someone notices. It does not ensure it.
 *
 * An attribute NOT in this map still gets NO meaning claim at all. Telling a user that listing an
 * address BLOCKS it when it in fact ALLOWS it is worse than telling them nothing.
 */
export type ListPolarity = 'allow' | 'deny'

export const LIST_POLARITY: ReadonlyMap<string, ListPolarity> = new Map<string, ListPolarity>([
  ['recipientAllowlist', 'allow'],
  ['recipientDenylist', 'deny'],
  // Neither template declares payToAllowlist yet, but it is in the v1 vocabulary and live in the
  // decision path — `POST /policy/decisions` requires `payTo` when a policy carries one. Scoping
  // this table to the two shipped templates would have left it silently uninterpreted.
  ['payToAllowlist', 'allow'],
  ['allowedMethods', 'allow'],
])

export function listPolarity(attributeName: string): ListPolarity | undefined {
  return LIST_POLARITY.get(attributeName)
}

/**
 * Is this a LIST attribute?
 *
 * Keyed on the declared TYPE, never on the attribute name. The first cut guessed at naming
 * conventions — `_LIST`, then camelCase `List` — and the real templates use neither:
 * `recipientAllowlist`, `recipientDenylist` and `allowedMethods` all matched nothing, so the
 * empty-list blocker never fired on a single real attribute. List-ness was always a
 * property of the type, and the type is unambiguous.
 *
 * What an empty one MEANS depends on which way the list points, which the type cannot tell you —
 * see {@link LIST_POLARITY}. An empty allow-list denies everything; an empty deny-list denies
 * nothing. An earlier version of this comment asserted the former for every list, which is the
 * inversion this fix was about.
 */
export function isListType(attributeType: string): boolean {
  return attributeType === ATTRIBUTE_TYPES.ADDRESS_LIST
    || attributeType === ATTRIBUTE_TYPES.STRING_LIST
    || attributeType === ATTRIBUTE_TYPES.NUMBER_LIST
}
