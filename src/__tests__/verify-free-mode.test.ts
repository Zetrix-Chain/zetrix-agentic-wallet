import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  checkAiBirthcertVerification,
  clearStuckPaymentReceipt,
  findUnusedVerificationPayment,
  requestAiBirthcertVerification,
} from '../orchestrator/verify-ai-birthcert'
import { credentialPreflight, VERIFIED_AI_BIRTHCERT } from '../orchestrator/preflight'
import { SsivcError } from '../clients/ssivc-client'
import { canonicalizeJson } from '../canonical-json'

/**
 * SSIVC can run a session without payment. Its quote (POST /sessions/quote) says so with `paymentRequired: false`, and only
 * that exact value lets the wallet start a session with no payment. Everything else, a quote that is missing, unreadable, or
 * silent on the point, must keep the old behaviour: the user is asked before anything is paid.
 */

const JMYR = 'ZTX3Jmyr000000000000000000000000000'
const CLIENT_OPTION = { scheme: 'exact', network: 'zetrix:testnet', asset: JMYR, payTo: 'ZTX3Pay', maxAmountRequired: '0', extra: { gasModel: 'client' } }
const FACILITATOR_OPTION = {
  ...CLIENT_OPTION,
  extra: { gasModel: 'facilitator', prepareEndpoint: 'https://public-api-sandbox.zetrix.com/api/facilitator/prepare' },
}
const PAID_OPTION = { ...CLIENT_OPTION, maxAmountRequired: '1000000' }
const PAID_FACILITATOR = { ...FACILITATOR_OPTION, maxAmountRequired: '1000000' }

const FREE_SESSION = { sessionId: 's-free', verificationUrl: 'https://zvg.test/verify/free', expiresAt: '2026-10-22T09:30:00+00:00' }

const CREATED = { kind: 'created', session: FREE_SESSION }
const CHARGING = { kind: 'challenge', challenge: { x402Version: 2, accepts: [PAID_OPTION, PAID_FACILITATOR] } }

function makeDeps(opts: { quote?: unknown; quoteError?: unknown; noQuoteRoute?: boolean; start?: unknown; startError?: unknown; withoutQuoteMethods?: boolean } = {}) {
  const quoteSession = vi.fn(async () => {
    if (opts.quoteError) throw opts.quoteError
    if (opts.noQuoteRoute) return undefined
    return opts.quote ?? { paymentRequired: false, accepts: [CLIENT_OPTION, FACILITATOR_OPTION] }
  })
  // What SSIVC answers a session request with no payment: a session only when its quote would have said free.
  const quoteIsFree = !opts.quoteError && !opts.noQuoteRoute && (opts.quote === undefined || (opts.quote as { paymentRequired?: unknown }).paymentRequired === false)
  const startSession = vi.fn(async () => {
    if (opts.startError) throw opts.startError
    return opts.start ?? (quoteIsFree ? CREATED : CHARGING)
  })
  const createSessionChallenge = vi.fn().mockResolvedValue({ x402Version: 2, accepts: [PAID_OPTION, PAID_FACILITATOR] })
  const createSessionSettle = vi.fn()
  const createSessionWithReceipt = vi.fn()
  const getSession = vi.fn().mockResolvedValue({ sessionId: 's-old', status: 'pending', expiresAt: '2026-10-22T09:30:00+00:00' })
  const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 'sig-hex', publicKey: 'b001pk' })
  const pay = vi.fn().mockResolvedValue('BASE64PAYMENT')
  const stored: { value: Record<string, unknown> | null } = { value: null }
  const sessionStore = {
    get: vi.fn().mockImplementation(async () => stored.value),
    set: vi.fn().mockImplementation(async (v: Record<string, unknown>) => { stored.value = v }),
    clear: vi.fn().mockImplementation(async () => { stored.value = null }),
  }
  const ssivc = opts.withoutQuoteMethods
    ? { createSessionChallenge, createSessionSettle, createSessionWithReceipt, getSession }
    : { createSessionChallenge, createSessionSettle, createSessionWithReceipt, getSession, quoteSession, startSession }
  const deps = {
    ssivc,
    signHexBlob,
    messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
    mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
    pay,
    publicKeyHex: 'b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b',
    address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
    holderDid: 'did:zid:owner123',
    now: () => new Date('2026-10-22T09:00:00.000Z'),
    sessionStore,
    verifiedTemplateId: 'did:zid:verified-template',
    cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
    quarantine: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      filePathFor: vi.fn((vcId: string) => `/state/${vcId}.json`),
      withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()),
    },
  }
  return { deps, quoteSession, startSession, createSessionChallenge, createSessionWithReceipt, getSession, signHexBlob, pay, sessionStore, stored }
}

