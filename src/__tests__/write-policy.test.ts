/**
 * write_policy / check_policy_write — the flow where a wrong answer costs real money twice.
 *
 * Two failure modes dominate everything else here, and both are about the window between phase 2
 * and a confirmed settlement, where the money has moved and no policy exists:
 *
 *   1. Reporting that window as a FAILURE. An agent told "failed" pays again.
 *   2. Reporting an unfinished write as DONE. A user told their policy exists acts as if it does.
 *
 * So the assertions below are mostly about what the wallet SAYS, not only what it returns — the
 * message is what an LLM reads back to a person, and "settlement in progress" and "failed" are the
 * same object shape with different consequences.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import { createFsPolicyWriteReceiptStore, type PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { writePolicy, checkPolicyWrite, type WritePolicyDeps } from '../orchestrator/write-policy'
import { buildPolicyWriteDeps, buildToolList } from '../index'
import { ZTP20_V1 } from './fixtures/real-policy-templates'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'

const INPUT = {
  policyKey: 'native-v1',
  attributes: [
    { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
    { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: '43200' },
  ],
  templateContractAddress: TEMPLATE,
  templateId: 'a'.repeat(64),
  requestKey: 'req-1',
  pollBudgetMs: 10_000,
}

const CHALLENGE = {
  x402Version: 1,
  error: 'payment required to write a policy',
  // prepareEndpoint included because the real 402 carries one: PaidPolicyWriteIntake builds
  // . Without it a
  // facilitator quote is UNUSABLE and orderAccepts drops it — so a fixture missing it would
  // never exercise the selection the wallet actually performs.
  accepts: [{
    scheme: 'exact',
    asset: 'ZTX3JMYR',
    maxAmountRequired: '1000',
    extra: { gasModel: 'facilitator', prepareEndpoint: 'https://public-api-sandbox.zetrix.com/api/facilitator' },
  }],
}

/** One scripted response per call, in order. */
type Step = { status: number; body?: unknown; headers?: Record<string, string> }

const send = (steps: Step[]): HttpSend & { calls: Array<{ url: string; headers: Record<string, string>; body: string }> } => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  let i = 0
  const fn = (async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    const step = steps[Math.min(i++, steps.length - 1)]
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (n: string) => step.headers?.[n] ?? step.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})),
    }
  }) as HttpSend
  ;(fn as unknown as { calls: typeof calls }).calls = calls
  return fn as never
}

const memoryStore = (): PolicyWriteReceiptStore => {
  const map = new Map<string, import('../clients/policy-write-receipt-store').PolicyWriteReceipt>()
  return {
    async get(id) { return map.get(id) ?? null },
    async set(r) { map.set(r.blobId, r) },
    async list() { return [...map.values()].sort((a, b) => b.paidAt.localeCompare(a.paidAt)) },
    async remove(id) { map.delete(id) },
    filePathFor: (id) => `/memory/${id}`,
  }
}

const deps = (steps: Step[], over: Partial<WritePolicyDeps> = {}) => {
  const http = send(steps)
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http),
    receipts: memoryStore(),
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    // Required now, not optional: an optional preflight made the whole guard fail-open, so a
    // wiring that forgot it skipped the check in silence. A test supplies its own; production
    // gets one from buildPolicyWriteDeps, which is where it is tested.
    templateContract: TEMPLATE,
    preflight: async () => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [] }),
    ...over,
  }
  return { d, http, pay }
}

describe('AC #1 — a 202 is "still settling", never a failure', () => {
  it('reports a pending settlement as paid and in progress, with the receipt', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { state: 'PAID_PENDING', receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 202, body: { state: 'SETTLING', detail: 'settling' }, headers: { 'Retry-After': '5' } },
    ])
    const r = await writePolicy(d, { ...INPUT, pollBudgetMs: 1 })
    expect(r.state).toBe('settling')
    expect(r.paid).toBe(true)
    expect(r.paymentReceipt).toBe('blob-1')
    expect(r.message).toMatch(/PAYMENT MADE/)
    expect(r.message).toMatch(/normal case rather than a failure/i)
    expect(r.message).toMatch(/Do not pay again/i)
    expect(r.message).not.toMatch(/\bfailed\b/i)
  })

  it('keeps the receipt while settling, so nothing is lost between calls', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 202, body: { state: 'SETTLING' } },
    ])
    await writePolicy(d, { ...INPUT, pollBudgetMs: 1 })
    expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })

  it('polls until the settlement confirms, then reports the policy', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 202, body: { state: 'SETTLING' }, headers: { 'Retry-After': '1' } },
      { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xabc' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('written')
    expect(r.txHash).toBe('0xabc')
    // Finished: the bookmark is dropped, because nothing more can be done with it.
    expect(await d.receipts.list()).toEqual([])
  })
})

