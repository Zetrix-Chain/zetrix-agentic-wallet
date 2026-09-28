import { describe, it, expect } from 'vitest'
import {
  WINDOW_RULES,
  windowRuleFor,
  INFORMATIONAL_ATTRIBUTES,
  QUALIFIER_ATTRIBUTES,
  isListType,
  LIST_POLARITY,
  listPolarity,
} from '../policy-window-rules'
import { NATIVE_V1, V1_VOCABULARY, ZTP20_V1 } from './fixtures/real-policy-templates'

/**
 * THE TRIPWIRE.
 *
 * These three rules are COPIED from `Windows.java` in the ms-zetrix policy registry. They are not
 * served by any API: `GET /policy/vocabulary` returns only `{name, type, appliesTo}`, a pure
 * projection of `AttributeName.values()` that carries no pairing information whatsoever.
 *
 * Be honest about what this test is. It is a tripwire, NOT a guarantee. There is no shared CI
 * between this repo and ms-zetrix, so NOTHING here fails automatically when `Windows.java` changes.
 * What it buys is that changing the behaviour on this side means deliberately editing a test that
 * names the other repo — which raises the chance someone notices the divergence. It does not ensure
 * it. A green run of this file is not evidence that the two repos agree.
 *
 * This precaution is not hypothetical. An earlier review found a javadoc at `PolicyWriteService:150-156`
 * claiming `PERMIT_DEADLINE_MARGIN_BLOCKS` matched the JS suite's margin. It did not — Java is
 * `head+1000`, the cited JS is `~head*1000`. A false cross-repo consistency note that a maintainer
 * would reasonably have trusted.
 */
describe('window rules (pinned from Windows.java)', () => {
  it('pins all three rules verbatim, naming Windows.java as their source', () => {
    expect(WINDOW_RULES).toEqual([
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
    ])
  })

  it('gives the three rules three DIFFERENT outcomes', () => {
    // Guards against a future refactor collapsing them into one "missing window" rule.
    const outcomes = WINDOW_RULES.map((r) => r.outcome)
    expect(new Set(outcomes).size).toBe(3)
    expect(windowRuleFor('velocityCap')?.outcome).toBe('denied')
    expect(windowRuleFor('cumulativeMax')?.outcome).toBe('lifetime')
    expect(windowRuleFor('maxTransactionCount')?.outcome).toBe('not-requested')
  })

  it('only velocityCap is denied — the other two remain enforceable policies', () => {
    expect(WINDOW_RULES.filter((r) => r.outcome === 'denied').map((r) => r.cap)).toEqual(['velocityCap'])
  })

  it('has no rule for an attribute that pairs with nothing', () => {
    expect(windowRuleFor('x402')).toBeUndefined()
  })

  it('classifies approvalPolicy and settlementChannel as informational, never as controls', () => {
    expect(INFORMATIONAL_ATTRIBUTES.has('approvalPolicy')).toBe(true)
    expect(INFORMATIONAL_ATTRIBUTES.has('settlementChannel')).toBe(true)
    // An enforceable attribute must not be swept in with them.
    expect(INFORMATIONAL_ATTRIBUTES.has('cumulativeMax')).toBe(false)
  })

  it('treats a qualifier as something that cannot carry a policy on its own', () => {
    expect(QUALIFIER_ATTRIBUTES.has('assetScope')).toBe(true)
    expect(QUALIFIER_ATTRIBUTES.has('unknownAttributePolicy')).toBe(true)
    // Every window is a qualifier too — a policy of only windows enforces nothing.
    for (const rule of WINDOW_RULES) expect(QUALIFIER_ATTRIBUTES.has(rule.window)).toBe(true)
    // A cap is NOT a qualifier; it is the thing being qualified.
    for (const rule of WINDOW_RULES) expect(QUALIFIER_ATTRIBUTES.has(rule.cap)).toBe(false)
  })

  it('recognises a list by its declared TYPE, never by the attribute name', () => {
    // The real templates name them recipientAllowlist / recipientDenylist / allowedMethods —
    // none of which match any naming convention. The first cut guessed at `_LIST`, then camelCase
    // `List`, and caught NONE of the three, so the deny-everything blocker never fired on a real
    // attribute (BT-3000). List-ness was always the type.
    expect(isListType('ADDRESS_LIST')).toBe(true)
    expect(isListType('STRING_LIST')).toBe(true)
    expect(isListType('NUMBER_LIST')).toBe(true)

    expect(isListType('ADDRESS')).toBe(false)
    expect(isListType('STRING')).toBe(false)
    expect(isListType('NUMBER')).toBe(false)

    // A name that looks like a list is not one; the type decides.
    expect(isListType('recipientAllowlist')).toBe(false)
    expect(isListType('RECIPIENT_LIST')).toBe(false)
  })

  it('states in plain words what each cap means without its window', () => {
    // These strings are shown to the user verbatim. A rule whose explanation is empty, or which
    // merely repeats the attribute name, teaches nothing and defeats the interpretation layer.
    for (const rule of WINDOW_RULES) {
      expect(rule.withoutWindowMeans.length).toBeGreaterThan(40)
      expect(rule.withoutWindowMeans).not.toContain(rule.cap)
    }
  })
})

