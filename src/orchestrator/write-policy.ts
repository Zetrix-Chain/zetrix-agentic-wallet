/**
 * write_policy / check_policy_write — put a spending policy on chain, paying for it with x402.
 *
 * Two tools rather than one, following the shape `request_ai_birthcert_verification` /
 * `check_ai_birthcert_verification` already uses: the settle queue can outlast a single MCP call,
 * so `write_policy` runs the three phases with a BOUNDED polling budget and, if settlement has not
 * confirmed by then, hands back the receipt and says so. `check_policy_write` resumes phase 3 from
 * that receipt.
 *
 * THE RULE THAT MATTERS MOST: a 202 is not a failure (AC #1). Between phase 2 and a confirmed
 * settlement the money has moved and no policy exists, and that window is the normal case — the
 * facilitator takes ~19s at p95. An agent told "failed" there will either alarm the user or, far
 * worse, pay again. So every un-finished state returned by this module carries the receipt and
 * says explicitly that a payment was made.
 *
 * WHAT IS NEVER STORED: the HSM password. Phase 3 needs it on the wire — ms-zetrix signs the
 * permit at write time — but it is read from session configuration at call time and never written
 * to the receipt store (AC #6, and see `policy-write-receipt-store.ts`).
 *
 * WHAT THIS MODULE NEVER BUILDS: a transaction blob, a permit digest, or canonical attributes JSON
 * (AC #7). ms-zetrix does all three, with the owner's own key.
 */

import { createHash } from 'node:crypto'
import type {
  AdoptTemplateRequest,
  CollectResult,
  PolicyWriteClient,
  UpdateRequest,
  WriteRoute,
} from '../clients/policy-write-client.js'
import { isVerifyShape, operationOf, type PolicyWriteOperation, type PolicyWriteReceipt, type PolicyWriteReceiptStore, type PolicyWriteVerify } from '../clients/policy-write-receipt-store.js'
import type { PolicyRead, PolicyReadResult } from '../clients/policy-read-client.js'
import type { PolicyPreflightResult } from './policy-preflight.js'
import type { Affordability } from './policy-affordability.js'
import { describePolicyRefusal, policyRefusalFlags, toPaymentPolicyError } from '../policy-refusal.js'

/** The x402 `accepts[]` entry shape, as the wallet's existing quote selection understands it. */
type Accept = Record<string, unknown>

export interface WritePolicyDeps {
  client?: PolicyWriteClient
  receipts: PolicyWriteReceiptStore
  /** Self-pay one accept and return the `X-PAYMENT` header. The wallet's existing capped payer. */
  pay: (accept: Accept) => Promise<string>
  /** Orders the quotes by gas preference. Injected so the choice cannot drift from other tools'. */
  chooseAccept: (accepts: Accept[]) => Accept | undefined
  /**
   * The Template contract this wallet is configured to trust.
   *
   * Preflight types a draft against THIS address; the paid write goes to whatever
   * `templateContractAddress` the caller supplied. Nothing compared them, so a wrong or invented
   * address passed the free check, was paid for, and then failed on chain against a different
   * template — the same defect as skipping preflight entirely, one level down.
   */
  templateContract: string
  /** The session's HSM password. Passed to phase 3 only, never persisted. */
  hsmPassword: string
  ownerAddress: string
  network?: string
  /** Sleep between polls. Injected so tests do not take the real Retry-After. */
  sleep: (ms: number) => Promise<void>
  /** Wall clock, injected for the same reason. */
  now?: () => Date
  /**
   * Renders a raw amount as the user would read it, for a quote ("50000 (0.05 JMYR)"). Optional:
   * without it, or if it fails, the quote carries the raw figure and nothing else is lost.
   */
  describeAmount?: (asset: string, raw: string) => Promise<string>
  /**
   * Whether this wallet could pay the quoted amount right now — balances and the payment cap, read
   * for free. Used ONLY by `dryRun`; the paying path is unchanged and still enforces its own
   * checks. Optional: without it, or if it throws, the quote says plainly that affordability was
   * not checked rather than implying it was.
   */
  checkAffordability?: (accept: Accept) => Promise<Affordability>
  /**
   * The SAME check `policy_preflight` runs, called here rather than merely recommended.
   *
   * `write_policy` used to name preflight in its tool description and never run it, so a draft
   * preflight refuses for free — `recipientAllowlist: []`, an empty allow-list that denies
   * everything — was paid for and written. A rule that lives only in a description is a rule an
   * agent may skip, and this one is the difference between a free refusal and a paid-for mistake.
   *
   * REQUIRED, not optional. It was optional so the orchestrator could be unit-tested without a
   * chain reader, and that made the guard fail-open: a wiring that forgot it skipped the check in
   * silence and paid anyway. A test supplies its own; production cannot omit one.
   */
  preflight: (draft: {
    policyKey: string
    attributes: Array<{ attributeName: string; attributeType?: string; value?: string; valueHuman?: string | number }>
    validFromBlock: string
    validToBlock: string
    templateId?: string
    amountUnit?: string
  }) => Promise<PolicyPreflightResult>
  /**
   * Reads one of the owner's policies from chain. Used by update_policy (the template to check against, the bounds to
   * carry forward, the earliest "it changed") and remove_policy (to describe what goes, and to confirm it is gone).
   * Optional in this type so the create flow's tests need not supply it; update_policy refuses without it, and
   * remove_policy then cannot confirm a removal and says so.
   */
  readPolicy?: (policyKey: string) => Promise<PolicyRead<PolicyReadResult>>
  /** Bound on one chain read made to verify a paid write. Defaults to 10 s; a test shortens it. */
  readTimeoutMs?: number
}

export interface WritePolicyResult {
  /**
   * `written` only when the block confirmed it. Every other value means STOP AND READ, and three
   * of them mean a payment has already been made.
   */
  state:
    | 'written'
    | 'settling'
    | 'submitted'
    | 'already_exists'
    /** Refused by the FREE pre-check. Nothing was presented for payment. */
    | 'refused'
    /**
     * The payment was presented and the service refused it. Kept apart from `refused` because
     * "nothing was paid" is true of one and NOT KNOWN of the other — a single state would force
     * every description of it into a claim about the fee that cannot be supported either way.
     */
    | 'payment_refused'
    | 'receipt_void'
    | 'write_failed'
    | 'unknown'
    | 'unavailable'
    /**
     * A price, and nothing else: `dryRun` ran the free checks and stopped. No payment was made and
     * no policy was written. `paid` is false and `quote` carries what the service asked for.
     */
    | 'quoted'
    /** update_policy: there is no such policy. Free; nothing was paid. */
    | 'not_found'
    /** update_policy: the policy changed since it was read. Free; nothing was paid. */
    | 'modified'
    /** update_policy: the template the policy references no longer exists. Free; nothing was paid. */
    | 'template_unavailable'
  /** What to tell the user, in one sentence. */
  message: string
  /** Present whenever a payment HAS been made and the write is not finished. Keep it. */
  paymentReceipt?: string
  /**
   * What the service (or a gateway in front of it) actually answered, kept apart from this wallet's own words in `message`:
   * the HTTP status and a bounded excerpt of its body. Present when the collect step answered with an error.
   */
  upstream?: { status: number; detail: string }
  /**
   * Wallet BE refused to sign the fee because the owner's spending policy DENIED it (`state: 'refused'`). A decision,
   * not a failure: retrying will not help. Nothing was signed or paid and no policy was written. See policy-refusal.ts.
   */
  policyDenied?: true
  /**
   * Wallet BE could not complete the policy check, so it refused to sign (`state: 'unavailable'`); nothing was paid
   * and no policy was written. Transient: trying again shortly is right.
   */
  policyCheckUnavailable?: true
  policyKey?: string
  txHash?: string
  /** True when money has moved for this call or a previous one. Never guessed. */
  paid?: boolean
  /** Set when paying again is the correct next step — only ever on a void receipt. */
  payFresh?: boolean
  /**
   * What this policy would MEAN, from preflight — carried on every result, including a successful
   * write. A policy can be perfectly valid and still not say what the user asked for (a cap with
   * no window is a LIFETIME cap), and that is exactly the case where nothing else will flag it.
   */
  interpretation?: string[]
  /** Why preflight refused, when it did. Every problem at once, so one round of fixes is enough. */
  blockers?: string[]
  /**
   * Set when this result came from collecting a write that was ALREADY PAID FOR under this
   * policyKey, rather than from the attributes just submitted.
   *
   * Round 1 APP-M02: the in-flight recovery collected the earlier write and reported
   * `state: written` as though the NEW request had landed. A request raising a cap to 300 would
   * come back "written" while the earlier request's cap is what is actually in force, and the agent
   * would tell the owner their new cap is live when it is not.
   *
   * This wallet cannot diff the two: the 409 carries a receipt and a sentence, not the attributes,
   * and there is no read-back of a pending write. So the honest answer is not to claim the new
   * draft landed — it is to say which write this is and let the caller confirm.
   */
  recoveredEarlierWrite?: boolean
  /**
   * Set on a `quoted` result that stopped only because `confirm: true` was not passed: nothing was paid or written, and the
   * next step is to show the user the interpretation and the price and, if they agree, call again with `confirm: true`.
   */
  needsConfirmation?: true
  /** Present on `quoted`. What the service asked for, as it asked. */
  quote?: {
    asset: string
    /** Raw units, exactly as quoted. */
    amount: string
    /** The same amount as a person would read it, when the asset could be resolved. */
    amountHuman?: string
    payTo?: string
    gasModel?: string
  }
  /**
   * Present on `quoted`: whether this wallet could pay it right now. `unknown` when it could not be
   * determined — a failed read is never reported as affordable.
   */
  affordability?: Affordability
}