describe('a 202 carrying a txHash is NOT a written policy', () => {
  it('reports WRITE_SUBMITTED as submitted, and says the policy does not exist yet', async () => {
    // The server's own comment: "the caller must not read that as a written policy". A txHash is
    // the most convincing-looking thing in the whole response, and here it means "on chain, block
    // not in yet" — telling the user their policy is created would be wrong by one block.
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 202, body: { state: 'WRITE_SUBMITTED', txHash: '0xdef' }, headers: { 'Retry-After': '15' } },
    ])
    const r = await writePolicy(d, { ...INPUT, pollBudgetMs: 1 })
    expect(r.state).toBe('submitted')
    expect(r.state).not.toBe('written')
    expect(r.txHash).toBe('0xdef')
    expect(r.message).toMatch(/does not exist yet/i)
    expect(r.message).toMatch(/do not report it as created/i)
    expect(r.paymentReceipt).toBe('blob-1')
  })
})

describe('the five terminal-ish collect states are told apart', () => {
  const collect = async (step: Step) => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      step,
    ])
    return { r: await writePolicy(d, { ...INPUT, pollBudgetMs: 1 }), d }
  }

  it('402 means the receipt bought nothing and paying again IS right', async () => {
    const { r, d } = await collect({ status: 402, body: { state: 'SETTLEMENT_FAILED', detail: 'settle failed' } })
    expect(r.state).toBe('receipt_void')
    expect(r.payFresh).toBe(true)
    expect(r.message).toMatch(/requires paying again/i)
    // A void receipt is worthless; keeping it would invite a pointless retry.
    expect(await d.receipts.list()).toEqual([])
  })

  it('502 means paid-and-rejected, and paying again would NOT help', async () => {
    const { r, d } = await collect({ status: 502, body: { state: 'WRITE_FAILED', txHash: '0xbad' } })
    expect(r.state).toBe('write_failed')
    expect(r.payFresh).toBeUndefined()
    expect(r.message).toMatch(/Paying again would not help/i)
    expect(r.message).toMatch(/PAYMENT MADE/)
    // Kept: it is the handle on money that moved, and support needs it.
    expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })

  it('504 means the outcome is unknown — never "it failed", never "pay again"', async () => {
    const { r, d } = await collect({ status: 504, body: { state: 'UNKNOWN' } })
    expect(r.state).toBe('unknown')
    expect(r.payFresh).toBeUndefined()
    expect(r.message).toMatch(/could not be determined/i)
    expect(r.message).toMatch(/do NOT pay again/i)
    expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })

  it('an unreachable service mid-poll keeps the receipt good', async () => {
    const http: HttpSend = async (url) =>
      url.endsWith('/collect')
        ? Promise.reject(new Error('ECONNRESET'))
        : ({
            ok: true,
            status: url.endsWith('/collect') ? 0 : 202,
            headers: { get: (n: string) => (n === 'X-PAYMENT-RECEIPT' ? 'blob-1' : null) },
            text: async () => JSON.stringify({ receipt: 'blob-1' }),
          } as never)
    const { d } = deps([], { client: new PolicyWriteClient(BASE, http) })
    // Phase 1 is the first call and this stub answers 202 to it, so drive phase 3 directly.
    await d.receipts.set({ blobId: 'blob-1', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-09-28T00:00:00Z' })
    const r = await checkPolicyWrite(d, { pollBudgetMs: 1 })
    expect(r.state).toBe('settling')
    expect(r.message).toMatch(/still good/i)
    expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })
})

