/**
 * write_policy pays and writes only with `confirm: true`.
 *
 * The policy the agent writes is the policy the wallet then reads to stand its own default cap aside, so an agent that could
 * write one on its own could lift its own limit. Without `confirm: true` the call stops at the price.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'

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

const CHALLENGE = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '1000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://f.test/prepare' } }],
}

function harness() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const http = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify(CHALLENGE) }
  }) as unknown as HttpSend
  const map = new Map<string, PolicyWriteReceipt>()
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
  return { d, pay, calls, receipts }
}

describe('write_policy without confirm: true stops at the price', () => {
  it('returns the quote with needsConfirmation, pays nothing, writes nothing', async () => {
    const h = harness()
    const out = await writePolicy(h.d, INPUT as never)
    expect(out.state).toBe('quoted')
    expect(out.needsConfirmation).toBe(true)
    expect(out.paid).toBe(false)
    expect(out.quote).toMatchObject({ asset: 'ZTX3JMYR', amount: '1000' })
    expect(out.interpretation).toEqual(['a cap'])
    expect(h.pay).not.toHaveBeenCalled()
    // Only the free pre-check went out, and nothing carried a payment header.
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].headers['X-PAYMENT']).toBeUndefined()
    expect(await h.receipts.list()).toEqual([])
  })

  it('tells the agent exactly what to do next, and not to decide it alone', async () => {
    const out = await writePolicy(harness().d, INPUT as never)
    expect(out.message).toContain('a person must agree to it first')
    expect(out.message).toContain('show the user what it means (interpretation) and the price')
    expect(out.message).toContain('call write_policy again with confirm: true')
    expect(out.message).toContain('Never pass confirm on your own judgement')
  })

  it.each([false, 'true', 'yes', 1, 0, null, undefined, {}, [], 'TRUE'])('confirm: %j is not confirmation', async (value) => {
    const h = harness()
    const out = await writePolicy(h.d, { ...INPUT, confirm: value } as never)
    expect(out.state).toBe('quoted')
    expect(out.needsConfirmation).toBe(true)
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('a dry run is a dry run: no needsConfirmation, and the wording is the dry run one', async () => {
    const h = harness()
    const out = await writePolicy(h.d, { ...INPUT, dryRun: true } as never)
    expect(out.state).toBe('quoted')
    expect(out.needsConfirmation).toBeUndefined()
    expect(out.message).toContain('Ask again without dryRun to deploy.')
    expect(out.message).not.toContain('a person must agree')
  })

  it('dryRun wins over confirm: a dry run never pays', async () => {
    const h = harness()
    const out = await writePolicy(h.d, { ...INPUT, dryRun: true, confirm: true } as never)
    expect(out.state).toBe('quoted')
    expect(out.needsConfirmation).toBeUndefined()
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('carries the affordability problem into the confirmation message instead of hiding it', async () => {
    const h = harness()
    h.d.checkAffordability = async () => ({
      verdict: 'not_affordable',
      fee: { status: 'short', required: '1000' },
      gas: { status: 'enough' },
      feeNotEstimated: false,
      problems: ['The fee is short.'],
      notChecked: [],
    }) as never
    const out = await writePolicy(h.d, INPUT as never)
    expect(out.needsConfirmation).toBe(true)
    expect(out.message).toContain('Fix the affordability problem above first.')
  })
})

describe('write_policy with confirm: true pays, as before', () => {
  it('reaches the payment step, so the cap, the refusal handling and the settlement all still run', async () => {
    const h = harness()
    // The first step is still the 402 pre-check; the payment is attempted, which is all this test needs to see.
    await writePolicy(h.d, { ...INPUT, confirm: true } as never).catch(() => undefined)
    expect(h.pay).toHaveBeenCalledTimes(1)
  })

  it('a policy refusal at signing is still reported as a result, with confirm given', async () => {
    const h = harness()
    h.d.pay = vi.fn().mockRejectedValue({ errorCode: 1000033, message: 'Policy denied: PER_TRANSACTION_EXCEEDED' })
    const out = await writePolicy(h.d, { ...INPUT, confirm: true } as never)
    expect(out.state).toBe('refused')
    expect(out.policyDenied).toBe(true)
  })
})
