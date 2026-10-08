/**
 * The four x402 paying paths report a Wallet BE policy refusal as what it is.
 *
 * Wallet BE gates every signature that spends the signer's assets, so the same two codes that
 * `transfer_token` handles can reach `pay_and_fetch`, `subscribe_and_issue`, the Verified AI Birthcert
 * session fee and `write_policy`'s fee. The refusal arrives as the failure of `sign`, the last step before the
 * X-PAYMENT header exists, so on every path nothing was signed and nothing was paid — and the wording must say
 * exactly that, and what each path HAD done, while keeping a decision (1000033, retrying will not help) apart from
 * a check that could not complete (1000034, trying again shortly is right).
 *
 * Every path is driven through the REAL WalletBeClient, with Wallet BE's real shape (HTTP 200, an `errorCode`
 * in the body), because a double that throws a hand-built error proves only that the double matches the matcher.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { WalletBeClient, WalletBeError } from '../clients/wallet-be-client'
import {
  boundedReason,
  describePolicyRefusal,
  MAX_REASON_CHARS,
  PaymentPolicyError,
  policyRefusalFlags,
  toPaymentPolicyError,
} from '../policy-refusal'
import { createPayer } from '../orchestrator/pay'
import { subscribeAndIssue } from '../orchestrator/subscribe'
import { requestAiBirthcertVerification } from '../orchestrator/verify-ai-birthcert'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import { PaymentReadinessError } from '../payment-readiness'

afterEach(() => {
  vi.unstubAllGlobals()
})

const client = new WalletBeClient('https://wallet-be.test')
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'

/** What Wallet BE sends: HTTP 200, the code in the body. */
const envelope = (errorCode: number, message: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ errorCode, message }),
  text: async () => JSON.stringify({ errorCode, message }),
})

/** The error the REAL client throws for that reply — what a paying path's `sign` actually rejects with. */
async function realRefusal(errorCode: number, message: string): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope(errorCode, message)))
  try {
    await client.signBlob('0102', OWNER, 'pw')
  } catch (e) {
    return e
  }
  throw new Error('the client did not throw')
}

const DENIED = () => realRefusal(1000033, 'Policy denied: PER_TRANSACTION_EXCEEDED')
const UNAVAILABLE = () => realRefusal(1000034, 'Policy check unavailable, not signed. Retry later.')

describe('toPaymentPolicyError', () => {
  it('classifies the two real envelopes', async () => {
    const denied = toPaymentPolicyError(await DENIED())
    expect(denied).toBeInstanceOf(PaymentPolicyError)
    expect(denied?.kind).toBe('denied')
    expect(denied?.reason).toContain('PER_TRANSACTION_EXCEEDED')
    const unavailable = toPaymentPolicyError(await UNAVAILABLE())
    expect(unavailable?.kind).toBe('unavailable')
    expect(unavailable?.reason).toContain('Retry later')
  })

  it('keeps the original error as the cause', async () => {
    const original = await DENIED()
    expect(toPaymentPolicyError(original)?.cause).toBe(original)
  })

  it('accepts a structured policyCode as a denial, and only a non-empty string', () => {
    expect(toPaymentPolicyError({ policyCode: 'PER_TRANSACTION_EXCEEDED', message: 'x' })?.kind).toBe('denied')
    expect(toPaymentPolicyError({ policyCode: '', message: 'x' })).toBeNull()
    expect(toPaymentPolicyError({ policyCode: 5, message: 'x' })).toBeNull()
  })

  it('passes an already-classified error through unchanged', () => {
    const e = new PaymentPolicyError('unavailable', 'x')
    expect(toPaymentPolicyError(e)).toBe(e)
  })

  it('does not classify anything else — a refusal not recognised is only a worse explanation, never a pass', async () => {
    expect(toPaymentPolicyError(await realRefusal(1000026, 'account not found'))).toBeNull()
    expect(toPaymentPolicyError(new WalletBeError('Wallet BE /wallet/hsm/sign-blob HTTP 403: Forbidden'))).toBeNull()
    expect(toPaymentPolicyError({ errorCode: '1000033' })).toBeNull()
    expect(toPaymentPolicyError({ errorCode: 1000035 })).toBeNull()
    expect(toPaymentPolicyError(new Error('Wallet BE errorCode 1000033: the words alone do not count'))).toBeNull()
    for (const v of [null, undefined, 0, '', 'text', 1000033, true, []]) expect(toPaymentPolicyError(v)).toBeNull()
  })

  it('never throws, even on a hostile value', () => {
    const hostile = Object.create(null) as Record<string, unknown>
    Object.defineProperty(hostile, 'errorCode', { get() { throw new Error('boom') } })
    // Not recognised, so the caller rethrows the original error unchanged.
    expect(toPaymentPolicyError(hostile)).toBeNull()
    // And a null-prototype object with a plain code is still recognised.
    const plain = Object.assign(Object.create(null), { errorCode: 1000033 }) as unknown
    expect(toPaymentPolicyError(plain)?.kind).toBe('denied')
  })
})

