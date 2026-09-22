import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestAiBirthcertVerification, checkAiBirthcertVerification, clearStuckPaymentReceipt } from '../orchestrator/verify-ai-birthcert'
import { PaymentReadinessError } from '../payment-readiness'
import { PaymentCapError } from '../payment-guard'
import { SsivcError } from '../clients/ssivc-client'

let passImagesDir: string
beforeEach(() => {
  passImagesDir = mkdtempSync(join(tmpdir(), 'verify-ai-birthcert-vc-pass-image-test-'))
})
afterEach(() => {
  rmSync(passImagesDir, { recursive: true, force: true })
})

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
    // Part of the real SsivcSessionStore interface since the clear-receipt work; the double predated it.
    clear: vi.fn().mockImplementation(async () => { stored.value = null }),
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
      withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()),
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
  const result = await runRequestRaw(overrides)
  if ('error' in result) return { session: undefined, error: (result as unknown as { error: string }).error, settlementPending: undefined }
  // APP-L03: a pending result is neither a session nor an error. Folding it into the session branch
  // produced a session with an undefined sessionId, which silently weakens any test that lands here.
  if (result.settlementPending === true) {
    return { session: undefined, error: undefined, settlementPending: result as unknown as { paymentReceipt: string; message: string } }
  }
  return {
    session: result as unknown as { sessionId: string; verificationUrl: string; expiresAt: string },
    error: undefined,
    settlementPending: undefined,
  }
}

/**
 * Same wiring as {@link runRequest} but returns the orchestrator result untouched, so a test can
 * assert on variants that are neither a session nor an `error` — e.g. the queued-settlement result.
 */
async function runRequestRaw(overrides: Partial<Record<string, unknown>> = {}) {
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
      withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()),
    },
    ...overrides,
  }
  return (await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })) as Record<
    string,
    unknown
  >
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
        quarantine: { get: vi.fn(), set: vi.fn(), filePathFor: vi.fn(), withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()) },
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

  it('stops waiting after the retry budget and reports it as pending, without re-paying', async () => {
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r1', retryAfterSeconds: 1 }),
    }
    const pay = vi.fn().mockResolvedValue('xpay-blob')
    const out = await runRequestRaw({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 3 })
    // A live settlement is reported as pending, never as an error.
    expect(out.error).toBeUndefined()
    expect(out.settlementPending).toBe(true)
    expect(pay).toHaveBeenCalledTimes(1)
  })

  // A queued sponsored settlement is NOT a failure — the payment was sent. Returning it as
  // `{ error }` made every caller (and the agent summarising for the user) read "the payment failed",
  // which is the opposite of what happened. It must come back as its own non-error variant that names
  // the receipt and points at check_ai_birthcert_verification.
  describe('a queued settlement returns early as a non-error pending result', () => {
    const queuedSsivc = (retryAfterSeconds: number) => ({
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-pending', retryAfterSeconds }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-pending', retryAfterSeconds }),
    })

    it('reports settlementPending with the receipt instead of an error', async () => {
      const pay = vi.fn().mockResolvedValue('xpay-blob')
      const out = await runRequestRaw({ ssivc: queuedSsivc(1), pay, sleep: vi.fn().mockResolvedValue(undefined) })

      expect(out.error).toBeUndefined()
      expect(out.settlementPending).toBe(true)
      expect(out.paymentReceipt).toBe('r-pending')
      expect(pay).toHaveBeenCalledTimes(1) // never re-paid
    })

    it('says the payment was SENT and points at check_ai_birthcert_verification', async () => {
      const out = await runRequestRaw({ ssivc: queuedSsivc(1), sleep: vi.fn().mockResolvedValue(undefined) })

      // R2-L04: anchored, like the OUTCOME UNKNOWN test. SPEC.md REQ-19a requires the verdict to
      // LEAD, because a summarising client keeps the opening of a message and drops the rest — an
      // unanchored match passed happily with the verdict buried mid-sentence.
      expect(out.message).toMatch(/^PAYMENT SENT/)
      expect(out.message).toMatch(/check_ai_birthcert_verification/)
      // Must never read as a failure — this is what the QA-run agent got wrong.
      expect(out.message).not.toMatch(/failed|did not go through/i)
    })

    it('waits no longer than the ~90s budget even when the server asks for a long Retry-After', async () => {
      // 3600s is clamped to MAX_RETRY_DELAY_MS (60s) per attempt, so the old attempt-count budget
      // alone allowed 20 x 60s = 20 minutes. A wall-clock budget must stop it inside 90s.
      const sleep = vi.fn().mockResolvedValue(undefined)
      const out = await runRequestRaw({ ssivc: queuedSsivc(3600), sleep })

      // Exact cadence, not just a ceiling: asserting only "<= 90000" would still pass if the retry
      // loop were deleted outright (0 <= 90000). 3600s clamps to the 60s per-attempt cap, so one
      // sleep fits the budget and a second (120s) would not.
      expect(sleep.mock.calls.map(([ms]: [number]) => ms)).toEqual([60_000])
      expect(out.settlementPending).toBe(true)
    })

    it('still bounds the wait when the server asks for a short Retry-After', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined)
      await runRequestRaw({ ssivc: queuedSsivc(15), sleep })

      // Six 15s sleeps exactly fill the 90s budget; a seventh would overrun it.
      const delays = sleep.mock.calls.map(([ms]: [number]) => ms)
      expect(delays).toEqual([15_000, 15_000, 15_000, 15_000, 15_000, 15_000])
      expect(delays.reduce((a: number, b: number) => a + b, 0)).toBe(90_000)
    })

    // APP-M01: a budget below the first delay used to produce ZERO polls — SETTLEMENT_WAIT_BUDGET_MS=1
    // silently disabled settlement polling altogether. The budget caps how long we wait, it must never
    // mean "do not even ask once".
    it('always polls at least once, even when the budget is below the first delay', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined)
      const ssivc = queuedSsivc(3600)

      await runRequestRaw({ ssivc, sleep, settlementWaitBudgetMs: 10_000 })

      expect(ssivc.createSessionWithReceipt).toHaveBeenCalledTimes(1)
      expect(sleep).toHaveBeenCalledTimes(1)
    })

    // APP-M02: every other budget test leans on the hard-coded default, so an injected budget —
    // which is exactly what SETTLEMENT_WAIT_BUDGET_MS produces — was never exercised here.
    it('honours an injected budget rather than the default', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined)

      await runRequestRaw({ ssivc: queuedSsivc(15), sleep, settlementWaitBudgetMs: 30_000 })

      expect(sleep.mock.calls.map(([ms]: [number]) => ms)).toEqual([15_000, 15_000])
    })

    // APP-M03: Math.min only clamps the UPPER bound. A NaN or negative retryAfterSeconds made the
    // overrun comparison always false, so the budget silently stopped applying and only the attempt
    // cap (20 x 60s) bounded the loop — contradicting the budget's own docstring. Not reachable
    // through the current client, which validates Retry-After at the boundary; defence in depth.
    it.each([
      ['NaN', Number.NaN],
      ['negative', -30],
      ['zero', 0],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('falls back to a safe delay when retryAfterSeconds is %s', async (_label, retryAfterSeconds) => {
      const sleep = vi.fn().mockResolvedValue(undefined)

      await runRequestRaw({ ssivc: queuedSsivc(retryAfterSeconds as number), sleep })

      const delays = sleep.mock.calls.map(([ms]: [number]) => ms)
      expect(delays.length).toBeGreaterThan(0)
      for (const ms of delays) {
        expect(Number.isFinite(ms)).toBe(true)
        expect(ms).toBeGreaterThan(0)
        expect(ms).toBeLessThanOrEqual(60_000)
      }
      expect(delays.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(90_000)
    })

    it('persists the receipt so check_ai_birthcert_verification can follow it', async () => {
      const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
      await runRequestRaw({ ssivc: queuedSsivc(1), sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) })

      expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ sessionId: '', paymentReceipt: 'r-pending' }))
    })
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

    // This payment is seconds old, so it reads as still-settling rather than stuck. The
    // safety property is unchanged — the receipt is kept and nothing is re-paid — but a user whose
    // payment just left is no longer told an operator must investigate it.
    expect(out.settlementPending?.paymentReceipt).toBe('r-failed')
    expect(out.settlementPending?.message).toMatch(/^PAYMENT SENT/)
    expect(out.settlementPending?.message).toContain('r-failed')
    expect(out.settlementPending?.message).toMatch(/do NOT pay again/i)
    // Must NOT be phrased as safely retryable, unlike SettlementStillQueuedError's message — this
    // outcome is not known-recoverable.
    expect(out.error).toBeUndefined()
    expect(out.settlementPending?.message).not.toMatch(/run.*again to resume/i)
    // Still points at the free follow-up tool, never back at this paid one.
    expect(out.settlementPending?.message).toMatch(/check_ai_birthcert_verification/)
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

    // One hour old, so still within the window where it may genuinely settle.
    expect(out).toMatchObject({ settlementPending: true })
    expect(out).toMatchObject({ message: expect.stringContaining('receipt-replay-failed') })
    expect(out).toMatchObject({ message: expect.stringMatching(/^PAYMENT SENT/) })
    // The receipt is also its own field here, not only inside the sentence.
    expect(out).toMatchObject({ paymentReceipt: 'receipt-replay-failed' })
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
    // R2-L04: anchored — REQ-19a's lead-with-the-verdict rule applies to this surface too, and this
    // one is the only place the receipt exists at all, so a truncating client must still see it.
    expect(out.error).toMatch(/^PAYMENT SENT/)
    expect(out.error).toContain('r-doomed')
    expect(pay).toHaveBeenCalledTimes(1) // still never re-paid

    // APP-C02: this message used to be built as `err.message + "(could not save...)"`, and
    // err.message is the happy-path text — so on the ONE branch where the receipt was not saved it
    // claimed "the receipt has been saved" and pointed at a tool that would find nothing. This is the
    // only place the receipt survives at all, so it must not contradict itself.
    expect(out.error).not.toMatch(/check_ai_birthcert_verification/)
    expect(out.error).not.toMatch(/receipt has been saved|receipt has been kept/i)
    expect(out.error).toMatch(/could not be saved|not saved/i)
    expect(out.error).toMatch(/do not pay again/i)
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
  // Write side: check_ rebuilds the replay body from the store alone, so whatever the user
  // supplied has to be IN the store. Persisting only the receipt would issue the credential without
  // it — silent loss, visible only once they read their birthcert.
  it('persists the optional request fields alongside the receipt, so a replay can rebuild the body', async () => {
    const store = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) }
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-opt', retryAfterSeconds: 1 }),
      createSessionWithReceipt: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-opt', retryAfterSeconds: 1 }),
    }

    await requestAiBirthcertVerification(
      { ...makeDeps().deps, ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) } as never,
      {
        agentName: 'Procurement Assistant',
        agentPurpose: 'Handles procurement negotiations',
        evidenceAssuranceLevel: 'high',
        ownerType: 'organisation',
        ownerVerified: 'true',
      },
    )

    // EVERY write, not just one: the receipt is persisted twice on this path (the moment settlement
    // is first seen as queued, and again at give-up). A record missing the fields is a record a
    // later replay would rebuild an incomplete body from, so neither site may drop them.
    expect(store.set).toHaveBeenCalled()
    for (const [record] of store.set.mock.calls) {
      expect(record).toMatchObject({
        paymentReceipt: 'r-opt',
        agentPurpose: 'Handles procurement negotiations',
        evidenceAssuranceLevel: 'high',
        ownerType: 'organisation',
        ownerVerified: 'true',
      })
    }
  })

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

    expect(out.settlementPending?.message).toContain('r-first')

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

    expect(out.settlementPending?.message).toContain('r-second')
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

