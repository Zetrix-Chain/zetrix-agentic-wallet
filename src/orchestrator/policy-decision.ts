/**
 * check_policy_decision — "would this spend go through right now?", answered by the PDP.
 *
 * `policy_preflight` asks whether a policy is well-formed and what it MEANS. This asks the only
 * question that one cannot: whether a specific payment is permitted at this moment, which depends
 * on cumulative spend the chain does not hold.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: nothing here produces `permitted: true` unless the PDP
 * said ALLOW. Not a timeout, not a 401, not a malformed envelope, not an unrecognised verdict
 * string. Every failure lands on `undetermined`, whose whole contract is "stop, and this is not a
 * refusal either".
 *
 * WHY THERE ARE THREE OUTCOMES WHEN THE SERVER HAS TWO. The server answers ALLOW or DENY, and
 * carries "we could not tell" as a DENY with `reasonCode: EVALUATION_UNAVAILABLE`. That is right
 * for the server, whose job is to make the caller stop. It is not enough for a tool whose output an
 * LLM agent reads aloud to a user: "your policy blocked this" and "we could not reach the policy
 * service" call for different next steps — fix the policy, versus try again in a minute. So the
 * three outcomes here are `permitted`, `refused` and `undetermined`, and `undetermined` covers
 * BOTH the server's EVALUATION_UNAVAILABLE and this wallet's own transport failures, because to
 * the user they are the same fact: nobody knows.
 *
 * `undetermined` is emphatically NOT the STEP_UP named in this tool's acceptance criteria. STEP_UP
 * would be a verdict — "a human must approve this" — and the PDP has no such state. Reporting one
 * would be inventing authority. See the ticket comment of 2026-09-28.
 */

import type {
  DecisionRead,
  DecisionRequest,
  PolicyDecisionClient,
  UnansweredCause,
} from '../clients/policy-decision-client.js'

export interface PolicyDecisionDeps {
  /** Absent when no decision endpoint is configured for this network. */
  client?: PolicyDecisionClient
  network?: string
}

export interface PolicyDecisionResult {
  /** `permitted` ONLY when the PDP said ALLOW. See the file header. */
  outcome: 'permitted' | 'refused' | 'undetermined'
  /** What to tell the user, in one sentence, without them reading the fields below. */
  summary: string
  /** The PDP's own reason code, when it gave one. Never invented, never translated away. */
  reasonCode?: string
  /** The policy this verdict came from, when one was resolved. */
  policyKey?: string
  /** Constraints the PDP enforced to reach this answer. */
  enforced?: string[]
  /**
   * Constraints the PDP could NOT enforce. Surfaced on a `permitted` result too — the same reason
   * `policy_preflight` returns `interpretation` on a clean result. An ALLOW that skipped a
   * constraint is not the same as an ALLOW that satisfied every one, and only this field tells
   * them apart.
   */
  ignored?: Array<{ attributeName?: string; reason?: string; detail?: string }>
  /** Headroom left after this spend, when the PDP read spend to decide. */
  remaining?: Record<string, string | undefined>
  /**
   * ALWAYS ABSENT TODAY. The server returns `capacityReturnsAt`/`capacityReturning` as null on
   * every response — deferred deliberately, because "a wrong 'you can spend again at' is worse
   * than none" (guide §9). Kept on the type so the field has one obvious home when it lands, and
   * NOT built into any sentence. "Capacity returns at X" would be a claim that can never fire
   * while the field is null, and an unverified one if the field ever arrives.
   */
  capacityReturnsAt?: string
  /**
   * Present on `permitted`, and the reason this tool is not a free read: the ALLOW it came from
   * reserved the owner's budget for 15 minutes, and nothing can release it early.
   *
   * (An earlier version of this doc pointed at a `reservationHeld` field. There is no such field
   * and there never was.)
   */
  reservationId?: string
  /** Everything this answer does not settle. Present on every outcome, like `policy_preflight`. */
  notChecked: string[]
}

/**
 * The reason codes that mean "nothing was evaluated" rather than "the policy refused you".
 *
 * Only one value, and it is a set rather than an equality check so that a second such code added
 * upstream has one obvious place to land. The distinction is the server's own: its `deny()`
 * factory throws if handed this code, and its `unavailable()` factory throws if handed any other.
 */
const NOT_EVALUATED: ReadonlySet<string> = new Set(['EVALUATION_UNAVAILABLE'])

/**
 * Plain-language readings of the PDP's reason codes.
 *
 * Deliberately a lookup with a fallback, not a translation layer: an unrecognised code is REPORTED
 * verbatim rather than described, because inventing a meaning for a code this wallet has never
 * seen is the same defect as inventing a verdict. Read from `DecisionReasonCode` in ms-zetrix
 * `developv2` on 2026-09-28. UNVERIFIED from this repo — ms-zetrix is not vendored here, so this
 * citation is the whole of the evidence, and a code missing from this map still works.
 */
