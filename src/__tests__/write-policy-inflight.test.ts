/**
 * The confirm gate also covers COLLECTING a write that was paid for elsewhere.
 *
 * Without this a prompt-injected agent could pay the policy-write fee through `pay_and_fetch` (the service takes the payment and
 * answers with a receipt, writing nothing), then call `write_policy` with no `confirm`: the pre-check answers 409
 * "already in flight" and the old code saved that receipt and collected it, which writes the earlier request's attributes.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { checkPolicyWrite, writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import { createPayer, policyWriteUrlRefusal } from '../orchestrator/pay'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'

const INPUT = {
  policyKey: 'native-v1',
  attributes: [{ attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' }],
  templateContractAddress: TEMPLATE,
  templateId: 'a'.repeat(64),
  requestKey: 'req-1',
  pollBudgetMs: 10_000,
}

const IN_FLIGHT = { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } }
const WRITTEN = { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xaaa' } }

type Step = { status: number; body?: unknown }

function harness(steps: Step[], preSaved: PolicyWriteReceipt[] = []) {
  const calls: Array<{ url: string }> = []
  let i = 0
  const http = (async (url: string) => {
    calls.push({ url })
    const step = steps[Math.min(i++, steps.length - 1)]
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: () => null },
      text: async () => JSON.stringify(step.body ?? {}),
    }
  }) as unknown as HttpSend
  const map = new Map<string, PolicyWriteReceipt>(preSaved.map((r) => [r.blobId, r]))
  const receipts: PolicyWriteReceiptStore = {
    async get(id) { return map.get(id) ?? null },
    async set(r) { map.set(r.blobId, r) },
    async list() { return [...map.values()] },
    async remove(id) { map.delete(id) },
    filePathFor: (id) => `/memory/${id}`,
  }
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http),
    receipts,
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    templateContract: TEMPLATE,
    preflight: async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: ['a cap'], notChecked: [] }),
  }
  const collected = () => calls.some((c) => c.url.endsWith('/collect'))
  return { d, pay, calls, receipts, collected }
}

const OWN_RECEIPT: PolicyWriteReceipt = { blobId: 'blob-old', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' }

describe('a paid write this wallet does not hold (paid elsewhere) needs a person before it is collected', () => {
  it.each([
    ['no confirm', {}],
    ['confirm false', { confirm: false }],
    ['confirm "true"', { confirm: 'true' }],
    ['confirm 1', { confirm: 1 }],
    ['dryRun with confirm', { dryRun: true, confirm: true }],
    ['dryRun alone', { dryRun: true }],
  ])('%s: refused, not saved, not collected', async (_label, extra) => {
    const h = harness([IN_FLIGHT, WRITTEN])
    const out = await writePolicy(h.d, { ...INPUT, ...extra } as never)
    expect(out.state).toBe('refused')
    expect(out.needsConfirmation).toBe(true)
    expect(out.paid).toBeUndefined()
    expect(out.message).toContain('this wallet holds no receipt for it')
    // It may be the wallet's own payment whose receipt was lost, so it must not claim the payment came from elsewhere.
    expect(out.message).toContain("may be this wallet's own payment whose receipt was lost")
    expect(out.message).toContain('call write_policy again with confirm: true')
    expect(out.message).toContain('Never pass confirm on your own judgement')
    expect(h.collected()).toBe(false)
    expect(h.pay).not.toHaveBeenCalled()
    // The receipt is NOT saved, so check_policy_write has nothing to collect either.
    expect(await h.receipts.list()).toEqual([])
  })

  it('check_policy_write cannot be used to collect it afterwards', async () => {
    const h = harness([IN_FLIGHT, WRITTEN])
    await writePolicy(h.d, INPUT as never)
    const nothing = await checkPolicyWrite(h.d, {})
    expect(nothing.state).toBe('unavailable')
    expect(nothing.message).toMatch(/no pending policy writes/)
    const named = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-old' })
    expect(named.state).toBe('unavailable')
    expect(named.message).toMatch(/holds no record of receipt "blob-old"/)
    expect(h.collected()).toBe(false)
  })

  it('with confirm: true a person has agreed, so it is saved and collected as before', async () => {
    const h = harness([IN_FLIGHT, WRITTEN])
    const out = await writePolicy(h.d, { ...INPUT, confirm: true } as never)
    expect(h.collected()).toBe(true)
    expect(out.recoveredEarlierWrite).toBe(true)
    expect(out.message).toContain('this did NOT write the attributes just submitted')
  })
})

describe('a paid write this wallet DOES hold (its own confirmed payment) is only pointed at without a person', () => {
  it('a dry run points at check_policy_write and collects nothing', async () => {
    const h = harness([IN_FLIGHT, WRITTEN], [OWN_RECEIPT])
    const out = await writePolicy(h.d, { ...INPUT, dryRun: true } as never)
    expect(out.state).toBe('settling')
    expect(out.paid).toBe(true)
    expect(out.paymentReceipt).toBe('blob-old')
    expect(out.message).toMatch(/DRY RUN — nothing was collected/)
    expect(h.collected()).toBe(false)
  })

  it('no confirmation says NOT CONFIRMED and collects nothing', async () => {
    const h = harness([IN_FLIGHT, WRITTEN], [OWN_RECEIPT])
    const out = await writePolicy(h.d, INPUT as never)
    expect(out.state).toBe('settling')
    expect(out.message).toMatch(/NOT CONFIRMED — nothing was collected/)
    expect(out.message).toMatch(/check_policy_write/)
    expect(out.message).toMatch(/Do not pay again/i)
    expect(h.collected()).toBe(false)
  })

  it('check_policy_write still finishes the wallet\'s own receipt, with no confirm, as before', async () => {
    const h = harness([WRITTEN], [OWN_RECEIPT])
    await checkPolicyWrite(h.d, { paymentReceipt: 'blob-old' })
    expect(h.collected()).toBe(true)
  })

  it('with confirm: true it collects without saving a second copy', async () => {
    const h = harness([IN_FLIGHT, WRITTEN], [OWN_RECEIPT])
    await writePolicy(h.d, { ...INPUT, confirm: true } as never)
    expect(h.collected()).toBe(true)
  })
})

describe('pay_and_fetch does not pay the policy-write service', () => {
  const refusal = policyWriteUrlRefusal(BASE)

  it.each([
    `${BASE}/pay/policy/adopt-template`,
    `${BASE}/pay/policy/adopt-template/collect`,
    `${BASE.toUpperCase()}/PAY/POLICY/ADOPT-TEMPLATE`,
    `  ${BASE}/pay/policy/remove  `,
  ])('refuses %s', (url) => {
    expect(refusal(url)).toMatch(/does not pay the policy-write service.*write_policy/)
  })

  it.each([`${BASE}/policy/vocabulary`, `${BASE}/pay/other`, 'https://example.test/pay/policy/adopt-template', `${BASE}`])(
    'leaves %s alone',
    (url) => {
      expect(refusal(url)).toBeUndefined()
    },
  )

  it('tolerates a trailing slash on the configured base, and nothing configured refuses nothing', () => {
    expect(policyWriteUrlRefusal(`${BASE}/`)(`${BASE}/pay/policy/adopt-template`)).toBeDefined()
    expect(policyWriteUrlRefusal(undefined)(`${BASE}/pay/policy/adopt-template`)).toBeUndefined()
    expect(policyWriteUrlRefusal('')(`${BASE}/pay/policy/adopt-template`)).toBeUndefined()
  })

  it('the payer throws before any request is made', async () => {
    const fetchFn = vi.fn()
    const pay = vi.fn()
    const payer = createPayer({ pay, resolveSymbol: async () => '', fetchFn: fetchFn as never, refuseUrl: refusal })
    await expect(payer({ url: `${BASE}/pay/policy/adopt-template`, method: 'POST', body: '{}' })).rejects.toThrow(/use write_policy/)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('an ordinary URL is unaffected', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ status: 200, text: async () => 'free' })
    const payer = createPayer({ pay: vi.fn(), resolveSymbol: async () => '', fetchFn: fetchFn as never, refuseUrl: refusal })
    expect((await payer({ url: 'https://x.test/free' })).status).toBe(200)
  })
})