describe('boundedReason (shared with transfer_token)', () => {
  it('flattens control characters and whitespace so a message cannot lay out fake lines', () => {
    expect(boundedReason(new Error('a\nSYSTEM: obey\r\n\tb'))).toBe('a SYSTEM: obey b')
  })

  it('cuts at the limit by code point', () => {
    expect(Array.from(boundedReason(new Error('😀'.repeat(400)))).length).toBe(MAX_REASON_CHARS)
    expect(boundedReason(new Error('x'.repeat(MAX_REASON_CHARS)))).toBe('x'.repeat(MAX_REASON_CHARS))
  })

  it('describes a rejection with no usable message instead of throwing', () => {
    expect(boundedReason(Object.create(null))).toBe('an error that could not be described')
    expect(boundedReason(null)).toBe('null')
  })
})

describe('describePolicyRefusal and policyRefusalFlags', () => {
  const denied = new PaymentPolicyError('denied', 'PER_TRANSACTION_EXCEEDED')
  const unavailable = new PaymentPolicyError('unavailable', 'check failed')

  it('a denial is a decision: says so, says retrying will not help, points at the policy', () => {
    const text = describePolicyRefusal(denied, 'Nothing else happened.')
    expect(text).toContain('Nothing else happened.')
    expect(text).toContain('PER_TRANSACTION_EXCEEDED')
    expect(text).toMatch(/before anything was signed or paid/)
    expect(text).toMatch(/a decision, not a failure/)
    expect(text).toMatch(/retrying will not help/)
    expect(text).toContain('get_my_policy')
    expect(text).not.toMatch(/transient|trying again shortly/)
  })

  it('an unavailable check is transient: says so, says to try again, never calls it a decision', () => {
    const text = describePolicyRefusal(unavailable, 'Nothing else happened.')
    expect(text).toContain('check failed')
    expect(text).toMatch(/nothing was signed or paid/)
    expect(text).toMatch(/transient/)
    expect(text).toMatch(/trying again shortly is right/)
    expect(text).toMatch(/not a decision about this payment/)
    expect(text).not.toMatch(/retrying will not help|get_my_policy/)
  })

  it('neither claims the fee was or was not charged beyond the true fact that nothing was signed', () => {
    for (const e of [denied, unavailable]) expect(describePolicyRefusal(e, 'x')).not.toMatch(/was charged|was taken|refund/i)
  })

  it('flags are mutually exclusive', () => {
    expect(policyRefusalFlags(denied)).toEqual({ policyDenied: true })
    expect(policyRefusalFlags(unavailable)).toEqual({ policyCheckUnavailable: true })
  })
})

