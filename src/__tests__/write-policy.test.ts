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
import type { Affordability } from '../orchestrator/policy-affordability'
import { buildPolicyWriteDeps, buildToolList, describeAssetAmount } from '../index'
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
  confirm: true,
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

describe('real preflight drives the real paid request, end to end', () => {
  // The tests above mock preflight. These wire the REAL one through buildPolicyWriteDeps, so a change anywhere between
  // the draft and the request body is caught: this is what the service actually receives.
  const TOKEN = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
  const chainFor = (decimals: unknown) => async ({ input }: { input: string }) => {
    const { method } = JSON.parse(input)
    const body =
      method === 'getTemplateById' ? ZTP20_V1 : method === 'contractInfo' ? { contractInfo: { symbol: 'JMYR', decimals } } : { found: false }
    return { errorCode: 0, result: { query_rets: [{ result: { value: JSON.stringify(body) } }] } }
  }
  const attrs = (cap: string) => [
    { attributeName: 'assetScope', attributeType: 'STRING', value: 'ztp20' },
    { attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: TOKEN },
    { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: cap },
  ]
  const run = async (decimals: unknown, attributes: ReturnType<typeof attrs>, amountUnit?: unknown) => {
    const built = buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE,
      chainQuery: chainFor(decimals),
      queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
      caps: undefined,
    } as never).policyWriteDeps!
    const { d, http, pay } = deps([{ status: 402, body: CHALLENGE }], { preflight: built.preflight })
    const r = await writePolicy(d, {
      ...INPUT,
      policyKey: 'ztp20-v1',
      attributes,
      ...(amountUnit === undefined ? {} : { amountUnit: amountUnit as string }),
      dryRun: true,
    })
    const calls = (http as unknown as { calls: Array<{ url: string; body: string }> }).calls
    return { r, calls, pay }
  }
  const sent = (calls: Array<{ body: string }>) => JSON.parse(calls[0].body) as { attributes: Array<{ attributeName: string; value: string }> } & Record<string, unknown>

  it('writes 1 JMYR as 1000000 when the user said "1" with amountUnit "whole"', async () => {
    const { r, calls } = await run('6', attrs('1'), 'whole')
    expect(r.state).toBe('quoted')
    expect(sent(calls).attributes.find((a) => a.attributeName === 'perTransactionMax')!.value).toBe('1000000')
  })

  it('scales by the token\'s own decimals: 1 whole token of an 18-decimal token is 10^18', async () => {
    const { r, calls } = await run('18', attrs('1'), 'whole')
    expect(r.state).toBe('quoted')
    expect(sent(calls).attributes.find((a) => a.attributeName === 'perTransactionMax')!.value).toBe('1' + '0'.repeat(18))
  })

  it('sends no request at all when the unit guard refuses', async () => {
    const { r, calls, pay } = await run('6', attrs('1'))
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/NOTHING WAS PAID/)
    expect(calls).toHaveLength(0)
    expect(pay).not.toHaveBeenCalled()
  })

  it('sends no request when the draft looks already converted — the double conversion the reviewer traced', async () => {
    const { r, calls } = await run('6', attrs('1000000'), 'whole')
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/times looser or tighter/)
    expect(r.message).toMatch(/resend them UNCHANGED with amountUnit "base"/)
    expect(calls).toHaveLength(0)
  })

  it('a genuine million-token cap: refused as whole, then sent exactly as the refusal says (value x 10^decimals, base)', async () => {
    // The reviewer's APP-M03. "1000000" with whole is ambiguous (copied raw, or a real million-token cap), so it is refused —
    // and the refusal names the route that is RIGHT for the large reading, which must actually work end to end.
    const refused = await run('6', attrs('1000000'), 'whole')
    expect(refused.r.state).toBe('refused')
    expect(refused.r.message).toMatch(/"perTransactionMax" 1000000 becomes 1000000000000/)
    expect(refused.calls).toHaveLength(0)

    const routed = await run('6', attrs('1000000000000'), 'base')
    expect(routed.r.state).toBe('quoted')
    expect(sent(routed.calls).attributes.find((a) => a.attributeName === 'perTransactionMax')!.value).toBe('1000000000000')
  })

  it('the copied-raw reading: the value resent unchanged with base is written as 1 token, not a million', async () => {
    const routed = await run('6', attrs('1000000'), 'base')
    expect(routed.r.state).toBe('quoted')
    expect(sent(routed.calls).attributes.find((a) => a.attributeName === 'perTransactionMax')!.value).toBe('1000000')
  })

  it('refuses decimals that are not a number, instead of writing the value unscaled', async () => {
    // The incident: a contract answering null/empty used to read as 0 decimals, so "1" went out as 1.
    for (const bad of [null, '', false, [], 77]) {
      const { r, calls } = await run(bad, attrs('1'), 'whole')
      expect(r.state, JSON.stringify(bad)).toBe('refused')
      expect(calls, JSON.stringify(bad)).toHaveLength(0)
    }
  })

  it('refuses an empty amountUnit, treating it as neither mode', async () => {
    const { r, calls } = await run('6', attrs('1000000'), '')
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/is not one of "whole" or "base"/)
    expect(calls).toHaveLength(0)
  })

  it('never puts amountUnit into the request body', async () => {
    for (const unit of ['whole', 'base'] as const) {
      const { calls } = await run('6', attrs(unit === 'whole' ? '1' : '1000000'), unit)
      expect(sent(calls)).not.toHaveProperty('amountUnit')
      expect(JSON.stringify(sent(calls))).not.toContain('amountUnit')
    }
  })

  it('passes a raw value through untouched with amountUnit "base"', async () => {
    const { r, calls } = await run('6', attrs('1'), 'base')
    expect(r.state).toBe('quoted')
    expect(sent(calls).attributes.find((a) => a.attributeName === 'perTransactionMax')!.value).toBe('1')
  })
})

