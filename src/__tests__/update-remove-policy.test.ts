/**
 * update_policy / remove_policy — the two ways a user manages a policy once it exists, both through the agent.
 *
 * An update PAYS (0.05 JMYR, through the same capped payer as every other paying tool); a remove is FREE but lifts every
 * limit the policy set, so it is gated on a confirmation and is reported as removed only when the chain says so.
 *
 * What these tests care about most:
 *   - every refusal that can be known before paying says NOTHING WAS PAID, and the test fails if the guard is removed
 *   - a 202, or a submitted transaction, is never reported as done
 *   - an update never silently strips a validity window it was not told to change
 *   - nothing is sent, and no password is tried, without the user's confirmation
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { updatePolicy, removePolicy, checkPolicyWrite, type WritePolicyDeps } from '../orchestrator/write-policy'
import type { PolicyRead, PolicyReadResult } from '../clients/policy-read-client'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE_CONTRACT = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const TEMPLATE_ID = 'a'.repeat(64)

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

const failure = (errorCode: number, message: string) => ({ success: false, messages: [{ type: 'ERROR', errorCode, message }] })

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
    async list() { return [...map.values()].sort((a, b) => b.paidAt.localeCompare(a.paidAt)) },
    async remove(id) { map.delete(id) },
    filePathFor: (id) => `/memory/${id}`,
  }
}

/** The policy as the chain holds it: block fields are strings, updatedAtBlock is a NUMBER. */
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

const deps = (steps: Step[], over: Partial<WritePolicyDeps> = {}) => {
  const http = send(steps)
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const preflight = vi.fn(async () => ({ ready: true, policyKey: 'native-v1', blockers: [] as string[], interpretation: ['a cap'], notChecked: [] as string[] }))
  const readPolicy = vi.fn(async () => onChain())
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http),
    receipts: memoryStore(),
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
  // An unbounded poll with an instant sleep never yields, so it would hang the run rather than fail a test. Cap every read
  // here so that such a loop is a loud failure.
  if (d.readPolicy) {
    const inner = d.readPolicy
    let reads = 0
    d.readPolicy = async (key) => {
      if (++reads > 200) throw new Error('polled without a bound')
      return inner(key)
    }
  }
  return { d, http, pay, preflight, readPolicy }
}

