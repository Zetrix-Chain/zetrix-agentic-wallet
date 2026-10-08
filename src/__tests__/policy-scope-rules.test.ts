/**
 * The write service's scope rules, in preflight.
 *
 * The regression that prompted them is `transcript` below, verbatim in shape: "a 10 JMYR
 * per-transaction max" drafted as `native-v1` with `assetScope: "JMYR"`. Preflight said
 * `ready: true` and described the scope as "limited to JMYR" — for a draft the write service
 * refuses at its free pre-check twice over.
 *
 * These rules are restated from ms-zetrix, so they are a TRIPWIRE and not a guarantee: nothing fails
 * if the service changes them. What is pinned here is that changing them on this side is a
 * deliberate edit, and that the names they rely on are names the vocabulary fixture — read from the
 * service's own `AttributeName.java` — actually contains.
 */
import { describe, it, expect } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { MAX_LINES, MAX_MESSAGE, baseNotChecked, policyPreflight } from '../orchestrator/policy-preflight'
import {
  ASSET_DENOMINATED_CAPS,
  ASSET_SCOPES,
  isAssetDenominatedCap,
  isAssetScope,
} from '../policy-scope-rules'
import { NATIVE_V1, V1_VOCABULARY, ZTP20_V1 } from './fixtures/real-policy-templates'

const VALID_ADDRESS = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'