describe('AC #3 — a 409 in phase 1 costs nothing, and one kind of 409 is a recovery', () => {
  it('ALREADY_EXISTS is reported without any payment being attempted', async () => {
    const { d, pay } = deps([{ status: 409, body: { state: 'ALREADY_EXISTS', detail: 'that key is taken' } }])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('already_exists')
    expect(r.message).toMatch(/Nothing was paid/i)
    expect(pay).not.toHaveBeenCalled()
  })

  it('ALREADY_IN_FLIGHT recovers the receipt and collects, instead of paying twice', async () => {
    // The guard against a hung settlement becoming a second charge only works if the client USES
    // it. A wallet that reads every 409 as failure throws away a write the user has paid for.
    const { d, pay } = deps([
      { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } },
      { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xaaa' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(pay).not.toHaveBeenCalled()
    expect(r.state).toBe('written')
    expect(r.txHash).toBe('0xaaa')
  })

  it('a 400 from the write validator is free, and says so', async () => {
    const { d, pay } = deps([{ status: 400, body: { detail: 'assetScope is required' } }])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/before any payment/i)
    expect(r.message).toMatch(/Nothing was paid/i)
    expect(pay).not.toHaveBeenCalled()
  })
})

describe('a phase-1 refusal and a phase-2 refusal are different facts about money', () => {
  it("does not claim nothing was paid once a payment has been presented", async () => {
    // A single 'refused' state covering both phases would force the tool description into
    // "refused means nothing was paid", which is true of the free pre-check and NOT KNOWN once
    // the payment has been handed over. The fixture header calls this out by name: no path may
    // say the fee was, or was not, taken where it cannot know.
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 400, body: { detail: 'payment payload malformed' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('payment_refused')
    expect(r.state).not.toBe('refused')
    expect(r.message).toMatch(/not stated by this response either way/i)
    expect(r.message).not.toMatch(/nothing was paid/i)
  })
})
describe('AC #2 — every payment goes through the wallet’s own capped payer', () => {
  it('pays through the injected payer, never by building a header itself', async () => {
    const { d, pay, http } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    await writePolicy(d, INPUT)
    expect(pay).toHaveBeenCalledTimes(1)
    expect(pay).toHaveBeenCalledWith(CHALLENGE.accepts[0])
    const paid = (http as unknown as { calls: Array<{ headers: Record<string, string> }> }).calls[1]
    expect(paid.headers['X-PAYMENT']).toBe('X-PAYMENT-HEADER')
  })

  it('a refusal from the capped payer stops the flow before the service is asked to take money', async () => {
    const { d, http } = deps([{ status: 402, body: CHALLENGE }], {
      pay: async () => { throw new Error('payment cap exceeded') },
    })
    await expect(writePolicy(d, INPUT)).rejects.toThrow(/cap exceeded/)
    // One call only: the free pre-check. Nothing was presented for payment.
    expect((http as unknown as { calls: unknown[] }).calls).toHaveLength(1)
  })
})

describe('AC #7 and #8 — what goes on the wire, and what never does', () => {
  it('sends no blob, no digest and no signature in any phase', async () => {
    const { d, http } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    await writePolicy(d, INPUT)
    for (const call of (http as unknown as { calls: Array<{ body: string }> }).calls) {
      expect(call.body).not.toMatch(/"blob"|"signature"|"publicKey"|"nonce"|"deadlineBlock"/)
    }
  })

  it('phase 3 sends ownerAddress and the password, and nothing else', async () => {
    // AC #8 as written says the password must not be sent. The shipped endpoint declares it
    // @NotBlank and signs the permit with it at write time, so the AC cannot be met as written —
    // raised on the ticket 2026-09-28. What IS enforced is that phase 3 carries nothing else:
    // no attributes, no template, no blob.
    const { d, http } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    await writePolicy(d, INPUT)
    const collect = (http as unknown as { calls: Array<{ url: string; body: string; headers: Record<string, string> }> })
      .calls.find((c) => c.url.endsWith('/collect'))!
    expect(JSON.parse(collect.body)).toEqual({ ownerAddress: OWNER, ownerHsmPassword: 'hunter2' })
    expect(collect.headers['X-PAYMENT-RECEIPT']).toBe('blob-1')
  })

  it('reads the receipt from the header, not from X-PAYMENT-RESPONSE', async () => {
    // X-PAYMENT-RESPONSE is base64 of {success, network, transaction:null} — it carries no
    // identifier at all, so it cannot say which attempt is being collected.
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      {
        status: 202,
        body: { state: 'PAID_PENDING' },
        headers: { 'X-PAYMENT-RECEIPT': 'from-header', 'X-PAYMENT-RESPONSE': 'eyJzdWNjZXNzIjp0cnVlfQ==' },
      },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('written')
  })

  it('a 202 with no receipt anywhere is reported without pretending the write is trackable', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { state: 'PAID_PENDING' } },
    ])
    const r = await writePolicy(d, INPUT)
    // 'unknown', not 'unavailable': the money HAS moved. 'unavailable' in this tool's vocabulary
    // means nothing was attempted, and saying that here would be the worst kind of wrong.
    expect(r.state).toBe('unknown')
    expect(r.paid).toBe(true)
    expect(r.message).toMatch(/PAYMENT MADE/)
    expect(r.message).toMatch(/cannot follow the write/i)
    expect(r.message).toMatch(/Do not pay again/i)
    // And it must NOT claim a network failure that did not happen.
    expect(r.message).not.toMatch(/could not be reached/i)
  })
})