const REASON_TEXT: ReadonlyMap<string, string> = new Map([
  ['NO_POLICY_FOR_ASSET', 'this owner has no policy covering that asset, and a policy is how an owner grants an agent authority to spend — so there is no authority to spend it'],
  ['POLICY_NOT_FOUND', 'no policy exists under that key for this owner'],
  ['ASSET_SCOPE_MISMATCH', 'the policy governs a different asset scope than the one being spent'],
  ['MISSING_ASSET_SCOPE', 'the policy sets an amount or count cap but names no asset, so the cap governs nothing'],
  ['AMBIGUOUS_TEMPLATE_MATCH', 'more than one policy could govern this request and they do not agree'],
  ['UNENFORCEABLE_ATTRIBUTE', 'the policy carries a constraint the decision service cannot enforce, so it refused rather than ignoring it'],
  ['NO_ENFORCEABLE_CONSTRAINTS', 'the policy has no enforceable constraint at all — only qualifiers — so it can permit nothing'],
  ['MISSING_PAY_TO', 'the policy restricts who may be paid, and this request did not say who is being paid'],
  ['MISSING_RECIPIENT', 'the policy restricts the recipient, and this request named none'],
  ['OUTSIDE_VALIDITY_WINDOW', 'the policy is not in force at this block'],
  ['RECIPIENT_DENYLISTED', 'the recipient is on the policy’s deny-list'],
  ['RECIPIENT_NOT_ALLOWLISTED', 'the recipient is not on the policy’s allow-list, which permits only the addresses it lists'],
  ['METHOD_NOT_ALLOWED', 'the policy does not permit that contract method'],
  ['PAY_TO_NOT_ALLOWLISTED', 'the payee is not on the policy’s allow-list'],
  ['PER_TRANSACTION_EXCEEDED', 'this single payment is larger than the policy’s per-transaction cap'],
  ['CUMULATIVE_EXCEEDED', 'this payment would take the total spent past the policy’s cumulative cap'],
  ['VELOCITY_EXCEEDED', 'this payment would exceed the policy’s rate limit for the current window'],
  ['TRANSACTION_COUNT_EXCEEDED', 'the policy’s limit on how MANY payments may be made in this window is already reached'],
  ['POLICY_WINDOW_EXCEEDS_RETENTION', 'the policy’s window is longer than the spend history the service retains, so it cannot be evaluated honestly'],
  ['OWNER_NOT_HSM_PROVISIONED', 'this owner has no HSM account, so no spend can be signed for them at all'],
  ['EVALUATION_UNAVAILABLE', 'the decision service could not evaluate the policy — this is not a refusal, and nothing about the policy is known from it'],
])

/**
 * Where a `remaining` figure is measured from, said wherever one is reported.
 *
 * Limits are prospective: the owner's enforcement floor is written once, on their first decision,
 * and never moves. A "lifetime" cumulative cap therefore counts from that block rather than from
 * account creation, so anyone who checks their own chain history will think the number is wrong
 * unless told where it starts.
 */
function enforcementFloorNote(enforcementFromBlock?: string): string[] {
  if (!enforcementFromBlock) return []
  return [
    `Any "remaining" figure here is counted from block ${enforcementFromBlock}, the owner's ` +
      `enforcement floor — NOT from the account's whole history. Spend that settled before that ` +
      `block is not counted against any cap, ever, so tell the user where the number is measured ` +
      `from or it will look wrong to anyone who checks their own chain history.`,
  ]
}

/**
 * What no decision can settle, on EVERY outcome — the same discipline as `policy_preflight`'s
 * `baseNotChecked`. A verdict is about this moment and this request, and reading it as a standing
 * permission is the mistake worth pre-empting.
 */
function baseNotChecked(network?: string): string[] {
  const items = [
    'Whether this answer is still true when the payment is actually made. A decision describes ' +
      'this moment; spend that lands in between changes it.',
    'Whether the payment will succeed for any NON-policy reason — gas, balance, a rejected ' +
      'transaction. The policy permitting a spend is not the chain accepting one.',
  ]
  if (network && !network.includes('testnet')) {
    items.push(
      `On ${network} the policy registry is not deployed, so there is no decision service to ask.`,
    )
  }
  return items
}

/**
 * What to tell the user when no verdict came back.
 *
 * Every branch ends in the same OUTCOME — stop — so the only thing this chooses is whose problem
 * it is and what to do next. Getting that wrong is not harmless: telling an agent its request is
 * malformed invites it to change the amount and ask again, which is the exploration the tool
 * description spends a paragraph forbidding.
 */
