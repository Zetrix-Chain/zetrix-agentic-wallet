import { describe, it, expect, vi } from 'vitest'
import { payAndFetch } from '../orchestrator/pay'

describe('payAndFetch', () => {
  it('passes the request through the injected x402 payer and returns its result', async () => {
    const payer = vi.fn().mockResolvedValue({
      status: 200, body: 'ok', paymentMade: true, amountPaid: '1000000', amountPaidHuman: '1 JMYR', asset: 'JMYR',
    })

    const out = await payAndFetch(payer, { url: 'https://api.test/data', method: 'GET' })

    expect(payer).toHaveBeenCalledWith({ url: 'https://api.test/data', method: 'GET' })
    expect(out).toEqual({
      status: 200, body: 'ok', paymentMade: true, amountPaid: '1000000', amountPaidHuman: '1 JMYR', asset: 'JMYR',
    })
  })
})
