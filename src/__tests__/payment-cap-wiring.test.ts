import { describe, it, expect } from 'vitest'
import { buildPayers, buildSettlementWiring } from '../index'
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

// R2-L03: same failure shape as the cap wiring above. The config layer parses, validates and warns
// about SETTLEMENT_WAIT_BUDGET_MS, and the retry loop honours an injected budget — but nothing
// observed the line joining the two, so deleting it left the env var silently inert in production
// with every test still green.
describe('buildSettlementWiring', () => {
  it('carries the settlement knobs from config onto the deps, under the names the orchestrator reads', () => {
    const wiring = buildSettlementWiring({
      gasPreference: 'self',
      maxSettlementAttempts: 7,
      settlementWaitBudgetMs: 12_345,
      aiBirthcertVerifiedTemplateId: 'tpl-verified',
    })

    expect(wiring).toEqual({
      gasPreference: 'self',
      maxSettlementAttempts: 7,
      settlementWaitBudgetMs: 12_345,
      verifiedTemplateId: 'tpl-verified',
    })
  })

  // The two numeric knobs are interchangeable by type, so a swap would type-check.
  it('does not swap the attempt count and the wall-clock budget', () => {
    const wiring = buildSettlementWiring({
      gasPreference: 'sponsored',
      maxSettlementAttempts: 20,
      settlementWaitBudgetMs: 90_000,
      aiBirthcertVerifiedTemplateId: 'tpl',
    })

    expect(wiring.maxSettlementAttempts).toBe(20)
    expect(wiring.settlementWaitBudgetMs).toBe(90_000)
  })

  it('reaches the deps from a real loadConfig, env var and all', () => {
    const cfg = loadConfig({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '45000' } as never)

    expect(buildSettlementWiring(cfg).settlementWaitBudgetMs).toBe(45_000)
  })
})