/**
 * The attributes as the service receives them. A human amount (`valueHuman`) never goes over the wire: preflight turned it
 * into the raw value, and the service stores raw base units only.
 */
function toWireAttributes(
  attributes: Array<{ attributeName: string; attributeType?: string; value?: string; valueHuman?: unknown }>,
  converted: Record<string, string> | undefined,
): Array<{ attributeName: string; attributeType?: string; value: string }> | undefined {
  const wire: Array<{ attributeName: string; attributeType?: string; value: string }> = []
  for (const a of Array.isArray(attributes) ? attributes : []) {
    // Not an object: preflight refuses it before this is ever reached. Called after preflight only, so nothing malformed gets here.
    if (a === null || typeof a !== 'object') return undefined
    const { valueHuman: _human, ...rest } = a
    const raw = converted && Object.prototype.hasOwnProperty.call(converted, a.attributeName) ? converted[a.attributeName] : a.value
    // An attribute with no text value is never sent: JSON.stringify would drop the key and the service would store an attribute
    // with no value. Preflight refuses it first, so this is the last line, not the first.
    if (typeof raw !== 'string') return undefined
    wire.push({ ...rest, value: raw })
  }
  return wire
}

const NO_WIRE_VALUE =
  'An attribute reached the request with no value, which preflight should have refused, so NOTHING WAS PAID and nothing was sent. ' +
  'Give every attribute a value (or a valueHuman for an amount) and ask again.'

/** One bounded sentence for the quote message. The structured detail is on `affordability`. */
function affordabilityWords(a: Affordability): string {
  const problems = clip(a.problems.join(' '), 600)
  if (a.verdict === 'affordable') {
    return (
      'As of now this wallet holds the quoted amount and its payment cap would not refuse it.' +
      (a.feeNotEstimated ? ' The network fee is not estimated here, so this is not a guarantee.' : '')
    )
  }
  if (a.verdict === 'not_affordable') return `This wallet could NOT pay it right now: ${problems}`
  return `Whether this wallet can pay it could not be confirmed: ${problems}`
}

/** Upstream text reaches an LLM agent as tool output, so it is bounded here as everywhere else. */
function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The default budget: long enough to cover a normal settle, short enough not to hang an agent. */
const DEFAULT_BUDGET_MS = 60_000

/**
 * A hard ceiling on how many times one call polls, independent of the clock.
 *
 * The budget is measured in elapsed wall time, which is not a bound on its own — it counts time
 * actually slept, so an instant sleep leaves it at zero forever. Generous enough that a real
 * settlement at the default five-second interval is never cut short by it.
 */
const MAX_POLLS = 40

function unavailable(message: string): WritePolicyResult {
  return { state: 'unavailable', message }
}

/**
 * Map a finished-or-not collect into the tool's own vocabulary.
 *
 * Kept separate from the polling loop because `check_policy_write` needs exactly the same mapping
 * from a single call — two copies of this would be two chances to describe a paid-for write as a
 * failure.
 */
function describeCollect(result: CollectResult, receipt: PolicyWriteReceipt): WritePolicyResult {
  const updating = operationOf(receipt) === 'UPDATE'
  const base = { paymentReceipt: receipt.blobId, policyKey: receipt.policyKey, paid: true as const }
  switch (result.kind) {
    case 'written':
      return {
        state: 'written',
        message: updating ? `The policy "${receipt.policyKey}" was updated on chain.` : `The policy "${receipt.policyKey}" is on chain.`,
        policyKey: result.policyKey ?? receipt.policyKey,
        txHash: result.txHash,
        paid: true,
      }
    case 'submitted':
      // A txHash on a 202. The server is explicit that this is NOT a written policy, and the
      // distinct state name exists so a caller cannot read it as one.
      return {
        ...base,
        state: 'submitted',
        txHash: result.txHash,
        message:
          `PAYMENT MADE. The write is ON CHAIN but the block has not confirmed it yet, so the ` +
          (updating ? `policy has not been updated yet — do not report it as updated. ` : `policy does not exist yet — do not report it as created. `) +
          `Check again shortly with the ` +
          `receipt below. Do not pay again.`,
      }
    case 'settling':
      return {
        ...base,
        state: 'settling',
        message:
          `PAYMENT MADE, settlement still in progress — ${updating ? 'the policy has not been changed yet' : 'no policy has been written yet'}, and this ` +
          `is the normal case rather than a failure. Check again shortly with the receipt below. ` +
          `Do not pay again.`,
      }
    case 'void':
      // The one state where paying again is right, and the only one that says so.
      return {
        ...base,
        state: 'receipt_void',
        payFresh: true,
        message:
          `The settlement FAILED and this receipt bought nothing. ${updating ? 'Updating' : 'Writing'} the policy now requires ` +
          `paying again. (${result.detail})`,
      }
    case 'write_failed':
      return {
        ...base,
        state: 'write_failed',
        txHash: result.txHash,
        message: updating
          ? `A PAYMENT WAS PRESENTED, and the chain then REJECTED the update. The policy is UNCHANGED. Whether the fee was kept is ` +
            `not known, so do not assume it was refunded, and do not pay again. Quote the receipt below to support. (${result.detail})`
          : `PAYMENT MADE, and the chain then REJECTED the write. Paying again would not help — the ` +
            `cause is on the service's side, not yours. Quote the receipt below to support. (${result.detail})`,
      }
    case 'unknown':
      return {
        ...base,
        state: 'unknown',
        upstream: upstreamOf(504, result.detail),
        message:
          `PAYMENT MADE, and its outcome could not be determined. Do NOT assume it failed and do ` +
          `NOT pay again — quote the receipt below to support. (${result.detail})`,
      }
    case 'unrecognised':
      // Terminal. The receipt is KEPT — the money moved and support needs the id — but the loop
      // stops, so a status this wallet cannot read does not burn the retry series (APP-L01).
      return {
        ...base,
        state: 'unknown',
        upstream: upstreamOf(result.status, result.detail),
        message:
          `PAYMENT MADE, and the service answered with something this wallet does not recognise ` +
          `(HTTP ${result.status}). It is not retried, because a failed collect consumes one of a ` +
          `small number of retries for this write. Quote the receipt below to support. ` +
          `(${result.detail})`,
      }
    case 'server_error':
      // `state: unknown` and the receipt KEPT, like every outcome that moved money without a verdict.
      // Terminal for the poll loop: a failed collect uses one of a small number of retries for this
      // write, so looping on a 5xx can spend the series without ever reaching a verdict.
      return {
        ...base,
        state: 'unknown',
        upstream: upstreamOf(result.status, result.detail),
        message: result.gateway
          ? `PAYMENT MADE, but a gateway or proxy in front of the policy service answered ` +
            `(HTTP ${result.status}) instead of the service, so the result of the write was never seen. ` +
            `That is NOT the chain rejecting anything. The policy may be written, still in progress, ` +
            `or failed — it is not known. Do NOT tell the user it failed, and do NOT pay again. Wait a ` +
            `few minutes, then check once with check_policy_write; every failed check uses one of a ` +
            `small number of retries for this write, so do not loop. If it still cannot be read, quote ` +
            `the receipt below to support. (${result.detail})`
          : `PAYMENT MADE, but the policy service hit an internal error (HTTP ${result.status}) while ` +
            `finishing the write, so its result was never seen. The policy may or may not have been ` +
            `written — it is not known. Do NOT tell the user it failed, and do NOT pay again. Wait a ` +
            `few minutes, then check once with check_policy_write; every failed check uses one of a ` +
            `small number of retries for this write, so do not loop. If it still cannot be read, quote ` +
            `the receipt below to support. (${result.detail})`,
      }
    case 'unreachable':
      return {
        ...base,
        state: 'settling',
        message:
          `PAYMENT MADE, but the service could not be reached to find out what became of it. The ` +
          `receipt below is still good — check again shortly. Do not pay again. (${result.detail})`,
      }
  }
}

/**
 * The service's own words, kept apart from the wallet's. It is remote text, so control characters and line breaks are replaced
 * (it cannot start a new line in the agent's view) and it is bounded.
 */
