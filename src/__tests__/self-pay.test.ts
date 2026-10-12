/**
 * Phase 2: a self-paid policy write. The wallet builds the Registry's `createOrUpdatePolicy` call itself, signs it through
 * Wallet BE and submits it, paying only network gas. These tests pin the call it builds byte for byte, what each way it can end is
 * called (nothing sent / may be on chain / on chain), and that the service is never contacted on this path.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import { updatePolicy, writePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import type { SelfPayDeps } from '../orchestrator/policy-gas-choice'
import {
  buildPolicyCall,
  comparable,
  comparableTyped,
  createSelfPay,
  typeAttributes,
  type SelfPayCall,
  type SelfPayChainDeps,
  type SelfPayExecResult,
} from '../orchestrator/policy-self-pay'
import type { TokenBalanceResult } from '../clients/token-balance-client'
import type { PolicyRead, PolicyReadResult } from '../clients/policy-read-client'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const REGISTRY = 'ZTX3Registry1111111111111111111111111'
const TEMPLATE_CONTRACT = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
const TEMPLATE_ID = 'a'.repeat(64)

const ztx = (raw: string): TokenBalanceResult => ({ token: 'ZTX', balance: raw, decimals: 6, display: `${Number(raw) / 1e6} ZTX` }) as TokenBalanceResult

// ── the call the wallet builds ─────────────────────────────────────────────────────────────────────
const CALL: SelfPayCall = {
  operation: 'CREATE',
  policyKey: 'native-v1',
  attributes: [
    { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
    { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: '["ZTX3A","ZTX3B"]' },
    { attributeName: 'assetScope', attributeType: 'STRING', value: 'native' },
  ],
  validFromBlock: '0',
  validToBlock: '0',
  templateContractAddress: TEMPLATE_CONTRACT,
  templateId: TEMPLATE_ID,
}

describe('typeAttributes / buildPolicyCall', () => {
  it('a scalar stays a string and a list becomes an array of strings', () => {
    const r = typeAttributes(CALL.attributes)
    expect(r).toEqual({
      ok: true,
      attributes: [
        { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
        { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: ['ZTX3A', 'ZTX3B'] },
        { attributeName: 'assetScope', attributeType: 'STRING', value: 'native' },
      ],
    })
  })

  it('builds exactly the Registry call: method, params, key order, typed values', () => {
    const r = buildPolicyCall(CALL)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.input).toBe(
      '{"method":"createOrUpdatePolicy","params":{"policyKey":"native-v1","attributes":[' +
        '{"attributeName":"cumulativeMax","attributeType":"NUMBER","value":"500000000"},' +
        '{"attributeName":"recipientAllowlist","attributeType":"ADDRESS_LIST","value":["ZTX3A","ZTX3B"]},' +
        '{"attributeName":"assetScope","attributeType":"STRING","value":"native"}],' +
        `"validFromBlock":"0","validToBlock":"0","templateContractAddress":"${TEMPLATE_CONTRACT}","templateId":"${TEMPLATE_ID}"}}`,
    )
  })

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['[]', '[]'],
  ])('an empty list (%s) is the empty array', (_l, value) => {
    const r = typeAttributes([{ attributeName: 'l', attributeType: 'STRING_LIST', value }])
    expect(r).toEqual({ ok: true, attributes: [{ attributeName: 'l', attributeType: 'STRING_LIST', value: [] }] })
  })

  it.each([
    ['not JSON', 'a,b'],
    ['an object', '{"a":1}'],
    ['a number entry', '[1,2]'],
    ['a nested array', '[["a"]]'],
    ['a bare string', '"a"'],
  ])('a list that is %s is refused', (_l, value) => {
    const r = typeAttributes([{ attributeName: 'l', attributeType: 'NUMBER_LIST', value }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('JSON array of strings')
  })

  it('an attribute with no type, or one the contract does not know, is refused rather than guessed', () => {
    for (const attributeType of [undefined, '', 'BOOLEAN', 'number', '__proto__', 'constructor']) {
      const r = typeAttributes([{ attributeName: 'a', attributeType, value: '1' }])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('attributeType')
    }
  })

  it('a repeated name, a missing name and a non-text value are refused', () => {
    expect(typeAttributes([{ attributeName: 'a', attributeType: 'STRING', value: '1' }, { attributeName: 'a', attributeType: 'STRING', value: '2' }]).ok).toBe(false)
    expect(typeAttributes([{ attributeName: '', attributeType: 'STRING', value: '1' }]).ok).toBe(false)
    expect(typeAttributes([{ attributeName: 'a', attributeType: 'STRING', value: 5 as never }]).ok).toBe(false)
  })

  it('buildPolicyCall passes the refusal on', () => {
    const r = buildPolicyCall({ ...CALL, attributes: [{ attributeName: 'a', value: '1' }] })
    expect(r.ok).toBe(false)
  })

  it('comparable: strings and finite numbers as text, string arrays as JSON, anything else is not comparable', () => {
    expect(comparable('5')).toBe('5')
    expect(comparable(5)).toBe('5')
    expect(comparable(['a', 'b'])).toBe('["a","b"]')
    expect(comparable(Number.NaN)).toBeUndefined()
    expect(comparable([1])).toBeUndefined()
    expect(comparable({})).toBeUndefined()
    expect(comparable(undefined)).toBeUndefined()
    expect(comparableTyped('5')).toBe('5')
    expect(comparableTyped(['a'])).toBe('["a"]')
  })
})

// ── the chain side ─────────────────────────────────────────────────────────────────────────────────
function chainDeps(over: Partial<SelfPayChainDeps> = {}) {
  const order: string[] = []
  const d: SelfPayChainDeps = {
    registryAddress: REGISTRY,
    ownerAddress: OWNER,
    fetchNonce: vi.fn(async () => {
      order.push('nonce')
      return '41'
    }),
    estimateFee: vi.fn(async () => {
      order.push('estimate')
      return { feeLimit: '1500000', gasPrice: '1000' }
    }),
    buildBlob: vi.fn(() => {
      order.push('build')
      return { blob: 'BLOB' }
    }),
    sign: vi.fn(async () => {
      order.push('sign')
      return { signBlob: 'SIG', publicKey: 'PUB' }
    }),
    submit: vi.fn(async () => {
      order.push('submit')
      return { hash: 'tx-1' }
    }),
    queryNativeBalance: vi.fn(async () => ztx('9000000')),
    ...over,
  }
  return { d, order }
}

/** What the balance check allowed for: a little above the 1,500,000 the fake node simulates. */
const LIMIT = { maxFeeRaw: '1800000' }

describe('createSelfPay: estimateGas', () => {
  it('asks the node to simulate the exact Registry call, from the owner, and reports the fee limit', async () => {
    const { d } = chainDeps()
    const r = await createSelfPay(d).estimateGas(CALL)
    expect(r).toEqual({ gasRaw: '1500000' })
    expect(d.fetchNonce).toHaveBeenCalledWith(OWNER)
    const built = buildPolicyCall(CALL)
    expect(d.estimateFee).toHaveBeenCalledWith({
      sourceAddress: OWNER,
      nonce: '41',
      operation: { type: 'contractInvokeByGas', data: { contractAddress: REGISTRY, input: built.ok ? built.input : '' } },
    })
  })

  it('a call that cannot be built is an error, and the node is never asked', async () => {
    const { d } = chainDeps()
    const r = await createSelfPay(d).estimateGas({ ...CALL, attributes: [{ attributeName: 'a', value: '1' }] })
    expect('error' in r).toBe(true)
    expect(d.fetchNonce).not.toHaveBeenCalled()
  })

  it('a node that refuses to simulate is an error, never a guess', async () => {
    const { d } = chainDeps({ estimateFee: vi.fn(async () => { throw new Error('contract rejected: type does not match template') }) })
    const r = await createSelfPay(d).estimateGas(CALL)
    expect(r).toMatchObject({ error: expect.stringContaining('type does not match template') })
  })

  it('a nonce that cannot be read is an error', async () => {
    const { d } = chainDeps({ fetchNonce: vi.fn(async () => { throw new Error('node down') }) })
    expect('error' in (await createSelfPay(d).estimateGas(CALL))).toBe(true)
  })

  it('exposes the native balance reader as given', async () => {
    const { d } = chainDeps()
    expect(await createSelfPay(d).queryNativeBalance()).toEqual(ztx('9000000'))
  })
})