describe('pay_and_fetch (createPayer)', () => {
  const ACCEPT = { scheme: 'exact', asset: 'ZTX3jmyr', payTo: 'ZTX3pay', maxAmountRequired: '1000', extra: { gasModel: 'client' } }
  const paymentRequired = () => ({ status: 402, text: async () => '', json: async () => ({ accepts: [ACCEPT] }) })
  const payerWith = (pay: (a: unknown) => Promise<string>) => {
    const fetchFn = vi.fn().mockResolvedValue(paymentRequired())
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    return { fetchFn, resolveSymbol, payer: createPayer({ pay: pay as never, resolveSymbol, fetchFn: fetchFn as never }) }
  }

  it('a denial is a RESULT: nothing paid, no retry request, flagged as a decision', async () => {
    const e = await DENIED()
    const { payer, fetchFn, resolveSymbol } = payerWith(async () => { throw e })
    const out = await payer({ url: 'https://x.test/data' })
    expect(out).toMatchObject({ status: 402, body: '', paymentMade: false, amountPaid: '', asset: '', policyDenied: true })
    expect(out.policyCheckUnavailable).toBeUndefined()
    expect(out.insufficientFunds).toBeUndefined()
    expect(out.reason).toContain('PER_TRANSACTION_EXCEEDED')
    expect(out.reason).toContain('the wallet did not pay it')
    expect(out.reason).toMatch(/retrying will not help/)
    // One request only: the unpaid one. A retry carrying x-payment would mean money was presented.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(resolveSymbol).not.toHaveBeenCalled()
  })

  it('an unavailable check is a RESULT, flagged transient', async () => {
    const e = await UNAVAILABLE()
    const { payer, fetchFn } = payerWith(async () => { throw e })
    const out = await payer({ url: 'https://x.test/data' })
    expect(out).toMatchObject({ status: 402, paymentMade: false, policyCheckUnavailable: true })
    expect(out.policyDenied).toBeUndefined()
    expect(out.reason).toMatch(/trying again shortly is right/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('an already-classified refusal is reported the same way', async () => {
    const { payer } = payerWith(async () => { throw new PaymentPolicyError('denied', 'R') })
    expect(await payer({ url: 'https://x.test/data' })).toMatchObject({ policyDenied: true })
  })

  it('every other failure still throws, so nothing is swallowed into a result', async () => {
    for (const e of [new Error('boom'), await realRefusal(1000026, 'account not found'), new WalletBeError('Wallet BE HTTP 403: Forbidden')]) {
      const { payer } = payerWith(async () => { throw e })
      await expect(payer({ url: 'https://x.test/data' })).rejects.toBe(e)
    }
  })

  it('insufficient funds is unchanged', async () => {
    const shortfall = { asset: 'ZTX', required: '100', available: '10', reason: 'gas' as const }
    const { payer } = payerWith(async () => { throw new PaymentReadinessError('short', shortfall) })
    const out = await payer({ url: 'https://x.test/data' })
    expect(out.insufficientFunds).toEqual(shortfall)
    expect(out.policyDenied).toBeUndefined()
  })

  it('the paying path is unchanged: pays, retries with x-payment, reports the symbol', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce({ status: 200, text: async () => 'data' })
    const payer = createPayer({ pay: async () => 'HDR', resolveSymbol: async () => 'JMYR', fetchFn: fetchFn as never })
    const out = await payer({ url: 'https://x.test/data' })
    expect(out).toEqual({ status: 200, body: 'data', paymentMade: true, amountPaid: '1000', amountPaidHuman: '', asset: 'JMYR' })
    expect(fetchFn.mock.calls[1][1].headers['x-payment']).toBe('HDR')
  })

  it('a response that is not a 402 is passed through untouched', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, text: async () => 'free' })
    const pay = vi.fn()
    const out = await createPayer({ pay, resolveSymbol: async () => '', fetchFn: fetchFn as never })({ url: 'https://x.test/free' })
    expect(out).toEqual({ status: 200, body: 'free', paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '' })
    expect(pay).not.toHaveBeenCalled()
  })

  it('a 402 with no accepts still throws', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ status: 402, text: async () => '', json: async () => ({}) })
    await expect(createPayer({ pay: vi.fn(), resolveSymbol: async () => '', fetchFn: fetchFn as never })({ url: 'https://x.test' })).rejects.toThrow(/no accepts/)
  })
})

