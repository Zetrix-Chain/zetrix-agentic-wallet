/**
 * When the collect step answers with an error that says nothing about the write, the wallet reads the chain.
 *
 * What happened on staging: an `update_policy` was paid and the service finished the collect, but it took 12.7 seconds and something in
 * front of it answered HTTP 500 at about 10. The wallet could only say "unknown, ask again later", and asking again spends one of the
 * service's few collect retries. The chain already held the update. These tests pin that the wallet now looks, that it says "written"
 * only when the chain holds EXACTLY what was submitted, and that every other outcome is the old, cautious one.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import { createFsPolicyWriteReceiptStore, type PolicyWriteReceipt, type PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { checkPolicyWrite, updatePolicy, writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
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
const GATEWAY_500 = { status: 500, body: '<html><body>Internal Server Error</body></html>' }
const WRITTEN = { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: 'tx-1' } }

const memoryStore = (pre: PolicyWriteReceipt[] = []): PolicyWriteReceiptStore => {
  const map = new Map<string, PolicyWriteReceipt>(pre.map((r) => [r.blobId, r]))
  return {
    async get(id) { return map.get(id) ?? null },
    async set(r) { map.set(r.blobId, r) },
    async list() { return [...map.values()] },
    async remove(id) { map.delete(id) },
    filePathFor: (id) => `/memory/${id}`,
  }
}

const attr = (attributeName: string, value: string) => ({ attributeName, attributeType: 'NUMBER', value })
const chain = (attributes: Array<{ attributeName: string; attributeType?: string; value: unknown }>, updatedAtBlock: unknown): PolicyRead<PolicyReadResult> => ({
  found: true,
  value: { policy: { attributes, validFromBlock: '0', validToBlock: '0', updatedAtBlock, templateContractAddress: TEMPLATE_CONTRACT, templateId: TEMPLATE_ID } },
})

const BEFORE = chain([attr('cumulativeMax', '100000000')], 12345)
const NEW_ATTRS = [attr('cumulativeMax', '500000000')]
const AFTER = chain(NEW_ATTRS, 12400)

const UPDATE = { policyKey: 'native-v1', attributes: NEW_ATTRS, expectedUpdatedAtBlock: '12345', pollBudgetMs: 10_000, confirm: true }
const CREATE = {
  policyKey: 'native-v1',
  attributes: NEW_ATTRS,
  templateContractAddress: TEMPLATE_CONTRACT,
  templateId: TEMPLATE_ID,
  requestKey: 'r',
  pollBudgetMs: 10_000,
  confirm: true,
}

/** readPolicy that answers `first` once (the update's own read before paying) and then `after` for every later read. */
function reads(first: PolicyRead<PolicyReadResult>, after: PolicyRead<PolicyReadResult> | (() => PolicyRead<PolicyReadResult>)) {
  let n = 0
  return vi.fn(async () => (n++ === 0 ? first : typeof after === 'function' ? after() : after))
}

function harness(steps: Step[], over: Partial<WritePolicyDeps> = {}, pre: PolicyWriteReceipt[] = []) {
  const http = send(steps)
  const sleep = vi.fn(async () => undefined)
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http.fn),
    receipts: memoryStore(pre),
    pay: vi.fn(async () => 'X-PAYMENT-HEADER'),
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep,
    templateContract: TEMPLATE_CONTRACT,
    preflight: (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: ['a cap'], notChecked: [] })) as never,
    readPolicy: reads(BEFORE, AFTER),
    ...over,
  }
  const collects = () => http.calls.filter((c) => c.url.endsWith('/collect')).length
  return { d, http, sleep, collects }
}

