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

import type {
  AdoptTemplateRequest,
  CollectResult,
  PolicyWriteClient,
} from '../clients/policy-write-client.js'
import type { PolicyWriteReceipt, PolicyWriteReceiptStore } from '../clients/policy-write-receipt-store.js'
import type { PolicyPreflightResult } from './policy-preflight.js'

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
    attributes: Array<{ attributeName: string; attributeType?: string; value: string }>
    validFromBlock: string
    validToBlock: string
    templateId?: string
  }) => Promise<PolicyPreflightResult>
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
  /** What to tell the user, in one sentence. */
  message: string
  /** Present whenever a payment HAS been made and the write is not finished. Keep it. */
  paymentReceipt?: string
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
  const base = { paymentReceipt: receipt.blobId, policyKey: receipt.policyKey, paid: true as const }
  switch (result.kind) {
    case 'written':
      return {
        state: 'written',
        message: `The policy "${receipt.policyKey}" is on chain.`,
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
          `policy does not exist yet — do not report it as created. Check again shortly with the ` +
          `receipt below. Do not pay again.`,
      }
    case 'settling':
      return {
        ...base,
        state: 'settling',
        message:
          `PAYMENT MADE, settlement still in progress — no policy has been written yet, and this ` +
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
          `The settlement FAILED and this receipt bought nothing. Writing the policy now requires ` +
          `paying again. (${result.detail})`,
      }
    case 'write_failed':
      return {
        ...base,
        state: 'write_failed',
        txHash: result.txHash,
        message:
          `PAYMENT MADE, and the chain then REJECTED the write. Paying again would not help — the ` +
          `cause is on the service's side, not yours. Quote the receipt below to support. ` +
          `(${result.detail})`,
      }
    case 'unknown':
      return {
        ...base,
        state: 'unknown',
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
        message:
          `PAYMENT MADE, and the service answered with something this wallet does not recognise ` +
          `(HTTP ${result.status}). It is not retried, because a failed collect consumes one of a ` +
          `small number of retries for this write. Quote the receipt below to support. ` +
          `(${result.detail})`,
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
    const result = await client.collect(receipt.blobId, receipt.ownerAddress, deps.hsmPassword)
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
    if (last.state === 'write_failed' || last.state === 'unknown') return last

    const waitSeconds = result.kind === 'settling' || result.kind === 'submitted' ? result.retryAfterSeconds : 5
    const elapsed = (deps.now?.() ?? new Date()).getTime() - started
    if (++polls >= MAX_POLLS || elapsed + waitSeconds * 1000 >= budget) return last
    await deps.sleep(waitSeconds * 1000)
  }
}

export interface WritePolicyInput {
  policyKey: string
  attributes: Array<{ attributeName: string; attributeType?: string; value: string }>
  templateContractAddress: string
  templateId: string
  validFromBlock?: string
  validToBlock?: string
  /** Idempotency key. Generated by the caller when absent. */
  requestKey?: string
  /** Milliseconds to keep polling phase 3 before handing back the receipt. */
  pollBudgetMs?: number
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
  if (typeof input.templateContractAddress !== 'string' || typeof input.templateId !== 'string') {
    return unavailable(
      'templateContractAddress and templateId are required — they are what makes this an ADOPT, so ' +
        'the chain type-checks the attributes against the template instead of accepting anything.',
    )
  }

  const request: AdoptTemplateRequest = {
    ownerAddress: deps.ownerAddress,
    policyKey: input.policyKey,
    attributes: input.attributes,
    templateContractAddress: input.templateContractAddress,
    templateId: input.templateId,
    ...(input.validFromBlock !== undefined ? { validFromBlock: input.validFromBlock } : {}),
    ...(input.validToBlock !== undefined ? { validToBlock: input.validToBlock } : {}),
    requestKey: input.requestKey ?? `${deps.ownerAddress}-${input.policyKey}-${(deps.now?.() ?? new Date()).toISOString()}`,
  }