function upstreamOf(status: number, detail: string): { status: number; detail: string } {
  return { status, detail: clip(String(detail ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim(), 200) }
}

/** What the chain should hold once this request has landed. */
function verifyFor(request: AdoptTemplateRequest | UpdateRequest): PolicyWriteVerify | undefined {
  const attributes = (request.attributes ?? [])
    .filter((a) => a && typeof a.attributeName === 'string' && typeof a.value === 'string')
    .map((a) => ({ attributeName: a.attributeName, value: a.value }))
  if (attributes.length === 0 || attributes.length !== (request.attributes ?? []).length) return undefined
  const prior = 'expectedUpdatedAtBlock' in request ? blockString(request.expectedUpdatedAtBlock) : undefined
  const templateId = 'templateId' in request && typeof request.templateId === 'string' && request.templateId !== '' ? request.templateId : undefined
  const verify: PolicyWriteVerify = {
    attributes,
    ...(prior !== undefined && /^\d{1,30}$/.test(prior) ? { priorUpdatedAtBlock: prior } : {}),
    ...(templateId !== undefined ? { templateId } : {}),
  }
  // The bounds the store enforces on read, applied on write too: a record it would drop is not worth saving.
  return isVerifyShape(verify) ? verify : undefined
}

/**
 * A receipt that can no longer be the thing that put the values on chain: the service said the write FAILED, or a newer paid write
 * for the same key has been bookmarked. Its `verify` is dropped so a later chain read cannot credit it with someone else's write.
 * The receipt itself stays (support needs the id).
 */
async function dropVerify(deps: WritePolicyDeps, receipt: PolicyWriteReceipt): Promise<void> {
  if (!receipt.verify) return
  const { verify: _dropped, ...rest } = receipt
  try {
    await deps.receipts.set(rest)
  } catch {
    // Keeping the bookmark matters more than this note on it; the owner and template checks still apply.
  }
}

const READ_TIMEOUT_MS = 10_000

/** One chain read, bounded: a read that never answers must not hold the tool call. */
async function readBounded(deps: WritePolicyDeps, policyKey: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      deps.readPolicy!(policyKey),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('chain read timed out')), deps.readTimeoutMs ?? READ_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type ChainShows =
  | { kind: 'applied'; updatedAtBlock?: string }
  | { kind: 'not_yet' }
  | { kind: 'unreadable' }
  | { kind: 'unverifiable' }

/**
 * Does the chain already hold what this paid write was meant to put there? A READ: free, it consumes none of the service's collect
 * retries, and it is the only way to know when the collect step answered with an error that says nothing about the write.
 *
 * Strict, so a yes can be trusted: the policy must hold EXACTLY the submitted attributes (same names, same values, nothing more or
 * less), and for an update its `updatedAtBlock` must have moved, otherwise "the same attributes" could simply be what was already
 * there. Anything short of that is "not yet" and never "applied". A value the chain stores differently from how it was sent reads
 * as "not yet", the safe side: it costs a manual check, never a false "written".
 */
async function chainShows(deps: WritePolicyDeps, receipt: PolicyWriteReceipt): Promise<ChainShows> {
  const verify = receipt.verify
  if (!verify || !deps.readPolicy) return { kind: 'unverifiable' }
  // The reader is bound to the current owner and receipts are not scoped per owner: a receipt left by another account says
  // nothing about this owner's policy under the same key.
  if (receipt.ownerAddress !== deps.ownerAddress) return { kind: 'unverifiable' }
  let read
  try {
    read = await readBounded(deps, receipt.policyKey)
  } catch {
    return { kind: 'unreadable' }
  }
  if ('error' in read) return { kind: 'unreadable' }
  if (read.found === false) return { kind: 'not_yet' }
  const record = read.value.policy
  // The same values under another template (or another Template contract) are not this write.
  if (verify.templateId !== undefined && record.templateId !== verify.templateId) return { kind: 'not_yet' }
  if (typeof record.templateContractAddress === 'string' && record.templateContractAddress !== '' && deps.templateContract && record.templateContractAddress !== deps.templateContract) {
    return { kind: 'not_yet' }
  }
  const onChain = Array.isArray(record.attributes) ? record.attributes : []
  if (onChain.length !== verify.attributes.length) return { kind: 'not_yet' }
  const held = new Map<string, string>()
  for (const a of onChain) {
    if (!a || typeof a.attributeName !== 'string' || held.has(a.attributeName)) return { kind: 'not_yet' }
    held.set(a.attributeName, String(a.value ?? ''))
  }
  for (const want of verify.attributes) {
    if (held.get(want.attributeName) !== want.value) return { kind: 'not_yet' }
  }
  const updatedAtBlock = blockString(record.updatedAtBlock)
  if (operationOf(receipt) === 'UPDATE') {
    if (verify.priorUpdatedAtBlock === undefined || updatedAtBlock === undefined || updatedAtBlock === verify.priorUpdatedAtBlock) {
      return { kind: 'not_yet' }
    }
  }
  return { kind: 'applied', ...(updatedAtBlock !== undefined ? { updatedAtBlock } : {}) }
}

/** The result when the chain shows the write landed although the collect step never said so. Drops the bookmark: nothing is left to do. */
async function appliedFromChain(
  deps: WritePolicyDeps,
  receipt: PolicyWriteReceipt,
  shows: Extract<ChainShows, { kind: 'applied' }>,
  why: string,
): Promise<WritePolicyResult> {
  await deps.receipts.remove(receipt.blobId)
  const updating = operationOf(receipt) === 'UPDATE'
  return {
    state: 'written',
    policyKey: receipt.policyKey,
    paid: true,
    paymentReceipt: receipt.blobId,
    message:
      `The policy "${receipt.policyKey}" ${updating ? 'was updated' : 'is on chain'}. ${why} this wallet read the chain, and it now holds ` +
      `exactly the attributes that were submitted${updating && shows.updatedAtBlock ? ` (updatedAtBlock moved from ${receipt.verify?.priorUpdatedAtBlock} to ${shows.updatedAtBlock})` : ''}. ` +
      `Nothing more is needed, and do not pay again.`,
  }
}

const VERIFY_BUDGET_MS = 45_000
/** Even with the poll budget spent, a collect error still gets this long to be read against the chain. */
const VERIFY_FLOOR_MS = 10_000

/** Poll phase 3 until it finishes or the budget runs out. Never turns a 202 into a failure. */
async function pollCollect(
  deps: WritePolicyDeps,
  client: PolicyWriteClient,
  receipt: PolicyWriteReceipt,
  budgetMs: number,
): Promise<WritePolicyResult> {
  // A budget that is not a positive number is not a budget. Round 1 passed it through, so a
  // non-numeric value made `elapsed + wait >= budget` false and the loop never expired — 201
  // polls before a terminal state arrived (APP-L02).
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS
  // Bounded by COUNT as well as by the clock. The clock alone is not a bound: it measures the
  // time actually slept, so anything that makes sleeping instant — a test, a fake timer, a
  // Retry-After of zero — leaves elapsed at ~0 forever and the loop never exits. Found by a test
  // for APP-L02 that hung rather than failing.
  let polls = 0
  const started = (deps.now?.() ?? new Date()).getTime()
  let last: WritePolicyResult | undefined

  for (;;) {
    const result = await client.collect(receipt.blobId, receipt.ownerAddress, deps.hsmPassword, operationOf(receipt))
    last = describeCollect(result, receipt)

    // Finished, either way. The bookmark is only dropped when nothing more can be done with it:
    // a written policy, or a receipt that provably bought nothing.
    if (last.state === 'written' || last.state === 'receipt_void') {
      await deps.receipts.remove(receipt.blobId)
      return last
    }
    // `write_failed` and `unknown` KEEP the receipt: the first is a support case that needs the
    // id, the second may yet resolve. Deleting either would throw away the only handle on money
    // that has already moved.
    if (last.state === 'unknown') {
      // The collect step answered with an error that says nothing about the write (a gateway timing out on a collect that then
      // finishes, as it did on staging: the service took 12.7 s and something in front of it answered 500 at about 10 s). Read the
      // chain, which is free and spends none of the service's collect retries, before handing the question back to the agent.
      const spent = (deps.now?.() ?? new Date()).getTime() - started
      const verified = await verifyOnChain(deps, receipt, Math.min(VERIFY_BUDGET_MS, Math.max(budget - spent, VERIFY_FLOOR_MS)), last)
      return verified
    }
    if (last.state === 'write_failed') {
      // The service's verdict. Whatever lands on chain for this key later is not this receipt's doing.
      await dropVerify(deps, receipt)
      return last
    }

    const waitSeconds = result.kind === 'settling' || result.kind === 'submitted' ? result.retryAfterSeconds : 5
    const elapsed = (deps.now?.() ?? new Date()).getTime() - started
    if (++polls >= MAX_POLLS || elapsed + waitSeconds * 1000 >= budget) return last
    await deps.sleep(waitSeconds * 1000)
  }
}

/** Read the chain, for a bounded time, until it shows the write or the time is up. Returns `last` with a note when it never does. */
async function verifyOnChain(
  deps: WritePolicyDeps,
  receipt: PolicyWriteReceipt,
  budgetMs: number,
  last: WritePolicyResult,
): Promise<WritePolicyResult> {
  if (!receipt.verify || !deps.readPolicy) return last
  const wait = 5_000
  const started = (deps.now?.() ?? new Date()).getTime()
  let polls = 0
  let waited = 0
  for (;;) {
    const shows = await chainShows(deps, receipt)
    if (shows.kind === 'applied') {
      return appliedFromChain(
        deps,
        receipt,
        shows,
        `The service's collect step ended with an error${last.upstream ? ` (HTTP ${last.upstream.status})` : ''} that says nothing about the write, but`,
      )
    }
    // The clock alone is not a bound (a sleep that returns at once leaves it at zero), so the count and the time already waited bound it too.
    const elapsed = Math.max((deps.now?.() ?? new Date()).getTime() - started, waited)
    if (++polls >= 12 || elapsed + wait >= budgetMs) break
    await deps.sleep(wait)
    waited += wait
  }
  const updating = operationOf(receipt) === 'UPDATE'
  return {
    ...last,
    message:
      `${last.message} This wallet also read the chain for about ${Math.max(Math.round(waited / 1000), 1)} seconds and it did not show ` +
      `the ${updating ? 'update' : 'policy'} yet. That does not mean it failed: the service may still be finishing.`,
  }
}

export interface WritePolicyInput {
  policyKey: string
  attributes: Array<{ attributeName: string; attributeType?: string; value?: string; valueHuman?: string | number }>
  /**
   * How the amount caps are written: omitted for raw base units (a non-zero cap under one whole token is
   * then refused as probably a unit mistake), `"whole"` for whole-token amounts the wallet converts,
   * `"base"` to confirm raw values. See `applyAmountUnit` in policy-preflight.ts.
   */
  amountUnit?: string
  /**
   * OPTIONAL. The wallet already knows the one Template contract it trusts, and refuses any
   * other, so there is exactly one value this could ever usefully be. Requiring it made an agent
   * ask the user for an address only the wallet knows — and invited a wrong one. Omitted, the
   * configured contract is used; supplied and different, the write is still refused before any
   * payment.
   */
  templateContractAddress?: string
  templateId: string
  validFromBlock?: string
  validToBlock?: string
  /** Idempotency key. Generated by the caller when absent. */
  requestKey?: string
  /** Milliseconds to keep polling phase 3 before handing back the receipt. */
  pollBudgetMs?: number
  /**
   * Ask for the price instead of writing. Runs every free check and returns the service's quote;
   * pays nothing, collects nothing and writes no policy on any path. The ONE thing it may write is a
   * local receipt bookmark when the write was already paid for, so check_policy_write can finish it.
   * See {@link isDryRun} for why an unexpected value counts as yes.
   */
  dryRun?: boolean
  /**
   * Must be exactly `true` to pay and write. Anything else stops at the price (`state: 'quoted'`, `needsConfirmation: true`).
   * A policy is a spending limit and, can lift the wallet's own default cap, so a person must have agreed
   * to it after seeing what it means and what it costs. The wallet cannot verify that a person said yes: like
   * `transfer_token`'s `confirm`, it is an instruction to the agent, never to be passed on its own judgement.
   */
  confirm?: boolean
}

/**
 * Whether the caller asked for a quote instead of a write.
 *
 * Fails TOWARD the quote. The two mistakes are not the same size: reading a genuine "deploy" as a
 * dry run costs one extra call, while reading a genuine dry run as a deploy spends money the user
 * explicitly did not want spent. So only an absent, null, false, zero or empty value means "deploy";
 * anything else — including the strings "true" and "false", which an agent passing the flag through
 * a loosely typed channel may well send — is treated as a request for a quote.
 */
function isDryRun(value: unknown): boolean {
  return !(value === undefined || value === null || value === false || value === 0 || value === '')
}

export async function writePolicy(deps: WritePolicyDeps, input: WritePolicyInput): Promise<WritePolicyResult> {
  if (!deps.client) {
    return unavailable(
      `No policy write service is configured for ${deps.network ?? 'this network'}, so nothing was ` +
        `attempted and nothing was paid.`,
    )
  }
  if (typeof input?.policyKey !== 'string' || input.policyKey === '') {
    return unavailable('policyKey is required — it is the key this policy would be stored under.')
  }
  if (!Array.isArray(input?.attributes) || input.attributes.length === 0) {
    return unavailable(
      'attributes are required — a policy with none would deploy successfully and restrict nothing.',
    )
  }
  if (typeof input.templateId !== 'string' || input.templateId.trim() === '') {
    return unavailable(
      'templateId is required — it is what makes this an ADOPT, so the chain type-checks the ' +
        'attributes against the template instead of accepting anything. Call get_policy_template_schema ' +
        'with no arguments to list the available templates and their ids.',
    )
  }

  const request: AdoptTemplateRequest = {
    ownerAddress: deps.ownerAddress,
    policyKey: input.policyKey,
    // Filled in after preflight (below): a draft is not touched, let alone reshaped, before the free check has said it is sound.
    attributes: [],
    // Always the configured contract — never whatever the caller passed, which at this point is
    // either absent or identical.
    templateContractAddress: deps.templateContract,
    templateId: input.templateId,
    ...(input.validFromBlock !== undefined ? { validFromBlock: input.validFromBlock } : {}),
    ...(input.validToBlock !== undefined ? { validToBlock: input.validToBlock } : {}),
    // A sha256 hex string: the service's column is 128 characters, and the old `${owner}-${policyKey}-${ISO}` overflowed it
    // for a policy key longer than about 65. Still unique per owner, key and moment.
    requestKey:
      input.requestKey ??
      createHash('sha256').update(`${deps.ownerAddress}-${input.policyKey}-${(deps.now?.() ?? new Date()).toISOString()}`).digest('hex'),
  }

  // ── Phase 1. Free, and the only phase that can refuse without costing anything. ─────────────
  // The template the draft is CHECKED against must be the one it will be WRITTEN against.
  // Otherwise preflight types it against a template nobody is going to use, and the free check
  // says yes to a draft the chain will reject after it has been paid for.
  // A blank value is "not supplied" — the effective contract is ALWAYS the configured one below,
  // so omitting it cannot point the write anywhere else. Anything else must match exactly.
  const supplied = input.templateContractAddress as unknown
  const omitted = supplied === undefined || supplied === null || (typeof supplied === 'string' && supplied.trim() === '')
  if (!omitted && supplied !== deps.templateContract) {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      message:
        `templateContractAddress "${input.templateContractAddress}" is not the Template contract ` +
        `this wallet is configured for ("${deps.templateContract}"). The draft would be checked ` +
        `against one template and written against another, so this is refused BEFORE any payment. ` +
        `Use the configured address, or ask an operator to change what the wallet trusts.`,
    }
  }

  // ── Preflight, BEFORE anything is quoted or paid. ───────────────────────────────────────────
  // Deliberately before the free pre-check too: the server's validator is "independent of the v1
  // vocabulary" and will happily accept a draft that means nothing, so a 402 for a well-formed
  // policy that enforces nothing is still a bill for nothing.
  const checked = await deps.preflight({
    policyKey: input.policyKey,
    attributes: input.attributes,
    validFromBlock: input.validFromBlock ?? '0',
    validToBlock: input.validToBlock ?? '0',
    templateId: input.templateId,
    ...(input.amountUnit !== undefined ? { amountUnit: input.amountUnit } : {}),
  })
  const interpretation = checked.interpretation
  if (!checked.ready) {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      blockers: checked.blockers,
      interpretation: checked.interpretation,
      message:
        `This draft was refused by the free pre-flight check, so NOTHING WAS PAID. Fix these and ` +
        `ask again: ${checked.blockers.join(' ')}`,
    }
  }

  // What gets written is what preflight SHOWED: with `amountUnit: "whole"` the amounts were converted to
  // raw base units there, and the user saw the converted values in `interpretation`.
  const wire = toWireAttributes(input.attributes, checked.convertedAmounts)
  if (!wire) return { state: 'refused', policyKey: input.policyKey, interpretation, message: NO_WIRE_VALUE }
  request.attributes = wire

  const dryRun = isDryRun(input.dryRun)
  // Paying, and collecting an earlier paid write, both put a spending limit on chain, which can lift the wallet's own default
  // cap. Both need a person's yes: `confirm` exactly `true`, and not a dry run.
  const confirmed = input.confirm === true
  const canWrite = confirmed && !dryRun
  const pre = await deps.client.precheck(request)

  if (pre.kind === 'already_exists') {
    return {
      state: 'already_exists',
      policyKey: input.policyKey,
      interpretation,
      message: `${pre.detail}. Nothing was paid.`,
    }
  }
  if (pre.kind === 'in_progress') {
    // NOT "the policy already exists", and "nothing was paid" is not true of it: a paid write is being completed.
    return {
      state: 'refused',
      policyKey: input.policyKey,
      interpretation,
      message: IN_PROGRESS_MESSAGE(clip(pre.detail)),
    }
  }
  if (pre.kind === 'refused') {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      message: `The write was refused before any payment: ${pre.detail}. Nothing was paid.`,
    }
  }
  if (pre.kind === 'unreachable') {
    return unavailable(`The policy write service could not be reached (${pre.detail}). Nothing was paid.`)
  }
  if (pre.kind === 'already_in_flight') {
    return recoverInFlight(deps, deps.client, {
      pre,
      policyKey: input.policyKey,
      interpretation,
      canWrite,
      dryRun,
      pollBudgetMs: input.pollBudgetMs ?? DEFAULT_BUDGET_MS,
      tool: 'write_policy',
    })
  }

  return runPaidFlow(deps, deps.client, {
    request,
    route: 'adopt-template',
    operation: 'CREATE',
    policyKey: input.policyKey,
    interpretation,
    dryRun,
    confirmed,
    canWrite,
    challenge: pre.challenge,
    pollBudgetMs: input.pollBudgetMs ?? DEFAULT_BUDGET_MS,
    tool: 'write_policy',
    verb: 'write',
  })
}