describe('update_policy: the collect answered 500, and the chain already holds the update', () => {
  it('reports it as written, drops the bookmark, and does not spend another collect', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500])
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('written')
    expect(r.paid).toBe(true)
    expect(r.message).toContain('was updated')
    expect(r.message).toContain('(HTTP 500)')
    expect(r.message).toContain('updatedAtBlock moved from 12345 to 12400')
    expect(r.message).toContain('do not pay again')
    expect(h.collects()).toBe(1)
    expect(await h.d.receipts.list()).toEqual([])
  })

  it('keeps reading until the chain catches up, within the budget', async () => {
    const readPolicy = reads(BEFORE, (() => {
      let n = 0
      return () => (n++ < 2 ? BEFORE : AFTER)
    })())
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy })
    const r = await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 60_000 })
    expect(r.state).toBe('written')
    expect(h.collects()).toBe(1)
    expect(h.sleep).toHaveBeenCalled()
  })

  it('stays "unknown" when the chain never shows it, says it looked, keeps the receipt, and keeps the service\'s own answer apart', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, BEFORE) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unknown')
    expect(r.message).toContain('This wallet also read the chain for about')
    expect(r.message).toContain('That does not mean it failed')
    expect(r.upstream).toMatchObject({ status: 500 })
    expect(r.upstream?.detail).toContain('Internal Server Error')
    expect(r.paymentReceipt).toBe('blob-1')
    expect((await h.d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
    expect(h.collects()).toBe(1)
  })

  it('is bounded: it does not read the chain for ever', async () => {
    const readPolicy = reads(BEFORE, BEFORE)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy })
    await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 120_000 })
    // 1 for the update's own read, at most 12 for the verification.
    expect(readPolicy.mock.calls.length).toBeLessThanOrEqual(13)
  })

  it('does not call it written when the attributes match but updatedAtBlock did not move (it may already have held them)', async () => {
    const same = chain(NEW_ATTRS, 12345)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(same, same) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unknown')
  })

  it('does not call it written when updatedAtBlock moved but the attributes are not the ones submitted', async () => {
    const other = chain([attr('cumulativeMax', '999')], 12400)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, other) })
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('unknown')
  })

  it.each([
    ['an extra attribute', chain([attr('cumulativeMax', '500000000'), attr('countWindow', '1d')], 12400)],
    ['a missing attribute', chain([], 12400)],
    ['a repeated attribute', chain([attr('cumulativeMax', '500000000'), attr('cumulativeMax', '500000000')], 12400)],
    ['no updatedAtBlock', chain(NEW_ATTRS, undefined)],
  ])('does not call it written when the chain has %s', async (_l, after) => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, after) })
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('unknown')
  })

  it('treats a number and a string value the same (the chain may hand back either)', async () => {
    const asNumber = chain([{ attributeName: 'cumulativeMax', value: 500000000 }], 12400)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, asNumber) })
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('written')
  })

  it('an unreadable chain, a thrown read and a removed policy are all "not yet", never "written"', async () => {
    for (const after of [
      { error: 'query_failed', detail: 'node down' } as PolicyRead<PolicyReadResult>,
      { found: false } as PolicyRead<PolicyReadResult>,
    ]) {
      const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, after) })
      expect((await updatePolicy(h.d, UPDATE)).state).toBe('unknown')
    }
    let n = 0
    const thrower = vi.fn(async () => {
      if (n++ === 0) return BEFORE
      throw new Error('boom')
    })
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: thrower as never })
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('unknown')
  })

  it('a chain reader that fails on every read gives the old answer, apart from carrying the service\'s answer', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500])
    // The update itself needs the reader to start, so give it one that is then withdrawn.
    let n = 0
    h.d.readPolicy = (async () => {
      if (n++ === 0) return BEFORE
      throw new Error('gone')
    }) as never
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unknown')
    expect(r.upstream?.status).toBe(500)
  })

  it('a collect that succeeds is unchanged: no chain read is needed', async () => {
    const readPolicy = reads(BEFORE, AFTER)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, WRITTEN], { readPolicy })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('written')
    expect(r.message).toBe('The policy "native-v1" was updated on chain.')
    expect(readPolicy).toHaveBeenCalledTimes(1)
  })
})

