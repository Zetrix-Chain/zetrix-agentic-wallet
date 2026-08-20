import { describe, it, expect, vi } from 'vitest'
import { fetchTokenInfo, resolveAssetSymbol, resolveAssetInfo, formatHumanAmount } from '../clients/token-info-client.js'

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

describe('resolveAssetInfo', () => {
  it('returns ZTX with its 6 decimals, no contract call', async () => {
    const query = vi.fn()
    expect(await resolveAssetInfo('ZTX', query)).toEqual({ symbol: 'ZTX', decimals: 6 })
    expect(query).not.toHaveBeenCalled()
  })

  it('resolves a ZTP20 contract to its real symbol and decimals', async () => {
    const query = vi.fn().mockResolvedValue(ok(JSON.stringify({ contractInfo: { symbol: 'JMYR', decimals: '6' } })))
    expect(await resolveAssetInfo(CONTRACT, query)).toEqual({ symbol: 'JMYR', decimals: 6 })
  })

  it('falls back to the raw address with decimals 0 when the lookup fails', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151, result: {} })
    expect(await resolveAssetInfo(CONTRACT, query)).toEqual({ symbol: CONTRACT, decimals: 0 })
  })

  it('returns empty symbol and decimals 0 for an empty asset, without calling out', async () => {
    const query = vi.fn()
    expect(await resolveAssetInfo('', query)).toEqual({ symbol: '', decimals: 0 })
    expect(query).not.toHaveBeenCalled()
  })
})

describe('formatHumanAmount', () => {
  it('converts a raw JMYR amount (6 decimals) matching the 0.01 pricing case that motivated this', () => {
    expect(formatHumanAmount('10000', 6)).toBe('0.01')
  })

  it('drops a fully-zero fractional part', () => {
    expect(formatHumanAmount('5000000', 6)).toBe('5')
  })

  it('trims trailing zeros in the fractional part without losing precision', () => {
    expect(formatHumanAmount('1230000', 6)).toBe('1.23')
    expect(formatHumanAmount('1000001', 6)).toBe('1.000001')
  })

  it('returns the raw string unchanged when decimals is 0 or unknown', () => {
    expect(formatHumanAmount('10000', 0)).toBe('10000')
    expect(formatHumanAmount('10000', -1)).toBe('10000')
  })

  it('returns the raw string unchanged for a non-integer input rather than throwing', () => {
    expect(formatHumanAmount('unknown', 6)).toBe('unknown')
    expect(formatHumanAmount('', 6)).toBe('')
  })

  it('never loses precision to floating point on a large raw amount', () => {
    // 2^53 + 1 units, i.e. one more than the largest integer a double can represent exactly.
    expect(formatHumanAmount('9007199254740993', 6)).toBe('9007199254.740993')
  })
})
