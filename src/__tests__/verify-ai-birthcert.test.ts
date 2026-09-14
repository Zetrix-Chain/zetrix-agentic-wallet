import { describe, it, expect, vi } from 'vitest'
import { requestAiBirthcertVerification, checkAiBirthcertVerification } from '../orchestrator/verify-ai-birthcert'
import { PaymentReadinessError } from '../payment-readiness'
import { PaymentCapError } from '../payment-guard'
import { SsivcError } from '../clients/ssivc-client'

const SAMPLE_ACCEPT = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTX3Pay', maxAmountRequired: '1000', extra: [] }

function makeDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const createSessionChallenge = vi.fn().mockResolvedValue({ x402Version: 2, accepts: [SAMPLE_ACCEPT] })
  const createSessionSettle = vi.fn().mockResolvedValue({
    session: { sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' },
    paymentReceipt: 'receipt-1',
  })
  const createSessionWithReceipt = vi.fn().mockResolvedValue({
    session: { sessionId: 's-2', verificationUrl: 'https://zvg.test/verify/tok2', expiresAt: '2026-08-17T10:00:00+00:00' },
    paymentReceipt: 'receipt-1',
  })
  const getSession = vi.fn().mockResolvedValue({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' })
  const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 'deadbeef-sig', publicKey: 'b001pk' })
  const pay = vi.fn().mockResolvedValue('BASE64PAYMENT')
  const stored: { value: Record<string, unknown> | null } = { value: null }
  const sessionStore = {
    get: vi.fn().mockImplementation(async () => stored.value),
    set: vi.fn().mockImplementation(async (s: Record<string, unknown>) => { stored.value = s }),
  }
  const deps = {
    ssivc: { createSessionChallenge, createSessionSettle, createSessionWithReceipt, getSession },
    signHexBlob,
    messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
    // Real MbiClient.downloadVcs now always resolves an array or throws (never undefined) —
    // match that contract in the default mock rather than relying on a since-removed `?? []`.
    mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
    pay,
    publicKeyHex: 'b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b',
    address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
    holderDid: 'did:zid:owner123',
    now: () => new Date('2026-08-17T09:00:00.000Z'),
    sessionStore,
    verifiedTemplateId: 'did:zid:verified-template',
    cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
    // R2-M01: keyed by vcId — get(vcId) returns that vcId's entry or null, never another's.
    quarantine: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      filePathFor: vi.fn((vcId: string) => `/state/ssivc-download-quarantine/${vcId}.json`),
    },
    ...overrides,
  }
  return { deps, createSessionChallenge, createSessionSettle, createSessionWithReceipt, getSession, signHexBlob, pay, sessionStore }
}