describe('subscribe_and_issue', () => {
  const holderDid = 'did:zid:holder-self-1'
  const opts = { templateId: 'did:zid:t-1', attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } }
  const accept = { payTo: 'ZTXissuer', asset: 'ZTX3jmyrcontract0000000000000000000', maxAmountRequired: '1000000', extra: { paymentId: 'pid-1' } }
  const fields = { required: [] as string[], allKeys: ['agentDid', 'agentName', 'purpose'] }

  function harness(payError: unknown) {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockRejectedValue(payError)
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), list: vi.fn().mockResolvedValue([]) }
    const resolveTemplateFields = vi.fn().mockResolvedValue(fields)
    return { mbi, sign, pay, cache, resolveTemplateFields }
  }

  it('a denial: not issued, nothing paid, flagged as a decision, and says what DID happen', async () => {
    const h = harness(await DENIED())
    const out = await subscribeAndIssue({ ...h, holderDid } as never, opts)
    expect(out.issued).toBe(false)
    expect(out.policyDenied).toBe(true)
    expect(out.policyCheckUnavailable).toBeUndefined()
    expect(out.reason).toContain('PER_TRANSACTION_EXCEEDED')
    expect(out.reason).toContain('No credential was issued')
    expect(out.reason).toContain('a payment request, which moves no money')
    expect(out.reason).toMatch(/retrying will not help/)
    // Money did not move and nothing was issued: settle never ran and nothing was cached.
    expect(h.mbi.applySettle).not.toHaveBeenCalled()
    expect(h.cache.set).not.toHaveBeenCalled()
    expect(out.paymentAttempted).toBeUndefined()
    expect(out.schema).toBeDefined()
  })

  it('an unavailable check: not issued, flagged transient', async () => {
    const h = harness(await UNAVAILABLE())
    const out = await subscribeAndIssue({ ...h, holderDid } as never, opts)
    expect(out).toMatchObject({ issued: false, policyCheckUnavailable: true })
    expect(out.policyDenied).toBeUndefined()
    expect(out.reason).toMatch(/trying again shortly is right/)
    expect(h.mbi.applySettle).not.toHaveBeenCalled()
  })

  it('does not call it insufficient funds', async () => {
    const out = await subscribeAndIssue({ ...harness(await DENIED()), holderDid } as never, opts)
    expect(out.insufficientFunds).toBeUndefined()
    expect(out.reason).not.toMatch(/insufficient funds/i)
  })

  it('any other failure from pay still throws', async () => {
    for (const e of [new Error('boom'), await realRefusal(1000026, 'account not found')]) {
      await expect(subscribeAndIssue({ ...harness(e), holderDid } as never, opts)).rejects.toBe(e)
    }
  })

  it('insufficient funds is unchanged', async () => {
    const shortfall = { asset: 'JMYR', required: '1000000', available: '0', reason: 'resource_payment' as const }
    const out = await subscribeAndIssue({ ...harness(new PaymentReadinessError('short', shortfall)), holderDid } as never, opts)
    expect(out.insufficientFunds).toEqual(shortfall)
    expect(out.policyDenied).toBeUndefined()
  })
})

