import { describe, it, expect } from 'vitest'
import { needsNativeGasCheck } from '../accept-selection.js'

const sponsored = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTXtoken', payTo: 'ZTXto', maxAmountRequired: '5000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://proxy/prepare' } }
const selfPayToken = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTXtoken', payTo: 'ZTXto', maxAmountRequired: '5000', extra: { gasModel: 'client' } }
const selfPayZtx = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTXto', maxAmountRequired: '1000000', extra: [] as unknown as Record<string, unknown> }

describe('needsNativeGasCheck', () => {
  it('checks gas for a self-paid ZTP20 payment — the zero-gas stopgap case', () => {
    expect(needsNativeGasCheck(selfPayToken)).toBe(true)
  })

  it('skips the gas check for a sponsored payment — the paymaster pays gas', () => {
    expect(needsNativeGasCheck(sponsored)).toBe(false)
  })

  it('skips the gas check for a native ZTX payment — balance check is the amount itself', () => {
    expect(needsNativeGasCheck(selfPayZtx)).toBe(false)
  })

  it('skips the gas check when the asset is absent', () => {
    expect(needsNativeGasCheck({ ...selfPayToken, asset: '' })).toBe(false)
  })
})