function explainUnanswered(cause: UnansweredCause, detail: string): string {
  const unknown = 'whether this spend is permitted is UNKNOWN — this is not a refusal and it is not permission'
  // The timeout warning belongs ONLY on paths where the call may have run: a request that was
  // refused or never understood reserved nothing, and warning about a reservation there would be
  // a claim about the owner's budget that nothing supports.
  const mayHaveReserved =
    ' DO NOT automatically retry: the call may have succeeded and already reserved this owner’s ' +
    'budget for 15 minutes, and asking again would reserve it a second time'

  switch (cause) {
    case 'unauthorized':
      // The status this wallet actually gets today. Nothing about the request is wrong, and no
      // amount of changing it will help.
      return (
        `This wallet is not authorised to query the decision service, so ${unknown}. Nothing is ` +
        `wrong with the request — the wallet has no credential for that service, which is for ` +
        `whoever operates it to configure. Do not change the amount or the asset and try again ` +
        `(${detail}).`
      )
    case 'busy':
      // Reached, and asked to come back. The request never ran, so there is no reservation to
      // warn about — saying there might be would be a false claim about the owner's budget.
      return (
        `The decision service is busy or rate-limiting, so ${unknown}. The request was not ` +
        `evaluated and nothing was reserved: wait a little and ask again UNCHANGED — do not alter ` +
        `the amount or the asset (${detail}).`
      )
    case 'misconfigured':
      // This client sends one fixed path and no query string, so nothing a caller supplies can
      // produce a 404. Telling them to fix their request would send them hunting in the wrong place.
      return (
        `The decision service was not found at the configured address, so ${unknown}. That is a ` +
        `setup problem for whoever operates this wallet, not something wrong with the request — ` +
        `do not change the amount or the asset and try again (${detail}).`
      )
    case 'rejected':
      return (
        `The decision service REFUSED this request, so no policy was consulted and ${unknown}. ` +
        `This is a problem with the request itself rather than an outage — fix it rather than ` +
        `waiting or retrying (${detail}).`
      )
    case 'unreadable':
      // A 2xx we could not parse. The decision may well have been computed and reserved.
      return `The decision service answered with something this wallet could not read, so ${unknown}.${mayHaveReserved} (${detail}).`
    case 'unreachable':
      return `The decision service could not be reached, so ${unknown}.${mayHaveReserved} (${detail}).`
  }
}

/** Shape a result for a question we could not put to the PDP at all. */
function undetermined(reason: string, network?: string, extra?: Partial<PolicyDecisionResult>): PolicyDecisionResult {
  return {
    outcome: 'undetermined',
    summary: reason,
    notChecked: [
      ...baseNotChecked(network),
      'Whether this spend is permitted. Nothing was evaluated, so this is NOT a refusal — and it ' +
        'is not permission either. Do not spend on the strength of it.',
    ],
    ...extra,
  }
}

/**
 * Reject a request that is not shaped like one before spending a network call on it.
 *
 * `index.ts` dispatches `fn(args ?? {})` and the MCP SDK does not enforce `inputSchema` at
 * runtime, so an agent can arrive here with anything. Returning blockers rather than throwing is
 * the same contract `policy_preflight` keeps.
 */
function structuralProblems(input: DecisionRequest): string[] {
  const problems: string[] = []
  if (typeof input?.ownerAddress !== 'string' || input.ownerAddress === '') {
    problems.push('ownerAddress is required — it identifies whose policy is being consulted.')
  }
  const asset: unknown = input?.asset
  if (typeof asset === 'string') {
    if (asset.trim() === '') problems.push('asset is required — "ZTX" or a ZTP20 contract address.')
  } else if (typeof asset === 'object' && asset !== null) {
    const { scope, tokenAddress } = asset as { scope?: unknown; tokenAddress?: unknown }
    if (scope !== 'native' && scope !== 'ztp20') {
      problems.push('asset.scope must be "native" or "ztp20".')
    } else if (scope === 'native' && typeof tokenAddress === 'string' && tokenAddress.trim() !== '') {
      // The server rejects this as a 400 rather than cleaning it up, and says why: "if you sent
      // both, you most likely meant ztp20 and mistyped scope, and quietly discarding the address
      // would answer a different question than the one you asked" (guide §1.5). Saying that here
      // costs nothing; learning it from a 400 costs a round trip and explains less.
      problems.push(
        'asset names scope "native" but also carries a tokenAddress. Did you mean scope "ztp20"? ' +
          'This is refused rather than cleaned up, because dropping the address would answer a ' +
          'different question than the one asked.',
      )
    } else if (scope === 'ztp20' && (typeof tokenAddress !== 'string' || tokenAddress.trim() === '')) {
      problems.push('asset scope "ztp20" needs a tokenAddress.')
    }
  } else {
    problems.push(
      'asset is required — "ZTX", a ZTP20 contract address, or { scope, tokenAddress }. A number ' +
        'or a bare object is not one of those.',
    )
  }
  if (typeof input?.amount !== 'string' || !/^\d+$/.test(input.amount)) {
    problems.push('amount is required, as a whole number written as a string (the chain’s own unit).')
  }
  // Rejected here rather than sent, because the server answers 400 for it and a 400 is not a
  // verdict. Telling the caller why costs one line; a 400 tells them almost nothing.
  if ((input as { templateId?: unknown })?.templateId !== undefined) {
    problems.push(
      'templateId is not accepted by the decision service — it rejects the request rather than ' +
        'ignoring the field. Name a policyKey, or omit both and let every policy for the asset be ' +
        'resolved.',
    )
  }
  return problems
}