describe('Verified AI Birthcert session fee', () => {
  const SELF = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTX3Pay', maxAmountRequired: '1000', extra: { gasModel: 'client' } }
  const SPONSORED = {
    scheme: 'exact',
    network: 'zetrix:testnet',
    asset: 'ZTX3jmyr',
    payTo: 'ZTX3Pay',
    maxAmountRequired: '1000',
    extra: { gasModel: 'facilitator', prepareEndpoint: 'https://facilitator.test/prepare' },
  }

  function harness(payError: unknown, accepts: unknown[] = [SELF]) {
    const createSessionChallenge = vi.fn().mockResolvedValue({ x402Version: 2, accepts })
    const createSessionSettle = vi.fn()
    const createSessionWithReceipt = vi.fn()
    const pay = vi.fn().mockRejectedValue(payError)
    const stored: { value: Record<string, unknown> | null } = { value: null }
    const sessionStore = {
      get: vi.fn().mockImplementation(async () => stored.value),
      set: vi.fn().mockImplementation(async (s: Record<string, unknown>) => { stored.value = s }),
      clear: vi.fn().mockImplementation(async () => { stored.value = null }),
    }
    const deps = {
      ssivc: { createSessionChallenge, createSessionSettle, createSessionWithReceipt, getSession: vi.fn() },
      signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      messageSigner: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' }),
      mbi: { downloadVcs: vi.fn().mockResolvedValue([]) },
      pay,
      publicKeyHex: 'b001pk',
      address: 'ZTX3F7fCN3zDga7qPxwxfpRRXiVa2pDdGCgxw',
      holderDid: 'did:zid:owner123',
      now: () => new Date('2026-08-17T09:00:00.000Z'),
      sessionStore,
      verifiedTemplateId: 'did:zid:verified-template',
      cache: { get: vi.fn(), set: vi.fn(), list: vi.fn() },
      quarantine: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), filePathFor: vi.fn(), withLock: vi.fn((_v: string, fn: () => Promise<unknown>) => fn()) },
    }
    return { deps, createSessionSettle, createSessionWithReceipt, pay, sessionStore }
  }

  it('a denial: an error result flagged as a decision, no session, nothing stored', async () => {
    const h = harness(await DENIED())
    const out = (await requestAiBirthcertVerification(h.deps as never, { agentName: 'Procurement Assistant' })) as Record<string, unknown>
    expect(out.policyDenied).toBe(true)
    expect(out.policyCheckUnavailable).toBeUndefined()
    expect(String(out.error)).toContain('PER_TRANSACTION_EXCEEDED')
    expect(String(out.error)).toContain('Nothing was paid and no verification session was created')
    expect(String(out.error)).toMatch(/retrying will not help/)
    expect(out.insufficientFunds).toBeUndefined()
    expect(h.createSessionSettle).not.toHaveBeenCalled()
    expect(h.createSessionWithReceipt).not.toHaveBeenCalled()
    // A refusal before payment leaves no receipt to resume, so nothing is recorded that a later call could replay.
    expect(h.sessionStore.set).not.toHaveBeenCalled()
  })

  it('an unavailable check: an error result flagged transient', async () => {
    const h = harness(await UNAVAILABLE())
    const out = (await requestAiBirthcertVerification(h.deps as never, { agentName: 'Procurement Assistant' })) as Record<string, unknown>
    expect(out.policyCheckUnavailable).toBe(true)
    expect(out.policyDenied).toBeUndefined()
    expect(String(out.error)).toMatch(/trying again shortly is right/)
    expect(h.createSessionSettle).not.toHaveBeenCalled()
  })

  it('does NOT fall back to the other gas option after a refusal — a second signature would be a second attempt at the same spend', async () => {
    for (const e of [await DENIED(), await UNAVAILABLE()]) {
      const h = harness(e, [SPONSORED, SELF])
      await requestAiBirthcertVerification(h.deps as never, { agentName: 'Procurement Assistant', gasPayer: 'sponsored' })
      expect(h.pay).toHaveBeenCalledTimes(1)
      expect(h.createSessionSettle).not.toHaveBeenCalled()
    }
  })

  it('any other failure from pay still throws', async () => {
    const e = new Error('boom')
    await expect(requestAiBirthcertVerification(harness(e).deps as never, { agentName: 'Procurement Assistant' })).rejects.toBe(e)
  })

  it('insufficient funds is unchanged', async () => {
    const shortfall = { asset: 'ZTX', required: '100', available: '10', reason: 'gas' as const }
    const out = (await requestAiBirthcertVerification(
      harness(new PaymentReadinessError('short', shortfall)).deps as never,
      { agentName: 'Procurement Assistant' },
    )) as Record<string, unknown>
    expect(out.insufficientFunds).toEqual(shortfall)
    expect(out.policyDenied).toBeUndefined()
  })
})