describe('AC #6 — the receipt store holds no secret material', () => {
  it('writes only the bookmark fields to disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-receipts-'))
    const store = createFsPolicyWriteReceiptStore(dir)
    const { d } = deps(
      [
        { status: 402, body: CHALLENGE },
        { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
        { status: 202, body: { state: 'SETTLING' } },
      ],
      { receipts: store },
    )
    await writePolicy(d, { ...INPUT, pollBudgetMs: 1 })

    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    expect(files).toHaveLength(1)
    const raw = await readFile(join(dir, files[0]), 'utf8')
    expect(JSON.parse(raw)).toEqual({
      blobId: 'blob-1',
      policyKey: 'native-v1',
      ownerAddress: OWNER,
      paidAt: expect.any(String),
    })
    // Stated as a property too, so a field added later cannot smuggle one in.
    expect(raw).not.toMatch(/hunter2|password|signature|publicKey|blob"\s*:\s*"0x/i)
  })

  it('AC #5 — two receipts held at once do not overwrite each other', async () => {
    // The R2-M01 lesson, and it costs more here than it did there: both writes are paid for.
    const dir = await mkdtemp(join(tmpdir(), 'policy-receipts-'))
    const store = createFsPolicyWriteReceiptStore(dir)
    await store.set({ blobId: 'blob-a', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-09-28T01:00:00Z' })
    await store.set({ blobId: 'blob-b', policyKey: 'ztp20-v1', ownerAddress: OWNER, paidAt: '2026-09-28T02:00:00Z' })
    expect((await store.list()).map((r) => r.blobId)).toEqual(['blob-b', 'blob-a'])
    expect(await store.get('blob-a')).not.toBeNull()
  })

  it('AC #4 — a receipt survives a restart and check_policy_write completes it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-receipts-'))
    // First process: pays, gets a 202, stops before the settlement confirms.
    const first = deps(
      [
        { status: 402, body: CHALLENGE },
        { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
        { status: 202, body: { state: 'SETTLING' } },
      ],
      { receipts: createFsPolicyWriteReceiptStore(dir) },
    )
    const pending = await writePolicy(first.d, { ...INPUT, pollBudgetMs: 1 })
    expect(pending.state).toBe('settling')

    // Second process: a brand-new store over the same directory, nothing carried in memory.
    const second = deps([{ status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xfin' } }], {
      receipts: createFsPolicyWriteReceiptStore(dir),
    })
    const done = await checkPolicyWrite(second.d)
    expect(done.state).toBe('written')
    expect(done.txHash).toBe('0xfin')
  })
})

describe('check_policy_write never pays', () => {
  it('has no payer call on any path, including an unknown receipt', async () => {
    const { d, pay } = deps([{ status: 200, body: { state: 'WRITTEN' } }])
    const missing = await checkPolicyWrite(d, { paymentReceipt: 'nope' })
    expect(missing.state).toBe('unavailable')
    expect(missing.message).toMatch(/does not mean the write failed/i)
    expect(pay).not.toHaveBeenCalled()
  })

  it('says plainly when there is nothing pending', async () => {
    const { d } = deps([{ status: 200, body: {} }])
    const r = await checkPolicyWrite(d)
    expect(r.state).toBe('unavailable')
    expect(r.message).toMatch(/no pending policy writes/i)
  })
})

describe('nothing is attempted when the flow cannot be run at all', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no policyKey', { policyKey: '' }],
    ['no attributes', { attributes: [] }],
    ['attributes not an array', { attributes: 'cumulativeMax' }],
    ['no templateId', { templateId: undefined }],
    ['no templateContractAddress', { templateContractAddress: undefined }],
  ]
  for (const [label, over] of cases) {
    it(`refuses before paying: ${label}`, async () => {
      const { d, pay, http } = deps([{ status: 402, body: CHALLENGE }])
      const r = await writePolicy(d, { ...INPUT, ...over } as never)
      expect(r.state, label).toBe('unavailable')
      expect(pay, label).not.toHaveBeenCalled()
      expect((http as unknown as { calls: unknown[] }).calls, label).toHaveLength(0)
    })
  }

  it('refuses when no write service is configured, without claiming anything about the policy', async () => {
    const { d, pay } = deps([], { client: undefined })
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('unavailable')
    expect(r.message).toMatch(/nothing was paid/i)
    expect(pay).not.toHaveBeenCalled()
  })
})

