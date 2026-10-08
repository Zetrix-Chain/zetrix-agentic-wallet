/**
 * Review round 1: M1 a native policy that names a token, M2 an attribute with neither value nor valueHuman,
 * and the LOW findings L1 to L5.
 *
 * Everything here goes through the REAL preflight (not a stub), with the real address checksum, so a refusal that only
 * happens to appear because a stub says so cannot satisfy these.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight, type PolicyPreflightDeps } from '../orchestrator/policy-preflight'
import { writePolicy, updatePolicy, type WritePolicyDeps } from '../orchestrator/write-policy'
import { PolicyWriteClient, type HttpSend } from '../clients/policy-write-client'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store'
import type { TemplateRecord } from '../clients/policy-read-client'
import { parseVocabularyBody } from '../clients/policy-vocabulary-client'
import { REAL_VOCABULARY_BODY } from './fixtures/policy-vocabulary'
import { ZTP20_V1 } from './fixtures/real-policy-templates'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://public-api-sandbox.zetrix.com/api'
const TEMPLATE_CONTRACT = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'

type Attr = { attributeName: string; attributeType: string; value?: unknown; valueHuman?: unknown }
const A = (attributeName: string, attributeType: string, value?: unknown, valueHuman?: unknown): Attr => ({
  attributeName,
  attributeType,
  ...(value !== undefined ? { value } : {}),
  ...(valueHuman !== undefined ? { valueHuman } : {}),
})

const draft = (attributes: Attr[], extra: Record<string, unknown> = {}) =>
  ({ policyKey: 'k', templateId: 'a'.repeat(64), validFromBlock: '0', validToBlock: '0', attributes, ...extra }) as never

function preflightDeps(over: Partial<PolicyPreflightDeps> = {}) {
  const describeUnit = vi.fn(async (asset: string) => (asset === 'native' ? null : { symbol: 'JMYR', decimals: 6 }))
  const deps: PolicyPreflightDeps = {
    readTemplate: async () => ({ found: true, value: ZTP20_V1 as unknown as TemplateRecord }) as never,
    isValidAddress: (a) => keypair.checkAddress(a),
    describeUnit,
    ...over,
  }
  return { deps, describeUnit }
}

const NATIVE_CAP = [A('assetScope', 'STRING', 'native'), A('perTransactionMax', 'NUMBER', undefined, '100')]

describe('M1: a native policy that names a token is not an amount of ZTX', () => {
  const nativeWithToken = [...NATIVE_CAP, A('tokenAddress', 'ADDRESS', JMYR)]

  it('refuses it, with the vocabulary unreadable, and says why', async () => {
    const { deps, describeUnit } = preflightDeps() // no readVocabulary: the offline path the review traced
    const r = await policyPreflight(deps, draft(nativeWithToken))
    expect(r.ready).toBe(false)
    const text = r.blockers.join(' ')
    expect(text).toContain('"assetScope" is "native" but a "tokenAddress" is also named')
    expect(text).toContain('would not limit ZTX at all')
    // ...and nothing was converted with ZTX decimals on the way.
    expect(r.convertedAmounts).toBeUndefined()
    expect(describeUnit).not.toHaveBeenCalledWith('native')
  })

  it('refuses it for amountUnit "whole" too (the exposure that was already there)', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([A('assetScope', 'STRING', 'native'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', '100')], { amountUnit: 'whole' }))
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('refuses it even with no amount at all, with or without the vocabulary', async () => {
    const vocabulary = parseVocabularyBody(REAL_VOCABULARY_BODY)
    for (const read of [undefined, async () => vocabulary]) {
      const { deps } = preflightDeps(read ? { readVocabulary: read as never } : {})
      const r = await policyPreflight(deps, draft([A('assetScope', 'STRING', 'native'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', '1000000')]))
      expect(r.blockers.join(' ')).toContain('"tokenAddress" is also named')
    }
  })

  it('an empty tokenAddress still counts as naming one', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([A('assetScope', 'STRING', 'native'), A('tokenAddress', 'ADDRESS', ''), A('perTransactionMax', 'NUMBER', '1000000')]))
    expect(r.blockers.join(' ')).toContain('"tokenAddress" is also named')
  })

  it('a native policy WITHOUT a token still converts with ZTX decimals', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft(NATIVE_CAP))
    expect(r.blockers.join(' ')).not.toContain('tokenAddress')
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '100000000' })
  })

  it('a ztp20 policy converts with the decimals of the token it is FOR (the mock checks which asset was read)', async () => {
    const describeUnit = vi.fn(async (asset: string) => (asset === JMYR ? { symbol: 'TWO', decimals: 2 } : { symbol: 'WRONG', decimals: 18 }))
    const { deps } = preflightDeps({ describeUnit })
    const r = await policyPreflight(deps, draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', undefined, '100')]))
    expect(describeUnit).toHaveBeenCalledWith(JMYR)
    expect(describeUnit).not.toHaveBeenCalledWith('native')
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '10000' })
  })
})

describe('M2: an attribute with neither value nor valueHuman is refused, whatever its type', () => {
  const base = [A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', '1000000')]

  it.each([
    ['unknownAttributePolicy', 'STRING'],
    ['settlementChannel', 'STRING'],
    ['cumulativeWindow', 'STRING'],
    ['maxTransactionCount', 'NUMBER'],
    ['recipientAllowlist', 'ADDRESS_LIST'],
    ['allowedMethods', 'STRING_LIST'],
  ])('%s (%s) with no value is refused, and ready is false', async (name, type) => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([...base, A(name, type)]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toContain(`"${name}" has no value: give "value"`)
  })

  it('says it once per attribute, not once from here and again from the type check', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([...base, A('maxTransactionCount', 'NUMBER')]))
    expect(r.blockers.filter((b) => b.includes('"maxTransactionCount"') && /no value/.test(b))).toHaveLength(1)
    expect(r.blockers.join(' ')).not.toContain('value "undefined"')
  })

  it('a null value is also "no value"', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([...base, A('unknownAttributePolicy', 'STRING', null)]))
    expect(r.blockers.join(' ')).toContain('"unknownAttributePolicy" has no value')
  })

  it('an attribute with a value, or with a valueHuman that converts, is untouched by this rule', async () => {
    const { deps } = preflightDeps()
    const r = await policyPreflight(deps, draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', undefined, '100'), A('unknownAttributePolicy', 'STRING', 'deny')]))
    expect(r.blockers.join(' ')).not.toContain('has no value')
  })
})

/** The write path with the REAL preflight behind it, so nothing here is a stub saying yes. */
function writeHarness() {
  const calls: string[] = []
  const http = (async (url: string) => {
    calls.push(url)
    return { ok: false, status: 402, headers: { get: () => null }, text: async () => JSON.stringify({ x402Version: 1, accepts: [{ scheme: 'exact', asset: 'ZTX3JMYR', maxAmountRequired: '1000', extra: { gasModel: 'facilitator', prepareEndpoint: 'https://f.test/prepare' } }] }) }
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
  const { deps: pf } = preflightDeps()
  const d: WritePolicyDeps = {
    client: new PolicyWriteClient(BASE, http),
    receipts,
    pay,
    chooseAccept: (accepts) => accepts[0],
    hsmPassword: 'hunter2',
    ownerAddress: OWNER,
    network: 'zetrix:testnet',
    sleep: async () => undefined,
    templateContract: TEMPLATE_CONTRACT,
    preflight: (dr) => policyPreflight(pf, dr as never),
    readPolicy: async () => ({
      found: true,
      value: { policy: { attributes: [], validFromBlock: '0', validToBlock: '0', updatedAtBlock: 1, templateContractAddress: TEMPLATE_CONTRACT, templateId: 'a'.repeat(64) } },
    }),
  }
  return { d, calls, pay }
}
const WRITE = (attributes: unknown[]) =>
  ({ policyKey: 'k', attributes, templateContractAddress: TEMPLATE_CONTRACT, templateId: 'a'.repeat(64), requestKey: 'r', pollBudgetMs: 1000, confirm: true }) as never

describe('M2 / L1 through write_policy and update_policy with the real preflight', () => {
  const scopeAndCap = [A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', '1000000')]

  it('a value-less STRING attribute stops write_policy before the service is contacted or anything is paid', async () => {
    const h = writeHarness()
    const r = await writePolicy(h.d, WRITE([...scopeAndCap, A('unknownAttributePolicy', 'STRING')]))
    expect(r.state).toBe('refused')
    expect(r.blockers?.join(' ')).toContain('"unknownAttributePolicy" has no value')
    expect(h.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('and update_policy', async () => {
    const h = writeHarness()
    const r = await updatePolicy(h.d, { policyKey: 'k', attributes: [...scopeAndCap, A('unknownAttributePolicy', 'STRING')], expectedUpdatedAtBlock: '1', confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(h.calls).toEqual([])
  })

  it.each([[null], [undefined], [5], ['text'], [[]]])('L1: an attribute entry of %j is refused cleanly by write_policy, never a raw TypeError', async (entry) => {
    const h = writeHarness()
    const r = await writePolicy(h.d, WRITE([entry, ...scopeAndCap]))
    expect(r.state).toBe('refused')
    expect(h.calls).toEqual([])
    expect(h.pay).not.toHaveBeenCalled()
  })

  it('L1: update_policy refuses the same way', async () => {
    const h = writeHarness()
    const r = await updatePolicy(h.d, { policyKey: 'k', attributes: [null, ...scopeAndCap], expectedUpdatedAtBlock: '1', confirm: true } as never)
    expect(r.state).toBe('refused')
    expect(h.calls).toEqual([])
  })

  it('a sound draft still reaches the service with its converted value on the wire', async () => {
    const h = writeHarness()
    await writePolicy(h.d, WRITE([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', undefined, '100')]))
    expect(h.calls.length).toBeGreaterThan(0)
  })
})

describe('L2: a served unit other than SMALLEST_UNIT is never scaled, whatever the built-in list says', () => {
  const served = (patch: Record<string, unknown>) => {
    const copy = JSON.parse(REAL_VOCABULARY_BODY)
    Object.assign(copy.object.attributes.find((a: { name: string }) => a.name === 'perTransactionMax'), patch)
    const parsed = parseVocabularyBody(JSON.stringify(copy))
    if (!parsed.available) throw new Error('must parse')
    return parsed
  }
  const withUnit = (patch: Record<string, unknown>) => {
    const { deps } = preflightDeps({ readVocabulary: (async () => served(patch)) as never })
    return policyPreflight(deps, draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', undefined, '100')]))
  }

  it.each([[null], ['SOMETHING_NEW']])('unit %j: refused, not converted', async (unit) => {
    const r = await withUnit({ unit })
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
    expect(r.blockers.join(' ')).toContain('not as an amount in the smallest unit')
  })

  it('unit SMALLEST_UNIT converts as before', async () => {
    const r = await withUnit({ unit: 'SMALLEST_UNIT' })
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '100000000' })
  })
})

describe('L3: a number is accepted only when JSON has not already rounded it', () => {
  const run = (valueHuman: unknown) => {
    const { deps } = preflightDeps()
    return policyPreflight(deps, draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', undefined, valueHuman)]))
  }

  it('a safe whole number is accepted', async () => {
    expect((await run(100)).convertedAmounts).toEqual({ perTransactionMax: '100000000' })
  })

  it.each([9007199254740995, 0.1 + 0.2, 0.5, -1, 1e21, NaN, Infinity])('the number %s is refused with "write it as text"', async (n) => {
    const r = await run(n)
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
    expect(r.blockers.join(' ')).toContain('write it as text')
  })

  it('the same amounts written as text are exact', async () => {
    expect((await run('0.5')).convertedAmounts).toEqual({ perTransactionMax: '500000' })
    expect((await run('9007199254740995')).convertedAmounts).toEqual({ perTransactionMax: '9007199254740995000000' })
  })
})

describe('L4: a raw value that is not text cannot slip past the agreement check', () => {
  const run = (value: unknown) => {
    const { deps } = preflightDeps()
    return policyPreflight(deps, draft([A('assetScope', 'STRING', 'ztp20'), A('tokenAddress', 'ADDRESS', JMYR), A('perTransactionMax', 'NUMBER', value, '1')]))
  }

  it.each([[1], [1000000], [{}], [[]], [true]])('value %j beside a valueHuman is refused', async (value) => {
    const r = await run(value)
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
    expect(r.blockers.join(' ')).toContain('has a value that is not text')
  })

  it('a text value that agrees, and a null or absent one, are fine; a text value that disagrees is still refused', async () => {
    expect((await run('1000000')).convertedAmounts).toEqual({ perTransactionMax: '1000000' })
    expect((await run(null)).convertedAmounts).toEqual({ perTransactionMax: '1000000' })
    expect((await run('5')).blockers.join(' ')).toContain('they do not agree')
  })
})