describe('write_policy fee', () => {
  const BASE = 'https://public-api-sandbox.zetrix.com/api'
  const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
  const INPUT = {
    policyKey: 'native-v1',
    attributes: [{ attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' }],
    templateContractAddress: TEMPLATE,
    templateId: 'a'.repeat(64),
    requestKey: 'req-1',
    pollBudgetMs: 10_000,
    confirm: true,
  }
  const CHALLENGE = {
    x402Version: 1,
    accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '1000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://f.test/prepare' } }],
  }

  const send = () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fn = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers })
      return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify(CHALLENGE) }
    }) as unknown as HttpSend
    return { fn, calls }
  }
  const memoryStore = (): PolicyWriteReceiptStore => {
    const map = new Map<string, PolicyWriteReceipt>()
    return {
      async get(id) { return map.get(id) ?? null },
      async set(r) { map.set(r.blobId, r) },
      async list() { return [...map.values()] },
      async remove(id) { map.delete(id) },
      filePathFor: (id) => `/memory/${id}`,
    }
  }
  function harness(payError: unknown) {
    const http = send()
    const receipts = memoryStore()
    const pay = vi.fn().mockRejectedValue(payError)
    const d: WritePolicyDeps = {
      client: new PolicyWriteClient(BASE, http.fn),
      receipts,
      pay,
      chooseAccept: (accepts) => accepts[0],
      hsmPassword: 'hunter2',
      ownerAddress: OWNER,
      network: 'zetrix:testnet',
      sleep: async () => undefined,
      templateContract: TEMPLATE,
      preflight: async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [] }),
    }
    return { d, http, pay, receipts }
  }

  it('a denial is state "refused": nothing paid, no policy, flagged as a decision, nothing presented for payment', async () => {
    const h = harness(await DENIED())
    const out = await writePolicy(h.d, INPUT as never)
    expect(out.state).toBe('refused')
    expect(out.policyKey).toBe('native-v1')
    expect(out.policyDenied).toBe(true)
    expect(out.policyCheckUnavailable).toBeUndefined()
    expect(out.paid).toBe(false)
    expect(out.paymentReceipt).toBeUndefined()
    expect(out.message).toContain('PER_TRANSACTION_EXCEEDED')
    expect(out.message).toContain('No policy was written. The free pre-check had passed.')
    expect(out.message).toMatch(/retrying will not help/)
    // Only the free pre-check went out: nothing carried a payment header, and nothing was bookmarked.
    expect(h.http.calls).toHaveLength(1)
    expect(h.http.calls[0].headers['X-PAYMENT']).toBeUndefined()
    expect(await h.receipts.list()).toEqual([])
  })

  it('an unavailable check is state "unavailable": nothing paid, flagged transient', async () => {
    const h = harness(await UNAVAILABLE())
    const out = await writePolicy(h.d, INPUT as never)
    expect(out.state).toBe('unavailable')
    expect(out.policyKey).toBe('native-v1')
    expect(out.policyCheckUnavailable).toBe(true)
    expect(out.policyDenied).toBeUndefined()
    expect(out.paid).toBe(false)
    expect(out.message).toMatch(/trying again shortly is right/)
    expect(h.http.calls).toHaveLength(1)
  })

  it('carries the interpretation, like every other result', async () => {
    const h = harness(await DENIED())
    h.d.preflight = async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: ['a cap'], notChecked: [] })
    expect((await writePolicy(h.d, INPUT as never)).interpretation).toEqual(['a cap'])
  })

  it('any other failure from pay still throws', async () => {
    for (const e of [new Error('boom'), await realRefusal(1000026, 'account not found')]) {
      await expect(writePolicy(harness(e).d, INPUT as never)).rejects.toBe(e)
    }
  })

  it('a dry run never signs, so it cannot hit either refusal', async () => {
    const h = harness(await DENIED())
    const out = await writePolicy(h.d, { ...INPUT, dryRun: true } as never)
    expect(out.state).toBe('quoted')
    expect(h.pay).not.toHaveBeenCalled()
  })
})
