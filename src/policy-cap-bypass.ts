/**
 * When the owner's spending policy governs an asset, the DEFAULT wallet cap for that asset stands aside.
 *
 * WHY. A payment has to pass the wallet's own per-payment cap and then Wallet BE's spending-policy check. For someone who
 * wrote a policy the two conflicted: a policy allowing 2 JMYR did not raise the default 1 JMYR wallet cap, so a 1.5 JMYR
 * payment was refused by the wallet before the policy was ever consulted. The decision (agreed with the reviewer) is that
 * a policy for an asset is the owner's own, more specific limit, so the default cap for that asset is not applied on top.
 *
 * WHAT COUNTS AS "THE POLICY GOVERNS THE ASSET". Deliberately narrower than "a policy exists", because bypassing the
 * wallet cap is only safe when something else bounds each payment:
 *
 *  - the policy names the asset: `assetScope` "native" for ZTX (and NO `tokenAddress`: the service says a policy that
 *    declares one "governs only that token and never native transfers", so such a policy would be ignored for ZTX), or
 *    "ztp20" with a `tokenAddress` equal to the asset;
 *  - it sets `perTransactionMax` for it (a policy that only denies certain recipients bounds no amount);
 *  - it names each of `assetScope`, `perTransactionMax` and `tokenAddress` AT MOST ONCE. Which of two copies the service
 *    takes is not knowable from here (preflight refuses repeated names for the same reason), and a policy whose scope
 *    reads one way to the wallet and another to the service must not stand the cap aside;
 *  - it is unbounded in time: `validFromBlock` and `validToBlock` both 0 or absent. A bounded policy may not be in force
 *    now, and this module cannot read the current block, so a bounded one never counts.
 *
 * FAIL CLOSED. Anything else (no registry configured, a failed read, a policy for another asset, a policy with no
 * per-transaction cap) leaves the default cap in force. A positive reading is cached briefly; a failure is never cached.
 * An EXPLICIT `MAX_PAYMENT_AMOUNT` is never bypassed: someone who set a limit means it.
 *
 * ONLY THE CAP STANDS ASIDE. The amount-format check that lives beside it does not (see `assertWithinCapUnlessGoverned`).
 *
 * KNOWN LIMITS, stated rather than hidden:
 *  - Wallet BE enforces the policy only where `policy.pep.enabled` is on (dev, test and UAT as shipped; OFF in prod). This
 *    module cannot ask Wallet BE whether it is enforcing, so on a network where it is off, a policy that governs an asset
 *    removes the only limit the wallet had for it. Agreed for mainnet and testnet alike.
 *  - A policy removed after it was read still bypasses the cap until the cache expires (30 seconds). A read that times out is
 *    never cached when it finally answers, so a late old answer cannot stretch that bound.
 *  - THE AGENT CAN WRITE THE POLICY. `write_policy` signs as the same account whose policy is read here, so an agent that
 *    can call it could write a high `perTransactionMax` and thereby lift its own cap. That is why `write_policy` pays and
 *    writes only with `confirm: true`, which the user must have given after seeing the interpretation and the price. The
 *    wallet cannot verify that a person said yes: it is the same instruction-level gate `transfer_token` relies on.
 *    The gate covers collecting a paid-for write too (a 409 "already in flight" is not collected without it, and is not saved as
 *    a receipt `check_policy_write` could collect), and `pay_and_fetch` refuses the write service's paid paths.
 */

import {
  readOwnerPolicies,
  type OwnerPolicies,
  type PolicyRecord,
} from './clients/policy-read-client.js'
import type { ContractQuery } from './clients/token-info-client.js'
import { assertValidAmount, assertWithinPaymentCap, type PaymentRequirement } from './payment-guard.js'

const NATIVE = 'ZTX'
const RAW_AMOUNT = /^\d{1,77}$/
const TIMED_OUT = Symbol('timed out')

/** Every value the policy carries under `name`, in order. A repeated name has several. */
function attributeValues(policy: PolicyRecord, name: string): unknown[] {
  const attributes = Array.isArray(policy.attributes) ? policy.attributes : []
  return attributes.filter((a) => a && a.attributeName === name).map((a) => a.value)
}

/** Both bounds unbounded: 0, "0" or absent. Anything else may not be in force now. */
function isUnbounded(value: unknown): boolean {
  return value === undefined || value === null || value === 0 || value === '0'
}

/** Does ONE policy bound each payment of `asset`, and is it in force without a time limit? */
function policyGovernsAsset(policy: PolicyRecord, asset: string): boolean {
  if (!isUnbounded(policy.validFromBlock) || !isUnbounded(policy.validToBlock)) return false

  const scopes = attributeValues(policy, 'assetScope')
  const tokens = attributeValues(policy, 'tokenAddress')
  const caps = attributeValues(policy, 'perTransactionMax')
  // A repeated name is ambiguous: the wallet cannot know which copy the service reads. assetScope and perTransactionMax must
  // appear exactly once; tokenAddress is held to exactly one (ztp20) or none (native) below, which also rejects repeats.
  if (scopes.length !== 1 || caps.length !== 1) return false

  const scope = scopes[0]
  const names =
    asset === NATIVE
      ? // A native policy that also names a token is ignored for native payments by the service.
        scope === 'native' && tokens.length === 0
      : scope === 'ztp20' && tokens.length === 1 && tokens[0] === asset
  if (!names) return false

  const perTransactionMax = caps[0]
  return typeof perTransactionMax === 'string' && RAW_AMOUNT.test(perTransactionMax)
}

/**
 * Pure: does any policy the owner has, read successfully, govern `asset`? A policy that could not be read is skipped, not
 * guessed at; one unreadable policy does not stop another readable one from qualifying, because each is judged alone.
 */
