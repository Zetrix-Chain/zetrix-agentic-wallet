/**
 * The wiring around update_policy / remove_policy: how one policy is read, what get_my_policy hands back for an
 * update, how the tools reach the orchestrator, and the write_policy requestKey that used to overflow its column.
 */
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createTools } from '../mcp-tools'
import { buildPolicyWriteDeps } from '../index'
import { readOwnerPolicy } from '../clients/policy-read-client'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import { writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const REGISTRY = 'ZTX3Registry0000000000000000000000000'
const POLICY_CONTRACT = 'ZTX3PolicyContract0000000000000000000'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'

/** A chain that answers by method, the way the contract query seam does. */
const chain = (answers: Record<string, unknown>, seen: Array<{ contractAddress: string; method: string; params: unknown }> = []) =>
  (async ({ contractAddress, input }: { contractAddress: string; input: string }) => {
    const { method, params } = JSON.parse(input)
    seen.push({ contractAddress, method, params })
    if (!(method in answers)) return { errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify({ found: false }) } }] } }
    const answer = answers[method]
    if (answer instanceof Error) throw answer
    return { errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify(answer) } }] } }
  }) as never

const POLICY = {
  attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100000000' }],
  validFromBlock: '10',
  validToBlock: '99',
  updatedAtBlock: 12345,
  templateContractAddress: TEMPLATE,
  templateId: 'a'.repeat(64),
}

describe('readOwnerPolicy', () => {
  it('resolves the owner\'s policy contract through the registry, then reads the one policy by key', async () => {
    const seen: Array<{ contractAddress: string; method: string; params: unknown }> = []
    const query = chain({ getPolicyContract: { found: true, address: POLICY_CONTRACT }, getPolicy: { found: true, policy: POLICY } }, seen)

    const r = await readOwnerPolicy(OWNER, REGISTRY, 'native-v1', query)

    expect(r).toMatchObject({ found: true, value: { policy: { updatedAtBlock: 12345 } } })
    expect(seen.map((s) => [s.contractAddress, s.method])).toEqual([[REGISTRY, 'getPolicyContract'], [POLICY_CONTRACT, 'getPolicy']])
    expect(seen[1].params).toEqual({ policyKey: 'native-v1' })
  })

  it('answers found:false for an owner who has never deployed a policy, without a second read', async () => {
    const seen: Array<{ contractAddress: string; method: string; params: unknown }> = []

    const r = await readOwnerPolicy(OWNER, REGISTRY, 'native-v1', chain({ getPolicyContract: { found: false } }, seen))

    expect(r).toEqual({ found: false })
    expect(seen).toHaveLength(1)
  })

  it('answers found:false for a key that is not there', async () => {
    const r = await readOwnerPolicy(OWNER, REGISTRY, 'nope', chain({ getPolicyContract: { found: true, address: POLICY_CONTRACT }, getPolicy: { found: false } }))

    expect(r).toEqual({ found: false })
  })

  it('reports a failed read as an error, never as "no policy"', async () => {
    const r = await readOwnerPolicy(OWNER, REGISTRY, 'native-v1', chain({ getPolicyContract: new Error('node down') }))

    expect(r).toMatchObject({ error: 'query_failed' })
  })
})

describe('buildPolicyWriteDeps wires a way to read a policy', () => {
  const build = (extra: Record<string, unknown>, chainQuery = chain({})) =>
    buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE,
      chainQuery,
      queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
      caps: undefined,
      ...extra,
    } as never).policyWriteDeps!

  it('reads the OWNER\'s policy through the configured registry', async () => {
    const seen: Array<{ contractAddress: string; method: string; params: unknown }> = []
    const deps = build(
      { policyRegistryAddress: REGISTRY },
      chain({ getPolicyContract: { found: true, address: POLICY_CONTRACT }, getPolicy: { found: true, policy: POLICY } }, seen),
    )

    const r = await deps.readPolicy!('native-v1')

    expect(r).toMatchObject({ found: true })
    expect(seen[0]).toMatchObject({ contractAddress: REGISTRY, method: 'getPolicyContract', params: { owner: OWNER } })
  })

  it('has none where no registry is deployed, so an update refuses instead of paying blind', async () => {
    expect(build({}).readPolicy).toBeUndefined()
  })
})

describe('get_my_policy says what an update needs', () => {
  it('hands back updatedAtBlock as the STRING the service wants, under forUpdate, with how to use it', async () => {
    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: OWNER, network: 'zetrix:testnet', policyRegistryAddress: REGISTRY },
      chainQuery: chain({
        getPolicyContract: { found: true, address: POLICY_CONTRACT },
        listPolicyKeys: ['native-v1'],
        getPolicy: { found: true, policy: POLICY },
      }),
    } as never)

    const r = (await tools.get_my_policy()) as { policies: Array<{ policyKey: string; forUpdate?: { expectedUpdatedAtBlock: string; note: string } }> }

    expect(r.policies[0].forUpdate?.expectedUpdatedAtBlock).toBe('12345')
    expect(typeof r.policies[0].forUpdate?.expectedUpdatedAtBlock).toBe('string')
    expect(r.policies[0].forUpdate?.note).toMatch(/update_policy/)
    expect(r.policies[0].forUpdate?.note).toMatch(/expectedUpdatedAtBlock/)
  })

  it('has no forUpdate for a policy that could not be read, rather than a guessed block', async () => {
    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: OWNER, network: 'zetrix:testnet', policyRegistryAddress: REGISTRY },
      chainQuery: chain({ getPolicyContract: { found: true, address: POLICY_CONTRACT }, listPolicyKeys: ['k'], getPolicy: new Error('boom') }),
    } as never)

    const r = (await tools.get_my_policy()) as { policies: Array<{ forUpdate?: unknown }> }

    expect(r.policies[0].forUpdate).toBeUndefined()
  })

  it('has no forUpdate when the chain gave no updatedAtBlock', async () => {
    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: OWNER, network: 'zetrix:testnet', policyRegistryAddress: REGISTRY },
      chainQuery: chain({
        getPolicyContract: { found: true, address: POLICY_CONTRACT },
        listPolicyKeys: ['k'],
        getPolicy: { found: true, policy: { ...POLICY, updatedAtBlock: undefined } },
      }),
    } as never)

    const r = (await tools.get_my_policy()) as { policies: Array<{ forUpdate?: unknown }> }

    expect(r.policies[0].forUpdate).toBeUndefined()
  })
})

