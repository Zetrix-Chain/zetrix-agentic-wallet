/**
 * Finding a template when you have nothing — the path a first-time user takes, and the one that
 * dead-ended: "show me the policy template" on a wallet with no deployed policy made the agent ask
 * the user for a publisher and a template contract address neither of which a user can know.
 *
 * The two ids pinned below are REAL. Both were derived from the testnet publisher and then
 * confirmed on chain (`getTemplateById` answered `found:true`, 11 and 13 attributes), so the
 * derivation is pinned against the contract's own behaviour and not against a restatement of the
 * rule.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  MAX_DECLARED,
  MAX_IDENTIFIER,
  MAX_TEMPLATES,
  confirmTemplateId,
  deriveTemplateId,
  discoverTemplates,
  listTemplateKeys,
} from '../clients/policy-template-discovery'
import { createTools } from '../mcp-tools'
import { buildToolConfig, buildToolList } from '../index'
import { derivePolicyTemplatePublisher, loadConfig } from '../config'
import { NATIVE_V1, ZTP20_V1 } from './fixtures/real-policy-templates'

const PUBLISHER = 'ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'

/** Confirmed on chain 2026-09-30. */
const NATIVE_ID = '06d52067df012577a66ff997874f4db56ed7a473bc1eda2ce8d7681faffcfdc8'
const ZTP20_ID = '3d2e2d3575d93d889bdce6ce9fc02405d0987ab05ad661894a18f4119e958acf'

const rets = (value: unknown) => ({
  errorCode: 0,
  result: { query_rets: [{ result: { value: typeof value === 'string' ? value : JSON.stringify(value) } }] },
})

type Query = (q: { contractAddress: string; input: string; optType: number }) => Promise<unknown>

/** A chain that answers by method, and records every call so a test can say what was NOT asked. */
function chain(handlers: Record<string, (params: Record<string, unknown>) => unknown>) {
  const calls: Array<{ method: string; params: Record<string, unknown>; contractAddress: string }> = []
  const query: Query = vi.fn(async ({ contractAddress, input }) => {
    const { method, params } = JSON.parse(input)
    calls.push({ method, params, contractAddress })
    const h = handlers[method]
    if (!h) return rets({ found: false })
    return h(params)
  })
  return { query: query as never, calls }
}

/** The testnet publisher's real shape: both templates exist and both derived ids resolve. */
const realPublisher = () =>
  chain({
    listTemplateKeys: () => rets(['native-v1', 'ztp20-v1']),
    getTemplateById: (p) => {
      if (p.templateId === NATIVE_ID) return rets(NATIVE_V1)
      if (p.templateId === ZTP20_ID) return rets(ZTP20_V1)
      return rets({ found: false })
    },
    getTemplate: (p) => rets(p.policyKey === 'native-v1' ? NATIVE_V1 : ZTP20_V1),
  })