/**
 * LIST_POLARITY decides whether a list PERMITS or BLOCKS what it names, and the whole empty-list
 * and interpretation logic rests on it. It was unpinned entirely: flipping `allowedMethods` from
 * allow to deny, or deleting the row, each left the full suite green (BT-3000 round 2, APP-M01) —
 * the same inversion APP-C01 was about, on the attribute deciding which contract methods an agent
 * may invoke.
 *
 * Pinned verbatim, the way WINDOW_RULES is, and against the same kind of source: each row is one
 * line of a `policyregistry/strategy/impl/*Evaluator.java` in ms-zetrix. Like WINDOW_RULES this is
 * a TRIPWIRE, not a guarantee — there is no shared CI, so nothing fails automatically when an
 * evaluator changes; changing polarity here just means deliberately editing a test that names those
 * files.
 */
describe('LIST_POLARITY (source: ms-zetrix *Evaluator.java — see the module doc)', () => {
  it('pins every row verbatim, naming the evaluator each one comes from', () => {
    // RecipientAllowlistEvaluator  contains(recipient) -> allow, else RECIPIENT_NOT_ALLOWLISTED
    // RecipientDenylistEvaluator   contains(recipient) -> RECIPIENT_DENYLISTED
    // PayToAllowlistEvaluator      contains(payTo)     -> allow, else PAY_TO_NOT_ALLOWLISTED
    // AllowedMethodsEvaluator      contains(method)    -> allow, else METHOD_NOT_ALLOWED
    expect([...LIST_POLARITY.entries()]).toEqual([
      ['recipientAllowlist', 'allow'],
      ['recipientDenylist', 'deny'],
      ['payToAllowlist', 'allow'],
      ['allowedMethods', 'allow'],
    ])
  })

  it('covers exactly the list attributes in the v1 vocabulary — derived, not restated', () => {
    // The invariant that matters, and the one round 3 had before this round deleted it.
    //
    // Round 3 derived the expected set from the chain fixtures. `payToAllowlist` is in the
    // vocabulary and in neither template, so that test failed — and the response was to delete it
    // and hand-author the expected list inside this file, which restated LIST_POLARITY's own keys
    // and therefore checked nothing. An invented `['memoDenylist', 'allow']` row — a *Denylist*
    // given ALLOW polarity, the round-1 CRITICAL exactly — then survived the whole suite
    // (BT-3000 round 4, APP-M01).
    //
    // Derived again now, from V1_VOCABULARY, which lives in the fixtures file with its provenance.
    // Adding a polarity row costs evidence again: the name has to be in the vocabulary first.
    const vocabularyLists = V1_VOCABULARY.filter((a) => isListType(a.attributeType)).map((a) => a.attributeName)
    expect([...LIST_POLARITY.keys()].sort()).toEqual([...vocabularyLists].sort())
  })

  it('covers every list attribute the deployed templates declare', () => {
    // The templates are a SUBSET of the vocabulary, so this is the weaker direction — but a real
    // template attribute missing from the table loses its interpretation entirely.
    const declared = [...NATIVE_V1.attributes, ...ZTP20_V1.attributes]
      .filter((a) => isListType(a.attributeType))
      .map((a) => a.attributeName)
    for (const name of new Set(declared)) expect([...LIST_POLARITY.keys()], name).toContain(name)
  })

  it('the deployed templates declare only attributes the vocabulary knows', () => {
    // Cross-checks the two fixtures against each other. They were read from different places on the
    // same day — the templates from chain, the vocabulary from AttributeName.java — so if either is
    // stale this is where it shows, rather than in whichever test happens to touch it first.
    const vocabulary = new Set(V1_VOCABULARY.map((a) => a.attributeName))
    for (const a of [...NATIVE_V1.attributes, ...ZTP20_V1.attributes]) {
      expect(vocabulary, a.attributeName).toContain(a.attributeName)
    }
  })

  it('agrees with the vocabulary about every attribute TYPE, not just the names', () => {
    // A name can be right while the type is wrong, and the type is what drives isListType.
    const byName = new Map(V1_VOCABULARY.map((a) => [a.attributeName, a.attributeType]))
    for (const a of [...NATIVE_V1.attributes, ...ZTP20_V1.attributes]) {
      expect(byName.get(a.attributeName), a.attributeName).toBe(a.attributeType)
    }
  })

  it('every INFORMATIONAL attribute is a name the vocabulary actually declares', () => {
    // APP-L01 round 5. V1_VOCABULARY's two INFORMATIONAL rows asserted against nothing: deleting
    // `settlementChannel` and `approvalPolicy` from the fixture left the whole suite green,
    // because all three consumers reach the fixture through `isListType` and both are STRING.
    // INFORMATIONAL_ATTRIBUTES cites the same AttributeName.java read, so the two can now only
    // disagree by failing here.
    for (const name of INFORMATIONAL_ATTRIBUTES) {
      expect(V1_VOCABULARY.map((a) => a.attributeName), name).toContain(name)
    }
  })

  it('a ZTP20_ONLY attribute never appears in the native template', () => {
    // APP-L02 round 5. `ztp20Only` was declared on all sixteen rows and read by nothing — inert
    // data in a fixture whose header made a claim ABOUT it, so it read as authoritative while
    // checking nothing. This is the invariant the flag exists to express.
    const ztp20Only = new Set<string>(V1_VOCABULARY.filter((a) => a.ztp20Only).map((a) => a.attributeName))
    for (const a of NATIVE_V1.attributes) expect(ztp20Only, a.attributeName).not.toContain(a.attributeName)
  })

  it('ztp20-v1 adds exactly two attributes to native-v1, and both are ZTP20_ONLY', () => {
    // APP-M02 round 5. The fixture header said ztp20-v1 carries 13 "because tokenAddress,
    // allowedMethods and approvalPolicy are ZTP20_ONLY" — 11 + 3 = 14, not 13. The delta is TWO.
    // Stated as arithmetic the file can fail on, so the prose cannot drift from the fixture again.
    const native = new Set<string>(NATIVE_V1.attributes.map((a) => a.attributeName))
    const added = ZTP20_V1.attributes.map((a) => a.attributeName).filter((name) => !native.has(name))
    expect(added.sort()).toEqual(['allowedMethods', 'tokenAddress'])
    expect(NATIVE_V1.attributes.length).toBe(11)
    expect(ZTP20_V1.attributes.length).toBe(13)

    // And the third ZTP20_ONLY name is in NEITHER template. Pinned rather than explained: nothing
    // in this repo knows why ztp20-v1 omits it, and a test that asserts the fact is honest where a
    // comment inventing a reason is not.
    const ztp20Only = V1_VOCABULARY.filter((a) => a.ztp20Only).map((a) => a.attributeName)
    expect(ztp20Only.sort()).toEqual(['allowedMethods', 'approvalPolicy', 'tokenAddress'])
    const declared = new Set([...NATIVE_V1.attributes, ...ZTP20_V1.attributes].map((a) => a.attributeName))
    expect(declared).not.toContain('approvalPolicy')
  })

  it('the two recipient lists point in OPPOSITE directions', () => {
    // Stated as a relationship so a future edit cannot make them agree without failing.
    expect(listPolarity('recipientAllowlist')).not.toBe(listPolarity('recipientDenylist'))
    expect(listPolarity('recipientAllowlist')).toBe('allow')
    expect(listPolarity('recipientDenylist')).toBe('deny')
  })

  it('returns undefined for anything not in the table, so callers can decline to interpret', () => {
    expect(listPolarity('mysteryList')).toBeUndefined()
    expect(listPolarity('recipientAllowList')).toBeUndefined()
  })
})
