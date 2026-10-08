import { describe, it, expect, vi } from 'vitest'
import { checkAffordability, type AffordabilityDeps } from '../orchestrator/policy-affordability.js'
import type { TokenBalanceResult } from '../clients/token-balance-client.js'

const JMYR = 'ZTX3JMYRContractAddress0000000000001'

const bal = (token: string, balance: string, decimals: number | null = 6): TokenBalanceResult => ({
  token,
  balance,
  decimals,
  display: decimals === null ? `${balance} ${token}` : `${Number(balance) / 10 ** decimals} ${token}`,
})
const fail = (token: string): TokenBalanceResult => ({ token, error: 'query_failed' })

/** A self-paid ZTP20 quote — the payer runs the ZTX gas guard for this one. */
const SELF_PAID = { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', extra: { gasModel: 'self' } }
/** Advertises a prepare endpoint, which `isSponsored` reads as the paymaster covering gas. */
const SPONSORED = {
  asset: JMYR,
  maxAmountRequired: '1000000',
  extra: { gasModel: 'facilitator', prepareEndpoint: 'https://facilitator.example/prepare' },
}

function deps(
  balances: Record<string, TokenBalanceResult | (() => never)>,
  caps: AffordabilityDeps['caps'] = undefined,
) {
  const queryBalance = vi.fn(async (token: string) => {
    const b = balances[token]
    if (typeof b === 'function') return b()
    return b ?? fail(token)
  })
  return { d: { queryBalance, caps } as AffordabilityDeps, queryBalance }
}

describe('checkAffordability — the verdict', () => {
  it('is affordable only when every applicable check positively passed', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '2000000') }, { '*': '9000000' })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('affordable')
    expect(r.fee.status).toBe('enough')
    expect(r.gas.status).toBe('enough')
    expect(r.cap.wouldPass).toBe(true)
    expect(r.problems).toEqual([])
  })

  it('treats a balance exactly equal to the fee as enough', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '1000000'), ZTX: bal('ZTX', '1') })
    expect((await checkAffordability(d, SELF_PAID)).fee.status).toBe('enough')
  })

  it('is not affordable when the fee asset is one unit short', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '999999'), ZTX: bal('ZTX', '1') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('not_affordable')
    expect(r.fee.status).toBe('short')
    expect(r.problems.join(' ')).toMatch(/Not enough/)
    expect(r.problems.join(' ')).toContain('1 JMYR')
  })

  it('reports gas as short when ZTX is exactly zero', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '0') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('not_affordable')
    expect(r.gas.status).toBe('short')
    expect(r.fee.status).toBe('enough')
    expect(r.problems.join(' ')).toMatch(/No ZTX for network gas/)
  })

  it('does not call a small non-zero gas balance short — only a zero balance is certain to fail', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '1') })
    expect((await checkAffordability(d, SELF_PAID)).gas.status).toBe('enough')
  })

  it('says it does not estimate the gas amount, so a green result is not read as a guarantee', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '1') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.notChecked.join(' ')).toMatch(/only catches a ZTX balance of zero/)
    expect(r.notChecked.join(' ')).toMatch(/estimated fee it cannot see/)
    expect(r.notChecked.join(' ')).toMatch(/snapshot/i)
  })
})