describe('a 402 that cannot be understood is not a reason to pay', () => {
  it('refuses a challenge with no accepts rather than guessing at terms', async () => {
    const { d, pay } = deps([{ status: 402, body: { x402Version: 1, accepts: [] } }])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('unavailable')
    expect(pay).not.toHaveBeenCalled()
  })

  it('refuses a 402 that is not JSON', async () => {
    const { d, pay } = deps([{ status: 402, body: '<html>gateway</html>' }])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('unavailable')
    expect(pay).not.toHaveBeenCalled()
  })

  it('caps untrusted upstream text before it reaches the agent', async () => {
    const { d } = deps([{ status: 400, body: 'x'.repeat(50_000) }])
    const r = await writePolicy(d, INPUT)
    expect(r.message.length).toBeLessThan(600)
  })
})

describe('round 1 — preflight is RUN, not merely recommended (APP-M01)', () => {
  const draftRefused = {
    ready: false,
    policyKey: 'native-v1',
    blockers: ['"recipientAllowlist" is an empty allow-list, which denies EVERYTHING.'],
    interpretation: ['This policy would permit nobody.'],
    notChecked: [],
  }
  const draftReady = {
    ready: true,
    policyKey: 'native-v1',
    blockers: [],
    interpretation: ['"cumulativeMax" is measured over each "cumulativeWindow" period.'],
    notChecked: [],
  }

  it('refuses a draft preflight rejects, before the service is asked and before anything is paid', async () => {
    // The probe from the review: an empty allow-list denies everything, preflight says so for
    // free, and round 1 paid for it and wrote it — because write_policy only MENTIONED preflight
    // in its description and never called it.
    const { d, pay, http } = deps([{ status: 402, body: CHALLENGE }], {
      preflight: async () => draftRefused as never,
    })
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/NOTHING WAS PAID/i)
    expect(r.blockers).toEqual(draftRefused.blockers)
    expect(pay).not.toHaveBeenCalled()
    // Not even the free pre-check: a 402 for a policy that enforces nothing is still a bill.
    expect((http as unknown as { calls: unknown[] }).calls).toHaveLength(0)
  })

  it('carries the interpretation through to a SUCCESSFUL write', async () => {
    // The case nothing else covers. A valid policy can still mean something other than what was
    // asked for — a cap with no window is a LIFETIME cap — and a clean write is exactly when
    // nobody will mention it unless the result does.
    const { d } = deps(
      [
        { status: 402, body: CHALLENGE },
        { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
        { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xabc' } },
      ],
      { preflight: async () => draftReady as never },
    )
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('written')
    expect(r.interpretation).toEqual(draftReady.interpretation)
  })

  it('asks preflight about the draft actually being written', async () => {
    const seen: unknown[] = []
    const { d } = deps(
      [
        { status: 402, body: CHALLENGE },
        { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
        { status: 200, body: { state: 'WRITTEN' } },
      ],
      { preflight: async (draft) => { seen.push(draft); return draftReady as never } },
    )
    await writePolicy(d, { ...INPUT, validFromBlock: '100', validToBlock: '900' })
    expect(seen[0]).toEqual({
      policyKey: 'native-v1',
      attributes: INPUT.attributes,
      validFromBlock: '100',
      validToBlock: '900',
      templateId: INPUT.templateId,
    })
  })
})

describe('round 1 — an in-flight recovery does not claim the new draft landed (APP-M02)', () => {
  it('says which write was collected, and that it is not this one', async () => {
    // Round 1 returned {state: "written"} for a request raising a cap to 300, while whatever the
    // EARLIER request contained is what is actually in force. The agent would have told the owner
    // their new cap was live. This wallet cannot diff the two — the 409 carries a receipt and a
    // sentence, not the attributes — so the honest answer is to name the situation.
    const { d, pay } = deps([
      { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'you have already paid for this write' } },
      { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xaaa' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(pay).not.toHaveBeenCalled()
    expect(r.recoveredEarlierWrite).toBe(true)
    expect(r.message).toMatch(/did NOT write the attributes just submitted/i)
    expect(r.message).toMatch(/do not tell the user their new values are live/i)
    expect(r.message).toMatch(/get_my_policy/)
    // The server's own sentence is carried rather than dropped.
    expect(r.message).toContain('you have already paid for this write')
  })

  it('does not set the flag on an ordinary write', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.recoveredEarlierWrite).toBeUndefined()
    expect(r.message).not.toMatch(/did NOT write the attributes/i)
  })

  it('saves the recovered bookmark before collecting it', async () => {
    // W08 from the review: the in-flight path could skip its own `receipts.set` and survive. A
    // crash between the 409 and the first poll would then lose the handle on a paid-for write.
    const { d } = deps([
      { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } },
      { status: 202, body: { state: 'SETTLING' } },
    ])
    await writePolicy(d, { ...INPUT, pollBudgetMs: 1 })
    expect((await d.receipts.list()).map((r) => r.blobId)).toEqual(['blob-old'])
  })
})

describe('round 1 — the payment gate, at the line that wires it (APP-M03)', () => {
  it('builds nothing when no write URL is configured', () => {
    expect(
      buildPolicyWriteDeps({
        network: 'zetrix:mainnet',
        stateDir: '/tmp/x',
        ownerAddress: OWNER,
        hsmPassword: 'p',
        pay: async () => 'header',
        gasPreference: 'sponsored',
        sleep: async () => undefined,
        policyTemplateAddress: TEMPLATE,
        chainQuery: async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: '{}' } }] } }),
      } as never).policyWriteDeps,
    ).toBeUndefined()
  })

  it('wires the payer it is given, and nothing else', async () => {
    // The `as never` at the call site switched off the one check that the CAPPED payer is what
    // arrives here. Mutants that wired an uncapped payer, the credential payer, or nothing at all
    // all survived, because this function had no tests.
    const calls: unknown[] = []
    const built = buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async (accept: unknown) => { calls.push(accept); return 'from-the-injected-payer' },
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE,
      chainQuery: async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: '{}' } }] } }),
    } as never).policyWriteDeps!
    expect(built).toBeDefined()
    expect(await built.pay({ asset: 'ZTX' } as never)).toBe('from-the-injected-payer')
    expect(calls).toEqual([{ asset: 'ZTX' }])
    expect(built.ownerAddress).toBe(OWNER)
    expect(built.hsmPassword).toBe('p')
    expect(built.preflight).toBeDefined()
  })

  it('orders the quotes the way every other x402 surface does', async () => {
    // A policy write must not end up preferring a different gas model than the rest of the wallet.
    const built = buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'h',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE,
      chainQuery: async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: '{}' } }] } }),
    } as never).policyWriteDeps!
    const selfPay = { scheme: 'exact', asset: 'ZTX', extra: { gasModel: 'client' } }
    const sponsored = { scheme: 'exact', asset: 'ZTX3JMYR', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://f.test/api/facilitator' } }
    expect(built.chooseAccept([selfPay, sponsored] as never)).toBe(sponsored)
  })
})