describe('write_policy (create): the same, with "the policy exists" as the evidence', () => {
  it('written when the chain holds exactly what was submitted', async () => {
    const readPolicy = vi.fn(async () => chain(NEW_ATTRS, 5))
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy })
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('written')
    expect(r.message).toContain('is on chain')
    expect(r.message).not.toContain('updatedAtBlock')
    expect(await h.d.receipts.list()).toEqual([])
    expect(h.collects()).toBe(1)
  })

  it('still unknown when the policy is not there, or holds something else', async () => {
    for (const read of [{ found: false } as PolicyRead<PolicyReadResult>, chain([attr('cumulativeMax', '1')], 5)]) {
      const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: vi.fn(async () => read) })
      const r = await writePolicy(h.d, CREATE as never)
      expect(r.state).toBe('unknown')
      expect(r.upstream?.status).toBe(500)
    }
  })

  it('without a chain reader it is the old behaviour', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: undefined })
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('unknown')
    expect(r.message).not.toContain('This wallet also read the chain')
  })
})

describe('the other answers that say nothing about the write', () => {
  it('an unrecognised status is verified the same way, and its answer is kept apart', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 418, body: 'teapot' }], { readPolicy: reads(BEFORE, AFTER) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('written')
    const h2 = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 418, body: 'teapot' }], { readPolicy: reads(BEFORE, BEFORE) })
    const r2 = await updatePolicy(h2.d, UPDATE)
    expect(r2.state).toBe('unknown')
    expect(r2.upstream).toMatchObject({ status: 418 })
  })

  it('the service\'s own FAILED verdict is not second-guessed by the chain', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 502, body: { state: 'WRITE_FAILED', detail: 'chain rejected', txHash: 'tx' } }], { readPolicy: reads(BEFORE, AFTER) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('write_failed')
  })

  it('the upstream excerpt is bounded', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 500, body: 'x'.repeat(5000) }], { readPolicy: reads(BEFORE, BEFORE) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.upstream?.detail.length).toBeLessThanOrEqual(200)
  })
})

describe('check_policy_write looks at the chain before spending a collect', () => {
  const receipt = (over: Partial<PolicyWriteReceipt> = {}): PolicyWriteReceipt => ({
    blobId: 'blob-1',
    policyKey: 'native-v1',
    ownerAddress: OWNER,
    paidAt: '2026-10-08T00:00:00.000Z',
    operation: 'UPDATE',
    verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], priorUpdatedAtBlock: '12345' },
    ...over,
  })

  it('a write that already landed is reported with NO collect at all, and the bookmark goes', async () => {
    const h = harness([GATEWAY_500], { readPolicy: vi.fn(async () => AFTER) }, [receipt()])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.state).toBe('written')
    expect(r.message).toContain('No collect was needed')
    expect(h.http.calls).toEqual([])
    expect(await h.d.receipts.list()).toEqual([])
  })

  it('the same with no receipt named (the most recent one)', async () => {
    const h = harness([GATEWAY_500], { readPolicy: vi.fn(async () => AFTER) }, [receipt()])
    expect((await checkPolicyWrite(h.d, {})).state).toBe('written')
    expect(h.http.calls).toEqual([])
  })

  it('when the chain does not show it yet, it collects exactly as before', async () => {
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => BEFORE) }, [receipt()])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.state).toBe('written')
    expect(h.collects()).toBe(1)
  })

  it('a receipt with nothing to verify (paid elsewhere, or saved before this existed) collects as before', async () => {
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => AFTER) }, [receipt({ verify: undefined })])
    await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(h.collects()).toBe(1)
  })

  it('an unreadable chain falls through to the collect', async () => {
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => ({ error: 'query_failed', detail: 'x' }) as never) }, [receipt()])
    await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(h.collects()).toBe(1)
  })

  it('a create receipt needs no updatedAtBlock to be recognised', async () => {
    const h = harness([GATEWAY_500], { readPolicy: vi.fn(async () => chain(NEW_ATTRS, 5)) }, [receipt({ operation: undefined, verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }] } })])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.state).toBe('written')
    expect(r.message).toContain('is on chain')
  })
})

