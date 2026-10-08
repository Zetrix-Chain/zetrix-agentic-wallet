/**
 * The wallet's client for the x402 policy UPDATE (paid) and REMOVE (free) routes, and the receipt
 * bookmark that now says which of the two paid writes it pays for.
 *
 * Status codes and error codes below are read from `developv2` (X402PolicyWriteController, ErrorCode): an update that
 * would fail answers 404 POLICY_KEY_NOT_FOUND, 409 POLICY_MODIFIED, 404 POLICY_TEMPLATE_NOT_FOUND or 400
 * POLICY_TEMPLATE_TYPE_MISMATCH BEFORE any charge, wrapped in the service's usual envelope
 * `{ success:false, messages:[{ type, errorCode, message }] }`.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PolicyWriteClient, type HttpSend, type UpdateRequest } from '../clients/policy-write-client'
import { createFsPolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'

const BASE = 'https://public-api-sandbox.zetrix.com/api'
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'

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

/** The service's error envelope for an ApplicationException. */
const failure = (errorCode: number, message: string) => ({
  success: false,
  messages: [{ type: 'ERROR', errorCode, message }],
})

const UPDATE: UpdateRequest = {
  ownerAddress: OWNER,
  policyKey: 'native-v1',
  attributes: [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' }],
  validFromBlock: '0',
  validToBlock: '0',
  expectedUpdatedAtBlock: '12345',
}

const CHALLENGE = { x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000' }] }

describe('PolicyWriteClient.precheckUpdate (phase 1, free)', () => {
  it('posts to /pay/policy/update, without a payment header, and quotes the 402', async () => {
    const http = send([{ status: 402, body: CHALLENGE }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'payment_required' })
    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/update`)
    expect(http.calls[0].headers['X-PAYMENT']).toBeUndefined()
    expect(JSON.parse(http.calls[0].body)).toEqual(UPDATE)
  })

  it('sends no template fields and no requestKey: the server carries the template forward and derives the key', async () => {
    const http = send([{ status: 402, body: CHALLENGE }])

    await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    const body = JSON.parse(http.calls[0].body)
    for (const field of ['templateId', 'templateContractAddress', 'requestKey', 'ownerHsmPassword']) {
      expect(field in body).toBe(false)
    }
  })

  it.each([
    ['POLICY_KEY_NOT_FOUND', 404, 461505, 'not_found'],
    ['POLICY_MODIFIED', 409, 461503, 'modified'],
    ['POLICY_TEMPLATE_NOT_FOUND', 404, 461512, 'template_unavailable'],
  ])('answers %s as %s, with the server\'s own words', async (_name, status, errorCode, kind) => {
    const http = send([{ status, body: failure(errorCode, `server says ${kind}`) }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind })
    expect((r as { detail: string }).detail).toContain(`server says ${kind}`)
  })

  it('reads a type mismatch (400) as a refusal that carries the server\'s explanation', async () => {
    const http = send([{ status: 400, body: failure(461530, 'An attribute\'s type does not match the type the template declares') }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'refused', status: 400 })
    expect((r as { detail: string }).detail).toMatch(/type does not match/)
  })

  it('hands back the receipt, and which write it pays for, when a paid write is already waiting', async () => {
    const http = send([{ status: 409, body: { state: 'ALREADY_IN_FLIGHT', receipt: 'blob-9', operation: 'CREATE', detail: 'a paid write is waiting' } }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toEqual({ kind: 'already_in_flight', blobId: 'blob-9', operation: 'CREATE', detail: 'a paid write is waiting' })
  })

  it('does not mistake POLICY_PAID_WRITE_IN_FLIGHT (no receipt) for a policy that already exists', async () => {
    const http = send([{ status: 409, body: failure(461529, 'A paid write for this policy is still in progress') }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'in_progress' })
  })

  it('never reads a 409 with an unknown code as "modified"', async () => {
    const http = send([{ status: 409, body: failure(999999, 'something else') }])

    const r = await new PolicyWriteClient(BASE, http).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'refused', status: 409 })
  })

  it('treats an unparseable 402 as unreachable, never as permission to pay', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 402, body: '<html>challenge</html>' }])).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'unreachable' })
  })

  it('treats a success status from the free pre-check as unreachable', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 200, body: {} }])).precheckUpdate(UPDATE)

    expect(r).toMatchObject({ kind: 'unreachable' })
  })

  it('reports a network failure as unreachable', async () => {
    const failing: HttpSend = async () => {
      throw new Error('boom')
    }

    expect(await new PolicyWriteClient(BASE, failing).precheckUpdate(UPDATE)).toMatchObject({ kind: 'unreachable' })
  })
})

describe('PolicyWriteClient.pay and collect on the update route', () => {
  it('presents the payment to /pay/policy/update with the X-PAYMENT header', async () => {
    const http = send([{ status: 202, body: { state: 'PAID_PENDING', receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } }])

    const r = await new PolicyWriteClient(BASE, http).pay(UPDATE, 'HEADER', 'update')

    expect(r).toMatchObject({ kind: 'paid', blobId: 'blob-1' })
    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/update`)
    expect(http.calls[0].headers['X-PAYMENT']).toBe('HEADER')
  })

  it('still presents a payment to adopt-template when no route is named, so the create flow is untouched', async () => {
    const http = send([{ status: 202, body: { receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } }])

    await new PolicyWriteClient(BASE, http).pay({ ...UPDATE } as never, 'HEADER')

    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/adopt-template`)
  })

  it('collects an UPDATE receipt at /pay/policy/update/collect and a CREATE receipt at /pay/policy/adopt-template/collect', async () => {
    const http = send([{ status: 200, body: { state: 'WRITTEN', policyKey: 'native-v1', txHash: 'tx' } }])
    const client = new PolicyWriteClient(BASE, http)

    await client.collect('blob-1', OWNER, 'pw', 'UPDATE')
    await client.collect('blob-2', OWNER, 'pw', 'CREATE')
    await client.collect('blob-3', OWNER, 'pw')

    expect(http.calls.map((c) => c.url)).toEqual([
      `${BASE}/pay/policy/update/collect`,
      `${BASE}/pay/policy/adopt-template/collect`,
      `${BASE}/pay/policy/adopt-template/collect`,
    ])
    expect(http.calls[0].headers['X-PAYMENT-RECEIPT']).toBe('blob-1')
    expect(JSON.parse(http.calls[0].body)).toEqual({ ownerAddress: OWNER, ownerHsmPassword: 'pw' })
  })
})

describe('PolicyWriteClient.remove (free, one call)', () => {
  it('posts the owner, the key and the password to /pay/policy/remove, and reports a submitted removal', async () => {
    const http = send([{ status: 202, body: { state: 'SUBMITTED', policyKey: 'native-v1', txHash: 'tx-1' }, headers: { 'Retry-After': '15' } }])

    const r = await new PolicyWriteClient(BASE, http).remove(OWNER, 'native-v1', 'hunter2')

    expect(r).toEqual({ kind: 'submitted', txHash: 'tx-1', policyKey: 'native-v1', retryAfterSeconds: 15, state: 'SUBMITTED' })
    expect(http.calls[0].url).toBe(`${BASE}/pay/policy/remove`)
    expect(http.calls[0].headers['X-PAYMENT']).toBeUndefined()
    expect(JSON.parse(http.calls[0].body)).toEqual({ ownerAddress: OWNER, policyKey: 'native-v1', ownerHsmPassword: 'hunter2' })
  })

  it('does not call a 202 "removed": the policy is gone only once the block confirms it', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 202, body: { state: 'CONFIRMED', txHash: 'tx' } }])).remove(OWNER, 'k', 'pw')

    expect(r.kind).toBe('submitted')
  })

  it('answers 404 POLICY_KEY_NOT_FOUND as not_found', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 404, body: failure(461505, 'No policy with this key for this owner') }])).remove(OWNER, 'k', 'pw')

    expect(r).toMatchObject({ kind: 'not_found' })
  })

  it('answers 409 POLICY_PAID_WRITE_IN_FLIGHT as in_progress', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 409, body: failure(461529, 'A paid write is still in progress') }])).remove(OWNER, 'k', 'pw')

    expect(r).toMatchObject({ kind: 'in_progress' })
  })

  it('reports another 4xx as a refusal with its explanation', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 400, body: failure(461506, 'The owner has no key in the HSM registry') }])).remove(OWNER, 'k', 'pw')

    expect(r).toMatchObject({ kind: 'refused', status: 400 })
    expect((r as { detail: string }).detail).toMatch(/no key in the HSM registry/)
  })

  it('reports a 5xx as a server error, with the gateway case told apart', async () => {
    const gateway = await new PolicyWriteClient(BASE, send([{ status: 502, body: '<html><body>Bad gateway</body></html>' }])).remove(OWNER, 'k', 'pw')
    const service = await new PolicyWriteClient(BASE, send([{ status: 500, body: failure(1, 'boom') }])).remove(OWNER, 'k', 'pw')

    expect(gateway).toMatchObject({ kind: 'server_error', gateway: true })
    expect(service).toMatchObject({ kind: 'server_error', gateway: false })
  })

  it('reports a network failure as unreachable', async () => {
    const failing: HttpSend = async () => {
      throw new Error('boom')
    }

    expect(await new PolicyWriteClient(BASE, failing).remove(OWNER, 'k', 'pw')).toMatchObject({ kind: 'unreachable' })
  })

  it('never lets the password into a result', async () => {
    const r = await new PolicyWriteClient(BASE, send([{ status: 400, body: failure(1, 'bad request') }])).remove(OWNER, 'k', 'hunter2')

    expect(JSON.stringify(r)).not.toContain('hunter2')
  })
})

describe('the receipt bookmark knows which write it pays for', () => {
  const base = { blobId: 'blob-1', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-07T00:00:00.000Z' }

  it('keeps an UPDATE operation across a save and a read', async () => {
    const store = createFsPolicyWriteReceiptStore(await mkdtemp(join(tmpdir(), 'receipts-')))

    await store.set({ ...base, operation: 'UPDATE' })

    expect((await store.get('blob-1'))?.operation).toBe('UPDATE')
    expect((await store.list())[0].operation).toBe('UPDATE')
  })

  it('reads a receipt written before there was an operation, as a CREATE', async () => {
    const store = createFsPolicyWriteReceiptStore(await mkdtemp(join(tmpdir(), 'receipts-')))

    await store.set(base)

    const read = await store.get('blob-1')
    expect(read).not.toBeNull()
    expect(read?.operation).toBeUndefined()
    expect((await import('../clients/policy-write-receipt-store')).operationOf(read!)).toBe('CREATE')
  })

  it('does not accept a receipt whose operation is something else', async () => {
    const store = createFsPolicyWriteReceiptStore(await mkdtemp(join(tmpdir(), 'receipts-')))
    await store.set({ ...base, operation: 'DELETE' as never })

    expect(await store.get('blob-1')).toBeNull()
  })
})