describe('createSelfPay: execute', () => {
  it('builds, signs and submits, in that order, with what each step returned', async () => {
    const { d, order } = chainDeps()
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    // Signed with the CEILING the balance was checked against, not the simulated figure.
    expect(r).toEqual({ kind: 'submitted', txHash: 'tx-1', nonce: '41', feeLimit: '1800000' })
    expect(order).toEqual(['nonce', 'estimate', 'build', 'sign', 'submit'])
    const built = buildPolicyCall(CALL)
    expect(d.buildBlob).toHaveBeenCalledWith({
      sourceAddress: OWNER,
      nonce: '41',
      gasPrice: '1000',
      feeLimit: '1800000',
      operations: [{ type: 'contractInvokeByGas', data: { contractAddress: REGISTRY, input: built.ok ? built.input : '' } }],
    })
    expect(d.sign).toHaveBeenCalledWith('BLOB')
    expect(d.submit).toHaveBeenCalledWith({ blob: 'BLOB', signBlob: 'SIG', publicKey: 'PUB' })
  })

  it('a call that cannot be built sends nothing and touches no chain dependency', async () => {
    const { d } = chainDeps()
    const r = await createSelfPay(d).execute({ ...CALL, attributes: [{ attributeName: 'a', value: '1' }] }, LIMIT)
    expect(r.kind).toBe('rejected')
    expect(d.fetchNonce).not.toHaveBeenCalled()
    expect(d.sign).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('a node that refuses the simulation costs nothing: nothing is signed or sent', async () => {
    const { d } = chainDeps({ estimateFee: vi.fn(async () => { throw new Error('PolicyContract: attribute x value does not match') }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('would not accept') })
    expect(d.sign).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('a nonce that cannot be read sends nothing', async () => {
    const { d } = chainDeps({ fetchNonce: vi.fn(async () => { throw new Error('node down') }) })
    expect((await createSelfPay(d).execute(CALL, LIMIT)).kind).toBe('rejected')
    expect(d.sign).not.toHaveBeenCalled()
  })

  it('a blob that cannot be built sends nothing', async () => {
    const { d } = chainDeps({ buildBlob: vi.fn(() => { throw new Error('bad blob') }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('could not be built') })
    expect(d.sign).not.toHaveBeenCalled()
  })

  it('Wallet BE denying the signature is a refusal (a decision) and nothing is submitted', async () => {
    const { d } = chainDeps({ sign: vi.fn(async () => { throw Object.assign(new Error('denied by policy'), { errorCode: 1000033 }) }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r.kind).toBe('refused')
    if (r.kind === 'refused') expect(r.refusal.kind).toBe('denied')
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('Wallet BE failing to complete its check is a transient refusal, not a decision', async () => {
    const { d } = chainDeps({ sign: vi.fn(async () => { throw Object.assign(new Error('check unavailable'), { errorCode: 1000034 }) }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r.kind).toBe('refused')
    if (r.kind === 'refused') expect(r.refusal.kind).toBe('unavailable')
  })

  it('any other signing failure sends nothing', async () => {
    const { d } = chainDeps({ sign: vi.fn(async () => { throw new Error('signer down') }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'sign_failed', reason: expect.stringContaining('signer down') })
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('the node answering and refusing the submit means nothing is on chain', async () => {
    const { d } = chainDeps({ submit: vi.fn(async () => { throw Object.assign(new Error('submit rejected with errorCode 111'), { submitRejected: true }) }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('rejected the transaction') })
  })

  it('an answer that never arrives means it MAY be on chain, and the nonce is reported', async () => {
    const { d } = chainDeps({ submit: vi.fn(async () => { throw new Error('socket hang up') }) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toEqual({ kind: 'unknown', reason: 'socket hang up', nonce: '41' })
  })
})

// ── the orchestrator ───────────────────────────────────────────────────────────────────────────────
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

const A = (attributeName: string, attributeType: string, value: unknown) => ({ attributeName, attributeType, value })
const NEW_ATTRS = [{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' }]
const policyOf = (over: Record<string, unknown> = {}): PolicyRead<PolicyReadResult> =>
  ({
    found: true,
    value: {
      policy: {
        attributes: [A('cumulativeMax', 'NUMBER', '100000000')],
        validFromBlock: '0',
        validToBlock: '0',
        updatedAtBlock: 12345,
        templateContractAddress: TEMPLATE_CONTRACT,
        templateId: TEMPLATE_ID,
        ...over,
      },
    },
  }) as unknown as PolicyRead<PolicyReadResult>
const BEFORE = policyOf()
const AFTER_UPDATE = policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], updatedAtBlock: 12400 })
const AFTER_CREATE = policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], updatedAtBlock: 5 })
const NOT_FOUND = { found: false } as PolicyRead<PolicyReadResult>

/** Successive answers, the last repeated. */
function seq<T>(...answers: T[]) {
  let i = 0
  return vi.fn(async () => answers[Math.min(i++, answers.length - 1)])
}

function selfPayDeps(over: Partial<SelfPayDeps> = {}): SelfPayDeps {
  return {
    estimateGas: vi.fn(async () => ({ gasRaw: '1000000' })),
    queryNativeBalance: vi.fn(async () => ztx('5000000')),
    execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'submitted', txHash: 'tx-1', nonce: '7', feeLimit: '1000000' })),
    ...over,
  }
}

function harness(over: Partial<WritePolicyDeps> = {}) {
  const calls: string[] = []
  const http = (async (url: string) => {
    calls.push(url)
    return { ok: false, status: 500, headers: { get: () => null }, text: async () => '' }
  }) as unknown as HttpSend
  const pay = vi.fn(async () => 'X-PAYMENT-HEADER')
  const sleep = vi.fn(async () => undefined)
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient('https://x/api', http),
    receipts: memoryStore(),
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep,
    templateContract: TEMPLATE_CONTRACT,
    preflight: (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: ['a cap'], notChecked: [] })) as never,
    readPolicy: seq(NOT_FOUND),
    selfPay: selfPayDeps(),
    hasVocabularySource: true,
    ...over,
  }
  return { d, calls, pay, sleep }
}

const CREATE_IN = { policyKey: 'native-v1', attributes: NEW_ATTRS, templateId: TEMPLATE_ID, requestKey: 'r', pollBudgetMs: 60_000, gasPayer: 'self' }
const UPDATE_IN = { policyKey: 'native-v1', attributes: NEW_ATTRS, expectedUpdatedAtBlock: '12345', pollBudgetMs: 60_000, gasPayer: 'self' }

describe('write_policy with gasPayer "self"', () => {
  it('never contacts the service and never pays a fee, even with no service configured', async () => {
    const h = harness({ client: undefined, readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('written')
    expect(h.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('builds the call from what was validated: the configured template contract, the attributes as sent, "0" bounds by default', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(h.d.selfPay!.execute).toHaveBeenCalledTimes(1)
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith({
      operation: 'CREATE',
      policyKey: 'native-v1',
      attributes: NEW_ATTRS,
      validFromBlock: '0',
      validToBlock: '0',
      templateContractAddress: TEMPLATE_CONTRACT,
      templateId: TEMPLATE_ID,
    }, { maxFeeRaw: '1200000' })
  })

  it('the validity bounds the caller named go on chain as named', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], validFromBlock: '10', validToBlock: '99' })) })
    const r = await writePolicy(h.d, { ...CREATE_IN, validFromBlock: '10', validToBlock: '99', confirm: true } as never)
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith(expect.objectContaining({ validFromBlock: '10', validToBlock: '99' }), { maxFeeRaw: '1200000' })
    expect(r.state).toBe('written')
  })

  it('without confirm it quotes the gas and sends nothing', async () => {
    const h = harness()
    const r = await writePolicy(h.d, CREATE_IN as never)
    expect(r.state).toBe('quoted')
    expect(r.needsConfirmation).toBe(true)
    expect(r.paid).toBe(false)
    expect(r.gasOptions?.self).toMatchObject({ fee: 'none', status: 'enough' })
    expect(r.gasOptions).not.toHaveProperty('sponsored')
    expect(r.message).toContain('QUOTE ONLY')
    expect(r.message).toContain('gasPayer "self" and confirm: true')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a dry run quotes without asking for confirmation, and says what to do next', async () => {
    const h = harness()
    const r = await writePolicy(h.d, { ...CREATE_IN, dryRun: true, confirm: true } as never)
    expect(r.state).toBe('quoted')
    expect(r).not.toHaveProperty('needsConfirmation')
    expect(r.message).toContain('Ask again without dryRun to write it')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a dry run that cannot be afforded says to fix that first', async () => {
    const h = harness({ selfPay: selfPayDeps({ queryNativeBalance: async () => ztx('1') }) })
    const r = await writePolicy(h.d, { ...CREATE_IN, dryRun: true } as never)
    expect(r.state).toBe('quoted')
    expect(r.message).toContain('Fix that, then ask again')
    expect(r.message).toContain('could NOT pay it right now')
  })

  it('a policy that already exists is reported, free, and nothing is sent', async () => {
    const h = harness({ readPolicy: seq(BEFORE) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('already_exists')
    expect(r.message).toContain('Nothing was sent')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a chain that cannot be read means nothing is sent', async () => {
    for (const readPolicy of [seq({ error: 'query_failed', detail: 'node down' } as PolicyRead<PolicyReadResult>), vi.fn(async () => { throw new Error('boom') })]) {
      const h = harness({ readPolicy: readPolicy as never })
      const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
      expect(r.state).toBe('unavailable')
      expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
    }
  })

  it('a wallet that cannot read the chain at all will not send blind', async () => {
    const h = harness({ readPolicy: undefined })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('unavailable')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('too little ZTX, or a balance or estimate that cannot be read, is a refusal and nothing is signed', async () => {
    for (const selfPay of [
      selfPayDeps({ queryNativeBalance: async () => ztx('10') }),
      selfPayDeps({ queryNativeBalance: async () => ({ token: 'ZTX', error: 'query_failed' }) as TokenBalanceResult }),
      selfPayDeps({ estimateGas: async () => ({ error: 'node down' }) }),
    ]) {
      const h = harness({ selfPay })
      const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
      expect(r.state).toBe('refused')
      expect(r.paid).toBe(false)
      expect(r.message).toContain('NOTHING WAS SENT')
      expect(r.message).toContain('gasPayer "sponsored"')
      expect(r.gasOptions?.self).toBeDefined()
      expect(selfPay.execute).not.toHaveBeenCalled()
    }
  })

  it('self-pay not wired: refused, nothing sent', async () => {
    const h = harness({ selfPay: undefined })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('not available')
  })

  describe('how the send ended', () => {
    const ended = (result: SelfPayExecResult) => {
      const h = harness({ selfPay: selfPayDeps({ execute: vi.fn(async () => result) }) })
      return writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    }

    it('rejected: nothing sent, no gas spent', async () => {
      const r = await ended({ kind: 'rejected', reason: 'the node would not accept this write: type mismatch' })
      expect(r.state).toBe('refused')
      expect(r.paid).toBe(false)
      expect(r.message).toContain('NOTHING WAS SENT and no gas was spent')
      expect(r.message).toContain('type mismatch')
    })

    it('Wallet BE denial is a decision, flagged', async () => {
      const { PaymentPolicyError } = await import('../policy-refusal')
      const r = await ended({ kind: 'refused', refusal: new PaymentPolicyError('denied', 'over the cap') })
      expect(r.state).toBe('refused')
      expect(r.policyDenied).toBe(true)
      expect(r.paid).toBe(false)
      expect(r.message).toContain('No policy was written')
      expect(r.message).toContain('over the cap')
    })

    it('Wallet BE failing its check is transient, flagged', async () => {
      const { PaymentPolicyError } = await import('../policy-refusal')
      const r = await ended({ kind: 'refused', refusal: new PaymentPolicyError('unavailable', 'check down') })
      expect(r.state).toBe('unavailable')
      expect(r.policyCheckUnavailable).toBe(true)
    })

    it('a signing failure: nothing sent', async () => {
      const r = await ended({ kind: 'sign_failed', reason: 'signer down' })
      expect(r.state).toBe('unavailable')
      expect(r.paid).toBe(false)
      expect(r.message).toContain('NOTHING WAS SENT')
    })

    it('an answer that never came: unknown, never "written", never "send again"', async () => {
      const r = await ended({ kind: 'unknown', reason: 'socket hang up', nonce: '41' })
      expect(r.state).toBe('unknown')
      expect(r.message).toContain('MAY be on chain')
      expect(r.message).toContain('Do NOT send it again')
      expect(r.message).toContain('nonce 41')
      expect(r).not.toHaveProperty('txHash')
    })
  })

  describe('after it was submitted', () => {
    it('written only when the chain holds exactly what was sent, with the hash and no fee', async () => {
      const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
      const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
      expect(r).toMatchObject({ state: 'written', paid: true, txHash: 'tx-1' })
      expect(r.message).toContain('is on chain')
      expect(r.message).toContain('network gas only (no service fee)')
      expect(r.interpretation).toEqual(['a cap'])
    })

    it('keeps reading until the chain catches up', async () => {
      const h = harness({ readPolicy: seq(NOT_FOUND, NOT_FOUND, NOT_FOUND, AFTER_CREATE) })
      const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
      expect(r.state).toBe('written')
      expect(h.sleep).toHaveBeenCalled()
    })

    it('never says written for anything else: submitted, not a failure, do not send again', async () => {
      for (const after of [
        NOT_FOUND,
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '1')] }),
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000'), A('extra', 'STRING', 'x')] }),
        policyOf({ attributes: [A('cumulativeMax', 'STRING', '500000000')] }),
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], templateId: 'b'.repeat(64) }),
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], templateContractAddress: 'ZTX3Elsewhere' }),
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], validToBlock: '77' }),
        policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], validFromBlock: '77' }),
        { error: 'query_failed', detail: 'down' } as PolicyRead<PolicyReadResult>,
      ]) {
        const h = harness({ readPolicy: seq(NOT_FOUND, after) })
        const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
        expect(r.state).toBe('submitted')
        expect(r).toMatchObject({ paid: true, txHash: 'tx-1' })
        expect(r.message).toContain('SUBMITTED, NOT CONFIRMED EITHER WAY')
        expect(r.message).toContain('Do NOT send it again')
        expect(r.message).toContain('get_my_policy')
      }
    })

    it('a read that throws or never answers does not become "written"', async () => {
      let n = 0
      const readPolicy = vi.fn(async () => {
        if (n++ === 0) return NOT_FOUND
        throw new Error('boom')
      })
      const h = harness({ readPolicy: readPolicy as never })
      expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('submitted')
      let m = 0
      const hang = vi.fn(async () => (m++ === 0 ? NOT_FOUND : await new Promise<never>(() => undefined)))
      const h2 = harness({ readPolicy: hang as never, readTimeoutMs: 5 })
      expect((await writePolicy(h2.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('submitted')
    })

    it('is bounded: the confirming reads stop on count and on the budget', async () => {
      const readPolicy = seq(NOT_FOUND)
      const h = harness({ readPolicy })
      await writePolicy(h.d, { ...CREATE_IN, confirm: true, pollBudgetMs: 600_000 } as never)
      // 1 before sending, then 15 (the 45 s budget in 3 s steps)
      expect(readPolicy.mock.calls.length).toBe(1 + 15)
      const readShort = seq(NOT_FOUND)
      const h2 = harness({ readPolicy: readShort })
      await writePolicy(h2.d, { ...CREATE_IN, confirm: true, pollBudgetMs: 6_000 } as never)
      expect(readShort.mock.calls.length).toBe(1 + 2)
    })

    it('a list value is compared as the array the chain holds', async () => {
      const list = [{ attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: '["ZTX3A","ZTX3B"]' }]
      const ok = policyOf({ attributes: [A('recipientAllowlist', 'ADDRESS_LIST', ['ZTX3A', 'ZTX3B'])] })
      const different = policyOf({ attributes: [A('recipientAllowlist', 'ADDRESS_LIST', ['ZTX3A'])] })
      const reordered = policyOf({ attributes: [A('recipientAllowlist', 'ADDRESS_LIST', ['ZTX3B', 'ZTX3A'])] })
      for (const [after, state] of [[ok, 'written'], [different, 'submitted'], [reordered, 'submitted']] as const) {
        const h = harness({ readPolicy: seq(NOT_FOUND, after) })
        const r = await writePolicy(h.d, { ...CREATE_IN, attributes: list, confirm: true } as never)
        expect(r.state).toBe(state)
      }
    })

    it('a number the chain hands back as a number still matches its text', async () => {
      const h = harness({ readPolicy: seq(NOT_FOUND, policyOf({ attributes: [A('cumulativeMax', 'NUMBER', 500000000)] })) })
      expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
    })
  })
})