/**
 * A write for this policy has ALREADY BEEN PAID FOR and is waiting to be collected. Shared by write_policy and
 * update_policy: the receipt is collected rather than paying again, on the route its own operation names — which may not
 * be the write just asked for — and only with a person's yes unless this wallet already holds the receipt.
 */
async function recoverInFlight(
  deps: WritePolicyDeps,
  client: PolicyWriteClient,
  a: {
    pre: { blobId: string; detail: string; operation?: PolicyWriteOperation }
    policyKey: string
    interpretation: string[]
    canWrite: boolean
    dryRun: boolean
    pollBudgetMs: number
    tool: 'write_policy' | 'update_policy'
  },
): Promise<WritePolicyResult> {
  const { pre } = a
  // The wallet's own record of this receipt, if it holds one. A receipt it holds was saved by its OWN confirmed payment and is
  // authoritative about which write it pays for; one it does not hold was paid elsewhere and is only as known as the 409 says.
  const known = await deps.receipts.get(pre.blobId)
  // A write this owner has ALREADY PAID FOR. Collect it rather than paying again — the guard
  // that stops a hung settlement becoming a second charge only works if the client uses it.
  //
  // But what gets collected is the EARLIER request's content, and this wallet has no way to
  // compare it with what was just submitted: the 409 carries a receipt and a sentence, not the
  // attributes. So the result says so rather than reporting the new draft as written (APP-M02).
  const receipt: PolicyWriteReceipt = {
    blobId: pre.blobId,
    policyKey: a.policyKey,
    ownerAddress: deps.ownerAddress,
    paidAt: (deps.now?.() ?? new Date()).toISOString(),
    // Which write this receipt pays for — it may not be the one just asked for, and it decides the collect route.
    ...(pre.operation ? { operation: pre.operation } : {}),
  }
  // A receipt this wallet already holds was saved by its OWN paid write. One it does not hold was paid by something else (for
  // instance `pay_and_fetch` pointed at the write service), and its content is unknown: it is not saved, and not collected,
  // unless a person has confirmed. Saving it would hand it to check_policy_write, which collects any saved receipt.
  if (!a.canWrite) {
    if (!known) {
      return {
        state: 'refused',
        needsConfirmation: true,
        policyKey: a.policyKey,
        interpretation: a.interpretation,
        message:
          `A write under "${a.policyKey}" has ALREADY BEEN PAID FOR, but this wallet holds no receipt for it (the service said: ` +
          `"${clip(pre.detail)}"). It may be this wallet's own payment whose receipt was lost, or one made elsewhere, and its ` +
          `content is unknown, so this wallet has not saved or collected it. Collecting it would write attributes this wallet ` +
          `cannot read back, so it needs a person's yes: ` +
          `ask the user, and only if they agree call ${a.tool} again with confirm: true. Never pass confirm on your ` +
          `own judgement. Do not pay again.`,
      }
    }
    // A dry run, or no confirmation, must NOT collect. Collecting is phase 3: it signs the permit with the owner's key and
    // WRITES the policy, which is the opposite of "nothing changes". The receipt is already on file, so check_policy_write
    // can finish it when the user actually wants that.
    return {
      state: 'settling',
      paid: true,
      paymentReceipt: pre.blobId,
      policyKey: a.policyKey,
      recoveredEarlierWrite: true,
      interpretation: a.interpretation,
      message:
        `${a.dryRun ? 'DRY RUN' : 'NOT CONFIRMED'} — nothing was collected. A write under "${a.policyKey}" has ALREADY BEEN ` +
        `PAID FOR and is waiting to be collected; the service said: "${clip(pre.detail)}". Pass the receipt below to ` +
        `check_policy_write to finish it. Do not pay again.`,
    }
  }
  // ── About to collect. The route is the receipt's OWN operation. A receipt the wallet holds decides it (its record is
  // authoritative); the server's `operation` must agree or nothing is collected. One the wallet does not hold needs the
  // server's, and an UPDATE that cannot be told from a CREATE is refused rather than defaulted: collecting an update receipt
  // on the create route is undefined server-side and can end in a void that deletes the bookmark and invites a second charge.
  const stored = known ? operationOf(known) : undefined
  if (stored !== undefined && pre.operation !== undefined && pre.operation !== stored) {
    return {
      state: 'refused',
      paid: true,
      paymentReceipt: pre.blobId,
      policyKey: a.policyKey,
      interpretation: a.interpretation,
      message:
        `A paid write under "${a.policyKey}" is waiting, but the service says its receipt pays for a ${pre.operation} and this ` +
        `wallet's own record says ${stored}. They disagree, so NOTHING WAS COLLECTED: collecting on the wrong route can lose the ` +
        `receipt. Do not pay again, and quote the receipt below to support. (the service said: "${clip(pre.detail)}")`,
    }
  }
  const operation = stored ?? pre.operation
  if (operation === undefined && a.tool === 'update_policy') {
    return {
      state: 'refused',
      paid: true,
      paymentReceipt: pre.blobId,
      policyKey: a.policyKey,
      interpretation: a.interpretation,
      message:
        `A paid write under "${a.policyKey}" is waiting, but neither the service nor this wallet says whether its receipt pays for ` +
        `a create or an update, so NOTHING WAS COLLECTED rather than guess a route. Do not pay again, and quote the receipt below ` +
        `to support. (the service said: "${clip(pre.detail)}")`,
    }
  }
  const collectable: PolicyWriteReceipt = known ?? { ...receipt, ...(operation ? { operation } : {}) }
  if (!known) await deps.receipts.set(collectable)
  const collected = await pollCollect(deps, client, collectable, a.pollBudgetMs)
  return {
    ...collected,
    recoveredEarlierWrite: true,
    interpretation: a.interpretation,
    message:
      `${collected.message} IMPORTANT: this did NOT ${a.tool === 'update_policy' ? 'apply' : 'write'} the attributes just submitted. An ` +
      `EARLIER write under "${a.policyKey}" had already been paid for, and that is the one ` +
      `this collected — the service said: "${clip(pre.detail)}". The attributes now in force are the ` +
      `earlier request's, which this wallet cannot read back, so do not tell the user their new ` +
      `values are live. Read the policy back with get_my_policy to see what is actually there.`,
  }
}

