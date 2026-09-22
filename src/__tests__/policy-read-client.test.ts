import { describe, it, expect, vi } from 'vitest'
import {
  declaredVocabulary,
  getPolicyContract,
  getTemplateById,
  getTemplateViaRegistry,
  queryPolicy,
  readOwnerPolicies,
} from '../clients/policy-read-client'

const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'
const OWNER = 'ZTX3YzAyKBxjbSaMPeaPKEBpV93wjzN4SjTaN'

/** One query_rets entry per contract hop, in hop order. */
function rets(...values: string[]) {
  return { errorCode: 0, result: { query_rets: values.map((value) => ({ result: { value } })) } }
}

describe('queryPolicy', () => {
  it('reads the LAST query_rets entry, not the first', async () => {
    // A proxied Registry call returns one entry per contract hop, the Registry's own answer last.
    // The two entries below DIFFER deliberately: an implementation reading [0] fails this test.
    const query = vi.fn().mockResolvedValue(rets('{"found":false}', '{"found":true,"address":"ZTX3Policy"}'))
    const result = await queryPolicy(REGISTRY, 'getPolicy', { owner: OWNER }, query)
    expect(result).toEqual({ ok: true, value: { found: true, address: 'ZTX3Policy' } })
  })

  it('reads the only entry when the call is not proxied', async () => {
    const query = vi.fn().mockResolvedValue(rets('{"found":true}'))
    expect(await queryPolicy(REGISTRY, 'getPolicy', {}, query)).toEqual({ ok: true, value: { found: true } })
  })

  it('reports a transport failure rather than throwing', async () => {
    const query = vi.fn().mockRejectedValue(new Error('socket hang up'))
    const result = await queryPolicy(REGISTRY, 'getPolicy', {}, query)
    expect(result).toEqual({ ok: false, detail: expect.stringContaining('socket hang up') })
  })

  it('reports a non-zero errorCode rather than returning a value', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151 })
    expect(await queryPolicy(REGISTRY, 'getPolicy', {}, query)).toMatchObject({ ok: false })
  })

  it('reports an empty or absent query_rets rather than returning undefined', async () => {
    expect(await queryPolicy(REGISTRY, 'getPolicy', {}, vi.fn().mockResolvedValue(rets()))).toMatchObject({
      ok: false,
    })
    expect(
      await queryPolicy(REGISTRY, 'getPolicy', {}, vi.fn().mockResolvedValue({ errorCode: 0, result: {} })),
    ).toMatchObject({ ok: false })
  })

  it('reports unparseable JSON rather than passing the raw string off as a value', async () => {
    const query = vi.fn().mockResolvedValue(rets('not json'))
    const result = await queryPolicy(REGISTRY, 'getPolicy', {}, query)
    expect(result).toMatchObject({ ok: false })
    expect((result as { detail: string }).detail).toContain('not json')
  })

  it('sends the method and params in the envelope the contracts expect', async () => {
    const query = vi.fn().mockResolvedValue(rets('{}'))
    await queryPolicy(REGISTRY, 'getPolicy', { policyKey: 'spend-limits' }, query)
    expect(query).toHaveBeenCalledWith({
      contractAddress: REGISTRY,
      input: JSON.stringify({ method: 'getPolicy', params: { policyKey: 'spend-limits' } }),
      optType: 2,
    })
  })
})

describe('getPolicyContract', () => {
  it('refuses an empty owner BEFORE issuing any call', async () => {
    // An absent owner makes the contract miss its storage key and answer {found:false} with
    // errorCode 0 — byte-identical to a user who genuinely has no policy. Guarding here is what
    // keeps the three-state result honest.
    const query = vi.fn()
    const result = await getPolicyContract('  ', REGISTRY, query)
    expect(query).not.toHaveBeenCalled()
    expect(result).toMatchObject({ error: 'query_failed' })
    expect('found' in result).toBe(false)
  })

  it('explains WHY an empty owner is refused, rather than just rejecting it', async () => {
    const result = await getPolicyContract('', REGISTRY, vi.fn())
    expect((result as { detail: string }).detail).toMatch(/found:false|cannot be told apart/i)
  })

  it('distinguishes "no policy" from a failed read', async () => {
    const absent = await getPolicyContract(OWNER, REGISTRY, vi.fn().mockResolvedValue(rets('{"found":false}')))
    expect(absent).toEqual({ found: false })

    const broken = await getPolicyContract(OWNER, REGISTRY, vi.fn().mockResolvedValue({ errorCode: 151 }))
    expect(broken).toMatchObject({ error: 'query_failed' })

    // The two must not be confusable in either direction.
    expect('error' in absent).toBe(false)
    expect('found' in broken).toBe(false)
  })

  it('returns the policy contract address when one is registered', async () => {
    const query = vi.fn().mockResolvedValue(rets('{"found":true,"address":"ZTX3PolicyOfOwner"}'))
    expect(await getPolicyContract(OWNER, REGISTRY, query)).toEqual({ found: true, value: 'ZTX3PolicyOfOwner' })
  })

  it('treats found:true without a usable address as a failed read, not a hit', async () => {
    // Reporting this as {found:true, value:''} would hand the caller an address it would then
    // query, turning one malformed reply into a second, more confusing failure.
    const query = vi.fn().mockResolvedValue(rets('{"found":true}'))
    expect(await getPolicyContract(OWNER, REGISTRY, query)).toMatchObject({ error: 'query_failed' })
    expect(await getPolicyContract(OWNER, REGISTRY, vi.fn().mockResolvedValue(rets('{"found":true,"address":""}')))).toMatchObject({
      error: 'query_failed',
    })
  })

  it('treats a null reply as no policy rather than crashing on it', async () => {
    const query = vi.fn().mockResolvedValue(rets('null'))
    expect(await getPolicyContract(OWNER, REGISTRY, query)).toEqual({ found: false })
  })
})