describe('the receipt carries what to verify, and the store treats it with suspicion', () => {
  const stepsPaid = [{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'SETTLING' } }]

  it('an update bookmark records the submitted attributes and the prior block, and nothing secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collect-verify-'))
    const h = harness(stepsPaid, { receipts: createFsPolicyWriteReceiptStore(dir) })
    await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 1 })
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const raw = await readFile(join(dir, files[0]), 'utf8')
    expect(JSON.parse(raw)).toEqual({
      blobId: 'blob-1',
      policyKey: 'native-v1',
      ownerAddress: OWNER,
      paidAt: expect.any(String),
      operation: 'UPDATE',
      verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], priorUpdatedAtBlock: '12345' },
    })
    expect(raw).not.toMatch(/hunter2|password|signature|publicKey/i)
  })

  it('a create bookmark records the attributes and no prior block', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collect-verify-'))
    const h = harness(stepsPaid, { receipts: createFsPolicyWriteReceiptStore(dir) })
    await writePolicy(h.d, { ...CREATE, pollBudgetMs: 1 } as never)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    const saved = JSON.parse(await readFile(join(dir, files[0]), 'utf8'))
    expect(saved.verify).toEqual({ attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], templateId: TEMPLATE_ID })
    expect(saved).not.toHaveProperty('operation')
  })

  it.each([
    ['not an object', 'x'],
    ['no attributes', { attributes: [] }],
    ['too many attributes', { attributes: Array.from({ length: 65 }, (_, i) => ({ attributeName: `a${i}`, value: '1' })) }],
    ['a duplicate name', { attributes: [{ attributeName: 'a', value: '1' }, { attributeName: 'a', value: '2' }] }],
    ['a non-string value', { attributes: [{ attributeName: 'a', value: 5 }] }],
    ['an over-long value', { attributes: [{ attributeName: 'a', value: 'x'.repeat(4001) }] }],
    ['a malformed prior block', { attributes: [{ attributeName: 'a', value: '1' }], priorUpdatedAtBlock: 'abc' }],
  ])('a malformed verify (%s) is dropped on read and the receipt is still readable', async (_l, verify) => {
    const dir = await mkdtemp(join(tmpdir(), 'collect-verify-'))
    const store = createFsPolicyWriteReceiptStore(dir)
    const base = { blobId: 'blob-x', policyKey: 'k', ownerAddress: OWNER, paidAt: '2026-10-08T00:00:00.000Z' }
    await store.set(base as never)
    const file = (await readdir(dir)).find((f) => f.endsWith('.json')) as string
    await writeFile(join(dir, file), JSON.stringify({ ...base, verify }), 'utf8')
    const got = await store.get('blob-x')
    expect(got).toMatchObject(base)
    expect(got).not.toHaveProperty('verify')
    expect((await store.list())[0]).not.toHaveProperty('verify')
  })

  it('a well-formed verify survives a round trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collect-verify-'))
    const store = createFsPolicyWriteReceiptStore(dir)
    const verify = { attributes: [{ attributeName: 'a', value: '1' }], priorUpdatedAtBlock: '77' }
    await store.set({ blobId: 'b', policyKey: 'k', ownerAddress: OWNER, paidAt: 'x', verify })
    expect((await store.get('b'))?.verify).toEqual(verify)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Review R1: a receipt must not be credited with a later write; the owner and template must match; bounded reads.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const WRITE_FAILED = { status: 502, body: { state: 'WRITE_FAILED', detail: 'chain rejected', txHash: 'tx-f' } }

