import { describe, it, expect } from 'vitest'
import { asPayRequest } from '../index.js'
import type { PayRequirement } from '../clients/mbi-client.js'

describe('asPayRequest', () => {
  it('normalises a sponsored quote\'s prepareEndpoint to the SDK base url', () => {
    // Verified live 2026-08-24: the server advertises extra.prepareEndpoint as a full URL
    // ending in /prepare. PaymentEngine.pay forwards it as the SDK's base url, and
    // FacilitatorPrepareClient.prepare appends its own /prepare — without stripping the
    // trailing /prepare here, every sponsored payment 403s on /prepare/prepare.
    const accept = {
      scheme: 'exact',
      network: 'zetrix:testnet',
      asset: 'ZTXtoken',
      payTo: 'ZTXto',
      maxAmountRequired: '5000',
      extra: { gasModel: 'facilitator', prepareEndpoint: 'https://proxy/api/facilitator/prepare' },
    } as unknown as PayRequirement

    const result = asPayRequest(accept) as unknown as { extra: Record<string, unknown> }

    expect(result.extra.prepareEndpoint).toBe('https://proxy/api/facilitator')
  })

  it('leaves a self-pay quote with no prepareEndpoint untouched', () => {
    const accept = {
      scheme: 'exact',
      network: 'zetrix:testnet',
      asset: 'ZTXtoken',
      payTo: 'ZTXto',
      maxAmountRequired: '5000',
      extra: { gasModel: 'client' },
    } as unknown as PayRequirement

    const result = asPayRequest(accept) as unknown as { extra: Record<string, unknown> }

    expect(result.extra).toEqual({ gasModel: 'client' })
  })

  it('defaults gasModel to client when extra is absent', () => {
    const accept = {
      scheme: 'exact',
      network: 'zetrix:testnet',
      asset: 'ZTX',
      payTo: 'ZTXto',
      maxAmountRequired: '1000000',
    } as unknown as PayRequirement

    const result = asPayRequest(accept) as unknown as { extra: Record<string, unknown> }

    expect(result.extra).toEqual({ gasModel: 'client' })
  })
})
