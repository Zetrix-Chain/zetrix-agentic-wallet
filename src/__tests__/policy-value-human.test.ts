/**
 * `valueHuman` — a human amount for an amount attribute, converted with the asset's own on-chain decimals.
 *
 * "perTransactionMax 100 JMYR" is easy to say and dangerous to write: the service stores raw base units, and 100 of a
 * 6-decimal token is 100000000. `amountUnit` already converts every amount in a draft one way; `valueHuman` lets ONE
 * attribute say what it means, and the wallet does the multiplication from the token's real decimals, shows both forms,
 * and refuses anything it cannot convert exactly. It never scales a count or a duration.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight, type PolicyPreflightDeps } from '../orchestrator/policy-preflight'
import { writePolicy, updatePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import { parseVocabularyBody, type VocabularyRead } from '../clients/policy-vocabulary-client'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'
import { ZTP20_V1, NATIVE_V1 } from './fixtures/real-policy-templates'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

type Attr = { attributeName: string; attributeType: string; value?: string; valueHuman?: unknown }
const a = (attributeName: string, value: string, attributeType = 'STRING'): Attr => ({ attributeName, attributeType, value })
const human = (attributeName: string, valueHuman: unknown, extra: Partial<Attr> = {}): Attr => ({
  attributeName,
  attributeType: 'NUMBER',
  valueHuman,
  ...extra,
})

const SCOPE = [a('assetScope', 'ztp20'), a('tokenAddress', JMYR, 'ADDRESS')]
const WINDOW = a('cumulativeWindow', '7d')

const draft = (attributes: Attr[], over: Record<string, unknown> = {}) =>
  ({ policyKey: 'ztp20-v1', templateId: 'a'.repeat(64), attributes, validFromBlock: '0', validToBlock: '0', ...over }) as never

const read = parseVocabularyBody(REAL_VOCABULARY_BODY)
if (!read.available) throw new Error('the recorded vocabulary must parse')
const AVAILABLE: VocabularyRead = read
const CHALLENGED: VocabularyRead = { available: false, cause: 'challenged', detail: 'HTTP 403: bot challenge' }

const deps = (over: Partial<PolicyPreflightDeps> = {}, template: unknown = ZTP20_V1): PolicyPreflightDeps => ({
  readTemplate: async () => ({ found: true, value: template }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (x: string) => keypair.checkAddress(x),
  knownTokens: { JMYR },
  describeUnit: async () => ({ symbol: 'JMYR', decimals: 6 }),
  ...over,
})

const converted = async (attributes: Attr[], over: Partial<PolicyPreflightDeps> = {}, d: Record<string, unknown> = {}) =>
  policyPreflight(deps(over), draft(attributes, d))

describe('converting a human amount', () => {
  it('turns 100 JMYR into 100000000, returns it, and shows both forms', async () => {
    const r = await converted([...SCOPE, human('cumulativeMax', '100'), WINDOW])

    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(r.convertedAmounts).toEqual({ cumulativeMax: '100000000' })
    const text = r.interpretation.join(' | ')
    expect(text).toContain('100 JMYR')
    expect(text).toContain('100000000')
  })

  it.each([
    ['1', '1000000'],
    ['0.5', '500000'],
    ['1.5', '1500000'],
    ['0.000001', '1'],
    ['250.25', '250250000'],
    ['0', '0'],
  ])('converts %s JMYR to %s', async (valueHuman, raw) => {
    const r = await converted([...SCOPE, human('perTransactionMax', valueHuman)])

    expect(r.convertedAmounts).toEqual({ perTransactionMax: raw })
  })

  it('accepts a number as well as a string, since a model may send either', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', 100)])

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '100000000' })
  })

  it('uses the decimals of the token it is actually for', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '1')], { describeUnit: async () => ({ symbol: 'USD', decimals: 18 }) })

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1' + '0'.repeat(18) })
  })

  it('needs no scaling for a token with no decimals', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '5')], { describeUnit: async () => ({ symbol: 'PT', decimals: 0 }) })

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '5' })
  })

  it('converts native ZTX with the native decimals', async () => {
    const r = await policyPreflight(deps({}, NATIVE_V1), draft([a('assetScope', 'native'), human('perTransactionMax', '2')], { policyKey: 'native-v1' }))

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '2000000' })
  })
})

describe('what it refuses, and converts nothing', () => {
  it.each([
    ['more decimal places than the token has', '0.0000001'],
    ['an exponent', '1e3'],
    ['a negative amount', '-5'],
    ['a thousands separator', '1,000'],
    ['units in the text', '100 JMYR'],
    ['an empty string', ''],
    ['a lone point', '.'],
    ['text', 'a lot'],
  ])('refuses %s', async (_label, valueHuman) => {
    const r = await converted([...SCOPE, human('perTransactionMax', valueHuman)])

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/perTransactionMax/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it.each([[null], [{}], [[1]], [true], [Number.NaN], [Infinity]])('refuses a valueHuman that is %j', async (valueHuman) => {
    const r = await converted([...SCOPE, human('perTransactionMax', valueHuman)])

    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('refuses a human amount when it does not know which asset it is in, rather than guessing a scale', async () => {
    const r = await converted([human('perTransactionMax', '100')])

    expect(r.blockers.join(' ')).toMatch(/which asset/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('refuses a human amount when the token\'s decimals cannot be read, and converts nothing', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '100')], { describeUnit: async () => null as never })

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/decimals/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('refuses an attribute that carries neither a value nor a valueHuman', async () => {
    const r = await converted([...SCOPE, { attributeName: 'perTransactionMax', attributeType: 'NUMBER' }])

    expect(r.ready).toBe(false)
  })
})

describe('only an amount can be given as a human amount', () => {
  it.each([
    ['maxTransactionCount', 'a count'],
    ['cumulativeWindow', 'a duration'],
    ['velocityWindow', 'a duration'],
  ])('refuses %s, which is %s, and never scales it', async (name, _what) => {
    const r = await converted([...SCOPE, a('perTransactionMax', '1000000', 'NUMBER'), human(name, '5')])

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(new RegExp(`"${name}".*(count|duration|not an amount)`, 'i'))
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('takes the served unit over the built-in belief: an attribute the service calls a COUNT is never converted', async () => {
    const vocabulary = {
      ...AVAILABLE.vocabulary,
      attributes: AVAILABLE.vocabulary.attributes.map((x) => (x.name === 'perTransactionMax' ? { ...x, unit: 'COUNT' } : x)),
    }

    const r = await converted([...SCOPE, human('perTransactionMax', '5')], { readVocabulary: async () => ({ ...AVAILABLE, vocabulary }) })

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/count/i)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('takes the served unit over the built-in belief: an attribute the service calls a DURATION is never converted', async () => {
    const vocabulary = {
      ...AVAILABLE.vocabulary,
      attributes: AVAILABLE.vocabulary.attributes.map((x) => (x.name === 'perTransactionMax' ? { ...x, unit: 'DURATION' } : x)),
    }

    const r = await converted([...SCOPE, human('perTransactionMax', '5')], { readVocabulary: async () => ({ ...AVAILABLE, vocabulary }) })

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/duration/i)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('converts an attribute the service says is in the smallest unit', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '1')], { readVocabulary: async () => AVAILABLE })

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000' })
  })

  it('converts an attribute only the service knows is an amount (the built-in list has never heard of it)', async () => {
    const vocabulary = {
      ...AVAILABLE.vocabulary,
      attributes: [
        ...AVAILABLE.vocabulary.attributes,
        { name: 'monthlyBudget', type: 'NUMBER', appliesTo: ['native', 'ztp20'], description: 'a budget', unit: 'SMALLEST_UNIT', role: 'CONSTRAINT', pairsWith: null, withoutPairMeans: null, emptyMeans: null, outsideAppliesToMeans: null },
      ],
    }

    const r = await converted([...SCOPE, human('monthlyBudget', '2')], { readVocabulary: async () => ({ ...AVAILABLE, vocabulary }) })

    expect(r.convertedAmounts).toEqual({ monthlyBudget: '2000000' })
  })

  it('falls back to the built-in amount list when the vocabulary cannot be read, and says so', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '1')], { readVocabulary: async () => CHALLENGED })

    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000' })
    expect(r.notChecked.join(' ')).toMatch(/vocabulary/i)
  })
})

describe('a value and a valueHuman for the same attribute must agree', () => {
  it('accepts them when they say the same thing', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '1', { value: '1000000' })])

    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000' })
  })

  it('refuses them when they do not, naming both and the raw value the human amount means', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '1', { value: '1' })])

    expect(r.ready).toBe(false)
    const text = r.blockers.join(' ')
    expect(text).toMatch(/do not agree/)
    expect(text).toContain('1000000')
    expect(r.convertedAmounts).toBeUndefined()
  })
})

describe('valueHuman and amountUnit never double-convert', () => {
  it('converts a valueHuman attribute once, whatever amountUnit says, and still converts its siblings by amountUnit', async () => {
    const r = await converted(
      [...SCOPE, human('cumulativeMax', '100'), a('perTransactionMax', '1', 'NUMBER'), WINDOW],
      {},
      { amountUnit: 'whole' },
    )

    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ cumulativeMax: '100000000', perTransactionMax: '1000000' })
  })

  it('is not caught by the "less than one whole token" guard, because a human amount is explicit', async () => {
    const r = await converted([...SCOPE, human('perTransactionMax', '0.5')])

    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '500000' })
  })

  it('still applies that guard to a sibling raw value', async () => {
    const r = await converted([...SCOPE, human('cumulativeMax', '100'), a('perTransactionMax', '1', 'NUMBER'), WINDOW])

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/perTransactionMax/)
  })
})

describe('what write_policy and update_policy send', () => {
  const CHALLENGE = { x402Version: 1, accepts: [{ scheme: 'exact', asset: 'A', maxAmountRequired: '1' }] }
  const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
  const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'

  const harness = (preflight: WritePolicyDeps['preflight'], extra: Partial<WritePolicyDeps> = {}) => {
    const bodies: string[] = []
    const send: HttpSend = async (_url, init) => {
      bodies.push(init.body)
      return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify(CHALLENGE) }
    }
    const d: WritePolicyDeps = {
      client: new PolicyWriteClient('https://ms.test/api', send),
      receipts: { get: async () => null, set: async () => undefined, list: async () => [], remove: async () => undefined, filePathFor: () => '/x' },
      pay: vi.fn(async () => 'h'),
      chooseAccept: (x) => x[0],
      hsmPassword: 'p',
      ownerAddress: OWNER,
      network: 'zetrix:testnet',
      sleep: async () => undefined,
      templateContract: TEMPLATE,
      preflight,
      ...extra,
    }
    return { d, bodies }
  }
  const ready = (convertedAmounts: Record<string, string>) =>
    (async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [], convertedAmounts })) as WritePolicyDeps['preflight']

  const attributes = [
    { attributeName: 'cumulativeMax', attributeType: 'NUMBER', valueHuman: '100' },
    { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: '7d' },
  ]

  it('write_policy sends the raw value for a human amount, and never the human one', async () => {
    const { d, bodies } = harness(ready({ cumulativeMax: '100000000' }))

    await writePolicy(d, { policyKey: 'k', attributes, templateId: 'a'.repeat(64), templateContractAddress: TEMPLATE, dryRun: true } as never)

    const sent = JSON.parse(bodies[0]).attributes
    expect(sent).toEqual([
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100000000' },
      { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: '7d' },
    ])
    expect(JSON.stringify(sent)).not.toContain('valueHuman')
  })

  it('update_policy does the same', async () => {
    const policy = {
      found: true as const,
      value: {
        policy: { attributes: [], validFromBlock: '1', validToBlock: '2', updatedAtBlock: 7, templateContractAddress: TEMPLATE, templateId: 'a'.repeat(64) },
      },
    }
    const { d, bodies } = harness(ready({ cumulativeMax: '100000000' }), { readPolicy: async () => policy })

    await updatePolicy(d, { policyKey: 'k', attributes, expectedUpdatedAtBlock: '7', dryRun: true } as never)

    const sent = JSON.parse(bodies[0]).attributes
    expect(sent[0]).toEqual({ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100000000' })
    expect(JSON.stringify(sent)).not.toContain('valueHuman')
  })

  it('hands the preflight the human amount untouched, so the conversion happens in exactly one place', async () => {
    const preflight = vi.fn(ready({ cumulativeMax: '100000000' }))
    const { d } = harness(preflight)

    await writePolicy(d, { policyKey: 'k', attributes, templateId: 'a'.repeat(64), templateContractAddress: TEMPLATE, dryRun: true } as never)

    expect(preflight.mock.calls[0][0].attributes[0]).toMatchObject({ attributeName: 'cumulativeMax', valueHuman: '100' })
  })
})