const deps = (template: unknown) => ({
  readTemplate: async () => ({ found: true, value: template }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (a: string) => keypair.checkAddress(a),
})
const unreadable = {
  readTemplate: async () => ({ error: 'query_failed', detail: 'down' }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (a: string) => keypair.checkAddress(a),
}

const attr = (attributeName: string, value: unknown, attributeType = 'STRING') =>
  ({ attributeName, attributeType, value }) as never

const draft = (attributes: unknown[]) => ({
  policyKey: 'default-spend',
  templateId: 'a'.repeat(64),
  attributes: attributes as never,
  validFromBlock: '0',
  validToBlock: '0',
})

const text = (r: { blockers: string[] }) => r.blockers.join(' ')

describe('the rules, pinned to what the service was read to say', () => {
  it('knows exactly two scopes, as exact wire literals', () => {
    expect([...ASSET_SCOPES]).toEqual(['native', 'ztp20'])
  })

  it('knows exactly the four asset-denominated caps', () => {
    // The service's AttributeName.ASSET_DENOMINATED_CAPS. The window attributes are NOT here: a
    // window qualifies a cap and measures nothing on its own.
    expect([...ASSET_DENOMINATED_CAPS].sort()).toEqual(
      ['cumulativeMax', 'maxTransactionCount', 'perTransactionMax', 'velocityCap'].sort(),
    )
    for (const window of ['cumulativeWindow', 'velocityWindow', 'countWindow']) {
      expect(isAssetDenominatedCap(window), window).toBe(false)
    }
  })

  it('relies only on names the service’s own vocabulary declares', () => {
    // Derived from V1_VOCABULARY, which is read from AttributeName.java with its provenance, so a
    // rule about an attribute the service does not have cannot be added without that fixture
    // disagreeing.
    const names = new Set<string>(V1_VOCABULARY.map((a) => a.attributeName))
    for (const name of [...ASSET_DENOMINATED_CAPS, 'assetScope', 'tokenAddress']) {
      expect(names.has(name), name).toBe(true)
    }
  })

  it('matches exactly: no trimming, no case folding', () => {
    expect(isAssetScope('native')).toBe(true)
    expect(isAssetScope('ztp20')).toBe(true)
    for (const bad of ['NATIVE', 'Native', 'ZTP20', 'ztp-20', ' native', 'native ', '', 'JMYR', 5, null, undefined, {}]) {
      expect(isAssetScope(bad), String(bad)).toBe(false)
    }
  })
})

describe('the transcript: a token symbol is not a scope', () => {
  it('no longer reports ready for assetScope JMYR on native-v1', async () => {
    const r = await policyPreflight(
      deps(NATIVE_V1),
      draft([attr('assetScope', 'JMYR'), attr('perTransactionMax', '10000000', 'NUMBER')]),
    )
    expect(r.ready).toBe(false)
    expect(text(r)).toMatch(/"assetScope" is "JMYR", which the write service refuses/)
    expect(text(r)).toMatch(/never a token symbol/i)
    expect(text(r)).toMatch(/"tokenAddress"/)
  })

  it('offers NO meaning for a scope it is refusing', () => {
    // "limited to JMYR" beside a blocker is the confident claim about an unusable value that this
    // whole rule exists to stop.
    return policyPreflight(deps(NATIVE_V1), draft([attr('assetScope', 'JMYR'), attr('perTransactionMax', '5', 'NUMBER')])).then(
      (r) => {
        expect(r.interpretation.join(' ')).not.toMatch(/JMYR/)
        expect(r.interpretation.join(' ')).not.toMatch(/assetScope/)
      },
    )
  })

  const refused: Array<[string, unknown]> = [
    ['a token symbol', 'JMYR'],
    ['the wrong case', 'NATIVE'],
    ['title case', 'Native'],
    ['upper-case ztp20', 'ZTP20'],
    ['a hyphenated variant', 'ztp-20'],
    ['a scope with leading padding', ' native'],
    ['a scope with trailing padding', 'native '],
    ['an unrelated word', 'erc20'],
    ['an empty string', ''],
    ['blank', '   '],
    ['a number', 5],
    ['null', null],
    ['an object', { scope: 'native' }],
  ]
  for (const [label, value] of refused) {
    it(`refuses ${label}`, async () => {
      const r = await policyPreflight(deps(NATIVE_V1), draft([attr('assetScope', value), attr('perTransactionMax', '5', 'NUMBER')]))
      expect(r.ready, label).toBe(false)
      expect(text(r), label).toMatch(/"assetScope" is "/)
      expect(text(r), label).toMatch(/exactly "native" or "ztp20"/)
    })
  }

  it('says it once, rather than once per cap', async () => {
    const r = await policyPreflight(
      deps(NATIVE_V1),
      draft([
        attr('assetScope', 'JMYR'),
        attr('perTransactionMax', '5', 'NUMBER'),
        attr('cumulativeMax', '50', 'NUMBER'),
        attr('cumulativeWindow', '100'),
      ]),
    )
    expect(r.blockers.filter((b) => /"assetScope" is "/.test(b))).toHaveLength(1)
    // The scope IS declared, just wrongly, so the "no asset at all" message would be a second,
    // misleading diagnosis.
    expect(text(r)).not.toMatch(/1000 of nothing/)
  })

  it('bounds what it echoes of a hostile scope value', async () => {
    const r = await policyPreflight(
      deps(NATIVE_V1),
      draft([attr('assetScope', 'x'.repeat(50_000)), attr('perTransactionMax', '5', 'NUMBER')]),
    )
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      // The length bound alone is met by the result-wide backstop whether or not THIS site caps
      // anything, so it cannot tell. A line cut off mid-sentence can: it means the echo was left
      // unbounded and the explanation after it was lost.
      expect(line.endsWith('…'), line.slice(0, 50)).toBe(false)
    }
  })
})

describe('a recognised scope says what it actually governs', () => {
  it('native governs native ZTX only', async () => {
    const r = await policyPreflight(deps(NATIVE_V1), draft([attr('assetScope', 'native'), attr('perTransactionMax', '5000000', 'NUMBER')]))
    expect(r.ready).toBe(true)
    expect(r.interpretation.join(' ')).toMatch(/governs native ZTX only and does not limit any token/)
  })

  it('ztp20 governs ONE token, the one tokenAddress names', async () => {
    const r = await policyPreflight(
      deps(ZTP20_V1),
      draft([attr('assetScope', 'ztp20'), attr('tokenAddress', VALID_ADDRESS, 'ADDRESS'), attr('perTransactionMax', '5', 'NUMBER')]),
    )
    expect(r.ready).toBe(true)
    expect(r.interpretation.join(' ')).toMatch(/ONE ZTP20 token/)
  })
})

describe('a ztp20 policy must say which token', () => {
  const ztp20 = attr('assetScope', 'ztp20')
  const cap = attr('perTransactionMax', '5', 'NUMBER')

  it('refuses ztp20 with no tokenAddress', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([ztp20, cap]))
    expect(r.ready).toBe(false)
    expect(text(r)).toMatch(/no "tokenAddress" says which token/)
    expect(text(r)).toMatch(/every token its own full-sized budget/)
    // ztp20-v1 DOES declare tokenAddress, so telling the user to change template would be wrong.
    expect(text(r)).not.toMatch(/does not declare/)
  })

  it('says the TEMPLATE is the problem when it cannot express a ztp20 policy at all', async () => {
    const r = await policyPreflight(deps(NATIVE_V1), draft([ztp20, cap]))
    expect(r.ready).toBe(false)
    expect(text(r)).toMatch(/does not declare "tokenAddress"/)
    expect(text(r)).toMatch(/choose a template that does/)
    expect(text(r)).toMatch(/get_policy_template_schema/)
  })

  it('says nothing about the template when it could not be read', async () => {
    // An unread template says nothing either way; claiming it lacks tokenAddress would be a guess.
    const r = await policyPreflight(unreadable as never, draft([ztp20, cap]))
    expect(text(r)).toMatch(/no "tokenAddress" says which token/)
    expect(text(r)).not.toMatch(/does not declare/)
  })

  it('refuses a blank tokenAddress as it refuses an absent one', async () => {
    for (const blank of ['', '   ']) {
      const r = await policyPreflight(deps(ZTP20_V1), draft([ztp20, attr('tokenAddress', blank, 'ADDRESS'), cap]))
      expect(text(r), JSON.stringify(blank)).toMatch(/no "tokenAddress" says which token/)
    }
  })

  it('accepts a named token', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([ztp20, attr('tokenAddress', VALID_ADDRESS, 'ADDRESS'), cap]))
    expect(text(r)).not.toMatch(/says which token/)
  })

  it('does not ask a native policy for a token', async () => {
    const r = await policyPreflight(deps(NATIVE_V1), draft([attr('assetScope', 'native'), cap]))
    expect(text(r)).not.toMatch(/tokenAddress/)
  })
})