describe('the tools reach the orchestrator', () => {
  const failing: HttpSend = async () => {
    throw new Error('should not be reached')
  }
  const writeDeps = (over: Partial<WritePolicyDeps> = {}): WritePolicyDeps => ({
    client: new PolicyWriteClient('https://ms.test/api', failing),
    receipts: { get: async () => null, set: async () => undefined, list: async () => [], remove: async () => undefined, filePathFor: () => '/x' },
    pay: async () => 'h',
    chooseAccept: (a) => a[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    templateContract: TEMPLATE,
    preflight: async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [] }),
    readPolicy: async () => ({ found: false as const }),
    ...over,
  })
  const toolsWith = (policyWriteDeps?: WritePolicyDeps) =>
    createTools({ config: { holderDid: 'did:zid:h', zetrixAddress: OWNER, network: 'zetrix:testnet' }, policyWriteDeps } as never)

  it('update_policy runs the update flow and answers not_found, free, for a policy that is not there', async () => {
    const r = await toolsWith(writeDeps()).update_policy({
      policyKey: 'nope',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '1' }],
      expectedUpdatedAtBlock: '1',
      confirm: true,
    })

    expect(r.state).toBe('not_found')
    expect(r.message).toMatch(/Nothing was paid/)
  })

  it('remove_policy stops for a yes and sends nothing', async () => {
    const r = await toolsWith(writeDeps({ readPolicy: async () => ({ found: true as const, value: { policy: POLICY } }) })).remove_policy({ policyKey: 'native-v1' })

    expect(r.state).toBe('needs_confirmation')
  })

  it.each([
    ['update_policy', (t: ReturnType<typeof toolsWith>) => t.update_policy({ policyKey: 'k', attributes: [], expectedUpdatedAtBlock: '1' }), /Nothing was paid/],
    ['remove_policy', (t: ReturnType<typeof toolsWith>) => t.remove_policy({ policyKey: 'k', confirm: true }), /Nothing was removed/],
  ])('%s says it is unavailable, and that nothing happened, when no policy write service is wired', async (_name, call, nothing) => {
    const r = await call(toolsWith(undefined))

    expect(r.state).toBe('unavailable')
    expect(r.message).toMatch(nothing)
  })
})

describe('write_policy requestKey', () => {
  const challenge = { x402Version: 1, accepts: [{ scheme: 'exact', asset: 'A', maxAmountRequired: '1' }] }
  const run = async (input: Record<string, unknown>) => {
    const bodies: string[] = []
    const send: HttpSend = async (_url, init) => {
      bodies.push(init.body)
      return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify(challenge) }
    }
    const d: WritePolicyDeps = {
      client: new PolicyWriteClient('https://ms.test/api', send),
      receipts: { get: async () => null, set: async () => undefined, list: async () => [], remove: async () => undefined, filePathFor: () => '/x' },
      pay: vi.fn(async () => 'h'),
      chooseAccept: (a) => a[0],
      hsmPassword: 'p',
      ownerAddress: OWNER,
      network: 'zetrix:testnet',
      sleep: async () => undefined,
      templateContract: TEMPLATE,
      preflight: async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [] }),
      now: () => new Date('2026-10-07T00:00:00.000Z'),
    }
    await writePolicy(d, {
      policyKey: 'native-v1',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '1' }],
      templateId: 'a'.repeat(64),
      templateContractAddress: TEMPLATE,
      dryRun: true,
      ...input,
    } as never)
    return JSON.parse(bodies[0]) as { requestKey: string }
  }

  it('is a sha256 hex string, which fits the service\'s 128-character column whatever the policy key', async () => {
    const short = await run({})
    const long = await run({ policyKey: 'k'.repeat(300) })

    expect(short.requestKey).toMatch(/^[0-9a-f]{64}$/)
    expect(long.requestKey).toMatch(/^[0-9a-f]{64}$/)
    expect(long.requestKey.length).toBeLessThanOrEqual(128)
  })

  it('is derived from the owner, the policy key and the time, so two different policies never share one', async () => {
    const a = await run({ policyKey: 'a' })
    const b = await run({ policyKey: 'b' })

    expect(a.requestKey).not.toBe(b.requestKey)
    expect(a.requestKey).toBe(createHash('sha256').update(`${OWNER}-a-2026-10-07T00:00:00.000Z`).digest('hex'))
  })

  it('leaves a key the caller supplied exactly as it is', async () => {
    expect((await run({ requestKey: 'my-own-key' })).requestKey).toBe('my-own-key')
  })
})
