/**
 * Wiring: the registered tokens and the decimals reader must reach BOTH places a draft is
 * preflighted — the `policy_preflight` tool and the check `write_policy` runs before paying — from
 * ONE builder, so the two cannot give the user different answers about the same draft.
 *
 * Without these, deleting the spread at either call site leaves every unit test green: the
 * orchestrator tests supply their own deps, which is exactly how this class of wiring bug hides.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { buildPolicyWriteDeps, buildPreflightTokenDeps } from '../index'
import { createTools } from '../mcp-tools'
import { knownTokensFor } from '../config'
import { queryTokenBalance } from '../clients/token-balance-client'
import { ZTP20_V1 } from './fixtures/real-policy-templates'

const JMYR_TESTNET = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const JMYR_MAINNET = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'

const rets = (value: unknown) => ({
  errorCode: 0,
  result: { query_rets: [{ result: { value: typeof value === 'string' ? value : JSON.stringify(value) } }] },
})

/** A chain that serves the real ztp20-v1 template and a token's contractInfo, and logs every call. */
function chain(info: unknown = { contractInfo: { symbol: 'JMYR', decimals: '6' } }) {
  const methods: string[] = []
  const query = vi.fn(async ({ input }: { input: string }) => {
    const { method } = JSON.parse(input)
    methods.push(method)
    if (method === 'getTemplateById') return rets(ZTP20_V1)
    if (method === 'contractInfo') return info === null ? { errorCode: 0, result: { query_rets: [{ result: {} }] } } : rets(info)
    return rets({ found: false })
  })
  return { query: query as never, methods }
}

const attr = (attributeName: string, value: string, attributeType = 'STRING') => ({ attributeName, attributeType, value })
const SYMBOL_DRAFT = {
  policyKey: 'ztp20-v1',
  templateId: 'a'.repeat(64),
  attributes: [attr('assetScope', 'ztp20'), attr('tokenAddress', 'JMYR', 'ADDRESS'), attr('perTransactionMax', '1', 'NUMBER')],
  validFromBlock: '0',
  validToBlock: '0',
}

describe('knownTokensFor', () => {
  it('names the testnet JMYR address on testnet and the mainnet one elsewhere', () => {
    expect(knownTokensFor('zetrix:testnet')).toEqual({ JMYR: JMYR_TESTNET })
    expect(knownTokensFor('zetrix:mainnet')).toEqual({ JMYR: JMYR_MAINNET })
  })
})

describe('buildPreflightTokenDeps', () => {
  it('carries the registered tokens for THIS network', () => {
    const { query } = chain()
    expect(buildPreflightTokenDeps('zetrix:testnet', query).knownTokens).toEqual({ JMYR: JMYR_TESTNET })
    expect(buildPreflightTokenDeps('zetrix:mainnet', query).knownTokens).toEqual({ JMYR: JMYR_MAINNET })
  })


  it('reads a token\'s symbol and decimals from the contract', async () => {
    const { query, methods } = chain({ contractInfo: { symbol: 'TKN', decimals: '4' } })
    expect(await buildPreflightTokenDeps('zetrix:testnet', query).describeUnit!(JMYR_TESTNET)).toEqual({ symbol: 'TKN', decimals: 4 })
    expect(methods).toEqual(['contractInfo'])
  })

  it('returns null — not a 0-decimal token — when the decimals cannot be read', async () => {
    // resolveAssetInfo falls back to decimals 0 for a failed read. Passing that on would tell the
    // user an amount is in whole tokens when nobody knows what it is.
    for (const info of [null, { contractInfo: { symbol: 'TKN', decimals: 'many' } }, { contractInfo: { symbol: 'TKN', decimals: '-1' } }]) {
      const { query } = chain(info)
      expect(await buildPreflightTokenDeps('zetrix:testnet', query).describeUnit!(JMYR_TESTNET), JSON.stringify(info)).toBeNull()
    }
  })
})