describe('R1-M1: a failed or superseded receipt is never credited with a later write of the same values', () => {
  it('update: after WRITE_FAILED the receipt keeps its id but loses its verify, so a later identical write cannot make it "written"', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, WRITE_FAILED], { readPolicy: reads(BEFORE, AFTER) })
    const first = await updatePolicy(h.d, UPDATE)
    expect(first.state).toBe('write_failed')
    const kept = await h.d.receipts.get('blob-1')
    expect(kept).not.toBeNull()
    expect(kept).not.toHaveProperty('verify')

    // Later the user pays for the same values and they land (chain moved to 12400). Checking the FAILED receipt must still ask the service.
    h.d.readPolicy = vi.fn(async () => AFTER)
    const before = h.collects()
    const again = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(again.state).toBe('write_failed')
    expect(again.message).not.toContain('No collect was needed')
    expect(h.collects()).toBe(before + 1)
    expect(await h.d.receipts.get('blob-1')).not.toBeNull()
  })

  it('create: the same after WRITE_FAILED, and the unnamed check does not report it written', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, WRITE_FAILED], { readPolicy: vi.fn(async () => ({ found: false }) as PolicyRead<PolicyReadResult>) })
    expect((await writePolicy(h.d, CREATE as never)).state).toBe('write_failed')
    h.d.readPolicy = vi.fn(async () => chain(NEW_ATTRS, 5))
    const r = await checkPolicyWrite(h.d, {})
    expect(r.state).toBe('write_failed')
    expect(await h.d.receipts.list()).toHaveLength(1)
  })

  it('a newer paid write for the same key strips verify from the older receipts for that key, and only that key', async () => {
    const older = (blobId: string, policyKey: string): PolicyWriteReceipt => ({
      blobId,
      policyKey,
      ownerAddress: OWNER,
      paidAt: '2026-10-07T00:00:00.000Z',
      operation: 'UPDATE',
      verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], priorUpdatedAtBlock: '12345' },
    })
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, WRITTEN], { readPolicy: reads(BEFORE, AFTER) }, [older('blob-old', 'native-v1'), older('blob-other', 'ztp20-v1')])
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('written')
    expect(await h.d.receipts.get('blob-old')).not.toHaveProperty('verify')
    expect((await h.d.receipts.get('blob-other'))?.verify).toBeDefined()
    // The older receipt is still collectable, and the chain read no longer answers for it.
    h.d.readPolicy = vi.fn(async () => AFTER)
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-old' })
    expect(r.message).not.toContain('No collect was needed')
  })

  it('a chain-inferred "written" carries the receipt id for support', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: reads(BEFORE, AFTER) })
    expect((await updatePolicy(h.d, UPDATE)).paymentReceipt).toBe('blob-1')
  })
})

describe('R1-M1: create is checked against its template as well', () => {
  const created = (over: Partial<PolicyWriteReceipt['verify'] & object> = {}): PolicyWriteReceipt => ({
    blobId: 'blob-1',
    policyKey: 'native-v1',
    ownerAddress: OWNER,
    paidAt: '2026-10-08T00:00:00.000Z',
    verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], templateId: TEMPLATE_ID, ...over },
  })

  it('the same values under the same template: written, no collect', async () => {
    const h = harness([GATEWAY_500], { readPolicy: vi.fn(async () => chain(NEW_ATTRS, 5)) }, [created()])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.state).toBe('written')
    expect(h.http.calls).toEqual([])
  })

  it('the same values under another template is not this write', async () => {
    const other = chain(NEW_ATTRS, 5)
    ;(other as { value: { policy: { templateId: string } } }).value.policy.templateId = 'b'.repeat(64)
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => other) }, [created()])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.message).not.toContain('No collect was needed')
    expect(h.collects()).toBe(1)
  })

  it('the same values under another Template contract is not this write', async () => {
    const other = chain(NEW_ATTRS, 5)
    ;(other as { value: { policy: { templateContractAddress: string } } }).value.policy.templateContractAddress = 'ZTX3Elsewhere'
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => other) }, [created()])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.message).not.toContain('No collect was needed')
  })
})

describe('R1-L1: a receipt left by another owner is not checked against this owner\'s policy', () => {
  it('falls through to the collect', async () => {
    const stranger: PolicyWriteReceipt = {
      blobId: 'blob-1',
      policyKey: 'native-v1',
      ownerAddress: 'ZTX3SomeoneElse',
      paidAt: '2026-10-08T00:00:00.000Z',
      operation: 'UPDATE',
      verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], priorUpdatedAtBlock: '12345' },
    }
    const readPolicy = vi.fn(async () => AFTER)
    const h = harness([WRITTEN], { readPolicy }, [stranger])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.message).not.toContain('No collect was needed')
    expect(readPolicy).not.toHaveBeenCalled()
    expect(h.collects()).toBe(1)
  })
})