describe('requestAiBirthcertVerification', () => {
  it('with no prior session: pays fresh — challenge -> pay(accept) -> settle(body, xPayment)', async () => {
    const { deps, createSessionChallenge, createSessionSettle, createSessionWithReceipt, pay } = makeDeps()

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(createSessionChallenge).toHaveBeenCalledTimes(1)
    expect(pay).toHaveBeenCalledWith(SAMPLE_ACCEPT)
    expect(createSessionSettle).toHaveBeenCalledWith(createSessionChallenge.mock.calls[0][0], 'BASE64PAYMENT')
    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(out).toEqual({ sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' })
  })

  it('builds the request body: id mirrors agentName, ownerReference is the holderDid, publicKey/address come from deps', async () => {
    const { deps, createSessionChallenge } = makeDeps()

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    const body = createSessionChallenge.mock.calls[0][0]
    expect(body.agentName).toBe('Procurement Assistant')
    expect(body.id).toBe('Procurement Assistant')
    expect(body.ownerReference).toBe('did:zid:owner123')
    expect(body.publicKey).toBe('b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b')
    expect(body.address).toBe('ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw')
    expect(body.timestamp).toBe('2026-08-17T09:00:00Z')
    expect(body.signedData).toBe('deadbeef-sig')
  })

  it('omits optional fields entirely when not supplied', async () => {
    const { deps, createSessionChallenge } = makeDeps()
    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    const body = createSessionChallenge.mock.calls[0][0]
    expect(body.agentPurpose).toBeUndefined()
    expect(body.evidenceAssuranceLevel).toBeUndefined()
    expect(body.ownerType).toBeUndefined()
    expect(body.ownerVerified).toBeUndefined()
  })

  it('passes through optional fields when supplied', async () => {
    const { deps, createSessionChallenge } = makeDeps()
    await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant', agentPurpose: 'Negotiate invoices',
      evidenceAssuranceLevel: 'high', ownerType: 'Individual', ownerVerified: 'true',
    })
    const body = createSessionChallenge.mock.calls[0][0]
    expect(body.agentPurpose).toBe('Negotiate invoices')
    expect(body.evidenceAssuranceLevel).toBe('high')
    expect(body.ownerType).toBe('Individual')
    expect(body.ownerVerified).toBe('true')
  })

  // The body is rebuilt (and re-signed) once per SSIVC call — one for the 402 challenge, one for
  // the paid settle attempt — rather than reused byte-for-byte, so that a retry loop (Task 4) can
  // never send a stale timestamp/signedData pair. With fixed `now`/`signHexBlob` mocks the two
  // resulting bodies are byte-identical anyway, so this is invisible to every other assertion.
  it('signs the SHA-256 digest of the canonical JSON of the body (minus signedData) via signHexBlob', async () => {
    const { deps, signHexBlob } = makeDeps()
    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    expect(signHexBlob).toHaveBeenCalledTimes(2)
    expect(signHexBlob.mock.calls[0][0] as string).toMatch(/^[0-9a-f]{64}$/)
  })

  it('persists sessionId, agentName, verificationUrl and the settlement receipt to the session store', async () => {
    const { deps, sessionStore } = makeDeps()
    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    expect(sessionStore.set).toHaveBeenCalledWith({
      sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-17T09:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/tok', paymentReceipt: 'receipt-1',
    })
    expect(out).toEqual({ sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' })
  })

  it('rejects a blank agentName before calling out', async () => {
    const { deps, createSessionChallenge, pay } = makeDeps()
    await expect(requestAiBirthcertVerification(deps as never, { agentName: '  ' })).rejects.toThrow(/agentName/)
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('when the stored session (same agentName) is still pending: returns it as-is, pays nothing, creates nothing new', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'pending', expiresAt: '2026-08-17T08:30:00+00:00' })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(getSession).toHaveBeenCalledWith('s-old')
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(out).toEqual({ sessionId: 's-old', verificationUrl: 'https://zvg.test/verify/old-tok', expiresAt: '2026-08-17T08:30:00+00:00' })
  })

  // APP-M03 / SEC-13: only `issued` ever consumes the settlement receipt (SPEC.md §634) — every
  // other confirmed terminal status ("expired" confirmed live 2026-08-28: the owner never completed
  // the MyDigital ID link before the session's TTL elapsed) leaves it unconsumed, so it must be
  // replayed exactly like the 404/"gone" case (the next test), never failed closed.
  it('when the stored session (same agentName) has expired (owner never completed MyDigital ID verification in time): replays the receipt instead of blocking', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'expired', expiresAt: '2026-08-17T08:30:00+00:00' })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-old')
  })

  // Same SEC-13 reasoning applies across the different-agentName branch (APP-M01): an expired prior
  // session for a DIFFERENT agent hasn't consumed its receipt either, so switching agentName must
  // replay it rather than block the way a still-`pending` other-agent session does (see the
  // "refuses to start a session for a DIFFERENT agentName while ... pending" test below).
  it('replays the stored receipt for a DIFFERENT agentName when the other agent’s session has expired', async () => {
    const { deps, sessionStore, getSession, pay, createSessionSettle, createSessionChallenge, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Some Other Agent', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'expired', expiresAt: '2026-08-17T08:30:00+00:00' })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-old')
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
  })

  it('when the stored session (same agentName) has vanished (getSession throws a 404 SsivcError): treats it as terminal and replays the receipt', async () => {
    const { deps, sessionStore, getSession, pay, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockRejectedValue(new SsivcError('SSIVC getSession failed — HTTP 404: not found', 404))

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(pay).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-old')
  })

  it('when getSession throws something other than a 404 SsivcError (transient error): propagates rather than replaying the receipt or paying fresh', async () => {
    const { deps, sessionStore, getSession, pay, createSessionWithReceipt, createSessionSettle } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockRejectedValue(new Error('ECONNRESET'))

    await expect(requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })).rejects.toThrow(/ECONNRESET/)

    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
  })

  it('when getSession throws a non-404 SsivcError (e.g. 503 facilitator_unavailable): propagates rather than replaying the receipt or paying fresh', async () => {
    const { deps, sessionStore, getSession, pay, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockRejectedValue(new SsivcError('SSIVC getSession failed — HTTP 503: unavailable', 503))

    await expect(requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })).rejects.toThrow(/503/)

    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('when the stored session (same agentName) is already issued: pays fresh instead of reusing the dead receipt', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'issued', expiresAt: '2026-08-17T08:30:00+00:00', vcId: 'did:zid:vc-old' })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    expect(pay).toHaveBeenCalledWith(SAMPLE_ACCEPT)
    expect(createSessionChallenge).toHaveBeenCalledTimes(1)
    expect(createSessionSettle).toHaveBeenCalledTimes(1)
  })

  // APP-M01: the store is a single slot. Switching to a different agentName while the stored
  // session's payment is still unconsumed would silently orphan it, so this must confirm the other
  // session's live status before proceeding rather than blindly overwriting.
  it('pays fresh for a DIFFERENT agentName once the stored session for the other agent is confirmed issued (receipt already dead)', async () => {
    const { deps, sessionStore, getSession, pay, createSessionSettle } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Some Other Agent', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'issued', expiresAt: '2026-08-17T08:30:00+00:00', vcId: 'did:zid:vc-old' })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(getSession).toHaveBeenCalledWith('s-old')
    expect(pay).toHaveBeenCalled()
    expect(createSessionSettle).toHaveBeenCalled()
  })

  // R2-L03: a 404'd session is a settled-but-orphaned receipt regardless of whose agentName is on
  // the stored record — so it must be replayed here exactly as it is for the same-agentName case,
  // not thrown away by paying fresh.
  it('replays the stored receipt for a DIFFERENT agentName when the other agent’s session is confirmed gone (404)', async () => {
    const { deps, sessionStore, getSession, pay, createSessionSettle, createSessionChallenge, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Some Other Agent', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockRejectedValue(new SsivcError('SSIVC getSession failed — HTTP 404: not found', 404))

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-old')
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
  })

  it('refuses to start a session for a DIFFERENT agentName while the stored session is still pending, and pays nothing', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Some Other Agent', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'pending', expiresAt: '2026-08-17T08:30:00+00:00' })
    sessionStore.set.mockClear() // clear the setup call above so the assertion below is about the SUT only

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({ error: expect.stringContaining('Some Other Agent') })
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).not.toHaveBeenCalled()
    // Refusing to proceed must not touch the existing record — it's the only handle on that receipt.
    expect(sessionStore.set).not.toHaveBeenCalled()
  })

  it('maps a PaymentReadinessError from pay() to a { error } result instead of throwing', async () => {
    const err = new PaymentReadinessError('insufficient ZTX for gas', { asset: 'ZTX', required: '100', available: '10', reason: 'gas' })
    const { deps } = makeDeps({ pay: vi.fn().mockRejectedValue(err) })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({
      error: expect.stringContaining('insufficient funds'),
      insufficientFunds: { asset: 'ZTX', required: '100', available: '10', reason: 'gas' },
    })
  })

  it('maps a PaymentCapError from pay() to a { error } result instead of throwing', async () => {
    const err = new PaymentCapError('payment blocked: requested 1000 ZTX exceeds configured MAX_PAYMENT_AMOUNT 0')
    const { deps } = makeDeps({ pay: vi.fn().mockRejectedValue(err) })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({ error: expect.stringContaining('MAX_PAYMENT_AMOUNT') })
  })

  // REQ-37/AC-17 (SPEC.md §5.1/§11): a 409 blob_already_settled must not surface as an
  // unhandled/opaque error to the MCP caller.
  it('maps a 409 blob_already_settled SsivcError from createSessionSettle to a { error } result instead of throwing', async () => {
    const err = new SsivcError('SSIVC request failed — HTTP 409: blob already settled', 409, undefined, 'blob_already_settled')
    const { deps } = makeDeps({
      ssivc: {
        createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [SAMPLE_ACCEPT] }),
        createSessionSettle: vi.fn().mockRejectedValue(err),
        createSessionWithReceipt: vi.fn(),
        getSession: vi.fn(),
      },
    })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({ error: expect.stringContaining('already settled') })
  })

  it('maps a 402 challenge with an empty accepts[] to a { error } result instead of throwing (mirrors subscribe.ts)', async () => {
    const noAcceptSsivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
      getSession: vi.fn(),
    }
    const { deps, pay } = makeDeps({ ssivc: noAcceptSsivc })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({ error: expect.stringContaining('payment options') })
    expect(pay).not.toHaveBeenCalled()
    expect(noAcceptSsivc.createSessionSettle).not.toHaveBeenCalled()
  })

  // APP-M02: the MCP host does not serialize tool calls, so two concurrent requests for the same
  // agentName must not both read "no session yet" before either writes one — that double-pays.
  it('serializes two concurrent requests for the same agentName so only one payment happens', async () => {
    const { deps, pay, createSessionSettle, getSession } = makeDeps()
    let releasePay: (v: string) => void = () => {}
    const paySignal = new Promise<string>((resolve) => { releasePay = resolve })
    pay.mockImplementation(() => paySignal)
    // Once the first call's session is stored, the second call's decidePriorSession sees it as
    // still pending and must reuse it rather than paying again — align the mock's expiresAt with
    // what call1 will actually create (createSessionSettle's default mock), so out1/out2 line up.
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-17T09:30:00+00:00' })

    const call1 = requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    await Promise.resolve().then(() => Promise.resolve()) // let call1 progress up to its await on pay()
    const call2 = requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    await Promise.resolve().then(() => Promise.resolve())

    releasePay('BASE64PAYMENT')
    const [out1, out2] = await Promise.all([call1, call2])

    expect(pay).toHaveBeenCalledTimes(1)
    expect(createSessionSettle).toHaveBeenCalledTimes(1)
    expect(out2).toEqual(out1)
    expect(getSession).toHaveBeenCalled() // call2's decidePriorSession checked the now-stored session
  })
})