const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const PUBLISHER = 'ZTX3YzAyKBxjbSaMPeaPKEBpV93wjzN4SjTaN'

const TEMPLATE_BODY = {
  found: true,
  attributes: [
    { attributeName: 'x402', attributeType: 'uint' },
    { attributeName: 'maxTransactionCount', attributeType: 'uint' },
  ],
  templateAttributeIds: ['a1', 'a2'],
}

describe('template reads', () => {
  it('reads publisher+policyKey through the Registry proxy, taking the final entry', async () => {
    // Two hops: the Template contract answers first, the Registry last. The bodies DIFFER,
    // so an implementation reading [0] fails — identical bodies would pass either way and pin
    // nothing at all (APP-L03).
    const inner = JSON.stringify({ ...TEMPLATE_BODY, attributes: [{ attributeName: 'innerOnly', attributeType: 'uint' }] })
    const query = vi.fn().mockResolvedValue(rets(inner, JSON.stringify(TEMPLATE_BODY)))
    const result = await getTemplateViaRegistry(PUBLISHER, 'x402', REGISTRY, query)
    expect(result).toMatchObject({ found: true })
    expect([...declaredVocabulary((result as Extract<typeof result, { found: true }>).value).keys()]).toEqual(['x402', 'maxTransactionCount'])
    expect(query.mock.calls[0][0].contractAddress).toBe(REGISTRY)
    expect(JSON.parse(query.mock.calls[0][0].input)).toEqual({
      method: 'getTemplate',
      params: { publisher: PUBLISHER, policyKey: 'x402' },
    })
  })

  it('reads templateId directly on the Template contract, since the Registry does not proxy it', async () => {
    const query = vi.fn().mockResolvedValue(rets(JSON.stringify(TEMPLATE_BODY)))
    await getTemplateById('a'.repeat(64), TEMPLATE, query)
    expect(query.mock.calls[0][0].contractAddress).toBe(TEMPLATE)
    expect(JSON.parse(query.mock.calls[0][0].input).method).toBe('getTemplateById')
  })

  it('keeps templateAttributeIds, which the id-only read omits', async () => {
    const query = vi.fn().mockResolvedValue(rets(JSON.stringify(TEMPLATE_BODY)))
    const result = await getTemplateViaRegistry(PUBLISHER, 'x402', REGISTRY, query)
    expect((result as { value: { templateAttributeIds?: string[] } }).value.templateAttributeIds).toEqual(['a1', 'a2'])
  })

  it('reports a missing template as found:false, and a failed read as an error', async () => {
    expect(await getTemplateById('x', TEMPLATE, vi.fn().mockResolvedValue(rets('{"found":false}')))).toEqual({
      found: false,
    })
    expect(await getTemplateById('x', TEMPLATE, vi.fn().mockResolvedValue({ errorCode: 151 }))).toMatchObject({
      error: 'query_failed',
    })
  })

  it('surfaces a Registry with no template contract as a read error, never as "no such template"', async () => {
    // The Registry ASSERTS in that case rather than answering found:false. It is a
    // misconfiguration, and telling the user their template does not exist would send them
    // chasing the wrong problem entirely.
    const query = vi.fn().mockResolvedValue({ errorCode: 151 })
    const result = await getTemplateViaRegistry(PUBLISHER, 'x402', REGISTRY, query)
    expect(result).toMatchObject({ error: 'query_failed' })
    expect('found' in result).toBe(false)
  })

  it('extracts attributeName -> attributeType as the declared vocabulary', () => {
    const vocab = declaredVocabulary(TEMPLATE_BODY as never)
    expect([...vocab.keys()]).toEqual(['x402', 'maxTransactionCount'])
    expect(vocab.get('x402')).toBe('uint')
  })

  it('returns an empty vocabulary for a template that declares nothing, rather than throwing', () => {
    expect(declaredVocabulary({} as never).size).toBe(0)
    expect(declaredVocabulary({ attributes: [] } as never).size).toBe(0)
  })

  it('skips malformed attribute entries instead of admitting a nameless attribute', () => {
    const vocab = declaredVocabulary({
      attributes: [{ attributeName: '' }, { attributeType: 'uint' }, { attributeName: 'x402', attributeType: 'uint' }],
    } as never)
    expect([...vocab.keys()]).toEqual(['x402'])
  })
})