describe('update_policy', () => {
  describe('the paid flow', () => {
    it('reads the policy, checks the draft against ITS template, pays once, collects, and reports the update', async () => {
      const { d, http, pay, preflight } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('written')
      expect(r.paid).toBe(true)
      expect(r.message).toMatch(/updated/i)
      expect(pay).toHaveBeenCalledTimes(1)
      // typed against the template the policy already references, not one the caller names
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ templateId: TEMPLATE_ID, policyKey: 'native-v1' }))
      expect(http.calls.map((c) => c.url)).toEqual([`${BASE}/pay/policy/update`, `${BASE}/pay/policy/update`, `${BASE}/pay/policy/update/collect`])
    })

    it('sends the update the server expects: the owner, the replacement, the validity and expectedUpdatedAtBlock, and nothing else', async () => {
      const { d, http } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      await updatePolicy(d, UPDATE)

      const body = JSON.parse(http.calls[0].body)
      expect(body).toEqual({
        ownerAddress: OWNER,
        policyKey: 'native-v1',
        attributes: UPDATE.attributes,
        validFromBlock: '10',
        validToBlock: '99',
        expectedUpdatedAtBlock: '12345',
      })
    })

    it('bookmarks the receipt as an UPDATE, and drops it once the update is written', async () => {
      const { d } = deps([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'SETTLING' } }])

      await updatePolicy(d, { ...UPDATE, pollBudgetMs: 1 })

      expect((await d.receipts.list()).map((x) => [x.blobId, x.operation])).toEqual([['blob-1', 'UPDATE']])

      const done = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])
      await updatePolicy(done.d, UPDATE)
      expect(await done.d.receipts.list()).toEqual([])
    })

    it('passes the payment through the wallet\'s capped payer, the one every paying tool uses', async () => {
      const { d, pay } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      await updatePolicy(d, UPDATE)

      expect(pay).toHaveBeenCalledWith(CHALLENGE.accepts[0])
    })
  })

  describe('the validity window is never silently stripped', () => {
    it('carries the current bounds forward when the caller names none, and says so', async () => {
      const { d, http, preflight } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      const r = await updatePolicy(d, UPDATE)

      const body = JSON.parse(http.calls[0].body)
      expect([body.validFromBlock, body.validToBlock]).toEqual(['10', '99'])
      expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ validFromBlock: '10', validToBlock: '99' }))
      expect(r.interpretation?.join(' ')).toMatch(/validity window.*kept/i)
    })

    it('uses the bounds the caller gives instead', async () => {
      const { d, http } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      await updatePolicy(d, { ...UPDATE, validFromBlock: '20', validToBlock: '0' })

      const body = JSON.parse(http.calls[0].body)
      expect([body.validFromBlock, body.validToBlock]).toEqual(['20', '0'])
    })
  })

  describe('what is refused before anything reaches the service, free', () => {
    it.each([
      ['the policy does not exist', () => ({ readPolicy: vi.fn(async () => ({ found: false as const })) }), 'not_found'],
      ['it changed since the caller read it', () => ({ readPolicy: vi.fn(async () => onChain({ updatedAtBlock: 99999 })) }), 'modified'],
    ])('answers %s with %s, says nothing was paid, and never contacts the service', async (_label, over, state) => {
      const { d, http, pay } = deps([{ status: 402, body: CHALLENGE }], over() as Partial<WritePolicyDeps>)

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe(state)
      expect(r.message).toMatch(/Nothing was paid/)
      expect(http.calls).toHaveLength(0)
      expect(pay).not.toHaveBeenCalled()
    })

    it('tells the caller what the chain holds now when the policy has changed', async () => {
      const { d } = deps([], { readPolicy: vi.fn(async () => onChain({ updatedAtBlock: 99999 })) })

      const r = await updatePolicy(d, UPDATE)

      expect(r.message).toContain('99999')
      expect(r.message).toMatch(/get_my_policy/)
    })

    it('cannot update a policy it cannot read, and says nothing was paid', async () => {
      const { d, http } = deps([], { readPolicy: vi.fn(async () => ({ error: 'query_failed' as const, detail: 'node down' })) })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('unavailable')
      expect(r.message).toMatch(/node down/)
      expect(r.message).toMatch(/Nothing was paid/)
      expect(http.calls).toHaveLength(0)
    })

    it('fails closed when no way to read the policy is wired', async () => {
      const { d, http } = deps([], { readPolicy: undefined })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('unavailable')
      expect(http.calls).toHaveLength(0)
    })

    it('refuses a policy that references a template contract this wallet does not trust', async () => {
      const { d, http } = deps([], { readPolicy: vi.fn(async () => onChain({ templateContractAddress: 'ZTX3SomeoneElse' })) })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('refused')
      expect(r.message).toMatch(/template contract/)
      expect(r.message).toMatch(/Nothing was paid/)
      expect(http.calls).toHaveLength(0)
    })

    it('refuses a policy with no template, which cannot be checked against one', async () => {
      const { d, http } = deps([], { readPolicy: vi.fn(async () => onChain({ templateId: undefined, templateContractAddress: undefined })) })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('refused')
      expect(r.message).toMatch(/no template/i)
      expect(http.calls).toHaveLength(0)
    })

    it('refuses what preflight refuses, with every blocker, before the service is contacted', async () => {
      const { d, http, pay } = deps([{ status: 402, body: CHALLENGE }])
      ;(d.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({ ready: false, policyKey: 'native-v1', blockers: ['empty list denies everyone'], interpretation: [], notChecked: [] })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('refused')
      expect(r.blockers).toEqual(['empty list denies everyone'])
      expect(r.message).toMatch(/NOTHING WAS PAID/)
      expect(http.calls).toHaveLength(0)
      expect(pay).not.toHaveBeenCalled()
    })

    it('uses the amounts preflight converted, as write_policy does', async () => {
      const { d, http } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])
      ;(d.preflight as ReturnType<typeof vi.fn>).mockResolvedValue({
        ready: true, policyKey: 'native-v1', blockers: [], interpretation: [], notChecked: [], convertedAmounts: { cumulativeMax: '1500000' },
      })

      await updatePolicy(d, { ...UPDATE, attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '1.5' }], amountUnit: 'whole' })

      expect(JSON.parse(http.calls[0].body).attributes[0].value).toBe('1500000')
    })

    it.each([
      ['no policyKey', { policyKey: '' }],
      ['no attributes', { attributes: [] }],
      ['no expectedUpdatedAtBlock', { expectedUpdatedAtBlock: undefined }],
      ['an expectedUpdatedAtBlock that is not a block number', { expectedUpdatedAtBlock: 'latest' }],
    ])('asks for what is missing when there is %s, without reading or contacting anything', async (_label, over) => {
      const { d, http, readPolicy } = deps([])

      const r = await updatePolicy(d, { ...UPDATE, ...(over as object) } as never)

      expect(r.state).toBe('unavailable')
      expect(readPolicy).not.toHaveBeenCalled()
      expect(http.calls).toHaveLength(0)
    })

    it('accepts a block number given as a number, since the chain hands it back as one', async () => {
      const { d, http } = deps([{ status: 402, body: CHALLENGE }, PAID, WRITTEN])

      const r = await updatePolicy(d, { ...UPDATE, expectedUpdatedAtBlock: 12345 as never })

      expect(r.state).toBe('written')
      expect(JSON.parse(http.calls[0].body).expectedUpdatedAtBlock).toBe('12345')
    })
  })

  describe('what the service refuses in its own free pre-check', () => {
    it.each([
      ['POLICY_KEY_NOT_FOUND', 404, 461505, 'not_found'],
      ['POLICY_MODIFIED', 409, 461503, 'modified'],
      ['POLICY_TEMPLATE_NOT_FOUND', 404, 461512, 'template_unavailable'],
    ])('reports %s as %s, says nothing was paid, and does not pay', async (_name, status, errorCode, state) => {
      const { d, pay, http } = deps([{ status, body: failure(errorCode, 'server words') }])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe(state)
      expect(r.message).toMatch(/Nothing was paid/)
      expect(r.message).toContain('server words')
      expect(pay).not.toHaveBeenCalled()
      expect(http.calls).toHaveLength(1)
    })

    it('reports a type mismatch as a refusal, free', async () => {
      const { d, pay } = deps([{ status: 400, body: failure(461530, 'type does not match') }])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('refused')
      expect(r.message).toMatch(/Nothing was paid/)
      expect(pay).not.toHaveBeenCalled()
    })

    it('reports a write still in progress as a refusal that points at the receipt, and does not pay', async () => {
      const { d, pay } = deps([{ status: 409, body: failure(461529, 'in progress') }])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('refused')
      expect(r.message).toMatch(/check_policy_write/)
      expect(pay).not.toHaveBeenCalled()
    })

    it('reports an unreachable service as unavailable, free', async () => {
      const failing: HttpSend = async () => { throw new Error('boom') }
      const { d, pay } = deps([], { client: new PolicyWriteClient(BASE, failing) })

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('unavailable')
      expect(r.message).toMatch(/Nothing was paid/)
      expect(pay).not.toHaveBeenCalled()
    })
  })

  describe('a person must agree before the fee is paid', () => {
    it('stops at the price without confirm, and says what to do', async () => {
      const { d, pay } = deps([{ status: 402, body: CHALLENGE }])

      const r = await updatePolicy(d, { ...UPDATE, confirm: undefined })

      expect(r.state).toBe('quoted')
      expect(r.needsConfirmation).toBe(true)
      expect(r.paid).toBe(false)
      expect(r.message).toMatch(/update_policy again with confirm: true/)
      expect(r.message).not.toMatch(/write_policy/)
      expect(pay).not.toHaveBeenCalled()
    })

    it('stops at the price on a dry run, even with confirm', async () => {
      const { d, pay } = deps([{ status: 402, body: CHALLENGE }])

      const r = await updatePolicy(d, { ...UPDATE, dryRun: true })

      expect(r.state).toBe('quoted')
      expect(pay).not.toHaveBeenCalled()
    })

    it.each([['true'], [1], ['yes']])('does not treat confirm %j as a yes', async (confirm) => {
      const { d, pay } = deps([{ status: 402, body: CHALLENGE }])

      const r = await updatePolicy(d, { ...UPDATE, confirm: confirm as never })

      expect(r.state).toBe('quoted')
      expect(pay).not.toHaveBeenCalled()
    })
  })

  describe('a write that was already paid for', () => {
    const inFlight = (operation: string) => ({ status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-7', operation, detail: 'a paid write is waiting' } })

    it('collects the receipt on the route its operation names, not the one just asked for', async () => {
      const { d, http, pay } = deps([inFlight('CREATE'), WRITTEN])
      await d.receipts.set({ blobId: 'blob-7', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' })

      const r = await updatePolicy(d, UPDATE)

      expect(r.recoveredEarlierWrite).toBe(true)
      expect(pay).not.toHaveBeenCalled()
      expect(http.calls[1].url).toBe(`${BASE}/pay/policy/adopt-template/collect`)
    })

    it('collects an earlier UPDATE on the update route', async () => {
      const { d, http } = deps([inFlight('UPDATE'), WRITTEN])
      await d.receipts.set({ blobId: 'blob-7', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z', operation: 'UPDATE' })

      await updatePolicy(d, UPDATE)

      expect(http.calls[1].url).toBe(`${BASE}/pay/policy/update/collect`)
    })

    it('does not collect a receipt this wallet does not hold without a person\'s yes, and does not save it', async () => {
      const { d, http } = deps([inFlight('UPDATE'), WRITTEN])

      const r = await updatePolicy(d, { ...UPDATE, confirm: undefined })

      expect(r.state).toBe('refused')
      expect(r.needsConfirmation).toBe(true)
      expect(r.message).toMatch(/update_policy/)
      expect(await d.receipts.list()).toEqual([])
      expect(http.calls).toHaveLength(1)
    })

    it('says this did not apply the draft just submitted', async () => {
      const { d } = deps([inFlight('UPDATE'), WRITTEN])
      await d.receipts.set({ blobId: 'blob-7', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z', operation: 'UPDATE' })

      const r = await updatePolicy(d, UPDATE)

      expect(r.message).toMatch(/did NOT apply the attributes just submitted/)
    })
  })

  describe('what is said about money and the policy', () => {
    it('reports a settlement in progress as paid, with the receipt, and the policy not yet changed', async () => {
      const { d } = deps([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'SETTLING' } }])

      const r = await updatePolicy(d, { ...UPDATE, pollBudgetMs: 1 })

      expect(r.state).toBe('settling')
      expect(r.paid).toBe(true)
      expect(r.paymentReceipt).toBe('blob-1')
      expect(r.message).toMatch(/PAYMENT MADE/)
      expect(r.message).toMatch(/has not been changed yet/)
      expect(r.message).toMatch(/Do not pay again/)
      expect(r.message).not.toMatch(/\bfailed\b/i)
    })

    it('says an update the chain rejected after payment left the policy UNCHANGED, and that whether the fee was kept is not known', async () => {
      const { d } = deps([{ status: 402, body: CHALLENGE }, PAID, { status: 502, body: { state: 'WRITE_FAILED', txHash: 'tx-9', detail: 'rejected' } }])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('write_failed')
      expect(r.message).toMatch(/UNCHANGED/)
      expect(r.message).toMatch(/A PAYMENT WAS PRESENTED/)
      expect(r.message).toMatch(/Whether the fee was kept is not known/)
      // One claim, not two: it must not also say the payment was made.
      expect(r.message).not.toMatch(/PAYMENT MADE/)
      expect(r.message).toMatch(/do not pay again/i)
      expect(await d.receipts.list()).toHaveLength(1)
    })

    it('says paying again is right, and means an update, when the receipt is void', async () => {
      const { d } = deps([{ status: 402, body: CHALLENGE }, PAID, { status: 402, body: { state: 'SETTLEMENT_FAILED', detail: 'settlement failed' } }])

      const r = await updatePolicy(d, UPDATE)

      expect(r.state).toBe('receipt_void')
      expect(r.payFresh).toBe(true)
      expect(r.message).toMatch(/Updating the policy now requires paying again/)
    })

    it('does not call a submitted transaction an updated policy', async () => {
      const { d } = deps([{ status: 402, body: CHALLENGE }, PAID, { status: 202, body: { state: 'WRITE_SUBMITTED', txHash: 'tx-2' }, headers: { 'Retry-After': '15' } }])

      const r = await updatePolicy(d, { ...UPDATE, pollBudgetMs: 1 })

      expect(r.state).toBe('submitted')
      expect(r.message).toMatch(/do not report it as updated/i)
    })
  })

  it('is unavailable without a policy write service', async () => {
    const { d } = deps([], { client: undefined })

    expect((await updatePolicy(d, UPDATE)).state).toBe('unavailable')
  })
})

describe('check_policy_write collects an update receipt on the update route', () => {
  it('uses the operation the receipt names', async () => {
    const { d, http } = deps([WRITTEN])
    await d.receipts.set({ blobId: 'blob-1', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z', operation: 'UPDATE' })

    const r = await checkPolicyWrite(d, { paymentReceipt: 'blob-1' })

    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/update/collect`)
    expect(r.state).toBe('written')
    expect(r.message).toMatch(/updated/i)
  })

  it('still collects a receipt with no operation as a create', async () => {
    const { d, http } = deps([WRITTEN])
    await d.receipts.set({ blobId: 'blob-1', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' })

    const r = await checkPolicyWrite(d, { paymentReceipt: 'blob-1' })

    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/adopt-template/collect`)
    expect(r.message).toMatch(/is on chain/)
  })
})

describe('remove_policy', () => {
  const REMOVE = { policyKey: 'native-v1', confirm: true, pollBudgetMs: 60_000 }
  const SUBMITTED = { status: 202, body: { state: 'SUBMITTED', policyKey: 'native-v1', txHash: 'tx-rm' }, headers: { 'Retry-After': '15' } }
  const gone = async () => ({ found: false as const })

  describe('nothing is sent without a person\'s yes', () => {
    it.each([['no confirm', undefined], ['"true"', 'true'], ['1', 1], ['false', false]])('stops with %s, contacting nothing and trying no password', async (_label, confirm) => {
      const { d, http } = deps([SUBMITTED])

      const r = await removePolicy(d, { policyKey: 'native-v1', confirm: confirm as never })

      expect(r.state).toBe('needs_confirmation')
      expect(http.calls).toHaveLength(0)
    })

    it('says plainly what removing does: the limits go, and spends of that asset are then signed without a limit', async () => {
      const { d } = deps([])

      const r = await removePolicy(d, { policyKey: 'native-v1' })

      expect(r.message).toMatch(/removes? (every|the) limit/i)
      expect(r.message).toMatch(/without (any )?limit/i)
      expect(r.message).toMatch(/confirm: true/)
      expect(r.message).toMatch(/Never pass confirm on your own judgement/)
    })

    it('shows what is about to be removed, when the policy can be read', async () => {
      const { d } = deps([])

      const r = await removePolicy(d, { policyKey: 'native-v1' })

      expect(JSON.stringify(r)).toContain('cumulativeMax')
      expect(JSON.stringify(r)).toContain('100000000')
    })

    it('answers not_found before asking for a yes, when there is nothing to remove', async () => {
      const { d, http } = deps([], { readPolicy: vi.fn(gone) })

      const r = await removePolicy(d, { policyKey: 'native-v1' })

      expect(r.state).toBe('not_found')
      expect(http.calls).toHaveLength(0)
    })

    it('still asks for a yes when the policy cannot be read just now, rather than guessing', async () => {
      const { d, http } = deps([], { readPolicy: vi.fn(async () => ({ error: 'query_failed' as const, detail: 'node down' })) })

      const r = await removePolicy(d, { policyKey: 'native-v1' })

      expect(r.state).toBe('needs_confirmation')
      expect(http.calls).toHaveLength(0)
    })
  })

  describe('a confirmed removal', () => {
    it('sends the owner, the key and the password in one call to /pay/policy/remove', async () => {
      const { d, http } = deps([SUBMITTED], { readPolicy: vi.fn(gone) })

      await removePolicy(d, REMOVE)

      expect(http.calls).toHaveLength(1)
      expect(http.calls[0].url).toBe(`${BASE}/pay/policy/remove`)
      expect(JSON.parse(http.calls[0].body)).toEqual({ ownerAddress: OWNER, policyKey: 'native-v1', ownerHsmPassword: 'hunter2' })
    })

    it('says removed only after the chain read shows the policy gone', async () => {
      const reads = [onChain(), onChain(), { found: false as const }]
      const readPolicy = vi.fn(async () => reads.shift() ?? { found: false as const })
      const { d } = deps([SUBMITTED], { readPolicy })

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('removed')
      expect(r.txHash).toBe('tx-rm')
      expect(readPolicy.mock.calls.length).toBeGreaterThanOrEqual(3)
    })

    it('does NOT say removed when the chain still shows the policy: it is submitted, and says what to do', async () => {
      const { d } = deps([SUBMITTED], { readPolicy: vi.fn(async () => onChain()), now: undefined })

      const r = await removePolicy(d, { ...REMOVE, pollBudgetMs: 1 })

      expect(r.state).toBe('submitted')
      expect(r.txHash).toBe('tx-rm')
      expect(r.message).toMatch(/not (yet )?confirmed|still (shows|exists)/i)
      expect(r.message).toMatch(/do not tell the user it is removed/i)
      expect(r.message).toMatch(/expected not to submit a second removal/)
    })

    it('does NOT say removed when the chain cannot be read, however many times it is tried', async () => {
      const { d } = deps([SUBMITTED], { readPolicy: vi.fn(async () => ({ error: 'query_failed' as const, detail: 'node down' })) })

      const r = await removePolicy(d, { ...REMOVE, pollBudgetMs: 1 })

      expect(r.state).toBe('submitted')
      expect(r.message).toMatch(/could not be read|cannot confirm/i)
    })

    it('does NOT say removed when this wallet has no way to read the chain', async () => {
      const { d } = deps([SUBMITTED], { readPolicy: undefined })

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('submitted')
      expect(r.message).toMatch(/get_my_policy/)
    })

    it('stops polling at its budget instead of looping on a policy that is still there', async () => {
      let reads = 0
      // An unbounded loop with an instant sleep never yields, so a hang would look like a pass of nothing: fail loudly instead.
      const readPolicy = vi.fn(async () => {
        if (++reads > 200) throw new Error('polled without a bound')
        return onChain()
      })
      const sleep = vi.fn(async () => undefined)
      const { d } = deps([SUBMITTED], { readPolicy, sleep })

      await removePolicy(d, { ...REMOVE, pollBudgetMs: 40_000 })

      expect(readPolicy.mock.calls.length).toBeLessThan(10)
      expect(sleep).toHaveBeenCalled()
    })
  })

  describe('what the service can answer instead', () => {
    it('reports nothing to remove as not_found', async () => {
      const { d } = deps([{ status: 404, body: failure(461505, 'No policy with this key for this owner') }])

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('not_found')
    })

    it('reports an uncollected paid update as in_progress, and says to collect it first', async () => {
      const { d } = deps([{ status: 409, body: failure(461529, 'A paid write is still in progress') }])

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('in_progress')
      expect(r.message).toMatch(/check_policy_write/)
    })

    it('reports a refusal with the server\'s words', async () => {
      const { d } = deps([{ status: 400, body: failure(461506, 'no key in the HSM registry') }])

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('refused')
      expect(r.message).toContain('no key in the HSM registry')
    })

    it('says a server error does not mean the policy is still there, and that repeating is safe', async () => {
      const { d } = deps([{ status: 500, body: failure(1, 'boom') }])

      const r = await removePolicy(d, REMOVE)

      expect(r.state).toBe('unavailable')
      expect(r.message).toMatch(/get_my_policy/)
      expect(r.message).toMatch(/expected not to submit a second removal/)
    })

    it('reports an unreachable service as unavailable', async () => {
      const failing: HttpSend = async () => { throw new Error('boom') }
      const { d } = deps([], { client: new PolicyWriteClient(BASE, failing) })

      expect((await removePolicy(d, REMOVE)).state).toBe('unavailable')
    })
  })

  it('never puts the password in a result', async () => {
    const outcomes = [
      await removePolicy(deps([SUBMITTED], { readPolicy: vi.fn(gone) }).d, REMOVE),
      await removePolicy(deps([{ status: 400, body: failure(1, 'bad') }]).d, REMOVE),
      await removePolicy(deps([]).d, { policyKey: 'native-v1' }),
    ]

    for (const r of outcomes) expect(JSON.stringify(r)).not.toContain('hunter2')
  })

  it.each([['no policyKey', { policyKey: '', confirm: true }]])('asks for the key when there is %s, contacting nothing', async (_label, input) => {
    const { d, http } = deps([])

    const r = await removePolicy(d, input as never)

    expect(r.state).toBe('unavailable')
    expect(http.calls).toHaveLength(0)
  })

  it('is unavailable without a policy write service', async () => {
    const { d } = deps([], { client: undefined })

    expect((await removePolicy(d, REMOVE)).state).toBe('unavailable')
  })
})