// When the settlement outcome is genuinely unknown the wallet keeps the receipt and refuses
// to pay again — correct, since guessing risks a double charge. But the only way out was deleting
// <stateDir>/ssivc-session.json on the gateway by hand, which a hosted Avatar subscriber cannot do.
// Same structural gap as the spending cap.
// In the 18 Sep 2026 QA run the agent compressed "could not determine whether the sponsored
// settlement succeeded or failed ... this is NOT a confirmed failure" into "the payment failed, the
// receipt is no longer valid" — the opposite meaning — and the user acted on it. An accurate message
// that does not survive summarisation is not an accurate message.
describe('terminal messages survive summarisation, and the receipt is a field', () => {
  const unknownSsivc = () => ({
    createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
    createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-unknown', retryAfterSeconds: 1 }),
    createSessionWithReceipt: vi.fn().mockRejectedValue(new Error('connection reset')),
  })

  // A payment made moments ago is never "permanently stuck", so request_ only reaches the
  // OUTCOME UNKNOWN wording on the replay path, against a record old enough to have given up hope.
  it('leads the unknown-outcome message with a verdict line, before any detail', async () => {
    const { deps, sessionStore } = makeDeps({
      ssivc: {
        createSessionChallenge: vi.fn(),
        createSessionSettle: vi.fn(),
        createSessionWithReceipt: vi.fn().mockRejectedValue(new Error('connection reset')),
        getSession: vi.fn(),
      },
    })
    await sessionStore.set({
      sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-01T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'r-unknown',
    })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    // The verdict has to be the FIRST thing, not buried after two clauses of explanation — a
    // summariser keeps the opening and discards the tail.
    expect(out.error).toMatch(/^OUTCOME UNKNOWN/)
    expect(out.error).toMatch(/do not retry/i)
    expect(out.error).toMatch(/do not assume failure/i)
  })

  // The other half of REQ-19a's verdict rule: a fresh one leads with PAYMENT SENT, which is the
  // other sanctioned verdict — never with an explanation the summariser will drop.
  it('leads a not-yet-confirmed settlement with PAYMENT SENT instead', async () => {
    const out = await runRequestRaw({ ssivc: unknownSsivc(), sleep: vi.fn().mockResolvedValue(undefined) })

    expect(out.message).toMatch(/^PAYMENT SENT/)
    expect(out.error).toBeUndefined()
  })

  // The original dead end: while a stuck receipt is held, this tool can only replay it, so it
  // can never buy a new credential. That is deliberate — it is what stops a second charge — but the
  // old message said only "an operator must investigate", naming no operator and no way forward.
  it('names the way out instead of dead-ending at "an operator must investigate"', async () => {
    const { deps, sessionStore } = makeDeps({
      ssivc: {
        createSessionChallenge: vi.fn(),
        createSessionSettle: vi.fn(),
        createSessionWithReceipt: vi.fn().mockRejectedValue(new Error('connection reset')),
        getSession: vi.fn(),
      },
    })
    await sessionStore.set({
      sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-01T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'r-stranded',
    })

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(out.error).toMatch(/clear_stuck_payment_receipt/)
    expect(out.error).toMatch(/SECOND fee/)
    expect(out.error).toMatch(/most likely already taken/i)
    expect(out.error).not.toMatch(/manual investigation by an operator/i)
    // Still no second payment, and the receipt still survives this call.
    expect(deps.pay).not.toHaveBeenCalled()
    expect((await sessionStore.get()).paymentReceipt).toBe('r-stranded')
  })

  it('returns the receipt id as its own field, not only inside the message', async () => {
    const out = await runRequestRaw({ ssivc: unknownSsivc(), sleep: vi.fn().mockResolvedValue(undefined) })

    // It is the first thing support asks for; digging it out of a long sentence invites transcription
    // errors on a value that identifies real money.
    expect(out.paymentReceipt).toBe('r-unknown')
  })

  // CreatedAt is well past the stuck threshold, so this stays on the OUTCOME UNKNOWN
  // wording it was written for. A fresh receipt now gets the gentler PAYMENT SENT message instead.
  it('check_ surfaces the receipt as its own field too', async () => {
    const { deps, sessionStore } = makeDeps()
    deps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(new Error('connection reset'))
    await sessionStore.set({
      sessionId: '', agentName: 'Procurement Assistant', createdAt: '2026-08-01T08:00:00.000Z',
      verificationUrl: '', paymentReceipt: 'r-check',
    })

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out.paymentReceipt).toBe('r-check')
    expect(out.message).toMatch(/^OUTCOME UNKNOWN/)
  })
})

