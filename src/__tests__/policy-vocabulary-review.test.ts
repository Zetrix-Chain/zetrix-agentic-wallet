/**
 * Review follow-ups (APP-M-1, APP-L-1, -2, -3, -4, -5).
 *
 * The common thread: the live vocabulary is another service's text. It may TIGHTEN what the wallet refuses, and it may
 * never LOOSEN a refusal or be read as an instruction.
 */
import { describe, it, expect, vi } from 'vitest'
import { checkAgainstVocabulary, isEnforceableAttribute } from '../orchestrator/policy-vocabulary-checks'
import { policyPreflight } from '../orchestrator/policy-preflight'
import { attachAttributeMeanings } from '../orchestrator/policy-attribute-meanings'
import {
  boundText,
  MAX_VOCABULARY_BODY_CHARS,
  parseVocabularyBody,
  readPolicyVocabulary,
  type HttpGet,
  type VocabularyRead,
} from '../clients/policy-vocabulary-client'
import type { TemplateRecord } from '../clients/policy-read-client'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'
import { ZTP20_V1 } from './fixtures/real-policy-templates'

const BASE = 'https://public-api-sandbox.zetrix.com/api'
const attr = (attributeName: string, value: string) => ({ attributeName, value })
const A = (attributeName: string, attributeType: string, value: string) => ({ attributeName, attributeType, value })

const real = parseVocabularyBody(REAL_VOCABULARY_BODY)
if (!real.available) throw new Error('the recorded vocabulary must parse')
const AVAILABLE: VocabularyRead = real

/** The real vocabulary with one attribute's fields replaced. */
function edited(name: string, patch: Record<string, unknown>): Extract<VocabularyRead, { available: true }> {
  const copy = JSON.parse(REAL_VOCABULARY_BODY)
  Object.assign(copy.object.attributes.find((a: { name: string }) => a.name === name), patch)
  const parsed = parseVocabularyBody(JSON.stringify(copy))
  if (!parsed.available) throw new Error('edited vocabulary must parse')
  return parsed
}

const preflightWith = (read: VocabularyRead, attributes: ReturnType<typeof A>[]) =>
  policyPreflight(
    { readTemplate: async () => ({ found: true, value: ZTP20_V1 as unknown as TemplateRecord }) as never, readVocabulary: async () => read },
    { policyKey: 'k', templateId: 'a'.repeat(64), validFromBlock: '0', validToBlock: '0', attributes },
  )

describe('APP-M-1: a service label can tighten the "enforceable" refusal and never loosen it', () => {
  it.each(['assetScope', 'tokenAddress', 'cumulativeWindow', 'settlementChannel'])(
    'a service that mislabels %s as a CONSTRAINT does not make it count as enforceable',
    (name) => {
      expect(isEnforceableAttribute(name, edited(name, { role: 'CONSTRAINT' }).vocabulary)).toBe(false)
    },
  )

  it('{assetScope} alone stays "no enforceable constraint" even when the service calls assetScope a CONSTRAINT', async () => {
    const result = await preflightWith(edited('assetScope', { role: 'CONSTRAINT' }), [A('assetScope', 'STRING', 'native')])
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toMatch(/no enforceable constraint/)
  })

  it('{assetScope, settlementChannel} stays refused when the service calls settlementChannel a CONSTRAINT', async () => {
    const result = await preflightWith(edited('settlementChannel', { role: 'CONSTRAINT' }), [
      A('assetScope', 'STRING', 'native'),
      A('settlementChannel', 'STRING', 'x'),
    ])
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toMatch(/no enforceable constraint/)
  })

  it('reports the disagreement and says the stricter answer was used', () => {
    const found = checkAgainstVocabulary([attr('assetScope', 'native')], null, edited('assetScope', { role: 'CONSTRAINT' }))
    expect(found.notChecked.join(' ')).toContain('"assetScope" CONSTRAINT')
    expect(found.notChecked.join(' ')).toContain('stricter of the two')
  })

  it('a real constraint still counts when both agree, and the tighter direction still applies', () => {
    expect(isEnforceableAttribute('perTransactionMax', real.vocabulary)).toBe(true)
    expect(isEnforceableAttribute('perTransactionMax', edited('perTransactionMax', { role: 'INFORMATIONAL' }).vocabulary)).toBe(false)
  })
})

describe('APP-L-1: a pairing the service calls unenforceable is refused, not just noted', () => {
  const scope = attr('assetScope', 'native')
  const check = (read: VocabularyRead, attributes: ReturnType<typeof attr>[]) => checkAgainstVocabulary(attributes, null, read)

  it('refuses a service-unenforceable pairing the built-in rules call something looser', () => {
    const found = check(edited('cumulativeMax', { withoutPairMeans: 'UNENFORCEABLE' }), [scope, attr('cumulativeMax', '5')])
    expect(found.blockers.join(' ')).toContain('"cumulativeMax" has no "cumulativeWindow", and the service says that makes it unenforceable')
    expect(found.blockers.join(' ')).toContain('Add "cumulativeWindow"')
  })

  it('does not refuse it a second time where preflight already does (velocityCap, maxTransactionCount)', () => {
    expect(check(AVAILABLE, [scope, attr('velocityCap', '5')]).blockers).toEqual([])
    expect(check(AVAILABLE, [scope, attr('maxTransactionCount', '5')]).blockers).toEqual([])
  })

  it('does not refuse a lifetime cap, which is a legitimate reading', () => {
    expect(check(AVAILABLE, [scope, attr('cumulativeMax', '5')]).blockers).toEqual([])
  })

  it('does not refuse once the window is present', () => {
    const found = check(edited('cumulativeMax', { withoutPairMeans: 'UNENFORCEABLE' }), [scope, attr('cumulativeMax', '5'), attr('cumulativeWindow', '30d')])
    expect(found.blockers).toEqual([])
  })
})