describe('the template id is derived, and pinned against the chain', () => {
  it('reproduces the two ids the chain confirmed', () => {
    // If the derivation rule is ever mis-stated here, these fail — and they were checked against
    // getTemplateById on the live Template contract, so they are not circular.
    expect(deriveTemplateId(PUBLISHER, 'native-v1')).toBe(NATIVE_ID)
    expect(deriveTemplateId(PUBLISHER, 'ztp20-v1')).toBe(ZTP20_ID)
  })

  it('depends on both the publisher and the key', () => {
    expect(deriveTemplateId(PUBLISHER, 'native-v1')).not.toBe(deriveTemplateId(PUBLISHER, 'ztp20-v1'))
    expect(deriveTemplateId('ZTX3AnotherPublisher0000000000000000', 'native-v1')).not.toBe(NATIVE_ID)
  })

  it('is 64 lowercase hex', () => {
    expect(deriveTemplateId(PUBLISHER, 'native-v1')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('listTemplateKeys keeps "none" and "could not ask" apart', () => {
  it('returns the publisher’s keys', async () => {
    const { query } = realPublisher()
    expect(await listTemplateKeys(PUBLISHER, TEMPLATE, query)).toEqual({ found: true, value: ['native-v1', 'ztp20-v1'] })
  })

  it('reports an empty list as found:false, not as a list with nothing in it', async () => {
    const { query } = chain({ listTemplateKeys: () => rets([]) })
    expect(await listTemplateKeys(PUBLISHER, TEMPLATE, query)).toEqual({ found: false })
  })

  it('reports a failed call as an error, never as no templates', async () => {
    // AC: "no templates" and "could not look it up" must stay distinct.
    const failing: never = (async () => { throw new Error('ECONNRESET') }) as never
    const r = await listTemplateKeys(PUBLISHER, TEMPLATE, failing)
    expect('error' in r).toBe(true)
    expect(r).not.toEqual({ found: false })
  })

  it('reports a non-array reply as an error', async () => {
    const { query } = chain({ listTemplateKeys: () => rets({ keys: [] }) })
    const r = await listTemplateKeys(PUBLISHER, TEMPLATE, query)
    expect('error' in r).toBe(true)
  })

  it('reports a non-empty reply with nothing usable as an error, not an absence', async () => {
    const { query } = chain({ listTemplateKeys: () => rets([1, null, { a: 1 }]) })
    const r = await listTemplateKeys(PUBLISHER, TEMPLATE, query)
    expect('error' in r).toBe(true)
  })

  for (const blank of ['', '   ', undefined as unknown as string]) {
    it(`refuses ${JSON.stringify(blank)} as a publisher WITHOUT asking the chain`, async () => {
      // The contract builds its storage key by concatenation, so an absent publisher simply
      // misses and answers like a real absence. A wallet bug that dropped it would otherwise be
      // indistinguishable from "this publisher has no templates".
      const { query, calls } = chain({ listTemplateKeys: () => rets(['native-v1']) })
      const r = await listTemplateKeys(blank, TEMPLATE, query)
      expect('error' in r).toBe(true)
      expect(calls).toHaveLength(0)
    })
  }
})

describe('discoverTemplates hands over only ids the chain confirmed', () => {
  it('lists both real templates with confirmed ids and their declared attributes', async () => {
    const { query } = realPublisher()
    const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
    expect(r).toMatchObject({ found: true, publisher: PUBLISHER, total: 2 })
    if (!('templates' in r)) throw new Error('expected templates')
    expect(r.templates.map((t) => [t.policyKey, t.templateId, t.templateIdConfirmed])).toEqual([
      ['native-v1', NATIVE_ID, true],
      ['ztp20-v1', ZTP20_ID, true],
    ])
    expect(r.templates[0].declared).toHaveLength(11)
    expect(r.templates[1].declared).toHaveLength(13)
    expect(r.templates[0].declared).toContainEqual({ name: 'cumulativeMax', type: 'NUMBER' })
  })

  it('withholds an id that was derived but did not resolve', async () => {
    // The contract LISTS the key, but the rule for deriving its id does not find it. Handing the
    // id over anyway would send an agent into a paid write against an id that does not exist.
    const { query } = chain({
      listTemplateKeys: () => rets(['native-v1']),
      getTemplateById: () => rets({ found: false }),
    })
    const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
    if (!('templates' in r)) throw new Error('expected templates')
    expect(r.templates[0].templateIdConfirmed).toBe(false)
    expect(r.templates[0].templateId).toBeUndefined()
    expect(r.templates[0].error).toMatch(/did not resolve/i)
  })

  it('keeps one template’s failure from hiding the others', async () => {
    const { query } = chain({
      listTemplateKeys: () => rets(['native-v1', 'ztp20-v1']),
      getTemplateById: (p) => {
        if (p.templateId === ZTP20_ID) throw new Error('boom')
        return rets(NATIVE_V1)
      },
    })
    const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
    if (!('templates' in r)) throw new Error('expected templates')
    expect(r.templates[0].templateIdConfirmed).toBe(true)
    expect(r.templates[1].templateIdConfirmed).toBe(false)
    expect(r.templates[1].templateId).toBeUndefined()
  })

  it('says found:false for a publisher with no templates, and error when it cannot tell', async () => {
    expect(await discoverTemplates(PUBLISHER, TEMPLATE, chain({ listTemplateKeys: () => rets([]) }).query)).toEqual({
      found: false,
      publisher: PUBLISHER,
    })
    const failing: never = (async () => { throw new Error('down') }) as never
    const r = await discoverTemplates(PUBLISHER, TEMPLATE, failing)
    expect('error' in r).toBe(true)
  })

  describe('bounded, because every key is chain data a publisher controls', () => {
    it('reads at most MAX_TEMPLATES and says how many it left out', async () => {
      const keys = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => `t${i}`)
      const { query, calls } = chain({
        listTemplateKeys: () => rets(keys),
        getTemplateById: () => rets(NATIVE_V1),
      })
      const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
      if (!('templates' in r)) throw new Error('expected templates')
      expect(r.templates).toHaveLength(MAX_TEMPLATES)
      expect(r.total).toBe(MAX_TEMPLATES + 5)
      expect(r.omitted).toBe(5)
      // One list call plus one read per SHOWN template — not one per key the publisher has.
      expect(calls.filter((c) => c.method === 'getTemplateById')).toHaveLength(MAX_TEMPLATES)
    })

    it('omits an over-long key rather than truncating it, and counts it', async () => {
      // A shortened identifier still looks like a real one, and the caller passes these back.
      const long = 'k'.repeat(MAX_IDENTIFIER + 1)
      const { query } = chain({
        listTemplateKeys: () => rets(['native-v1', long]),
        getTemplateById: () => rets(NATIVE_V1),
      })
      const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
      if (!('templates' in r)) throw new Error('expected templates')
      expect(r.templates.map((t) => t.policyKey)).toEqual(['native-v1'])
      expect(r.omitted).toBe(1)
      expect(JSON.stringify(r)).not.toContain(long)
    })

    it('keeps a key of exactly MAX_IDENTIFIER characters', async () => {
      const edge = 'k'.repeat(MAX_IDENTIFIER)
      const { query } = chain({ listTemplateKeys: () => rets([edge]), getTemplateById: () => rets(NATIVE_V1) })
      const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
      if (!('templates' in r)) throw new Error('expected templates')
      expect(r.templates.map((t) => t.policyKey)).toEqual([edge])
      expect(r.omitted).toBeUndefined()
    })

    it('bounds the declared attributes per template and counts the omissions', async () => {
      // The over-long name goes FIRST. Put last, it sat beyond the MAX_DECLARED cut and was dropped by
      // the slice whether or not the length filter existed, so removing the filter survived. First, it
      // would appear in the output unless the filter is what removes it.
      const longName = 'x'.repeat(MAX_IDENTIFIER + 1)
      const many = {
        found: true,
        attributes: [
          { attributeName: longName, attributeType: 'STRING' },
          ...Array.from({ length: MAX_DECLARED + 10 }, (_, i) => ({ attributeName: `a${i}`, attributeType: 'STRING' })),
        ],
      }
      const { query } = chain({ listTemplateKeys: () => rets(['big']), getTemplateById: () => rets(many) })
      const r = await discoverTemplates(PUBLISHER, TEMPLATE, query)
      if (!('templates' in r)) throw new Error('expected templates')
      expect(r.templates[0].declared).toHaveLength(MAX_DECLARED)
      expect(r.templates[0].declaredOmitted).toBe(11)
      // Omitted, not truncated: the over-long name appears nowhere, in any form.
      expect(JSON.stringify(r.templates[0].declared)).not.toContain('x'.repeat(10))
      expect(r.templates[0].declared!.map((x) => x.name)).toContain('a0')
    })
  })
})

describe('confirmTemplateId', () => {
  it('returns the id only when the chain finds it', async () => {
    const { query } = realPublisher()
    expect(await confirmTemplateId(PUBLISHER, 'native-v1', TEMPLATE, query)).toEqual({ templateId: NATIVE_ID, confirmed: true })
  })

  it('withholds an id the chain does not know', async () => {
    const { query } = chain({ getTemplateById: () => rets({ found: false }) })
    const r = await confirmTemplateId(PUBLISHER, 'native-v1', TEMPLATE, query)
    expect(r.confirmed).toBe(false)
    expect(r.templateId).toBeUndefined()
  })

  it('cannot confirm without a Template contract, and says so', async () => {
    const { query, calls } = realPublisher()
    const r = await confirmTemplateId(PUBLISHER, 'native-v1', undefined, query)
    expect(r.confirmed).toBe(false)
    expect(r.reason).toMatch(/no Template contract/i)
    expect(calls).toHaveLength(0)
  })
})

type Handlers = Record<string, (input?: unknown) => Promise<Record<string, unknown>>>
const tools = (config: Record<string, unknown>, chainQuery: unknown) =>
  createTools({
    config: {
      holderDid: 'did:zid:test',
      zetrixAddress: '',
      network: 'zetrix:testnet',
      policyRegistryAddress: REGISTRY,
      policyTemplateAddress: TEMPLATE,
      policyTemplatePublisher: PUBLISHER,
      ...config,
    },
    chainQuery,
  } as never) as never as Handlers

describe('"show me the policy template" on a wallet with nothing deployed', () => {
  it('lists the templates with no follow-up question needed', async () => {
    // The exact prompt that dead-ended. No publisher, no key, no id, no deployed policy.
    const { query } = realPublisher()
    const r = await tools({}, query).get_policy_template_schema({})
    expect(r.found).toBe(true)
    expect(r.publisher).toBe(PUBLISHER)
    expect(r.publisherSource).toBe('default')
    const listed = r.templates as Array<{ policyKey: string; templateId: string; templateIdConfirmed: boolean }>
    expect(listed.map((t) => [t.policyKey, t.templateId, t.templateIdConfirmed])).toEqual([
      ['native-v1', NATIVE_ID, true],
      ['ztp20-v1', ZTP20_ID, true],
    ])
  })

  it('works when called with no argument object at all', async () => {
    const { query } = realPublisher()
    const r = await tools({}, query).get_policy_template_schema()
    expect(r.found).toBe(true)
  })

  it('lists a DIFFERENT publisher when one is named, and says it was supplied', async () => {
    const { query, calls } = realPublisher()
    const r = await tools({}, query).get_policy_template_schema({ publisher: 'ZTX3Someone' + 'x'.repeat(24) })
    expect(r.publisherSource).toBe('supplied')
    expect(calls.find((c) => c.method === 'listTemplateKeys')!.params.publisher).toBe('ZTX3Someone' + 'x'.repeat(24))
  })

  it('reads ONE template of the default publisher from a bare key, with its confirmed id', async () => {
    const { query, calls } = realPublisher()
    const r = await tools({}, query).get_policy_template_schema({ policyKey: 'native-v1' })
    expect(r.found).toBe(true)
    expect(r.templateId).toBe(NATIVE_ID)
    expect(r.templateIdConfirmed).toBe(true)
    expect(r.publisherSource).toBe('default')
    expect(calls.find((c) => c.method === 'getTemplate')!.params).toEqual({ publisher: PUBLISHER, policyKey: 'native-v1' })
  })

  it('does not hand over an id the chain does not confirm on the single-template route', async () => {
    const { query } = chain({
      getTemplate: () => rets(NATIVE_V1),
      getTemplateById: () => rets({ found: false }),
    })
    const r = await tools({}, query).get_policy_template_schema({ policyKey: 'native-v1' })
    expect(r.found).toBe(true)
    expect(r.templateIdConfirmed).toBe(false)
    expect('templateId' in r).toBe(false)
    expect(String(r.templateIdNote)).toMatch(/did not resolve/i)
  })

  it('leaves the explicit templateId route alone', async () => {
    const { query, calls } = realPublisher()
    const r = await tools({}, query).get_policy_template_schema({ templateId: NATIVE_ID })
    expect(r.found).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['getTemplateById'])
    // No listing and no derived id: the caller already named the one it wanted.
    expect('templates' in r).toBe(false)
    expect('templateIdConfirmed' in r).toBe(false)
  })

  it('reports a failed listing as an error, never as "no templates"', async () => {
    const failing = vi.fn(async () => { throw new Error('ECONNRESET') })
    const r = await tools({}, failing).get_policy_template_schema({})
    expect('error' in r).toBe(true)
    expect(r.found).toBeUndefined()
  })

  it('reports a publisher with no templates as found:false', async () => {
    const { query } = chain({ listTemplateKeys: () => rets([]) })
    const r = await tools({}, query).get_policy_template_schema({})
    expect(r).toMatchObject({ found: false, publisher: PUBLISHER })
  })
})

describe('no default is applied where there is none', () => {
  it('says so and what to pass, instead of asking for an address the user cannot know', async () => {
    const { query, calls } = realPublisher()
    const r = await tools({ policyTemplatePublisher: undefined }, query).get_policy_template_schema({})
    expect(String(r.error)).toMatch(/No template publisher is configured/i)
    expect(String(r.error)).toMatch(/\{ publisher \}/)
    expect(calls).toHaveLength(0)
  })

  it('still lists when the caller supplies the publisher themselves', async () => {
    const { query } = realPublisher()
    const r = await tools({ policyTemplatePublisher: undefined }, query).get_policy_template_schema({ publisher: PUBLISHER })
    expect(r.found).toBe(true)
  })

  it('refuses to list without a Template contract', async () => {
    const { query } = realPublisher()
    const r = await tools({ policyTemplateAddress: undefined }, query).get_policy_template_schema({})
    expect(String(r.error)).toMatch(/needs the policy template contract/i)
  })

  it('has no default publisher off testnet, and an override wins on testnet', () => {
    expect(derivePolicyTemplatePublisher('zetrix:testnet')).toBe(PUBLISHER)
    expect(derivePolicyTemplatePublisher('zetrix:mainnet')).toBeUndefined()
    const base = { HSM_PASSWORD: 'x', WALLET_BE_URL: 'https://be.test', ZETRIX_NODE_HOST: 'n.test' }
    expect(loadConfig({ ...base }).policyTemplatePublisher).toBe(PUBLISHER)
    expect(loadConfig({ ...base, POLICY_TEMPLATE_PUBLISHER: 'ZTX3Override' }).policyTemplatePublisher).toBe('ZTX3Override')
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' }).policyTemplatePublisher).toBeUndefined()
  })
})

describe('the config reaches the handlers', () => {
  it('carries every policy field through buildToolConfig, each with a distinct value', () => {
    // main() used to copy these one at a time into an inline object — which is where a new field
    // goes missing: it typechecks, every test that builds its own deps passes, and production reads
    // undefined. Distinct sentinels so a swap is caught as well as an omission.
    const built = buildToolConfig(
      {
        network: 'zetrix:testnet',
        policyRegistryAddress: 'REGISTRY-SENTINEL',
        policyTemplateAddress: 'TEMPLATE-SENTINEL',
        policyTemplatePublisher: 'PUBLISHER-SENTINEL',
        aiBirthcertVerifiedTemplateId: 'VERIFIED-TEMPLATE-SENTINEL',
      },
      'did:zid:holder',
      'ZTX3owner',
    )
    expect(built).toEqual({
      holderDid: 'did:zid:holder',
      zetrixAddress: 'ZTX3owner',
      network: 'zetrix:testnet',
      policyRegistryAddress: 'REGISTRY-SENTINEL',
      policyTemplateAddress: 'TEMPLATE-SENTINEL',
      policyTemplatePublisher: 'PUBLISHER-SENTINEL',
      aiBirthcertVerifiedTemplateId: 'VERIFIED-TEMPLATE-SENTINEL',
    })
  })
})

describe('policy_preflight with no template identifier', () => {
  it('points the agent at the listing instead of leaving it stuck', async () => {
    const { query } = realPublisher()
    const r = await tools({}, query).policy_preflight({
      policyKey: 'default-spend',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }],
      validFromBlock: '0',
      validToBlock: '0',
    } as never)
    const blockers = (r as unknown as { blockers: string[] }).blockers.join(' ')
    expect(blockers).toMatch(/get_policy_template_schema with no arguments/i)
  })
})

describe('what the agent is told', () => {
  const tool = (name: string) => buildToolList().find((t) => t.name === name)!

  it('tells it to START HERE, with no arguments, and not to ask the user for addresses', () => {
    const d = tool('get_policy_template_schema').description
    expect(d).toMatch(/START HERE/)
    expect(d).toMatch(/called with NO arguments it lists the templates/i)
    expect(d).toMatch(/Do not ask the user for a publisher/i)
    // The qualification: asking IS right where no default exists, and the agent should know when.
    expect(d).toMatch(/Only if a result says no default publisher is configured should you ask/i)
  })

  it('no longer describes templateId as something found inside a deployed policy', () => {
    // That description was the circular dead end: a first-time user has no deployed policy, and
    // the only way to get one is write_policy, which needs a templateId.
    const id = tool('get_policy_template_schema').inputSchema.properties.templateId!.description
    expect(id).not.toMatch(/deployed policy/i)
    expect(id).toMatch(/lists templates/i)
  })

  it('makes templateContractAddress optional on write_policy and says to leave it out', () => {
    const t = tool('write_policy')
    expect(t.inputSchema.required).toEqual(['policyKey', 'attributes', 'templateId'])
    expect(t.inputSchema.properties.templateContractAddress!.description).toMatch(/Leave this out/i)
  })

  it('points write_policy at the listing for a templateId, and forbids inventing one', () => {
    const d = tool('write_policy').description
    expect(d).toMatch(/call get_policy_template_schema with no arguments/i)
    expect(d).toMatch(/Never invent one/i)
    expect(tool('write_policy').inputSchema.properties.templateId!.description).toMatch(/Take it from get_policy_template_schema/i)
  })

  it('does not contradict itself across the two tools about asking the user', () => {
    // write_policy used to say "never ask the user for a publisher", an absolute that the other
    // tool qualifies. The agent reads both.
    expect(tool('write_policy').description).not.toMatch(/never ask the user for a publisher/i)
    expect(tool('write_policy').description).toMatch(/never the user's to supply/i)
  })
})
