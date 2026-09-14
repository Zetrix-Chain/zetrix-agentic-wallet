import { describe, it, expect } from 'vitest'
import { buildPayers } from '../index'
import { loadConfig } from '../config'
import { assertWithinPaymentCap } from '../payment-guard'

// R1-M01 / R2-M01 (rounds 2-3 review of !80): the config layer producing maxPaymentAmount /
// credentialIssuanceCaps was covered, but which auto-pay closure — `pay` (pay_and_fetch, arbitrary
// URLs) vs `payForCredential` (a known issuer) — got which map was not. An intermediate fix
// (resolvePaymentCapWiring) pinned the two maps themselves but still left `main()` writing
// `makePay(payCaps)` / `makePay(payForCredentialCaps)` at the call site — an unguarded pairing a
// swap there could flip with every other test green. buildPayers removes that call site entirely
// by taking `makePay` as a dependency and doing the pairing itself, so this test is the only place
// that pairing exists at all.
const JMYR_MAINNET = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
const base = { HSM_PASSWORD: 'x', WALLET_BE_URL: 'https://be.test', ZETRIX_NODE_HOST: 'n.test' }

describe('buildPayers', () => {
  it('passes maxPaymentAmount to `pay` and credentialIssuanceCaps to `payForCredential` and preflightCaps — not swapped', () => {
    const maxPaymentAmount = { '*': '0' }
    const credentialIssuanceCaps = { [JMYR_MAINNET]: '1000000', '*': '0' }
    const received: Record<string, string>[] = []
    // A fake makePay that tags each result with the exact cap object it was called with, so the
    // test can tell which map each returned closure was actually built from — not just which map
    // the config exposes.
    const fakeMakePay = (caps: Record<string, string>) => {
      received.push(caps)
      return async () => (caps === maxPaymentAmount ? 'built-from-maxPaymentAmount' : 'built-from-credentialIssuanceCaps')
    }

    const { pay, payForCredential, preflightCaps } = buildPayers({ maxPaymentAmount, credentialIssuanceCaps }, fakeMakePay)

    expect(received).toEqual([maxPaymentAmount, credentialIssuanceCaps])
    expect(preflightCaps).toBe(credentialIssuanceCaps)
    return Promise.all([
      pay({} as never).then((r) => expect(r).toBe('built-from-maxPaymentAmount')),
      payForCredential({} as never).then((r) => expect(r).toBe('built-from-credentialIssuanceCaps')),
    ])
  })

  // Same property, behaviourally: on an unconfigured mainnet wallet, an arbitrary x402 resource
  // quoting the credential fee must still be refused via `pay`, while the exact same quote must be
  // accepted via `payForCredential`. Uses the real makePay-shaped guard (assertWithinPaymentCap)
  // rather than a fake, so a swap anywhere in buildPayers — not just at its return statement —
  // would surface here too.
  it('on mainnet: `pay` refuses the credential fee, `payForCredential` accepts it, via a real cap guard', async () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as never)
    const fee = { asset: JMYR_MAINNET, maxAmountRequired: '1000000' }
    const makePayFromGuard = (caps: Record<string, string>) => async (accept: typeof fee) => {
      assertWithinPaymentCap(accept, caps)
      return 'paid'
    }

    const { pay, payForCredential } = buildPayers(cfg, makePayFromGuard as never)

    await expect(pay(fee as never)).rejects.toThrow()
    await expect(payForCredential(fee as never)).resolves.toBe('paid')
  })
})