describe('update_policy with gasPayer "self"', () => {
  it('writes the whole policy: the template and bounds carried from the chain, the staleness block recorded', async () => {
    const h = harness({ readPolicy: seq(BEFORE, BEFORE, AFTER_UPDATE) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(r).toMatchObject({ state: 'written', paid: true, txHash: 'tx-1' })
    expect(r.message).toContain('was updated')
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith({
      operation: 'UPDATE',
      policyKey: 'native-v1',
      attributes: NEW_ATTRS,
      validFromBlock: '0',
      validToBlock: '0',
      templateContractAddress: TEMPLATE_CONTRACT,
      templateId: TEMPLATE_ID,
      expectedUpdatedAtBlock: '12345',
    }, { maxFeeRaw: '1200000' })
    expect(h.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('works with no service configured', async () => {
    const h = harness({ client: undefined, readPolicy: seq(BEFORE, BEFORE, AFTER_UPDATE) })
    expect((await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('written')
  })

  it('bounds the caller named replace the carried ones', async () => {
    const after = policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], updatedAtBlock: 12400, validFromBlock: '5', validToBlock: '50' })
    const h = harness({ readPolicy: seq(BEFORE, BEFORE, after) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, validFromBlock: '5', validToBlock: '50', confirm: true } as never)
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith(expect.objectContaining({ validFromBlock: '5', validToBlock: '50' }), { maxFeeRaw: '1200000' })
    expect(r.state).toBe('written')
  })

  it('a policy that changed between the first read and the send is "modified", and nothing is sent', async () => {
    const moved = policyOf({ updatedAtBlock: 12399 })
    const h = harness({ readPolicy: seq(BEFORE, moved) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(r.state).toBe('modified')
    expect(r.message).toContain('12399')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a policy that vanished between the two reads is "not_found"', async () => {
    const h = harness({ readPolicy: seq(BEFORE, NOT_FOUND) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(r.state).toBe('not_found')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('the same attributes with updatedAtBlock unchanged is not "written" (it may already have held them)', async () => {
    const same = policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], updatedAtBlock: 12345 })
    const h = harness({ readPolicy: seq(BEFORE, BEFORE, same) })
    expect((await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('submitted')
  })

  it('no updatedAtBlock on the chain is not "written"', async () => {
    const none = policyOf({ attributes: [A('cumulativeMax', 'NUMBER', '500000000')], updatedAtBlock: undefined })
    const h = harness({ readPolicy: seq(BEFORE, BEFORE, none) })
    expect((await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('submitted')
  })

  it('without confirm it quotes, and a dry run does not ask for confirmation', async () => {
    const a = harness({ readPolicy: seq(BEFORE) })
    const r = await updatePolicy(a.d, UPDATE_IN as never)
    expect(r.state).toBe('quoted')
    expect(r.needsConfirmation).toBe(true)
    expect(r.message).toContain('call update_policy again with gasPayer "self"')
    const b = harness({ readPolicy: seq(BEFORE) })
    const d = await updatePolicy(b.d, { ...UPDATE_IN, dryRun: true } as never)
    expect(d).not.toHaveProperty('needsConfirmation')
    expect(d.message).toContain('Ask again without dryRun to update it')
    expect(a.d.selfPay!.execute).not.toHaveBeenCalled()
    expect(b.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a policy that holds no validity window, with none named, is refused before anything is sent', async () => {
    const bare = policyOf({ validFromBlock: undefined, validToBlock: undefined })
    const h = harness({ readPolicy: seq(bare) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('Name both')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('when self-pay cannot be built for this update it is still the user who chooses: needs_choice with sponsored only, never a default', async () => {
    const bare = policyOf({ validFromBlock: undefined, validToBlock: undefined })
    const steps = [
      { status: 402, body: { x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }] } },
    ]
    let i = 0
    const http = (async () => {
      const step = steps[Math.min(i++, steps.length - 1)]
      return { ok: false, status: step.status, headers: { get: () => null }, text: async () => JSON.stringify(step.body) }
    }) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http), readPolicy: seq(bare) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, gasPayer: undefined, validFromBlock: undefined, confirm: true } as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions?.sponsored).toBeDefined()
    expect(r.gasOptions).not.toHaveProperty('self')
    expect(r.message).toContain('not available for this write')
    expect(h.pay).not.toHaveBeenCalled()
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a policy on another template contract is refused as before', async () => {
    const h = harness({ readPolicy: seq(policyOf({ templateContractAddress: 'ZTX3Elsewhere' })) })
    const r = await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('the template contract the chain record omits falls back to the configured one', async () => {
    const h = harness({ readPolicy: seq(policyOf({ templateContractAddress: undefined }), policyOf({ templateContractAddress: undefined }), AFTER_UPDATE) })
    await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith(expect.objectContaining({ templateContractAddress: TEMPLATE_CONTRACT }), { maxFeeRaw: '1200000' })
  })
})

// ── the wiring ─────────────────────────────────────────────────────────────────────────────────────
import { buildPolicyWriteDeps } from '../index'

describe('buildPolicyWriteDeps offers self-pay only when it can carry it out', () => {
  const build = (extra: Record<string, unknown>) =>
    buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE_CONTRACT,
      chainQuery: (async () => ({ errorCode: 0, result: { query_rets: [] } })) as never,
      queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
      caps: undefined,
      ...extra,
    } as never).policyWriteDeps!

  const { d: chain } = chainDeps()
  const { registryAddress: _r, ownerAddress: _o, ...selfPayChain } = chain

  it('with a registry and the chain seam: offered, bound to that registry and this owner', async () => {
    const deps = build({ policyRegistryAddress: REGISTRY, selfPayChain })
    expect(deps.selfPay).toBeDefined()
    await deps.selfPay!.estimateGas(CALL)
    expect(chain.estimateFee).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: OWNER, operation: expect.objectContaining({ data: expect.objectContaining({ contractAddress: REGISTRY }) }) }))
  })

  it('without a registry (no policy contracts here): not offered', () => {
    expect(build({ selfPayChain }).selfPay).toBeUndefined()
  })

  it('without the chain seam: not offered', () => {
    expect(build({ policyRegistryAddress: REGISTRY }).selfPay).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Review R1
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
import { assessSelfPay } from '../orchestrator/policy-gas-choice'
import { checkAgainstVocabulary } from '../orchestrator/policy-vocabulary-checks'
import type { VocabularyRead } from '../clients/policy-vocabulary-client'

describe('R1-M1: the fee that is signed is the fee that was checked', () => {
  it('a fresh estimate above the ceiling is refused with nothing signed', async () => {
    const { d } = chainDeps({ estimateFee: vi.fn(async () => ({ feeLimit: '1800001', gasPrice: '1000' })) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('1800001') })
    expect(d.buildBlob).not.toHaveBeenCalled()
    expect(d.sign).not.toHaveBeenCalled()
    expect(d.submit).not.toHaveBeenCalled()
  })

  it('exactly the ceiling is allowed', async () => {
    const { d } = chainDeps({ estimateFee: vi.fn(async () => ({ feeLimit: '1800000', gasPrice: '1000' })) })
    expect((await createSelfPay(d).execute(CALL, LIMIT)).kind).toBe('submitted')
  })

  it.each([
    ['a zero fee limit', { feeLimit: '0', gasPrice: '1000' }],
    ['a non-numeric fee limit', { feeLimit: 'abc', gasPrice: '1000' }],
    ['a negative fee limit', { feeLimit: '-5', gasPrice: '1000' }],
    ['a fractional fee limit', { feeLimit: '1.5', gasPrice: '1000' }],
    ['a zero gas price', { feeLimit: '1500000', gasPrice: '0' }],
    ['a missing gas price', { feeLimit: '1500000' }],
    ['a number where text is required', { feeLimit: 1500000, gasPrice: '1000' }],
  ])('%s from the node is refused with nothing signed', async (_l, fee) => {
    const { d } = chainDeps({ estimateFee: vi.fn(async () => fee as never) })
    const r = await createSelfPay(d).execute(CALL, LIMIT)
    expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('positive whole number') })
    expect(d.sign).not.toHaveBeenCalled()
  })

  it.each([[undefined], [{}], [{ maxFeeRaw: '' }], [{ maxFeeRaw: '0' }], [{ maxFeeRaw: '-1' }], [{ maxFeeRaw: 'abc' }], [{ maxFeeRaw: 1800000 }]])(
    'no usable ceiling (%j) means nothing is signed and the chain is not even asked',
    async (limit) => {
      const { d } = chainDeps()
      const r = await createSelfPay(d).execute(CALL, limit as never)
      expect(r).toMatchObject({ kind: 'rejected', reason: expect.stringContaining('ceiling') })
      expect(d.fetchNonce).not.toHaveBeenCalled()
      expect(d.sign).not.toHaveBeenCalled()
    },
  )

  it('the orchestrator hands over exactly the amount the balance was checked against', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE), selfPay: selfPayDeps({ estimateGas: async () => ({ gasRaw: '1500000' }) }) })
    await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    // 1,500,000 + a fifth.
    expect(h.d.selfPay!.execute).toHaveBeenCalledWith(expect.anything(), { maxFeeRaw: '1800000' })
  })
})

describe('assessSelfPay reads what it is handed as untrusted (R1-M1, R1-L1, R1-L2)', () => {
  const call = CALL
  const good = selfPayDeps()
  it.each([['zero', '0'], ['negative', '-4'], ['fractional', '1.5']])('a %s estimate is unknown, not enough', async (_l, gasRaw) => {
    const r = await assessSelfPay({ ...good, estimateGas: async () => ({ gasRaw }) }, call)
    expect(r.status).toBe('unknown')
    expect(r.gas.estimatedRaw).toBeUndefined()
  })

  it.each([[null], [undefined], ['x'], [42], [{}]])('an estimate of %j is unknown and never a crash', async (value) => {
    const r = await assessSelfPay({ ...good, estimateGas: async () => value as never }, call)
    expect(r.status).toBe('unknown')
    expect(r.problems.join(' ')).toContain('could not be estimated')
  })

  it.each([[null], [undefined], ['x'], [42], [{}]])('a balance of %j is unknown and never a crash', async (value) => {
    const r = await assessSelfPay({ ...good, queryNativeBalance: async () => value as never }, call)
    expect(r.status).toBe('unknown')
    expect(r.balance).toBeUndefined()
  })

  it('a balance that is not ZTX, or not in 6 decimals, is not trusted', async () => {
    for (const balance of [
      { token: 'JMYR', balance: '99999999', decimals: 6, display: '' },
      { token: 'ZTX', balance: '99999999', decimals: 8, display: '' },
      { token: 'ZTX', balance: '99999999', decimals: null, display: '' },
    ]) {
      const r = await assessSelfPay({ ...good, queryNativeBalance: async () => balance as never }, call)
      expect(r.status).toBe('unknown')
    }
  })

  it('carries the real reason an estimate failed, bounded', async () => {
    const r = await assessSelfPay({ ...good, estimateGas: async () => ({ error: 'the attribute "cumulativeMax" has no attributeType the policy contract knows' }) }, call)
    expect(r.problems.join(' ')).toContain('cumulativeMax')
    const long = await assessSelfPay({ ...good, estimateGas: async () => ({ error: 'e'.repeat(5000) }) }, call)
    expect(long.problems.join(' ').length).toBeLessThan(500)
  })

  it('says the gas is spent even if the write fails on chain', async () => {
    const r = await assessSelfPay(good, call)
    expect(r.notChecked.join(' ')).toContain('spent even if it fails on chain')
  })
})

describe('R1-L2: a refusal says why', () => {
  it('an estimate that fails with a reason shows it, and does not tell the user to top up', async () => {
    const selfPay = selfPayDeps({ estimateGas: async () => ({ error: 'the attribute "a" has no attributeType the policy contract knows' }) })
    const h = harness({ selfPay })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('has no attributeType')
    expect(r.message).not.toContain('Top up')
    expect(r.message).toContain('Fix the cause above')
    expect(selfPay.execute).not.toHaveBeenCalled()
  })

  it('a real shortfall still says to top up', async () => {
    const h = harness({ selfPay: selfPayDeps({ queryNativeBalance: async () => ztx('1') }) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.message).toContain('Top up ZTX')
  })
})

// ── M2: "sponsored" means a quote that really covers the gas ────────────────────────────────────────
describe('R1-M2: sponsored is sponsored', () => {
  const SELF_QUOTE = { scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: {} }
  const SPONSORED_QUOTE = { scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }
  const clientWith = (accepts: unknown[]) => {
    const http = (async () => ({
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => JSON.stringify({ x402Version: 1, accepts }),
    })) as unknown as HttpSend
    return new PolicyWriteClient('https://x/api', http)
  }
  const { gasPayer: _g, ...NO_CHOICE } = CREATE_IN

  it('gasPayer "sponsored" never settles for a quote that has the user paying the gas', async () => {
    const h = harness({ client: clientWith([SELF_QUOTE]), selfPay: undefined })
    const r = await writePolicy(h.d, { ...CREATE_IN, gasPayer: 'sponsored', confirm: true } as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('no sponsored payment')
    expect(r.message).toContain('NOTHING WAS PAID')
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('and picks the sponsored one when the quote offers both, whatever order they come in', async () => {
    for (const accepts of [[SELF_QUOTE, SPONSORED_QUOTE], [SPONSORED_QUOTE, SELF_QUOTE]]) {
      const h = harness({ client: clientWith(accepts), selfPay: undefined })
      const r = await writePolicy(h.d, { ...CREATE_IN, gasPayer: 'sponsored' } as never)
      expect(r.state).toBe('quoted')
      expect(r.quote?.gasModel).toBe('facilitator')
    }
  })

  it('the choice offers sponsored only from a sponsored quote, labelled from that quote', async () => {
    const h = harness({ client: clientWith([SELF_QUOTE, SPONSORED_QUOTE]), readPolicy: seq(NOT_FOUND) })
    const r = await writePolicy(h.d, NO_CHOICE as never)
    expect(r.state).toBe('needs_choice')
    expect(r.quote?.gasModel).toBe('facilitator')
    expect(r.gasOptions?.sponsored?.gas).toBe('paid by the service')
  })

  it('with no sponsored quote the choice is self alone, and says sponsored is not offered', async () => {
    const h = harness({ client: clientWith([SELF_QUOTE]), readPolicy: seq(NOT_FOUND) })
    const r = await writePolicy(h.d, NO_CHOICE as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions).not.toHaveProperty('sponsored')
    expect(r.gasOptions?.self).toBeDefined()
    expect(r.message).toContain('Only self is available')
    expect(r.message).toContain('SPONSORED: not offered')
    expect(r.message).toContain('gasPayer "self"')
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('with no sponsored quote and no way to self-pay, nothing is on offer', async () => {
    const h = harness({ client: clientWith([SELF_QUOTE]), readPolicy: seq(NOT_FOUND) })
    ;(h.d as { preflight: unknown }).preflight = (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: [], notChecked: [], vocabularyUnread: true })) as never
    const r = await writePolicy(h.d, NO_CHOICE as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Neither way of paying is available')
  })

  it("where self-pay is not on offer and no choice is named, today's behaviour is untouched (any quote)", async () => {
    const h = harness({ client: clientWith([SELF_QUOTE]), selfPay: undefined })
    const r = await writePolicy(h.d, { ...NO_CHOICE, dryRun: true } as never)
    expect(r.state).toBe('quoted')
  })
})

// ── M3: a transaction that was included and then rejected ───────────────────────────────────────────
describe('R1-M3: what became of the transaction', () => {
  const run = (lookup: SelfPayDeps['lookupTransaction'], read = seq(NOT_FOUND)) => {
    const h = harness({ readPolicy: read, selfPay: selfPayDeps(lookup ? { lookupTransaction: lookup } : {}) })
    return writePolicy(h.d, { ...CREATE_IN, confirm: true } as never).then((r) => ({ r, h }))
  }

  it('included and rejected by the contract: failed on chain, gas spent, nothing written, no "not a failure"', async () => {
    const { r } = await run(vi.fn(async () => ({ status: 'failed' as const, errorCode: 151, errorDesc: 'PolicyContract: attribute type mismatch' })))
    expect(r.state).toBe('write_failed')
    expect(r).toMatchObject({ paid: true, txHash: 'tx-1' })
    expect(r.message).toContain('FAILED ON CHAIN')
    expect(r.message).toContain('151')
    expect(r.message).toContain('attribute type mismatch')
    expect(r.message).toContain('gas was spent')
    expect(r.message).toContain('NOTHING was written')
    expect(r.message).not.toContain('not a failure')
  })

  it('a failure is not waited out: the loop stops on the first lookup that says so', async () => {
    const lookup = vi.fn(async () => ({ status: 'failed' as const, errorCode: 1 }))
    const { h } = await run(lookup)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it('succeeded but the chain does not match yet: submitted, and it says the transaction itself succeeded', async () => {
    const { r } = await run(vi.fn(async () => ({ status: 'success' as const })))
    expect(r.state).toBe('submitted')
    expect(r.message).toContain('SUCCEEDED ON CHAIN')
    expect(r.message).toContain('Do NOT send it again')
  })

  it.each([
    ['unknown', vi.fn(async () => ({ status: 'unknown' as const }))],
    ['throwing', vi.fn(async () => { throw new Error('node down') })],
    ['absent', undefined],
  ])('a lookup that is %s is "not confirmed either way", never a failure or a success', async (_l, lookup) => {
    const { r } = await run(lookup as never)
    expect(r.state).toBe('submitted')
    expect(r.message).toContain('NOT CONFIRMED EITHER WAY')
    expect(r.message).toContain('could not be read')
    expect(r.message).toContain('a failed transaction still costs the gas')
    expect(r.message).not.toContain('This is not a failure')
  })

  it('a landed write is written even when the lookup would say otherwise (the chain is the evidence)', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE), selfPay: selfPayDeps({ lookupTransaction: vi.fn(async () => ({ status: 'failed' as const, errorCode: 1 })) }) })
    expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
  })

  it("createSelfPay exposes the chain's lookup, and only when there is one", async () => {
    const getTransaction = vi.fn(async () => ({ status: 'success' as const }))
    const { d } = chainDeps({ getTransaction })
    expect(await createSelfPay(d).lookupTransaction!('h')).toEqual({ status: 'success' })
    expect(getTransaction).toHaveBeenCalledWith('h')
    expect(createSelfPay(chainDeps().d).lookupTransaction).toBeUndefined()
  })
})

// ── L4: a pending sponsored write for the same key ─────────────────────────────────────────────────
describe('R1-L4: a self-paid write does not run over a paid write that is still waiting', () => {
  const waiting = (policyKey: string): PolicyWriteReceipt => ({ blobId: 'blob-w', policyKey, ownerAddress: OWNER, paidAt: '2026-10-09T00:00:00.000Z' })

  it('is refused while a receipt for the same key is pending, and names it', async () => {
    const h = harness()
    await h.d.receipts.set(waiting('native-v1'))
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.paymentReceipt).toBe('blob-w')
    expect(r.message).toContain('check_policy_write')
    expect(r.message).toContain('NOTHING WAS SENT')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('also for an update', async () => {
    const h = harness({ readPolicy: seq(BEFORE) })
    await h.d.receipts.set(waiting('native-v1'))
    expect((await updatePolicy(h.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('refused')
  })

  it('a receipt for another key does not get in the way', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    await h.d.receipts.set(waiting('ztp20-v1'))
    expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
  })
})

// ── L5: an unreadable vocabulary ────────────────────────────────────────────────────────────────────
describe('R1-L5: a self-paid write needs the vocabulary it cannot lean on the service for', () => {
  const unread = (h: ReturnType<typeof harness>) => {
    ;(h.d as { preflight: unknown }).preflight = (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: ['a cap'], notChecked: [], vocabularyUnread: true })) as never
  }

  it('checkAgainstVocabulary flags an unavailable source, and only then', () => {
    const down: VocabularyRead = { available: false, cause: 'unreachable', detail: 'x' }
    expect(checkAgainstVocabulary([], null, down).unread).toBe(true)
    expect(checkAgainstVocabulary([], null, undefined).unread).toBeUndefined()
  })

  it('self-pay is refused, with the reason, and nothing is sent', async () => {
    const h = harness()
    unread(h)
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('vocabulary could not be read')
    expect(r.message).toContain('NOTHING WAS SENT')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
    const u = harness({ readPolicy: seq(BEFORE) })
    unread(u)
    expect((await updatePolicy(u.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('refused')
  })

  it('the choice says self is not available and why, while sponsored stays on offer', async () => {
    const http = (async () => ({
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }] }),
    })) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http) })
    unread(h)
    const { gasPayer: _g, ...noChoice } = CREATE_IN
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions?.sponsored).toBeDefined()
    expect(r.gasOptions).not.toHaveProperty('self')
    expect(r.message).toContain('SELF: not available for this write')
    expect(r.message).toContain('vocabulary could not be read')
  })
})

// ── L6: no policy service configured ───────────────────────────────────────────────────────────────
describe('R1-L6: with no policy service, self-pay is still on the table', () => {
  const { gasPayer: _g, ...noChoice } = CREATE_IN
  it('no choice named: the user is asked, with self-pay the only option', async () => {
    const h = harness({ client: undefined })
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions).not.toHaveProperty('sponsored')
    expect(r.gasOptions?.self?.status).toBe('enough')
    expect(r.message).toContain('Only self is available')
    const u = harness({ client: undefined, readPolicy: seq(BEFORE) })
    const { gasPayer: _g2, ...noChoiceU } = UPDATE_IN
    expect((await updatePolicy(u.d, noChoiceU as never)).state).toBe('needs_choice')
  })

  it('sponsored with no service is unavailable, as before', async () => {
    const h = harness({ client: undefined })
    const r = await writePolicy(h.d, { ...noChoice, gasPayer: 'sponsored' } as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('No policy write service')
  })

  it('and with no self-pay either, nothing is available', async () => {
    const h = harness({ client: undefined, selfPay: undefined })
    expect((await writePolicy(h.d, noChoice as never)).state).toBe('unavailable')
  })

  it('wiring: with no service URL nothing here can write, so no tools are built, unless a vocabulary comes from elsewhere', () => {
    const { d: chain } = chainDeps()
    const { registryAddress: _r, ownerAddress: _o, ...selfPayChain } = chain
    const build = (extra: Record<string, unknown>) =>
      buildPolicyWriteDeps({
        network: 'zetrix:testnet',
        stateDir: '/tmp/x',
        ownerAddress: OWNER,
        hsmPassword: 'p',
        pay: async () => 'header',
        gasPreference: 'sponsored',
        sleep: async () => undefined,
        policyTemplateAddress: TEMPLATE_CONTRACT,
        chainQuery: (async () => ({ errorCode: 0, result: { query_rets: [] } })) as never,
        queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
        caps: undefined,
        ...extra,
      } as never).policyWriteDeps
    // A vocabulary reader is only built from the service URL, so a registry and the chain seam alone give a wallet that can neither
    // quote a sponsored write nor check a self-paid one: no tools at all.
    expect(build({ policyRegistryAddress: REGISTRY, selfPayChain })).toBeUndefined()
    const readVocabulary = async () => ({ available: false, cause: 'unreachable', detail: 'x' }) as VocabularyRead
    const both = build({ policyRegistryAddress: REGISTRY, selfPayChain, readVocabulary })
    expect(both).toBeDefined()
    expect(both!.client).toBeUndefined()
    expect(both!.selfPay).toBeDefined()
    expect(both!.hasVocabularySource).toBe(true)
    expect(build({})).toBeUndefined()
    expect(build({ policyRegistryAddress: REGISTRY })).toBeUndefined()
    expect(build({ selfPayChain })).toBeUndefined()
  })
})

// ── L8: the gaps the review named ──────────────────────────────────────────────────────────────────
describe('R1-L8: more of what must hold', () => {
  it('chainMatchesCall: the same number of attributes under different names is not a match', async () => {
    const other = policyOf({ attributes: [A('somethingElse', 'NUMBER', '500000000')] })
    const h = harness({ readPolicy: seq(NOT_FOUND, other) })
    expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('submitted')
  })

  it('an unknown outcome submits exactly once, never again', async () => {
    const selfPay = selfPayDeps({ execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'unknown', reason: 'socket hang up', nonce: '9' })) })
    const h = harness({ selfPay })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('unknown')
    expect(selfPay.execute).toHaveBeenCalledTimes(1)
  })

  it('a repeat call after an unknown outcome reads the chain first: a write that landed is "already exists", not sent twice', async () => {
    const selfPay = selfPayDeps({ execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'unknown', reason: 'socket hang up', nonce: '9' })) })
    const first = harness({ selfPay })
    await writePolicy(first.d, { ...CREATE_IN, confirm: true } as never)
    const second = harness({ selfPay, readPolicy: seq(AFTER_CREATE) })
    const r = await writePolicy(second.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('already_exists')
    expect(selfPay.execute).toHaveBeenCalledTimes(1)
  })

  it('a transient Wallet BE refusal is neither paid nor a decision, and says to try again', async () => {
    const { PaymentPolicyError } = await import('../policy-refusal')
    const selfPay = selfPayDeps({ execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'refused', refusal: new PaymentPolicyError('unavailable', 'check down') })) })
    const r = await writePolicy(harness({ selfPay }).d, { ...CREATE_IN, confirm: true } as never)
    expect(r).toMatchObject({ state: 'unavailable', paid: false, policyCheckUnavailable: true })
    expect(r.message).toContain('trying again shortly is right')
    expect(r).not.toHaveProperty('policyDenied')
  })

  it.each([['true'], [1], ['yes'], [undefined], [false]])('confirm of %j is not a yes: it quotes and sends nothing', async (confirm) => {
    const h = harness()
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm } as never)
    expect(r.state).toBe('quoted')
    expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
  })

  it('a balance exactly equal to the required amount is enough, one less is not', async () => {
    const enough = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE), selfPay: selfPayDeps({ queryNativeBalance: async () => ztx('1200000') }) })
    expect((await writePolicy(enough.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
    const short = harness({ selfPay: selfPayDeps({ queryNativeBalance: async () => ztx('1199999') }) })
    expect((await writePolicy(short.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('refused')
  })

  it('a list that is too long, or too many attributes, is refused', () => {
    const many = Array.from({ length: 501 }, (_, i) => `"ZTX3A${i}"`).join(',')
    const r = typeAttributes([{ attributeName: 'l', attributeType: 'ADDRESS_LIST', value: `[${many}]` }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('at most 500')
    const exact = Array.from({ length: 500 }, (_, i) => `"ZTX3A${i}"`).join(',')
    expect(typeAttributes([{ attributeName: 'l', attributeType: 'ADDRESS_LIST', value: `[${exact}]` }]).ok).toBe(true)
    const attrs = Array.from({ length: 65 }, (_, i) => ({ attributeName: `a${i}`, attributeType: 'STRING', value: 'x' }))
    expect(typeAttributes(attrs).ok).toBe(false)
    expect(typeAttributes(attrs.slice(0, 64)).ok).toBe(true)
  })
})

// ── the lookup wiring ──────────────────────────────────────────────────────────────────────────────
import { buildTransactionLookup } from '../index'

describe('buildTransactionLookup', () => {
  const info = (result: unknown, errorCode = 0) => vi.fn(async () => ({ errorCode, result }) as never)

  it('error_code 0 is success', async () => {
    expect(await buildTransactionLookup(info({ transactions: [{ error_code: 0 }] }))('h')).toEqual({ status: 'success' })
  })

  it("any other code is the contract's rejection, with its description", async () => {
    expect(await buildTransactionLookup(info({ transactions: [{ error_code: 151, error_desc: 'PolicyContract: type mismatch' }] }))('h')).toEqual({
      status: 'failed',
      errorCode: 151,
      errorDesc: 'PolicyContract: type mismatch',
    })
    expect(await buildTransactionLookup(info({ transactions: [{ error_code: 7 }] }))('h')).toEqual({ status: 'failed', errorCode: 7 })
  })

  it.each([
    ['no transactions', info({ transactions: [] })],
    ['no result', info(undefined)],
    ['a code that is not a whole number', info({ transactions: [{ error_code: 'abc' }] })],
    ['no code', info({ transactions: [{}] })],
    ['the node answering an error', info({ transactions: [{ error_code: 0 }] }, 15016)],
    ['a throw', vi.fn(async () => { throw new Error('node down') })],
  ])('%s says nothing either way', async (_l, getInfo) => {
    expect(await buildTransactionLookup(getInfo as never)('h')).toEqual({ status: 'unknown' })
  })

  it('asks for the hash it was given', async () => {
    const getInfo = info({ transactions: [{ error_code: 0 }] })
    await buildTransactionLookup(getInfo)('abc123')
    expect(getInfo).toHaveBeenCalledWith('abc123')
  })
})

// ── the real preflight carries the flag (mutation testing found only the stubbed path was covered) ──
import { policyPreflight } from '../orchestrator/policy-preflight'
import { parseVocabularyBody } from '../clients/policy-vocabulary-client'
import type { TemplateRecord } from '../clients/policy-read-client'
import { NATIVE_V1 } from './fixtures/real-policy-templates'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'

describe('R1-L5: preflight itself says when the vocabulary could not be read', () => {
  const draft = {
    policyKey: 'k',
    templateId: 'a'.repeat(64),
    validFromBlock: '0',
    validToBlock: '0',
    attributes: [
      { attributeName: 'assetScope', attributeType: 'STRING', value: 'native' },
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' },
    ],
  }
  const template = { readTemplate: async () => ({ found: true, value: NATIVE_V1 as unknown as TemplateRecord }) as never }
  const real = parseVocabularyBody(REAL_VOCABULARY_BODY)

  it('an unreadable vocabulary sets vocabularyUnread on the result', async () => {
    const r = await policyPreflight({ ...template, readVocabulary: async () => ({ available: false, cause: 'unreachable', detail: 'down' }) as VocabularyRead }, draft)
    expect(r.vocabularyUnread).toBe(true)
  })

  it('a readable one, and no vocabulary source at all, do not', async () => {
    expect(await policyPreflight({ ...template, readVocabulary: async () => real }, draft)).not.toHaveProperty('vocabularyUnread')
    expect(await policyPreflight(template, draft)).not.toHaveProperty('vocabularyUnread')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Review R2
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('R2-M1: the lookup reads the SDK as it really answers (nested numbers are strings)', () => {
  const real = (code: unknown, extra: Record<string, unknown> = {}) =>
    vi.fn(async () => ({
      errorCode: 0,
      // What zetrix-sdk-nodejs 1.0.3 hands back from getTransactionHistory: every nested number a string.
      result: { total_count: '1', transactions: [{ actual_fee: '1234', error_code: code, error_desc: '', hash: 'ab12', ledger_seq: '700', ...extra }] },
    }) as never)

  it('"0" is success and "151" is the contract\'s rejection, with its description', async () => {
    expect(await buildTransactionLookup(real('0'))('ab12')).toEqual({ status: 'success' })
    expect(await buildTransactionLookup(real('151', { error_desc: 'PolicyContract: type mismatch' }))('ab12')).toEqual({
      status: 'failed',
      errorCode: 151,
      errorDesc: 'PolicyContract: type mismatch',
    })
    expect(await buildTransactionLookup(real('151'))('ab12')).toEqual({ status: 'failed', errorCode: 151 })
  })

  it('a real number is read too, in case a node or SDK version keeps it', async () => {
    expect(await buildTransactionLookup(real(0))('ab12')).toEqual({ status: 'success' })
    expect(await buildTransactionLookup(real(151))('ab12')).toEqual({ status: 'failed', errorCode: 151 })
  })

  it.each([['-1'], ['1.5'], [''], ['abc'], [' 7'], ['1234567890'], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [null], [undefined], [{}]])(
    'a code of %j says nothing either way',
    async (code) => {
      expect(await buildTransactionLookup(real(code))('ab12')).toEqual({ status: 'unknown' })
    },
  )

  it('a transaction the node names differently is not the one asked about', async () => {
    expect(await buildTransactionLookup(real('151', { hash: 'ffff' }))('ab12')).toEqual({ status: 'unknown' })
  })

  it('the hash is compared without regard to case, and a node that names none is taken at its word', async () => {
    expect(await buildTransactionLookup(real('0', { hash: 'AB12' }))('ab12')).toEqual({ status: 'success' })
    expect(await buildTransactionLookup(real('0', { hash: undefined }))('ab12')).toEqual({ status: 'success' })
  })

  it('end to end: a transaction the contract rejected, answered as the SDK does, is write_failed with its code', async () => {
    const lookup = buildTransactionLookup(real('151', { error_desc: 'PolicyContract: type mismatch', hash: 'tx-1' }))
    const h = harness({ readPolicy: seq(NOT_FOUND), selfPay: selfPayDeps({ lookupTransaction: lookup }) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('write_failed')
    expect(r.message).toContain('151')
    expect(r.message).toContain('type mismatch')
  })
})

describe('R2-L1: only a receipt that can still write holds a self-paid write back', () => {
  const receipt = (over: Partial<PolicyWriteReceipt> = {}): PolicyWriteReceipt => ({
    blobId: 'blob-w',
    policyKey: 'native-v1',
    ownerAddress: OWNER,
    paidAt: '2026-10-09T00:00:00.000Z',
    ...over,
  })

  it('a receipt the service said FAILED does not block, and is kept', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    await h.d.receipts.set(receipt({ failed: true }))
    expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
    expect(await h.d.receipts.get('blob-w')).not.toBeNull()
  })

  it('a receipt with an unresolved outcome still blocks', async () => {
    const h = harness()
    await h.d.receipts.set(receipt())
    expect((await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('refused')
  })

  it('a pending receipt blocks self in the choice as well, and says why, while sponsored stays on offer', async () => {
    const http = (async () => ({
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }] }),
    })) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http) })
    await h.d.receipts.set(receipt())
    const { gasPayer: _g, ...noChoice } = CREATE_IN
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions?.sponsored).toBeDefined()
    expect(r.gasOptions).not.toHaveProperty('self')
    expect(r.message).toContain('SELF: not available for this write')
    expect(r.message).toContain('blob-w')
  })

  it('the sponsored path marks a receipt failed when the service says so, and drops what it would verify', async () => {
    const steps = [
      { status: 402, body: { x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }] }, headers: {} as Record<string, string> },
      { status: 202, body: { state: 'PAID_PENDING', receipt: 'blob-1' }, headers: { 'X-PAYMENT-RECEIPT': 'blob-1' } as Record<string, string> },
      { status: 502, body: { state: 'WRITE_FAILED', detail: 'chain rejected', txHash: 'tx-f' }, headers: {} as Record<string, string> },
    ]
    let n = 0
    const http = (async () => {
      const st = steps[Math.min(n++, steps.length - 1)]
      return { ok: st.status < 300, status: st.status, headers: { get: (k: string) => st.headers[k] ?? null }, text: async () => JSON.stringify(st.body) }
    }) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http), selfPay: undefined, readPolicy: seq(NOT_FOUND) })
    const r = await writePolicy(h.d, { ...CREATE_IN, gasPayer: 'sponsored', confirm: true } as never)
    expect(r.state).toBe('write_failed')
    const kept = await h.d.receipts.get('blob-1')
    expect(kept).toMatchObject({ failed: true })
    expect(kept).not.toHaveProperty('verify')
  })
})