export function ownerPoliciesGovernAsset(owned: OwnerPolicies, asset: string): boolean {
  if (!asset) return false
  return owned.policies.some((entry) => {
    const result = entry.result
    return 'found' in result && result.found === true && policyGovernsAsset(result.value.policy, asset)
  })
}

export interface PolicyGovernsOptions {
  /** True when the user set MAX_PAYMENT_AMOUNT: their own limit is never bypassed. */
  explicitCaps: boolean
  /** Undefined where the policy contracts are not deployed (mainnet today): nothing can govern, so the cap applies. */
  registryAddress: string | undefined
  owner: string | undefined
  query: ContractQuery
  /** How long a good reading is reused. */
  ttlMs?: number
  /** The longest the chain read may take before the answer is "does not govern". */
  readTimeoutMs?: number
  /** After a read times out, how long no new read is started while it still runs. */
  abandonedRetryMs?: number
  /** Monotonic milliseconds. Not the wall clock: a clock set backwards must not keep a removed policy bypassing. */
  now?: () => number
  /** For tests: replace the chain read. */
  read?: (owner: string, registry: string, query: ContractQuery) => Promise<OwnerPolicies>
}

export type PolicyGoverns = (asset: string) => Promise<boolean>

/** A reading worth keeping: the owner's policy contract was found and its keys listed, or there is no contract at all. */
function isCompleteReading(owned: OwnerPolicies): boolean {
  if (!('found' in owned.contract)) return false
  if (owned.contract.found === false) return true // "has no policy contract" is a real, complete answer
  return owned.keys !== null && 'found' in owned.keys && owned.keys.found === true
}

/**
 * A cached, never-throwing check: does the owner's policy govern this asset, so the default wallet cap should not be applied?
 *
 * The read is the same 2 + N chain read `get_my_policy` makes. Concurrent callers share one read, a read that takes too long
 * is "does not govern", and only a complete reading is kept.
 */
export function createPolicyGovernsCheck(options: PolicyGovernsOptions): PolicyGoverns {
  const { explicitCaps, registryAddress, owner, query } = options
  if (explicitCaps || !registryAddress || !owner) return async () => false

  const read = options.read ?? readOwnerPolicies
  const now = options.now ?? (() => performance.now())
  const ttl = options.ttlMs ?? 30_000
  const timeoutMs = options.readTimeoutMs ?? 10_000
  const abandonedRetryMs = options.abandonedRetryMs ?? 60_000
  let cached: { owned: OwnerPolicies; at: number } | undefined
  let inFlight: Promise<OwnerPolicies> | undefined
  // A read that timed out and is still running. The chain read takes no abort signal, so it cannot be cancelled; while it
  // runs no other read is started (they would pile up on a slow node), and its late answer is never cached.
  let stuck: { read: Promise<OwnerPolicies>; since: number } | undefined

  const current = async (): Promise<OwnerPolicies | undefined> => {
    if (cached && now() - cached.at < ttl) return cached.owned
    // Fail closed while a read is stuck, but not forever: a read that never settles must not switch the bypass off for the
    // life of the process, so one new attempt is allowed once the stuck one is old enough.
    if (stuck && now() - stuck.since < abandonedRetryMs) return undefined
    if (!inFlight) {
      // Stamped with when the read STARTED: the answer describes the chain as it was then, not when it arrived.
      const startedAt = now()
      const started: Promise<OwnerPolicies> = read(owner, registryAddress, query)
        .then((owned) => {
          // Only a read still wanted may fill the cache. One that timed out was dropped from `inFlight`, so a late positive
          // can never overwrite a newer answer and extend the bypass past the documented bound.
          if (inFlight === started && isCompleteReading(owned)) cached = { owned, at: startedAt }
          return owned
        })
        .finally(() => {
          if (inFlight === started) inFlight = undefined
          if (stuck?.read === started) stuck = undefined
        })
      inFlight = started
    }
    const pending = inFlight
    pending.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    })
    try {
      const result = await Promise.race([pending, timedOut])
      if (result === TIMED_OUT) {
        if (inFlight === pending) inFlight = undefined
        stuck = { read: pending, since: now() }
        return undefined
      }
      return result
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  return async (asset) => {
    try {
      const owned = await current()
      return owned !== undefined && ownerPoliciesGovernAsset(owned, asset)
    } catch {
      return false
    }
  }
}

/**
 * The check as `main()` wires it, in one place a test can call. Written inline in `main()` (coverage-ignored), dropping
 * `explicitCaps` would make an explicit MAX_PAYMENT_AMOUNT bypassable with every test green; here it is pinned.
 */
export function buildPolicyGoverns(
  config: { paymentCapsExplicit: boolean; policyRegistryAddress?: string },
  owner: string | undefined,
  query: ContractQuery,
): PolicyGoverns {
  return createPolicyGovernsCheck({
    explicitCaps: config.paymentCapsExplicit,
    registryAddress: config.policyRegistryAddress,
    owner,
    query,
  })
}

/**
 * The cap check every paying path runs: the default wallet cap, unless the owner's policy governs the asset. Throws the same
 * `PaymentCapError` as `assertWithinPaymentCap` when the cap applies and is exceeded.
 *
 * Only the CAP stands aside. The amount must still be a plain non-negative integer string, because a malformed amount in a
 * 402 challenge from an arbitrary URL would otherwise reach the payment engine unchecked once the cap no longer looks at it.
 */
export async function assertWithinCapUnlessGoverned(
  accept: PaymentRequirement,
  caps: Record<string, string> | undefined,
  policyGoverns: PolicyGoverns | undefined,
): Promise<void> {
  if (policyGoverns && (await policyGoverns(accept.asset ?? ''))) {
    assertValidAmount(accept)
    return
  }
  assertWithinPaymentCap(accept, caps)
}