describe('checkAffordability — the cap', () => {
  const funded = { [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '5') }

  it('is not affordable when the quote exceeds the cap, however full the wallet is', async () => {
    const { d } = deps(funded, { '*': '999999' })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('not_affordable')
    expect(r.cap.wouldPass).toBe(false)
    expect(r.fee.status).toBe('enough')
    // The cap that applied came from the "*" fallback, and the message says so rather than implying a JMYR entry.
    expect(r.problems.join(' ')).toMatch(/spending limit that applies is 0\.999999 JMYR \(from the "\*" fallback.*and this needs 1 JMYR/)
  })

  it('accepts a quote exactly at the cap', async () => {
    const { d } = deps(funded, { '*': '1000000' })
    expect((await checkAffordability(d, SELF_PAID)).verdict).toBe('affordable')
  })

  it('is not affordable when caps are configured but none covers the asset', async () => {
    const { d } = deps(funded, { ZTX: '100' })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('not_affordable')
    expect(r.cap.capRaw).toBeNull()
    expect(r.problems.join(' ')).toMatch(/No spending limit applies to/)
  })

  it('does not gate on a cap when none is configured at all', async () => {
    const { d } = deps(funded, undefined)
    expect((await checkAffordability(d, SELF_PAID)).verdict).toBe('affordable')
  })

  it('uses the cap entry for the asset over the wildcard', async () => {
    const { d } = deps(funded, { [JMYR]: '10', '*': '99999999' })
    expect((await checkAffordability(d, SELF_PAID)).cap.wouldPass).toBe(false)
  })
})

describe('checkAffordability — each cause is stated separately', () => {
  it('reports fee, gas and cap shortfalls together, not one at a time', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '1'), ZTX: bal('ZTX', '0') }, { '*': '5' })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('not_affordable')
    expect(r.fee.status).toBe('short')
    expect(r.gas.status).toBe('short')
    expect(r.cap.wouldPass).toBe(false)
    expect(r.problems).toHaveLength(3)
  })
})

describe('checkAffordability — a failed read is unknown, never a pass and never zero', () => {
  it('an unreadable fee balance is unknown, not affordable and not short', async () => {
    const { d } = deps({ ZTX: bal('ZTX', '5') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('unknown')
    expect(r.fee.status).toBe('unknown')
    expect(r.fee.balance).toBeUndefined()
    expect(r.problems.join(' ')).toMatch(/Could not read the .* balance/)
  })

  it('an unreadable gas balance is unknown, not short', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('unknown')
    expect(r.gas.status).toBe('unknown')
    expect(r.gas.balance).toBeUndefined()
  })

  it('a balance reader that THROWS is contained and reported as unknown', async () => {
    const { d } = deps({
      [JMYR]: () => { throw new Error('node down') },
      ZTX: bal('ZTX', '5'),
    })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.verdict).toBe('unknown')
    expect(r.fee.status).toBe('unknown')
  })

  it('a definite shortfall outranks an unreadable check', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000') }, { '*': '1' })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.gas.status).toBe('unknown')
    expect(r.verdict).toBe('not_affordable')
  })

  it('never echoes an unbounded error string from the reader', async () => {
    const hostile = { token: JMYR, error: 'E'.repeat(50_000) } as unknown as TokenBalanceResult
    const { d } = deps({ [JMYR]: hostile, ZTX: bal('ZTX', '5') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.problems.join(' ').length).toBeLessThan(2000)
  })
})

describe('checkAffordability — gas is checked only when the payer checks it', () => {
  it('skips ZTX entirely for a sponsored payment, and reads no ZTX balance', async () => {
    const { d, queryBalance } = deps({ [JMYR]: bal('JMYR', '5000000') })
    const r = await checkAffordability(d, SPONSORED)
    expect(r.gas.status).toBe('not_needed')
    expect(r.verdict).toBe('affordable')
    expect(queryBalance).not.toHaveBeenCalledWith('ZTX')
  })

  it('a native ZTX fee needs no separate gas read', async () => {
    const { d, queryBalance } = deps({ ZTX: bal('ZTX', '5000000') })
    const r = await checkAffordability(d, { asset: 'ZTX', maxAmountRequired: '1000000' })
    expect(r.gas.status).toBe('not_needed')
    expect(r.verdict).toBe('affordable')
    expect(queryBalance).toHaveBeenCalledTimes(1)
  })

  it('checks gas for a facilitator quote that advertises NO prepare endpoint', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '0') })
    const r = await checkAffordability(d, { asset: JMYR, maxAmountRequired: '1000000', extra: { gasModel: 'facilitator' } })
    expect(r.gas.status).toBe('short')
  })
})

