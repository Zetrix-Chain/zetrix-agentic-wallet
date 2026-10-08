/**
 * When the owner's spending policy governs an asset, the DEFAULT wallet cap for that asset stands aside.
 *
 * The rule bypasses a safety limit, so the tests are mostly about when it must NOT: an explicit cap, a policy for another
 * asset, a policy with no per-transaction cap, a bounded policy, a failed read.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  assertWithinCapUnlessGoverned,
  createPolicyGovernsCheck,
  ownerPoliciesGovernAsset,
} from '../policy-cap-bypass'
import { describePaymentCap, describePolicyGovernedCap, PaymentCapError } from '../payment-guard'
import { checkAffordability } from '../orchestrator/policy-affordability'
import { credentialPreflight, VERIFIED_AI_BIRTHCERT } from '../orchestrator/preflight'
import type { OwnerPolicies } from '../clients/policy-read-client'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const OTHER = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const REGISTRY = 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'

type Attrs = Array<[string, unknown]>
const policy = (attrs: Attrs, extra: Record<string, unknown> = {}) => ({
  policyKey: 'k',
  result: {
    found: true as const,
    value: {
      policy: {
        attributes: attrs.map(([attributeName, value]) => ({ attributeName, attributeType: 'STRING', value })),
        validFromBlock: '0',
        validToBlock: '0',
        ...extra,
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
const NATIVE_POLICY: Attrs = [['assetScope', 'native'], ['perTransactionMax', '5000000']]

describe('ownerPoliciesGovernAsset', () => {
  it('a ztp20 policy with a per-transaction cap governs exactly its own token', () => {
    const o = owned([policy(JMYR_POLICY)])
    expect(ownerPoliciesGovernAsset(o, JMYR)).toBe(true)
    expect(ownerPoliciesGovernAsset(o, OTHER)).toBe(false)
    expect(ownerPoliciesGovernAsset(o, 'ZTX')).toBe(false)
  })

  it('a native policy with a per-transaction cap governs ZTX and nothing else', () => {
    const o = owned([policy(NATIVE_POLICY)])
    expect(ownerPoliciesGovernAsset(o, 'ZTX')).toBe(true)
    expect(ownerPoliciesGovernAsset(o, JMYR)).toBe(false)
  })

  it('a policy that bounds no amount for the asset does not govern it', () => {
    for (const attrs of [
      [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['recipientDenylist', '["ZTX3x"]']],
      [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['cumulativeMax', '9000000'], ['cumulativeWindow', '30d']],
      [['assetScope', 'ztp20'], ['tokenAddress', JMYR]],
      [['recipientDenylist', '["ZTX3x"]']],
    ] as Attrs[]) {
      expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), JMYR)).toBe(false)
    }
  })

  it.each(['abc', '', '1.5', '-1', ' 5', '1e6', 5, null, undefined, '1'.repeat(78)])(
    'a per-transaction cap of %j is not a usable ceiling',
    (value) => {
      const attrs: Attrs = [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', value]]
      expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), JMYR)).toBe(false)
    },
  )

  it('accepts a per-transaction cap of zero: still a ceiling (it refuses everything)', () => {
    const attrs: Attrs = [['assetScope', 'ztp20'], ['tokenAddress', JMYR], ['perTransactionMax', '0']]
    expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), JMYR)).toBe(true)
  })

  it('a policy bounded in time never counts: it may not be in force now, and the current block is not read', () => {
    for (const extra of [{ validToBlock: '999999999' }, { validFromBlock: '5' }, { validToBlock: 7 }, { validFromBlock: 7, validToBlock: 9 }]) {
      expect(ownerPoliciesGovernAsset(owned([policy(JMYR_POLICY, extra)]), JMYR)).toBe(false)
    }
  })

  it('unbounded in every spelling counts: "0", 0, absent', () => {
    for (const extra of [{ validFromBlock: 0, validToBlock: 0 }, { validFromBlock: undefined, validToBlock: undefined }, {}]) {
      expect(ownerPoliciesGovernAsset(owned([policy(JMYR_POLICY, extra)]), JMYR)).toBe(true)
    }
  })

  it('matches the scope and the token address exactly', () => {
    for (const attrs of [
      [['assetScope', 'ZTP20'], ['tokenAddress', JMYR], ['perTransactionMax', '1']],
      [['assetScope', 'JMYR'], ['tokenAddress', JMYR], ['perTransactionMax', '1']],
      [['assetScope', 'ztp20'], ['tokenAddress', JMYR.toLowerCase()], ['perTransactionMax', '1']],
      [['assetScope', 'ztp20'], ['tokenAddress', ` ${JMYR}`], ['perTransactionMax', '1']],
      [['assetScope', 'ztp20'], ['perTransactionMax', '1']],
    ] as Attrs[]) {
      expect(ownerPoliciesGovernAsset(owned([policy(attrs)]), JMYR)).toBe(false)
    }
    expect(ownerPoliciesGovernAsset(owned([policy([['assetScope', 'NATIVE'], ['perTransactionMax', '1']])]), 'ZTX')).toBe(false)
  })

  it('an unreadable policy is skipped, and another readable one can still qualify', () => {
    const unreadable = { policyKey: 'bad', result: { error: 'query_failed' as const, detail: 'x' } }
    const missing = { policyKey: 'gone', result: { found: false as const } }
    expect(ownerPoliciesGovernAsset(owned([unreadable, missing]), JMYR)).toBe(false)
    expect(ownerPoliciesGovernAsset(owned([unreadable, policy(JMYR_POLICY), missing]), JMYR)).toBe(true)
  })

  it('no policies, an empty asset, and malformed attributes are all "does not govern"', () => {
    expect(ownerPoliciesGovernAsset(owned([]), JMYR)).toBe(false)
    expect(ownerPoliciesGovernAsset(owned([policy(JMYR_POLICY)]), '')).toBe(false)
    const weird = { policyKey: 'w', result: { found: true as const, value: { policy: { attributes: 'nope' } } } }
    expect(ownerPoliciesGovernAsset(owned([weird as never]), JMYR)).toBe(false)
    const nullEntry = { policyKey: 'n', result: { found: true as const, value: { policy: { attributes: [null] } } } }
    expect(ownerPoliciesGovernAsset(owned([nullEntry as never]), JMYR)).toBe(false)
  })
})

describe('createPolicyGovernsCheck', () => {
  const query = vi.fn() as never
  const base = { explicitCaps: false, registryAddress: REGISTRY, owner: OWNER, query }
  const clock = () => {
    let t = 1_000
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  it('is never true when the user set MAX_PAYMENT_AMOUNT, and does not even read the chain', async () => {
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    expect(await createPolicyGovernsCheck({ ...base, explicitCaps: true, read })(JMYR)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('is never true without a policy registry (mainnet today) or an owner', async () => {
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    expect(await createPolicyGovernsCheck({ ...base, registryAddress: undefined, read })(JMYR)).toBe(false)
    expect(await createPolicyGovernsCheck({ ...base, owner: undefined, read })(JMYR)).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })

  it('is true for the governed asset and false for another, from one read', async () => {
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await governs(JMYR)).toBe(true)
    expect(await governs(OTHER)).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(OWNER, REGISTRY, query)
  })

  it('reuses a good reading within the window and reads again after it', async () => {
    const c = clock()
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read, ttlMs: 30_000, now: c.now })
    await governs(JMYR)
    c.advance(29_999)
    await governs(JMYR)
    expect(read).toHaveBeenCalledTimes(1)
    c.advance(2)
    await governs(JMYR)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a removed policy stops bypassing once the reading expires', async () => {
    const c = clock()
    let policies = [policy(JMYR_POLICY)]
    const governs = createPolicyGovernsCheck({ ...base, read: async () => owned(policies), ttlMs: 30_000, now: c.now })
    expect(await governs(JMYR)).toBe(true)
    policies = []
    expect(await governs(JMYR)).toBe(true) // still the cached reading
    c.advance(30_001)
    expect(await governs(JMYR)).toBe(false)
  })

  it('a failed read is false and is NOT cached, so the next payment tries again', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('node down')).mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await governs(JMYR)).toBe(false)
    expect(await governs(JMYR)).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('an incomplete reading (contract or keys not read) is not cached either', async () => {
    const incomplete: OwnerPolicies = { contract: { error: 'query_failed', detail: 'x' }, keys: null, policies: [] }
    const read = vi.fn().mockResolvedValueOnce(incomplete).mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await governs(JMYR)).toBe(false)
    expect(await governs(JMYR)).toBe(true)
    const keysFailed: OwnerPolicies = { contract: { found: true, value: 'c' }, keys: { error: 'query_failed', detail: 'x' }, policies: [] }
    const read2 = vi.fn().mockResolvedValueOnce(keysFailed).mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs2 = createPolicyGovernsCheck({ ...base, read: read2 })
    expect(await governs2(JMYR)).toBe(false)
    expect(await governs2(JMYR)).toBe(true)
  })

  it('an owner with no policy contract (a normal state) is false', async () => {
    const none: OwnerPolicies = { contract: { found: false }, keys: null, policies: [] }
    expect(await createPolicyGovernsCheck({ ...base, read: async () => none })(JMYR)).toBe(false)
  })

  it('concurrent callers share one read', async () => {
    const read = vi.fn(async () => owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    expect(await Promise.all([governs(JMYR), governs(JMYR), governs(OTHER)])).toEqual([true, true, false])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not keep a failed read in flight forever', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(owned([policy(JMYR_POLICY)]))
    const governs = createPolicyGovernsCheck({ ...base, read })
    await governs(JMYR)
    expect(await governs(JMYR)).toBe(true)
  })
})

describe('assertWithinCapUnlessGoverned', () => {
  const caps = { [JMYR]: '1000000', '*': '0' }
  const overCap = { asset: JMYR, maxAmountRequired: '1500000' }

  it('applies the cap when the policy does not govern the asset', async () => {
    await expect(assertWithinCapUnlessGoverned(overCap, caps, async () => false)).rejects.toBeInstanceOf(PaymentCapError)
  })

  it('applies the cap when no check is wired at all', async () => {
    await expect(assertWithinCapUnlessGoverned(overCap, caps, undefined)).rejects.toBeInstanceOf(PaymentCapError)
  })

  it('stands the default cap aside when the policy governs the asset', async () => {
    await expect(assertWithinCapUnlessGoverned(overCap, caps, async () => true)).resolves.toBeUndefined()
    await expect(assertWithinCapUnlessGoverned({ asset: OTHER, maxAmountRequired: '9' }, caps, async () => true)).resolves.toBeUndefined()
  })

  it('asks about the asset being paid, and about nothing else', async () => {
    const governs = vi.fn(async () => false)
    await assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: '1' }, caps, governs)
    expect(governs).toHaveBeenCalledWith(JMYR)
    await assertWithinCapUnlessGoverned({ maxAmountRequired: '0' } as never, caps, governs).catch(() => undefined)
    expect(governs).toHaveBeenLastCalledWith('')
  })

  it('lets the cap pass a payment inside it either way', async () => {
    await expect(assertWithinCapUnlessGoverned({ asset: JMYR, maxAmountRequired: '1000000' }, caps, async () => false)).resolves.toBeUndefined()
  })
})

describe('the read-only reports agree with the enforcement', () => {
  it('describePolicyGovernedCap says the policy governs and the default cap is not applied', () => {
    expect(describePolicyGovernedCap(JMYR)).toEqual({ asset: JMYR, capRaw: null, matchedKey: 'policy', wouldPass: true })
    // ...and is not what the ordinary description says for the same asset.
    expect(describePaymentCap(JMYR, '1500000', { [JMYR]: '1000000', '*': '0' })).toMatchObject({ wouldPass: false })
  })

  it('credential preflight reports the policy, and no cap blocker, for a governed asset', async () => {
    const mk = (policyGoverns?: (a: string) => Promise<boolean>) => ({
      quoteVerified: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1500000', payTo: 'ZTX3Payee', gasModel: 'sponsored' } }),
      quoteTemplate: vi.fn(),
      queryTokenBalance: vi.fn(async (token: string) => ({ token: token === JMYR ? 'JMYR' : token, balance: '9000000', decimals: 6, display: '9' })),
      caps: { [JMYR]: '1000000', '*': '0' },
      ...(policyGoverns ? { policyGoverns } : {}),
    })
    const without = await credentialPreflight(mk() as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(without.cap?.wouldPass).toBe(false)
    expect(without.ready).toBe(false)
    const withPolicy = await credentialPreflight(mk(async () => true) as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(withPolicy.cap).toEqual({ asset: JMYR, capRaw: null, matchedKey: 'policy', wouldPass: true })
    expect(withPolicy.blockers.join(' ')).not.toMatch(/cap/i)
    const notGoverned = await credentialPreflight(mk(async () => false) as never, { credential: VERIFIED_AI_BIRTHCERT })
    expect(notGoverned.cap?.wouldPass).toBe(false)
  })

  it('write_policy affordability reports the policy, and no cap problem, for a governed asset', async () => {
    const quote = { asset: JMYR, maxAmountRequired: '1500000', payTo: 'ZTX3Payee', extra: { gasModel: 'self' } }
    const queryBalance = vi.fn(async (token: string) => ({ token, balance: '9000000', decimals: 6, display: '9' }))
    const caps = { [JMYR]: '1000000', '*': '0' }
    const without = await checkAffordability({ queryBalance, caps } as never, quote)
    expect(without.cap.wouldPass).toBe(false)
    const withPolicy = await checkAffordability({ queryBalance, caps, policyGoverns: async () => true } as never, quote)
    expect(withPolicy.cap).toEqual({ asset: JMYR, capRaw: null, matchedKey: 'policy', wouldPass: true })
    const notGoverned = await checkAffordability({ queryBalance, caps, policyGoverns: async () => false } as never, quote)
    expect(notGoverned.cap.wouldPass).toBe(false)
  })
})
