import { describe, it, expect, vi } from 'vitest'
import { queryContract } from '../clients/contract-query-client'

const CONTRACT = 'ZTX3token00000000000000000000000000'

function ok(value: string) {
  return { errorCode: 0, result: { query_rets: [{ result: { value } }] } }
}

describe('queryContract', () => {
  it('calls the query with method/params wrapped as JSON input, optType 2', async () => {
    const query = vi.fn().mockResolvedValue(ok(JSON.stringify({ balance: '5000000' })))
    await queryContract({ contractAddress: CONTRACT, method: 'balanceOf', params: { address: 'ZTX3Holder' } }, query)
    expect(query).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      input: JSON.stringify({ method: 'balanceOf', params: { address: 'ZTX3Holder' } }),
      optType: 2,
    })
  })

  it('defaults params to {} when omitted', async () => {
    const query = vi.fn().mockResolvedValue(ok(JSON.stringify({ contractInfo: { symbol: 'JMYR' } })))
    await queryContract({ contractAddress: CONTRACT, method: 'contractInfo' }, query)
    expect(query).toHaveBeenCalledWith({
      contractAddress: CONTRACT,
      input: JSON.stringify({ method: 'contractInfo', params: {} }),
      optType: 2,
    })
  })

  it('returns ok:true with the parsed JSON result on success', async () => {
    const query = vi.fn().mockResolvedValue(ok(JSON.stringify({ balance: '5000000' })))
    const out = await queryContract({ contractAddress: CONTRACT, method: 'balanceOf', params: { address: 'ZTX3Holder' } }, query)
    expect(out).toEqual({ ok: true, result: { balance: '5000000' } })
  })

  it('returns ok:false on a non-zero errorCode', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 151, result: {} })
    const out = await queryContract({ contractAddress: CONTRACT, method: 'badMethod' }, query)
    expect(out).toEqual({ ok: false, error: 'query_contract: contract call failed with errorCode 151' })
  })

  it('returns ok:false when no result value is returned', async () => {
    const query = vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [] } })
    const out = await queryContract({ contractAddress: CONTRACT, method: 'contractInfo' }, query)
    expect(out).toEqual({ ok: false, error: 'query_contract: no result value returned' })
  })

  it('returns ok:false (not a throw) when the query itself rejects', async () => {
    const query = vi.fn().mockRejectedValue(new Error('node down'))
    const out = await queryContract({ contractAddress: CONTRACT, method: 'contractInfo' }, query)
    expect(out).toEqual({ ok: false, error: 'query_contract: RPC call failed — node down' })
  })
})