describe('round 1 — the remaining findings', () => {
  it('never sends X-PAYMENT on the free pre-check (C18)', async () => {
    // The payment gate stated as a property of the first call, which nothing checked. A phase-1
    // request carrying a payment header would be paying for the free step.
    const { d, http } = deps([{ status: 409, body: { state: 'ALREADY_EXISTS' } }])
    await writePolicy(d, INPUT)
    const [first] = (http as unknown as { calls: Array<{ headers: Record<string, string> }> }).calls
    expect(first.headers['X-PAYMENT']).toBeUndefined()
    expect(Object.keys(first.headers)).not.toContain('X-PAYMENT-RECEIPT')
  })

  it('stops on a status this flow does not define, instead of retrying into the key limit', async () => {
    // APP-L01. A 404/410 for a swept receipt read as "unreachable", which kept the loop going and
    // re-presented the HSM password each time — against a six-key retry series (BT-2958).
    const { d, http } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 410, body: { detail: 'receipt swept' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('unknown')
    expect(r.message).toMatch(/does not recognise/i)
    expect(r.message).toMatch(/not retried/i)
    // Three calls: pre-check, pay, one collect. Not a fourth.
    expect((http as unknown as { calls: unknown[] }).calls).toHaveLength(3)
    // The receipt is KEPT: money moved and support needs the id.
    expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })

  const badBudgets: Array<[string, unknown]> = [
    ['a string', 'forever'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
    ['undefined', undefined],
  ]
  for (const [label, pollBudgetMs] of badBudgets) {
    it(`does not poll forever when pollBudgetMs is ${label}`, async () => {
      // APP-L02: a non-numeric budget made the expiry comparison false every time — 201 polls
      // before a terminal state arrived. The loop is bounded by a real number or not at all.
      let polls = 0
      const http: HttpSend = async (url) => {
        if (url.endsWith('/collect')) polls++
        return {
          ok: true,
          status: 202,
          headers: { get: (n: string) => (n === 'X-PAYMENT-RECEIPT' ? 'blob-1' : n === 'Retry-After' ? '5' : null) },
          text: async () => JSON.stringify({ state: 'SETTLING', receipt: 'blob-1' }),
        }
      }
      // A clock that ADVANCES with each sleep. Without one, elapsed time never moves and only
      // MAX_POLLS ever stops the loop — which masks the budget check entirely: leaving budgetMs
      // unvalidated survived, because 40 polls is under the ceiling this test asserted.
      let clock = 0
      const { d } = deps([], {
        client: new PolicyWriteClient(BASE, http),
        sleep: async (ms: number) => { clock += ms },
        now: () => new Date(clock),
      })
      await d.receipts.set({ blobId: 'blob-1', policyKey: 'k', ownerAddress: OWNER, paidAt: '2026-09-29T00:00:00Z' })
      const r = await checkPolicyWrite(d, { pollBudgetMs: pollBudgetMs as never })
      expect(r.state, label).toBe('settling')
      // The DEFAULT budget is a minute at a five-second interval, so a bad value must land near
      // a dozen polls — not at the MAX_POLLS ceiling, which is a backstop rather than a budget.
      expect(polls, label).toBeLessThan(15)
    })
  }

  it('falls back to the body when the receipt header is present but EMPTY', async () => {
    // APP-L05: `??` only steps aside for null and undefined, so an empty header skipped the body
    // and landed on paid_untrackable while the receipt sat in the body all along.
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-from-body' }, headers: { 'X-PAYMENT-RECEIPT': '   ' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('written')
    expect((await d.receipts.list())).toEqual([])
  })

  it('says when more than one paid-for write is on file', async () => {
    // APP-L06: a write_failed receipt is kept deliberately and never expires, so the newest can
    // be a dead one sitting in front of an older write that is still settling.
    const { d } = deps([{ status: 202, body: { state: 'SETTLING' } }])
    await d.receipts.set({ blobId: 'older', policyKey: 'a', ownerAddress: OWNER, paidAt: '2026-09-28T00:00:00Z' })
    await d.receipts.set({ blobId: 'newer', policyKey: 'b', ownerAddress: OWNER, paidAt: '2026-09-29T00:00:00Z' })
    const r = await checkPolicyWrite(d, { pollBudgetMs: 1 })
    expect(r.paymentReceipt).toBe('newer')
    expect(r.message).toMatch(/2 paid-for writes are on file/i)
    expect(r.message).toContain('a (older)')
  })

  it('does not advertise requestKey as an idempotency key', () => {
    // APP-L04, and the same wrong fact BT-2867 carried: repeating one is not a safe retry.
    const tool = buildToolList().find((t) => t.name === 'write_policy')!
    const text = tool.inputSchema.properties!.requestKey!.description
    expect(text).toMatch(/Do NOT treat it as an idempotency key/i)
    expect(text).not.toMatch(/^Idempotency key/i)
  })
})

describe('round 2 — the draft is checked against the template it will be WRITTEN against', () => {
  it('refuses, free, when the caller names a different Template contract', async () => {
    // Preflight types a draft against the CONFIGURED template; the paid write goes to whatever
    // address the caller supplied. Nothing compared them, so a wrong or invented address passed
    // the free check, was paid for, and then failed on chain against a different template. The
    // same defect as skipping preflight entirely, one level down.
    const { d, pay, http } = deps([{ status: 402, body: CHALLENGE }], {
      preflight: async () => { throw new Error('preflight must not even be reached') },
    })
    const r = await writePolicy(d, { ...INPUT, templateContractAddress: 'ZTX3SomeOtherTemplateContract00001' })
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/not the Template contract this wallet is configured for/i)
    expect(r.message).toMatch(/BEFORE any payment/i)
    expect(pay).not.toHaveBeenCalled()
    expect((http as unknown as { calls: unknown[] }).calls).toHaveLength(0)
  })

  it('proceeds when the addresses agree', async () => {
    const { d } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.state).toBe('written')
  })

  it('caps the 409 detail, as every other upstream-text path here does', async () => {
    const { d } = deps([
      { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'x'.repeat(50_000) } },
      { status: 200, body: { state: 'WRITTEN' } },
    ])
    const r = await writePolicy(d, INPUT)
    expect(r.message.length).toBeLessThan(1000)
  })
})

