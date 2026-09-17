import { describe, it, expect, vi } from 'vitest'
import { credentialPreflight, VERIFIED_AI_BIRTHCERT } from '../orchestrator/preflight'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

/** Balances keyed by whatever the caller asks for; anything unlisted reads as zero. */
function balances(byToken: Record<string, string>) {
  return vi.fn(async (token: string) => {
    const raw = byToken[token] ?? byToken[token.toUpperCase()]
    if (raw === undefined) return { token, error: 'query_failed' as const }
    const symbol = token === JMYR ? 'JMYR' : token.toUpperCase()
    return { token: symbol, balance: raw, decimals: 6, display: `${Number(raw) / 1e6} ${symbol}` }
  })
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    quoteVerified: vi.fn().mockResolvedValue({
      quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'sponsored' },
    }),
    quoteTemplate: vi.fn().mockResolvedValue({
      quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee' },
      schema: { required: ['agentUsername'], optional: ['purpose'] },
    }),
    queryTokenBalance: balances({ [JMYR]: '5000000', ZTX: '2000000' }),
    caps: { [JMYR]: '5000000', '*': '0' },
    ...overrides,
  }
}

describe('credentialPreflight — know before you pay (R1)', () => {
  it('reports ready when the fee is quoted, the balance covers it and the cap permits it', async () => {
    const out = await credentialPreflight(deps() as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(true)
    expect(out.blockers).toEqual([])
    expect(out.fee).toMatchObject({ asset: JMYR, maxAmountRequired: '1000000', gasModel: 'sponsored' })
  })

  it('spends nothing — it only ever asks for quotes and balances', async () => {
    const d = deps()
    await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(d.quoteVerified).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })

  // MBI reports free-vs-paid separately from the amount: in free mode `accepts[]` still
  // carries a full price nobody will be charged (verified live — paymentRequired false
  // alongside maxAmountRequired 1000000). Blocking on that amount sends the user to fund a
  // credential the wallet already knows is free, which is exactly what happened on 2026-09-14.
  it('does not block on the fee balance or the cap when MBI reports issuance is free', async () => {
    const d = deps({
      quoteTemplate: vi.fn().mockResolvedValue({
        // Zero balance, amount over the cap: both would block if the credential were chargeable.
        quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'sponsored', paymentRequired: false },
        schema: { required: ['agentUsername'], optional: [] },
      }),
      queryTokenBalance: balances({ [JMYR]: '0', ZTX: '2000000' }),
      caps: { [JMYR]: '0', '*': '0' },
    })

    const out = await credentialPreflight(d as never, { credential: 'did:zid:t-free' })

    expect(out.ready).toBe(true)
    expect(out.blockers).toEqual([])
    // The indicative price is still reported — what it WOULD cost if payment were switched on.
    expect(out.fee).toMatchObject({ asset: JMYR, maxAmountRequired: '1000000', paymentRequired: false })
  })

  // paymentRequired is a service-wide MBI setting, not a property of this template,
  // and suppressing the blockers on it is what lets preflight answer ready:true for an empty
  // wallet. If payment is switched back on between this quote and the apply, that answer was wrong
  // and the user finds out at issuance. The tool's contract is to always relay notChecked, so the
  // caveat has to be in there rather than implied.
  it('warns via notChecked that free mode is a mutable service-wide setting, only when free', async () => {
    const freeDeps = deps({
      quoteTemplate: vi.fn().mockResolvedValue({
        quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'sponsored', paymentRequired: false },
      }),
      queryTokenBalance: balances({ [JMYR]: '0', ZTX: '2000000' }),
    })
    const free = await credentialPreflight(freeDeps as never, { credential: 'did:zid:t-free' })
    expect(free.ready).toBe(true)
    expect(free.notChecked.join(' ')).toMatch(/still free at apply time/)

    // A chargeable credential must not carry it — the caveat is only true when the answer relied on
    // the flag, and a notChecked list that cries wolf stops being read.
    const paid = await credentialPreflight(deps() as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(paid.notChecked.join(' ')).not.toMatch(/still free at apply time/)
  })

  // Gas is not the fee. A free credential on a self-pay gas model still needs ZTX, so suppressing
  // the fee blocker must not suppress this one — that would trade one wrong answer for another.
  it('still blocks on missing ZTX gas even when issuance is free', async () => {
    const d = deps({
      quoteTemplate: vi.fn().mockResolvedValue({
        quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'self', paymentRequired: false },
        schema: { required: ['agentUsername'], optional: [] },
      }),
      queryTokenBalance: balances({ [JMYR]: '0', ZTX: '0' }),
    })

    const out = await credentialPreflight(d as never, { credential: 'did:zid:t-free' })

    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/ZTX/)
    // …but not about the fee itself.
    expect(out.blockers.join(' ')).not.toMatch(/Not enough JMYR/)
  })

  // Absent is unknown, not free — the same three-state rule established for dryRun.
  // Treating a silent (older) MBI as free would under-report a real cost.
  it('keeps blocking on balance when MBI omits paymentRequired entirely', async () => {
    const d = deps({
      quoteTemplate: vi.fn().mockResolvedValue({
        quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'sponsored' },
        schema: { required: ['agentUsername'], optional: [] },
      }),
      queryTokenBalance: balances({ [JMYR]: '0', ZTX: '2000000' }),
    })

    const out = await credentialPreflight(d as never, { credential: 'did:zid:t-unknown' })

    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/Not enough JMYR/)
    expect(out.fee?.paymentRequired).toBeUndefined()
  })

  it('still blocks on an insufficient balance when MBI says payment IS required', async () => {
    const d = deps({
      quoteTemplate: vi.fn().mockResolvedValue({
        quote: { asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3Payee', gasModel: 'sponsored', paymentRequired: true },
        schema: { required: ['agentUsername'], optional: [] },
      }),
      queryTokenBalance: balances({ [JMYR]: '0', ZTX: '2000000' }),
    })

    const out = await credentialPreflight(d as never, { credential: 'did:zid:t-paid' })

    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/Not enough JMYR/)
    expect(out.fee).toMatchObject({ paymentRequired: true })
  })

  it('blocks on an insufficient balance, naming the shortfall in human units', async () => {
    const d = deps({ queryTokenBalance: balances({ [JMYR]: '10', ZTX: '2000000' }) })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/balance/i)
  })

  it('blocks on the spending cap, naming the applied key so a mis-keyed limit is visible', async () => {
    const d = deps({ caps: { JMYR: '5000000', '*': '0' } })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    expect(out.cap).toMatchObject({ matchedKey: '*', wouldPass: false })
    expect(out.blockers.join(' ')).toMatch(/limit|cap/i)
  })

  // Reported live: the balance blocker read "the fee is 1 JMYR" while the cap blocker in the same
  // response read "issuance requires 1,000,000" — a raw base-unit number with no symbol, which a
  // caller summarizing both blockers together has no way to tell apart from an already-human amount.
  it('renders the cap blocker in human units (symbol + decimals), not raw base units', async () => {
    const d = deps({ caps: { [JMYR]: '200000', '*': '0' } })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    const capBlocker = out.blockers.join(' ')
    expect(capBlocker).toMatch(/0\.2 JMYR/)
    expect(capBlocker).toMatch(/1 JMYR/)
    expect(capBlocker).not.toMatch(/200000/)
    expect(capBlocker).not.toMatch(/\b1000000\b/)
  })

  it('renders the mis-keyed cap blocker in human units too', async () => {
    const d = deps({ caps: { JMYR: '5000000', '*': '300000' } })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    const capBlocker = out.blockers.join(' ')
    expect(capBlocker).toMatch(/0\.3 JMYR/)
    expect(capBlocker).toMatch(/1 JMYR/)
    expect(capBlocker).not.toMatch(/300000/)
    expect(capBlocker).not.toMatch(/\b1000000\b/)
  })

  // Code review (APP-L01): renderCapBlocker's call to renderAmount is the one call site with
  // no guard against an errored balance read — the balance-blocker call sites at :155/:180 are both
  // provably non-errored. renderAmount's own `'error' in balance` fallback catches it and degrades to
  // raw units, but that fallback was previously unreachable dead code; this pins it as load-bearing.
  it('degrades the cap blocker to raw units instead of throwing when the fee balance read errored', async () => {
    const d = deps({ queryTokenBalance: balances({ ZTX: '2000000' }), caps: { '*': '0' } })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    const blockerText = out.blockers.join(' ')
    expect(blockerText).toMatch(/Could not read the .* balance/)
    expect(blockerText).toMatch(/\b1000000\b/)
  })

  it('reports BOTH a balance and a cap blocker at once, not one at a time', async () => {
    // The captured session hit these as two separate dead ends: top up, retry, discover the cap.
    const d = deps({ queryTokenBalance: balances({ [JMYR]: '10', ZTX: '2000000' }), caps: { '*': '0' } })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.blockers.length).toBeGreaterThanOrEqual(2)
  })

  it('checks gas separately from the fee when the wallet self-pays', async () => {
    const d = deps({
      quoteVerified: vi.fn().mockResolvedValue({
        quote: { asset: JMYR, maxAmountRequired: '1000000', gasModel: 'self' },
      }),
      queryTokenBalance: balances({ [JMYR]: '5000000', ZTX: '0' }),
    })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/ZTX/)
  })

  it('does NOT require ZTX when the paymaster sponsors gas', async () => {
    const d = deps({ queryTokenBalance: balances({ [JMYR]: '5000000', ZTX: '0' }) })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(true)
  })

  it('always says the agent name was not checked — it cannot be', async () => {
    const out = await credentialPreflight(deps() as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.notChecked.join(' ')).toMatch(/name/i)
  })

  it('reports the template schema for a template credential, so fields are known upfront', async () => {
    const out = await credentialPreflight(deps() as never, { credential: 'AI Birthcert' })
    expect(out.schema).toEqual({ required: ['agentUsername'], optional: ['purpose'] })
  })

  it('reports a quote failure as a blocker rather than throwing', async () => {
    const d = deps({ quoteVerified: vi.fn().mockResolvedValue({ error: 'SSIVC 402 returned no usable payment options' }) })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/no usable payment options/)
  })

  it('reports a failed balance read as a blocker, never as zero', async () => {
    const d = deps({ queryTokenBalance: vi.fn(async (t: string) => ({ token: t, error: 'query_failed' as const })) })
    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/could not read|failed/i)
  })

  // Asserted by counting reads in flight rather than by timing: a wall-clock threshold is flaky on
  // a loaded CI box, and asserting call ORDER would not catch a revert — a sequential loop produces
  // the same order. Only overlap distinguishes the two.
  describe('the fee and gas balances are read concurrently', () => {
    /** Resolves both reads only once `expected` of them are simultaneously in flight. */
    function gatedBalances(expected: number) {
      let inFlight = 0
      let peak = 0
      let release: () => void
      const allInFlight = new Promise<void>((r) => (release = r))
      const fn = vi.fn(async (token: string) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        if (inFlight >= expected) release!()
        await allInFlight
        inFlight--
        return { token: token === JMYR ? 'JMYR' : token, balance: '5000000', decimals: 6, display: `5 ${token}` }
      })
      return { fn, peak: () => peak }
    }

    it('has both reads open at once when the wallet self-pays gas', async () => {
      const { fn, peak } = gatedBalances(2)
      const d = deps({
        quoteVerified: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1000000', gasModel: 'self' } }),
        queryTokenBalance: fn,
      })
      // A sequential implementation deadlocks against the gate instead of resolving, so this test
      // fails by timing out on a revert — which is the signal we want.
      const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
      expect(out.balances).toHaveLength(2)
      expect(peak()).toBe(2)
    })

    it('still reports the fee asset first and gas second, so the blockers name the right balance', async () => {
      const d = deps({
        quoteVerified: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1000000', gasModel: 'self' } }),
      })
      const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })
      expect(out.balances.map((b) => b.token)).toEqual(['JMYR', 'ZTX'])
    })
  })
})