/**
 * Phases 2 and 3, shared by write_policy and update_policy: pick the quote, stop at the price unless a person has agreed,
 * pay through the wallet's own capped payer, bookmark the receipt, and poll the collect. Nothing here knows which write it
 * is except the route it pays to, the operation it bookmarks, and the words it uses.
 */
async function runPaidFlow(
  deps: WritePolicyDeps,
  client: PolicyWriteClient,
  a: {
    request: AdoptTemplateRequest | UpdateRequest
    route: WriteRoute
    operation: PolicyWriteOperation
    policyKey: string
    interpretation: string[]
    dryRun: boolean
    confirmed: boolean
    canWrite: boolean
    challenge: { accepts?: unknown[] }
    pollBudgetMs: number
    tool: 'write_policy' | 'update_policy'
    verb: 'write' | 'update'
  },
): Promise<WritePolicyResult> {
  const { policyKey, interpretation, dryRun, confirmed, canWrite } = a
  // ── Phase 2. The wallet's own capped payer builds the header; nothing here signs. ───────────
  const accepts = (a.challenge.accepts ?? []) as Accept[]
  const accept = deps.chooseAccept(accepts)
  if (!accept) {
    return unavailable('The service quoted a price but offered no payment option this wallet can use.')
  }

  // Without `confirm: true` the call stops at the price, exactly like a dry run. Paying writes a spending limit, which can lift
  // the wallet's own default cap, so it needs a person's yes, not just the agent's call.
  if (!canWrite) {
    // Every free check has passed and the service has named its price. Stop HERE: nothing below
    // this line pays, and nothing pays without going through `deps.pay`. The price comes from the
    // 402 itself — the one authoritative figure, since an admin pricing row can override the
    // service's compiled-in fallback.
    const asset = clip(String(accept.asset ?? ''), 100)
    const amount = clip(String(accept.maxAmountRequired ?? ''), 40)
    const extra = (accept.extra ?? {}) as Record<string, unknown>
    let amountHuman: string | undefined
    if (deps.describeAmount && amount !== '') {
      // A failed lookup costs the friendly form and nothing else — the quote stands without it.
      amountHuman = await deps.describeAmount(asset, amount).then(
        (text) => clip(text, 120),
        () => undefined,
      )
    }
    // A failed check is an UNKNOWN, stated as such — never silence, which reads as "fine".
    let affordability: Affordability | undefined
    if (deps.checkAffordability) {
      affordability = await deps.checkAffordability(accept).catch(
        (): Affordability => ({
          verdict: 'unknown',
          fee: { status: 'unknown', required: amount },
          gas: { status: 'unknown' },
          // No `cap`: an invented one reads, to a structured consumer, as "no cap key matches this asset".
          feeNotEstimated: false,
          problems: ['Whether this wallet can afford it could not be checked.'],
          notChecked: ['The affordability check itself failed, so nothing about balances or the cap is known.'],
        }),
      )
    }
    const worded = affordability ? affordabilityWords(affordability) : undefined
    return {
      state: 'quoted',
      paid: false,
      ...(!dryRun && !confirmed ? { needsConfirmation: true as const } : {}),
      policyKey: policyKey,
      interpretation,
      quote: {
        asset,
        amount,
        ...(amountHuman ? { amountHuman } : {}),
        ...(typeof accept.payTo === 'string' ? { payTo: clip(accept.payTo, 100) } : {}),
        ...(typeof extra.gasModel === 'string' ? { gasModel: clip(extra.gasModel, 40) } : {}),
      },
      ...(affordability ? { affordability } : {}),
      message:
        `QUOTE ONLY — nothing was paid and nothing was written. The service asked for ` +
        `${amountHuman ?? `${amount} of ${asset}`} to ${a.verb} this policy. That is what it asked for ` +
        `just now: it can change, and it is not a promise the payment will be allowed, because ` +
        (worded
          ? `balances can change and the payment cap is enforced again when paying. ${worded} `
          : `the wallet's payment cap is applied only when paying. `) +
        (!dryRun && !confirmed
          ? `A policy is a spending limit, so a person must agree to it first: show the user what it means (interpretation) and the price, and only after they say yes call ${a.tool} again with confirm: true. Never pass confirm on your own judgement.` +
            (affordability?.verdict === 'not_affordable' ? ' Fix the affordability problem above first.' : '')
          : affordability?.verdict === 'not_affordable'
            ? 'Fix that, then ask again without dryRun to deploy.'
            : 'Ask again without dryRun to deploy.'),
    }
  }

  let paymentHeader: string
  try {
    paymentHeader = await deps.pay(accept)
  } catch (err) {
    // The signature is the last step before the X-PAYMENT header exists, so a refusal here means nothing was
    // presented for payment: the free pre-check had passed and nothing else had happened. A denial is a decision
    // (`refused`); a check that could not complete is transient (`unavailable`). Everything else still throws.
    const refusal = toPaymentPolicyError(err)
    if (!refusal) throw err
    return {
      state: refusal.kind === 'denied' ? 'refused' : 'unavailable',
      policyKey: policyKey,
      paid: false,
      interpretation,
      ...policyRefusalFlags(refusal),
      message: describePolicyRefusal(refusal, 'No policy was written. The free pre-check had passed.'),
    }
  }
  const paid = await client.pay(a.request, paymentHeader, a.route)

  if (paid.kind === 'refused') {
    return {
      state: 'payment_refused',
      policyKey: policyKey,
      message:
        `The payment was presented and the service refused it: ${paid.detail}. No policy was ` +
        `written. Whether the fee was taken is not stated by this response either way.`,
    }
  }
  if (paid.kind === 'paid_untrackable') {
    // The service ANSWERED, and accepted the money, and named no receipt. Reported as its own
    // thing rather than as a network failure, because the recovery is different: there is nothing
    // to retry and nothing to poll, and the next ask for this policyKey is what recovers it.
    return {
      state: 'unknown',
      policyKey: policyKey,
      paid: true,
      message:
        `PAYMENT MADE. The service accepted it but returned no receipt, so this wallet cannot ` +
        `follow the write and holds nothing it could collect. It should still be completed on the service's side. Do not pay ` +
        `again. Asking to ${a.verb} this same policyKey again is free: the service may say the write is still in progress. ` +
        `Read the policy back later with get_my_policy to see whether it took effect, and quote this to support if it did not. ` +
        `(${paid.detail})`,
    }
  }
  if (paid.kind === 'unreachable') {
    // Genuinely no answer. The payment may or may not have landed; never claim either.
    return {
      state: 'unknown',
      policyKey: policyKey,
      message:
        `A payment was sent and the service could not be reached afterwards, so it is NOT known ` +
        `whether it landed, and this wallet holds no receipt. Do not pay again. Asking for this same policyKey again is free: ` +
        `the service may say a write is still in progress. Read the policy back later with get_my_policy to see whether it ` +
        `took effect. (${paid.detail})`,
    }
  }

  // Bookmark FIRST, poll second. A crash between the 202 and the first poll must not lose the
  // handle on a write that has been paid for.
  const verify = verifyFor(a.request)
  const receipt: PolicyWriteReceipt = {
    blobId: paid.blobId,
    policyKey: policyKey,
    ownerAddress: deps.ownerAddress,
    paidAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(a.operation === 'UPDATE' ? { operation: a.operation } : {}),
    ...(verify ? { verify } : {}),
  }
  // A newer paid write for this key supersedes the older receipts: from now on the chain can no longer tell them apart, so they
  // stop being checked against it.
  for (const older of await deps.receipts.list()) {
    if (older.policyKey === policyKey && older.blobId !== receipt.blobId) await dropVerify(deps, older)
  }
  await deps.receipts.set(receipt)

  // interpretation rides EVERY outcome, including a clean write. The field doc says "every
  // result" and round 1 attached it on two branches only, which is the same shape of defect as
  // the finding this round fixes.
  return { ...(await pollCollect(deps, client, receipt, a.pollBudgetMs)), interpretation }
}

