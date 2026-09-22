/**
 * Handler-level tests for the three policy MCP tools.
 *
 * These exist because their absence was the root cause of both CRITICAL review findings in review
 * (APP-M02). Everything BENEATH the handlers — policy-read-client, policy-preflight — was heavily
 * covered, which is exactly why nobody noticed that the handler layer dropped the `notChecked`
 * invariant on mainnet (APP-C02) and made an explicit `templateId` unreachable (APP-M04).
 *
 * The handlers are thin, but thin is where routing and gating live, and neither is exercised by
 * `tool-registration.test.ts`, which only reads schema and description text.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTools } from '../mcp-tools'

type Handlers = Record<string, (input?: unknown) => Promise<Record<string, unknown>>>

const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const OWNER = 'ZTX3YzAyKBxjbSaMPeaPKEBpV93wjzN4SjTaN'

const TEMPLATE_BODY = {
  found: true,
  attributes: [{ attributeName: 'x402', attributeType: 'uint' }],
  templateAttributeIds: ['a1', 'a2'],
}

/** One query_rets entry per contract hop, in hop order. */
function rets(...values: string[]) {
  return { errorCode: 0, result: { query_rets: values.map((value) => ({ result: { value } })) } }
}

/** Build the tool record with only what the policy handlers actually use. */
function tools(
  config: Partial<{ network: string; zetrixAddress: string; policyRegistryAddress: string; policyTemplateAddress: string }>,
  chainQuery: unknown = vi.fn().mockResolvedValue(rets('{"found":false}')),
) {
  const deps = {
    config: { holderDid: 'did:zid:test', zetrixAddress: '', network: 'zetrix:testnet', ...config },
    chainQuery,
  } as never
  return createTools(deps) as never as Handlers
}

const TESTNET = { policyRegistryAddress: REGISTRY, policyTemplateAddress: TEMPLATE, zetrixAddress: OWNER }
const MAINNET = { network: 'zetrix:mainnet' }

const draft = {
  policyKey: 'spend-limits',
  attributes: [{ attributeName: 'x402', attributeType: 'uint', value: '1000000' }],
  validFromBlock: '0',
  validToBlock: '0',
}

describe('policy_preflight handler', () => {
  it('returns a FULL result with notChecked when no contracts are configured', async () => {
    // APP-C02. The design states twice that notChecked appears on every result, so a clean
    // preflight is never read as permission to spend — and mainnet, where nothing is deployed, is
    // where that warning matters most. This used to return a bare {error}.
    const result = await tools(MAINNET).policy_preflight(draft)
    expect(result.ready).toBe(false)
    expect(Array.isArray(result.notChecked)).toBe(true)
    expect((result.notChecked as string[]).length).toBeGreaterThan(0)
    expect((result.notChecked as string[]).join(' ')).toMatch(/ALLOW/)
    expect(Array.isArray(result.blockers)).toBe(true)
    expect(Array.isArray(result.interpretation)).toBe(true)
    expect(result.policyKey).toBe('spend-limits')
  })

  it('says on mainnet that nothing is deployed there', async () => {
    const result = await tools(MAINNET).policy_preflight(draft)
    expect((result.notChecked as string[]).join(' ')).toMatch(/mainnet|not deployed/i)
  })

  it('keeps a usable shape even when the draft is malformed and nothing is configured', async () => {
    const result = await tools(MAINNET).policy_preflight({} as never)
    expect(result.ready).toBe(false)
    expect(Array.isArray(result.notChecked)).toBe(true)
    expect(result.policyKey).toBe('')
  })

  it('prefers an explicit templateId over publisher + policyKey', async () => {
    // APP-M04. draft.policyKey is the key this policy would be STORED under, which is not
    // necessarily the template's key — preferring the pair made templateId unreachable.
    const chainQuery = vi.fn().mockResolvedValue(rets(JSON.stringify(TEMPLATE_BODY)))
    await tools(TESTNET, chainQuery).policy_preflight({
      ...draft,
      publisher: OWNER,
      templateId: 'b'.repeat(64),
    })
    expect(chainQuery).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(chainQuery.mock.calls[0][0].input)
    expect(sent.method).toBe('getTemplateById')
    expect(sent.params.templateId).toBe('b'.repeat(64))
  })

  it('falls back to the Registry pair when no templateId is given', async () => {
    const chainQuery = vi.fn().mockResolvedValue(rets(JSON.stringify(TEMPLATE_BODY)))
    await tools(TESTNET, chainQuery).policy_preflight({ ...draft, publisher: OWNER })
    const sent = JSON.parse(chainQuery.mock.calls[0][0].input)
    expect(sent.method).toBe('getTemplate')
    expect(sent.params).toEqual({ publisher: OWNER, policyKey: 'spend-limits' })
  })

  it('blocks, rather than throws, when neither identifier is supplied', async () => {
    const result = await tools(TESTNET).policy_preflight(draft)
    expect(result.ready).toBe(false)
    expect((result.blockers as string[]).join(' ')).toMatch(/templateId|identifier/i)
  })

  it('does not throw on malformed input reaching the handler', async () => {
    // The MCP SDK does not enforce inputSchema at runtime, so this is reachable from an agent.
    for (const bad of [{}, { policyKey: 'k' }, { policyKey: 'k', attributes: 'nope' }]) {
      const result = await tools(TESTNET).policy_preflight(bad as never)
      expect(result.ready).toBe(false)
      expect((result.blockers as string[]).length).toBeGreaterThan(0)
    }
  })
})