// APP-C01: the two halves were tested separately but never end to end, so nothing proved the hand-off
// actually worked. request_ tells the user "PAYMENT SENT — call check_"; if check_ then said
// "no_session, call request_", the agent is in a loop and the user is back where this started.
// This is the test that would have caught that.
// APP-M03: Earlier work stopped check_ from dropping the optional fields, but request_'s OWN replay path
// rebuilds the body from the caller's current input, not the store. A bare retry — plausible now that
// check_ is the advertised resume path — replayed an incomplete body AND overwrote the stored record
// with the empty set, permanently deleting what the user paid for. The fix undone by a sibling path.
// APP-M01: withRequestLock exists because the MCP host does not serialize tool calls. Before this
// stack, check_ was read-only so it needed no lock. It is not read-only any more — advanceQueuedSettlement
// reads, replays and WRITES the store. Two concurrent replays both win their read and the last write
// orphans the other's session: one payment, two live SSIVC sessions, and the stored verificationUrl
// points at only one of them.
describe('APP-M01: the mutating tools serialize against request_', () => {
  const record = {
    sessionId: '',
    agentName: 'Procurement Assistant',
    createdAt: '2026-08-17T08:00:00.000Z',
    verificationUrl: '',
    paymentReceipt: 'r-race',
  }

  function sharedStore() {
    const state: { value: Record<string, unknown> | null } = { value: { ...record } }
    return {
      state,
      store: {
        get: vi.fn().mockImplementation(async () => state.value),
        set: vi.fn().mockImplementation(async (s: Record<string, unknown>) => { state.value = s }),
        clear: vi.fn().mockImplementation(async () => { state.value = null }),
      },
    }
  }

  it('does not let a concurrent check_ and request_ both replay the same receipt', async () => {
    const { state, store } = sharedStore()
    let inFlight = 0
    let maxConcurrent = 0
    const createSessionWithReceipt = vi.fn().mockImplementation(async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return {
        kind: 'settled',
        session: { sessionId: 's-' + createSessionWithReceipt.mock.calls.length, verificationUrl: 'https://zvg.test/v', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'r-race',
      }
    })
    const ssivc = {
      createSessionChallenge: vi.fn(),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt,
      // Whoever serializes second re-reads the store, finds the session the first one created, and
      // takes the ordinary status path instead of replaying again — which is the point of the lock.
      getSession: vi.fn().mockResolvedValue({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-17T10:00:00+00:00' }),
    }
    const deps = { ...makeDeps().deps, ssivc, sessionStore: store, sleep: vi.fn().mockResolvedValue(undefined) }

    await Promise.all([
      checkAiBirthcertVerification(deps as never),
      requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' }),
    ])

    // The critical section must never overlap — whoever goes second re-reads the store and sees the
    // session the first one created, instead of replaying the receipt again.
    expect(maxConcurrent).toBe(1)
    expect(createSessionWithReceipt).toHaveBeenCalledTimes(1)
    expect(state.value).toMatchObject({ sessionId: 's-1' })
  })

  it('does not let clear_ discard a receipt while request_ is mid-replay', async () => {
    const { state, store } = sharedStore()
    let inFlight = 0
    let maxConcurrent = 0
    const createSessionWithReceipt = vi.fn().mockImplementation(async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight -= 1
      return { kind: 'queued', paymentReceipt: 'r-race', retryAfterSeconds: 1 }
    })
    const ssivc = {
      createSessionChallenge: vi.fn(),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt,
      getSession: vi.fn(),
    }
    // R2-L08: maxConcurrent alone is vacuous here — it only ever increments inside
    // createSessionWithReceipt, which clear_ never calls, so it could not fail however broken the
    // locking was. The falsifiable property is that the destructive write never lands while a
    // replay is in flight, which is the actual harm: deleting the only handle on a payment that is,
    // at that moment, being settled.
    let clearedMidReplay = false
    const sessionStore = {
      ...store,
      clear: vi.fn().mockImplementation(async () => {
        if (inFlight > 0) clearedMidReplay = true
        return store.clear()
      }),
    }
    const deps = { ...makeDeps().deps, ssivc, sessionStore, sleep: vi.fn().mockResolvedValue(undefined) }

    const [, cleared] = await Promise.all([
      requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' }),
      clearStuckPaymentReceipt(deps as never, { confirmReceiptId: 'r-race' }),
    ])

    expect(clearedMidReplay).toBe(false)
    expect(maxConcurrent).toBe(1)
    // Whichever order they serialize in, the outcome is coherent: either the receipt was cleared and
    // the store is empty, or it was not and the record survives. Never a half-state.
    if ((cleared as { cleared: boolean }).cleared) expect(state.value).toBeNull()
    else expect(state.value).not.toBeNull()
  })
})

// A stuck receipt makes request_ replay forever, so the only route to a new credential was
// clear_stuck_payment_receipt and then request_ — correct, but two calls, and the wallet never said
// so. This is the same thing in one call, keeping the property that made the two-step version safe:
// the consent token is the receipt ID, not a boolean, so nothing can be discarded that the agent was
// not first shown.
describe('discarding a stuck receipt and paying fresh, in one call', () => {
  const stuck = {
    sessionId: '',
    agentName: 'Procurement Assistant',
    createdAt: '2026-08-01T08:00:00.000Z',
    verificationUrl: '',
    paymentReceipt: 'r-stuck',
  }

  function makeStuckDeps() {
    const { deps, sessionStore, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt } = makeDeps()
    return { deps, sessionStore, pay, createSessionChallenge, createSessionSettle, createSessionWithReceipt }
  }

  it('discards the named receipt, pays fresh, and opens a new session', async () => {
    const { deps, sessionStore, pay, createSessionWithReceipt } = makeStuckDeps()
    await sessionStore.set(stuck)

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-stuck',
    })

    expect(out.sessionId).toBeDefined()
    expect(pay).toHaveBeenCalledTimes(1)
    // The old receipt is gone, so nothing replayed it.
    expect(createSessionWithReceipt).not.toHaveBeenCalled()
  })

  // The discarded id exists nowhere else afterwards — the store now holds the NEW session — and it is
  // the first thing support asks for when reconciling a payment that bought nothing.
  it('hands the discarded receipt id back on the result', async () => {
    const { deps, sessionStore } = makeStuckDeps()
    await sessionStore.set(stuck)

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-stuck',
    })

    expect(out.discardedPaymentReceipt).toBe('r-stuck')
  })

  // The safety property: a wrong id must cost nothing at all, neither the old receipt nor a new fee.
  it('a mismatched id discards nothing AND pays nothing', async () => {
    const { deps, sessionStore, pay } = makeStuckDeps()
    await sessionStore.set(stuck)

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-wrong',
    })

    expect(out.error).toMatch(/does not match/i)
    expect(out.error).toMatch(/NOTHING WAS PAID/)
    expect(pay).not.toHaveBeenCalled()
    expect((await sessionStore.get()).paymentReceipt).toBe('r-stuck')
  })

  it('refuses when there is no receipt at all, rather than paying anyway', async () => {
    const { deps, pay } = makeStuckDeps()

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-imagined',
    })

    expect(out.error).toMatch(/no payment receipt/i)
    expect(pay).not.toHaveBeenCalled()
  })

  // R2-M01 again, on the new surface: a live session is already paid for, and its link cannot be
  // reissued. Paying here would buy a second copy of something the user already owns.
  it('refuses to discard a LIVE session, and points at the tools that handle it', async () => {
    const { deps, sessionStore, pay } = makeStuckDeps()
    await sessionStore.set({ ...stuck, sessionId: 's-live', verificationUrl: 'https://zvg.test/link' })

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-stuck',
    })

    expect(out.error).toMatch(/check_ai_birthcert_verification/)
    expect(out.error).toMatch(/clear_stuck_payment_receipt/)
    expect(pay).not.toHaveBeenCalled()
    expect((await sessionStore.get()).sessionId).toBe('s-live')
  })

  // Contradictory intent: one of these spends money and one cannot. Silently honouring the quote
  // would leave the caller believing a receipt had been thrown away.
  it('refuses to combine with dryRun, discarding and quoting nothing', async () => {
    const { deps, sessionStore, pay, createSessionChallenge } = makeStuckDeps()
    await sessionStore.set(stuck)

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      dryRun: true,
      discardStuckReceiptAndPayFresh: 'r-stuck',
    })

    expect(out.error).toMatch(/cannot be combined/i)
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionChallenge).not.toHaveBeenCalled()
    expect((await sessionStore.get()).paymentReceipt).toBe('r-stuck')
  })

  // Not age-gated, matching clear_stuck_payment_receipt: the two-step route has no age gate either,
  // and a rule that can be routed around by making two calls instead of one is not a safety property.
  it('works on a receipt younger than the stuck threshold, since the user asked explicitly', async () => {
    const { deps, sessionStore, pay } = makeStuckDeps()
    await sessionStore.set({ ...stuck, createdAt: '2026-08-17T08:00:00.000Z' })

    const out = await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      discardStuckReceiptAndPayFresh: 'r-stuck',
    })

    expect(out.discardedPaymentReceipt).toBe('r-stuck')
    expect(pay).toHaveBeenCalledTimes(1)
  })

  // An ordinary call must be completely unaffected — this path only exists when explicitly asked for.
  it('changes nothing about a normal request', async () => {
    const { deps, sessionStore, pay, createSessionWithReceipt } = makeStuckDeps()
    await sessionStore.set(stuck)

    const out = await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    // Still replays rather than paying: the block is intact unless the caller names the receipt.
    expect(pay).not.toHaveBeenCalled()
    expect(createSessionWithReceipt).toHaveBeenCalled()
    expect(out.discardedPaymentReceipt).toBeUndefined()
  })
})