describe('amountUnit reaches the write, so what is paid for is what the user saw', () => {
  const cleanPreflight = (extra: Record<string, unknown> = {}) =>
    vi.fn(async (_draft: unknown) => ({ ready: true, policyKey: 'k', blockers: [], interpretation: [], notChecked: [], ...extra }) as never)

  const ATTRS = [
    { attributeName: 'assetScope', attributeType: 'STRING', value: 'ztp20' },
    { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1' },
    { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100' },
    { attributeName: 'maxTransactionCount', attributeType: 'NUMBER', value: '5' },
  ]
  const sentAttributes = (http: unknown) => {
    const calls = (http as { calls: Array<{ url: string; body: string }> }).calls
    return JSON.parse(calls[0].body).attributes as Array<{ attributeName: string; value: string }>
  }
  const valuesOf = (attrs: Array<{ attributeName: string; value: string }>) => Object.fromEntries(attrs.map((x) => [x.attributeName, x.value]))

  it('forwards amountUnit to preflight', async () => {
    const preflight = cleanPreflight()
    const { d } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    await writePolicy(d, { ...INPUT, attributes: ATTRS, amountUnit: 'whole', dryRun: true })
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ amountUnit: 'whole' }))
  })

  it('does not invent an amountUnit when none was given', async () => {
    const preflight = cleanPreflight()
    const { d } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    await writePolicy(d, { ...INPUT, attributes: ATTRS, dryRun: true })
    expect((preflight.mock.calls[0][0] as Record<string, unknown>)).not.toHaveProperty('amountUnit')
  })

  it('sends the RAW values preflight converted to, not the whole-token ones the caller typed', async () => {
    const preflight = cleanPreflight({ convertedAmounts: { perTransactionMax: '1000000', cumulativeMax: '100000000' } })
    const { d, http } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    await writePolicy(d, { ...INPUT, attributes: ATTRS, amountUnit: 'whole', dryRun: true })
    expect(valuesOf(sentAttributes(http))).toEqual({
      assetScope: 'ztp20',
      perTransactionMax: '1000000',
      cumulativeMax: '100000000',
      // Not an amount, so never touched.
      maxTransactionCount: '5',
    })
  })

  it('keeps every attribute, in order, changing only the converted values', async () => {
    const preflight = cleanPreflight({ convertedAmounts: { cumulativeMax: '100000000' } })
    const { d, http } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    await writePolicy(d, { ...INPUT, attributes: ATTRS, amountUnit: 'whole', dryRun: true })
    const sent = sentAttributes(http)
    expect(sent.map((x) => x.attributeName)).toEqual(ATTRS.map((x) => x.attributeName))
    expect(valuesOf(sent).perTransactionMax).toBe('1')
    expect(valuesOf(sent).cumulativeMax).toBe('100000000')
  })

  it('sends the caller\'s attributes untouched when nothing was converted', async () => {
    const { d, http } = deps([{ status: 402, body: CHALLENGE }], { preflight: cleanPreflight() })
    await writePolicy(d, { ...INPUT, attributes: ATTRS, amountUnit: 'base', dryRun: true })
    expect(sentAttributes(http)).toEqual(ATTRS.map(({ attributeName, value }) => expect.objectContaining({ attributeName, value })))
  })

  it('does not let a converted-values map act on an inherited property name', async () => {
    // convertedAmounts is a plain object; an attribute called "toString" or "constructor" must not
    // read as converted just because the object inherits one.
    const preflight = cleanPreflight({ convertedAmounts: {} })
    const attrs = [...ATTRS, { attributeName: 'toString', attributeType: 'STRING', value: 'x' }, { attributeName: 'constructor', attributeType: 'STRING', value: 'y' }]
    const { d, http } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    await writePolicy(d, { ...INPUT, attributes: attrs, amountUnit: 'whole', dryRun: true })
    const sent = valuesOf(sentAttributes(http))
    expect(sent.toString).toBe('x')
    expect(sent.constructor).toBe('y')
  })

  it('pays for the converted values on a real deploy, not the typed ones', async () => {
    const preflight = cleanPreflight({ convertedAmounts: { perTransactionMax: '1000000' } })
    const { d, http, pay } = deps(
      [
        { status: 402, body: CHALLENGE },
        { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
        { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xabc' } },
      ],
      { preflight },
    )
    const r = await writePolicy(d, { ...INPUT, attributes: ATTRS, amountUnit: 'whole' })
    expect(r.state).toBe('written')
    expect(pay).toHaveBeenCalledTimes(1)
    const calls = (http as unknown as { calls: Array<{ url: string; body: string }> }).calls
    const withAttributes = calls.filter((c) => c.body.includes('perTransactionMax'))
    expect(withAttributes.length).toBeGreaterThan(0)
    for (const c of withAttributes) expect(valuesOf(JSON.parse(c.body).attributes).perTransactionMax).toBe('1000000')
  })

  it('refuses before anything is quoted or paid when preflight refuses — the unit guard costs nothing', async () => {
    const preflight = cleanPreflight({ ready: false, blockers: ['"perTransactionMax" is 1, which is only 0.000001 JMYR'] })
    const { d, http, pay } = deps([{ status: 402, body: CHALLENGE }], { preflight })
    const r = await writePolicy(d, { ...INPUT, attributes: ATTRS })
    expect(r.state).toBe('refused')
    expect(r.message).toMatch(/NOTHING WAS PAID/)
    expect(r.message).toContain('only 0.000001 JMYR')
    expect(pay).not.toHaveBeenCalled()
    expect((http as unknown as { calls: unknown[] }).calls).toHaveLength(0)
  })
})

describe('a 5xx from collect that is not the service reporting a money state', () => {
  // Real, from a transcript on 2026-10-01: the collect call answered with a Spring default error body,
  // and the status check that followed got Cloudflare's own page. The second was read as the SERVICE's
  // 502 — "paid, submitted, and rejected by the block" — which nobody knew to be true.
  const SPRING_500 = {
    timestamp: '2026-10-01T02:01:43.291+00:00',
    status: 500,
    error: 'Internal Server Error',
    path: '/api/pay/policy/adopt-template/collect',
  }
  const CLOUDFLARE_502 =
    '<!DOCTYPE html><html><head><title>502 Bad Gateway</title><style>body{color:red}</style></head>' +
    '<body><h1>Bad gateway</h1><p>The origin web server returned an invalid or incomplete response to ' +
    'Cloudflare. This typically indicates the origin is overloaded or misconfigured.</p>' +
    '<script>var x = "secret"</script></body></html>'

  const collect = async (step: Step) => {
    const { d, http } = deps([
      { status: 402, body: CHALLENGE },
      { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
      step,
    ])
    const r = await writePolicy(d, INPUT)
    const collects = (http as unknown as { calls: Array<{ url: string }> }).calls.filter((c) => c.url.endsWith('/collect'))
    return { r, d, collects }
  }

  describe("the service's own unhandled exception (HTTP 500)", () => {
    it('is unknown, not failed — and says the write may or may not have happened', async () => {
      const { r } = await collect({ status: 500, body: SPRING_500 })
      expect(r.state).toBe('unknown')
      expect(r.paid).toBe(true)
      expect(r.payFresh).toBeUndefined()
      expect(r.message).toMatch(/PAYMENT MADE/)
      expect(r.message).toMatch(/internal error \(HTTP 500\)/)
      expect(r.message).toMatch(/may or may not have been written/)
    })

    it('tells the agent what NOT to say or do, and what to do instead', async () => {
      const { r } = await collect({ status: 500, body: SPRING_500 })
      expect(r.message).toMatch(/Do NOT tell the user it failed/)
      expect(r.message).toMatch(/do NOT pay again/)
      expect(r.message).toMatch(/check once with check_policy_write/)
      expect(r.message).toMatch(/do not loop/i)
      expect(r.message).toMatch(/quote the receipt/i)
    })

    it('does not blame the chain or a gateway — it knows neither', async () => {
      const { r } = await collect({ status: 500, body: SPRING_500 })
      expect(r.message).not.toMatch(/gateway|proxy|REJECTED|rejecting/i)
    })

    it('keeps the receipt, because it is the only handle on money that moved', async () => {
      const { d } = await collect({ status: 500, body: SPRING_500 })
      expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
    })

    it('is NOT retried: a failed collect uses one of a small number of retries for this write', async () => {
      const { collects } = await collect({ status: 500, body: SPRING_500 })
      expect(collects).toHaveLength(1)
    })

    it('quotes what the service said, so support has something to search by', async () => {
      const { r } = await collect({ status: 500, body: SPRING_500 })
      expect(r.message).toContain('Internal Server Error')
      expect(r.message).toContain('/api/pay/policy/adopt-template/collect')
    })
  })

  describe('a gateway answering instead of the service', () => {
    it("does NOT read Cloudflare's 502 page as 'the chain rejected the write'", async () => {
      const { r } = await collect({ status: 502, body: CLOUDFLARE_502 })
      expect(r.state).toBe('unknown')
      expect(r.state).not.toBe('write_failed')
      expect(r.payFresh).toBeUndefined()
      expect(r.message).not.toMatch(/chain then REJECTED|Paying again would not help/i)
    })

    it('says plainly that the write result was never seen, and that it is not a chain rejection', async () => {
      const { r } = await collect({ status: 502, body: CLOUDFLARE_502 })
      expect(r.message).toMatch(/gateway or proxy in front of the policy service answered \(HTTP 502\)/)
      expect(r.message).toMatch(/NOT the chain rejecting anything/)
      expect(r.message).toMatch(/may be written, still in progress, or failed — it is not known/)
      expect(r.message).toMatch(/Do NOT tell the user it failed/)
      expect(r.message).toMatch(/do NOT pay again/)
      expect(r.message).toMatch(/check once with check_policy_write/)
    })

    it('quotes the page as TEXT, not markup, with scripts and styles dropped', async () => {
      const { r } = await collect({ status: 502, body: CLOUDFLARE_502 })
      expect(r.message).toContain('origin web server returned an invalid or incomplete response')
      expect(r.message).not.toMatch(/<\/?(html|body|h1|p|script|style)/i)
      expect(r.message).not.toContain('secret')
      expect(r.message).not.toContain('color:red')
    })

    it('keeps the receipt and does not retry', async () => {
      const { d, collects } = await collect({ status: 502, body: CLOUDFLARE_502 })
      expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
      expect(collects).toHaveLength(1)
    })

    it('treats a 502 with JSON but NO service state as a gateway, not as WRITE_FAILED', async () => {
      // Only the service's own body — {state: WRITE_FAILED} — is the service reporting a rejection.
      const { r } = await collect({ status: 502, body: { message: 'upstream connect error' } })
      expect(r.state).toBe('unknown')
      expect(r.message).toMatch(/gateway or proxy/)
    })

    it('treats a 502 whose state is one it does not know as UNRECOGNISED — the service spoke, so it is not a gateway', async () => {
      const { r } = await collect({ status: 502, body: { state: 'SOMETHING_NEW' } })
      expect(r.state).toBe('unknown')
      expect(r.message).toMatch(/does not recognise/)
      expect(r.message).not.toMatch(/gateway or proxy|REJECTED/)
    })

    it('still honours the service\'s own 502 — WRITE_FAILED is the one that means rejected', async () => {
      const { r } = await collect({ status: 502, body: { state: 'WRITE_FAILED', txHash: '0xbad' } })
      expect(r.state).toBe('write_failed')
      expect(r.txHash).toBe('0xbad')
    })

    it('treats a bare 504 as a gateway, and still honours the service\'s own UNKNOWN', async () => {
      const bare = await collect({ status: 504, body: '<html><body>Gateway Timeout</body></html>' })
      expect(bare.r.state).toBe('unknown')
      expect(bare.r.message).toMatch(/gateway or proxy/)
      const own = await collect({ status: 504, body: { state: 'UNKNOWN' } })
      expect(own.r.state).toBe('unknown')
      expect(own.r.message).toMatch(/could not be determined/i)
      expect(own.r.message).not.toMatch(/gateway or proxy/)
    })

    for (const status of [503, 520, 521, 522, 523, 524, 525, 526, 530]) {
      it('treats a bare ' + status + ' as a gateway fault', async () => {
        const { r } = await collect({ status, body: '' })
        expect(r.state, String(status)).toBe('unknown')
        expect(r.message, String(status)).toMatch(new RegExp('gateway or proxy in front of the policy service answered \\(HTTP ' + status + '\\)'))
      })
    }

    it('treats a 500 that is an HTML page as a gateway, and a 500 that is JSON as the service', async () => {
      const html = await collect({ status: 500, body: '  <html><body>nginx error</body></html>' })
      expect(html.r.message).toMatch(/gateway or proxy/)
      const json = await collect({ status: 500, body: SPRING_500 })
      expect(json.r.message).not.toMatch(/gateway or proxy/)
    })

    it('recognises an HTML page however it opens', async () => {
      for (const body of ['<!DOCTYPE html><html></html>', '<!doctype HTML><body></body>', '\n\t <HTML><BODY>x</BODY></HTML>', '<head></head>']) {
        const { r } = await collect({ status: 500, body })
        expect(r.message, body).toMatch(/gateway or proxy/)
      }
    })

    it('bounds what it echoes of a hostile page', async () => {
      const hostile = '<html><body>' + 'A'.repeat(50_000) + '<script>' + 'B'.repeat(50_000) + '</script></body></html>'
      const { r } = await collect({ status: 502, body: hostile })
      expect(r.message.length).toBeLessThan(1500)
      expect(r.message).not.toContain('BBBB')
    })

    it('bounds what it echoes of a hostile JSON body from the service', async () => {
      const { r } = await collect({ status: 500, body: { error: 'E'.repeat(50_000) } })
      expect(r.message.length).toBeLessThan(1500)
    })
  })

  it('leaves non-5xx statuses on the unrecognised path, which is not a server fault', async () => {
    const { r } = await collect({ status: 404, body: { detail: 'no such receipt' } })
    expect(r.state).toBe('unknown')
    expect(r.message).toMatch(/does not recognise/)
    expect(r.message).not.toMatch(/gateway or proxy|internal error/)
  })

  it('check_policy_write reads the same 5xx the same way, rather than reporting the chain rejected it', async () => {
    const { d } = deps([{ status: 502, body: CLOUDFLARE_502 }])
    await d.receipts.set({ blobId: 'blob-1', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-01T02:00:00Z' })
    const r = await checkPolicyWrite(d, { pollBudgetMs: 1 })
    expect(r.state).toBe('unknown')
    expect(r.message).toMatch(/gateway or proxy/)
    expect(r.message).not.toMatch(/REJECTED/)
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
      // What the chain should show once the write lands (names and values the user already submitted, public on chain once
      // written), so a collect that answers with an error can be checked against the chain. No credential, no signature.
      verify: { attributes: INPUT.attributes.map((x) => ({ attributeName: x.attributeName, value: x.value })), templateId: INPUT.templateId },
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
    ['a blank templateId', { templateId: '   ' }],
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
    // re-presented the HSM password each time — against a six-key retry series.
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
    // APP-L04, and the same wrong fact an earlier version carried: repeating one is not a safe retry.
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
      queryBalance: async (token: string) => ({ token, balance: '0', decimals: 6, display: `0 ${token}` }),
      caps: undefined,
      ...over,
    } as never)

  describe('wires the affordability check to the cap and reader the payer uses', () => {
    const accept = { asset: 'ZTX3JMYR', maxAmountRequired: '1000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://f.test/prepare' } }
    const funded = async (token: string) => ({ token: 'JMYR', balance: '5000', decimals: 3, display: '5 JMYR' }) as never

    it('wires a check at all', () => {
      expect(buildWith().policyWriteDeps!.checkAffordability).toBeDefined()
    })

    it('evaluates the cap it was given — and refuses a quote over it', async () => {
      const over = await buildWith({ queryBalance: funded, caps: { '*': '500' } }).policyWriteDeps!.checkAffordability!(accept)
      expect(over.verdict).toBe('not_affordable')
      expect(over.cap?.wouldPass).toBe(false)
      const within = await buildWith({ queryBalance: funded, caps: { '*': '5000' } }).policyWriteDeps!.checkAffordability!(accept)
      expect(within.verdict).toBe('affordable')
    })

    it('reads balances through the reader it was given', async () => {
      const seen: string[] = []
      const reader = async (token: string) => { seen.push(token); return { token: 'JMYR', balance: '0', decimals: 3, display: '0 JMYR' } as never }
      const r = await buildWith({ queryBalance: reader, caps: undefined }).policyWriteDeps!.checkAffordability!(accept)
      expect(seen).toEqual(['ZTX3JMYR'])
      expect(r.verdict).toBe('not_affordable')
    })
  })

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

  it('wires a quote formatter that resolves through the chain reader', async () => {
    // The orchestrator treats describeAmount as optional, so a builder that simply forgot it
    // would still type-check and still quote — with the raw figure only, in silence.
    const built = buildWith().policyWriteDeps!
    expect(built.describeAmount).toBeDefined()
    expect(await built.describeAmount!('ZTX', '1500000')).toBe('1500000 (1.5 ZTX)')
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
    // And it says where a templateId comes from, instead of leaving the agent stuck.
    expect(result.blockers.join(' ')).toMatch(/get_policy_template_schema with no arguments/i)
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

describe('templateContractAddress is optional, and the configured one is what is written against', () => {
  const happy = () => [
    { status: 402, body: CHALLENGE },
    { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
    { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xabc' } },
  ]
  const bodiesOf = (http: unknown) =>
    (http as { calls: Array<{ body: string }> }).calls.map((c) => JSON.parse(c.body) as Record<string, unknown>)

  it('writes when the address is omitted — the agent is not asked for what only the wallet knows', async () => {
    // The transcript that prompted this: the agent asked the user for a template contract address.
    // The wallet refuses every address but one, so requiring the caller to supply it was friction
    // that could only ever produce a wrong value.
    const { d } = deps(happy())
    const r = await writePolicy(d, { ...INPUT, templateContractAddress: undefined })
    expect(r.state).toBe('written')
  })

  it('sends the CONFIGURED contract on the wire when the caller omitted it', async () => {
    // The part that would fail silently: omitted in, undefined out. The server needs the address
    // to record which template typed the policy.
    const { d, http } = deps(happy())
    await writePolicy(d, { ...INPUT, templateContractAddress: undefined })
    for (const body of bodiesOf(http).filter((b) => 'policyKey' in b)) {
      expect(body.templateContractAddress).toBe(TEMPLATE)
    }
    expect(bodiesOf(http).some((b) => b.templateContractAddress === TEMPLATE)).toBe(true)
  })

  it('sends the configured contract when the caller supplied the matching one', async () => {
    const { d, http } = deps(happy())
    await writePolicy(d, INPUT)
    expect(bodiesOf(http)[0].templateContractAddress).toBe(TEMPLATE)
  })

  for (const blank of ['', '   ', null]) {
    it(`treats ${JSON.stringify(blank)} as not supplied`, async () => {
      const { d } = deps(happy())
      const r = await writePolicy(d, { ...INPUT, templateContractAddress: blank as never })
      expect(r.state).toBe('written')
    })
  }

  const wrong: Array<[string, unknown]> = [
    ['a different address', 'ZTX3SomeOtherTemplateContract00001'],
    ['the address with a trailing space', `${TEMPLATE} `],
    ['a number', 5],
    ['an object', { address: TEMPLATE }],
    ['an array', [TEMPLATE]],
  ]
  for (const [label, value] of wrong) {
    it(`still refuses ${label}, before anything is sent or paid`, async () => {
      // The safety check survives: only ABSENCE became valid. A supplied value must match exactly.
      const { d, pay, http } = deps(happy())
      const r = await writePolicy(d, { ...INPUT, templateContractAddress: value as never })
      expect(r.state, label).toBe('refused')
      expect(r.message, label).toMatch(/BEFORE any payment/i)
      expect(pay, label).not.toHaveBeenCalled()
      expect((http as unknown as { calls: unknown[] }).calls, label).toHaveLength(0)
    })
  }

  it('points a missing templateId at the listing instead of leaving the agent stuck', async () => {
    const { d, pay } = deps(happy())
    const r = await writePolicy(d, { ...INPUT, templateId: undefined as never })
    expect(r.state).toBe('unavailable')
    expect(r.message).toMatch(/get_policy_template_schema with no arguments/i)
    expect(pay).not.toHaveBeenCalled()
  })
})

describe('dryRun asks for the price and does nothing else', () => {
  const quoteSteps = () => [{ status: 402, body: CHALLENGE }]
  const happy = () => [
    { status: 402, body: CHALLENGE },
    { status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } },
    { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xabc' } },
  ]
  const callsOf = (http: unknown) =>
    (http as { calls: Array<{ url: string; headers: Record<string, string>; body: string }> }).calls

  it('returns the quote from the 402, paying nothing and stopping after the free pre-check', async () => {
    // The agent in the transcript said it could not learn the price without calling write_policy,
    // and "I can't stop it after the pre-check, so I'd rather not call it just to learn the price".
    const { d, pay, http } = deps(quoteSteps())
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.state).toBe('quoted')
    expect(r.paid).toBe(false)
    expect(r.quote).toMatchObject({ asset: 'ZTX3JMYR', amount: '1000', gasModel: 'facilitator' })
    expect(pay).not.toHaveBeenCalled()
    // ONE call — the free pre-check — and it carried no payment header.
    expect(callsOf(http)).toHaveLength(1)
    expect(callsOf(http)[0].headers['X-PAYMENT']).toBeUndefined()
  })

  it('says plainly that nothing was paid and that a quote is not a promise', async () => {
    const { d } = deps(quoteSteps())
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.message).toMatch(/QUOTE ONLY — nothing was paid and nothing was written/)
    expect(r.message).toMatch(/can change/i)
    expect(r.message).toMatch(/not a promise the payment will be allowed/i)
    // The cap is applied inside the payer, which a quote never reaches — so the claim must not be
    // that it was checked.
    expect(r.message).toMatch(/payment cap is applied only when paying/i)
    expect(r.message).not.toMatch(/within the cap|cap allows|is allowed by/i)
  })

  it('does not depend on the wallet being able to pay at all', async () => {
    // The quote must work for a user who has no funds and whose cap would refuse — that is exactly
    // who needs to know the price first.
    const { d } = deps(quoteSteps(), {
      pay: (async () => { throw new Error('payer must not be reached') }) as never,
    })
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.state).toBe('quoted')
  })

  it('adds the human-readable amount when it can', async () => {
    const { d } = deps(quoteSteps(), { describeAmount: async (asset, raw) => `${raw} (0.001 JMYR)` })
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.quote?.amountHuman).toBe('1000 (0.001 JMYR)')
    expect(r.message).toContain('1000 (0.001 JMYR)')
  })

  it('bounds the friendly form too — it comes from a token lookup, not from this wallet', async () => {
    // The raw figure is clipped, but the decorated form is produced by a separate read whose
    // result is just as untrusted. Without its own cap it floods the quote and the message.
    const { d } = deps(quoteSteps(), { describeAmount: async () => 'X'.repeat(50_000) })
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.quote!.amountHuman!.length).toBeLessThanOrEqual(120)
    expect(r.message.length).toBeLessThan(1000)
  })

  it('still quotes when the friendly form cannot be produced', async () => {
    // A failed lookup costs the decoration and nothing else.
    const { d } = deps(quoteSteps(), { describeAmount: async () => { throw new Error('token lookup failed') } })
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.state).toBe('quoted')
    expect(r.quote?.amountHuman).toBeUndefined()
    expect(r.message).toContain('1000 of ZTX3JMYR')
  })

  it('carries payTo when the service names one, and omits it when it does not', async () => {
    const withPayTo = { ...CHALLENGE, accepts: [{ ...CHALLENGE.accepts[0], payTo: 'ZTX3PayeeAddress' }] }
    const { d } = deps([{ status: 402, body: withPayTo }])
    expect((await writePolicy(d, { ...INPUT, dryRun: true })).quote?.payTo).toBe('ZTX3PayeeAddress')
    const { d: d2 } = deps(quoteSteps())
    expect('payTo' in ((await writePolicy(d2, { ...INPUT, dryRun: true })).quote ?? {})).toBe(false)
  })

  it('bounds what it echoes of the service’s quote', async () => {
    const hostile = { ...CHALLENGE, accepts: [{ ...CHALLENGE.accepts[0], asset: 'A'.repeat(50_000), maxAmountRequired: '9'.repeat(50_000), payTo: 'P'.repeat(50_000) }] }
    const { d } = deps([{ status: 402, body: hostile }])
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.quote!.asset.length).toBeLessThanOrEqual(100)
    expect(r.quote!.amount.length).toBeLessThanOrEqual(40)
    expect(r.quote!.payTo!.length).toBeLessThanOrEqual(100)
    expect(r.message.length).toBeLessThan(1000)
  })

  it('keeps no receipt for a quote, because nothing was paid', async () => {
    const { d } = deps(quoteSteps())
    await writePolicy(d, { ...INPUT, dryRun: true })
    expect(await d.receipts.list()).toEqual([])
  })

  it('refuses a quote with nothing to quote, rather than inventing a price', async () => {
    const { d } = deps(quoteSteps(), { chooseAccept: () => undefined })
    const r = await writePolicy(d, { ...INPUT, dryRun: true })
    expect(r.state).toBe('unavailable')
    expect(r.quote).toBeUndefined()
  })

  describe('it says whether the wallet could pay the quote', () => {
    const verdict = (v: Affordability["verdict"], problems: string[] = [], feeNotEstimated = false): Affordability => ({
      verdict: v,
      fee: { status: v === 'affordable' ? 'enough' : v === 'unknown' ? 'unknown' : 'short', required: '1000' },
      gas: { status: 'not_needed' },
      cap: { asset: 'ZTX3JMYR', capRaw: null, matchedKey: null, wouldPass: v === 'affordable' },
      feeNotEstimated,
      problems,
      notChecked: [],
    })

    it('carries the verdict and says the wallet holds the quoted amount when it does', async () => {
      const { d, pay } = deps(quoteSteps(), { checkAffordability: async () => verdict('affordable') })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('quoted')
      expect(r.affordability?.verdict).toBe('affordable')
      expect(r.message).toMatch(/holds the quoted amount and its payment cap would not refuse it/i)
      // No fee caveat when the check says the wallet pays no fee it could not see.
      expect(r.message).not.toMatch(/network fee is not estimated/i)
      expect(pay).not.toHaveBeenCalled()
    })

    it('hands the chosen 402 option to the check, so it prices what will actually be paid', async () => {
      const seen: unknown[] = []
      const { d } = deps(quoteSteps(), { checkAffordability: async (accept) => { seen.push(accept); return verdict('affordable') } })
      await writePolicy(d, { ...INPUT, dryRun: true })
      expect(seen).toEqual([expect.objectContaining({ asset: 'ZTX3JMYR', maxAmountRequired: '1000' })])
    })

    it('says NOT when it could not pay, names every cause, and does not invite a deploy', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => verdict('not_affordable', ['Not enough JMYR: the quote is 1, the balance is 0.', 'The payment cap for X is 0.5, and this needs 1.']) })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.affordability?.verdict).toBe('not_affordable')
      expect(r.message).toMatch(/could NOT pay it right now/)
      expect(r.message).toContain("Not enough JMYR")
      expect(r.message).toContain("The payment cap for X")
      expect(r.message).toMatch(/Fix that, then ask again without dryRun/)
      expect(r.message).not.toMatch(/would not refuse it/)
    })

    it('says it could not confirm when a read failed — never that it can pay', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => verdict('unknown', ['Could not read the JMYR balance (query_failed).']) })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.affordability?.verdict).toBe('unknown')
      expect(r.message).toMatch(/could not be confirmed/i)
      expect(r.message).not.toMatch(/holds the quoted amount|would not refuse it|could NOT pay/)
    })

    it('turns a THROWING check into unknown rather than losing the quote or implying it passed', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => { throw new Error('balance service down') } })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('quoted')
      expect(r.affordability?.verdict).toBe('unknown')
      expect(r.message).toMatch(/could not be confirmed/i)
      expect(r.message).toContain("1000")
    })

    it('keeps the old wording, and no affordability, when no check is wired', async () => {
      const { d } = deps(quoteSteps())
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.affordability).toBeUndefined()
      expect(r.message).toMatch(/payment cap is applied only when paying/i)
    })

    it('always says balances can change and the cap is enforced again when paying', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => verdict('affordable') })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.message).toMatch(/balances can change and the payment cap is enforced again when paying/i)
      expect(r.message).toMatch(/not a promise the payment will be allowed/i)
    })

    it('adds the fee caveat when the wallet will pay a fee the check did not estimate', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => verdict('affordable', [], true) })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.message).toMatch(/holds the quoted amount and its payment cap would not refuse it\. The network fee is not estimated here, so this is not a guarantee/i)
    })

    it('does not invent a cap when the check itself failed', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => { throw new Error('balance service down') } })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      // A made-up { capRaw: null, wouldPass: false } reads, to a structured consumer, as "caps are
      // configured but none matches this asset" — and an agent may tell the user to add a cap key.
      expect(r.affordability).toBeDefined()
      expect(r.affordability).not.toHaveProperty('cap')
      expect(r.affordability!.notChecked.join(' ')).toMatch(/check itself failed/)
    })

    it('bounds what a hostile check can put in the message', async () => {
      const { d } = deps(quoteSteps(), { checkAffordability: async () => verdict('not_affordable', ['P'.repeat(50_000)]) })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.message.length).toBeLessThan(1500)
    })

    it('is not consulted on a real deploy — the payer does its own checks', async () => {
      const check = vi.fn(async () => verdict('affordable'))
      const { d } = deps(happy(), { checkAffordability: check })
      await writePolicy(d, INPUT)
      expect(check).not.toHaveBeenCalled()
    })

    it('is not consulted when the free checks refuse, so a refusal costs no reads', async () => {
      const check = vi.fn(async () => verdict('affordable'))
      const { d } = deps([{ status: 409, body: { state: 'ALREADY_EXISTS', detail: 'taken' } }], { checkAffordability: check })
      await writePolicy(d, { ...INPUT, dryRun: true })
      expect(check).not.toHaveBeenCalled()
    })
  })

  describe('it must never collect', () => {
    it('does not collect an already-paid write — collecting signs and WRITES the policy', async () => {
      // The one path where a "dry" run could do real damage. ALREADY_IN_FLIGHT normally goes
      // straight to phase 3, which signs the permit with the owner's key and writes. A dry run
      // that did that would be a deploy with a misleading name.
      const { d, pay, http } = deps([
        { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } },
        { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xaaa' } },
      ])
      // The wallet's OWN confirmed payment saved this receipt (one it does not hold is not collected at all).
      await d.receipts.set({ blobId: 'blob-old', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(callsOf(http)).toHaveLength(1)
      expect(callsOf(http).some((c) => c.url.endsWith('/collect'))).toBe(false)
      expect(pay).not.toHaveBeenCalled()
      expect(r.state).toBe('settling')
      expect(r.paid).toBe(true)
      expect(r.paymentReceipt).toBe('blob-old')
      expect(r.recoveredEarlierWrite).toBe(true)
      expect(r.message).toMatch(/DRY RUN — nothing was collected/)
      expect(r.message).toMatch(/check_policy_write/)
      expect(r.message).toMatch(/Do not pay again/i)
    })

    it('keeps the receipt the wallet already holds, so check_policy_write can finish it later', async () => {
      const { d } = deps([{ status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } }])
      await d.receipts.set({ blobId: 'blob-old', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' })
      await writePolicy(d, { ...INPUT, dryRun: true })
      expect((await d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-old'])
    })

    it('does NOT save a bookmark for a receipt it does not hold: a dry run must not hand check_policy_write something to collect', async () => {
      const { d } = deps([{ status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } }])
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('refused')
      expect(await d.receipts.list()).toEqual([])
    })

    it('the same request WITHOUT dryRun does collect — so the guard is what stopped it', async () => {
      const { d, http } = deps([
        { status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid' } },
        { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: '0xaaa' } },
      ])
      await writePolicy(d, INPUT)
      expect(callsOf(http).some((c) => c.url.endsWith('/collect'))).toBe(true)
    })
  })

  describe('the free refusals are identical to a real call', () => {
    it('already_exists', async () => {
      const { d, pay } = deps([{ status: 409, body: { state: 'ALREADY_EXISTS', detail: 'that key is taken' } }])
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('already_exists')
      expect(pay).not.toHaveBeenCalled()
    })

    it('a pre-check refusal', async () => {
      const { d } = deps([{ status: 400, body: { detail: 'assetScope is required' } }])
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('refused')
    })

    it('a preflight refusal', async () => {
      const { d, http } = deps(quoteSteps(), {
        preflight: async () => ({ ready: false, policyKey: 'k', blockers: ['nope'], interpretation: [], notChecked: [] }) as never,
      })
      const r = await writePolicy(d, { ...INPUT, dryRun: true })
      expect(r.state).toBe('refused')
      expect(callsOf(http)).toHaveLength(0)
    })

    it('a wrong template contract', async () => {
      const { d, http } = deps(quoteSteps())
      const r = await writePolicy(d, { ...INPUT, dryRun: true, templateContractAddress: 'ZTX3SomeOtherTemplateContract00001' })
      expect(r.state).toBe('refused')
      expect(callsOf(http)).toHaveLength(0)
    })
  })

  describe('an unexpected value fails toward the quote, because the mistakes are not the same size', () => {
    // Reading a real deploy as a dry run costs one extra call. Reading a real dry run as a deploy
    // spends money the user explicitly did not want spent.
    for (const flag of [true, 'true', 'false', 'yes', 1, {}, []]) {
      it(`treats ${JSON.stringify(flag)} as a request for a quote`, async () => {
        const { d, pay } = deps(happy())
        const r = await writePolicy(d, { ...INPUT, dryRun: flag as never })
        expect(r.state, JSON.stringify(flag)).toBe('quoted')
        expect(pay, JSON.stringify(flag)).not.toHaveBeenCalled()
      })
    }

    for (const flag of [undefined, null, false, 0, '']) {
      it(`deploys for ${JSON.stringify(flag)}`, async () => {
        const { d, pay } = deps(happy())
        const r = await writePolicy(d, { ...INPUT, dryRun: flag as never })
        expect(r.state, JSON.stringify(flag)).toBe('written')
        expect(pay, JSON.stringify(flag)).toHaveBeenCalledTimes(1)
      })
    }
  })
})

describe('describeAssetAmount is the one amount formatter', () => {
  it('scales a known asset and keeps the raw figure beside it', async () => {
    const never = (async () => { throw new Error('native needs no lookup') }) as never
    // ZTX is 6-decimal in this wallet (ZTX_DECIMALS), so 1500000 raw is 1.5. A first draft of this
    // assertion assumed 8 decimals and the code rightly disagreed with it.
    const out = await describeAssetAmount('ZTX', '1500000', never)
    expect(out).toBe('1500000 (1.5 ZTX)')
  })

  it('falls back to the raw figure and a label when it cannot scale', async () => {
    const failing = (async () => { throw new Error('down') }) as never
    const out = await describeAssetAmount('ZTX3SomeTokenThatCannotBeRead000000', '50000', failing)
    expect(out).toContain('50000')
    expect(out).not.toMatch(/\(\d/)
  })
})
