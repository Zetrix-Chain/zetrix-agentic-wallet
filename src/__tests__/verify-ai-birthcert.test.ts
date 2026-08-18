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

  it('signs the SHA-256 digest of the canonical JSON of the body (minus signedData) via signHexBlob', async () => {
    const { deps, signHexBlob } = makeDeps()
    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })
    expect(signHexBlob).toHaveBeenCalledTimes(1)
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

  // APP-M03: only `pending`/`issued` are confirmed session statuses (SPEC.md D8 is open on the
  // rest). An unrecognized concrete status string (e.g. a hypothetical "expired") must NOT be
  // treated as safe-to-replay by default — only a confirmed 404 (the session record genuinely gone,
  // see the next test) is. Guessing wrong here could replay a receipt against a payment that's
  // about to be consumed.
  it('when the stored session (same agentName) reports an unrecognized status: propagates rather than guessing it is safe to replay', async () => {
    const { deps, sessionStore, getSession, pay, createSessionChallenge, createSessionWithReceipt } = makeDeps()
    await sessionStore.set({
      sessionId: 's-old', agentName: 'Procurement Assistant', createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: 'https://zvg.test/verify/old-tok', paymentReceipt: 'receipt-old',
    })
    getSession.mockResolvedValue({ sessionId: 's-old', status: 'expired', expiresAt: '2026-08-17T08:30:00+00:00' })

    await expect(requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })).rejects.toThrow(/unrecognized prior session status/)

    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).not.toHaveBeenCalled()
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

    expect(out).toEqual({ error: expect.stringContaining('insufficient funds') })
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

    expect(out).toEqual({ error: expect.stringContaining('no payment options') })
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

describe('checkAiBirthcertVerification', () => {
  it('reports no_session when nothing has been requested yet', async () => {
    const { deps, getSession } = makeDeps()

    const out = await checkAiBirthcertVerification(deps as never)

    expect(getSession).not.toHaveBeenCalled()
    expect(out).toEqual({ status: 'no_session', message: expect.stringContaining('request_ai_birthcert_verification') })
  })

  it('checks the persisted sessionId and reports pending (no vcId)', async () => {
    const { deps, sessionStore, getSession } = makeDeps()
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(getSession).toHaveBeenCalledWith('s-1')
    expect(out).toEqual({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' })
    expect(out.vcId).toBeUndefined()
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