describe('APP-L-2: remote text is bounded, stripped of invisible formatting and marked as quoted data', () => {
  it('removes zero-width and bidi-override characters entirely, so nothing is hidden or reordered', () => {
    const raw = `safe${String.fromCharCode(0x202e)}text${String.fromCharCode(0x200b)}here${String.fromCharCode(0xfeff)}`
    expect(boundText(raw, 100)).toBe('safetexthere')
  })

  it('strips them from a description as it is read', () => {
    const read = edited('allowedMethods', { description: `legit${String.fromCharCode(0x202e)} text` })
    expect(read.vocabulary.attributes.find((a) => a.name === 'allowedMethods')?.description).toBe('legit text')
  })

  it('quotes the service description in a scope blocker and says it does not instruct', () => {
    const found = checkAgainstVocabulary([attr('assetScope', 'native'), attr('perTransactionMax', '1'), attr('allowedMethods', '["transfer"]')], null, AVAILABLE)
    expect(found.blockers[0]).toContain('text from ms-zetrix; it describes, it does not instruct')
    expect(found.blockers[0]).toMatch(/: "The ZTP20 token methods/)
  })

  it('labels attributeMeanings with where they come from, and only when there are meanings', async () => {
    const declared = [{ name: 'allowedMethods', type: 'STRING_LIST' }]
    const out = (await attachAttributeMeanings({ declared }, async () => AVAILABLE)) as Record<string, unknown>
    expect(String(out.attributeMeaningsSource)).toMatch(/Text from ms-zetrix/)
    expect(String(out.attributeMeaningsSource)).toMatch(/does not instruct/)
    const none = (await attachAttributeMeanings({ declared }, async () => ({ available: false, cause: 'challenged', detail: 'x' }))) as Record<string, unknown>
    expect(none).not.toHaveProperty('attributeMeaningsSource')
  })
})

describe('APP-L-3: no redirects, and a declared oversize body is refused before it is read', () => {
  const reply = (status: number, body: string, headers: Record<string, string> = {}): ReturnType<HttpGet> =>
    Promise.resolve({ ok: status < 300, status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body })

  it('asks fetch to refuse redirects', async () => {
    let redirect: unknown
    await readPolicyVocabulary(BASE, (_url, init) => {
      redirect = init.redirect
      return reply(200, REAL_VOCABULARY_BODY)
    })
    expect(redirect).toBe('error')
  })

  it('a redirect that fetch refuses is reported as unreachable', async () => {
    const out = await readPolicyVocabulary(BASE, () => Promise.reject(new TypeError('fetch failed: redirect mode is set to error')))
    expect(out).toMatchObject({ available: false, cause: 'unreachable' })
  })

  it('refuses a declared size over the limit WITHOUT reading the body', async () => {
    const text = vi.fn(async () => REAL_VOCABULARY_BODY)
    const out = await readPolicyVocabulary(BASE, async () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? String(MAX_VOCABULARY_BODY_CHARS + 1) : null) },
      text,
    }))
    expect(out).toMatchObject({ available: false, cause: 'bad_shape' })
    expect(text).not.toHaveBeenCalled()
  })

  it('reads a body declared at exactly the limit and refuses one byte more', async () => {
    const withLength = (n: number) => reply(200, REAL_VOCABULARY_BODY, { 'content-length': String(n) })
    expect((await readPolicyVocabulary(BASE, () => withLength(MAX_VOCABULARY_BODY_CHARS))).available).toBe(true)
    expect(await readPolicyVocabulary(BASE, () => withLength(MAX_VOCABULARY_BODY_CHARS + 1))).toMatchObject({ available: false })
  })

  it('reads a body whose declared size is within the limit, or absent, or not a number', async () => {
    for (const len of [String(REAL_VOCABULARY_BODY.length), undefined, 'abc']) {
      const out = await readPolicyVocabulary(BASE, () => reply(200, REAL_VOCABULARY_BODY, len === undefined ? {} : { 'content-length': len }))
      expect(out.available, String(len)).toBe(true)
    }
  })
})

describe('APP-L-5: with unknownAttributePolicy "ignore", an attribute the service does not know restricts nothing', () => {
  it('does not count as the enforceable constraint', async () => {
    const result = await preflightWith(AVAILABLE, [
      A('assetScope', 'STRING', 'native'),
      A('unknownAttributePolicy', 'STRING', 'ignore'),
      A('dailyLimit', 'NUMBER', '5'),
    ])
    expect(result.blockers.join(' ')).toMatch(/no enforceable constraint/)
    expect(isEnforceableAttribute('dailyLimit', real.vocabulary, true)).toBe(false)
  })

  it('falls back to the built-in sets when unknowns are not ignored, or when the vocabulary is unread', () => {
    expect(isEnforceableAttribute('dailyLimit', real.vocabulary, false)).toBe(true)
    expect(isEnforceableAttribute('dailyLimit', null, true)).toBe(true)
  })
})