describe('R2-L2: a wallet with no vocabulary to check against does not self-pay', () => {
  it('is refused with the vocabulary reason, nothing sent', async () => {
    for (const hasVocabularySource of [false, undefined]) {
      const h = harness({ hasVocabularySource })
      const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
      expect(r.state).toBe('refused')
      expect(r.message).toContain('no attribute vocabulary configured')
      expect(h.d.selfPay!.execute).not.toHaveBeenCalled()
      const u = harness({ hasVocabularySource, readPolicy: seq(BEFORE) })
      expect((await updatePolicy(u.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('refused')
    }
  })

  it('wiring: a source is reported only when one is wired', () => {
    const build = (extra: Record<string, unknown>) =>
      buildPolicyWriteDeps({
        policyWriteUrl: 'https://ms.test/api',
        network: 'zetrix:testnet',
        stateDir: '/tmp/x',
        ownerAddress: OWNER,
        hsmPassword: 'p',
        pay: async () => 'header',
        gasPreference: 'sponsored',
        sleep: async () => undefined,
        policyTemplateAddress: TEMPLATE_CONTRACT,
        chainQuery: (async () => ({ errorCode: 0, result: { query_rets: [] } })) as never,
        queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
        caps: undefined,
        ...extra,
      } as never).policyWriteDeps!
    expect(build({}).hasVocabularySource).toBe(false)
    expect(build({ readVocabulary: async () => ({ available: false, cause: 'unreachable', detail: 'x' }) }).hasVocabularySource).toBe(true)
  })
})

describe('R2-L3: when neither way of paying is available, it says so, with both reasons', () => {
  const { gasPayer: _g, ...noChoice } = CREATE_IN
  it('no service and self blocked: unavailable, naming the self reason', async () => {
    const h = harness({ client: undefined, hasVocabularySource: false })
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Neither way of paying is available')
    expect(r.message).toContain('NOTHING WAS PAID')
    expect(r.message).toContain('no attribute vocabulary configured')
  })

  it('an update of a policy with no window and no service: neither, naming the window', async () => {
    const bare = policyOf({ validFromBlock: undefined, validToBlock: undefined })
    const h = harness({ client: undefined, readPolicy: seq(bare) })
    const { gasPayer: _g2, ...noChoiceU } = UPDATE_IN
    const r = await updatePolicy(h.d, { ...noChoiceU, validFromBlock: undefined } as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Neither way of paying is available')
    expect(r.message).toContain('validFromBlock')
  })

  it('a service that offers no sponsored quote and a self blocked for another reason: neither, with that reason', async () => {
    const http = (async () => ({ ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: {} }] }) })) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http), hasVocabularySource: false })
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Neither way of paying is available')
    expect(r.message).toContain('no attribute vocabulary configured')
  })

  it('self alone is only ever offered when "self" would be accepted', async () => {
    const h = harness({ client: undefined })
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    const again = await writePolicy(h.d, { ...noChoice, gasPayer: 'self', confirm: true } as never)
    expect(['written', 'submitted']).toContain(again.state)
  })
})