export async function checkPolicyDecision(
  deps: PolicyDecisionDeps,
  input: DecisionRequest,
): Promise<PolicyDecisionResult> {
  const problems = structuralProblems(input)
  if (problems.length > 0) {
    return undetermined(`This request could not be asked: ${problems.join(' ')}`, deps.network)
  }

  if (!deps.client) {
    return undetermined(
      `No policy decision service is configured for ${deps.network ?? 'this network'}, so whether ` +
        `this spend is permitted could not be established.`,
      deps.network,
    )
  }

  const read: DecisionRead = await deps.client.decide(input)

  if (!read.answered) {
    // The failure that matters most in this whole file. It must not read as a refusal, it must not
    // read as permission, and — the part that is easy to miss — a TIMEOUT is not "nothing
    // happened". Integration guide §7: "A network timeout may mean the decision SUCCEEDED and
    // reserved, and your retry will reserve again." There is no endpoint to release a reservation;
    // it lapses at the TTL or discharges against a settled transfer, and nothing else.
    return undetermined(explainUnanswered(read.cause, read.detail), deps.network)
  }

  const v = read.value
  const notEvaluated = v.reasonCode !== undefined && NOT_EVALUATED.has(v.reasonCode)
  const explanation = v.reasonCode ? REASON_TEXT.get(v.reasonCode) : undefined

  const shared = {
    reasonCode: v.reasonCode,
    policyKey: v.resolvedPolicyKey,
    enforced: v.enforced,
    ignored: v.ignored?.length ? v.ignored : undefined,
    remaining: v.remaining as Record<string, string | undefined> | undefined,
  }

  if (notEvaluated) {
    // Arrives as decision:"DENY". Reported as undetermined, because the policy said nothing.
    return {
      ...undetermined(
        `The policy could not be evaluated, so whether this spend is permitted is UNKNOWN — the ` +
          `policy did NOT refuse it. ${explanation ?? `The service reported ${v.reasonCode}.`}`,
        deps.network,
      ),
      ...shared,
    }
  }

  if (v.decision === 'DENY') {
    const because = explanation
      ? ` Reason: ${explanation}.`
      : v.reasonCode
        ? ` The service gave the reason code ${v.reasonCode}, which this wallet does not recognise — report it as-is rather than guessing at it.`
        : ''
    return {
      outcome: 'refused',
      summary: `The policy REFUSES this spend.${because}`,
      ...shared,
      capacityReturnsAt: v.capacityReturnsAt,
      // The enforcement-floor note belongs here TOO, not only on a permitted answer: a cap-breach
      // DENY carries `remaining`, and the tool tells the agent to compute from it locally, so this
      // is exactly where the number gets used and exactly where it looks wrong without the note.
      notChecked: [...baseNotChecked(deps.network), ...enforcementFloorNote(v.enforcementFromBlock)],
    }
  }

  const ignoredWarning = v.ignored?.length
    ? ` NOTE: ${v.ignored.length} constraint${v.ignored.length === 1 ? '' : 's'} in this policy could ` +
      `not be enforced and ${v.ignored.length === 1 ? 'was' : 'were'} skipped — this ALLOW is ` +
      `narrower evidence than it looks. See "ignored".`
    : ''

  return {
    outcome: 'permitted',
    summary:
      `The policy PERMITS this spend right now.${ignoredWarning}` +
      (v.reservationId
        ? ` Capacity for it is RESERVED for about 15 minutes — do not call this repeatedly to poll, ` +
          `because each ALLOW holds headroom that may never be spent.`
        : ''),
    ...shared,
    reservationId: v.reservationId,
    capacityReturnsAt: v.capacityReturnsAt,
    notChecked: [...baseNotChecked(deps.network), ...enforcementFloorNote(v.enforcementFromBlock)],
  }
}
