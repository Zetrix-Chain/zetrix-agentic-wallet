/**
 * Review round 1: M1 recovery on the receipt's own operation, M2 a null validity bound, M3 a malformed error
 * envelope, M4 the false recovery promises and the create 461529 mapping, and the LOW findings L1 to L6.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { updatePolicy, removePolicy, writePolicy, checkPolicyWrite, type WritePolicyDeps } from '../orchestrator/write-policy'
import { getPolicyByKey, type PolicyRead, type PolicyReadResult } from '../clients/policy-read-client'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE_CONTRACT = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const TEMPLATE_ID = 'a'.repeat(64)

type Step = { status: number; body?: unknown; headers?: Record<string, string> }
function send(steps: Step[]) {
  const calls: Array<{ url: string; body: string }> = []
  let i = 0
  const fn = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: init.body })
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
const WRITTEN = { status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: 'tx-1' } }
const inFlight = (operation?: 'CREATE' | 'UPDATE') => ({
  status: 409,
  body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-old', detail: 'already paid', ...(operation ? { operation } : {}) },
})

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
const receipt = (operation?: 'UPDATE'): PolicyWriteReceipt => ({
  blobId: 'blob-old',
  policyKey: 'native-v1',
  ownerAddress: OWNER,
  paidAt: '2026-10-07T00:00:00.000Z',
  ...(operation ? { operation } : {}),
})

const onChain = (over: Record<string, unknown> = {}): PolicyRead<PolicyReadResult> => ({
  found: true,
  value: {
    policy: {
      attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '100000000' }],
      validFromBlock: '10',
      validToBlock: '99',
      updatedAtBlock: 12345,
      templateContractAddress: TEMPLATE_CONTRACT,
      templateId: TEMPLATE_ID,
      ...over,
    },
  },
})

const UPDATE = {
  policyKey: 'native-v1',
  attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' }],
  expectedUpdatedAtBlock: '12345',
  pollBudgetMs: 10_000,
  confirm: true,
}
const CREATE = {
  policyKey: 'native-v1',
  attributes: [{ attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' }],
  templateContractAddress: TEMPLATE_CONTRACT,
  templateId: TEMPLATE_ID,
  requestKey: 'req-1',
  pollBudgetMs: 10_000,
  confirm: true,
}

function harness(steps: Step[], pre: PolicyWriteReceipt[] = [], over: Partial<WritePolicyDeps> = {}) {
  const http = send(steps)
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const preflight = vi.fn(async () => ({ ready: true, policyKey: 'native-v1', blockers: [] as string[], interpretation: ['a cap'], notChecked: [] as string[] }))
  const readPolicy = vi.fn(async () => onChain())
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http.fn),
    receipts: memoryStore(pre),
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    templateContract: TEMPLATE_CONTRACT,
    preflight: preflight as never,
    readPolicy,
    ...over,
  }
  const collectUrls = () => http.calls.map((c) => c.url).filter((u) => u.endsWith('/collect'))
  return { d, http, pay, preflight, collectUrls }
}

describe('R1-M1: recovery collects on the receipt\'s OWN route, and refuses when it cannot tell', () => {
  it('update_policy: a 409 with no operation and no stored receipt is refused, not collected as a create', async () => {
    const h = harness([inFlight(undefined)])
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('refused')
    expect(r.paid).toBe(true)
    expect(r.paymentReceipt).toBe('blob-old')
    expect(r.message).toContain('NOTHING WAS COLLECTED')
    expect(r.message).toContain('neither the service nor this wallet says whether its receipt pays for a create or an update')
    expect(h.collectUrls()).toEqual([])
    expect(await h.d.receipts.list()).toEqual([])
  })

  it('update_policy: a stored UPDATE receipt decides the route even when the 409 omits the operation', async () => {
    const h = harness([inFlight(undefined), WRITTEN], [receipt('UPDATE')])
    await updatePolicy(h.d, UPDATE)
    expect(h.collectUrls()).toEqual([`${BASE}/pay/policy/update/collect`])
  })

  it('write_policy: the same, a stored UPDATE receipt is collected on the update route', async () => {
    const h = harness([inFlight(undefined), WRITTEN], [receipt('UPDATE')])
    await writePolicy(h.d, CREATE as never)
    expect(h.collectUrls()).toEqual([`${BASE}/pay/policy/update/collect`])
  })

  it('refuses without collecting when the service and the stored record disagree (stored UPDATE, service says CREATE)', async () => {
    const h = harness([inFlight('CREATE'), WRITTEN], [receipt('UPDATE')])
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('the service says its receipt pays for a CREATE and this wallet\'s own record says UPDATE')
    expect(r.message).toContain('NOTHING WAS COLLECTED')
    expect(h.collectUrls()).toEqual([])
  })

  it('refuses without collecting when the stored record is a create and the service says UPDATE', async () => {
    const h = harness([inFlight('UPDATE'), WRITTEN], [receipt()])
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('says its receipt pays for a UPDATE and this wallet\'s own record says CREATE')
    expect(h.collectUrls()).toEqual([])
  })

  it('a receipt the wallet does not hold is collected on the server\'s operation, and bookmarked with it', async () => {
    const h = harness([inFlight('UPDATE'), WRITTEN])
    await updatePolicy(h.d, UPDATE)
    expect(h.collectUrls()).toEqual([`${BASE}/pay/policy/update/collect`])
  })

  it('write_policy keeps its historical default: a 409 with no operation and no stored receipt is collected as a create', async () => {
    const h = harness([inFlight(undefined), WRITTEN])
    await writePolicy(h.d, CREATE as never)
    expect(h.collectUrls()).toEqual([`${BASE}/pay/policy/adopt-template/collect`])
  })

  it('a held receipt that agrees with the service is collected on its own route', async () => {
    const h = harness([inFlight('UPDATE'), WRITTEN], [receipt('UPDATE')])
    await updatePolicy(h.d, UPDATE)
    expect(h.collectUrls()).toEqual([`${BASE}/pay/policy/update/collect`])
  })

  it('does not collect any of this without confirm, whatever the operations say', async () => {
    const h = harness([inFlight('UPDATE'), WRITTEN], [receipt('UPDATE')])
    await updatePolicy(h.d, { ...UPDATE, confirm: false })
    expect(h.collectUrls()).toEqual([])
  })

  it('R1-L1: the refusal for a receipt the wallet does not hold names the tool that was called', async () => {
    const forUpdate = await updatePolicy(harness([inFlight('UPDATE')]).d, { ...UPDATE, confirm: false })
    expect(forUpdate.message).toContain('call update_policy again with confirm: true')
    expect(forUpdate.message).toContain('this wallet holds no receipt for it')
    const forCreate = await writePolicy(harness([inFlight('CREATE')]).d, { ...CREATE, confirm: false } as never)
    expect(forCreate.message).toContain('call write_policy again with confirm: true')
  })
})

describe('R1-M2: a null or malformed validity bound never strips an expiry', () => {
  const run = async (patch: Record<string, unknown>) => {
    const h = harness([{ status: 402, body: CHALLENGE }, { status: 202, body: { state: 'PAID_PENDING', receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } }, WRITTEN])
    const r = await updatePolicy(h.d, { ...UPDATE, ...patch } as never)
    return { r, h, sent: h.http.calls[0] ? JSON.parse(h.http.calls[0].body) : undefined }
  }

  it.each([
    ['validToBlock: null', { validToBlock: null }],
    ['validFromBlock: null', { validFromBlock: null }],
    ['both null', { validFromBlock: null, validToBlock: null }],
  ])('%s carries the current bound forward', async (_l, patch) => {
    const { sent, preflightArg } = await (async () => {
      const x = await run(patch)
      return { sent: x.sent, preflightArg: (x.h.preflight.mock.calls as unknown as unknown[][])[0][0] as { validFromBlock: string; validToBlock: string } }
    })()
    expect(sent.validFromBlock).toBe('10')
    expect(sent.validToBlock).toBe('99')
    expect(preflightArg).toMatchObject({ validFromBlock: '10', validToBlock: '99' })
  })

  it('a named bound still replaces the carried one, and the other is carried', async () => {
    const { sent } = await run({ validToBlock: '500', validFromBlock: null })
    expect(sent.validToBlock).toBe('500')
    expect(sent.validFromBlock).toBe('10')
  })

  it('a numeric bound is accepted and sent as a string', async () => {
    const { sent } = await run({ validToBlock: 500 })
    expect(sent.validToBlock).toBe('500')
  })

  it.each(['abc', '', ' 5', '1.5', '-1', '1e3', 1.5, -1, {}, [], true, '9'.repeat(31)])('refuses %j before anything is sent', async (bad) => {
    const { r, h } = await run({ validToBlock: bad })
    expect(r.state).toBe('refused')
    expect(r.message).toContain('whole block number written as digits')
    expect(r.message).toContain('Nothing was paid')
    expect(h.http.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('R1-L2: the "kept" line names only the bound that was actually carried', async () => {
    const both = await run({})
    expect((both.r.interpretation ?? []).join(' ')).toContain('was not changed: validFromBlock is kept as it is now (block 10) and validToBlock is kept as it is now (block 99)')
    const one = await run({ validToBlock: '500' })
    const text = (one.r.interpretation ?? []).join(' ')
    expect(text).toContain('is only partly changed: validFromBlock is kept as it is now (block 10)')
    expect(text).not.toContain('validToBlock is kept')
    const none = await run({ validFromBlock: '1', validToBlock: '2' })
    expect((none.r.interpretation ?? []).join(' ')).not.toMatch(/validity window/)
  })
})

describe('R1-M3: a malformed error envelope never throws', () => {
  const REQUEST = { ...CREATE, ownerAddress: OWNER, attributes: CREATE.attributes } as never
  const bodies = [
    ['messages is a string', '{"messages":"oops","detail":"the real reason"}'],
    ['messages is an object', '{"messages":{"a":1},"message":"the real reason"}'],
    ['messages is a number', '{"messages":5,"detail":"the real reason"}'],
    ['messages is null', '{"messages":null,"detail":"the real reason"}'],
    ['messages holds non-objects', '{"messages":[1,null,"x",[]],"detail":"the real reason"}'],
    ['the body is a JSON string', '"just a string"'],
    ['the body is a JSON number', '12'],
    ['the body is null', 'null'],
    ['the body is HTML', '<html>bad gateway</html>'],
  ] as const

  it.each(bodies)('create pay(): %s -> a refusal, not an exception', async (_l, body) => {
    const client = new PolicyWriteClient(BASE, send([{ status: 500, body }]).fn)
    const out = await client.pay(REQUEST, 'HDR')
    expect(typeof out.kind).toBe('string')
  })

  it.each(bodies)('update pre-check: %s -> a result, not an exception', async (_l, body) => {
    const client = new PolicyWriteClient(BASE, send([{ status: 409, body }]).fn)
    const out = await client.precheckUpdate({ ...(REQUEST as object), expectedUpdatedAtBlock: '1' } as never)
    expect(['refused', 'in_progress', 'modified']).toContain(out.kind)
  })

  it.each(bodies)('remove: %s -> a result, not an exception', async (_l, body) => {
    const client = new PolicyWriteClient(BASE, send([{ status: 409, body }]).fn)
    const out = await client.remove(OWNER, 'k', 'pw')
    expect(out.kind).toBe('refused')
  })

  it('the real reason survives next to a broken messages field', async () => {
    const client = new PolicyWriteClient(BASE, send([{ status: 400, body: '{"messages":"oops","detail":"the real reason"}' }]).fn)
    const out = await client.pay(REQUEST, 'HDR')
    expect(out).toMatchObject({ kind: 'refused', detail: 'the real reason' })
  })

  it('a well-formed envelope still gives its message and its code', async () => {
    const body = { success: false, messages: [{ type: 'ERROR', errorCode: 461529, message: 'paid write in flight' }] }
    const client = new PolicyWriteClient(BASE, send([{ status: 409, body }]).fn)
    expect(await client.precheckUpdate({ ...(REQUEST as object), expectedUpdatedAtBlock: '1' } as never)).toMatchObject({ kind: 'in_progress', detail: 'paid write in flight' })
  })

  it('a payment refusal reaches the agent as payment_refused even with a hostile body, after the payment was presented', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, { status: 500, body: '{"messages":"oops"}' }])
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('payment_refused')
    expect(r.message).toContain('Whether the fee was taken is not stated')
  })
})

describe('R1-M4: no false promise of a receipt, and a paid create in progress is not an existing policy', () => {
  const IN_PROGRESS = { status: 409, body: { success: false, messages: [{ type: 'ERROR', errorCode: 461529, message: 'a paid write is being completed' }] } }

  it('create pre-check: 409 + 461529 is in progress, not "already exists"', async () => {
    const client = new PolicyWriteClient(BASE, send([IN_PROGRESS]).fn)
    expect(await client.precheck({ ...(CREATE as object), ownerAddress: OWNER } as never)).toMatchObject({ kind: 'in_progress', detail: 'a paid write is being completed' })
  })

  it('create pre-check: a 409 with another code is still "already exists"', async () => {
    const client = new PolicyWriteClient(BASE, send([{ status: 409, body: { state: 'ALREADY_EXISTS', detail: 'that key is taken' } }]).fn)
    expect(await client.precheck({ ...(CREATE as object), ownerAddress: OWNER } as never)).toMatchObject({ kind: 'already_exists' })
  })

  it('write_policy says a paid write is in progress, does not say "nothing was paid", and does not promise a receipt', async () => {
    const h = harness([IN_PROGRESS])
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('ALREADY BEEN PAID FOR')
    expect(r.message).toContain('Do not pay again')
    expect(r.message).toContain('get_my_policy')
    expect(r.message).not.toMatch(/already exists|hand back the receipt/i)
    expect(r.message).not.toMatch(/Nothing was paid\./)
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('update_policy in_progress no longer sends the agent to a dead end', async () => {
    const r = await updatePolicy(harness([IN_PROGRESS]).d, UPDATE)
    expect(r.message).toContain('ALREADY BEEN PAID FOR')
    expect(r.message).toContain('If this wallet holds its receipt, check_policy_write finishes it')
    expect(r.message).not.toContain('Finish it first with check_policy_write')
  })

  it('remove_policy in_progress says the same', async () => {
    const h = harness([IN_PROGRESS])
    const r = await removePolicy(h.d, { policyKey: 'native-v1', confirm: true })
    expect(r.state).toBe('in_progress')
    expect(r.message).toContain('If this wallet holds its receipt, check_policy_write finishes it')
    expect(r.message).not.toContain('Finish it with check_policy_write first')
  })

  it('a payment that comes back with no receipt does not promise the pre-check will hand one back', async () => {
    const h = harness([{ status: 402, body: CHALLENGE }, { status: 202, body: {} }])
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('unknown')
    expect(r.message).toContain('holds nothing it could collect')
    expect(r.message).toContain('get_my_policy')
    expect(r.message).not.toMatch(/hand back the receipt|tell you the policy already exists/i)
    const u = await updatePolicy(harness([{ status: 402, body: CHALLENGE }, { status: 202, body: {} }]).d, UPDATE)
    expect(u.message).not.toMatch(/hand back the receipt/i)
  })

  it('a payment whose answer never arrived does not promise a receipt either', async () => {
    const down = (async () => {
      throw new Error('socket hang up')
    }) as unknown as HttpSend
    let n = 0
    const http: HttpSend = (async (url: string, init: never) => {
      if (n++ < 1) return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify(CHALLENGE) }
      return down(url, init)
    }) as never
    const h = harness([])
    h.d.client = new PolicyWriteClient(BASE, http)
    const r = await writePolicy(h.d, CREATE as never)
    expect(r.state).toBe('unknown')
    expect(r.message).toContain('holds no receipt')
    expect(r.message).not.toMatch(/will hand back the receipt/i)
  })

  it('check_policy_write for a receipt it does not hold does not promise one either', async () => {
    const r = await checkPolicyWrite(harness([]).d, { paymentReceipt: 'nope' })
    expect(r.message).toContain('holds no record of receipt "nope"')
    expect(r.message).toContain('get_my_policy')
    expect(r.message).not.toMatch(/will report it/i)
  })
})

describe('R1-L4 / L5 / L6', () => {
  it.each([200, 201, 204])('L4: remove answering an unexpected %i is unknown, never "nothing was removed"', async (status) => {
    const h = harness([{ status, body: '' }])
    const r = await removePolicy(h.d, { policyKey: 'native-v1', confirm: true })
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('NOT known whether the removal went through')
    expect(r.message).not.toContain('Nothing was removed')
  })

  it.each([500, 502, 503, 504])('L5: a %i on the update pre-check is the service not answering, not a refusal', async (status) => {
    const h = harness([{ status, body: '<html>bad gateway</html>' }])
    const r = await updatePolicy(h.d, UPDATE)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Nothing was paid')
    expect(r.state).not.toBe('refused')
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('L5: a 4xx on the update pre-check is still a refusal', async () => {
    const r = await updatePolicy(harness([{ status: 400, body: { detail: 'bad request' } }]).d, UPDATE)
    expect(r.state).toBe('refused')
  })

  describe('L6: a malformed getPolicy reply is a failed read, never "the policy is gone"', () => {
    const query = (value: unknown) =>
      vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [{ result: { value: typeof value === 'string' ? value : JSON.stringify(value) } }] } })

    it.each([['null', 'null'], ['an empty object', '{}'], ['an array', '[]'], ['a string', '"x"'], ['found as a string', '{"found":"true"}'], ['found missing', '{"policy":{}}']])(
      '%s -> query_failed',
      async (_l, value) => {
        const out = await getPolicyByKey('ZTX3Contract', 'k', query(value) as never)
        expect(out).toMatchObject({ error: 'query_failed' })
      },
    )

    it('found:false is still "no such policy", found:true still reads it', async () => {
      expect(await getPolicyByKey('ZTX3Contract', 'k', query('{"found":false}') as never)).toEqual({ found: false })
      expect(await getPolicyByKey('ZTX3Contract', 'k', query('{"found":true,"policy":{"attributes":[]}}') as never)).toMatchObject({ found: true })
    })

    it('remove_policy stays submitted when the read comes back malformed', async () => {
      const h = harness([{ status: 202, body: { state: 'SUBMITTED', policyKey: 'native-v1', txHash: 'tx' } }], [], {
        readPolicy: async () => ({ error: 'query_failed', detail: 'getPolicy: the reply carried no boolean found' }),
      })
      const r = await removePolicy(h.d, { policyKey: 'native-v1', confirm: true, pollBudgetMs: 1_000 })
      expect(r.state).toBe('submitted')
    })
  })

  it('L7: the idempotence claim is stated as the server\'s, not the wallet\'s', async () => {
    const r = await removePolicy(harness([{ status: 503, body: 'x' }]).d, { policyKey: 'native-v1', confirm: true })
    expect(r.message).toContain('expected not to submit a second removal')
    expect(r.message).not.toContain('never submits')
  })
})