describe('R2-L4 / R2-L6: the lookup wording, and the lookup is bounded', () => {
  it('a transaction that succeeded on chain is worded as that, with no "may have failed"', async () => {
    const h = harness({ readPolicy: seq(NOT_FOUND), selfPay: selfPayDeps({ lookupTransaction: vi.fn(async () => ({ status: 'success' as const })) }) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('submitted')
    expect(r.message).toContain('SUCCEEDED ON CHAIN')
    expect(r.message).not.toContain('may have failed')
    expect(r.message).toContain('Do NOT send it again')
  })

  it('a lookup that never answers is cut off and the answer stays "not confirmed either way"', async () => {
    const hang = vi.fn(async () => await new Promise<never>(() => undefined))
    const h = harness({ readPolicy: seq(NOT_FOUND), readTimeoutMs: 5, selfPay: selfPayDeps({ lookupTransaction: hang as never }) })
    const r = await writePolicy(h.d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('submitted')
    expect(r.message).toContain('NOT CONFIRMED EITHER WAY')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Review R3
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
import { PaymentPolicyError } from '../policy-refusal'

describe('a self-paid write is offered to a wallet that already has a policy', () => {
  it('a create and an update are not held back for owning a policy contract: nothing asks the Registry about it', async () => {
    const create = harness({ readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    expect((await writePolicy(create.d, { ...CREATE_IN, confirm: true } as never)).state).toBe('written')
    const update = harness({ readPolicy: seq(BEFORE, BEFORE, AFTER_UPDATE) })
    expect((await updatePolicy(update.d, { ...UPDATE_IN, confirm: true } as never)).state).toBe('written')
  })

  it('the choice offers self again, with its gas, next to sponsored', async () => {
    const http = (async () => ({
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '50000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://x/f' } }] }),
    })) as unknown as HttpSend
    const h = harness({ client: new PolicyWriteClient('https://x/api', http), readPolicy: seq(BEFORE) })
    const { gasPayer: _g, ...noChoice } = UPDATE_IN
    const r = await updatePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    expect(r.gasOptions?.sponsored).toBeDefined()
    expect(r.gasOptions?.self).toMatchObject({ status: 'enough' })
  })

  it('wiring: no check about owning a policy contract is wired any more', () => {
    const { d: chain } = chainDeps()
    const { registryAddress: _r, ownerAddress: _o, ...selfPayChain } = chain
    const deps = buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: OWNER,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: TEMPLATE_CONTRACT,
      chainQuery: (async () => ({ errorCode: 0, result: { query_rets: [] } })) as never,
      queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
      caps: undefined,
      policyRegistryAddress: REGISTRY,
      selfPayChain,
      readVocabulary: async () => ({ available: false, cause: 'unreachable', detail: 'x' }),
    } as never).policyWriteDeps!
    expect(deps.selfPay).toBeDefined()
    expect(deps).not.toHaveProperty('ownerHasPolicyContract')
  })

  it("an older Wallet BE still refuses it: that refusal is final, not about the policy's limits, and does not invite a retry", async () => {
    const selfPay = selfPayDeps({
      execute: vi.fn(async (): Promise<SelfPayExecResult> => ({
        kind: 'refused',
        refusal: new PaymentPolicyError('denied', 'Policy denied: UNSUPPORTED_OPERATION (CONTRACT_METHOD:createOrUpdatePolicy)'),
      })),
    })
    const r = await writePolicy(harness({ selfPay }).d, { ...CREATE_IN, confirm: true } as never)
    expect(r).toMatchObject({ state: 'refused', paid: false, policyDenied: true })
    expect(r.message).toContain('UNSUPPORTED_OPERATION')
    expect(r.message).toContain('not about this policy')
    expect(r.message).toContain('retrying will not help')
    expect(r.message).toContain('older Wallet BE')
    expect(r.message).toContain('gasPayer "sponsored"')
    expect(r.message).not.toContain('Review the policy')
    expect(r.message).not.toContain('Trying again shortly')
  })

  it('and without a service the same refusal does not point at sponsored', async () => {
    const selfPay = selfPayDeps({
      execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'refused', refusal: new PaymentPolicyError('denied', 'Policy denied: UNSUPPORTED_OPERATION (X)') })),
    })
    const r = await writePolicy(harness({ selfPay, client: undefined }).d, { ...CREATE_IN, confirm: true } as never)
    expect(r.message).toContain('Sponsored is not available either')
    expect(r.message).not.toContain('Use gasPayer "sponsored"')
  })

  it('it is matched on the refusal kind as well as the text: a transient refusal that mentions it is not worded as final', async () => {
    const selfPay = selfPayDeps({
      execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'refused', refusal: new PaymentPolicyError('unavailable', 'check unavailable (UNSUPPORTED_OPERATION seen)') })),
    })
    const r = await writePolicy(harness({ selfPay }).d, { ...CREATE_IN, confirm: true } as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).not.toContain('retrying will not help')
  })

  it('an ordinary policy denial keeps its own wording', async () => {
    const selfPay = selfPayDeps({
      execute: vi.fn(async (): Promise<SelfPayExecResult> => ({ kind: 'refused', refusal: new PaymentPolicyError('denied', 'PER_TRANSACTION_MAX_EXCEEDED') })),
    })
    const r = await writePolicy(harness({ selfPay }).d, { ...CREATE_IN, confirm: true } as never)
    expect(r.message).toContain('Review the policy')
    expect(r.message).not.toContain('not about this policy')
  })
})