const selfPayAccept = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTXpayee', maxAmountRequired: '1000000', extra: { gasModel: 'client' } }
const sponsoredAccept = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTXtoken', payTo: 'ZTXrecipient', maxAmountRequired: '5000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://proxy/ztx/facilitator/prepare' } }

/**
 * Thin helper for the sponsored-settlement-retry / self-pay-fallback tests: builds a full
 * `VerifyAiBirthcertDeps` from fixtures (overridden by `overrides`), calls
 * `requestAiBirthcertVerification`, and re-shapes the result as `{ session, error }` so assertions
 * read as `out.session?.sessionId` / `out.error` regardless of which branch fired.
 *
 * `now`/`signHexBlob` tick on every call (not just once) so that a body rebuilt across multiple
 * retry attempts is provably NOT byte-identical — this is what the "never reuses timestamp/
 * signedData" test below checks.
 */
async function runRequest(overrides: Partial<Record<string, unknown>> = {}) {
  let clockTick = 0
  let sigTick = 0
  const ssivc = {
    createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [SAMPLE_ACCEPT] }),
    createSessionSettle: vi.fn().mockResolvedValue({
      kind: 'settled',
      session: { sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' },
      paymentReceipt: 'receipt-1',
    }),
    createSessionWithReceipt: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' }),
  }
  const sessionStore = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  }
  const deps = {
    ssivc,
    signHexBlob: vi.fn().mockImplementation(async () => ({ signBlob: `sig-${++sigTick}`, publicKey: 'b001pk' })),
    messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
    mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
    pay: vi.fn().mockResolvedValue('BASE64PAYMENT'),
    publicKeyHex: 'b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b',
    address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
    holderDid: 'did:zid:owner123',
    now: () => new Date(Date.UTC(2026, 7, 17, 9, 0, clockTick++)),
    sessionStore,
    verifiedTemplateId: 'did:zid:verified-template',
    cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
    quarantine: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      filePathFor: vi.fn((vcId: string) => `/state/ssivc-download-quarantine/${vcId}.json`),
    },
    ...overrides,
  }
  const result = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
  return 'error' in (result as Record<string, unknown>)
    ? { session: undefined, error: (result as { error: string }).error }
    : { session: result as { sessionId: string; verificationUrl: string; expiresAt: string }, error: undefined }
}

// subscribe_and_issue already reports a shortfall as structured `insufficientFunds` alongside its
// prose reason. This path returned prose only, so a caller had to parse the sentence to learn which
// asset was short and by how much — and the skill renders guidance per shortfall `reason`.
describe('structured payment failures, matching subscribe_and_issue (R11)', () => {
  async function failWith(err: Error) {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [SAMPLE_ACCEPT] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
      getSession: vi.fn(),
    }
    const sessionStore = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    return (await requestAiBirthcertVerification(
      {
        ssivc,
        signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }),
        messageSigner: vi.fn(),
        mbi: { downloadVcs: vi.fn() },
        pay: vi.fn().mockRejectedValue(err),
        publicKeyHex: 'b001pk',
        address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
        holderDid: 'did:zid:owner123',
        now: () => new Date('2026-09-04T00:00:00Z'),
        sessionStore,
        quarantine: { get: vi.fn(), set: vi.fn(), filePathFor: vi.fn() },
      } as never,
      { agentName: 'Structured Failure Probe' },
    )) as Record<string, unknown>
  }

  it('reports a funds shortfall as structured insufficientFunds, not only prose', async () => {
    const shortfall = { asset: 'JMYR', required: '1000000', available: '0', reason: 'resource_payment' as const }
    const out = await failWith(new PaymentReadinessError('short 1 JMYR', shortfall))
    expect(out.error).toMatch(/insufficient funds/i)
    expect(out.insufficientFunds).toEqual(shortfall)
  })

  it('reports a cap refusal as structured paymentCap, so the applied key is machine-readable', async () => {
    const detail = { asset: 'JMYR', requiredRaw: '1000000', capRaw: '0', matchedKey: '*' }
    const out = await failWith(new PaymentCapError('payment blocked: ...', detail))
    expect(out.paymentCap).toEqual(detail)
  })
})

// Verified live against SSIVC UAT (2026-09-04): a correctly signed session request with no
// X-Payment header returns 402 with the full quote, repeatably, creating no server-side state. So a
// price can be known before any money moves — which is the whole point of preflight.
describe('dryRun: quote without paying (R2)', () => {
  it('returns the quote and never calls pay', async () => {
    const { deps } = makeDeps()
    const out = (await requestAiBirthcertVerification(deps as never, {
      agentName: 'Quote Probe',
      dryRun: true,
    })) as Record<string, unknown>

    expect(deps.pay).not.toHaveBeenCalled()
    expect(deps.ssivc.createSessionSettle).not.toHaveBeenCalled()
    expect(out.quote).toMatchObject({ asset: 'ZTX', maxAmountRequired: '1000', payTo: 'ZTX3Pay' })
  })

  it('creates no session and writes nothing to the session store', async () => {
    const { deps } = makeDeps()
    await requestAiBirthcertVerification(deps as never, { agentName: 'Quote Probe', dryRun: true })
    expect(deps.sessionStore.set).not.toHaveBeenCalled()
  })

  it('does not consult a prior session — a quote is independent of one being in flight', async () => {
    const { deps, sessionStore } = makeDeps()
    await sessionStore.set({ sessionId: 's-live', agentName: 'Someone Else', createdAt: 'x', verificationUrl: 'u', paymentReceipt: 'r' })
    sessionStore.get.mockClear()

    const out = (await requestAiBirthcertVerification(deps as never, {
      agentName: 'Quote Probe',
      dryRun: true,
    })) as Record<string, unknown>

    // A pending session for a DIFFERENT agent blocks a real request (APP-M01). It must not block a
    // free quote — otherwise preflight cannot answer while anything is in flight.
    expect(out.quote).toBeDefined()
    expect(out.error).toBeUndefined()
  })

  it('reports the gas model as sponsored when the server offers a facilitator option (R12)', async () => {
    const { deps } = makeDeps()
    deps.ssivc.createSessionChallenge.mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] })
    const out = (await requestAiBirthcertVerification(deps as never, { agentName: 'Q', dryRun: true })) as Record<string, unknown>
    expect(out.quote).toMatchObject({ gasModel: 'sponsored', asset: 'ZTXtoken', maxAmountRequired: '5000' })
  })

  it('reports the gas model as self when only a self-pay option is quoted (R12)', async () => {
    const { deps } = makeDeps()
    deps.ssivc.createSessionChallenge.mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept] })
    const out = (await requestAiBirthcertVerification(deps as never, { agentName: 'Q', dryRun: true })) as Record<string, unknown>
    expect(out.quote).toMatchObject({ gasModel: 'self' })
  })

  it('honours a gasPayer override when quoting, so the quote matches what would actually be paid', async () => {
    const { deps } = makeDeps()
    deps.ssivc.createSessionChallenge.mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] })
    const out = (await requestAiBirthcertVerification(deps as never, {
      agentName: 'Q',
      dryRun: true,
      gasPayer: 'self',
    })) as Record<string, unknown>
    expect(out.quote).toMatchObject({ gasModel: 'self', asset: 'ZTX' })
  })

  it('reports an error rather than a quote when the server offers nothing usable', async () => {
    const { deps } = makeDeps()
    deps.ssivc.createSessionChallenge.mockResolvedValue({ x402Version: 2, accepts: [] })
    const out = (await requestAiBirthcertVerification(deps as never, { agentName: 'Q', dryRun: true })) as Record<string, unknown>
    expect(out.error).toMatch(/no usable payment options/i)
    expect(out.quote).toBeUndefined()
  })
})