describe('checkAffordability — a quote it cannot compare', () => {
  for (const [label, accept] of [
    ['a non-numeric amount', { asset: JMYR, maxAmountRequired: 'lots' }],
    ['a negative amount', { asset: JMYR, maxAmountRequired: '-5' }],
    ['a fractional amount', { asset: JMYR, maxAmountRequired: '1.5' }],
    ['an empty amount', { asset: JMYR, maxAmountRequired: '' }],
    ['no amount at all', { asset: JMYR }],
    ['no asset', { maxAmountRequired: '5' }],
  ] as const) {
    it(`is unknown for ${label}, reading nothing`, async () => {
      const { d, queryBalance } = deps({})
      const r = await checkAffordability(d, accept)
      expect(r.verdict).toBe('unknown')
      expect(queryBalance).not.toHaveBeenCalled()
    })
  }

  it('does not throw on a huge amount', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '1'), ZTX: bal('ZTX', '1') })
    const r = await checkAffordability(d, { ...SELF_PAID, maxAmountRequired: '9'.repeat(5000) })
    expect(r.verdict).toBe('not_affordable')
  })
})

describe('checkAffordability — human units', () => {
  it('falls back to the raw figure when decimals are unreadable, rather than guessing a scale', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5', null), ZTX: bal('ZTX', '5') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.problems.join(' ')).toContain('1000000')
    expect(r.problems.join(' ')).not.toMatch(/\b1 JMYR\b/)
  })
})

describe('checkAffordability — what it reports on the result', () => {
  it('bounds an unbounded error string from the GAS read too, not just the fee read', async () => {
    const hostile = { token: 'ZTX', error: 'E'.repeat(50_000) } as unknown as TokenBalanceResult
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: hostile })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.gas.status).toBe('unknown')
    expect(r.problems.join(' ').length).toBeLessThan(2000)
  })

  it('reports the balances it read, so a caller can show them', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '7') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.fee).toMatchObject({ status: 'enough', required: '1000000', balance: '5000000', display: '5 JMYR' })
    expect(r.gas).toEqual({ status: 'enough', balance: '7' })
  })

  it('reports the balance and display on a fee shortfall as well', async () => {
    const { d } = deps({ [JMYR]: bal('JMYR', '5'), ZTX: bal('ZTX', '7') })
    const r = await checkAffordability(d, SELF_PAID)
    expect(r.fee).toMatchObject({ status: 'short', balance: '5', display: '0.000005 JMYR' })
  })
})

// ── review findings ──────────────────────────────────────────────────────────────────

describe('checkAffordability — a payment made IN ZTX needs the amount plus the network fee', () => {
  // PaymentEngine.checkBalance: for ZTX, required = amount + fee, from ONE balance.
  const ZTX_QUOTE = { asset: 'ZTX', maxAmountRequired: '1000000' }
  const ztx = (balance: string) => deps({ ZTX: bal('ZTX', balance) })

  it('is short when the balance is exactly the quote, because nothing is left for the fee', async () => {
    const r = await checkAffordability(ztx('1000000').d, ZTX_QUOTE)
    expect(r.verdict).toBe('not_affordable')
    expect(r.fee.status).toBe('short')
    expect(r.problems.join(' ')).toMatch(/exactly that, leaving nothing for the network fee/)
  })

  it('is short below the quote, and says the payer needs amount plus fee from one balance', async () => {
    const r = await checkAffordability(ztx('999999').d, ZTX_QUOTE)
    expect(r.verdict).toBe('not_affordable')
    expect(r.problems.join(' ')).toMatch(/amount plus the network fee from this one balance/)
  })

  it('is enough one unit above the quote, but says the fee is not estimated', async () => {
    const r = await checkAffordability(ztx('1000001').d, ZTX_QUOTE)
    expect(r.verdict).toBe('affordable')
    expect(r.fee.status).toBe('enough')
    expect(r.feeNotEstimated).toBe(true)
  })

  it('does NOT apply the equal-balance rule to a token, where the fee is paid in ZTX separately', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '1000000'), ZTX: bal('ZTX', '1') }).d, SELF_PAID)
    expect(r.fee.status).toBe('enough')
  })
})