export interface CheckPolicyWriteInput {
  /** Which receipt to resume. Omitted, the most recent pending one is used. */
  paymentReceipt?: string
  pollBudgetMs?: number
}

/**
 * Resume phase 3 from a stored receipt. Never pays, under any circumstance — this tool exists
 * precisely so that "check on my policy write" cannot cost money.
 */
export async function checkPolicyWrite(
  deps: WritePolicyDeps,
  input: CheckPolicyWriteInput = {},
): Promise<WritePolicyResult> {
  if (!deps.client) {
    return unavailable(`No policy write service is configured for ${deps.network ?? 'this network'}.`)
  }

  let receipt: PolicyWriteReceipt | null = null
  if (input.paymentReceipt) {
    receipt = await deps.receipts.get(input.paymentReceipt)
    if (!receipt) {
      // Not an error state to act on: the server may still hold it. Say what is true.
      return unavailable(
        `This wallet holds no record of receipt "${input.paymentReceipt}". That does not mean the ` +
          `write failed — the service completes a paid write on its own. Asking to write or update the same policyKey ` +
          `again is free and the service may say it is still in progress; read the policy back later with get_my_policy.`,
      )
    }
  } else {
    const pending = await deps.receipts.list()
    receipt = pending[0] ?? null
    if (!receipt) {
      return unavailable('There are no pending policy writes to check — nothing is waiting to be collected.')
    }
    if (pending.length > 1) {
      // Newest first is a reasonable default and a bad silence: a `write_failed` receipt is kept
      // deliberately (support needs the id) and never expires, so the newest can easily be a dead
      // one sitting in front of an older write that is still settling (APP-L06). Say so rather
      // than quietly choosing.
      const others = pending.slice(1).map((r) => `${r.policyKey} (${r.blobId})`).join(', ')
      const result =
        (await checkChainFirst(deps, receipt)) ?? (await pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS))
      return {
        ...result,
        message:
          `${result.message} NOTE: ${pending.length} paid-for writes are on file and this checked the ` +
          `most recent one only. The others are: ${others}. Check each by passing its receipt.`,
      }
    }
  }

  return (await checkChainFirst(deps, receipt)) ?? pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS)
}

/**
 * A receipt that carries what the chain should show is looked at on chain FIRST: a write that already landed needs no collect, and a
 * collect that is not needed spends one of the service's few retries for nothing. Anything but a clear "applied" falls through to the
 * collect exactly as before.
 */