describe('sponsored settlement retry', () => {
  it('retries with the receipt until settled, then returns the session', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn()
        .mockResolvedValueOnce({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 })
        .mockResolvedValueOnce({ kind: 'settled', session: { sessionId: 's-9', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r1' }),
    }
    const sleep = vi.fn().mockResolvedValue(undefined)
    const out = await runRequest({ ssivc, sleep })

    expect(out.session?.sessionId).toBe('s-9')
    expect(ssivc.createSessionSettle).toHaveBeenCalledTimes(1)
    expect(ssivc.createSessionWithReceipt).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('sends a freshly signed body on every retry — never reuses timestamp/signedData', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn()
        .mockResolvedValueOnce({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 })
        .mockResolvedValueOnce({ kind: 'settled', session: { sessionId: 's-9', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r1' }),
    }
    await runRequest({ ssivc, sleep: vi.fn().mockResolvedValue(undefined) })

    const bodies = ssivc.createSessionWithReceipt.mock.calls.map((c: unknown[]) => c[0] as { signedData: string; timestamp: string })
    expect(bodies[0].signedData).not.toEqual(bodies[1].signedData)
    expect(bodies[0].timestamp).not.toEqual(bodies[1].timestamp)
  })

  it('never sends X-Payment on a retry — receipt only (REQ-32)', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'settled', session: { sessionId: 's-9', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r1' }),
    }
    const pay = vi.fn().mockResolvedValue('xpay-blob')
    await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })
    expect(pay).toHaveBeenCalledTimes(1) // paid once, never re-paid on retry
  })

  it('gives up with a clear error after the retry budget, without re-paying', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
    }
    const pay = vi.fn().mockResolvedValue('xpay-blob')
    const out = await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 3 })
    expect(out.error).toMatch(/still settling|payment is being processed/i)
    expect(pay).toHaveBeenCalledTimes(1)
  })

  // Finding-1 fix: an SsivcError with an UNRECOGNIZED kind (not 'blob_already_settled', not any of
  // the other classified kinds) on a receipt-retry call must not surface as a silent, unhandled,
  // permanently-bricking exception. Before the fix, this propagated raw out of resolveSettlement,
  // through payAndCreateSession, past the outer catch's instanceof ladder (matching none of its
  // branches), and hit the bare `throw err` fallthrough — an opaque unhandled rejection. It must now
  // resolve gracefully as a `{ error }` naming the receipt.
  it('a receipt-retry SsivcError with an unrecognized kind resolves gracefully with the receipt named, instead of throwing unhandled', async () => {
    // kind is deliberately undefined — this is exactly what SsivcClient.error() produces for a
    // genuine settlement-failure response (e.g. the proposed 402/status_code "64" in
    // SSIVC_PAYMASTER_CHANGES.md §3.8): the 402 body's `error` field isn't 'payment_invalid', so none
    // of error()'s kind classifications fire.
    const unrecognized = new SsivcError('SSIVC request failed — HTTP 402: sponsored settlement failed, payment required again', 402, '64', undefined)
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-failed', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockRejectedValue(unrecognized),
    }

    const out = await runRequest({ ssivc, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.error).toBeDefined()
    expect(out.error).toContain('r-failed')
    expect(out.error).toMatch(/could not be determined/i)
    expect(out.error).toMatch(/manual|investigation/i)
    // Must NOT be phrased as safely retryable, unlike SettlementStillQueuedError's message — this
    // outcome is not known-recoverable.
    expect(out.error).not.toMatch(/run.*again to resume/i)
  })

  // Same indeterminate-outcome guard applies to the OTHER call site: requestAiBirthcertVerificationLocked's
  // initial createSessionWithReceipt call on the `replay_receipt` path (a prior give-up record with
  // sessionId: '', resumed on a later call), not just the in-loop retry inside resolveSettlement.
  it('an unrecognized SsivcError on the replay_receipt path (resuming a give-up record) also resolves gracefully', async () => {
    const { deps, sessionStore } = makeDeps({
      ssivc: {
        createSessionChallenge: vi.fn(),
        createSessionSettle: vi.fn(),
        createSessionWithReceipt: vi.fn().mockRejectedValue(new SsivcError('SSIVC request failed — HTTP 402: settlement failed', 402, '64')),
        getSession: vi.fn(),
      },
    })
    await sessionStore.set({
      sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'receipt-replay-failed',
    })
    sessionStore.set.mockClear()

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out).toEqual({ error: expect.stringContaining('receipt-replay-failed') })
    expect(out).toEqual({ error: expect.stringMatching(/could not be determined/i) })
    // The stored record must be untouched — NOT cleared, NOT overwritten — so a future call does not
    // treat this as "safe to pay fresh" (which risks a double payment against a settlement that may
    // actually still be in flight).
    expect(sessionStore.set).not.toHaveBeenCalled()
  })

  // Fix wave (final review): persistQueuedReceipt already swallows its own store-write failures
  // internally (see the "does not abort settlement..." test below) — so if the store is failing for
  // a SYSTEMIC reason (ENOSPC, EPERM, an antivirus file-lock on Windows), that failure is silent
  // there. The SAME correlated failure then hits the give-up write too, but that write was
  // previously unguarded — letting it throw would replace the graceful "run again to resume"
  // message with a raw filesystem exception that never mentions a payment happened, and the
  // receipt would be lost everywhere. The result must stay a graceful `{ error }` whose message
  // still carries the receipt.
  it('gives up gracefully — with the receipt in the message — even when the give-up store write itself fails', async () => {
    const store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('EPERM: operation not permitted, rename')),
    }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-doomed', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-doomed', retryAfterSeconds: 1 }),
    }
    const pay = vi.fn().mockResolvedValue('xpay-blob')
    const out = await runRequest({ ssivc, pay, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 3 })

    expect(out.error).toBeDefined()
    expect(out.error).toMatch(/still settling|payment is being processed/i)
    expect(out.error).toContain('r-doomed')
    expect(pay).toHaveBeenCalledTimes(1) // still never re-paid
  })

  it('self-pay 200 completes with no retry at all', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'settled', session: { sessionId: 's-1', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r0' }),
      createSessionWithReceipt: vi.fn(),
    }
    const out = await runRequest({ ssivc, sleep: vi.fn() })
    expect(out.session?.sessionId).toBe('s-1')
    expect(ssivc.createSessionWithReceipt).not.toHaveBeenCalled()
  })

  // REQ-35: the receipt is the only handle on a real, already-paid settlement — a crash or the
  // caller giving up right after giving-up-with-an-error must not lose track of it.
  it('persists the receipt before giving up, so a later call can resume', async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-keep', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-keep', retryAfterSeconds: 1 }),
    }
    await runRequest({ ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 2 })
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ paymentReceipt: 'r-keep' }))
  })

  // Fix round 1: a give-up record has sessionId: '' (no session was ever created — see the
  // persist-before-giving-up test above). SSIVC 301-redirects a lookup against an empty path
  // segment rather than 404ing it, so decidePriorSession must short-circuit BEFORE calling
  // getSession at all — replaying the receipt directly, exactly as createSessionWithReceipt does
  // for a confirmed-404 (R2-L03) prior session. Asserting getSession is never called is the
  // regression this test exists to catch.
  it('resumes a give-up record (empty sessionId) by replaying the receipt, with NO getSession call', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'receipt-queued',
    })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(getSession).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-queued')
  })

  // Same short-circuit must apply even when the give-up record belongs to a DIFFERENT agentName:
  // the receipt is bound to the request body's signature, not to agentName (R2-L03), and there is
  // no real sessionId to confirm ownership against anyway.
  it('resumes a give-up record (empty sessionId) for a DIFFERENT agentName too, with NO getSession call', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: '', agentName: 'Some Other Agent', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'receipt-queued-other',
    })

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(getSession).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionSettle).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Procurement Assistant' }), 'receipt-queued-other')
  })

  // Fix round 2 / C1: persisting the receipt ONLY on give-up (SettlementStillQueuedError) loses it
  // if anything else throws mid-loop — a transient 5xx or network blip on retry N is far likelier
  // than exhausting the whole attempt budget over a loop that can run up to 20 minutes. The store
  // must already hold the receipt by the time such an error propagates, so a later call resumes by
  // replaying it instead of paying a second time.
  //
  // Finding-1 fix: a transient/unrecognized error from createSessionWithReceipt is INDETERMINATE
  // (SettlementOutcomeUnknownError), not an unhandled crash — it now surfaces as a graceful
  // { error } naming the receipt, exactly like SettlementStillQueuedError, rather than an opaque
  // unhandled rejection. This test previously asserted the (buggy) unhandled-throw behavior; it now
  // asserts the fixed graceful behavior while keeping its original receipt-persistence assertion.
  it('persists the receipt on the FIRST queued outcome, then reports a graceful indeterminate error if a later attempt throws', async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-first', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    }
    const out = await runRequest({ ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.error).toMatch(/could not be determined/i)
    expect(out.error).toContain('r-first')

    // The receipt from the very first (settle) queued response must already be in the store even
    // though the very next call (the first retry) threw before ever reaching give-up.
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ paymentReceipt: 'r-first' }))
  })

  it('persists an updated receipt if a later retry returns a DIFFERENT queued receipt before a transient throw, then reports the error gracefully', async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-first', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn()
        .mockResolvedValueOnce({ kind: 'queued', paymentReceipt: 'r-second', retryAfterSeconds: 1 })
        .mockRejectedValueOnce(new Error('ECONNRESET')),
    }
    const out = await runRequest({ ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.error).toMatch(/could not be determined/i)
    expect(out.error).toContain('r-second')
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ paymentReceipt: 'r-first' }))
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ paymentReceipt: 'r-second' }))
    // The last write reflects the latest live receipt, not a stale earlier one.
    expect(store.set.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ paymentReceipt: 'r-second' }))
    // The store's last write must still be the queued placeholder (sessionId: '') — the indeterminate
    // error path must NOT clear or overwrite it into something a future call would treat as safe to
    // pay fresh.
    expect(store.set.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ sessionId: '' }))
  })

  // Fix round 3: onQueued (persistQueuedReceipt) is awaited unguarded inside resolveSettlement, and
  // it performs a real filesystem write (see ssivc-session-store.ts's mkdir/writeFile/rename) that
  // can transiently reject (ENOSPC, EPERM, an antivirus/file-lock on the rename — a real hazard on
  // Windows). By the time this runs, deps.pay has already spent money — a rejection here must be
  // swallowed (best-effort) so the retry loop keeps going and can still reach a settled session,
  // rather than aborting with an opaque error in place of a graceful SettlementStillQueuedError.
  it('does not abort settlement when the queued-receipt persist write rejects — the loop still reaches settled', async () => {
    // Only the queued (placeholder, sessionId: '') persist write fails — the final success-path
    // write (with a real session) must still succeed so the overall call can complete cleanly and
    // prove the rejection was contained to the best-effort queued write, not a blanket store outage.
    const store = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockImplementation(async (record: { sessionId: string }) => {
        if (record.sessionId === '') throw new Error('EPERM: operation not permitted, rename')
      }),
    }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'settled', session: { sessionId: 's-9', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r1' }),
    }
    const out = await runRequest({ ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.error).toBeUndefined()
    expect(out.session?.sessionId).toBe('s-9')
    expect(ssivc.createSessionWithReceipt).toHaveBeenCalledTimes(1)
  })

  // Fix round 2 / I3: MAX_RETRY_DELAY_MS must actually cap what's passed to sleep — deleting the
  // Math.min(...) must fail this test. A misbehaving/absurd server-supplied retryAfterSeconds (the
  // brief's own example: 999999999) must not be honoured verbatim.
  it('caps an absurd retryAfterSeconds before sleeping on it', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 999_999_999 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'settled', session: { sessionId: 's-9', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r1' }),
    }
    const sleep = vi.fn().mockResolvedValue(undefined)
    await runRequest({ ssivc, sleep })

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(60_000)
    expect(sleep.mock.calls[0][0]).toBeLessThan(999_999_999 * 1000)
  })
})

