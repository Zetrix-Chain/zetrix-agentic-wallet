import { describe, it, expect, vi } from 'vitest'
import { fetchTokenInfo, resolveAssetSymbol } from '../clients/token-info-client.js'

/** A callContract success envelope carrying `value` as the contract's returned JSON string. */
function ok(value: string) {
  return { errorCode: 0, result: { query_rets: [{ result: { value } }] } }
}

const CONTRACT = 'ZTX3token00000000000000000000000000'

describe('fetchTokenInfo', () => {
  it('queries contractInfo (optType 2) and parses symbol/decimals from the wrapped value', async () => {
    const query = vi.fn().mockResolvedValue(
      ok(JSON.stringify({ contractInfo: { name: 'MyEG Ringgit', symbol: 'JMYR', decimals: '6', protocol: 'ztp20' } })),
    )
    const info = await fetchTokenInfo(CONTRACT, query)
    expect(info).toEqual({ symbol: 'JMYR', decimals: 6 })
    expect(query).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      input: JSON.stringify({ method: 'contractInfo', params: {} }),
      optType: 2,
    })
  })

  it('returns null on a non-zero errorCode', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 4, result: {} })
    expect(await fetchTokenInfo(CONTRACT, query)).toBeNull()
  })

  it('returns null when query_rets/value is missing', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [] } })
    expect(await fetchTokenInfo(CONTRACT, query)).toBeNull()
  })

  it('returns null on malformed JSON value', async () => {
    const query = vi.fn().mockResolvedValue(ok('not-json'))
    expect(await fetchTokenInfo(CONTRACT, query)).toBeNull()
  })

  it('returns null when the parsed info carries no symbol', async () => {
    const query = vi.fn().mockResolvedValue(ok(JSON.stringify({ contractInfo: { decimals: '6' } })))
    expect(await fetchTokenInfo(CONTRACT, query)).toBeNull()
  })

  it('returns null (not a throw) when the query itself rejects', async () => {
    const query = vi.fn().mockRejectedValue(new Error('node down'))
    expect(await fetchTokenInfo(CONTRACT, query)).toBeNull()
  })
})

describe('resolveAssetSymbol', () => {
  it('returns "ZTX" for the native asset without any contract call', async () => {
    const query = vi.fn()
    expect(await resolveAssetSymbol('ZTX', query)).toBe('ZTX')
    expect(query).not.toHaveBeenCalled()
  })

  it('resolves the on-chain symbol for a ZTP20 contract address', async () => {
    const query = vi.fn().mockResolvedValue(
      ok(JSON.stringify({ contractInfo: { symbol: 'JMYR', decimals: '6' } })),
    )
    expect(await resolveAssetSymbol(CONTRACT, query)).toBe('JMYR')
  })

  it('falls back to the raw asset string when the lookup fails', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151, result: {} })
    expect(await resolveAssetSymbol(CONTRACT, query)).toBe(CONTRACT)
  })

  it('returns an empty string unchanged (nothing to resolve)', async () => {
    const query = vi.fn()
    expect(await resolveAssetSymbol('', query)).toBe('')
    expect(query).not.toHaveBeenCalled()
  })
})