describe('APP-M03: a bare replay must not erase the optional fields already paid for', () => {
  const stuckRecord = {
    sessionId: '',
    agentName: 'Procurement Assistant',
    createdAt: '2026-08-17T08:00:00.000Z',
    verificationUrl: '',
    paymentReceipt: 'r-stored',
    agentPurpose: 'Handles procurement negotiations',
    evidenceAssuranceLevel: 'high',
    ownerType: 'organisation',
    ownerVerified: 'true',
  }

  function replayDeps(outcome: Record<string, unknown>) {
    const state: { value: Record<string, unknown> | null } = { value: { ...stuckRecord } }
    const sessionStore = {
      get: vi.fn().mockImplementation(async () => state.value),
      set: vi.fn().mockImplementation(async (s: Record<string, unknown>) => { state.value = s }),
      clear: vi.fn(),
    }
    const createSessionWithReceipt = vi.fn().mockResolvedValue(outcome)
    const ssivc = {
      createSessionChallenge: vi.fn(),
      createSessionSettle: vi.fn(),
      createSessionWithReceipt,
      getSession: vi.fn(),
    }
    return {
      deps: { ...makeDeps().deps, ssivc, sessionStore, sleep: vi.fn().mockResolvedValue(undefined) },
      sessionStore, createSessionWithReceipt, state,
    }
  }

  const queued = { kind: 'queued', paymentReceipt: 'r-stored', retryAfterSeconds: 1 }
  const settled = {
    kind: 'settled',
    session: { sessionId: 's-done', verificationUrl: 'https://zvg.test/v', expiresAt: '2026-08-17T10:00:00+00:00' },
    paymentReceipt: 'r-stored',
  }

  it('replays with the STORED optional fields when the caller supplies none', async () => {
    const { deps, createSessionWithReceipt } = replayDeps(queued)

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(createSessionWithReceipt.mock.calls[0][0]).toMatchObject({
      agentPurpose: 'Handles procurement negotiations',
      evidenceAssuranceLevel: 'high',
      ownerType: 'organisation',
      ownerVerified: 'true',
    })
  })

  it('does not erase the stored fields when re-persisting on a bare retry', async () => {
    const { deps, state } = replayDeps(queued)

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(state.value).toMatchObject({
      paymentReceipt: 'r-stored',
      agentPurpose: 'Handles procurement negotiations',
      evidenceAssuranceLevel: 'high',
    })
  })

  it('lets an explicit caller value win over the stored one', async () => {
    const { deps, createSessionWithReceipt } = replayDeps(queued)

    await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      agentPurpose: 'Updated purpose',
    })

    expect(createSessionWithReceipt.mock.calls[0][0]).toMatchObject({
      agentPurpose: 'Updated purpose',
      evidenceAssuranceLevel: 'high', // untouched stored value still survives
    })
  })

  // R2-L06: asserting on the final store state cannot see this — the give-up write lands last and
  // overwrites whatever the first write contained. But the FIRST write is the REQ-35
  // crash-durability one: it exists precisely for the window where the process dies mid-settlement,
  // and if it dropped the optional fields, a resume after a crash would rebuild an incomplete body
  // and issue the credential without them. Observed through the call log, not the end state.
  it('carries the fields on the FIRST write, the one that survives a crash', async () => {
    const { deps, sessionStore } = replayDeps(queued)

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(sessionStore.set.mock.calls.length).toBeGreaterThan(0)
    expect(sessionStore.set.mock.calls[0][0]).toMatchObject({
      paymentReceipt: 'r-stored',
      agentPurpose: 'Handles procurement negotiations',
      evidenceAssuranceLevel: 'high',
      ownerType: 'organisation',
      ownerVerified: 'true',
    })
  })

  // Benign today (a record with a real sessionId never replays) but the same latent gap.
  it('carries the fields onto the success write too', async () => {
    const { deps, state } = replayDeps(settled)

    await requestAiBirthcertVerification(deps as never, { agentName: 'Procurement Assistant' })

    expect(state.value).toMatchObject({
      sessionId: 's-done',
      agentPurpose: 'Handles procurement negotiations',
    })
  })
})