describe('checkAiBirthcertVerification', () => {
  it('reports no_session when nothing has been requested yet', async () => {
    const { deps, getSession } = makeDeps()

    const out = await checkAiBirthcertVerification(deps as never)

    expect(getSession).not.toHaveBeenCalled()
    expect(out).toEqual({ status: 'no_session', message: expect.stringContaining('request_ai_birthcert_verification') })
  })

  // Fix round 2 / I1: a stored give-up record (sessionId: '') means a sponsored payment is still
  // settling and no session was ever created. Calling getSession('') hits SSIVC's 301 redirect on an
  // empty path segment, not a 404 — so this must be guarded before that call, not rethrown as an
  // opaque error, since this is exactly the tool call the give-up message tells the user to retry.
  it('reports settlement-still-pending (not a throw) when the stored record has no sessionId yet', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z', verificationUrl: '', paymentReceipt: 'r-queued' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(getSession).not.toHaveBeenCalled()
    expect(out).toEqual({
      status: 'no_session',
      message: expect.stringMatching(/still settling|request_ai_birthcert_verification.*again|not pay twice/i),
    })
  })

  it('checks the persisted sessionId and reports pending (no vcId)', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(getSession).toHaveBeenCalledWith('s-1')
    expect(out).toEqual({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' })
    expect(out.vcId).toBeUndefined()
  })

  // R13: "where is my link again?" must be answerable by this FREE tool. SSIVC's GET /sessions/{id}
  // never returns the verification URL — it is issued exactly once, at session creation — so without
  // this the only route back to the link is request_ai_birthcert_verification, the *paid* tool. That
  // costs nothing on the still-pending path, but it forces a spend-approval prompt to re-read a link
  // the user has already paid for, which teaches people to wave payment prompts through.
  it('hands back the stored verification link while the session is still pending', async () => {
    const { deps, sessionStore } = makeDeps()
    await sessionStore.set({
      sessionId: 's-1',
      agentName: 'Procurement Assistant',
      createdAt: '2026-08-13T09:00:00.000Z',
      verificationUrl: 'https://ssivc-api-uat.myegdev.com/verify/s-1',
    })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out).toMatchObject({
      status: 'pending',
      verificationUrl: 'https://ssivc-api-uat.myegdev.com/verify/s-1',
      // The expiry comes from SSIVC on every call, not from the store — the agent needs to say how
      // long the link is good for, and a locally cached value would go stale.
      expiresAt: '2026-08-13T09:30:00+00:00',
    })
  })

  // The link is only useful while the session is live. Once myid has issued, the link is spent, and
  // repeating it would send someone back to a MyDigital ID flow that is already finished.
  it('does not repeat the link once the credential has been issued', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({
      sessionId: 's-1',
      agentName: 'Procurement Assistant',
      createdAt: '2026-08-13T09:00:00.000Z',
      verificationUrl: 'https://ssivc-api-uat.myegdev.com/verify/s-1',
    })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out).not.toHaveProperty('verificationUrl')
  })

  it('reports vcId when status is issued', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out).toMatchObject({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
  })

  it('on issued: fetches the VC via MBI, verifies the subject, and caches it under the Verified template id', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc }, { vc: { id: 'did:zid:someone-elses-vc' } }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.mbi.downloadVcs).toHaveBeenCalledWith({ address: deps.address }, { signedData: 'sig', publicKey: 'b001pk' })
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1', vc })
    expect(deps.cache.set).toHaveBeenCalledWith('did:zid:verified-template', expect.objectContaining({
      templateId: 'did:zid:verified-template', vc, vcId: 'did:zid:vc-1', validUntil: '2028-08-13T00:00:00Z',
    }))
    // SEC-11/APP-C01: the full raw response (both entries, not just the matched one) must be
    // quarantined BEFORE the entries above were ever validated.
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({
      vcId: 'did:zid:vc-1', entries: [{ vc }, { vc: { id: 'did:zid:someone-elses-vc' } }],
    }))
  })

  // SEC-11/APP-C01: MBI's download is one-shot — a retry after a validation rejection must
  // re-validate the already-quarantined copy, not call MBI again (which would just 404).
  it('on issued: uses the quarantined copy instead of calling MBI again when one already exists for this vcId', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.quarantine.get = vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-1', entries: [{ vc }], downloadedAt: '2026-08-13T09:29:00Z' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.quarantine.get).toHaveBeenCalledWith('did:zid:vc-1')
    expect(deps.mbi.downloadVcs).not.toHaveBeenCalled()
    expect(deps.quarantine.set).not.toHaveBeenCalled() // already quarantined — nothing new to persist
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1', vc })
    expect(deps.cache.set).toHaveBeenCalled()
  })

  // R2-M01: the store is keyed by vcId, so an OTHER vcId's quarantined entry is simply not returned
  // for this vcId — and quarantining this one must not disturb it.
  it('on issued: downloads fresh when only a DIFFERENT vcId has been quarantined', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-new' })
    const quarantinedByVcId: Record<string, unknown> = {
      'did:zid:vc-old': { vcId: 'did:zid:vc-old', entries: [{ vc: { id: 'did:zid:vc-old' } }], downloadedAt: '2020-01-01T00:00:00Z' },
    }
    deps.quarantine.get = vi.fn(async (vcId: string) => quarantinedByVcId[vcId] ?? null)
    const freshVc = { id: 'did:zid:vc-new', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc: freshVc }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.quarantine.get).toHaveBeenCalledWith('did:zid:vc-new')
    expect(deps.mbi.downloadVcs).toHaveBeenCalled()
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({ vcId: 'did:zid:vc-new' }))
    expect(out).toMatchObject({ vc: freshVc })
  })

  // APP-L02: the tool description promises a transient MBI error surfaces as cacheError, not a
  // throw — this is what makes "call check_ai_birthcert_verification again" a safe, correct retry.
  it('on issued: reports a cacheError instead of throwing when downloadVcs itself fails', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    deps.mbi.downloadVcs = vi.fn().mockRejectedValue(new Error('MBI vc/ext/download failed — HTTP 503: unavailable'))

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.quarantine.set).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1' })
    expect((out as { cacheError?: string }).cacheError).toMatch(/failed to fetch credential from MBI/i)
  })

  it('on issued: refuses to cache a VC with no validUntil, and reports it rather than caching silently', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' } } // no validUntil
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.cache.set).not.toHaveBeenCalled()
    // R2-L01/APP-C01: the raw response must be quarantined BEFORE this rejection, or the one-shot
    // download is lost for good.
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({ vcId: 'did:zid:vc-1' }))
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1' })
    expect((out as { cacheError?: string }).cacheError).toMatch(/validUntil/i)
  })

  // R2-M02: an already-expired credential must not be cached and returned as a success — the
  // cache-validity gate would reject it on the very next call (looping forever), and prove_identity,
  // which applies the same isVcValid gate, would refuse it outright.
  it('on issued: refuses to cache or return an already-expired VC', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2020-06-01T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.cache.set).not.toHaveBeenCalled()
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({ vcId: 'did:zid:vc-1' }))
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1' })
    expect((out as { cacheError?: string }).cacheError).toMatch(/expired/i)
    expect((out as { vc?: unknown }).vc).toBeUndefined()
  })

  it('on issued: refuses to cache a VC whose credentialSubject.id does not match holderDid, with a diagnosable message', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:someone-else' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.cache.set).not.toHaveBeenCalled()
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({ vcId: 'did:zid:vc-1' }))
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1' })
    const cacheError = (out as { cacheError?: string }).cacheError
    expect(cacheError).toContain('did:zid:someone-else')
    expect(cacheError).toContain('did:zid:owner123')
  })

  it('on issued: reports an error rather than caching when no downloaded VC matches vcId', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc: { id: 'did:zid:unrelated' } }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.cache.set).not.toHaveBeenCalled()
    expect(deps.quarantine.set).toHaveBeenCalledWith(expect.objectContaining({ vcId: 'did:zid:vc-1' }))
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1' })
    expect((out as { cacheError?: string }).cacheError).toMatch(/no matching credential/i)
  })

  it('on issued: skips the download entirely when the cache already has this exact vcId', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const cachedVc = { id: 'did:zid:vc-1' }
    deps.cache.get = vi.fn().mockResolvedValue({ templateId: 'did:zid:verified-template', vc: cachedVc, vcId: 'did:zid:vc-1', issuedAt: '2026-08-13T09:00:00Z' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.mbi.downloadVcs).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1', vc: cachedVc })
  })

  it('on issued: falls through to re-fetch from MBI when the cached entry with this vcId has expired', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const staleCachedVc = { id: 'did:zid:vc-1' }
    deps.cache.get = vi.fn().mockResolvedValue({
      templateId: 'did:zid:verified-template', vc: staleCachedVc, vcId: 'did:zid:vc-1',
      issuedAt: '2020-01-01T00:00:00Z', validUntil: '2020-06-01T00:00:00Z', // long expired relative to `now`
    })
    const freshVc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc: freshVc }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(deps.mbi.downloadVcs).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ status: 'issued', vcId: 'did:zid:vc-1', vc: freshVc })
    expect(deps.cache.set).toHaveBeenCalledWith('did:zid:verified-template', expect.objectContaining({ vc: freshVc }))
  })
})