describe('get_policy_template_schema handler', () => {
  it('reports the network when no contracts are configured', async () => {
    const result = await tools(MAINNET).get_policy_template_schema({ templateId: 'a'.repeat(64) })
    expect(String(result.error)).toMatch(/not deployed/i)
  })

  it('asks for an identifier when given none', async () => {
    const result = await tools(TESTNET).get_policy_template_schema({})
    expect(String(result.error)).toMatch(/publisher.*policyKey|templateId/i)
  })

  it('does not tell a caller to supply what they already supplied', async () => {
    // APP-L01. With a pair given but no registry configured, the old message asked for the pair.
    const result = await tools({ policyTemplateAddress: TEMPLATE }).get_policy_template_schema({
      publisher: OWNER,
      policyKey: 'x402',
    })
    expect(String(result.error)).toMatch(/registry/i)
    expect(String(result.error)).not.toMatch(/Provide either/i)
  })

  it('surfaces templateAttributeIds from the Registry route', async () => {
    // APP-M06. The design's stated reason to prefer this route is that it returns these; the
    // handler used to drop them before any caller could see them.
    const chainQuery = vi.fn().mockResolvedValue(rets(JSON.stringify(TEMPLATE_BODY)))
    const result = await tools(TESTNET, chainQuery).get_policy_template_schema({
      publisher: OWNER,
      policyKey: 'x402',
    })
    expect(result.found).toBe(true)
    expect(result.templateAttributeIds).toEqual(['a1', 'a2'])
    expect(result.declared).toEqual([{ name: 'x402', type: 'uint' }])
  })

  it('omits templateAttributeIds on the id-only route, which does not return them', async () => {
    const body = JSON.stringify({ found: true, attributes: TEMPLATE_BODY.attributes })
    const chainQuery = vi.fn().mockResolvedValue(rets(body))
    const result = await tools(TESTNET, chainQuery).get_policy_template_schema({ templateId: 'a'.repeat(64) })
    expect(result.found).toBe(true)
    expect('templateAttributeIds' in result).toBe(false)
  })

  it('keeps a failed read distinct from a missing template', async () => {
    const failed = await tools(TESTNET, vi.fn().mockResolvedValue({ errorCode: 151 })).get_policy_template_schema({
      templateId: 'a'.repeat(64),
    })
    expect(failed.error).toBeDefined()
    expect('found' in failed).toBe(false)

    const missing = await tools(TESTNET).get_policy_template_schema({ templateId: 'a'.repeat(64) })
    expect(missing).toEqual({ found: false })
  })
})

describe('get_my_policy handler', () => {
  it('reports the network when the registry is not configured', async () => {
    const result = await tools(MAINNET).get_my_policy({})
    expect(String(result.error)).toMatch(/not deployed/i)
  })

  it('defaults to the wallet own address', async () => {
    const chainQuery = vi.fn().mockResolvedValue(rets('{"found":false}'))
    await tools(TESTNET, chainQuery).get_my_policy({})
    expect(JSON.parse(chainQuery.mock.calls[0][0].input).params.owner).toBe(OWNER)
  })

  it('prefers an explicitly passed owner', async () => {
    const chainQuery = vi.fn().mockResolvedValue(rets('{"found":false}'))
    await tools(TESTNET, chainQuery).get_my_policy({ owner: 'ZTX3Other' })
    expect(JSON.parse(chainQuery.mock.calls[0][0].input).params.owner).toBe('ZTX3Other')
  })

  it('refuses when there is no owner anywhere, without calling the chain', async () => {
    const chainQuery = vi.fn()
    const result = await tools({ policyRegistryAddress: REGISTRY }, chainQuery).get_my_policy({})
    expect(chainQuery).not.toHaveBeenCalled()
    expect(String(result.error)).toMatch(/owner/i)
  })

  it('reports an owner with no policy contract as a clean absence', async () => {
    const result = await tools(TESTNET).get_my_policy({})
    expect(result.contract).toEqual({ found: false })
    expect(result.policies).toEqual([])
  })
})
