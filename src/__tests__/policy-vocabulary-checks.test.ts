import { describe, it, expect, vi } from 'vitest'
import { checkAgainstVocabulary, isEnforceableAttribute } from '../orchestrator/policy-vocabulary-checks'
import { policyPreflight } from '../orchestrator/policy-preflight'
import { attachAttributeMeanings } from '../orchestrator/policy-attribute-meanings'
import { createTools, type ToolDeps } from '../mcp-tools'
import { buildPolicyVocabularyReader, buildPreflightTokenDeps } from '../index'
import { parseVocabularyBody, type HttpGet, type VocabularyRead } from '../clients/policy-vocabulary-client'
import {
  ASSET_DENOMINATED_CAPS,
  AMOUNT_CAPS,
} from '../policy-scope-rules'
import { INFORMATIONAL_ATTRIBUTES, LIST_POLARITY, QUALIFIER_ATTRIBUTES, WINDOW_RULES } from '../policy-window-rules'
import type { TemplateRecord } from '../clients/policy-read-client'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'
import { NATIVE_V1, V1_VOCABULARY, ZTP20_V1 } from './fixtures/real-policy-templates'

const read = parseVocabularyBody(REAL_VOCABULARY_BODY)
if (!read.available) throw new Error('the recorded vocabulary must parse')
const AVAILABLE: VocabularyRead = read
const vocabulary = read.vocabulary
const by = new Map(vocabulary.attributes.map((a) => [a.name, a]))

const CHALLENGED: VocabularyRead = { available: false, cause: 'challenged', detail: 'HTTP 403: Cloudflare answered with a bot challenge' }