const run = (deps: unknown, input: Record<string, unknown>) => requestAiBirthcertVerification(deps as never, input as never) as Promise<Record<string, any>>

describe('the dry run (credential_preflight) asks SSIVC\'s quote', () => {
  it('sends no agent name, no id and no optional fields, and signs exactly what it sends', async () => {
    const { deps, quoteSession, signHexBlob, createSessionChallenge } = makeDeps()

    await run(deps, { agentName: 'placeholder', dryRun: true, agentPurpose: 'should not be sent' })

    expect(createSessionChallenge).not.toHaveBeenCalled()
    const body = (quoteSession.mock.calls as unknown as Array<[Record<string, string>]>)[0][0]
    expect(Object.keys(body).sort()).toEqual(['address', 'ownerReference', 'publicKey', 'signedData', 'timestamp'])
    expect(body.ownerReference).toBe('did:zid:owner123')
    expect(body.timestamp).toBe('2026-10-22T09:00:00Z')
    expect(body.signedData).toBe('sig-hex')
    const { signedData: _s, ...fields } = body
    expect(signHexBlob).toHaveBeenCalledWith(createHash('sha256').update(canonicalizeJson(fields), 'utf8').digest('hex'))
  })

  it('reports a free session: paymentRequired false, the indicative price, and the option that would be used', async () => {
    const { deps } = makeDeps()
    const out = await run(deps, { agentName: 'x', dryRun: true })

    expect(out.quote).toEqual({ asset: JMYR, maxAmountRequired: '0', payTo: 'ZTX3Pay', gasModel: 'sponsored', paymentRequired: false })
  })

  it('reports a charging session: paymentRequired true and the price', async () => {
    const { deps } = makeDeps({ quote: { paymentRequired: true, accepts: [PAID_OPTION, PAID_FACILITATOR] } })
    const out = await run(deps, { agentName: 'x', dryRun: true })

    expect(out.quote).toMatchObject({ maxAmountRequired: '1000000', paymentRequired: true })
  })

  it('leaves paymentRequired out when SSIVC did not say, so it is never read as free', async () => {
    const { deps } = makeDeps({ quote: { paymentRequired: undefined, accepts: [PAID_OPTION] } })
    const out = await run(deps, { agentName: 'x', dryRun: true })

    expect(out.quote).not.toHaveProperty('paymentRequired')
  })

  it('uses the 402 check when this SSIVC has no quote route', async () => {
    const { deps, startSession } = makeDeps({ noQuoteRoute: true })
    const out = await run(deps, { agentName: 'x', dryRun: true })

    expect(startSession).toHaveBeenCalledTimes(1)
    expect(out.quote).toMatchObject({ maxAmountRequired: '1000000' })
    expect(out.quote).not.toHaveProperty('paymentRequired')
  })

  it('with no quote route on an SSIVC that is not charging, reports it free and saves nothing', async () => {
    const { deps, sessionStore, pay } = makeDeps({ noQuoteRoute: true, start: CREATED })
    const out = await run(deps, { agentName: 'placeholder', dryRun: true })

    expect(out.quote).toMatchObject({ maxAmountRequired: '0', paymentRequired: false })
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('never sends the user\'s name or details when it has to probe with a session request', async () => {
    for (const start of [CREATED, CHARGING]) {
      const { deps, startSession } = makeDeps({ noQuoteRoute: true, start: start as never })
      await run(deps, { agentName: 'Procurement Assistant', agentPurpose: 'buying', ownerType: 'person', dryRun: true })

      const body = (startSession.mock.calls as unknown as Array<[Record<string, string>]>)[0][0]
      expect(body.agentName).toMatch(/^price-check-/)
      expect(body.id).toBe(body.agentName)
      expect(JSON.stringify(body)).not.toMatch(/Procurement Assistant|buying|person/)
    }
  })

  it('uses a different throwaway name each time', async () => {
    const names = new Set<string>()
    for (let i = 0; i < 3; i++) {
      const { deps, startSession } = makeDeps({ noQuoteRoute: true, start: CHARGING as never })
      await run(deps, { agentName: 'x', dryRun: true })
      names.add((startSession.mock.calls as unknown as Array<[Record<string, string>]>)[0][0].agentName)
    }
    expect(names.size).toBe(3)
  })

  it('reports a free quote with no options (or none usable) as free, as the request would start free', async () => {
    for (const accepts of [[], [{ ...FACILITATOR_OPTION, extra: { gasModel: 'facilitator' } }]]) {
      const { deps } = makeDeps({ quote: { paymentRequired: false, accepts } })
      const out = await run(deps, { agentName: 'x', dryRun: true })
      expect(out.quote).toMatchObject({ maxAmountRequired: '0', paymentRequired: false })
    }
  })

  it('uses the 402 check when the SSIVC client has no quote method at all', async () => {
    const { deps, createSessionChallenge } = makeDeps({ withoutQuoteMethods: true })
    await run(deps, { agentName: 'x', dryRun: true })
    expect(createSessionChallenge).toHaveBeenCalledTimes(1)
  })

  it('lets a quote error (bad signature, stale timestamp) surface rather than guessing', async () => {
    const { deps } = makeDeps({ quoteError: new SsivcError('Signature Verification failed.', 400, '50') })
    await expect(run(deps, { agentName: 'x', dryRun: true })).rejects.toBeInstanceOf(SsivcError)
  })

  it('says so when it charges and no option in the quote can be used', async () => {
    const onlyUnusable = { ...FACILITATOR_OPTION, extra: { gasModel: 'facilitator' } }
    const { deps } = makeDeps({ quote: { paymentRequired: true, accepts: [onlyUnusable] } })
    const out = await run(deps, { agentName: 'x', dryRun: true })
    expect(out.error).toMatch(/no usable payment options/)
  })

  it('never creates a session or spends: no start, no pay, nothing saved', async () => {
    const { deps, startSession, pay, sessionStore } = makeDeps()
    await run(deps, { agentName: 'x', dryRun: true })
    expect(startSession).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(sessionStore.set).not.toHaveBeenCalled()
  })
})

describe('a session SSIVC does not charge for', () => {
  it('is started with no payment and no price to confirm, with the user\'s real name', async () => {
    const { deps, startSession, pay, createSessionChallenge, sessionStore } = makeDeps()

    const out = await run(deps, { agentName: 'Procurement Assistant' })

    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(startSession).toHaveBeenCalledTimes(1)
    const body = (startSession.mock.calls as unknown as Array<[Record<string, string>]>)[0][0]
    expect(body.agentName).toBe('Procurement Assistant')
    expect(body.id).toBe('Procurement Assistant')
    expect(out).toMatchObject({ sessionId: 's-free', verificationUrl: 'https://zvg.test/verify/free', paidThisCall: false, nextStep: 'show_link_and_wait' })
    expect(out.needsConfirmation).toBeUndefined()
    expect(sessionStore.set).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-free', agentName: 'Procurement Assistant', paymentReceipt: '' }))
  })

  it('says nothing was paid, and tells the agent not to ask for a fee', async () => {
    const { deps } = makeDeps()
    const out = await run(deps, { agentName: 'x' })
    expect(out.message).toMatch(/^No payment was needed/)
    expect(out.message).toMatch(/do not ask them to agree to a fee/i)
    expect(out.message).not.toMatch(/already paid for/)
  })

  it('says which name it was started for, so a mistake is caught before the user verifies', async () => {
    const { deps } = makeDeps()
    const out = await run(deps, { agentName: 'Procurement Assistant', agentPurpose: 'buying' })
    expect(out.message).toMatch(/agentName "Procurement Assistant" and the details you gave/)
  })

  it('still hands back the link when the wallet cannot save the session', async () => {
    const { deps, sessionStore } = makeDeps()
    sessionStore.set.mockRejectedValue(new Error('EPERM'))
    const out = await run(deps, { agentName: 'x' })
    expect(out).toMatchObject({ sessionId: 's-free', verificationUrl: 'https://zvg.test/verify/free', paidThisCall: false })
    expect(out.message).toMatch(/could not save the session/)
    expect(out.message).not.toMatch(/  /)
    expect(out.message).not.toMatch(/message me again|check the status then/i)
  })

  it('starts free on a confirm that was valid for an earlier price, paying nothing', async () => {
    const { deps, quoteSession, startSession, pay } = makeDeps({ quote: { paymentRequired: true, accepts: [PAID_OPTION, PAID_FACILITATOR] } })
    const stop = await run(deps, { agentName: 'x' })
    expect(stop.needsConfirmation).toBe(true)
    quoteSession.mockResolvedValue({ paymentRequired: false, accepts: [CLIENT_OPTION, FACILITATOR_OPTION] } as never)
    startSession.mockResolvedValue(CREATED as never)

    const out = await run(deps, { agentName: 'x', confirm: stop.quote })

    expect(out).toMatchObject({ sessionId: 's-free', paidThisCall: false })
    expect(pay).not.toHaveBeenCalled()
  })

  it('needs no confirm, and does not mind one being sent', async () => {
    const { deps, pay } = makeDeps()
    const out = await run(deps, { agentName: 'x', confirm: { asset: 'whatever' } })
    expect(out.sessionId).toBe('s-free')
    expect(pay).not.toHaveBeenCalled()
  })

  it('carries the optional details the user gave', async () => {
    const { deps, startSession, sessionStore } = makeDeps()
    await run(deps, { agentName: 'x', agentPurpose: 'procurement' })
    expect((startSession.mock.calls as unknown as Array<[Record<string, string>]>)[0][0].agentPurpose).toBe('procurement')
    expect(sessionStore.set).toHaveBeenCalledWith(expect.objectContaining({ agentPurpose: 'procurement' }))
  })
})

describe('anything short of an explicit "no payment needed" keeps asking before it pays', () => {
  const stopsAtThePrice = (out: Record<string, any>) => {
    expect(out.needsConfirmation).toBe(true)
    expect(out.paidThisCall).toBe(false)
    expect(out.nextStep).toBe('ask_user_to_confirm_payment')
  }

  it('SSIVC says it charges', async () => {
    const { deps, startSession, pay, sessionStore } = makeDeps({ quote: { paymentRequired: true, accepts: [PAID_OPTION, PAID_FACILITATOR] } })
    stopsAtThePrice(await run(deps, { agentName: 'x' }))
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('SSIVC does not say (no paymentRequired in the quote)', async () => {
    const { deps, pay, sessionStore } = makeDeps({ quote: { paymentRequired: undefined, accepts: [PAID_OPTION, PAID_FACILITATOR] } })
    stopsAtThePrice(await run(deps, { agentName: 'x' }))
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('the quote cannot be read', async () => {
    const { deps, pay, sessionStore } = makeDeps({ quoteError: new Error('timeout') })
    stopsAtThePrice(await run(deps, { agentName: 'x' }))
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('this SSIVC has no quote route', async () => {
    const { deps, sessionStore } = makeDeps({ noQuoteRoute: true })
    stopsAtThePrice(await run(deps, { agentName: 'x' }))
    expect(sessionStore.set).not.toHaveBeenCalled()
  })

  // A free SSIVC whose quote cannot be used still answers the first call with a session, which is real: it is kept and
  // handed back, never thrown away.
  it.each([
    ['the quote cannot be read', { quoteError: new Error('timeout') }],
    ['SSIVC does not say whether it charges', { quote: { paymentRequired: undefined, accepts: [CLIENT_OPTION] } }],
    ['this SSIVC has no quote route', { noQuoteRoute: true }],
    ['the quote has no options', { quote: { paymentRequired: undefined, accepts: [] } }],
  ])('%s, but SSIVC answers the request with a session: it is kept and returned as free', async (_name, opts) => {
    const { deps, pay, sessionStore } = makeDeps({ ...opts, start: CREATED } as never)
    const out = await run(deps, { agentName: 'Procurement Assistant' })

    expect(out).toMatchObject({ sessionId: 's-free', verificationUrl: 'https://zvg.test/verify/free', paidThisCall: false, nextStep: 'show_link_and_wait' })
    expect(out.message).toMatch(/^No payment was needed/)
    expect(sessionStore.set).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-free', agentName: 'Procurement Assistant', paymentReceipt: '' }))
    expect(pay).not.toHaveBeenCalled()
  })

  it('a taken name on a free SSIVC with an unreadable quote gets the name message, not a raw error, and saves nothing', async () => {
    const err = new SsivcError('agent name already in use', 409, '26', 'agent_name_in_use')
    const { deps, sessionStore, pay } = makeDeps({ quoteError: new Error('timeout'), startError: err })

    const out = await run(deps, { agentName: 'Taken' })

    expect(out.error).toMatch(/AGENT NAME ALREADY IN USE/)
    expect(out.error).toMatch(/Nothing was paid/)
    expect(out.error).not.toMatch(/no session was created/)
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('the same on a confirmed call: a session SSIVC makes instead of asking for payment is kept, and nothing is paid', async () => {
    const { deps, startSession, pay, sessionStore } = makeDeps({ quote: { paymentRequired: true, accepts: [PAID_OPTION, PAID_FACILITATOR] } })
    const stop = await run(deps, { agentName: 'x' })
    startSession.mockResolvedValue(CREATED as never)

    const out = await run(deps, { agentName: 'x', confirm: stop.quote })

    expect(out).toMatchObject({ sessionId: 's-free', paidThisCall: false })
    expect(out.message).toMatch(/^No payment was needed/)
    expect(sessionStore.set).toHaveBeenCalledWith(expect.objectContaining({ paymentReceipt: '' }))
    expect(pay).not.toHaveBeenCalled()
  })

  it('the SSIVC client cannot start a session without payment', async () => {
    const { deps, pay } = makeDeps({ withoutQuoteMethods: true })
    stopsAtThePrice(await run(deps, { agentName: 'x' }))
    expect(pay).not.toHaveBeenCalled()
  })

  it('the quote said free but SSIVC then asked for payment: it stops at that price with one request, saves nothing and pays nothing', async () => {
    const { deps, pay, sessionStore, startSession } = makeDeps({ start: CHARGING as never })
    const out = await run(deps, { agentName: 'x' })
    stopsAtThePrice(out)
    expect(out.quote).toMatchObject({ maxAmountRequired: '1000000' })
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(pay).not.toHaveBeenCalled()
    expect(sessionStore.set).not.toHaveBeenCalled()
  })
})

describe('a free session that fails', () => {
  it('a taken name is refused with a message that says only that, and nothing is saved', async () => {
    const err = new SsivcError('agent name already in use', 409, '26', 'agent_name_in_use')
    const { deps, sessionStore, pay } = makeDeps({ startError: err })

    const out = await run(deps, { agentName: 'Taken' })

    expect(out.error).toMatch(/AGENT NAME ALREADY IN USE/)
    expect(out.error).toMatch(/Nothing was paid/)
    expect(out.error).not.toMatch(/fee may have been spent/i)
    expect(out.error).not.toMatch(/Do NOT pay again/)
    expect(sessionStore.set).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('any other failure surfaces and saves nothing', async () => {
    const { deps, sessionStore } = makeDeps({ startError: new SsivcError('boom', 500) })
    await expect(run(deps, { agentName: 'x' })).rejects.toThrow('boom')
    expect(sessionStore.set).not.toHaveBeenCalled()
  })
})

describe('a saved session that needed no payment has no receipt, and is never treated as one', () => {
  const freeRecord = { sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-10-22T08:00:00Z', verificationUrl: 'https://zvg.test/verify/old', paymentReceipt: '', holderDid: 'did:zid:owner123' }

  it('the same name while its link is open hands the same link back, saying no payment was made', async () => {
    const { deps, startSession, stored } = makeDeps()
    stored.value = freeRecord

    const out = await run(deps, { agentName: 'Procurement Assistant' })

    expect(out).toMatchObject({ sessionId: 's-old', paidThisCall: false })
    expect(out.message).toMatch(/^No payment was made on this call/)
    expect(out.message).not.toMatch(/already paid for/)
    expect(startSession).not.toHaveBeenCalled()
  })

  it.each(['expired', 'issued'])('once it is %s, a new request starts a new free session instead of replaying a receipt', async (status) => {
    const { deps, startSession, createSessionWithReceipt, getSession, stored } = makeDeps()
    stored.value = freeRecord
    getSession.mockResolvedValue({ sessionId: 's-old', status, expiresAt: '2026-10-22T08:30:00+00:00' })

    const out = await run(deps, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(out.sessionId).toBe('s-free')
  })

  it('a session SSIVC no longer knows starts a new one, not a replay', async () => {
    const { deps, startSession, createSessionWithReceipt, getSession, stored } = makeDeps()
    stored.value = freeRecord
    getSession.mockRejectedValue(new SsivcError('not found', 404, '23'))

    await run(deps, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(startSession).toHaveBeenCalledTimes(1)
  })

  it('another name while a free session is still open starts a new one: nothing was paid, so nothing is at risk', async () => {
    const { deps, startSession, stored } = makeDeps()
    stored.value = freeRecord

    const out = await run(deps, { agentName: 'A Different Agent' })

    expect(out).toMatchObject({ sessionId: 's-free', paidThisCall: false })
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(stored.value).toMatchObject({ agentName: 'A Different Agent', paymentReceipt: '' })
  })

  it('another name while a PAID session is still open stays blocked', async () => {
    const { deps, startSession, stored } = makeDeps()
    stored.value = { ...freeRecord, paymentReceipt: 'receipt-1' }

    const out = await run(deps, { agentName: 'A Different Agent' })

    expect(out.error).toMatch(/still in progress/)
    expect(out.error).toMatch(/payment has not been consumed/)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('is not reported as an earlier payment the next link would reuse', async () => {
    const { deps, stored } = makeDeps()
    stored.value = freeRecord
    expect(await findUnusedVerificationPayment(deps as never)).toBeUndefined()
  })

  it('has no receipt to discard when asked to pay fresh', async () => {
    const { deps, stored, startSession } = makeDeps()
    stored.value = freeRecord

    const out = await run(deps, { agentName: 'Procurement Assistant', discardStuckReceiptAndPayFresh: 'anything' })

    expect(out.error).toMatch(/needed no payment, so there is no receipt to discard/)
    expect(startSession).not.toHaveBeenCalled()
  })

  it('has no receipt to clear', async () => {
    const { deps, stored } = makeDeps()
    stored.value = freeRecord

    const out = await clearStuckPaymentReceipt(deps as never, {})

    expect(out).toMatchObject({ cleared: false })
    expect((out as { message?: string }).message).toMatch(/started without a payment/)
    expect(deps.sessionStore.clear).not.toHaveBeenCalled()
  })

  it('check_ still reports the link of a free session that is pending', async () => {
    const { deps, stored, getSession } = makeDeps()
    stored.value = freeRecord
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'pending', expiresAt: '2026-10-22T09:30:00+00:00' })

    const out = (await checkAiBirthcertVerification(deps as never)) as Record<string, unknown>

    expect(out).toMatchObject({ sessionId: 's-old', status: 'pending', verificationUrl: 'https://zvg.test/verify/old' })
  })
})

describe('credential_preflight for the Verified kind, end to end through the quote', () => {
  function preflightDeps(opts: Parameters<typeof makeDeps>[0], balance: string) {
    const made = makeDeps(opts)
    const quoteVerified = vi.fn((input: Record<string, unknown>) => requestAiBirthcertVerification(made.deps as never, input as never))
    return {
      made,
      deps: {
        quoteVerified,
        quoteTemplate: vi.fn(),
        queryTokenBalance: vi.fn(async (token: string) => ({ token: token === JMYR ? 'JMYR' : token.toUpperCase(), balance, decimals: 6, display: `${Number(balance) / 1e6} JMYR` })),
        caps: { '*': '0' },
      },
    }
  }

  it('is ready with an empty wallet and a zero spending limit when SSIVC charges nothing, and creates nothing', async () => {
    const { deps, made } = preflightDeps({}, '0')

    const out = await credentialPreflight(deps as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(out.ready).toBe(true)
    expect(out.blockers).toEqual([])
    expect(out.fee).toMatchObject({ paymentRequired: false })
    expect(made.startSession).not.toHaveBeenCalled()
    expect(made.pay).not.toHaveBeenCalled()
    expect(made.sessionStore.set).not.toHaveBeenCalled()
  })

  it('still blocks on balance and the limit when SSIVC charges', async () => {
    const { deps } = preflightDeps({ quote: { paymentRequired: true, accepts: [PAID_OPTION, PAID_FACILITATOR] } }, '0')

    const out = await credentialPreflight(deps as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/Not enough JMYR/)
  })

  it('still blocks when SSIVC does not say whether it charges', async () => {
    const { deps } = preflightDeps({ quote: { paymentRequired: undefined, accepts: [PAID_OPTION, PAID_FACILITATOR] } }, '0')

    const out = await credentialPreflight(deps as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(out.ready).toBe(false)
    expect(out.blockers.join(' ')).toMatch(/Not enough JMYR/)
  })
})