describe('checkAffordability — feeNotEstimated says when "affordable" means only "holds the amount"', () => {
  it('is set for a gas-paid token payment', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '1') }).d, SELF_PAID)
    expect(r.verdict).toBe('affordable')
    expect(r.feeNotEstimated).toBe(true)
  })

  it('is NOT set when the paymaster covers the fee', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '5000000') }).d, SPONSORED)
    expect(r.verdict).toBe('affordable')
    expect(r.feeNotEstimated).toBe(false)
  })

  it('is not set for a quote that could not be compared at all', async () => {
    const r = await checkAffordability(deps({}).d, { asset: JMYR, maxAmountRequired: 'lots' })
    expect(r.feeNotEstimated).toBe(false)
  })
})

describe('checkAffordability — the caveats a green result must carry', () => {
  it('says the network fee is not estimated, and that the payer needs the amount plus the fee in ZTX', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '1') }).d, SELF_PAID)
    expect(r.notChecked.join(' ')).toMatch(/The network fee/)
    expect(r.notChecked.join(' ')).toMatch(/amount plus that fee from one balance/)
  })

  it('says activation is not checked, because a never-activated address reads as an ordinary shortfall', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '0'), ZTX: bal('ZTX', '0') }).d, SELF_PAID)
    expect(r.notChecked.join(' ')).toMatch(/Whether the wallet address is activated on chain/)
    expect(r.notChecked.join(' ')).toMatch(/payer reports it as not activated/)
  })
})

describe('checkAffordability — the cap message names the cap that actually applied', () => {
  const funded = { [JMYR]: bal('JMYR', '5000000'), ZTX: bal('ZTX', '5000000') }

  it('says when the applicable cap is the "*" fallback, with the default testnet map and a ZTX quote', async () => {
    // The default map is { <JMYR>: "1000000", "*": "0" }: no ZTX key, so ZTX falls to "*": 0.
    const r = await checkAffordability(deps(funded, { [JMYR]: '1000000', '*': '0' }).d, { asset: 'ZTX', maxAmountRequired: '1000000' })
    const message = r.problems.join(' ')
    expect(message).toMatch(/from the "\*" fallback/)
    expect(message).toMatch(/no limit is set for ZTX/)
    expect(message).not.toMatch(/limit for ZTX is 0/)
  })

  it('uses the plain wording when the asset has its own entry', async () => {
    const r = await checkAffordability(deps(funded, { [JMYR]: '999999' }).d, SELF_PAID)
    expect(r.problems.join(' ')).toMatch(/The spending limit for .* is 0\.999999 JMYR, and this needs 1 JMYR/)
    expect(r.problems.join(' ')).not.toMatch(/fallback/)
  })

  it('bounds the cap message', async () => {
    const r = await checkAffordability(deps(funded, { ['K'.repeat(50_000)]: '1' }).d, SELF_PAID)
    for (const p of r.problems) expect(p.length).toBeLessThanOrEqual(300)
  })
})

describe('checkAffordability — every problem line is bounded, wherever the figure comes from', () => {
  // The quoted amount comes from the service. A 5,000-digit one used to be echoed in full by the fee line, and
  // by the cap line, and then returned in the structured `problems` an agent reads.
  const HUGE = '9'.repeat(5_000)

  it('bounds the fee-shortfall line', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '1'), ZTX: bal('ZTX', '1') }).d, { ...SELF_PAID, maxAmountRequired: HUGE })
    expect(r.fee.status).toBe('short')
    for (const p of r.problems) expect(p.length).toBeLessThanOrEqual(300)
  })

  it('bounds the cap line, which echoes the same figure', async () => {
    const r = await checkAffordability(
      deps({ [JMYR]: bal('JMYR', '5'.repeat(6_000)), ZTX: bal('ZTX', '1') }, { '*': '1' }).d,
      { ...SELF_PAID, maxAmountRequired: HUGE },
    )
    expect(r.cap.wouldPass).toBe(false)
    expect(r.problems.some((p) => /spending limit/.test(p))).toBe(true)
    for (const p of r.problems) expect(p.length).toBeLessThanOrEqual(300)
  })

  it('does not cut a normal-sized line short', async () => {
    const r = await checkAffordability(deps({ [JMYR]: bal('JMYR', '1'), ZTX: bal('ZTX', '1') }, { '*': '1' }).d, SELF_PAID)
    for (const p of r.problems) expect(p.endsWith('…'), p).toBe(false)
  })
})
