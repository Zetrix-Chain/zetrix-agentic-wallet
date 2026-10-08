/**
 * Review round 1: M1 (native policy naming a token), M2 (repeated names), M3 (amount format), L3 (wiring), L4
 * (monotonic clock), L5 (timeout, no-contract caching), and the two mutation survivors.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertWithinCapUnlessGoverned,
  buildPolicyGoverns,
  createPolicyGovernsCheck,
  ownerPoliciesGovernAsset,
} from '../policy-cap-bypass'
import { PaymentCapError } from '../payment-guard'
import type { OwnerPolicies } from '../clients/policy-read-client'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const OTHER = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'

type Attrs = Array<[string, unknown]>
const policy = (attrs: Attrs) => ({
  policyKey: 'k',
  result: {
    found: true as const,
    value: {
      policy: {
        attributes: attrs.map(([attributeName, value]) => ({ attributeName, attributeType: 'STRING', value })),
        validFromBlock: '0',
        validToBlock: '0',
      },
    },
  },
})
const owned = (policies: OwnerPolicies['policies']): OwnerPolicies => ({
  contract: { found: true, value: 'ZTX3Contract' },
  keys: { found: true, value: policies.map((p) => p.policyKey) },
  policies,
})
const JMYR_POLICY: Attrs = [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', '2000000']]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('R1-M1: a native policy that names a token is ignored for native payments by the service', () => {
  it('does not govern ZTX', () => {
    const attrs: Attrs = [['assetScope', 'native'], ['tokenAddress', JMYR], ['perTransactionMax', '5']]
    expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), 'ZTX')).toBe(false)
  })

  it('a native policy with no token still governs ZTX', () => {
    expect(ownerPoliciesGovernAsset(owned([policy([['assetScope', 'native'], ['perTransactionMax', '5']])]), 'ZTX')).toBe(true)
  })

  it('an empty tokenAddress on a native policy is still "names a token"', () => {
    const attrs: Attrs = [['assetScope', 'native'], ['tokenAddress', ''], ['perTransactionMax', '5']]
    expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), 'ZTX')).toBe(false)
  })

  it('the bypass is not borrowed by another policy: a recipient-only native policy beside it governs nothing', () => {
    const wrong: Attrs = [['assetScope', 'native'], ['tokenAddress', JMYR], ['perTransactionMax', '5']]
    const noAmount: Attrs = [['assetScope', 'native'], ['recipientDenylist', '["ZTX3x"]']]
    expect(ownerPoliciesGovernAsset(owned([policy(wrong), policy(noAmount)]), 'ZTX')).toBe(false)
  })
})

describe('R1-M2: a repeated attribute name is ambiguous, so the policy does not govern', () => {
  it.each([
    ['assetScope twice (native then ztp20)', [['assetScope', 'native'], ['perTransactionMax', '1'], ['assetScope', 'ztp20'], ['tokenAddress', JMYR]], 'ZTX'],
    ['assetScope twice, both ztp20', [['assetScope', 'ztp20'], ['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', '1']], JMYR],
    ['perTransactionMax twice', [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', '1'], ['perTransactionMax', '9']], JMYR],
    ['tokenAddress twice (same value)', [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['tokenAddress', JMYR], ['perTransactionMax', '1']], JMYR],
    ['tokenAddress twice (different)', [['assetScope', 'ztp20'], ['tokenAddress', OTHER], ['tokenAddress', JMYR], ['perTransactionMax', '1']], JMYR],
  ] as Array<[string, Attrs, string]>)('%s', (_label, attrs, asset) => {
    expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), asset)).toBe(false)
  })

  it('a missing assetScope or perTransactionMax is not "once"', () => {
    expect(ownerPoliciesGovernAsset(owned([policy([['tokenAddress', JMYR], ['perTransactionMax', '1']])]), JMYR)).toBe(false)
    expect(ownerPoliciesGovernAsset(owned([policy([['assetScope', 'ztp20'], ['tokenAddress', JMYR]])]), JMYR)).toBe(false)
  })

  it('exactly once each governs', () => {
    expect(ownerPoliciesGovernAsset(owned([policy(JMYR_POLICY)]), JMYR)).toBe(true)
  })
})

describe('R1-M3: only the cap stands aside; the amount format is still checked', () => {
  const governs = async () => true
  const caps = { [JMYR]: '1000000', '*': '0' }

  it.each(['1.5', '-1', '1e30', ' 5', '0x10', '', '5 ', 'abc'])('refuses a governed payment quoting %j', async (amount) => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: amount }, caps, governs)).rejects.toBeInstanceOf(PaymentCapError)
  })

  it('names the amount in the refusal', async () => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: '1.5' }, caps, governs)).rejects.toThrow(
      /maxAmountRequired "1\.5" is not a non-negative integer string/,
    )
  })

  it('still lets a well-formed governed amount through, however large', async () => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: '9'.repeat(40) }, caps, governs)).resolves.toBeUndefined()
  })

  it('an absent amount is treated as 0, as the cap check does', async () => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR } as never, caps, governs)).resolves.toBeUndefined()
  })

  it('the ungoverned path refuses the same malformed amounts, unchanged', async () => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: '1.5' }, caps, async () => false)).rejects.toBeInstanceOf(PaymentCapError)
  })
})

describe('mutation survivors', () => {
  it('an empty asset never governs, even against a policy whose tokenAddress is empty', () => {
    const attrs: Attrs = [['assetScope', 'ztp20'], ['tokenAddress', ''], ['perTransactionMax', '1']]
    expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), '')).toBe(false)
  })

  it('accepts a 77-digit per-transaction cap and refuses 78', () => {
    const at = (digits: number): Attrs => [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', '9'.repeat(digits)]]
    expect(ownerPoliciesGovernAsset(owned([policy(at(77))]), JMYR)).toBe(true)
    expect(ownerPoliciesGovernAsset(owned([policy(at(78))]), JMYR)).toBe(false)
  })
})

describe('R1-L3: the wiring main() uses is pinned here', () => {

  it('an explicit MAX_PAYMENT_AMOUNT is never bypassed and never reads the chain', async () => {
    const query = vi.fn() as never
    const governs = buildPolicyGoverns({ paymentCapsExplicit: true, policyRegistryAddress: REGISTRY }, OWNER, query)
    expect(await governs(JMYR)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('no registry (mainnet today) or no owner never reads the chain', async () => {
    const query = vi.fn() as never
    expect(await buildPolicyGoverns({ paymentCapsExplicit: false, policyRegistryAddress: undefined }, OWNER, query)(JMYR)).toBe(false)
    expect(await buildPolicyGoverns({ paymentCapsExplicit: false, policyRegistryAddress: REGISTRY }, undefined, query)(JMYR)).toBe(false)
    expect(query).not.toHaveBeenCalled()
  })

  it('a default-cap wallet with a registry and an owner does read the chain (and fails closed when that fails)', async () => {
    // Built here, not at describe scope: afterEach(vi.restoreAllMocks) would reset a rejection set up earlier, and the test
    // would then be proving a parse failure instead of a failed read.
    const failingQuery = vi.fn().mockRejectedValue(new Error('no chain in tests'))
    const governs = buildPolicyGoverns({ paymentCapsExplicit: false, policyRegistryAddress: REGISTRY }, OWNER, failingQuery as never)
    expect(await governs(JMYR)).toBe(false)
    expect(failingQuery).toHaveBeenCalled()
    await expect(failingQuery({})).rejects.toThrow('no chain in tests')
  })
})

describe('R1-L4: the cache uses a monotonic clock', () => {
  it('reads performance.now, not the wall clock, by default', async () => {
    const perf = vi.spyOn(performance, 'now')
    const wall = vi.spyOn(Date, 'now')
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ explicitCaps: false, registryAddress: REGISTRY, owner: OWNER, query: vi.fn() as never, read })
    await governs(JMYR)
    await governs(JMYR)
    expect(perf).toHaveBeenCalled()
    expect(wall).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('R1-L5: a hung read is "does not govern", and "no policy contract" is cached', () => {
  const base = { explicitCaps: false, registryAddress: REGISTRY, owner: OWNER, query: vi.fn() as never }

  const clock = () => {
    let t = 1_000
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('a read that never answers is false after the timeout, and a new read starts once the stuck one is old enough', async () => {
    const c = clock()
    const read = vi
      .fn<[string, string, unknown], Promise<OwnerPolicies>>()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 20, abandonedRetryMs: 60_000, now: c.now })
    expect(await governs(JMYR)).toBe(false)
    c.advance(60_001)
    expect(await governs(JMYR)).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('R2-L2: while a timed-out read still runs, no further read is started (they would pile up on a slow node)', async () => {
    const c = clock()
    const read = vi.fn<[string, string, unknown], Promise<OwnerPolicies>>().mockImplementation(() => new Promise(() => undefined))
    const governs = createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 20, abandonedRetryMs: 60_000, now: c.now })
    expect(await governs(JMYR)).toBe(false)
    c.advance(1_000)
    expect(await governs(JMYR)).toBe(false)
    expect(await governs(OTHER)).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('R2-L2: the pile-up bound is one new read per retry window, not none for ever', async () => {
    const c = clock()
    const read = vi.fn<[string, string, unknown], Promise<OwnerPolicies>>().mockImplementation(() => new Promise(() => undefined))
    const governs = createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 20, abandonedRetryMs: 60_000, now: c.now })
    await governs(JMYR)
    c.advance(60_001)
    await governs(JMYR)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('R2-M2: a stuck read that finally answers with an OLD positive cannot overwrite a newer negative', async () => {
    const c = clock()
    let resolveA: (v: OwnerPolicies) => void = () => undefined
    const read = vi
      .fn<[string, string, unknown], Promise<OwnerPolicies>>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve }))
      .mockResolvedValue(owned([]))
    const governs = createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 20, abandonedRetryMs: 60_000, ttlMs: 30_000, now: c.now })
    // A starts, sees the policy but is slow: it times out.
    expect(await governs(JMYR)).toBe(false)
    // The owner removed the policy; a later payment starts read B, which sees nothing and is cached.
    c.advance(61_000)
    expect(await governs(JMYR)).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    // A finally answers with the OLD positive.
    resolveA(owned([policy(JMYR_POLICY)]))
    await new Promise((r) => setTimeout(r, 10))
    // B's negative must still stand, and still be the cached one.
    expect(await governs(JMYR)).toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('R2-M2: the cache is stamped with when the read STARTED', async () => {
    const c = clock()
    let resolveRead: (v: OwnerPolicies) => void = () => undefined
    const read = vi.fn<[string, string, unknown], Promise<OwnerPolicies>>().mockImplementation(() => new Promise((resolve) => { resolveRead = resolve }))
    const governs = createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 5_000, ttlMs: 30_000, now: c.now })
    const pending = governs(JMYR)
    c.advance(29_000)
    resolveRead(owned([policy(JMYR_POLICY)]))
    expect(await pending).toBe(true)
    // 29 s of the 30 s window were spent waiting on the read, so one more second makes it stale.
    c.advance(1_001)
    void governs(JMYR)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('an owner with no policy contract is a complete answer and is cached, so each payment does not repeat the registry call', async () => {
    const none: OwnerPolicies = { contract: { found: false }, keys: null, policies: [] }
    const read = vi.fn(async () => none)
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await governs(JMYR)).toBe(false)
    expect(await governs(JMYR)).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('a failed contract lookup is still not cached', async () => {
    const failed: OwnerPolicies = { contract: { error: 'query_failed', detail: 'x' }, keys: null, policies: [] }
    const read = vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await governs(JMYR)).toBe(false)
    expect(await governs(JMYR)).toBe(true)
  })

  it('a fast read is not delayed by the timeout', async () => {
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    const started = Date.now()
    expect(await createPolicyGovernsCheck({ ...base, read, readTimeoutMs: 5_000 })(JMYR)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('R2-L2: a stuck read stops blocking as soon as it settles', () => {
  it('once the late answer arrives, the next payment may start a fresh read immediately, not after the retry window', async () => {
    let now = 1_000
    let resolveA: (v: OwnerPolicies) => void = () => undefined
    const read = vi
      .fn<[string, string, unknown], Promise<OwnerPolicies>>()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve }))
      .mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({
      explicitCaps: false, registryAddress: REGISTRY, owner: OWNER, query: vi.fn() as never,
      read, readTimeoutMs: 20, abandonedRetryMs: 60_000, now: () => now,
    })
    expect(await governs(JMYR)).toBe(false) // times out: stuck
    now += 1_000
    expect(await governs(JMYR)).toBe(false) // still stuck, no new read
    expect(read).toHaveBeenCalledTimes(1)
    resolveA(owned([]))
    await new Promise((r) => setTimeout(r, 10)) // the stuck read settles
    expect(await governs(JMYR)).toBe(true) // a fresh read starts straight away
    expect(read).toHaveBeenCalledTimes(2)
  })
})