async function checkChainFirst(deps: WritePolicyDeps, receipt: PolicyWriteReceipt): Promise<WritePolicyResult | undefined> {
  const shows = await chainShows(deps, receipt)
  if (shows.kind !== 'applied') return undefined
  return appliedFromChain(deps, receipt, shows, 'No collect was needed:')
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// update_policy — replace a policy's attributes and validity window, paying the update fee with x402.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface UpdatePolicyInput {
  policyKey: string
  /** The FULL replacement set: an update replaces the attributes, it does not merge into them. */
  attributes: Array<{ attributeName: string; attributeType?: string; value?: string; valueHuman?: string | number }>
  /** See {@link WritePolicyInput.amountUnit}. */
  amountUnit?: string
  /**
   * The validity window. When omitted the policy's CURRENT bound is carried forward: the service does not default an
   * omitted bound on update, so sending nothing would silently strip an existing expiry.
   */
  validFromBlock?: string
  validToBlock?: string
  /**
   * The policy's `updatedAtBlock` as the caller read it (`get_my_policy`, `forUpdate.expectedUpdatedAtBlock`). If the
   * policy has changed since, the update is refused before anything is paid.
   */
  expectedUpdatedAtBlock: string | number
  pollBudgetMs?: number
  /** See {@link WritePolicyInput.dryRun}. */
  dryRun?: boolean
  /** See {@link WritePolicyInput.confirm}. Must be exactly `true` to pay. */
  confirm?: boolean
}

/**
 * A validity bound the caller named, read strictly. `undefined` and `null` both mean "not named": tool arguments are not
 * validated against the schema, and an agent sending `null` for an optional field must not strip an existing expiry. Anything that
 * is present must be a whole block number, as digits; a malformed bound is refused for free rather than sent.
 */
function boundInput(value: unknown): { kind: 'omitted' } | { kind: 'value'; value: string } | { kind: 'invalid' } {
  if (value === undefined || value === null) return { kind: 'omitted' }
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return { kind: 'value', value }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { kind: 'value', value: String(value) }
  return { kind: 'invalid' }
}

function blockString(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value !== '') return value
  return undefined
}