describe('self-pay fallback', () => {
  it('falls back to the self-pay quote when /prepare refuses sponsorship', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'settled', session: { sessionId: 's-fb', verificationUrl: 'https://zvg/v', expiresAt: '2026-08-21T09:00:00Z' }, paymentReceipt: 'r-fb' }),
      createSessionWithReceipt: vi.fn(),
    }
    // First call (sponsored) is refused by the facilitator; second (self-pay) succeeds.
    const pay = vi.fn()
      // Shape matches what FacilitatorPrepareClient actually throws — see §9.6 of the spec doc.
      .mockRejectedValueOnce(new Error('FacilitatorPrepareClient.prepare: HTTP 429 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461414,"message":"rate_limit_exceeded"}],"success":false}'))
      .mockResolvedValueOnce('xpay-selfpay')
    const out = await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.session?.sessionId).toBe('s-fb')
    expect(pay).toHaveBeenCalledTimes(2)
    expect(pay.mock.calls[0][0]).toEqual(sponsoredAccept)
    expect(pay.mock.calls[1][0]).toEqual(selfPayAccept)
  })

  it('does NOT fall back when the retry budget runs out — payment may still land', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-q', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-q', retryAfterSeconds: 1 }),
    }
    const pay = vi.fn().mockResolvedValue('xpay-sponsored')
    const out = await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 2 })

    expect(pay).toHaveBeenCalledTimes(1)              // never re-paid
    expect(out.error).toMatch(/still settling|being processed/i)
  })

  it('does not fall back when there is no second candidate', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockRejectedValue(new Error('facilitator /prepare refused: RATE_LIMITED'))
    // No recognised error type wraps this (it's a plain Error, not PaymentReadinessError/
    // PaymentCapError), so — same as every other unrecognised error on this path (e.g. the
    // ECONNRESET cases above) — it propagates unchanged rather than being coerced into `{ error }`.
    // The safety property under test is that `pay` is never called a second time.
    await expect(runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow(/refused|RATE_LIMITED/i)

    expect(pay).toHaveBeenCalledTimes(1)
  })

  it('reshapes a 461407 (facilitator insufficient-funds) failure into a clean error naming the asset and amount, without a self-pay retry', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    // Same HTTP-error-body shape as the 461414 fixtures above (ms-zetrix returns 402, so
    // response.ok is false and FacilitatorPrepareClient takes the raw-body branch, not the
    // envelope-unwrap branch) — ms-zetrix's ErrorCode message is a bare "insufficient_funds" with
    // no asset/amount of its own.
    const pay = vi.fn().mockRejectedValue(new Error(
      'FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds"}],"success":false}',
    ))
    const out = await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })

    // Deliberately NOT definitive (see DEFINITIVE_PREPARE_REFUSALS) — self-pay would need the same
    // token plus ZTX gas on top, so it must not be retried.
    expect(pay).toHaveBeenCalledTimes(1)
    expect(out.error).toMatch(/insufficient funds/i)
    expect(out.error).toContain(sponsoredAccept.asset)
    expect(out.error).toContain(sponsoredAccept.maxAmountRequired)
  })

  it('renders the 461407 reshape in human units via formatAssetAmount, including the balance from the facilitator\'s bracketed detail', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    // Real shape: the facilitator's own message carries [asset, required, available].
    const pay = vi.fn().mockRejectedValue(new Error(
      `FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds [${sponsoredAccept.asset}, ${sponsoredAccept.maxAmountRequired}, 0]"}],"success":false}`,
    ))
    // Mirrors index.ts's real formatAssetAmount: "raw (human SYMBOL)".
    const formatAssetAmount = vi.fn(async (asset: string, raw: string) =>
      raw === '0' ? '0 (0 JMYR)' : `${raw} (1 JMYR)`,
    )
    const out = await runRequest({ ssivc, pay, formatAssetAmount, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(formatAssetAmount).toHaveBeenCalledWith(sponsoredAccept.asset, sponsoredAccept.maxAmountRequired)
    expect(formatAssetAmount).toHaveBeenCalledWith(sponsoredAccept.asset, '0')
    expect(out.error).toContain('1 JMYR')
    expect(out.error).toContain('0 JMYR')
    // The raw base-unit count must NOT appear bare (unlabeled) — that's exactly the misleading
    // "top up 1000000 JMYR" reading this exists to prevent.
    expect(out.error).not.toMatch(new RegExp(`requires ${sponsoredAccept.maxAmountRequired}(?! \\()`))
  })

  it('prefers the structured messages[0].detail field over the bracketed message text for the available balance', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    // detail says 42 (the real, structured value); the free-text bracket says a stale/different 0 -
    // proves detail wins when both are present, not just when only one is.
    const pay = vi.fn().mockRejectedValue(new Error(
      `FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds [${sponsoredAccept.asset}, ${sponsoredAccept.maxAmountRequired}, 0]","detail":["${sponsoredAccept.asset}","${sponsoredAccept.maxAmountRequired}","42"]}],"success":false}`,
    ))
    const formatAssetAmount = vi.fn(async (_asset: string, raw: string) => `${raw} HUMAN`)
    const out = await runRequest({ ssivc, pay, formatAssetAmount, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(formatAssetAmount).toHaveBeenCalledWith(sponsoredAccept.asset, '42')
    expect(formatAssetAmount).not.toHaveBeenCalledWith(sponsoredAccept.asset, '0')
    expect(out.error).toContain('42 HUMAN')
  })

  it('falls back to the bracketed message text when messages[0].detail is absent (older facilitator)', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockRejectedValue(new Error(
      `FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds [${sponsoredAccept.asset}, ${sponsoredAccept.maxAmountRequired}, 7]"}],"success":false}`,
    ))
    const formatAssetAmount = vi.fn(async (_asset: string, raw: string) => `${raw} HUMAN`)
    const out = await runRequest({ ssivc, pay, formatAssetAmount, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(formatAssetAmount).toHaveBeenCalledWith(sponsoredAccept.asset, '7')
    expect(out.error).toContain('7 HUMAN')
  })

  it('reshapes a 461407 the same way when there is no self-pay fallback candidate at all', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockRejectedValue(new Error(
      'FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds"}],"success":false}',
    ))
    const out = await runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })

    expect(pay).toHaveBeenCalledTimes(1)
    expect(out.error).toMatch(/insufficient funds/i)
    expect(out.error).toContain(sponsoredAccept.asset)
    expect(out.error).toContain(sponsoredAccept.maxAmountRequired)
  })

  it('leaves a 461407 failure unreshaped (raw error) when the accept is missing asset/maxAmountRequired', async () => {
    // Self-pay-shaped (not `sponsoredAccept`) so it isn't dropped as "unusable" by orderAccepts —
    // isSponsored requires a non-empty asset, so a sponsored-declaring accept with asset:'' would be
    // filtered out entirely (a different, already-covered code path) rather than reaching `pay`.
    const barePrimary = { ...selfPayAccept, asset: '', maxAmountRequired: '' }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [barePrimary] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockRejectedValue(new Error(
      'FacilitatorPrepareClient.prepare: HTTP 402 from https://proxy/api/facilitator — {"messages":[{"type":"ERROR","errorCode":461407,"message":"insufficient_funds"}],"success":false}',
    ))
    // Same unrecognised-error behaviour as every other case with no asset/amount to build a clean
    // message from — propagates unchanged rather than rendering `requires  of asset ""`.
    await expect(runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow(/insufficient_funds/i)
  })

  it('does not fall back when the caller forced self-pay and self-pay failed', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    // Deliberately DEFINITIVE (a real 461414 rate-limit code) so this exercises the fail-closed
    // path correctly. NOTE: with this fixture ([selfPayAccept, sponsoredAccept]), `fallback` is
    // always sponsored, so `isSponsored(fallback)` alone already blocks escalation regardless of
    // `!isSponsored(primary)` — this test does not, by itself, isolate the direction guard. See
    // the next test for that.
    const pay = vi.fn().mockRejectedValue(new Error(
      'FacilitatorPrepareClient.prepare: HTTP 429 — {"messages":[{"type":"ERROR","errorCode":461414,"message":"rate_limit_exceeded"}],"success":false}',
    ))
    await expect(
      runRequest({ ssivc, pay, gasPreference: 'self', sleep: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow(/461414/)

    expect(pay).toHaveBeenCalledTimes(1) // no silent escalation to sponsored
  })

  it('does not fall back to a second self-pay candidate when self-pay was forced and fails definitively', async () => {
    // Isolates the `!isSponsored(primary)` clause specifically. With TWO self-pay candidates and
    // `prefer: 'self'`, orderAccepts returns [selfPayAccept, selfPayAcceptB] (both land in the
    // self-pay bucket, wire order preserved) — so `fallback` (selfPayAcceptB) is NOT sponsored,
    // meaning `isSponsored(fallback)` is false and can no longer mask the direction-guard clause.
    // Traced what happens if `!isSponsored(primary) ||` were deleted from the guard:
    //   before: !fallback(false) || !isSponsored(primary)(true) || isSponsored(fallback)(false) = true  -> throws, pay called once
    //   after:  !fallback(false) ||                                 isSponsored(fallback)(false) = false -> falls back, pay called twice
    // So this test's `toHaveBeenCalledTimes(1)` assertion actually fails if that clause is removed
    // — unlike the previous test, where the same mutation is masked by `isSponsored(fallback))`
    // being true regardless.
    const selfPayAcceptB = { ...selfPayAccept, payTo: 'ZTXanotherPayee' }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, selfPayAcceptB] }),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockRejectedValue(new Error(
      'FacilitatorPrepareClient.prepare: HTTP 429 — {"messages":[{"type":"ERROR","errorCode":461414,"message":"rate_limit_exceeded"}],"success":false}',
    ))
    await expect(
      runRequest({ ssivc, pay, gasPreference: 'self', sleep: vi.fn().mockResolvedValue(undefined) }),
    ).rejects.toThrow(/461414/)

    expect(pay).toHaveBeenCalledTimes(1) // never attempts the second candidate — self-pay never falls back
  })

  it('does NOT fall back when a definitive-looking error code arrives from createSessionSettle, after money already moved', async () => {
    // Same 461414-shaped body as the successful-fallback test above, but this time it comes from
    // createSessionSettle — i.e. AFTER deps.pay already succeeded and the X-Payment blob was
    // submitted. Falling back here would double-pay. This is the regression PrepareStageError
    // exists to prevent: only an error thrown by deps.pay itself is classified as pre-money.
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn().mockRejectedValue(new Error(
        'SSIVC request failed — HTTP 500: {"messages":[{"type":"ERROR","errorCode":461414,"message":"rate_limit_exceeded"}],"success":false}',
      )),
      createSessionWithReceipt: vi.fn(),
    }
    const pay = vi.fn().mockResolvedValue('xpay-sponsored')
    await expect(runRequest({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow(/461414/)

    expect(pay).toHaveBeenCalledTimes(1) // never re-paid via the self-pay candidate
  })
})