describe('round 2 — the preflight wiring is built where it is tested', () => {
  const buildWith = (over: Record<string, unknown> = {}) =>
    buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE,
      chainQuery: async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: '{}' } }] } }),
      ...over,
    } as never)

  it('builds nothing without a Template contract, because an unpriceable draft is not paid for', () => {
    // Both, not either: with no template there is nothing to type a draft against, and a write
    // this wallet cannot check for free is one it will not pay for.
    expect(buildWith({ policyTemplateAddress: undefined }).policyWriteDeps).toBeUndefined()
    expect(buildWith({ policyWriteUrl: undefined }).policyWriteDeps).toBeUndefined()
    expect(buildWith().policyWriteDeps).toBeDefined()
  })

  it('carries the configured template through to the equality check', () => {
    expect(buildWith().policyWriteDeps!.templateContract).toBe(TEMPLATE)
  })

  it('builds a preflight that reads the CONFIGURED template, not one the caller names', async () => {
    // The closure used to live inline in main(), where nothing tested it — so a mutation to
    // "always ready", or to no preflight at all, had nothing to get past.
    const read: Array<{ contractAddress: string; input: string }> = []
    const built = buildWith({
      chainQuery: async (q: { contractAddress: string; input: string }) => {
        read.push(q)
        return { errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify({ found: false }) } }] } }
      },
    }).policyWriteDeps!

    const result = await built.preflight({
      policyKey: 'native-v1',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }],
      validFromBlock: '0',
      validToBlock: '0',
      templateId: 'a'.repeat(64),
    })

    expect(read).toHaveLength(1)
    expect(read[0].contractAddress).toBe(TEMPLATE)
    expect(read[0].input).toContain('getTemplateById')
    // A template that does not resolve is not a pass.
    expect(result.ready).toBe(false)
  })

  it('reads the configured contract whatever else the draft carries', async () => {
    // The template a draft is typed against must come from CONFIGURATION, never from the draft.
    // policy_preflight accepts a { publisher, policyKey } pair as an alternative way to find a
    // template, so a field of that shape reaching this closure and being preferred is a real
    // shape of mistake — and one nothing here would have caught, because writePolicy happens not
    // to forward it today. Pinned so it stays that way.
    const read: Array<{ contractAddress: string }> = []
    const built = buildWith({
      chainQuery: async (q: { contractAddress: string }) => {
        read.push(q)
        return { errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify({ found: false }) } }] } }
      },
    }).policyWriteDeps!
    await built.preflight({
      policyKey: 'native-v1',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }],
      validFromBlock: '0',
      validToBlock: '0',
      templateId: 'a'.repeat(64),
      publisher: 'ZTX3AttackerSuppliedPublisher00001',
      templateContractAddress: 'ZTX3AttackerSuppliedTemplate00001',
    } as never)
    expect(read).toHaveLength(1)
    expect(read[0].contractAddress).toBe(TEMPLATE)
  })

  it('refuses a draft with no templateId rather than typing it against nothing', async () => {
    const built = buildWith().policyWriteDeps!
    const result = await built.preflight({
      policyKey: 'native-v1',
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }],
      validFromBlock: '0',
      validToBlock: '0',
    })
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toMatch(/could not read the template/i)
  })

  it('the real preflight refuses the empty-allow-list draft, end to end through the builder', async () => {
    // The original probe, run through the wiring rather than a stub: an empty allow-list denies
    // everything, and the chain answers with the real ztp20-v1 template.
    const built = buildWith({
      chainQuery: async () => ({
        errorCode: 0,
        result: { query_rets: [{ result: { value: JSON.stringify(ZTP20_V1) } }] },
      }),
    }).policyWriteDeps!
    const result = await built.preflight({
      policyKey: 'ztp20-v1',
      attributes: [{ attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: '[]' }],
      validFromBlock: '0',
      validToBlock: '0',
      templateId: 'a'.repeat(64),
    })
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toMatch(/denies EVERYTHING/i)
  })
})
