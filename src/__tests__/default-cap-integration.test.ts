import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config'
import { assertWithinPaymentCap } from '../payment-guard'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const JMYR_MAINNET = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
const base = { HSM_PASSWORD: 'x', WALLET_BE_URL: 'https://be.test', ZETRIX_NODE_HOST: 'n.test' }
const fee = { asset: JMYR, maxAmountRequired: '1000000' } // the live 1 JMYR quote

describe('the out-of-the-box spending cap, end to end', () => {
  it('an unconfigured TESTNET wallet can now pay the credential fee', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:testnet' } as never)
    expect(() => assertWithinPaymentCap(fee, cfg.maxPaymentAmount)).not.toThrow()
  })

  it('...but still refuses anything else', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:testnet' } as never)
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1' }, cfg.maxPaymentAmount)).toThrow()
    expect(() => assertWithinPaymentCap({ asset: JMYR, maxAmountRequired: '1000001' }, cfg.maxPaymentAmount)).toThrow()
  })

  // Product decision: a first credential should work on mainnet too. The fee must be keyed to the
  // MAINNET JMYR contract — the testnet one would not match.
  it('an unconfigured MAINNET wallet can now pay the same fee FOR A CREDENTIAL', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as never)
    const mainnetFee = { asset: JMYR_MAINNET, maxAmountRequired: '1000000' }
    expect(() => assertWithinPaymentCap(mainnetFee, cfg.credentialIssuanceCaps)).not.toThrow()
  })

  // The allowance is scoped to issuance on purpose. pay_and_fetch auto-pays arbitrary URLs, so the
  // same default there would let a misled agent be drained of real value on a wallet nobody
  // configured — the confused-deputy case the payment guard exists to prevent.
  it('but that mainnet allowance does NOT extend to pay_and_fetch — the general cap still refuses it', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as never)
    const mainnetFee = { asset: JMYR_MAINNET, maxAmountRequired: '1000000' }
    expect(() => assertWithinPaymentCap(mainnetFee, cfg.maxPaymentAmount)).toThrow()
  })

  it('...and an unconfigured MAINNET wallet still refuses anything above the fee, and every other asset', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as never)
    expect(() => assertWithinPaymentCap({ asset: JMYR_MAINNET, maxAmountRequired: '1000001' }, cfg.credentialIssuanceCaps)).toThrow()
    expect(() => assertWithinPaymentCap({ asset: 'ZTX', maxAmountRequired: '1' }, cfg.credentialIssuanceCaps)).toThrow()
    // The testnet contract is a different asset on mainnet and must not inherit the allowance.
    expect(() => assertWithinPaymentCap(fee, cfg.credentialIssuanceCaps)).toThrow()
  })

  it('the ticker the user reached for in the transcript now actually works', () => {
    const cfg = loadConfig({
      ...base,
      ZETRIX_NETWORK: 'zetrix:testnet',
      MAX_PAYMENT_AMOUNT: '{"JMYR":"5000000","*":"0"}',
    } as never)
    expect(() => assertWithinPaymentCap(fee, cfg.maxPaymentAmount)).not.toThrow()
  })

  it('an explicit config still overrides the default on both networks', () => {
    for (const net of ['zetrix:testnet', 'zetrix:mainnet']) {
      const cfg = loadConfig({ ...base, ZETRIX_NETWORK: net, MAX_PAYMENT_AMOUNT: '{"*":"0"}' } as never)
      expect(cfg.maxPaymentAmount).toEqual({ '*': '0' })
      expect(() => assertWithinPaymentCap(fee, cfg.maxPaymentAmount)).toThrow()
    }
  })
})
