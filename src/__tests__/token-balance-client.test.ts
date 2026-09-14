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

  // R1-M02: any contract matching looksLikeContractAddress() is queried here, not only
  // registry-known tokens — an unverified contract returning a non-numeric string must fail the
  // read here rather than pass through as a "successful" balance that a caller's BigInt() then
  // throws on unguarded (see credentialPreflight).
  it('throws instead of reporting a bogus balance when the contract returns a non-numeric string', async () => {
    const query = queryReturning({ balanceOf: JSON.stringify({ balance: 'not-a-number' }) })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).rejects.toThrow(/non-numeric balance/)
  })

  it('throws on a negative-looking balance string too — raw base units are never negative', async () => {
    const query = queryReturning({ balanceOf: JSON.stringify({ balance: '-5' }) })
    await expect(fetchZTP20BalanceStrict(jmyr, holder, query)).rejects.toThrow(/non-numeric balance/)
  })
})

describe('queryTokenBalance', () => {
  it('reports a ZTP20 balance with the decimals read from contractInfo', async () => {
    const out = await queryTokenBalance(deps(), 'JMYR')
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: 6, display: '473.9999 JMYR' })
  })

  it('reports the native ZTX balance with ZETA decimals', async () => {
    const out = await queryTokenBalance(deps(), 'ZTX')
    expect(out).toEqual({ token: 'ZTX', balance: '5000000', decimals: ZTX_DECIMALS, display: '5 ZTX' })
  })

  it('reports query_failed rather than an unverified balance when the contract returns a non-numeric value', async () => {
    const query = queryReturning({ balanceOf: JSON.stringify({ balance: 'not-a-number' }) })
    const out = await queryTokenBalance(deps({ query }), 'JMYR')
    expect(out).toEqual({ token: 'JMYR', error: 'query_failed' })
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
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: null, display: '473999900 JMYR' })
  })

  it('reports unknown_token for a symbol with no registered contract on this network', async () => {
    const out = await queryTokenBalance(deps(), 'NOPE')
    expect(out).toEqual({ token: 'NOPE', error: 'unknown_token' })
  })

  // The spending cap is keyed by CONTRACT ADDRESS while this lookup took a SYMBOL, so the wallet
  // wanted the same token named two opposite ways on two adjacent surfaces. Passing the address the
  // cap just made you deal with returned unknown_token, which reads as "no such token".
  describe('accepts a contract address as well as a symbol', () => {
    it('resolves a balance when given a ZTP20 contract address directly', async () => {
      const out = await queryTokenBalance(deps(), jmyr)
      expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: 6, display: '473.9999 JMYR' })
    })

    it('queries the address that was passed, not a registry lookup of it', async () => {
      const query = queryReturning({ balanceOf: balanceOk, contractInfo: infoOk })
      // An address the registry knows nothing about still works — it IS the contract.
      const unregistered = 'ZTX3someotherc0ntract00000000000000'
      const out = await queryTokenBalance(deps({ query, resolveTokenAddress: () => null }), unregistered)
      expect(out).toMatchObject({ balance: '473999900' })
      expect(query.mock.calls[0][0]).toMatchObject({ contractAddress: unregistered })
    })

    it('still reports unknown_token for something that is neither a symbol nor an address', async () => {
      const out = await queryTokenBalance(deps(), 'NOT-A-TOKEN')
      expect(out).toEqual({ token: 'NOT-A-TOKEN', error: 'unknown_token' })
    })

    it('prefers the registry when the input is a known symbol', async () => {
      const query = queryReturning({ balanceOf: balanceOk, contractInfo: infoOk })
      await queryTokenBalance(deps({ query }), 'JMYR')
      expect(query.mock.calls[0][0]).toMatchObject({ contractAddress: jmyr })
    })
  })

  // A raw base-unit integer next to a ticker reads as whole tokens: "1000000 JMYR" looks like a
  // million, when at 6 decimals it is one. Callers should not have to divide by 10^decimals to make
  // a payment decision.
  describe('reports a human-readable amount alongside the raw one', () => {
    it('renders the balance in whole tokens with its symbol', async () => {
      const out = await queryTokenBalance(deps(), 'JMYR')
      expect(out).toMatchObject({ balance: '473999900', decimals: 6, display: '473.9999 JMYR' })
    })

    it('falls back to raw units when decimals cannot be read, rather than guessing', async () => {
      const query = queryReturning({ balanceOf: balanceOk })
      const out = await queryTokenBalance(deps({ query }), 'JMYR')
      expect(out).toMatchObject({ balance: '473999900', decimals: null, display: '473999900 JMYR' })
    })

    it('renders native ZTX too', async () => {
      const out = await queryTokenBalance(deps(), 'ZTX')
      expect(out).toMatchObject({ balance: '5000000', decimals: ZTX_DECIMALS, display: '5 ZTX' })
    })
  })

  it('upper-cases the requested symbol before resolving it', async () => {
    const out = await queryTokenBalance(deps(), 'jmyr')
    expect(out).toEqual({ token: 'JMYR', balance: '473999900', decimals: 6, display: '473.9999 JMYR' })
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
    expect(await queryTokenBalance(deps, 'ZTX')).toEqual({ token: 'ZTX', balance: '0', decimals: ZTX_DECIMALS, display: '0 ZTX' })
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