describe('a cap needs an asset', () => {
  for (const name of ASSET_DENOMINATED_CAPS) {
    it(`refuses ${name} with no assetScope`, async () => {
      const r = await policyPreflight(deps(NATIVE_V1), draft([attr(name, '5', 'NUMBER')]))
      expect(r.ready, name).toBe(false)
      expect(text(r), name).toContain(`"${name}" is a cap`)
      expect(text(r), name).toMatch(/1000 of nothing/)
    })

    it(`accepts ${name} once a scope is named`, async () => {
      const r = await policyPreflight(deps(NATIVE_V1), draft([attr('assetScope', 'native'), attr(name, '5', 'NUMBER')]))
      expect(text(r), name).not.toMatch(/1000 of nothing/)
    })
  }

  it('names every cap when there are several', async () => {
    const r = await policyPreflight(
      deps(NATIVE_V1),
      draft([attr('perTransactionMax', '5', 'NUMBER'), attr('velocityCap', '9', 'NUMBER'), attr('velocityWindow', '100')]),
    )
    expect(text(r)).toMatch(/"perTransactionMax", "velocityCap" are caps/)
  })

  it('leaves a policy with no caps and no scope alone', async () => {
    // A scope-agnostic policy is valid: the service says an ABSENT scope is not this rule's business.
    const r = await policyPreflight(
      deps(NATIVE_V1),
      draft([attr('recipientAllowlist', JSON.stringify([VALID_ADDRESS]), 'ADDRESS_LIST')]),
    )
    expect(text(r)).not.toMatch(/assetScope/)
    expect(r.ready).toBe(true)
  })
})

describe('how these blockers are delivered', () => {
  it('survives a flood of attribute faults, because it is draft-level', async () => {
    // Attribute blockers are as many as the caller sends and capLines drops from the END, so a
    // draft-level blocker appended last would be the first thing lost.
    const flood = Array.from({ length: 100 }, (_, i) => attr(`nope${i}`, '1'))
    const r = await policyPreflight(deps(NATIVE_V1), draft([...flood, attr('assetScope', 'JMYR')]))
    expect(r.blockers.length).toBeLessThanOrEqual(MAX_LINES)
    expect(text(r)).toMatch(/"assetScope" is "JMYR"/)
  })

  it('applies without a template, because none of the rules needs one', async () => {
    const r = await policyPreflight(unreadable as never, draft([attr('assetScope', 'JMYR'), attr('perTransactionMax', '5', 'NUMBER')]))
    expect(r.ready).toBe(false)
    expect(text(r)).toMatch(/"assetScope" is "JMYR"/)
  })
})

describe('notChecked no longer contradicts the tool list', () => {
  it('does not say the deploy path is unbuilt', () => {
    // write_policy ships. The agent noticed the contradiction and could not tell which statement to
    // believe.
    const all = baseNotChecked('zetrix:testnet').join(' ')
    expect(all).not.toMatch(/not built yet/i)
    expect(all).not.toMatch(/deploy path/i)
  })

  it('points at the quote instead', () => {
    expect(baseNotChecked('zetrix:testnet').join(' ')).toMatch(/write_policy with dryRun/)
  })

  it('does not assert what this repo cannot see about enforcement', () => {
    // "Nothing outside the policy registry currently consults the decision service" was stated as
    // fact from a wallet that cannot see the other side of that call.
    const all = baseNotChecked('zetrix:testnet').join(' ')
    expect(all).not.toMatch(/Nothing outside the policy registry/)
    expect(all).toMatch(/cannot see whether anything consults the decision service/)
  })

  it('still carries the enforcement and the cannot-guarantee caveats', () => {
    const all = baseNotChecked('zetrix:testnet').join(' ')
    expect(all).toMatch(/ENFORCED/)
    expect(all).toMatch(/mirrors but cannot guarantee/)
    expect(all).toMatch(/ALLOW or DENY/)
  })
})
