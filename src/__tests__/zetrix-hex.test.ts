import { describe, it, expect } from 'vitest'
import { zetrixHexStringToBytes } from '../zetrix-hex'

// Reference vectors captured from the reference HexFormat.hexStringToBytes implementation.
// This decoder is what MBI signs/verifies the holder signature over, so byte-parity is load-bearing.
describe('zetrixHexStringToBytes (port of HexFormat.hexStringToBytes)', () => {
  it('matches the reference implementation on a raw-JSON payload (non-hex chars → 0xFF)', () => {
    const s = '[{"templateId":"did:zid:c042","metadata":{"agentName":"Jak Sparrow","purpose":"x401 + x402"}}]'
    expect(zetrixHexStringToBytes(s).toString('hex').toUpperCase()).toBe(
      'FFFFFFFFFFFFFFFFFFFFFFFFC042FFFFFFADFFFFFFFAFEFFFAFEFFFFFFFFFAFFFFFFFFFFFFFEFFFF40FFFFF402FFFF',
    )
  })

  it('matches on a mixed non-hex string', () => {
    expect(zetrixHexStringToBytes('hello world').toString('hex').toUpperCase()).toBe('FEFFFFFFFF')
  })

  it('decodes a genuine hex string normally (case-insensitive)', () => {
    expect(zetrixHexStringToBytes('5b7b22').toString('hex').toUpperCase()).toBe('5B7B22')
  })

  it('drops an odd trailing char (floor(len/2))', () => {
    // 'ABC' → len 1, only 'AB' decoded
    expect(zetrixHexStringToBytes('ABC').toString('hex').toUpperCase()).toBe('AB')
  })
})