describe('request_ -> pending -> check_ round trip', () => {
  it('hands a pending settlement from request_ to check_, which drives it to a live session', async () => {
    const state: { value: Record<string, unknown> | null } = { value: null }
    const sessionStore = {
      get: vi.fn().mockImplementation(async () => state.value),
      set: vi.fn().mockImplementation(async (s: Record<string, unknown>) => { state.value = s }),
      clear: vi.fn(),
    }
    const createSessionWithReceipt = vi
      .fn()
      // Every replay inside request_'s budget is still queued, so request_ hands back a pending result.
      .mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-handoff', retryAfterSeconds: 1 })
    const ssivc = {
      createSessionChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [sponsoredAccept] }),
      createSessionSettle: vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-handoff', retryAfterSeconds: 1 }),
      createSessionWithReceipt,
      getSession: vi.fn(),
    }
    const deps = { ...makeDeps().deps, ssivc, sessionStore, sleep: vi.fn().mockResolvedValue(undefined) }

    // 1. request_ pays, settlement stays queued, and it returns early rather than blocking.
    const requested = (await requestAiBirthcertVerification(deps as never, {
      agentName: 'Procurement Assistant',
      agentPurpose: 'Handles procurement negotiations',
    })) as Record<string, unknown>

    expect(requested.settlementPending).toBe(true)
    expect(requested.paymentReceipt).toBe('r-handoff')
    expect(requested.error).toBeUndefined()

    // 2. The settlement completes on SSIVC's side while the user waits.
    createSessionWithReceipt.mockResolvedValue({
      kind: 'settled',
      session: { sessionId: 's-handoff', verificationUrl: 'https://zvg.test/verify/handoff', expiresAt: '2026-08-17T10:00:00+00:00' },
      paymentReceipt: 'r-handoff',
    })

    // 3. check_ — the tool request_ told them to call — finishes the job. It must NOT report
    //    no_session, and must NOT send them back to the paid tool.
    const checked = (await checkAiBirthcertVerification(deps as never)) as Record<string, unknown>

    expect(checked.status).not.toBe('no_session')
    expect(checked.verificationUrl).toBe('https://zvg.test/verify/handoff')
    expect(ssivc.getSession).not.toHaveBeenCalled()
    expect(deps.pay).toHaveBeenCalledTimes(1) // one payment across the whole round trip

    // 4. The optional field the user supplied survived the hand-off into the replayed body.
    expect(createSessionWithReceipt.mock.calls.at(-1)?.[0]).toMatchObject({
      agentPurpose: 'Handles procurement negotiations',
    })
  })
})