export async function updatePolicy(deps: WritePolicyDeps, input: UpdatePolicyInput): Promise<WritePolicyResult> {
  const client = deps.client
  if (!client) {
    return unavailable(
      `No policy write service is configured for ${deps.network ?? 'this network'}, so nothing was ` +
        `attempted and nothing was paid.`,
    )
  }
  if (typeof input?.policyKey !== 'string' || input.policyKey === '') {
    return unavailable('policyKey is required — it names the policy to update.')
  }
  if (!Array.isArray(input?.attributes) || input.attributes.length === 0) {
    return unavailable(
      'attributes are required: an update replaces the whole set, so an empty one would leave the policy restricting ' +
        'nothing. To lift the limits entirely, that is remove_policy.',
    )
  }
  const expected = blockString(input.expectedUpdatedAtBlock)
  if (expected === undefined || !/^\d+$/.test(expected)) {
    return unavailable(
      'expectedUpdatedAtBlock is required, as a block number: read it from get_my_policy (forUpdate.expectedUpdatedAtBlock). ' +
        'It is how an update is refused, free, if the policy changed since you read it.',
    )
  }
  if (!deps.readPolicy) {
    return unavailable(
      'This wallet cannot read the current policy, so it cannot check an update against it. Nothing was paid.',
    )
  }

  // ── Read the policy first, free. It supplies the template the update is typed against, the bounds to carry forward,
  //    and the earliest possible "it is not there" or "it changed". The service checks all of it again, and wins.
  const current = await deps.readPolicy(input.policyKey)
  if ('error' in current) {
    return unavailable(`The current policy could not be read (${clip(current.detail)}), so it was not updated. Nothing was paid.`)
  }
  if (current.found === false) {
    return {
      state: 'not_found',
      policyKey: input.policyKey,
      message:
        `There is no policy "${input.policyKey}" for this wallet to update. Nothing was paid. Check the key with ` +
        `get_my_policy; write_policy creates a new one.`,
    }
  }
  const record = current.value.policy
  const onChainBlock = blockString(record.updatedAtBlock)
  if (onChainBlock === undefined) {
    return unavailable(
      `The policy was read but carried no updatedAtBlock, so the update cannot be checked for staleness and was not attempted. Nothing was paid.`,
    )
  }
  if (onChainBlock !== expected) {
    return {
      state: 'modified',
      policyKey: input.policyKey,
      message:
        `The policy "${input.policyKey}" has changed since it was read: it was last updated at block ${onChainBlock}, and you ` +
        `passed ${expected}. Read it again with get_my_policy, show the user what it holds now, and update from that. ` +
        `Nothing was paid.`,
    }
  }
  const templateId = typeof record.templateId === 'string' && record.templateId !== '' ? record.templateId : undefined
  if (!templateId) {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      message:
        `The policy "${input.policyKey}" references no template, so this wallet cannot check an update against one and ` +
        `will not pay for one it cannot check. Nothing was paid.`,
    }
  }
  const contract = typeof record.templateContractAddress === 'string' ? record.templateContractAddress : undefined
  if (contract !== undefined && contract !== '' && contract !== deps.templateContract) {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      message:
        `The policy references the template contract "${contract}", which is not the Template contract this wallet is ` +
        `configured for ("${deps.templateContract}"), so an update would be checked against a different template from the ` +
        `one it is written against. Refused before any payment. Nothing was paid.`,
    }
  }

  const fromBound = boundInput(input.validFromBlock)
  const toBound = boundInput(input.validToBlock)
  if (fromBound.kind === 'invalid' || toBound.kind === 'invalid') {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      message:
        `validFromBlock and validToBlock must each be a whole block number written as digits ("0" for no limit), or left out to ` +
        `keep the policy's current one. A bound that is not one is refused rather than sent, because an omitted bound is carried ` +
        `forward but a malformed one could strip an existing expiry. Nothing was paid.`,
    }
  }
  const carriedFrom = fromBound.kind === 'omitted' ? blockString(record.validFromBlock) : undefined
  const carriedTo = toBound.kind === 'omitted' ? blockString(record.validToBlock) : undefined
  const validFromBlock = fromBound.kind === 'value' ? fromBound.value : carriedFrom
  const validToBlock = toBound.kind === 'value' ? toBound.value : carriedTo

  // ── Preflight, BEFORE the service is contacted: the same check write_policy runs, against the policy's own template.
  const checked = await deps.preflight({
    policyKey: input.policyKey,
    attributes: input.attributes,
    validFromBlock: validFromBlock ?? '0',
    validToBlock: validToBlock ?? '0',
    templateId,
    ...(input.amountUnit !== undefined ? { amountUnit: input.amountUnit } : {}),
  })
  const interpretation = [
    ...(carriedFrom !== undefined || carriedTo !== undefined
      ? [
          // Only what was actually carried: a bound the caller named is theirs, not "kept".
          `The validity window ${carriedFrom !== undefined && carriedTo !== undefined ? 'was not changed' : 'is only partly changed'}: ` +
            [
              carriedFrom !== undefined ? `validFromBlock is kept as it is now (block ${carriedFrom})` : undefined,
              carriedTo !== undefined ? `validToBlock is kept as it is now (block ${carriedTo})` : undefined,
            ]
              .filter((s) => s !== undefined)
              .join(' and ') +
            `; name ${carriedFrom !== undefined && carriedTo !== undefined ? 'validFromBlock / validToBlock' : 'it'} to change it.`,
        ]
      : []),
    ...checked.interpretation,
  ]
  if (!checked.ready) {
    return {
      state: 'refused',
      policyKey: input.policyKey,
      blockers: checked.blockers,
      interpretation,
      message:
        `This update was refused by the free pre-flight check, so NOTHING WAS PAID. Fix these and ` +
        `ask again: ${checked.blockers.join(' ')}`,
    }
  }

  const attributes = toWireAttributes(input.attributes, checked.convertedAmounts)
  if (!attributes) return { state: 'refused', policyKey: input.policyKey, interpretation, message: NO_WIRE_VALUE }
  const request: UpdateRequest = {
    ownerAddress: deps.ownerAddress,
    policyKey: input.policyKey,
    attributes,
    ...(validFromBlock !== undefined ? { validFromBlock } : {}),
    ...(validToBlock !== undefined ? { validToBlock } : {}),
    expectedUpdatedAtBlock: expected,
  }

  const dryRun = isDryRun(input.dryRun)
  const confirmed = input.confirm === true
  const canWrite = confirmed && !dryRun
  const pre = await client.precheckUpdate(request)

  switch (pre.kind) {
    case 'not_found':
      return {
        state: 'not_found',
        policyKey: input.policyKey,
        interpretation,
        message: `The service says there is no policy "${input.policyKey}" to update (${clip(pre.detail)}). Nothing was paid.`,
      }
    case 'modified':
      return {
        state: 'modified',
        policyKey: input.policyKey,
        interpretation,
        message:
          `The service says the policy has changed since it was read (${clip(pre.detail)}). Read it again with get_my_policy, ` +
          `show the user what it holds now, and update from that. Nothing was paid.`,
      }
    case 'template_unavailable':
      return {
        state: 'template_unavailable',
        policyKey: input.policyKey,
        interpretation,
        message:
          `The template this policy references is no longer available (${clip(pre.detail)}), so the update cannot be checked ` +
          `against it. Nothing was paid, and the policy is unchanged.`,
      }
    case 'in_progress':
      return {
        state: 'refused',
        policyKey: input.policyKey,
        interpretation,
        message: IN_PROGRESS_MESSAGE(clip(pre.detail)),
      }
    case 'refused':
      return {
        state: 'refused',
        policyKey: input.policyKey,
        interpretation,
        message: `The update was refused before any payment: ${pre.detail}. Nothing was paid.`,
      }
    case 'unreachable':
      return unavailable(`The policy write service could not be reached (${pre.detail}). Nothing was paid.`)
    case 'already_in_flight':
      return recoverInFlight(deps, client, {
        pre,
        policyKey: input.policyKey,
        interpretation,
        canWrite,
        dryRun,
        pollBudgetMs: input.pollBudgetMs ?? DEFAULT_BUDGET_MS,
        tool: 'update_policy',
      })
    case 'payment_required':
      return runPaidFlow(deps, client, {
        request,
        route: 'update',
        operation: 'UPDATE',
        policyKey: input.policyKey,
        interpretation,
        dryRun,
        confirmed,
        canWrite,
        challenge: pre.challenge,
        pollBudgetMs: input.pollBudgetMs ?? DEFAULT_BUDGET_MS,
        tool: 'update_policy',
        verb: 'update',
      })
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// remove_policy — remove a policy. FREE, one call, and it lifts every limit the policy set.
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RemovePolicyInput {
  policyKey: string
  /** Must be exactly `true`. Anything else stops before anything is sent: removing is a person's decision. */
  confirm?: boolean
  /** Milliseconds to keep reading the chain for the policy to disappear. */
  pollBudgetMs?: number
}

export interface RemovePolicyResult {
  /**
   * `removed` ONLY when a chain read shows the policy gone. `submitted` is a transaction on its way, not a removal.
   */
  state: 'needs_confirmation' | 'removed' | 'submitted' | 'not_found' | 'in_progress' | 'refused' | 'unavailable'
  message: string
  policyKey?: string
  txHash?: string
  /** On `needs_confirmation`: the attributes about to be removed, when the policy could be read. */
  currentAttributes?: Array<{ attributeName: string; value: string }>
}

const DEFAULT_REMOVE_BUDGET_MS = 45_000

/** The consequence a person must understand before agreeing. Said on every unconfirmed answer. */
const REMOVE_CONSEQUENCE =
  'Removing a policy removes every limit it set, and Wallet BE will then sign spends of that asset without any limit.'

const NEVER_TWICE =
  'Calling remove_policy again is expected to be safe: the service is expected not to submit a second removal for a policy that is already being removed.'

/** A paid write for this policy is being completed by the service and the wallet has no receipt to collect: say so, and do not promise one. */
const IN_PROGRESS_MESSAGE = (detail: string): string =>
  `A write for this policy has ALREADY BEEN PAID FOR and is still being completed by the service (${detail}). Do not pay again, ` +
  `and nothing was paid by this call. If this wallet holds its receipt, check_policy_write finishes it; otherwise wait and ` +
  `read the policy back later with get_my_policy to see whether it took effect.`

export async function removePolicy(deps: WritePolicyDeps, input: RemovePolicyInput): Promise<RemovePolicyResult> {
  const client = deps.client
  if (!client) {
    return {
      state: 'unavailable',
      message: `No policy write service is configured for ${deps.network ?? 'this network'}, so nothing was attempted.`,
    }
  }
  if (typeof input?.policyKey !== 'string' || input.policyKey === '') {
    return { state: 'unavailable', message: 'policyKey is required — it names the policy to remove.' }
  }

  // ── Without a yes, nothing is sent and no password is tried. A read is free and only describes what would go.
  if (input.confirm !== true) {
    let attributes: RemovePolicyResult['currentAttributes']
    if (deps.readPolicy) {
      const read = await deps.readPolicy(input.policyKey)
      if (!('error' in read) && read.found === false) {
        return {
          state: 'not_found',
          policyKey: input.policyKey,
          message: `There is no policy "${input.policyKey}" for this wallet to remove, so nothing needs to be done. Check with get_my_policy.`,
        }
      }
      if (!('error' in read) && read.found === true) {
        attributes = (read.value.policy.attributes ?? []).slice(0, 20).map((a) => ({
          attributeName: clip(String(a.attributeName ?? ''), 60),
          value: clip(String(a.value ?? ''), 80),
        }))
      }
    }
    return {
      state: 'needs_confirmation',
      policyKey: input.policyKey,
      ...(attributes ? { currentAttributes: attributes } : {}),
      message:
        `NOTHING WAS REMOVED. ${REMOVE_CONSEQUENCE} Show the user what the policy "${input.policyKey}" currently limits` +
        `${attributes ? ' (currentAttributes)' : ''} and what removing it means, and only if they clearly agree call ` +
        `remove_policy again with confirm: true. Never pass confirm on your own judgement.`,
    }
  }

  // ── Confirmed. One free call; the service signs the permit with the owner's key and the password travels with it.
  const result = await client.remove(deps.ownerAddress, input.policyKey, deps.hsmPassword)
  switch (result.kind) {
    case 'not_found':
      return {
        state: 'not_found',
        policyKey: input.policyKey,
        message:
          `The service says there is no policy "${input.policyKey}" to remove (${clip(result.detail)}). Either it never existed ` +
          `or it has already been removed — confirm with get_my_policy before telling the user which.`,
      }
    case 'in_progress':
      return {
        state: 'in_progress',
        policyKey: input.policyKey,
        message:
          `A paid write for "${input.policyKey}" is still being completed (${clip(result.detail)}), so it cannot be removed ` +
          `now. If this wallet holds its receipt, check_policy_write finishes it; otherwise wait and ask again later. Nothing was ` +
          `removed by this call.`,
      }
    case 'refused':
      return {
        state: 'refused',
        policyKey: input.policyKey,
        message: `The removal was refused: ${result.detail}. Nothing was removed.`,
      }
    case 'server_error':
      return {
        state: 'unavailable',
        policyKey: input.policyKey,
        message:
          `${result.gateway ? 'A gateway in front of the policy service answered' : 'The policy service hit an error'} ` +
          `(HTTP ${result.status}), so it is NOT known whether the removal went through. Do not tell the user it did or did ` +
          `not: check with get_my_policy (found:false means it is gone). ${NEVER_TWICE} (${clip(result.detail)})`,
      }
    case 'unreachable':
      return {
        state: 'unavailable',
        policyKey: input.policyKey,
        message:
          `The policy service could not be reached (${result.detail}), so it is NOT known whether the removal went through. ` +
          `Check with get_my_policy (found:false means it is gone). ${NEVER_TWICE}`,
      }
    case 'unrecognised':
      return {
        state: 'unavailable',
        policyKey: input.policyKey,
        message:
          `The policy service answered HTTP ${result.status}, which this wallet does not recognise for a removal, so it is NOT ` +
          `known whether the removal went through. Check with get_my_policy (found:false means it is gone). ${NEVER_TWICE} ` +
          `(${clip(result.detail)})`,
      }
    case 'submitted':
      break
  }

  // ── Submitted is not removed. Read the chain until the policy is gone or the budget runs out.
  const txHash = result.txHash
  const submittedMessage = (why: string): RemovePolicyResult => ({
    state: 'submitted',
    policyKey: input.policyKey,
    ...(txHash ? { txHash } : {}),
    message:
      `The removal of "${input.policyKey}" was SUBMITTED but is not confirmed: ${why} Do NOT tell the user it is removed yet. ` +
      `Check with get_my_policy (found:false means it is gone). ${NEVER_TWICE}`,
  })

  if (!deps.readPolicy) {
    return submittedMessage('this wallet has no way to read the chain, so it cannot confirm it.')
  }
  const budget = Number.isFinite(input.pollBudgetMs) && (input.pollBudgetMs as number) > 0 ? (input.pollBudgetMs as number) : DEFAULT_REMOVE_BUDGET_MS
  const wait = Math.max(1, Math.min(result.retryAfterSeconds, 60)) * 1000
  const started = (deps.now?.() ?? new Date()).getTime()
  let polls = 0
  let waited = 0
  let unreadable = false
  for (;;) {
    const read = await deps.readPolicy(input.policyKey)
    if ('error' in read) {
      unreadable = true
    } else if (read.found === false) {
      return {
        state: 'removed',
        policyKey: input.policyKey,
        ...(txHash ? { txHash } : {}),
        message: `The policy "${input.policyKey}" is removed: the chain no longer holds it. Its limits no longer apply.`,
      }
    } else {
      unreadable = false
    }
    // The clock alone is not a bound: anything that makes sleeping instant leaves it at zero. Time already waited counts too.
    const elapsed = Math.max((deps.now?.() ?? new Date()).getTime() - started, waited)
    if (++polls >= MAX_POLLS || elapsed + wait >= budget) break
    await deps.sleep(wait)
    waited += wait
  }
  return submittedMessage(
    unreadable
      ? 'the chain could not be read to confirm it.'
      : 'the chain still shows the policy, so the block has not confirmed the removal yet.',
  )
}
