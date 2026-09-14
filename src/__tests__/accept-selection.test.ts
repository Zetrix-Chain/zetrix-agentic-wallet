import { describe, it, expect } from 'vitest'
import { orderAccepts, isSponsored, prepareBaseUrl } from '../accept-selection.js'

const selfPay = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTXpayee', maxAmountRequired: '1000000', extra: { gasModel: 'client' } }
const sponsored = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTXtokenContract', payTo: 'ZTXrecipient', maxAmountRequired: '5000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://proxy/ztx/facilitator/prepare' } }

describe('isSponsored', () => {
  it('is true only for gasModel facilitator with a prepareEndpoint', () => {
    expect(isSponsored(sponsored)).toBe(true)
    expect(isSponsored(selfPay)).toBe(false)
  })

  it('is false when gasModel is facilitator but prepareEndpoint is missing — unusable quote', () => {
    expect(isSponsored({ ...sponsored, extra: { gasModel: 'facilitator' } })).toBe(false)
  })

  it('treats a legacy empty-array extra as self-pay', () => {
    expect(isSponsored({ ...selfPay, extra: [] as unknown as Record<string, unknown> })).toBe(false)
  })

  it('treats a missing extra as self-pay', () => {
    const { extra: _drop, ...noExtra } = selfPay
    expect(isSponsored(noExtra as typeof selfPay)).toBe(false)
  })

  it('is false when gasModel is facilitator with a valid prepareEndpoint but no asset — unsponsorable, not self-pay-eligible either', () => {
    // Isolates the `asset !== ''` branch: every other test case above short-circuits on an earlier
    // check before reaching it, so a mutant that always evaluated this branch true would go
    // undetected without this case.
    expect(isSponsored({ ...sponsored, asset: '' })).toBe(false)
  })
})

describe('orderAccepts', () => {
  it('returns an empty list for no options', () => {
    expect(orderAccepts([], 'sponsored')).toEqual([])
  })

  it('puts sponsored first when preferred, regardless of wire order', () => {
    expect(orderAccepts([selfPay, sponsored], 'sponsored')).toEqual([sponsored, selfPay])
    expect(orderAccepts([sponsored, selfPay], 'sponsored')).toEqual([sponsored, selfPay])
  })

  it('puts self-pay first when the caller forces self', () => {
    expect(orderAccepts([sponsored, selfPay], 'self')).toEqual([selfPay, sponsored])
  })

  it('still offers the only option available, whichever preference is set', () => {
    expect(orderAccepts([selfPay], 'sponsored')).toEqual([selfPay])
    expect(orderAccepts([sponsored], 'self')).toEqual([sponsored])
  })

  it('drops a sponsored quote priced in native ZTX — unsponsorable', () => {
    const bogus = { ...sponsored, asset: 'ZTX' }
    expect(orderAccepts([bogus], 'sponsored')).toEqual([])
    expect(orderAccepts([bogus, selfPay], 'sponsored')).toEqual([selfPay])
  })

  it('drops a facilitator quote with no prepareEndpoint — not actionable', () => {
    const unusable = { ...sponsored, extra: { gasModel: 'facilitator' } }
    expect(orderAccepts([unusable], 'sponsored')).toEqual([])
  })
})

describe('prepareBaseUrl', () => {
  it('collapses both advertised forms to the same base', () => {
    expect(prepareBaseUrl('https://proxy/ztx/facilitator')).toBe('https://proxy/ztx/facilitator')
    expect(prepareBaseUrl('https://proxy/ztx/facilitator/prepare')).toBe('https://proxy/ztx/facilitator')
  })
})