describe('write_policy\'s pre-payment check uses them', () => {
  const build = (chainQuery: never) =>
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
      queryBalance: async (token: string) => ({ token, error: 'query_failed' as const }),
      caps: undefined,
    } as never).policyWriteDeps!

  it('names the registered address for a symbol, so a paid write cannot go ahead on it', async () => {
    const { query } = chain()
    const r = await build(query).preflight(SYMBOL_DRAFT as never)
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toContain(`JMYR on this network is ${JMYR_TESTNET}`)
  })

  it('states the unit, which needs the decimals reader to be wired', async () => {
    const { query } = chain()
    // amountUnit "base" acknowledges that 1 raw unit of a 6-decimal token is deliberate (the unit guard).
    const fixed = {
      ...SYMBOL_DRAFT,
      amountUnit: 'base',
      attributes: [attr('assetScope', 'ztp20'), attr('tokenAddress', JMYR_TESTNET, 'ADDRESS'), attr('perTransactionMax', '1', 'NUMBER')],
    }
    const r = await build(query).preflight(fixed as never)
    expect(r.blockers).toEqual([])
    expect(r.interpretation.join(' ')).toMatch(/"perTransactionMax" is 1 in BASE units: 1 = 0\.000001 JMYR/)
  })

  it('carries amountUnit through, so the unit guard and the whole-token conversion reach a paid write', async () => {
    const { query } = chain()
    const draft = {
      ...SYMBOL_DRAFT,
      attributes: [attr('assetScope', 'ztp20'), attr('tokenAddress', JMYR_TESTNET, 'ADDRESS'), attr('perTransactionMax', '1', 'NUMBER')],
    }
    // No amountUnit: 1 raw unit of a 6-decimal token is refused as probably a unit mistake.
    const guarded = await build(query).preflight(draft as never)
    expect(guarded.ready).toBe(false)
    expect(guarded.blockers.join(' ')).toMatch(/less than one whole token/)
    // "whole": converted by the wallet, and reported for write_policy to apply.
    const whole = await build(query).preflight({ ...draft, amountUnit: 'whole' } as never)
    expect(whole.blockers).toEqual([])
    expect(whole.convertedAmounts).toEqual({ perTransactionMax: '1000000' })
  })
})

describe('the policy_preflight tool uses them', () => {
  const tools = (extra: Record<string, unknown>, chainQuery: never) =>
    createTools({
      config: {
        holderDid: 'did:zid:test',
        zetrixAddress: '',
        network: 'zetrix:testnet',
        policyRegistryAddress: REGISTRY,
        policyTemplateAddress: TEMPLATE,
      },
      chainQuery,
      isValidAddress: (a: string) => keypair.checkAddress(a),
      ...extra,
    } as never) as never as { policy_preflight: (i: unknown) => Promise<{ ready: boolean; blockers: string[]; interpretation: string[]; convertedAmounts?: Record<string, string> }> }

  it('names the registered address when the builder is wired', async () => {
    const { query } = chain()
    const r = await tools({ preflightTokenDeps: buildPreflightTokenDeps('zetrix:testnet', query) }, query).policy_preflight(SYMBOL_DRAFT)
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toContain(`JMYR on this network is ${JMYR_TESTNET}`)
  })

  it('forwards amountUnit, so a whole-token amount is converted and the unit guard applies', async () => {
    const { query } = chain()
    const draft = {
      ...SYMBOL_DRAFT,
      attributes: [attr('assetScope', 'ztp20'), attr('tokenAddress', JMYR_TESTNET, 'ADDRESS'), attr('perTransactionMax', '1', 'NUMBER')],
    }
    const t = tools({ preflightTokenDeps: buildPreflightTokenDeps('zetrix:testnet', query) }, query)
    const guarded = await t.policy_preflight(draft)
    expect(guarded.ready).toBe(false)
    expect(guarded.blockers.join(' ')).toMatch(/less than one whole token/)
    const whole = (await t.policy_preflight({ ...draft, amountUnit: 'whole' })) as { ready: boolean; convertedAmounts?: Record<string, string> }
    expect(whole.ready).toBe(true)
    expect(whole.convertedAmounts).toEqual({ perTransactionMax: '1000000' })
  })

  it('has no such hint when it is not — the dep is optional, and its absence is not an error', async () => {
    const { query } = chain()
    const r = await tools({}, query).policy_preflight(SYMBOL_DRAFT)
    expect(r.blockers.join(' ')).not.toMatch(/token symbol, not an address/)
  })
})

describe('wallet_status can name the token, so the agent need not ask for it', () => {
  const deps = (query: never) => ({
    address: 'ZTX3Holder',
    fetchNativeBalance: async () => '5000000',
    resolveTokenAddress: (s: string) => (s === 'JMYR' ? JMYR_TESTNET : null),
    query,
  })

  it('returns the contract address for a token asked for by symbol', async () => {
    const { query } = chain()
    const bal = vi.fn(async () => rets({ balance: '3000000' }))
    const q = (async (x: { input: string }) => (JSON.parse(x.input).method === 'balanceOf' ? bal() : (query as never as (x: unknown) => unknown)(x))) as never
    const out = await queryTokenBalance(deps(q), 'JMYR')
    expect(out).toMatchObject({ token: 'JMYR', balance: '3000000', tokenAddress: JMYR_TESTNET })
  })

  it('returns the address exactly as given when asked by address, never upper-cased', async () => {
    const mixed = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
    const q = (async (x: { input: string }) =>
      JSON.parse(x.input).method === 'balanceOf' ? rets({ balance: '1' }) : rets({ contractInfo: { symbol: 'ABC', decimals: '2' } })) as never
    const out = await queryTokenBalance({ ...deps(q), resolveTokenAddress: () => null }, mixed)
    expect(out).toMatchObject({ token: 'ABC', tokenAddress: mixed })
  })

  it('has no tokenAddress for native ZTX, which has no contract', async () => {
    const { query } = chain()
    const out = await queryTokenBalance(deps(query), 'ZTX')
    expect('tokenAddress' in out).toBe(false)
  })
})
