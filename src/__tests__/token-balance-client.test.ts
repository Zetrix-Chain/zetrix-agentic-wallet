import { describe, it, expect, vi } from 'vitest'
import { queryTokenBalance, fetchZTP20BalanceStrict, parseNativeBalance, ZTX_DECIMALS, type TokenBalanceDeps } from '../clients/token-balance-client'

const holder = 'ZTXholder000000000000000000000000000'
const jmyr = 'ZTX3jmyrcontract0000000000000000000'

/** A ContractQuery that answers balanceOf/contractInfo from the given map of method → value JSON. */
function queryReturning(byMethod: Record<string, string>) {
  return vi.fn(async ({ input }: { input: string }) => {
    const { method } = JSON.parse(input) as { method: string }
    const value = byMethod[method]
    if (value === undefined) return { errorCode: 0, result: { query_rets: [{ result: {} }] } }
    return { errorCode: 0, result: { query_rets: [{ result: { value } }] } }
  })
}

const balanceOk = JSON.stringify({ balance: '473999900' })
const infoOk = JSON.stringify({ contractInfo: { symbol: 'JMYR', decimals: '6' } })

function deps(overrides: Partial<Parameters<typeof queryTokenBalance>[0]> = {}) {
  return {
    address: holder,
    fetchNativeBalance: vi.fn().mockResolvedValue('5000000'),
    resolveTokenAddress: (symbol: string) => (symbol === 'JMYR' ? jmyr : null),
    query: queryReturning({ balanceOf: balanceOk, contractInfo: infoOk }),
    ...overrides,
  }
}

describe('fetchZTP20BalanceStrict', () => {
  it('throws instead of reporting zero when the contract call returns a non-zero errorCode', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151, result: {} })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).rejects.toThrow(/errorCode 151/)
  })

  it('throws instead of reporting zero when the response carries no result value', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [{ result: {} }] } })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).rejects.toThrow(/no value/)
  })

  it('throws instead of reporting zero when the result value is not valid JSON', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [{ result: { value: 'not-json' } }] } })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).rejects.toThrow()
  })

  it('returns the raw base-unit balance on success', async () => {
    const query = queryReturning({ balanceOf: balanceOk })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).resolves.toBe('473999900')
  })
})

describe('queryTokenBalance', () => {
  it('reports a ZTP20 balance with the decimals read from contractInfo', async () => {
    const out = await queryTokenBalance(deps(), 'JMYR')
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: 6 })
  })

  it('reports the native ZTX balance with ZETA decimals', async () => {
    const out = await queryTokenBalance(deps(), 'ZTX')
    expect(out).toEqual({ token: 'ZTX', balance: '5000000', decimals: ZTX_DECIMALS })
  })

  it('reports query_failed rather than a zero balance when the ZTP20 lookup fails', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151, result: {} })
    const out = await queryTokenBalance(deps({ query }), 'JMYR')
    expect(out).toEqual({ token: 'JMYR', error: 'query_failed' })
  })

  it('reports query_failed rather than a zero balance when the native ZTX lookup fails', async () => {
    const fetchNativeBalance = vi.fn().mockRejectedValue(new Error('node unreachable'))
    const out = await queryTokenBalance(deps({ fetchNativeBalance }), 'ZTX')
    expect(out).toEqual({ token: 'ZTX', error: 'query_failed' })
  })

  it('still reports the balance with decimals:null when contractInfo is unavailable', async () => {
    const query = queryReturning({ balanceOf: balanceOk })
    const out = await queryTokenBalance(deps({ query }), 'JMYR')
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: null })
  })

  it('reports unknown_token for a symbol with no registered contract on this network', async () => {
    const out = await queryTokenBalance(deps(), 'NOPE')
    expect(out).toEqual({ token: 'NOPE', error: 'unknown_token' })
  })

  it('upper-cases the requested symbol before resolving it', async () => {
    const out = await queryTokenBalance(deps(), 'jmyr')
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: 6 })
  })
})

describe('parseNativeBalance', () => {
  it('returns the balance when the node reports one', () => {
    // A funded account, as observed live: ZTX3YzAyKBxjbSaMPeaPKEBpV93wjzN4SjTaN.
    expect(parseNativeBalance({ errorCode: 0, result: { balance: '1333492010', nonce: '1336' } })).toBe('1333492010')
  })

  it('returns "0" when the node OMITS balance — it does that for a zero balance', () => {
    // The whole bug: an activated account holding nothing returns no balance key at all.
    // Observed on the template registry (nonce 218) and the JMYR contract (nonce 5370).
    expect(parseNativeBalance({ errorCode: 0, result: { nonce: '218' } })).toBe('0')
  })

  it('returns "0" for a never-activated account — no balance and no nonce', () => {
    expect(parseNativeBalance({ errorCode: 0, result: {} })).toBe('0')
  })

  it('treats an explicit null balance as zero too', () => {
    expect(parseNativeBalance({ errorCode: 0, result: { balance: null } })).toBe('0')
  })

  it('accepts a numeric balance — the raw node emits a JSON number, the SDK stringifies it', () => {
    expect(parseNativeBalance({ errorCode: 0, result: { balance: 1333492010 } })).toBe('1333492010')
  })

  it('still throws on a failed RPC, so an unreachable node never looks like an empty wallet', () => {
    expect(() => parseNativeBalance({ errorCode: 4, result: {} })).toThrow(/errorCode 4/)
    expect(() => parseNativeBalance({ result: {} })).toThrow(/errorCode/)
    expect(() => parseNativeBalance(null)).toThrow(/errorCode/)
  })

  it('throws when the response carries no result at all — that is malformed, not zero', () => {
    expect(() => parseNativeBalance({ errorCode: 0 })).toThrow(/no result/)
    expect(() => parseNativeBalance({ errorCode: 0, result: null })).toThrow(/no result/)
  })

  it('throws on a balance of an unusable type rather than coercing it', () => {
    expect(() => parseNativeBalance({ errorCode: 0, result: { balance: {} } })).toThrow(/unusable balance/)
    expect(() => parseNativeBalance({ errorCode: 0, result: { balance: Number.NaN } })).toThrow(/unusable balance/)
  })
})

describe('queryTokenBalance with the real parseNativeBalance', () => {
  it('reports a zero ZTX balance instead of query_failed — the end-to-end fix', async () => {
    const deps = {
      address: 'ZTX3Holder',
      fetchNativeBalance: async () => parseNativeBalance({ errorCode: 0, result: { nonce: '1' } }),
      resolveTokenAddress: () => null,
      query: async () => ({ errorCode: 0 }),
    } as unknown as TokenBalanceDeps
    expect(await queryTokenBalance(deps, 'ZTX')).toEqual({ token: 'ZTX', balance: '0', decimals: ZTX_DECIMALS })
  })

  it('still reports query_failed when the node itself fails', async () => {
    const deps = {
      address: 'ZTX3Holder',
      fetchNativeBalance: async () => parseNativeBalance({ errorCode: 4, result: {} }),
      resolveTokenAddress: () => null,
      query: async () => ({ errorCode: 0 }),
    } as unknown as TokenBalanceDeps
    expect(await queryTokenBalance(deps, 'ZTX')).toEqual({ token: 'ZTX', error: 'query_failed' })
  })
})