describe('chain-first: what it needs and what it refuses', () => {
  const upd = (over: Partial<PolicyWriteReceipt> = {}): PolicyWriteReceipt => ({
    blobId: 'blob-1',
    policyKey: 'native-v1',
    ownerAddress: OWNER,
    paidAt: '2026-10-08T00:00:00.000Z',
    operation: 'UPDATE',
    verify: { attributes: [{ attributeName: 'cumulativeMax', value: '500000000' }], priorUpdatedAtBlock: '12345' },
    ...over,
  })

  it('an update receipt that recorded no prior block is never "applied" (nothing to show the chain moved)', async () => {
    const r0 = upd()
    const h = harness([WRITTEN], { readPolicy: vi.fn(async () => AFTER) }, [
      { ...r0, verify: { attributes: r0.verify!.attributes } },
    ])
    const r = await checkPolicyWrite(h.d, { paymentReceipt: 'blob-1' })
    expect(r.message).not.toContain('No collect was needed')
    expect(h.collects()).toBe(1)
  })

  it('with several receipts pending, the newest is still looked at on chain first, and the others are named', async () => {
    const newest = upd({ blobId: 'blob-new', paidAt: '2026-10-08T02:00:00.000Z' })
    const oldest = upd({ blobId: 'blob-old', policyKey: 'ztp20-v1', paidAt: '2026-10-08T01:00:00.000Z' })
    const h = harness([GATEWAY_500], { readPolicy: vi.fn(async () => AFTER) }, [newest, oldest])
    const r = await checkPolicyWrite(h.d, {})
    expect(r.state).toBe('written')
    expect(r.message).toContain('No collect was needed')
    expect(r.message).toContain('2 paid-for writes are on file')
    expect(r.message).toContain('blob-old')
    expect(h.http.calls).toEqual([])
  })
})

describe('R1-L2: the chain read is bounded in count, in time left, and per read', () => {
  it('with the whole budget available it makes at most 9 verifying reads (45 s)', async () => {
    const readPolicy = reads(BEFORE, BEFORE)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy })
    await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 120_000 })
    expect(readPolicy).toHaveBeenCalledTimes(1 + 9)
  })

  it('with a spent budget it still gets a short floor (10 s), not 45 s', async () => {
    const readPolicy = reads(BEFORE, BEFORE)
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy })
    await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 1 })
    expect(readPolicy).toHaveBeenCalledTimes(1 + 2)
  })

  it('what the poll already used comes off the verify budget', async () => {
    const clock = { t: 0 }
    const readPolicy = reads(BEFORE, BEFORE)
    const h = harness(
      [{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'PAID_PENDING' }, headers: { 'Retry-After': '30' } }, GATEWAY_500],
      {
        readPolicy,
        now: () => new Date(clock.t),
        sleep: vi.fn(async (ms: number) => {
          clock.t += ms
        }),
      },
    )
    await updatePolicy(h.d, { ...UPDATE, pollBudgetMs: 60_000 })
    // 30 s were spent waiting on the 202, so 30 s remain: reads at 0,5,...,25 s = 6 verifying reads (not 9).
    expect(readPolicy).toHaveBeenCalledTimes(1 + 6)
  })

  it('a read that never answers is cut off and the answer stays "unknown"', async () => {
    let n = 0
    const hang = vi.fn(async () => (n++ === 0 ? BEFORE : await new Promise<never>(() => undefined)))
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, GATEWAY_500], { readPolicy: hang as never, readTimeoutMs: 5 })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unknown')
    expect((await h.d.receipts.list()).map((x) => x.blobId)).toEqual(['blob-1'])
  })
})