  // ── Phase 1. Free, and the only phase that can refuse without costing anything. ─────────────
  // The template the draft is CHECKED against must be the one it will be WRITTEN against.
  // Otherwise preflight types it against a template nobody is going to use, and the free check
  // says yes to a draft the chain will reject after it has been paid for.
  if (input.templateContractAddress !== deps.templateContract) {
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

  const pre = await deps.client.precheck(request)

  if (pre.kind === 'already_exists') {
    return {
      state: 'already_exists',
      policyKey: input.policyKey,
      interpretation,
      message: `${pre.detail}. Nothing was paid.`,
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
    // A write this owner has ALREADY PAID FOR. Collect it rather than paying again — the guard
    // that stops a hung settlement becoming a second charge only works if the client uses it.
    //
    // But what gets collected is the EARLIER request's content, and this wallet has no way to
    // compare it with what was just submitted: the 409 carries a receipt and a sentence, not the
    // attributes. So the result says so rather than reporting the new draft as written (APP-M02).
    const receipt: PolicyWriteReceipt = {
      blobId: pre.blobId,
      policyKey: input.policyKey,
      ownerAddress: deps.ownerAddress,
      paidAt: (deps.now?.() ?? new Date()).toISOString(),
    }
    await deps.receipts.set(receipt)
    const collected = await pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS)
    return {
      ...collected,
      recoveredEarlierWrite: true,
      interpretation,
      message:
        `${collected.message} IMPORTANT: this did NOT write the attributes just submitted. An ` +
        `EARLIER write under "${input.policyKey}" had already been paid for, and that is the one ` +
        `this collected — the service said: "${clip(pre.detail)}". The attributes now in force are the ` +
        `earlier request's, which this wallet cannot read back, so do not tell the user their new ` +
        `values are live. Read the policy back with get_my_policy to see what is actually there.`,
    }
  }

  // ── Phase 2. The wallet's own capped payer builds the header; nothing here signs. ───────────
  const accepts = (pre.challenge.accepts ?? []) as Accept[]
  const accept = deps.chooseAccept(accepts)
  if (!accept) {
    return unavailable('The service quoted a price but offered no payment option this wallet can use.')
  }

  const paymentHeader = await deps.pay(accept)
  const paid = await deps.client.pay(request, paymentHeader)

  if (paid.kind === 'refused') {
    return {
      state: 'payment_refused',
      policyKey: input.policyKey,
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
      policyKey: input.policyKey,
      paid: true,
      message:
        `PAYMENT MADE. The service accepted it but returned no receipt, so this wallet cannot ` +
        `follow the write. It WILL still be completed on the service's side. Do not pay again — ` +
        `ask to write this same policyKey again and the free pre-check will hand back the receipt ` +
        `if one is still open, or tell you the policy already exists. (${paid.detail})`,
    }
  }
  if (paid.kind === 'unreachable') {
    // Genuinely no answer. The payment may or may not have landed; never claim either.
    return {
      state: 'unknown',
      policyKey: input.policyKey,
      message:
        `A payment was sent and the service could not be reached afterwards, so it is NOT known ` +
        `whether it landed. Do not pay again — ask for this same policyKey again and the service ` +
        `will hand back the receipt if one exists. (${paid.detail})`,
    }
  }

  // Bookmark FIRST, poll second. A crash between the 202 and the first poll must not lose the
  // handle on a write that has been paid for.
  const receipt: PolicyWriteReceipt = {
    blobId: paid.blobId,
    policyKey: input.policyKey,
    ownerAddress: deps.ownerAddress,
    paidAt: (deps.now?.() ?? new Date()).toISOString(),
  }
  await deps.receipts.set(receipt)

  // interpretation rides EVERY outcome, including a clean write. The field doc says "every
  // result" and round 1 attached it on two branches only, which is the same shape of defect as
  // the finding this round fixes.
  return { ...(await pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS)), interpretation }
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
          `write failed — the service completes a paid write on its own. Asking to write the same ` +
          `policyKey again will report it, free, before any payment.`,
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
      const result = await pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS)
      return {
        ...result,
        message:
          `${result.message} NOTE: ${pending.length} paid-for writes are on file and this checked the ` +
          `most recent one only. The others are: ${others}. Check each by passing its receipt.`,
      }
    }
  }

  return pollCollect(deps, deps.client, receipt, input.pollBudgetMs ?? DEFAULT_BUDGET_MS)
}
