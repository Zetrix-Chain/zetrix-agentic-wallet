/**
 * an earlier change phase 1: who pays the gas is the user's choice, put to them when self-pay is on offer and never made by the wallet.
 *
 * Self-pay is offered only when the wallet can carry it out (`deps.selfPay`). Without it nothing changes. With it, a call that names no
 * `gasPayer` stops at `needs_choice` (nothing paid, whatever `confirm` says); "sponsored" is today's flow; "self" is refused until the
 * wallet can execute it; and a value that is neither is refused before the service is even contacted.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { updatePolicy, writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import { assessSelfPay, parseGasPayer, type SelfPayDeps } from '../orchestrator/policy-gas-choice'
import type { SelfPayCall } from '../orchestrator/policy-self-pay'
import type { TokenBalanceResult } from '../clients/token-balance-client'
import type { PolicyRead, PolicyReadResult } from '../clients/policy-read-client'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE_CONTRACT = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const TEMPLATE_ID = 'a'.repeat(64)

type Step = { status: number; body?: unknown; headers?: Record<string, string> }
function send(steps: Step[]) {
  const calls: Array<{ url: string }> = []
  let i = 0
  const fn = (async (url: string) => {
    calls.push({ url })
    const step = steps[Math.min(i++, steps.length - 1)]
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      headers: { get: (n: string) => step.headers?.[n] ?? step.headers?.[n.toLowerCase()] ?? null },
      text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {})),
    }
  }) as unknown as HttpSend
  return { fn, calls }
}

const CHALLENGE = {
  x402Version: 1,
  accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/facilitator' } }],
}
const PAID = { status: 202, body: { state: 'PAID_PENDING', receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } }
const WRITTEN = { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: 'tx-1' } }

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

const NEW_ATTRS = [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' }]
const BEFORE: PolicyRead<PolicyReadResult> = {
  found: true,
  value: {
    policy: {
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100000000' }],
      validFromBlock: '0',
      validToBlock: '0',
      updatedAtBlock: 12345,
      templateContractAddress: TEMPLATE_CONTRACT,
      templateId: TEMPLATE_ID,
    },
  },
}
const CREATE = { policyKey: 'native-v1', attributes: NEW_ATTRS, templateId: TEMPLATE_ID, requestKey: 'r', pollBudgetMs: 10_000 }
const UPDATE = { policyKey: 'native-v1', attributes: NEW_ATTRS, expectedUpdatedAtBlock: '12345', pollBudgetMs: 10_000 }

const ztx = (raw: string): TokenBalanceResult => ({ token: 'ZTX', balance: raw, decimals: 6, display: `${Number(raw) / 1e6} ZTX` }) as TokenBalanceResult

function selfPayDeps(over: Partial<SelfPayDeps> = {}): SelfPayDeps {
  return {
    estimateGas: vi.fn(async () => ({ gasRaw: '1000000' })),
    queryNativeBalance: vi.fn(async () => ztx('5000000')),
    execute: vi.fn(async () => ({ kind: 'submitted' as const, txHash: 'tx-1', nonce: '7', feeLimit: '1000000', ceilLedgerSeq: '1060' })),
    ...over,
  }
}

function harness(steps: Step[], over: Partial<WritePolicyDeps> = {}) {
  const http = send(steps)
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http.fn),
    receipts: memoryStore(),
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    templateContract: TEMPLATE_CONTRACT,
    preflight: (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: ['a cap'], notChecked: [] })) as never,
    readPolicy: vi.fn(async () => BEFORE),
    hasVocabularySource: true,
    ...over,
  }
  return { d, http, pay }
}
const STEPS = [{ status: 402, body: CHALLENGE }, PAID, WRITTEN]

describe('parseGasPayer', () => {
  it.each([[undefined], [null], ['']])('%s means "not chosen"', (v) => {
    expect(parseGasPayer(v)).toEqual({ ok: true })
  })
  it.each([['self'], ['sponsored']])('%s is accepted exactly', (v) => {
    expect(parseGasPayer(v)).toEqual({ ok: true, gasPayer: v })
  })
  it.each([['Self'], [' self'], ['SPONSORED'], ['both'], ['facilitator'], [true], [1], [{}], [['self']]])('%j is refused, not read as one of them', (v) => {
    expect(parseGasPayer(v)).toEqual({ ok: false })
  })
})

describe('assessSelfPay', () => {
  const req: SelfPayCall = {
    operation: 'CREATE',
    policyKey: 'k',
    attributes: [],
    validFromBlock: '0',
    validToBlock: '0',
    templateContractAddress: 'ZTX3Template',
    templateId: 'a'.repeat(64),
  }

  it('enough: the balance covers the estimate plus a fifth', async () => {
    const r = await assessSelfPay(selfPayDeps(), req)
    expect(r.status).toBe('enough')
    expect(r.gas).toMatchObject({ asset: 'ZTX', estimatedRaw: '1000000', estimatedHuman: '1 ZTX', requiredRaw: '1200000', requiredHuman: '1.2 ZTX' })
    expect(r.balance).toEqual({ raw: '5000000', human: '5 ZTX' })
    expect(r.problems).toEqual([])
    expect(r.notChecked.join(' ')).toContain('Whether Wallet BE will sign it')
  })

  it('exactly the required amount is enough, one less is short', async () => {
    expect((await assessSelfPay(selfPayDeps({ queryNativeBalance: async () => ztx('1200000') }), req)).status).toBe('enough')
    const short = await assessSelfPay(selfPayDeps({ queryNativeBalance: async () => ztx('1199999') }), req)
    expect(short.status).toBe('short')
    expect(short.problems.join(' ')).toContain('Not enough ZTX for gas')
    expect(short.problems.join(' ')).toContain('1.2 ZTX')
    expect(short.problems.join(' ')).toContain('1.199999 ZTX')
  })

  it('the reserve rounds up, so an estimate that is not a multiple of five still gets a whole unit more', async () => {
    const r = await assessSelfPay(selfPayDeps({ estimateGas: async () => ({ gasRaw: '6' }) }), req)
    // 6 + ceil(6 / 5) = 8; rounding down would give 7.
    expect(r.gas.requiredRaw).toBe('8')
    const exact = await assessSelfPay(selfPayDeps({ estimateGas: async () => ({ gasRaw: '5' }) }), req)
    expect(exact.gas.requiredRaw).toBe('6')
  })

  it('a balance that is not a number is unknown, never trusted and never a throw', async () => {
    const r = await assessSelfPay(selfPayDeps({ queryNativeBalance: async () => ({ token: 'ZTX', balance: 'abc', decimals: 6, display: '?' }) as TokenBalanceResult }), req)
    expect(r.status).toBe('unknown')
    expect(r.balance).toBeUndefined()
    expect(r.problems.join(' ')).toContain('balance could not be read')
  })

  it('an estimate that fails is unknown, never a guess, and a thrown one is contained', async () => {
    for (const estimateGas of [async () => ({ error: 'boom' }), async () => { throw new Error('boom') }, async () => ({ gasRaw: 'abc' })]) {
      const r = await assessSelfPay(selfPayDeps({ estimateGas: estimateGas as never }), req)
      expect(r.status).toBe('unknown')
      expect(r.gas.estimatedRaw).toBeUndefined()
      expect(r.problems.join(' ')).toContain('could not be estimated')
    }
  })

  it('a balance that cannot be read is unknown, never enough, and a throw is contained', async () => {
    for (const queryNativeBalance of [async () => ({ token: 'ZTX', error: 'query_failed' }), async () => { throw new Error('boom') }]) {
      const r = await assessSelfPay(selfPayDeps({ queryNativeBalance: queryNativeBalance as never }), req)
      expect(r.status).toBe('unknown')
      expect(r.balance).toBeUndefined()
      expect(r.problems.join(' ')).toContain('balance could not be read')
    }
  })

  it('no ZTX at all is a definite no even when the estimate is unknown', async () => {
    const r = await assessSelfPay(selfPayDeps({ estimateGas: async () => ({ error: 'x' }), queryNativeBalance: async () => ztx('0') }), req)
    expect(r.status).toBe('short')
    expect(r.problems.join(' ')).toContain('holds no ZTX')
  })

  it('a shortfall outranks nothing else being known: a known shortfall is short, not unknown', async () => {
    const r = await assessSelfPay(selfPayDeps({ queryNativeBalance: async () => ztx('1') }), req)
    expect(r.status).toBe('short')
  })

  it('hands the node the exact call it will build', async () => {
    const estimateGas = vi.fn(async (_c: SelfPayCall) => ({ gasRaw: '1' }))
    const call: SelfPayCall = { ...req, operation: 'UPDATE', policyKey: 'native-v1', expectedUpdatedAtBlock: '5' }
    await assessSelfPay(selfPayDeps({ estimateGas }), call)
    expect(estimateGas).toHaveBeenCalledWith(call)
  })
})

describe.each([
  ['write_policy', (d: WritePolicyDeps, extra: object) => writePolicy(d, { ...CREATE, ...extra } as never), 'CREATE'],
  ['update_policy', (d: WritePolicyDeps, extra: object) => updatePolicy(d, { ...UPDATE, ...extra } as never), 'UPDATE'],
] as const)('%s: the gas payer', (_tool, run, operation) => {
  it('without self-pay on offer nothing changes: it quotes as before and has no gasOptions', async () => {
    const h = harness(STEPS)
    const r = await run(h.d, { dryRun: true })
    expect(r.state).toBe('quoted')
    expect(r).not.toHaveProperty('gasOptions')
  })

  it('with self-pay on offer and no gasPayer it stops at needs_choice, even when confirmed: nothing paid, nothing collected', async () => {
    const h = harness(STEPS, { selfPay: selfPayDeps() })
    const r = await run(h.d, { confirm: true })
    expect(r.state).toBe('needs_choice')
    expect(r.paid).toBe(false)
    expect(h.pay).not.toHaveBeenCalled()
    expect(h.http.calls.map((c) => c.url).filter((u) => u.endsWith('/collect'))).toEqual([])
    expect(await h.d.receipts.list()).toEqual([])
  })

  it('and the same on a dry run', async () => {
    const h = harness(STEPS, { selfPay: selfPayDeps() })
    const r = await run(h.d, { dryRun: true })
    expect(r.state).toBe('needs_choice')
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('lays out both options, what each costs and whether the wallet can pay it', async () => {
    const h = harness(STEPS, {
      selfPay: selfPayDeps(),
      checkAffordability: async () =>
        ({ verdict: 'affordable', fee: { status: 'enough', required: '50000' }, gas: { status: 'not_needed' }, feeNotEstimated: false, problems: [], notChecked: [] }) as never,
    })
    const r = await run(h.d, {})
    expect(r.gasOptions?.sponsored).toMatchObject({ feeAsset: 'ZTX3JMYR', feeAmount: '50000', gas: 'paid by the service', affordability: { verdict: 'affordable' } })
    expect(r.gasOptions?.self).toMatchObject({ fee: 'none', status: 'enough', gas: { asset: 'ZTX', estimatedRaw: '1000000' } })
    expect(r.quote).toMatchObject({ asset: 'ZTX3JMYR', amount: '50000' })
    expect(r.interpretation).toContain('a cap')
    for (const word of ['CHOICE NEEDED', 'nothing was paid', 'SPONSORED', 'SELF', 'no fee', 'Never choose for the user', 'gasPayer']) {
      expect(r.message).toContain(word)
    }
    expect(r.message).toContain('holds 5 ZTX')
  })

  it('says plainly when the wallet cannot pay one of them, or does not know', async () => {
    const short = harness(STEPS, { selfPay: selfPayDeps({ queryNativeBalance: async () => ztx('10') }) })
    expect((await run(short.d, {})).message).toContain('could NOT pay it right now')
    const unknown = harness(STEPS, { selfPay: selfPayDeps({ estimateGas: async () => { throw new Error('x') } }) })
    const r = await run(unknown.d, {})
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions?.self?.status).toBe('unknown')
    expect(r.message).toContain('not known')
  })

  it('asks the node about the exact write it would make', async () => {
    const estimateGas = vi.fn(async (_c: SelfPayCall) => ({ gasRaw: '1000000' }))
    const h = harness(STEPS, { selfPay: selfPayDeps({ estimateGas }) })
    await run(h.d, {})
    expect(estimateGas).toHaveBeenCalledTimes(1)
    const arg = estimateGas.mock.calls[0][0]
    expect(arg.operation).toBe(operation)
    expect(arg).toMatchObject({ policyKey: 'native-v1', templateContractAddress: TEMPLATE_CONTRACT, templateId: TEMPLATE_ID, validFromBlock: '0', validToBlock: '0' })
    expect(arg.attributes).toEqual(NEW_ATTRS)
  })

  it('"sponsored" is today\'s flow, with or without self-pay on offer', async () => {
    for (const selfPay of [undefined, selfPayDeps()]) {
      const h = harness(STEPS, selfPay ? { selfPay } : {})
      const r = await run(h.d, { gasPayer: 'sponsored', confirm: true })
      expect(r.state).toBe('written')
      expect(h.pay).toHaveBeenCalledTimes(1)
    }
  })

  it('"sponsored" without confirm still stops at the price, as before', async () => {
    const h = harness(STEPS, { selfPay: selfPayDeps() })
    const r = await run(h.d, { gasPayer: 'sponsored' })
    expect(r.state).toBe('quoted')
    expect(r.needsConfirmation).toBe(true)
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('"self" where this wallet cannot pay the gas itself is refused: nothing paid, nothing sent', async () => {
    const h = harness(STEPS)
    const r = await run(h.d, { gasPayer: 'self', confirm: true })
    expect(r.state).toBe('refused')
    expect(r.paid).toBe(false)
    expect(r.message).toContain('NOTHING WAS PAID')
    expect(h.pay).not.toHaveBeenCalled()
    expect(h.http.calls).toEqual([])
  })

  it.each([['Self'], ['both'], [true], [1], ['facilitator']])('a gasPayer of %j is refused before the service is even contacted', async (bad) => {
    const h = harness(STEPS, { selfPay: selfPayDeps() })
    const r = await run(h.d, { gasPayer: bad, confirm: true })
    expect(r.state).toBe('refused')
    expect(r.message).toContain('gasPayer must be exactly')
    expect(r.message).toContain('NOTHING WAS PAID')
    expect(h.http.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('a paid write already waiting is recovered without a choice (nothing new is paid)', async () => {
    const h = harness([{ status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-9', detail: 'in flight', operation: operation } }], {
      selfPay: selfPayDeps(),
    })
    const r = await run(h.d, {})
    expect(r.state).not.toBe('needs_choice')
    expect(h.pay).not.toHaveBeenCalled()
  })
})