describe('readOwnerPolicies', () => {
  const policyBody = (key: string) =>
    JSON.stringify({
      found: true,
      attributes: [{ attributeName: key, attributeType: 'uint', value: '5' }],
      validFromBlock: '0',
      validToBlock: '0',
      updatedAtBlock: 4248521,
    })

  it('walks Registry -> listPolicyKeys -> getPolicy per key', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(rets('{"found":true,"address":"ZTX3PolicyOfOwner"}'))
      .mockResolvedValueOnce(rets('["x402","maxTransactionCount"]'))
      .mockResolvedValueOnce(rets(policyBody('x402')))
      .mockResolvedValueOnce(rets(policyBody('maxTransactionCount')))

    const result = await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(result.contract).toEqual({ found: true, value: 'ZTX3PolicyOfOwner' })
    expect(result.policies.map((p) => p.policyKey)).toEqual(['x402', 'maxTransactionCount'])
    expect(query).toHaveBeenCalledTimes(4) // 2 + N
    expect(result.warning).toBeUndefined()
  })

  it('calls listPolicyKeys on the OWNER contract, not the Registry, which does not proxy it', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(rets('{"found":true,"address":"ZTX3PolicyOfOwner"}'))
      .mockResolvedValueOnce(rets('[]'))

    await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(query.mock.calls[0][0].contractAddress).toBe(REGISTRY)
    expect(query.mock.calls[1][0].contractAddress).toBe('ZTX3PolicyOfOwner')
  })

  it('reports an owner with no policy contract as a normal absence, not an error', async () => {
    // The Factory deploys the contract lazily on first write, so this is the expected state for
    // everyone who has not used the feature yet.
    const query = vi.fn().mockResolvedValue(rets('{"found":false}'))
    const result = await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(result.contract).toEqual({ found: false })
    expect(result.policies).toEqual([])
    expect(result.keys).toBeNull()
  })

  it('stops at the key listing when that read fails, rather than reporting zero policies', async () => {
    // "We could not list your policies" must never be presented as "you have none".
    const query = vi
      .fn()
      .mockResolvedValueOnce(rets('{"found":true,"address":"ZTX3PolicyOfOwner"}'))
      .mockResolvedValueOnce({ errorCode: 151 })

    const result = await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(result.keys).toMatchObject({ error: 'query_failed' })
    expect(result.policies).toEqual([])
  })

  it('refuses an empty owner without issuing a single call', async () => {
    const query = vi.fn()
    const result = await readOwnerPolicies('', REGISTRY, query)
    expect(query).not.toHaveBeenCalled()
    expect(result.contract).toMatchObject({ error: 'query_failed' })
  })

  it('keeps a per-key failure from hiding the keys that did read', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(rets('{"found":true,"address":"ZTX3P"}'))
      .mockResolvedValueOnce(rets('["good","bad"]'))
      .mockResolvedValueOnce(rets(policyBody('good')))
      .mockResolvedValueOnce({ errorCode: 151 })

    const result = await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(result.policies).toHaveLength(2)
    expect(result.policies[0].result).toMatchObject({ found: true })
    expect(result.policies[1].result).toMatchObject({ error: 'query_failed' })
  })

  it('warns above 50 keys', async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `k${i}`)
    const query = vi.fn().mockImplementation(({ input }: { input: string }) => {
      const { method } = JSON.parse(input)
      if (method === 'getPolicyContract') return Promise.resolve(rets('{"found":true,"address":"ZTX3P"}'))
      if (method === 'listPolicyKeys') return Promise.resolve(rets(JSON.stringify(keys)))
      return Promise.resolve(rets(policyBody('k')))
    })
    const result = await readOwnerPolicies(OWNER, REGISTRY, query)
    expect(result.warning).toContain('51')
    // The cost is what the warning is FOR — state it, do not merely say "a lot".
    expect(result.warning).toContain('53')
  })

  it('stays silent at the threshold itself', async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `k${i}`)
    const query = vi.fn().mockImplementation(({ input }: { input: string }) => {
      const { method } = JSON.parse(input)
      if (method === 'getPolicyContract') return Promise.resolve(rets('{"found":true,"address":"ZTX3P"}'))
      if (method === 'listPolicyKeys') return Promise.resolve(rets(JSON.stringify(keys)))
      return Promise.resolve(rets(policyBody('k')))
    })
    expect((await readOwnerPolicies(OWNER, REGISTRY, query)).warning).toBeUndefined()
  })

  it('rejects a listPolicyKeys reply that is not an array', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(rets('{"found":true,"address":"ZTX3P"}'))
      .mockResolvedValueOnce(rets('{"keys":["x402"]}'))

    expect((await readOwnerPolicies(OWNER, REGISTRY, query)).keys).toMatchObject({ error: 'query_failed' })
  })
})
