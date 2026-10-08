/**
 * Token decimals are typed strictly and bounded, at the read (review finding APP-M01).
 *
 * `Number(null)`, `Number("")`, `Number(false)` and `Number([])` are all 0, so a contract answering any of them used to
 * read as a genuine 0-decimal token — and `amountUnit: "whole"` would then write 1 token as `1`, a million times too small
 * for a 6-decimal one. And there was no upper bound: a huge value made `10n ** BigInt(decimals)` throw or stall.
 */
import { describe, it, expect } from 'vitest'
import { fetchTokenInfo, parseDecimals, MAX_TOKEN_DECIMALS } from '../clients/token-info-client'

const infoReply = (decimals: unknown, symbol: unknown = 'TKN') => ({
  errorCode: 0,
  result: { query_rets: [{ result: { value: JSON.stringify({ contractInfo: { symbol, decimals } }) } }] },
})
const read = (decimals: unknown) => fetchTokenInfo('ZTX3Token', (async () => infoReply(decimals)) as never)

describe('parseDecimals', () => {
  it('pins the ceiling at 36, absolutely', () => {
    expect(MAX_TOKEN_DECIMALS).toBe(36)
  })

  it('accepts a whole number from 0 to the ceiling', () => {
    for (const n of [0, 1, 6, 8, 18, 36]) expect(parseDecimals(n), String(n)).toBe(n)
  })

  it('accepts a short digit string, which is what contractInfo usually returns', () => {
    for (const [s, n] of [['0', 0], ['6', 6], ['18', 18], ['36', 36], ['06', 6]] as const) expect(parseDecimals(s), s).toBe(n)
  })

  it('refuses everything that Number() would have quietly turned into 0', () => {
    for (const bad of [null, '', false, [], {}, undefined, '  ', true]) {
      expect(parseDecimals(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('refuses a string that is not plainly digits', () => {
    // '006' and '000' too: at most two digits, so padding cannot disguise a value (Number('006') would be 6).
    for (const bad of ['0x6', '1e1', '6.0', '+6', '-6', ' 6', '6 ', 'six', '６', '٦', '1_0', '006', '000', '0006']) {
      expect(parseDecimals(bad), bad).toBeUndefined()
    }
  })

  it('refuses anything past the ceiling, as a number or a string', () => {
    for (const bad of [37, 77, 100, 1e9, 1e300, Number.POSITIVE_INFINITY, '37', '77', '99', '100', '1000000000']) {
      expect(parseDecimals(bad), String(bad)).toBeUndefined()
    }
  })

  it('refuses a negative, fractional or non-finite number', () => {
    for (const bad of [-1, -0.5, 1.5, 0.1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(parseDecimals(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('fetchTokenInfo', () => {
  it('reads a normal token', async () => {
    expect(await read('6')).toEqual({ symbol: 'TKN', decimals: 6, decimalsReadable: true })
    expect(await read(18)).toEqual({ symbol: 'TKN', decimals: 18, decimalsReadable: true })
  })

  it('reads a genuine 0-decimal token as readable, which is different from an unreadable one', async () => {
    expect(await read(0)).toEqual({ symbol: 'TKN', decimals: 0, decimalsReadable: true })
    expect(await read('0')).toEqual({ symbol: 'TKN', decimals: 0, decimalsReadable: true })
  })

  it('does NOT read null, empty, false or an array as a 0-decimal token', async () => {
    for (const bad of [null, '', false, [], 'abc']) {
      const info = await read(bad)
      expect(info, JSON.stringify(bad)).toEqual({ symbol: 'TKN', decimals: 0, decimalsReadable: false })
    }
  })

  it('does not believe an absurd value', async () => {
    for (const bad of [77, 1e9, '1000000000', 1e300]) {
      expect((await read(bad))?.decimalsReadable, String(bad)).toBe(false)
    }
  })

  it('still needs a symbol, as before', async () => {
    expect(await fetchTokenInfo('ZTX3Token', (async () => infoReply(6, '')) as never)).toBeNull()
    expect(await fetchTokenInfo('ZTX3Token', (async () => infoReply(6, 7)) as never)).toBeNull()
  })
})