const attr = (attributeName: string, value: string) => ({ attributeName, value })
const SCOPE_NATIVE = attr('assetScope', 'native')
const SCOPE_ZTP20 = attr('assetScope', 'ztp20')
const TOKEN = attr('tokenAddress', 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5')
const CAP = attr('perTransactionMax', '1000000')
const METHODS = attr('allowedMethods', '["transfer"]')

describe('the built-in rules still agree with the recorded vocabulary (tripwire, not a guarantee)', () => {
  it('every window rule pairs the same cap and window the service names', () => {
    for (const rule of WINDOW_RULES) {
      expect(by.get(rule.cap)?.pairsWith, rule.cap).toBe(rule.window)
    }
  })

  it('agrees on what a missing window means — except one known divergence, pinned here on purpose', () => {
    const expected = { lifetime: 'LIFETIME', denied: 'UNENFORCEABLE' } as const
    const disagreements = WINDOW_RULES.filter((rule) => {
      const mapped = expected[rule.outcome as keyof typeof expected]
      return mapped !== by.get(rule.cap)?.withoutPairMeans
    }).map((rule) => rule.cap)
    // The service says maxTransactionCount without countWindow means "every transfer is refused"
    // (UNENFORCEABLE); the built-in rule says "not a limit at all". Unresolved: the service's
    // prose is not the evaluator. A change on EITHER side fails this on purpose.
    expect(disagreements).toEqual(['maxTransactionCount'])
  })

  it('agrees on which attributes are informational and which are qualifiers', () => {
    for (const a of vocabulary.attributes) {
      const builtIn = INFORMATIONAL_ATTRIBUTES.has(a.name) ? 'INFORMATIONAL' : QUALIFIER_ATTRIBUTES.has(a.name) ? 'QUALIFIER' : 'CONSTRAINT'
      expect(a.role, a.name).toBe(builtIn)
    }
  })

  it('agrees on which caps are amounts and which are asset-denominated', () => {
    expect([...AMOUNT_CAPS].sort()).toEqual(vocabulary.attributes.filter((a) => a.unit === 'SMALLEST_UNIT').map((a) => a.name).sort())
    expect([...ASSET_DENOMINATED_CAPS].sort()).toEqual(
      vocabulary.attributes.filter((a) => a.unit === 'SMALLEST_UNIT' || a.unit === 'COUNT').map((a) => a.name).sort(),
    )
  })

  it('agrees on what an empty list means, per the polarity table', () => {
    for (const [name, polarity] of LIST_POLARITY) {
      expect(by.get(name)?.emptyMeans, name).toBe(polarity === 'allow' ? 'DENY_ALL' : 'NO_EFFECT')
    }
  })

  it('knows exactly the sixteen names the template fixture lists', () => {
    expect(vocabulary.attributes.map((a) => a.name).sort()).toEqual(V1_VOCABULARY.map((v) => v.attributeName).sort())
  })

  it('agrees with the template fixture on each attribute type', () => {
    for (const v of V1_VOCABULARY) expect(by.get(v.attributeName)?.type, v.attributeName).toBe(v.attributeType)
  })
})

describe('checkAgainstVocabulary', () => {
  it('says nothing when this wallet has no vocabulary source at all', () => {
    expect(checkAgainstVocabulary([SCOPE_NATIVE, CAP], null, undefined)).toEqual({ blockers: [], interpretation: [], notChecked: [] })
  })

  it('says one thing, in notChecked, when the vocabulary could not be read — and blocks nothing', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, METHODS], null, CHALLENGED)
    expect(found.blockers).toEqual([])
    expect(found.interpretation).toEqual([])
    expect(found.notChecked).toHaveLength(1)
    expect(found.notChecked[0]).toContain('HTTP 403')
    expect(found.notChecked[0]).toMatch(/did not run/)
  })

  it('passes a clean native draft', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, CAP], null, AVAILABLE)
    expect(found).toEqual({ blockers: [], interpretation: [], notChecked: [] })
  })

  it('passes a clean ztp20 draft carrying the ztp20-only attributes', () => {
    const found = checkAgainstVocabulary([SCOPE_ZTP20, TOKEN, METHODS, CAP], null, AVAILABLE)
    expect(found.blockers).toEqual([])
  })

  it('blocks allowedMethods on a native policy, quoting the service', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, CAP, METHODS], null, AVAILABLE)
    expect(found.blockers).toHaveLength(1)
    expect(found.blockers[0]).toContain('"allowedMethods" applies to ztp20 policies only')
    expect(found.blockers[0]).toContain('"native"')
    expect(found.blockers[0]).toContain('The ZTP20 token methods the agent may call')
    expect(found.blockers[0]).toMatch(/unenforceable/)
  })

  it('blocks approvalPolicy on a native policy the same way', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, CAP, attr('approvalPolicy', 'manual')], null, AVAILABLE)
    expect(found.blockers.join(' ')).toContain('"approvalPolicy" applies to ztp20 policies only')
  })

  it('treats a missing assetScope as native for an attribute that is unenforceable there', () => {
    const found = checkAgainstVocabulary([METHODS], null, AVAILABLE)
    expect(found.blockers).toHaveLength(1)
    expect(found.blockers[0]).toContain('states no assetScope, which means native')
  })

  it('does not call allowedMethods unenforceable when the draft names a token — that takes it off native transfers', () => {
    expect(checkAgainstVocabulary([METHODS, TOKEN], null, AVAILABLE).blockers).toEqual([])
    expect(checkAgainstVocabulary([SCOPE_ZTP20, METHODS, TOKEN], null, AVAILABLE).blockers).toEqual([])
  })

  it('blocks tokenAddress under an explicit native scope: the policy would never govern a native transfer', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, TOKEN, CAP], null, AVAILABLE)
    expect(found.blockers.join(' ')).toContain('"tokenAddress" applies to ztp20 policies only')
    expect(found.blockers.join(' ')).toMatch(/never apply to native transfers/)
  })

  it('stays quiet about tokenAddress when no scope is stated', () => {
    expect(checkAgainstVocabulary([TOKEN, METHODS], null, AVAILABLE).blockers).toEqual([])
  })

  it('does nothing about scope when the assetScope is unrecognised — the scope rules already refuse that', () => {
    expect(checkAgainstVocabulary([attr('assetScope', 'JMYR'), METHODS], null, AVAILABLE).blockers).toEqual([])
  })

  it('blocks an attribute the service does not recognise, and says why it matters', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, attr('dailyLimit', '5')], null, AVAILABLE)
    expect(found.blockers).toHaveLength(1)
    expect(found.blockers[0]).toContain('"dailyLimit" is not an attribute the service recognises')
    expect(found.blockers[0]).toMatch(/refuses every transfer/)
    expect(found.blockers[0]).toContain('"ignore"')
  })

  it('pluralises for several unknown attributes', () => {
    const found = checkAgainstVocabulary([attr('aaa', '1'), attr('bbb', '2')], null, AVAILABLE)
    expect(found.blockers[0]).toContain('"aaa", "bbb" are not attributes the service recognises')
    expect(found.blockers[0]).toContain('carrying them')
  })

  it('turns that blocker into a note when unknownAttributePolicy is "ignore"', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, attr('dailyLimit', '5'), attr('unknownAttributePolicy', 'ignore')], null, AVAILABLE)
    expect(found.blockers).toEqual([])
    expect(found.interpretation.join(' ')).toMatch(/"dailyLimit" is not an attribute the service recognises.*skipped/)
  })

  it('does not accept "Ignore" or " ignore" as ignore — exact, like the scope', () => {
    for (const v of ['Ignore', ' ignore', 'IGNORE']) {
      const found = checkAgainstVocabulary([attr('dailyLimit', '5'), attr('unknownAttributePolicy', v)], null, AVAILABLE)
      expect(found.blockers, v).toHaveLength(1)
    }
  })

  it('does not refuse twice for a name the template does not declare — the template check already did', () => {
    const declared = new Set(['perTransactionMax'])
    expect(checkAgainstVocabulary([attr('dailyLimit', '5')], declared, AVAILABLE).blockers).toEqual([])
    // ...but does when the template DOES declare it and the service has never heard of it.
    expect(checkAgainstVocabulary([attr('dailyLimit', '5')], new Set(['dailyLimit']), AVAILABLE).blockers).toHaveLength(1)
  })

  it('bounds the length of a name it echoes', () => {
    const found = checkAgainstVocabulary([attr('n'.repeat(5000), '1')], null, AVAILABLE)
    expect(found.blockers[0].length).toBeLessThan(500)
  })

  it('notes — rather than silently picking a side — when the service and the built-in rules disagree on a pair', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, attr('maxTransactionCount', '5')], null, AVAILABLE)
    expect(found.blockers).toEqual([])
    expect(found.notChecked).toHaveLength(1)
    expect(found.notChecked[0]).toContain('"maxTransactionCount" is UNENFORCEABLE')
    expect(found.notChecked[0]).toContain('NOT_A_LIMIT')
    expect(found.notChecked[0]).toContain('"countWindow"')
    expect(found.notChecked[0]).toContain('every transfer is refused')
  })

  it('says nothing about a pair when the window is present, or when the two agree', () => {
    expect(checkAgainstVocabulary([attr('maxTransactionCount', '5'), attr('countWindow', '1d')], null, AVAILABLE).notChecked).toEqual([])
    expect(checkAgainstVocabulary([attr('velocityCap', '5')], null, AVAILABLE).notChecked).toEqual([])
    expect(checkAgainstVocabulary([attr('cumulativeMax', '5')], null, AVAILABLE).notChecked).toEqual([])
  })

  it('reports a role disagreement and uses the STRICTER of the two (service INFORMATIONAL vs built-in CONSTRAINT)', () => {
    const edited = parseVocabularyBody(
      REAL_VOCABULARY_BODY.replace('"name":"perTransactionMax"', '"name":"perTransactionMax"').replace(/("name":"perTransactionMax"[^}]*?"role":)"CONSTRAINT"/, '$1"INFORMATIONAL"'),
    )
    if (!edited.available) throw new Error('edited vocabulary must parse')
    const found = checkAgainstVocabulary([SCOPE_NATIVE, CAP], null, edited)
    expect(found.notChecked.join(' ')).toContain('"perTransactionMax" INFORMATIONAL')
    expect(found.notChecked.join(' ')).toContain('stricter of the two')
    expect(found.interpretation.join(' ')).toContain('"perTransactionMax" is informational only')
    expect(isEnforceableAttribute('perTransactionMax', edited.vocabulary)).toBe(false)
  })

  it('does not repeat the informational note for an attribute the built-in set already explains', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, attr('settlementChannel', 'x')], null, AVAILABLE)
    expect(found.interpretation).toEqual([])
    expect(found.notChecked).toEqual([])
  })
})