describe('per-call gasPayer override', () => {
  it('input.gasPayer overrides deps.gasPreference for that one call', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({
        kind: 'settled',
        session: { sessionId: 's-override', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-21T09:00:00Z' },
        paymentReceipt: 'receipt-override',
      }),
      createSessionWithReceipt: vi.fn(),
      getSession: vi.fn(),
    }
    const pay = vi.fn().mockResolvedValue('xpay-selfpay')
    const sessionStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    }
    const deps = {
      ssivc,
      signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
      pay,
      publicKeyHex: 'b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b',
      address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
      holderDid: 'did:zid:owner123',
      now: () => new Date('2026-08-21T09:00:00.000Z'),
      sessionStore,
      verifiedTemplateId: 'did:zid:verified-template',
      cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
      quarantine: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        filePathFor: vi.fn((vcId: string) => `/state/ssivc-download-quarantine/${vcId}.json`),
      },
      // Deployment default says sponsored — the per-call gasPayer below must win over this.
      gasPreference: 'sponsored' as const,
    }

    const result = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant', gasPayer: 'self' })

    expect('error' in (result as Record<string, unknown>)).toBe(false)
    // orderAccepts('self') puts the self-pay candidate first — attemptCandidate calls pay(candidates[0]).
    expect(pay).toHaveBeenCalledWith(selfPayAccept)
  })

  // MCP schema enum validation is advisory in many hosts — a caller (e.g. a confused LLM) can send
  // any string for gasPayer, not just 'self'/'sponsored'. Because it's truthy, a naive
  // `input.gasPayer ?? deps.gasPreference` never falls back, and orderAccepts's
  // `prefer === 'sponsored' ? ... : ...` treats ANY non-'sponsored' string as self-pay-first —
  // silently overriding a deployment configured for sponsored gas. This must NOT happen: a garbage
  // gasPayer value must be treated as absent, falling through to deps.gasPreference.
  it('an unrecognised gasPayer value is treated as absent — deployment sponsored default still wins', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [selfPayAccept, sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({
        kind: 'settled',
        session: { sessionId: 's-garbage', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-21T09:00:00Z' },
        paymentReceipt: 'receipt-garbage',
      }),
      createSessionWithReceipt: vi.fn(),
      getSession: vi.fn(),
    }
    const pay = vi.fn().mockResolvedValue('xpay-sponsored')
    const sessionStore = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    }
    const deps = {
      ssivc,
      signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
      pay,
      publicKeyHex: 'b001abec8ba07df4359362f9d2337d3dad3a85a1ae060d7d4e2e2c792106d54cc815344f524b',
      address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
      holderDid: 'did:zid:owner123',
      now: () => new Date('2026-08-21T09:00:00.000Z'),
      sessionStore,
      verifiedTemplateId: 'did:zid:verified-template',
      cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
      quarantine: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn(),
        filePathFor: vi.fn((vcId: string) => `/state/ssivc-download-quarantine/${vcId}.json`),
      },
      gasPreference: 'sponsored' as const,
    }

    const result = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      gasPayer: 'banana' as never,
    })

    expect('error' in (result as Record<string, unknown>)).toBe(false)
    // orderAccepts('sponsored') puts the sponsored candidate first — a garbage gasPayer must not
    // force self-pay-first.
    expect(pay).toHaveBeenCalledWith(sponsoredAccept)
  })
})
