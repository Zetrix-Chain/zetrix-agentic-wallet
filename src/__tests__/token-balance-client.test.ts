import { describe, it, expect, vi } from 'vitest'
import { queryTokenBalance, fetchZTP20BalanceStrict, ZTX_DECIMALS } from '../clients/token-balance-client'

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