describe('R1-L3: the service\'s own words are bounded and carry no control characters', () => {
  it('the service\'s own 504 UNKNOWN carries upstream, bounded', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 504, body: { state: 'UNKNOWN', detail: 'y'.repeat(5000) } }], { readPolicy: reads(BEFORE, BEFORE) })
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unknown')
    expect(r.upstream?.status).toBe(504)
    expect(r.upstream!.detail.length).toBeLessThanOrEqual(200)
  })

  it('newlines and control characters are replaced, in a JSON detail and in a plain body', async () => {
    const bell = String.fromCharCode(7)
    for (const step of [
      { status: 504, body: { state: 'UNKNOWN', detail: `line one\nline two${bell}end${String.fromCharCode(0x2028)}more` } },
      { status: 500, body: `plain\r\nbody${bell}here` },
    ]) {
      const h = harness([{ status: 402, body: CHALLENGE }, PAID, step], { readPolicy: reads(BEFORE, BEFORE) })
      const r = await updatePolicy(h.d, UPDATE)
      expect(r.upstream?.detail).toBeDefined()
      expect(r.upstream!.detail).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u)
      expect(r.upstream!.detail).toMatch(/line one line two|plain body/)
    }
  })
})

describe('R1-L5: what the bookmark records, and what the store accepts', () => {
  it('a 4xx the wallet does not know enters the chain read like any other unrecognised answer', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 400, body: 'bad request' }], { readPolicy: reads(BEFORE, AFTER) })
    expect((await updatePolicy(h.d, UPDATE)).state).toBe('written')
  })

  it('the bookmark holds the converted wire value, not the human amount', async () => {
    const preflight = (async () => ({
      ready: true,
      policyKey: 'native-v1',
      blockers: [],
      interpretation: ['a cap'],
      notChecked: [],
      convertedAmounts: { cumulativeMax: '500000000' },
    })) as never
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'PAID_PENDING' } }], { preflight, readPolicy: reads(BEFORE, BEFORE) })
    await updatePolicy(h.d, {
      policyKey: 'native-v1',
      attributes: [{ attributeName: 'cumulativeMax', valueHuman: '500' }],
      amountUnit: 'whole',
      expectedUpdatedAtBlock: '12345',
      pollBudgetMs: 1,
      confirm: true,
    })
    expect((await h.d.receipts.get('blob-1'))?.verify?.attributes).toEqual([{ attributeName: 'cumulativeMax', value: '500000000' }])
  })

  it('more attributes than the store would accept back are not recorded (no verify), the receipt still is', async () => {
    const many = Array.from({ length: 65 }, (_, i) => attr(`a${i}`, '1'))
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'PAID_PENDING' } }], { readPolicy: reads(BEFORE, BEFORE) })
    await updatePolicy(h.d, { ...UPDATE, attributes: many, pollBudgetMs: 1 })
    const saved = await h.d.receipts.get('blob-1')
    expect(saved).not.toBeNull()
    expect(saved).not.toHaveProperty('verify')
  })

  it('an over-long value is not recorded either', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'PAID_PENDING' } }], { readPolicy: reads(BEFORE, BEFORE) })
    await updatePolicy(h.d, { ...UPDATE, attributes: [attr('cumulativeMax', '9'.repeat(4001))], pollBudgetMs: 1 })
    expect(await h.d.receipts.get('blob-1')).not.toHaveProperty('verify')
  })

  it.each([
    ['an empty attribute name', { attributes: [{ attributeName: '', value: '1' }] }],
    ['an over-long attribute name', { attributes: [{ attributeName: 'n'.repeat(101), value: '1' }] }],
    ['a blank templateId', { attributes: [{ attributeName: 'a', value: '1' }], templateId: '' }],
    ['a non-string templateId', { attributes: [{ attributeName: 'a', value: '1' }], templateId: 5 }],
    ['an over-long templateId', { attributes: [{ attributeName: 'a', value: '1' }], templateId: 't'.repeat(201) }],
  ])('a malformed verify (%s) is dropped on read', async (_l, verify) => {
    const dir = await mkdtemp(join(tmpdir(), 'collect-verify-'))
    const store = createFsPolicyWriteReceiptStore(dir)
    const base = { blobId: 'blob-y', policyKey: 'k', ownerAddress: OWNER, paidAt: '2026-10-08T00:00:00.000Z' }
    await store.set(base as never)
    const file = (await readdir(dir)).find((f) => f.endsWith('.json')) as string
    await writeFile(join(dir, file), JSON.stringify({ ...base, verify }), 'utf8')
    expect(await store.get('blob-y')).not.toHaveProperty('verify')
  })
})