describe('isEnforceableAttribute', () => {
  it.each([
    ['perTransactionMax', true],
    ['recipientAllowlist', true],
    ['allowedMethods', true],
    ['assetScope', false],
    ['cumulativeWindow', false],
    ['unknownAttributePolicy', false],
    ['tokenAddress', false],
    ['settlementChannel', false],
    ['approvalPolicy', false],
  ])('%s -> %s with the vocabulary', (name, expected) => {
    expect(isEnforceableAttribute(name, vocabulary)).toBe(expected)
  })

  it.each([
    ['perTransactionMax', true],
    ['assetScope', false],
    ['settlementChannel', false],
  ])('%s -> %s from the built-in sets when the vocabulary is unread', (name, expected) => {
    expect(isEnforceableAttribute(name, null)).toBe(expected)
  })

  it('falls back to the built-in sets for a name the service does not list', () => {
    expect(isEnforceableAttribute('somethingNew', vocabulary)).toBe(true)
  })
})

describe('policyPreflight with the live vocabulary', () => {
  const template = (record: object) => ({ readTemplate: async () => ({ found: true, value: record as unknown as TemplateRecord }) as never })
  const draft = (attributes: Array<{ attributeName: string; attributeType: string; value: string }>) => ({
    policyKey: 'k',
    templateId: 'a'.repeat(64),
    attributes,
    validFromBlock: '0',
    validToBlock: '0',
  })
  const A = (attributeName: string, attributeType: string, value: string) => ({ attributeName, attributeType, value })

  it('refuses allowedMethods on a native policy when the vocabulary is read', async () => {
    const result = await policyPreflight(
      { ...template(ZTP20_V1), readVocabulary: async () => AVAILABLE },
      draft([A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', '1000000'), A('allowedMethods', 'STRING_LIST', '["transfer"]')]),
    )
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toContain('"allowedMethods" applies to ztp20 policies only')
  })

  it('without the vocabulary the same draft gets exactly the old answer plus one honest line', async () => {
    const attributes = [A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', '1000000'), A('allowedMethods', 'STRING_LIST', '["transfer"]')]
    const before = await policyPreflight(template(ZTP20_V1), draft(attributes))
    const after = await policyPreflight({ ...template(ZTP20_V1), readVocabulary: async () => CHALLENGED }, draft(attributes))
    expect(after.ready).toBe(before.ready)
    expect(after.blockers).toEqual(before.blockers)
    expect(after.interpretation).toEqual(before.interpretation)
    expect(after.notChecked.filter((l) => !before.notChecked.includes(l))).toHaveLength(1)
    expect(after.notChecked.join(' ')).toContain('HTTP 403')
  })

  it('a reader that throws does not take preflight down with it, and is reported as unavailable', async () => {
    // The reader contract is "never throws", but preflight is the last line before a paid write.
    const attributes = [A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', '1000000')]
    const before = await policyPreflight(template(NATIVE_V1), draft(attributes))
    const result = await policyPreflight(
      {
        ...template(NATIVE_V1),
        readVocabulary: async () => {
          throw new Error('reader exploded')
        },
      },
      draft(attributes),
    )
    expect(result.ready).toBe(before.ready)
    expect(result.blockers).toEqual(before.blockers)
    expect(result.notChecked.join(' ')).toContain('reader exploded')
    expect(result.notChecked.join(' ')).toMatch(/could not be read/)
  })

  it('adds nothing at all when no vocabulary source is wired', async () => {
    const result = await policyPreflight(
      template(NATIVE_V1),
      draft([A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', '1000000')]),
    )
    expect(result.notChecked.join(' ')).not.toMatch(/vocabulary/i)
  })

  it('a policy of only informational values is still "no enforceable constraint" under the vocabulary', async () => {
    const result = await policyPreflight(
      { ...template(ZTP20_V1), readVocabulary: async () => AVAILABLE },
      draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', TOKEN.value)]),
    )
    expect(result.blockers.join(' ')).toMatch(/no enforceable constraint/)
  })

  it('does not double-refuse a name the template lacks', async () => {
    const result = await policyPreflight(
      { ...template(NATIVE_V1), readVocabulary: async () => AVAILABLE },
      draft([A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', '1000000'), A('dailyLimit', 'NUMBER', '5')]),
    )
    expect(result.blockers.filter((b) => b.includes('dailyLimit'))).toHaveLength(1)
    expect(result.blockers.join(' ')).toContain('not declared by this template')
  })
})

describe('attachAttributeMeanings', () => {
  const declared = [
    { name: 'allowedMethods', type: 'STRING_LIST' },
    { name: 'recipientAllowlist', type: 'ADDRESS_LIST' },
  ]

  it('returns the result untouched when there is no vocabulary source', async () => {
    const result = { found: true, declared }
    expect(await attachAttributeMeanings(result, undefined)).toBe(result)
  })

  it('returns the result untouched, without reading, when nothing is declared', async () => {
    const reader = vi.fn(async () => AVAILABLE)
    const result = { found: false }
    expect(await attachAttributeMeanings(result, reader)).toBe(result)
    expect(reader).not.toHaveBeenCalled()
  })

  it('attaches the service description beside what the chain returned, leaving it intact', async () => {
    const result = { found: true, templateId: 'abc', declared }
    const out = (await attachAttributeMeanings(result, async () => AVAILABLE)) as typeof result & { attributeMeanings: Array<Record<string, unknown>> }
    expect(out.declared).toEqual(declared)
    expect(out.templateId).toBe('abc')
    expect(out.attributeMeanings.map((m) => m.name)).toEqual(['allowedMethods', 'recipientAllowlist'])
    expect(out.attributeMeanings[1]).toMatchObject({ emptyMeans: 'DENY_ALL', role: 'CONSTRAINT', type: 'ADDRESS_LIST' })
    expect(out.attributeMeanings[1].description).toMatch(/empty list allows no recipient/)
    // Null fields are left out rather than echoed as null.
    expect(out.attributeMeanings[1]).not.toHaveProperty('unit')
  })

  it('covers every template in a listing, once per attribute', async () => {
    const listing = { found: true, templates: [{ policyKey: 'a', declared }, { policyKey: 'b', declared: [declared[0]] }] }
    const out = (await attachAttributeMeanings(listing, async () => AVAILABLE)) as typeof listing & { attributeMeanings: unknown[] }
    expect(out.attributeMeanings).toHaveLength(2)
  })

  it('names a declared attribute the service does not know, and what that means', async () => {
    const out = (await attachAttributeMeanings({ declared: [{ name: 'dailyLimit', type: 'NUMBER' }] }, async () => AVAILABLE)) as Record<string, unknown>
    expect(out.attributesUnknownToService).toEqual(['dailyLimit'])
    expect(String(out.attributesUnknownToServiceNote)).toMatch(/refuses every transfer/)
    expect(out.attributeMeanings).toEqual([])
  })

  it('adds one sentence, and nothing else, when the vocabulary could not be read', async () => {
    const result = { found: true, declared }
    const out = (await attachAttributeMeanings(result, async () => CHALLENGED)) as Record<string, unknown>
    expect(out).toEqual({ ...result, attributeMeaningsNote: expect.stringContaining('HTTP 403') })
    expect(out).not.toHaveProperty('attributeMeanings')
  })

  it('ignores malformed declared entries instead of throwing', async () => {
    const out = await attachAttributeMeanings({ declared: [null, 5, { name: 7 }] as never }, async () => AVAILABLE)
    expect(out).toEqual({ declared: [null, 5, { name: 7 }] })
  })
})

describe('get_policy_template_schema carries the meanings', () => {
  const baseDeps = (extra: Partial<ToolDeps>): ToolDeps =>
    ({
      config: { network: 'testnet', policyTemplateAddress: 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5', policyRegistryAddress: undefined, policyTemplatePublisher: undefined },
      chainQuery: (async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify(ZTP20_V1) } }] } })) as never,
      ...extra,
    }) as unknown as ToolDeps

  it('adds attributeMeanings to a templateId read', async () => {
    const tools = createTools(baseDeps({ readPolicyVocabulary: async () => AVAILABLE }))
    const out = (await tools.get_policy_template_schema({ templateId: 'a'.repeat(64) })) as Record<string, unknown>
    expect(out.found).toBe(true)
    expect((out.attributeMeanings as unknown[]).length).toBeGreaterThan(5)
    expect(out.declared).toBeDefined()
  })

  it('is exactly the old result when no vocabulary source is wired', async () => {
    const tools = createTools(baseDeps({}))
    const out = (await tools.get_policy_template_schema({ templateId: 'a'.repeat(64) })) as Record<string, unknown>
    expect(out).not.toHaveProperty('attributeMeanings')
    expect(out).not.toHaveProperty('attributeMeaningsNote')
  })

  it('says so, on the result, when the vocabulary could not be read', async () => {
    const tools = createTools(baseDeps({ readPolicyVocabulary: async () => CHALLENGED }))
    const out = (await tools.get_policy_template_schema({ templateId: 'a'.repeat(64) })) as Record<string, unknown>
    expect(out.found).toBe(true)
    expect(String(out.attributeMeaningsNote)).toContain('HTTP 403')
  })

  it('adds nothing to an error', async () => {
    const tools = createTools(baseDeps({ readPolicyVocabulary: async () => AVAILABLE, chainQuery: (async () => ({ errorCode: 151 })) as never }))
    const out = (await tools.get_policy_template_schema({ templateId: 'a'.repeat(64) })) as Record<string, unknown>
    expect(out).not.toHaveProperty('attributeMeanings')
  })
})

describe('wiring', () => {
  it('builds a reader from the policy write URL, and nothing without one', async () => {
    expect(buildPolicyVocabularyReader(undefined)).toEqual({})
    expect(buildPolicyVocabularyReader('')).toEqual({})
    const built = buildPolicyVocabularyReader('https://example.test/api')
    expect(typeof built.readPolicyVocabulary).toBe('function')
  })

  it('the reader asks /policy/vocabulary on that base, through the global fetch', async () => {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      return new Response(REAL_VOCABULARY_BODY, { status: 200 })
    }) as typeof fetch
    try {
      const out = await buildPolicyVocabularyReader('https://example.test/api').readPolicyVocabulary?.()
      expect(out?.available).toBe(true)
      expect(calls).toEqual(['https://example.test/api/policy/vocabulary'])
    } finally {
      globalThis.fetch = original
    }
  })

  it('hands the same reader to both preflight call sites through buildPreflightTokenDeps', () => {
    const reader = async () => AVAILABLE
    expect(buildPreflightTokenDeps('testnet', (async () => ({})) as never, reader).readVocabulary).toBe(reader)
    expect(buildPreflightTokenDeps('testnet', (async () => ({})) as never)).not.toHaveProperty('readVocabulary')
  })

  it('HttpGet is satisfied by the global fetch', () => {
    const get: HttpGet = (url, init) => fetch(url, init)
    expect(typeof get).toBe('function')
  })
})

describe('mutation follow-ups', () => {
  it('under a native scope with a token named, allowedMethods is not called unenforceable but tokenAddress is still refused', () => {
    const found = checkAgainstVocabulary([SCOPE_NATIVE, CAP, METHODS, TOKEN], null, AVAILABLE)
    const text = found.blockers.join(' ')
    expect(text).toContain('"tokenAddress" applies to ztp20 policies only')
    expect(text).not.toContain('"allowedMethods" applies to')
  })

  it('NOT_GOVERNED only speaks of native transfers when the scope is native', () => {
    const synthetic = parseVocabularyBody(
      JSON.stringify({
        object: {
          version: 'v1',
          attributes: [
            { name: 'assetScope', type: 'STRING', appliesTo: ['native', 'ztp20'], description: 'Scope.', unit: null, role: 'QUALIFIER', pairsWith: null, withoutPairMeans: null, emptyMeans: null, outsideAppliesToMeans: null },
            {
              name: 'nativeOnlyThing', type: 'STRING', appliesTo: ['native'], description: 'Only for native.',
              unit: null, role: 'CONSTRAINT', pairsWith: null, withoutPairMeans: null, emptyMeans: null, outsideAppliesToMeans: 'NOT_GOVERNED',
            },
          ],
        },
        success: true,
      }),
    )
    if (!synthetic.available) throw new Error('synthetic vocabulary must parse')
    const underZtp20 = checkAgainstVocabulary([SCOPE_ZTP20, attr('nativeOnlyThing', 'x')], null, synthetic)
    expect(underZtp20.blockers).toEqual([])
  })

  it('preflight uses the service role, not only the built-in sets, to decide whether anything is enforceable', async () => {
    const informational = parseVocabularyBody(
      REAL_VOCABULARY_BODY.replace(/("name":"perTransactionMax"[^}]*?"role":)"CONSTRAINT"/, '$1"INFORMATIONAL"'),
    )
    if (!informational.available) throw new Error('edited vocabulary must parse')
    const draft = {
      policyKey: 'k', templateId: 'a'.repeat(64), validFromBlock: '0', validToBlock: '0',
      attributes: [
        { attributeName: 'assetScope', attributeType: 'STRING', value: 'native' },
        { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' },
      ],
    }
    const template = { readTemplate: async () => ({ found: true, value: NATIVE_V1 as unknown as TemplateRecord }) as never }
    const withBuiltIn = await policyPreflight({ ...template, readVocabulary: async () => AVAILABLE }, draft)
    const withServiceRole = await policyPreflight({ ...template, readVocabulary: async () => informational }, draft)
    expect(withBuiltIn.blockers.join(' ')).not.toMatch(/no enforceable constraint/)
    expect(withServiceRole.blockers.join(' ')).toMatch(/no enforceable constraint/)
  })

  it('reports no unknown attributes when every declared one is known', async () => {
    const out = (await attachAttributeMeanings({ declared: [{ name: 'allowedMethods', type: 'STRING_LIST' }] }, async () => AVAILABLE)) as Record<string, unknown>
    expect(out).not.toHaveProperty('attributesUnknownToService')
    expect(out).not.toHaveProperty('attributesUnknownToServiceNote')
  })
})