describe('R3-L1: the reason says what is true of the cause, and the advice fits what is available', () => {
  it('a vocabulary that could not be read just now may pass shortly; one that is not configured will not', async () => {
    const stub = (h: ReturnType<typeof harness>) => {
      ;(h.d as { preflight: unknown }).preflight = (async () => ({ ready: true, policyKey: 'native-v1', blockers: [], interpretation: [], notChecked: [], vocabularyUnread: true })) as never
    }
    const transient = harness()
    stub(transient)
    const a = await writePolicy(transient.d, { ...CREATE_IN, confirm: true } as never)
    expect(a.message).toContain('ask again shortly')
    const permanent = harness({ hasVocabularySource: false })
    const b = await writePolicy(permanent.d, { ...CREATE_IN, confirm: true } as never)
    expect(b.message).toContain('no attribute vocabulary configured')
    expect(b.message).not.toContain('ask again shortly')
    expect(b.message).not.toContain('try again shortly')
  })

  it('with no service the refusal does not send the agent to sponsored', async () => {
    const h = harness({ client: undefined, hasVocabularySource: false })
    const r = await writePolicy(h.d, { ...CREATE_IN, gasPayer: 'self', confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(r.message).toContain('Sponsored is not available either')
    expect(r.message).not.toContain('Use gasPayer "sponsored"')
    const withService = harness({ hasVocabularySource: false })
    expect((await writePolicy(withService.d, { ...CREATE_IN, gasPayer: 'self', confirm: true } as never)).message).toContain('Use gasPayer "sponsored"')
  })
})

describe('R3-L2: the "neither" answers, from every cause', () => {
  const waiting: PolicyWriteReceipt = { blobId: 'blob-w', policyKey: 'native-v1', ownerAddress: OWNER, paidAt: '2026-10-09T00:00:00.000Z' }
  const { gasPayer: _g, ...noChoice } = CREATE_IN

  it('a pending receipt with no sponsored quote: neither, naming the receipt', async () => {
    const h = harness({ client: undefined })
    await h.d.receipts.set(waiting)
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('unavailable')
    expect(r.message).toContain('Neither way of paying is available')
    expect(r.message).toContain('blob-w')
  })

  it('self alone is only offered when "self" would then be accepted, and it then is', async () => {
    const h = harness({ client: undefined, readPolicy: seq(NOT_FOUND, AFTER_CREATE) })
    const r = await writePolicy(h.d, noChoice as never)
    expect(r.state).toBe('needs_choice')
    const again = await writePolicy(h.d, { ...noChoice, gasPayer: 'self', confirm: true } as never)
    expect(again.state).toBe('written')
  })
})
