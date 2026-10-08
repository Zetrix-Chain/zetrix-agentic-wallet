/**
 * Acceptance criteria that were already delivered, pinned against the recorded vocabulary so they
 * cannot drift unseen. (valueHuman is in policy-value-human.test.ts.)
 *
 *   - a cap whose pair is missing is described exactly as the served `withoutPairMeans` says: LIFETIME is stated as a
 *     lifetime cap, UNENFORCEABLE is a blocker that names the missing window — for velocityCap and maxTransactionCount;
 *   - an attribute used outside the scope it applies to is a blocker on a native policy.
 */
import { describe, it, expect } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight } from '../orchestrator/policy-preflight'
import { parseVocabularyBody } from '../clients/policy-vocabulary-client'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'
import { ZTP20_V1, NATIVE_V1 } from './fixtures/real-policy-templates'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const read = parseVocabularyBody(REAL_VOCABULARY_BODY)
if (!read.available) throw new Error('the recorded vocabulary must parse')

const a = (attributeName: string, value: string, attributeType = 'NUMBER') => ({ attributeName, attributeType, value })
const TOKEN_SCOPE = [a('assetScope', 'ztp20', 'STRING'), a('tokenAddress', JMYR, 'ADDRESS')]

const run = (attributes: ReturnType<typeof a>[], template: unknown = ZTP20_V1) =>
  policyPreflight(
    {
      readTemplate: async () => ({ found: true, value: template }) as never,
      network: 'zetrix:testnet',
      isValidAddress: (x: string) => keypair.checkAddress(x),
      knownTokens: { JMYR },
      describeUnit: async () => ({ symbol: 'JMYR', decimals: 6 }),
      readVocabulary: async () => read,
    },
    { policyKey: 'k', templateId: 'a'.repeat(64), attributes, validFromBlock: '0', validToBlock: '0' } as never,
  )

const by = new Map(read.vocabulary.attributes.map((x) => [x.name, x]))

describe('a cap without its window is what the service says it is', () => {
  it('cumulativeMax: the service says LIFETIME, and preflight states a lifetime cap and stays ready', async () => {
    expect(by.get('cumulativeMax')?.withoutPairMeans).toBe('LIFETIME')

    const r = await run([...TOKEN_SCOPE, a('cumulativeMax', '1000000')])

    expect(r.ready).toBe(true)
    expect(r.interpretation.join(' ')).toMatch(/cumulativeMax.*no "cumulativeWindow".*entire lifetime/)
  })

  it.each([
    ['velocityCap', 'velocityWindow', [a('velocityCap', '1000000')]],
    ['maxTransactionCount', 'countWindow', [a('perTransactionMax', '1000000'), a('maxTransactionCount', '5')]],
  ])('%s: the service says UNENFORCEABLE, so preflight BLOCKS and names the missing %s', async (cap, window, attributes) => {
    expect(by.get(cap)?.withoutPairMeans).toBe('UNENFORCEABLE')

    const r = await run([...TOKEN_SCOPE, ...attributes])

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toContain(`"${cap}" has no "${window}"`)
  })

  it('a cap WITH its window is not reported as missing one', async () => {
    const r = await run([...TOKEN_SCOPE, a('velocityCap', '1000000'), a('velocityWindow', '1d', 'STRING'), a('perTransactionMax', '1000000')])

    expect(r.blockers.join(' ')).not.toMatch(/has no "velocityWindow"/)
  })
})

describe('an attribute outside the scope it applies to', () => {
  it('allowedMethods on a native policy is refused: it applies to ztp20 only', async () => {
    expect(by.get('allowedMethods')?.appliesTo).toEqual(['ztp20'])

    const r = await run([a('assetScope', 'native', 'STRING'), a('perTransactionMax', '1000000'), a('allowedMethods', '["transfer"]', 'STRING_LIST')], NATIVE_V1)

    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/"allowedMethods" applies to ztp20 policies only/)
  })
})
