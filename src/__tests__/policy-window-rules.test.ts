import { describe, it, expect } from 'vitest'
import {
  WINDOW_RULES,
  windowRuleFor,
  INFORMATIONAL_ATTRIBUTES,
  QUALIFIER_ATTRIBUTES,
  isListAttribute,
} from '../policy-window-rules'

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

  it('recognises list attributes in BOTH naming conventions', () => {
    // Underscore form.
    expect(isListAttribute('RECIPIENT_LIST')).toBe(true)
    expect(isListAttribute('recipient_list')).toBe(true)
    // camelCase form — the style every other attribute in this repo uses. Missing this let an
    // empty list deny everything with no blocker at all (APP-M03).
    expect(isListAttribute('recipientAllowList')).toBe(true)
    expect(isListAttribute('assetList')).toBe(true)
    // Not lists.
    expect(isListAttribute('cumulativeMax')).toBe(false)
    expect(isListAttribute('assetScope')).toBe(false)
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