describe('clearStuckPaymentReceipt', () => {
  const stuck = {
    sessionId: '',
    agentName: 'Procurement Assistant',
    createdAt: '2026-08-17T08:00:00.000Z',
    verificationUrl: '',
    paymentReceipt: 'r-stuck-123',
  }

  function makeStore(initial: Record<string, unknown> | null) {
    const state: { value: Record<string, unknown> | null } = { value: initial }
    return {
      get: vi.fn().mockImplementation(async () => state.value),
      set: vi.fn().mockImplementation(async (v: Record<string, unknown>) => { state.value = v }),
      clear: vi.fn().mockImplementation(async () => { state.value = null }),
    }
  }

  it('shows the receipt id and asks for confirmation instead of clearing straight away', async () => {
    const sessionStore = makeStore(stuck)

    const out = await clearStuckPaymentReceipt({ sessionStore } as never, {})

    expect(out.cleared).toBe(false)
    expect(out.paymentReceipt).toBe('r-stuck-123')
    expect(out.requiresConfirmation).toBe(true)
    expect(sessionStore.clear).not.toHaveBeenCalled()
  })

  it('warns that clearing forfeits the payment', async () => {
    const out = await clearStuckPaymentReceipt({ sessionStore: makeStore(stuck) } as never, {})

    expect(out.message).toMatch(/cannot be undone|unrecoverable|forfeit|lost/i)
  })

  it('clears only when the caller echoes back the exact receipt id', async () => {
    const sessionStore = makeStore(stuck)

    const out = await clearStuckPaymentReceipt({ sessionStore } as never, { confirmReceiptId: 'r-stuck-123' })

    expect(out.cleared).toBe(true)
    expect(out.paymentReceipt).toBe('r-stuck-123')
    expect(sessionStore.clear).toHaveBeenCalledTimes(1)
    expect(await sessionStore.get()).toBeNull()
  })

  // The echo is the whole safety mechanism: an agent cannot clear a receipt it has not first been
  // shown, so "never automatic" holds by construction rather than by asking it nicely.
  it('refuses a mismatched receipt id and leaves the record alone', async () => {
    const sessionStore = makeStore(stuck)

    const out = await clearStuckPaymentReceipt({ sessionStore } as never, { confirmReceiptId: 'r-wrong' })

    expect(out.cleared).toBe(false)
    expect(out.error).toMatch(/does not match/i)
    expect(sessionStore.clear).not.toHaveBeenCalled()
    expect(await sessionStore.get()).toEqual(stuck)
  })

  it('reports there is nothing to clear when no session is stored', async () => {
    const sessionStore = makeStore(null)

    const out = await clearStuckPaymentReceipt({ sessionStore } as never, {})

    expect(out.cleared).toBe(false)
    expect(out.message).toMatch(/nothing to clear|no .*session/i)
    expect(sessionStore.clear).not.toHaveBeenCalled()
  })

  // A healthy, live session is not a stuck receipt. Discarding one orphans a verification link the
  // user can still act on, so the warning has to distinguish the two cases.
  it('still confirms, but says a live session is being discarded, when the record has a real sessionId', async () => {
    const live = { ...stuck, sessionId: 's-live', verificationUrl: 'https://zvg.test/verify/tok' }

    const out = await clearStuckPaymentReceipt({ sessionStore: makeStore(live) } as never, {})

    expect(out.cleared).toBe(false)
    expect(out.message).toMatch(/live|active|still open|in progress/i)
  })

  // R2-M01. The gap is a TOCTOU across two separate tool calls, not a concurrent one: the receipt
  // id is the only confirmation token, and advancing a queued settlement upgrades the record in
  // place without changing that id — so the id handed out in step 1 still matches after the record
  // has become a live, paid session. Step 2 in this sequence is the exact call the tool's own
  // description tells the agent to make first.
  describe('R2-M01: the record goes live between the two steps', () => {
    const live = { ...stuck, sessionId: 's-9', verificationUrl: 'https://zvg.test/live-link' }

    it('refuses to clear on the receipt id alone once the receipt belongs to a live session', async () => {
      const sessionStore = makeStore(stuck)

      const step1 = await clearStuckPaymentReceipt({ sessionStore } as never, {})
      expect(step1.requiresConfirmation).toBe(true)
      expect(step1.paymentReceipt).toBe('r-stuck-123')

      // check_ai_birthcert_verification advances the settlement: same receipt, now a real session.
      await sessionStore.set(live)

      const step3 = await clearStuckPaymentReceipt({ sessionStore } as never, {
        confirmReceiptId: 'r-stuck-123',
      })

      expect(step3.cleared).toBe(false)
      expect(step3.requiresConfirmation).toBe(true)
      expect(sessionStore.clear).not.toHaveBeenCalled()
      expect(await sessionStore.get()).toEqual(live)
    })

    // The store is the only place verification_url survives — SSIVC issues it once, at creation.
    it('hands back the live session id and its verification link rather than destroying them', async () => {
      const out = await clearStuckPaymentReceipt({ sessionStore: makeStore(live) } as never, {
        confirmReceiptId: 'r-stuck-123',
      })

      expect(out.sessionId).toBe('s-9')
      expect(out.verificationUrl).toBe('https://zvg.test/live-link')
      expect(out.message).toContain('https://zvg.test/live-link')
    })

    it('clears a live session only on the second, separate confirmation', async () => {
      const sessionStore = makeStore(live)

      const out = await clearStuckPaymentReceipt({ sessionStore } as never, {
        confirmReceiptId: 'r-stuck-123',
        confirmDiscardLiveSession: true,
      })

      expect(out.cleared).toBe(true)
      expect(sessionStore.clear).toHaveBeenCalledTimes(1)
      expect(await sessionStore.get()).toBeNull()
    })

    // The success message must not describe discarding a paid, open session in the same terms as
    // clearing a dead end — that wording is what makes the loss legible after the fact.
    it('says a live session was destroyed, not just a receipt', async () => {
      const out = await clearStuckPaymentReceipt({ sessionStore: makeStore(live) } as never, {
        confirmReceiptId: 'r-stuck-123',
        confirmDiscardLiveSession: true,
      })

      expect(out.message).toMatch(/live verification session s-9/i)
    })

    // The extra flag must not become a second hurdle on the ordinary stuck-receipt path, which is
    // what this tool exists for.
    it('does not require the live confirmation for a genuinely stuck receipt', async () => {
      const sessionStore = makeStore(stuck)

      const out = await clearStuckPaymentReceipt({ sessionStore } as never, {
        confirmReceiptId: 'r-stuck-123',
      })

      expect(out.cleared).toBe(true)
      expect(out.message).not.toMatch(/live verification session/i)
    })

    // A wrong id is still rejected as a mismatch, and the live check never leaks the session id to
    // a caller that could not name the receipt.
    it('still rejects a mismatched id before considering the live-session question', async () => {
      const out = await clearStuckPaymentReceipt({ sessionStore: makeStore(live) } as never, {
        confirmReceiptId: 'r-wrong',
        confirmDiscardLiveSession: true,
      })

      expect(out.cleared).toBe(false)
      expect(out.error).toMatch(/does not match/i)
      expect(out.sessionId).toBeUndefined()
    })
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
  // A give-up record (sessionId: '') used to dead-end here — check_ only READ state, so
  // "wait a few minutes and check back", the natural user behaviour and what the agent advised in
  // the 18 Sep 2026 QA run, never progressed anything. Only the PAID tool could resume. check_ must
  // now advance the queued settlement itself. getSession is still never called: there is no session
  // id to look up, and SSIVC 301-redirects an empty path segment rather than 404ing it.
  describe('a queued settlement is advanced, not just reported', () => {
    const queuedRecord = {
      sessionId: '',
      agentName: 'Procurement Assistant',
      createdAt: '2026-08-17T08:00:00.000Z',
      verificationUrl: '',
      paymentReceipt: 'r-queued',
    }

    it('replays the stored receipt instead of dead-ending', async () => {
      const { deps, sessionStore, getSession } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi.fn().mockResolvedValue({
        kind: 'settled',
        session: { sessionId: 's-live', verificationUrl: 'https://zvg.test/verify/live', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'r-queued',
      })
      await sessionStore.set(queuedRecord)

      const out = await checkAiBirthcertVerification(deps as never)

      expect(getSession).not.toHaveBeenCalled()
      expect(deps.ssivc.createSessionWithReceipt).toHaveBeenCalledWith(expect.anything(), 'r-queued')
      expect(out.verificationUrl).toBe('https://zvg.test/verify/live')
      expect(deps.pay).not.toHaveBeenCalled() // never pays — the receipt is already paid for
    })

    it('persists the now-real session so the next call is an ordinary status check', async () => {
      const { deps, sessionStore } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi.fn().mockResolvedValue({
        kind: 'settled',
        session: { sessionId: 's-live', verificationUrl: 'https://zvg.test/verify/live', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'r-queued',
      })
      await sessionStore.set(queuedRecord)

      await checkAiBirthcertVerification(deps as never)

      expect(sessionStore.set).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 's-live', verificationUrl: 'https://zvg.test/verify/live' }),
      )
    })

    // The whole reason the optional fields are persisted at all — check_ has no user input, so the
    // replayed body has to come from the store or the credential loses what the user paid for.
    it('rebuilds the request body from the stored optional fields', async () => {
      const { deps, sessionStore } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi.fn().mockResolvedValue({
        kind: 'settled',
        session: { sessionId: 's-live', verificationUrl: 'https://zvg.test/v', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'r-queued',
      })
      await sessionStore.set({
        ...queuedRecord,
        agentPurpose: 'Handles procurement negotiations',
        evidenceAssuranceLevel: 'high',
        ownerType: 'organisation',
        ownerVerified: 'true',
      })

      await checkAiBirthcertVerification(deps as never)

      const [body] = deps.ssivc.createSessionWithReceipt.mock.calls[0]
      expect(body).toMatchObject({
        agentName: 'Procurement Assistant',
        agentPurpose: 'Handles procurement negotiations',
        evidenceAssuranceLevel: 'high',
        ownerType: 'organisation',
        ownerVerified: 'true',
      })
    })

    // APP-M02: the replay passed a no-op onQueued, justified by "resolveSettlement only ever reports
    // the SAME receipt back" — an assumption about SSIVC nobody confirmed, sitting next to the very
    // machinery request_ wires a real persister into because a receipt CAN change mid-loop (REQ-35).
    // If it ever does, check_ reports the new receipt in chat while the store keeps the dead one, and
    // every later call replays a corpse forever.
    it('persists a receipt that changes mid-replay, instead of keeping the dead one', async () => {
      const { deps, sessionStore, } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi
        .fn()
        .mockResolvedValueOnce({ kind: 'queued', paymentReceipt: 'r-fresh', retryAfterSeconds: 1 })
        .mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-fresh', retryAfterSeconds: 1 })
      deps.sleep = vi.fn().mockResolvedValue(undefined)
      await sessionStore.set(queuedRecord)

      const out = await checkAiBirthcertVerification(deps as never)

      expect(out.paymentReceipt).toBe('r-fresh')
      expect((await sessionStore.get()).paymentReceipt).toBe('r-fresh')
    })

    it('keeps the stored optional fields when re-persisting a changed receipt', async () => {
      const { deps, sessionStore } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi
        .fn()
        .mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-fresh', retryAfterSeconds: 1 })
      deps.sleep = vi.fn().mockResolvedValue(undefined)
      await sessionStore.set({ ...queuedRecord, agentPurpose: 'Handles procurement negotiations' })

      await checkAiBirthcertVerification(deps as never)

      expect(await sessionStore.get()).toMatchObject({
        paymentReceipt: 'r-fresh',
        agentPurpose: 'Handles procurement negotiations',
      })
    })

    // SSIVC returns the same `status_code 69` ("settlement status could not be confirmed.
    // Please retry.") whether the settlement is two minutes old or three weeks old — confirmed live
    // on 2026-09-21 against two independently stuck receipts, one 19 days old and still 69. Their
    // code cannot separate "still in flight" from "never coming back", so the wallet uses the
    // receipt's own age. Neither branch pays again or discards the receipt: only the wording differs.
    describe('an unconfirmed settlement is read by the receipt\'s age, not by the status code', () => {
      const unconfirmed = () =>
        Object.assign(new SsivcError('SSIVC request failed — HTTP 400: Payment settlement status could not be confirmed. Please retry.', 400, '69', 'settlement_unconfirmed'))

      async function checkWithAge(createdAt: string, stuckAfterMs?: number) {
        const { deps, sessionStore } = makeDeps()
        deps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(unconfirmed())
        if (stuckAfterMs !== undefined) deps.settlementStuckAfterMs = stuckAfterMs
        await sessionStore.set({ ...queuedRecord, createdAt })
        const out = await checkAiBirthcertVerification(deps as never)
        return { out, sessionStore, deps }
      }

      // now() is 2026-08-17T09:00:00Z in makeDeps, so this receipt is one hour old.
      it('a fresh one reads as still settling: PAYMENT SENT, no alarm, receipt kept', async () => {
        const { out, sessionStore } = await checkWithAge('2026-08-17T08:00:00.000Z')

        expect(out.status).toBe('settlement_pending')
        expect(out.message).toMatch(/^PAYMENT SENT/)
        expect(out.outcomeUnknown).toBeUndefined()
        expect(out.paymentReceipt).toBe('r-queued')
        expect(out.message).not.toMatch(/operator|forfeit|second fee/i)
        expect((await sessionStore.get()).paymentReceipt).toBe('r-queued')
      })

      // Sixteen days old: past the point where "check back in a few minutes" is honest.
      it('an old one reads as permanently stuck, and says the fee was most likely taken', async () => {
        const { out, sessionStore } = await checkWithAge('2026-08-01T08:00:00.000Z')

        expect(out.status).toBe('settlement_pending')
        expect(out.message).toMatch(/^OUTCOME UNKNOWN/)
        expect(out.outcomeUnknown).toBe(true)
        expect(out.stuckFor).toMatch(/days/)
        expect(out.message).toMatch(/most likely already taken/i)
        // The receipt is still the only evidence of a real payment, so it is never dropped for them.
        expect((await sessionStore.get()).paymentReceipt).toBe('r-queued')
      })

      // The whole point of naming the cost: starting over is not free, and the old wording never said so.
      it('tells the user starting over costs a SECOND fee, and names the tool that does it', async () => {
        const { out } = await checkWithAge('2026-08-01T08:00:00.000Z')

        expect(out.message).toMatch(/SECOND fee/)
        expect(out.message).toMatch(/clear_stuck_payment_receipt/)
      })

      it('honours an injected threshold rather than the 24h default', async () => {
        // One hour old, but the threshold is one minute — so it counts as stuck.
        const { out } = await checkWithAge('2026-08-17T08:00:00.000Z', 60_000)

        expect(out.message).toMatch(/^OUTCOME UNKNOWN/)
        expect(out.outcomeUnknown).toBe(true)
      })

      // Fail safe: an unreadable timestamp must produce the message that keeps the receipt and tells
      // nobody their money is gone, not the one that declares a loss.
      it('treats an unparseable createdAt as brand new', async () => {
        const { out } = await checkWithAge('not-a-date')

        expect(out.message).toMatch(/^PAYMENT SENT/)
        expect(out.outcomeUnknown).toBeUndefined()
      })

      // The classification earns its keep here: "they told us they cannot confirm it" is evidence
      // about where the money went; "we could not reach them" is not, and must not be dressed up as
      // though it were — the stuck verdict leans on that distinction.
      it('says the payment service cannot confirm it, rather than blaming our own call', async () => {
        const { out } = await checkWithAge('2026-08-01T08:00:00.000Z')

        expect(out.message).toMatch(/payment service reports that it cannot confirm/i)
        expect(out.message).not.toMatch(/call itself failed/i)
      })

      it('still reports a local failure as a local failure', async () => {
        const { deps, sessionStore } = makeDeps()
        deps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
        await sessionStore.set({ ...queuedRecord, createdAt: '2026-08-01T08:00:00.000Z' })

        const out = await checkAiBirthcertVerification(deps as never)

        expect(out.message).toMatch(/call itself failed/i)
        expect(out.message).toContain('ECONNRESET')
        expect(out.message).not.toMatch(/payment service reports/i)
      })

      // The original scope of this work, unblocked once the UAT spec revealed 67/68 alongside 69: SSIVC can
      // now say a receipt is finished, which is a different thing from not knowing.
      describe('67 and 68 are terminal, and age is irrelevant to them', () => {
        const voidErr = (code: string, text: string) =>
          new SsivcError(`SSIVC request failed — HTTP 400: ${text}`, 400, code, 'settlement_void')

        async function checkVoid(code: string, text: string, createdAt = '2026-08-17T08:00:00.000Z') {
          const { deps, sessionStore } = makeDeps()
          deps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(voidErr(code, text))
          await sessionStore.set({ ...queuedRecord, createdAt })
          const out = await checkAiBirthcertVerification(deps as never)
          return { out, sessionStore, deps }
        }

        it('reports 67 as receipt_void, not as something to check again', async () => {
          const { out } = await checkVoid('67', 'Sponsored settlement expired. Payment required again.')

          expect(out.status).toBe('receipt_void')
          expect(out.message).toMatch(/^RECEIPT VOID/)
          expect(out.message).toMatch(/checking again will not change this/i)
          expect(out.paymentReceipt).toBe('r-queued')
        })

        it('reports 68 the same way', async () => {
          const { out } = await checkVoid('68', 'Payment settlement failed. This receipt can no longer be used.')

          expect(out.status).toBe('receipt_void')
          expect(out.message).toMatch(/^RECEIPT VOID/)
        })

        // A one-hour-old void receipt is just as dead as a three-week-old one. Running it through the
        // age split would tell the user to check back on something SSIVC has already ruled on.
        it('does not soften a fresh one into "still settling"', async () => {
          const fresh = await checkVoid('67', 'Sponsored settlement expired.', '2026-08-17T08:59:00.000Z')

          expect(fresh.out.status).toBe('receipt_void')
          expect(fresh.out.message).not.toMatch(/PAYMENT SENT/)
          expect(fresh.out.stuckFor).toBeUndefined()
        })

        // The money question this whole ticket turned on: expiry does NOT mean the fee was refunded,
        // Measured on the stuck-settlement incident. The message must not imply otherwise.
        it('never claims the user was not charged, and hands them the receipt', async () => {
          const { out } = await checkVoid('67', 'Sponsored settlement expired. Payment required again.')

          expect(out.message).toMatch(/not settled by this/i)
          expect(out.message).toMatch(/do not tell the user they were not charged/i)
          expect(out.message).toContain('r-queued')
        })

        it('names the paid way forward and still never pays by itself', async () => {
          const { out, deps, sessionStore } = await checkVoid('68', 'Payment settlement failed.')

          expect(out.message).toMatch(/discardStuckReceiptAndPayFresh/)
          expect(out.message).toMatch(/pay(ing)? the fee AGAIN/i)
          expect(deps.pay).not.toHaveBeenCalled()
          // The receipt survives: it is the evidence of a payment that may really have left.
          expect((await sessionStore.get()).paymentReceipt).toBe('r-queued')
        })
      })

      it('never pays again, on either side of the threshold', async () => {
        const fresh = await checkWithAge('2026-08-17T08:00:00.000Z')
        const old = await checkWithAge('2026-08-01T08:00:00.000Z')

        expect(fresh.deps.pay).not.toHaveBeenCalled()
        expect(old.deps.pay).not.toHaveBeenCalled()
      })
    })

    it('reports it as still pending, with the receipt, when it has not settled yet', async () => {
      const { deps, sessionStore, getSession } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-queued', retryAfterSeconds: 1 })
      deps.sleep = vi.fn().mockResolvedValue(undefined)
      await sessionStore.set(queuedRecord)

      const out = await checkAiBirthcertVerification(deps as never)

      expect(getSession).not.toHaveBeenCalled()
      expect(out.status).toBe('settlement_pending')
      expect(out.paymentReceipt).toBe('r-queued')
      expect(deps.pay).not.toHaveBeenCalled()
    })

    it('leaves the stored receipt intact when the replay outcome is unknown', async () => {
      const { deps, sessionStore } = makeDeps()
      deps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(new Error('connection reset'))
      await sessionStore.set(queuedRecord)

      const out = await checkAiBirthcertVerification(deps as never)

      expect(out.paymentReceipt).toBe('r-queued')
      expect((await sessionStore.get()).paymentReceipt).toBe('r-queued')
    })

    // R2-L01: one status, two situations. "Queued, check back in a few minutes" and "we do not know
    // whether this settled" call for different advice to the user, and an agent reading only
    // `status` cannot tell them apart — so the distinction has to be a field, not just prose.
    it('flags an undetermined outcome as outcomeUnknown, and a merely queued one not at all', async () => {
      const { deps: unknownDeps, sessionStore: unknownStore } = makeDeps()
      unknownDeps.ssivc.createSessionWithReceipt = vi.fn().mockRejectedValue(new Error('connection reset'))
      // Aged past the stuck threshold. Under it, an unresolved outcome is reported as
      // PAYMENT SENT rather than OUTCOME UNKNOWN — see the block below.
      await unknownStore.set({ ...queuedRecord, createdAt: '2026-08-01T08:00:00.000Z' })

      const unknown = await checkAiBirthcertVerification(unknownDeps as never)

      expect(unknown.status).toBe('settlement_pending')
      expect(unknown.outcomeUnknown).toBe(true)
      expect(unknown.message).toMatch(/^OUTCOME UNKNOWN/)

      const { deps: queuedDeps, sessionStore: queuedStore } = makeDeps()
      queuedDeps.ssivc.createSessionWithReceipt = vi.fn().mockResolvedValue({ kind: 'queued', paymentReceipt: 'r-queued', retryAfterSeconds: 1 })
      queuedDeps.sleep = vi.fn().mockResolvedValue(undefined)
      await queuedStore.set(queuedRecord)

      const stillQueued = await checkAiBirthcertVerification(queuedDeps as never)

      expect(stillQueued.status).toBe('settlement_pending')
      expect(stillQueued.outcomeUnknown).toBeUndefined()
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

  it('on issued: writes the pass image and returns/caches vcPassImagePaths when extraData.vcPassBase64 is present', async () => {
    const { deps, sessionStore, getSession } = makeDeps({ passImagesDir })
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([
      { vc, extraData: { vcPassBase64: [Buffer.from('verified-pass-bytes').toString('base64')] } },
    ])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out.vcPassImagePaths).toHaveLength(1)
    expect(readFileSync(out.vcPassImagePaths![0], 'utf8')).toBe('verified-pass-bytes')
    expect(deps.cache.set).toHaveBeenCalledWith(
      'did:zid:verified-template',
      expect.objectContaining({ vcPassImagePaths: expect.arrayContaining([expect.stringContaining(passImagesDir)]) }),
    )
  })

  // Code review (APP-M01): the writeVcPassImages call here was an unguarded IIFE — a
  // filesystem failure rejected checkAiBirthcertVerification and turned an already-validated,
  // already-paid-for credential into a reported failure instead of degrading vcPassImagePaths to
  // undefined as the surrounding docblock promises.
  it('on issued: still returns the credential when writing the pass image to disk fails', async () => {
    // A file, not a directory, at passImagesDir — mkdir/writeFile inside writeVcPassImages must fail.
    rmSync(passImagesDir, { recursive: true, force: true })
    writeFileSync(passImagesDir, 'not a directory')
    const { deps, sessionStore, getSession } = makeDeps({ passImagesDir })
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([
      { vc, extraData: { vcPassBase64: [Buffer.from('verified-pass-bytes').toString('base64')] } },
    ])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out.status).toBe('issued')
    expect((out as { vcId?: string }).vcId).toBe('did:zid:vc-1')
    expect(out.vcPassImagePaths).toBeUndefined()
  })

  it('on issued: does not set vcPassImagePaths when the downloaded entry carries no extraData.vcPassBase64', async () => {
    const { deps, sessionStore, getSession } = makeDeps({ passImagesDir })
    await sessionStore.set({ sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-13T09:00:00.000Z' })
    getSession.mockResolvedValue({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-13T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:owner123' }, validUntil: '2028-08-13T00:00:00Z' }
    deps.mbi.downloadVcs = vi.fn().mockResolvedValue([{ vc, extraData: null }])

    const out = await checkAiBirthcertVerification(deps as never)

    expect(out.vcPassImagePaths).toBeUndefined()
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
    const out = await runRequestRaw({ ssivc, pay, sleep: vi.fn().mockResolvedValue(undefined), maxSettlementAttempts: 2 })

    expect(pay).toHaveBeenCalledTimes(1)              // never re-paid
    expect(out.settlementPending).toBe(true)
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
        withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()),
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
        withLock: vi.fn((_vcId: string, fn: () => Promise<unknown>) => fn()),
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
