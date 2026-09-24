import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildToolList } from '../index'
import { EXPECTED_AGENT_TEXT, MONEY_TOUCHING_TOOLS, splitAgentSentences } from './fixtures/agent-facing-text'

/**
 * Every agent-facing string a tool ships: its own `description`, plus every `description` anywhere
 * inside its `inputSchema`, at any nesting depth (`prove_identity`'s `issuerKeys` has its own
 * nested properties, and a future tool may nest deeper).
 *
 * R11-M02: the money guards and the snapshot used to read ONLY the top-level description of two
 * tools. A property description is shipped to the host LLM verbatim, exactly like the tool
 * description, so a retry endorsement planted in one was invisible to every guard in this file.
 */
function agentStrings(toolName: string): { path: string; text: string }[] {
  const tool = buildToolList().find((t) => t.name === toolName)
  if (!tool) throw new Error(`no such tool: ${toolName}`)
  const out: { path: string; text: string }[] = [{ path: 'description', text: tool.description }]
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return
    const rec = node as Record<string, unknown>
    if (typeof rec.description === 'string') out.push({ path: `${path}.description`, text: rec.description })
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'description') continue
      walk(value, `${path}.${key}`)
    }
  }
  walk(tool.inputSchema, 'inputSchema')
  return out
}

/** Every sentence of every agent-facing string of every tool that can cause or excuse a charge. */
function moneySentences(): { tool: string; path: string; sentence: string }[] {
  return MONEY_TOUCHING_TOOLS.flatMap((tool) =>
    agentStrings(tool).flatMap(({ path, text }) =>
      splitAgentSentences(text).map((sentence) => ({ tool, path, sentence })),
    ),
  )
}

describe('buildToolList', () => {
  it('exposes exactly the 14 agent tools with the correct required inputs', () => {
    const tools = buildToolList()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_ai_birthcert_verification', 'clear_stuck_payment_receipt', 'create_holder_account', 'credential_preflight',
      'get_my_policy', 'get_policy_template_schema', 'get_template_schema', 'pay_and_fetch', 'policy_preflight',
      'prove_identity', 'query_contract', 'request_ai_birthcert_verification', 'subscribe_and_issue',
      'wallet_status',
    ])

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.prove_identity.inputSchema.required).toEqual(['proofRequest'])
    expect(byName.pay_and_fetch.inputSchema.required).toEqual(['url'])
    expect(byName.subscribe_and_issue.inputSchema.required).toEqual(['templateId', 'attributes'])
    expect(byName.subscribe_and_issue.inputSchema.properties.templateId.description).toMatch(/credential_requirements/)
    expect(byName.wallet_status.inputSchema.type).toBe('object')
    expect(byName.create_holder_account.inputSchema.required).toBeUndefined()
    expect(byName.query_contract.inputSchema.required).toEqual(['contractAddress', 'method'])
    expect(byName.get_template_schema.inputSchema.required).toEqual(['templateId'])
    expect(byName.request_ai_birthcert_verification.inputSchema.required).toEqual(['agentName'])
    expect(byName.check_ai_birthcert_verification.inputSchema.type).toBe('object')
  })

  it('does not expose a password parameter on create_holder_account', () => {
    const tool = buildToolList().find((t) => t.name === 'create_holder_account')
    expect(tool?.inputSchema.properties.password).toBeUndefined()
  })

  it('does not tell the agent anything about a password', () => {
    const tool = buildToolList().find((t) => t.name === 'create_holder_account')
    expect(tool?.description).not.toMatch(/password/i)
  })

  it('advertises get_template_schema as free of payment', () => {
    const tool = buildToolList().find((t) => t.name === 'get_template_schema')
    expect(tool?.description).toMatch(/free|no payment/i)
  })

  // The tool can now come back with settlementPending instead of a session. The agent has
  // to be told that this means the payment SUCCEEDED and is still settling — in the 18 Sep 2026 QA
  // run it read a live settlement as "the payment failed" and told the user so.
  // Check_ can now replay a stuck receipt, which CREATES a session. It still never pays,
  // but "starts nothing" became false — and an agent that believes it is inert will not reach for it
  // when it is the tool that actually unblocks the user.
  // Support must be able to unblock a stuck user without shell access on the gateway.
  // In the QA run the agent paid without re-checking a balance the user had just topped up.
  // credential_preflight is free; the tool it guards is not.
  it('request_ai_birthcert_verification tells the agent to run credential_preflight first', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/credential_preflight/)
  })

  it('registers clear_stuck_payment_receipt with confirmReceiptId as the only input', () => {
    const tool = buildToolList().find((t) => t.name === 'clear_stuck_payment_receipt')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.properties.confirmReceiptId).toBeDefined()
    expect(tool?.inputSchema.required ?? []).not.toContain('confirmReceiptId')
  })

  it('clear_stuck_payment_receipt is described as destructive and confirmation-gated', () => {
    const tool = buildToolList().find((t) => t.name === 'clear_stuck_payment_receipt')
    expect(tool?.description).toMatch(/cannot be undone|unrecoverable|forfeit/i)
    expect(tool?.description).toMatch(/confirm/i)
    // The agent must not reach for this as a generic retry — it destroys a real payment.
    expect(tool?.description).toMatch(/last resort|only.*stuck|do not use/i)
  })

  it('check_ai_birthcert_verification is described as free but no longer as starting nothing', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.description).toMatch(/free|never pays|spends nothing/i)
    expect(tool?.description).not.toMatch(/starts nothing/i)
    expect(tool?.description).toMatch(/settlement_pending/)
  })

  // APP-L03: advancing a queued settlement can block for the whole wait budget. A tool the agent
  // believes is an instant read, that occasionally takes 90s, reads as a hang.
  it('check_ai_birthcert_verification warns that advancing a settlement can take up to ~90s', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.description).toMatch(/90s|90 seconds/i)
  })

  it('request_ai_birthcert_verification documents the settlementPending result as a success, not a failure', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/settlementPending/)
    expect(tool?.description).toMatch(/check_ai_birthcert_verification/)
    expect(tool?.description).toMatch(/do not pay again|never pay again/i)
  })

  // R2-M04. The descriptions are the half of this fix the host agent actually reads, and they had
  // no coverage at all — reverting them to the old "payment is safe and unspent" wording left the
  // suite green. The agent in the live incident invented its own explanation of the tool precisely
  // because the description left room for one.
  it.each(['request_ai_birthcert_verification', 'check_ai_birthcert_verification'])(
    '%s tells the agent how to handle a refusal, and never to claim the fee was not taken',
    (name) => {
      const description = buildToolList().find((t) => t.name === name)?.description ?? ''

      // The discriminant, and that it is NOT a settlement problem.
      expect(description).toMatch(/issuerRejected/)
      expect(description).toMatch(/not what failed/i)
      // Relay their reason rather than narrating a settlement.
      expect(description).toMatch(/relay that reason/i)
      // SPEC.md §6: no path may state or imply the user was not charged.
      expect(description).toMatch(/never tell the user they were not charged/i)
      expect(description).not.toMatch(/payment is safe|unspent|has not been spent|funds are safe/i)
    },
  )

  // R5-M01/R5-M02. Reverse-applying the whole src/index.ts hunk that added paymentInvalid and
  // stuckFor wording left all 942 tests green — nothing pinned any of these newer sentences.
  // That gap is exactly how R5-M01 (a wrong affirmative money claim on the plain still-settling
  // case) got through undetected. These pin the specific properties that bit before.
  it.each(['request_ai_birthcert_verification', 'check_ai_birthcert_verification'])(
    '%s documents paymentInvalid distinctly from issuerRejected, guarding both directions',
    (name) => {
      const description = buildToolList().find((t) => t.name === name)?.description ?? ''

      expect(description).toMatch(/paymentInvalid/)
      // paymentInvalid is specifically about the payment, unlike issuerRejected -- the
      // description must say so, not silently reuse issuerRejected's framing.
      expect(description).toMatch(/this verdict IS about the payment/i)
      // Both directions guarded for paymentInvalid, not just the one issuerRejected guards.
      expect(description).toMatch(/never tell them they WERE charged/i)
    },
  )

  // R5-M01: the exact wrong claim that shipped and was caught in review -- asserting the fee is
  // definitely taken for the plain still-settling bucket, which also covers a 5xx/timeout case
  // where the wallet genuinely does not know the outcome (SettlementOutcomeUnknownError's own
  // docstring: "we don't know whether the settlement actually failed or is merely still in
  // flight"). Must never reappear on either surface.
  it.each(['request_ai_birthcert_verification', 'check_ai_birthcert_verification'])(
    '%s never claims the fee is definitely taken for the plain still-settling case',
    (name) => {
      const description = buildToolList().find((t) => t.name === name)?.description ?? ''
      expect(description).not.toMatch(/fee is definitely already taken/i)
      expect(description).not.toMatch(/definitely already taken and saying so is correct/i)
    },
  )

  // check_-only: stuckFor is emitted on BOTH issuerRejected and paymentInvalid results (see the
  // orchestrator's '...(age?.stuck ? { stuckFor: ... } : {})' on both branches), so the
  // description must say so for both, not just one.
  it('check_ai_birthcert_verification documents stuckFor for both issuerRejected and paymentInvalid', () => {
    const description = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')?.description ?? ''
    expect(description).toMatch(/stuckFor may appear alongside EITHER issuerRejected or paymentInvalid/i)
  })

  // R6-M01. The umbrella sentence describing the plain settlementPending result was rewritten to
  // "the payment SUCCEEDED" and left unscoped, so it applied to issuerRejected/paymentInvalid too
  // -- reachable and shipped: a test in this same suite asserts settlementPending AND paymentInvalid
  // together on a rejected 402. "Succeeded" now belongs ONLY to the plain no-flags-set case; the
  // other two must actively deny it, not just omit the claim, per the same pattern as R5-M01's guard.
  it('request_ai_birthcert_verification scopes the payment-succeeded claim to the plain case only', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    // The umbrella intro must not claim success before the three cases are even told apart.
    expect(description).not.toMatch(/the payment SUCCEEDED and no session exists yet/i)
    // The no-flags-set branch no longer claims success either (R8-M02: it is a union of a confirmed
    // still-clearing state and an indeterminate one) -- it tells the agent to read `message`...
    expect(description).toMatch(/With neither set, do NOT assume the payment is known to have succeeded/i)
    // ...and success is actively denied for the two rejection branches, not merely left unmentioned.
    expect(description).toMatch(/do NOT describe this as the payment having succeeded/i)
    expect(description).toMatch(/do NOT describe it as a success either/i)
  })

  // LOW from the same round: "do not call this tool again to retry" used to cover the
  // insufficient-funds/payment-cap error too, where retrying after the user tops up is the
  // correct recovery -- safe direction (never over-pays) but wrong advice.
  it('request_ai_birthcert_verification says retrying is fine once an insufficient-funds error is fixed', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    expect(description).toMatch(/calling this tool again is the right next step/i)
  })

  // R7-C01 / R8-M01. The R6-LOW#1 retry-advice fix was too broad: it endorsed retrying on ANY
  // { error } result. requestAiBirthcertVerification returns { error } on several branches other
  // than insufficient-funds/payment-cap -- blob_already_settled, a receipt that failed to save
  // locally, RECEIPT VOID and OUTCOME UNKNOWN among them -- and on each of those a payment may
  // already have been sent, so retrying without the user's consent pays the fee again. Reachable:
  // the wallet's own RECEIPT VOID message says the opposite ("THIS CALL MAY ITSELF HAVE SENT A
  // PAYMENT") of what the old unscoped retry advice told the agent.
  //
  // R8-M01: the original version of this test (and a sibling positional/"structural" test) only
  // checked that each branch name and each caveat phrase appeared SOMEWHERE in the description --
  // never that they were connected. Proven insufficient by three reworded mutants that all passed
  // the full suite, the most dangerous being: narrow the caveat to cover ONLY RECEIPT VOID, and add
  // "retry freely" for the other three money-at-risk branches, while keeping every literal phrase
  // these tests keyed on. That reintroduces the exact double-charge risk this finding exists to
  // prevent, on 3 of 4 branches, completely undetected by a presence-only check.
  //
  // Fixed with real co-occurrence, not presence or position: for every place retrying is endorsed
  // as fine, no dangerous branch name may be nearby; for every dangerous branch name, a consent
  // caveat must be nearby. "Nearby" is a bounded character window on both sides, not "anywhere in
  // the document" (too loose -- proven above) and not "before/after one fixed marker" (also proven
  // too loose -- a mutant can reorder around a marker just as easily as reword one phrase).
  const DANGEROUS_ERROR_BRANCHES = [
    'blob_already_settled',
    'could not be saved locally',
    'RECEIPT VOID',
    'OUTCOME UNKNOWN',
  ]
  const CONSENT_CAVEAT = /do NOT retry|pays the fee AGAIN|explicit agreement/i
  // A word list can never be provably complete for prose, so this is deliberately broad and
  // stem-based, and was verified against several distinct rewordings of the regression (see the
  // R8-M01 note above) rather than assumed. Two shapes: a retry verb near a permissive word
  // ("Retrying freely", "call again … is fine", "simply try again"), and a permissive word near a
  // retry verb ("fine after", "safe to retry", "OK to call"). Case-insensitive; "do NOT retry" and
  // "must not pay again" contain no permissive word so are not caught.
  //
  // R9-M01 widened both halves. A mutant that added a whole new sentence ("...so go ahead and issue
  // the request a second time without stopping to ask") matched neither half: "issue ... a second
  // time" was not in the retry-verb list and "go ahead"/"without stopping to ask" was not in the
  // permissive list. Both lists now cover those shapes. Still a word list, so still not provably
  // complete -- what it now provably catches is every rewording tried in R8 and R9, and the
  // NO_CHARGE_CLAIM guard below covers the same mutant a second way, through its money claim rather
  // than its retry wording.
  const RETRY_VERB =
    /\b(retry|retrying|resubmit|call(ing)? (this tool )?again|try(ing)? again|(issue|request|call|submit|send|pay|buy|purchase)(ing)?[^.;]{0,30}\b(again|a second time|afresh|anew)|proceed(ing)? (anyway|regardless|without))\b/i
  const PERMISSIVE =
    /\b(freely|fine|safe|ok|okay|allowed|permitted|simply|just|go ahead|right next step|no need to ask|without (asking|stopping|confirming|checking with)|on their behalf without)\b/i
  const RETRY_ENDORSEMENT = new RegExp(
    `(?:${RETRY_VERB.source})[^.;]{0,80}(?:${PERMISSIVE.source})` +
      `|(?:${PERMISSIVE.source})[^.;]{0,80}(?:${RETRY_VERB.source})` +
      `|is the right next step`,
    'i',
  )
  /** Sentence split that does not break on "e.g." / "i.e." / an ellipsis -- splitting there detaches
   * an endorsement from the words that scope it, which silently weakens every sentence-level check
   * below. Shared with the reviewed snapshot (R11-M02) so a guard can never be reasoning over
   * different units than the snapshot pins. */
  const splitSentences = splitAgentSentences
  /** Generous on purpose: the shared caveat clause follows a FOUR-item list, so it can sit this far
   * from any single item's own mention without that being a problem -- the window exists to catch
   * a caveat that has moved somewhere else entirely, not to demand tight prose. */
  const WINDOW = 500

  it('request_ai_birthcert_verification: every dangerous error branch has a consent caveat nearby, not just present somewhere', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    for (const branch of DANGEROUS_ERROR_BRANCHES) {
      // EVERY occurrence, not just indexOf's first (R9-M01): a mutant left the original mention
      // untouched and added a SECOND one, further down, telling the agent to pay again. Checking only
      // the first occurrence could never see it.
      const positions: number[] = []
      for (let at = description.indexOf(branch); at !== -1; at = description.indexOf(branch, at + 1)) positions.push(at)
      expect(positions.length, `expected "${branch}" to be named in the description at all`).toBeGreaterThan(0)
      for (const at of positions) {
        const scope = description.slice(Math.max(0, at - 100), at + WINDOW)
        expect(scope, `no consent caveat found near the occurrence of "${branch}" at ${at}`).toMatch(CONSENT_CAVEAT)
      }
    }
  })

  it('request_ai_birthcert_verification: no sentence endorsing a retry also names a dangerous branch', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    // Sentence-level, not a fixed character window: the safe branches (insufficient funds / cap) and
    // the dangerous ones are deliberately ADJACENT sentences ("...is the right next step. Several
    // OTHER { error } shapes mean the opposite: ..."), so any distance-based window either flags the
    // correct text or lets a real regression through. A sentence boundary is the actual signal.
    const sentences = description.split(/(?<=[.!?])\s+/)
    const endorsing = sentences.filter((s) => RETRY_ENDORSEMENT.test(s.replace(/whether retrying is safe/gi, '')))
    expect(endorsing.length, 'expected at least one retry-is-fine statement (insufficient funds / payment cap)').toBeGreaterThan(0)
    for (const sentence of endorsing) {
      for (const branch of DANGEROUS_ERROR_BRANCHES) {
        expect(sentence, `"${branch}" shares a sentence with a retry-is-fine statement — this is the exact regression`).not.toContain(branch)
      }
    }
  })

  // The second, independent guard. The consent caveat must cover ALL four dangerous branches
  // TOGETHER: one sentence naming every one of them, carrying the prohibition, with no permissive
  // wording. A regression that narrows the caveat to a subset (the reviewer's most dangerous mutant:
  // caveat kept for RECEIPT VOID, "retry freely" for the other three) has to move at least one
  // branch out of this sentence or add permissive wording to it -- the first fails here whatever
  // words the regression uses (it is counting branch names, not matching prose); the second only
  // fails here if RETRY_ENDORSEMENT recognises its wording, which is a word list. The sibling
  // occurrence-scan and NO_CHARGE_CLAIM guards exist because that second half cannot stand alone.
  it('request_ai_birthcert_verification: one sentence names every dangerous branch, prohibits retry, and permits nothing', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    const sentences = description.split(/(?<=[.!?])\s+/)
    const grouped = sentences.filter((s) => DANGEROUS_ERROR_BRANCHES.every((b) => s.includes(b)))
    expect(grouped.length, 'expected exactly one sentence naming all four dangerous branches together').toBe(1)
    expect(grouped[0]).toMatch(CONSENT_CAVEAT)
    expect(grouped[0], 'the sentence that groups the dangerous branches must not also permit a retry').not.toMatch(RETRY_ENDORSEMENT)
  })

  // Success-claim guard (R6-M01 / R8-M02 family). The bad shape was an umbrella sentence asserting the
  // payment succeeded for a result shape that also covers rejected and indeterminate states. A
  // literal-string test only catches one wording of it ("the payment SUCCEEDED and no session exists
  // yet"); "the payment succeeded and there is no session yet" sails through.
  //
  // What this pair does and does not catch, stated precisely (R10-M04 — the previous comment claimed
  // "any sentence that asserts the money reached the other side must itself carry an EXPLICIT denial",
  // which was false: two mutants using only listed NOUNS survived because their PREDICATES were not
  // listed — "the funds are already with the issuer", "the credential service holds the fee ... cleared
  // on chain"):
  //  - EXPLICIT_DENIAL is an enumerated set of denial FRAMES, so it is sound: it cannot be satisfied by
  //    an unrelated negation elsewhere in the sentence.
  //  - SUCCESS_CLAIM is a WORD LIST, and a word list over prose can never be proved complete. It is
  //    best-effort: it now matches in BOTH directions (money noun then arrival predicate, or arrival
  //    predicate then money noun, since "the service holds the fee" puts them the other way round) and
  //    covers the predicates seen in every mutant tried through R10 — but a new predicate nobody
  //    thought of still slips past it.
  //  - The real backstop for that is the exact-sentence snapshot further down: a mutant does not need
  //    to be RECOGNISED there, only to exist, because any added/removed/reworded sentence fails it.
  //    These semantic guards stay as defence in depth, and because they explain WHY a sentence is
  //    unsafe, which a snapshot diff does not.
  //
  // R9-M04 rebuilt both halves, because the previous pair was not falsifiable:
  //  - the claim side keyed on the literal token "payment", so a mutant that said "the fee has
  //    already reached the credential service" matched nothing and passed vacuously. It now covers
  //    the money synonyms (fee/charge/funds/transfer/money) and arrival wordings, not just "payment
  //    succeeded".
  //  - the denial side was /NOT|not|never|without|.../, which ANY stray "without" in a long sentence
  //    satisfied -- a mutant re-added false certainty and passed on the "without hedging" it had
  //    added itself. It is now an enumerated set of denial FRAMES ("do NOT assume/describe/say",
  //    "never tell/say/claim", "says NOTHING about", "not known to", "does not establish", "without
  //    promising"), so an unrelated negation elsewhere in the sentence cannot satisfy it.
  //
  // Scope, deliberately: this guard runs against request_'s description ONLY. "the fee was most likely
  // already taken" IS in SUCCESS_CLAIM as of R10-M04 (a mutant used "has been taken"/"was debited"), and
  // check_'s description asserts exactly that on purpose, for the aged OUTCOME UNKNOWN case where it is
  // the true and required thing to say -- forcing a denial frame onto that would be wrong, which is why
  // check_ is not run through this test. The no-charge direction IS guarded on both tools, below.
  const MONEY_NOUN = /\b(payment|fee|charge|funds|transfer|money)\b/
  /** Predicates that say the money got to the other side. Widened in R10-M04; see the note above. */
  const ARRIVAL =
    /\b(succeed(ed|s)?|went through|was confirmed|is confirmed|settled (successfully|on chain|on-chain)|cleared (successfully|on chain|on-chain)|known to have succeeded|has (already )?(reached|arrived|been received|been taken|been deducted|been debited)|(was|were|is|are) (now )?(already )?(taken|deducted|debited|with the (issuer|credential service|payment service))|reached the (credential|payment) service|hold(s)? the|received it|landed|arrived|on chain already)\b/
  const SUCCESS_CLAIM = new RegExp(
    `${MONEY_NOUN.source}[^.]{0,80}${ARRIVAL.source}` +
      `|${ARRIVAL.source}[^.]{0,80}${MONEY_NOUN.source}` +
      `|\\b(credential|payment) service (has |already )?received it\\b`,
    'i',
  )
  const EXPLICIT_DENIAL =
    /\bdo(es)? not (assume|describe|say|tell|claim|promise|treat|mean|always mean)\b|\bnever (tell|say|claim|assume|describe|promise|report)\b|\bsays nothing about\b|\bnot known to\b|\bdoes not establish\b|\bno claim\b|\bwithout promising\b|\bnot a confirmed one\b/i
  it('request_ai_birthcert_verification: no sentence asserts the money arrived without an explicit denial', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    const claiming = splitSentences(description).filter((s) => SUCCESS_CLAIM.test(s))
    // Non-vacuity: the description DOES discuss payment success (it has to, to deny it), so a zero
    // count means SUCCESS_CLAIM stopped matching the wording rather than the wording becoming safe.
    expect(claiming.length, 'SUCCESS_CLAIM matched nothing — the guard has gone blind, not the description safe').toBeGreaterThan(0)
    for (const sentence of claiming) {
      expect(sentence, 'a sentence asserting the money arrived must carry an explicit denial frame').toMatch(EXPLICIT_DENIAL)
    }
  })

  // The other direction, and the one R9-M01's mutant used: asserting the money did NOT move. That is
  // true for exactly two branches (insufficient funds / payment cap) and unknowable for every other,
  // so such a sentence must either name that safe scope or be a prohibition on saying it. Applied to
  // both tools: check_ makes the same no-charge disclaimers, and both are non-vacuous here.
  const NO_CHARGE_CLAIM =
    /\b(fee|charge|charged|payment|money|funds)\b[^.]{0,80}\b(never left|did not leave|was not taken|were not taken|has not been taken|was not charged|were not charged|not charged|no charge|refunded|still in the account|untouched|intact)\b|\bnothing was (paid|charged|taken|spent|debited)\b|\bno (fee|money|charge) (was|has been) (taken|charged|spent|sent|paid)\b/i
  const SAFE_SCOPE = /insufficient funds|payment-cap|payment cap/i
  it.each(['request_ai_birthcert_verification', 'check_ai_birthcert_verification'])(
    '%s: no sentence says the money did not move unless it is scoped to the safe branches or forbids saying it',
    (name) => {
      const description = buildToolList().find((t) => t.name === name)?.description ?? ''
      const claiming = splitSentences(description).filter((s) => NO_CHARGE_CLAIM.test(s))
      expect(claiming.length, 'NO_CHARGE_CLAIM matched nothing — the guard has gone blind').toBeGreaterThan(0)
      for (const sentence of claiming) {
        expect(
          SAFE_SCOPE.test(sentence) || EXPLICIT_DENIAL.test(sentence),
          `this sentence tells the agent the money did not move, with neither the safe scope nor a prohibition frame: ${sentence}`,
        ).toBe(true)
      }
    },
  )

  // R10-M03 / R10-M04, widened in R11-M02. THE STRUCTURAL BACKSTOP -- the only guard in this file
  // that is not a word list.
  //
  // Every semantic guard above detects a KNOWN shape of unsafe wording, and three R10 mutants showed
  // why that can never be enough alone. A2 kept every phrase those guards key on, quoted the caveat it
  // was overriding, and instructed a retry in fresh words ("routine housekeeping", "needs no separate
  // sign-off", "reconciled the ledger"). A3 named no branch at all and still shipped a retry
  // instruction covering three of the four money-at-risk branches. C2/D2 asserted the money had arrived
  // with predicates no list held. An ADDITIVE sentence is invisible to a detector written before it.
  //
  // So this pins the exact sentences. A mutant does not have to be RECOGNISED to fail here -- it only
  // has to exist. Any added, removed, reordered or reworded sentence fails, which is the intent: these
  // strings are read by a host LLM that spends the user's money according to what they say, so a change
  // to them must be a reviewed change, never an incidental one.
  //
  // R11-M02 widened the scope from "the two Verified-AI-Birthcert descriptions" to EVERY agent-facing
  // string of EVERY registered tool -- every top-level description and every inputSchema property
  // description, at any depth. All of it is shipped to the host LLM verbatim, and two planted mutants
  // proved the narrower snapshot blind to it: a retry endorsement added to
  // discardStuckReceiptAndPayFresh's property description, and the same text added to
  // clear_stuck_payment_receipt's description, both survived the entire suite. The reviewed text lives
  // in ./fixtures/agent-facing-text.ts (size only -- the assertions and the reasoning stay here).
  //
  // WHEN THIS FAILS after a deliberate edit, do not just paste the new text in. A snapshot update is
  // not a formality: re-run the REASONING of the semantic guards above over every changed sentence --
  // no path may say the fee WAS taken or was NOT taken when it cannot know (SPEC.md §6, REQ-19e/f), no
  // branch where money may have moved may carry a retry endorsement, and no indeterminate state may be
  // called progressing or succeeded (SPEC.md REQ-19b as amended in R11-M03) -- then update the fixture
  // deliberately, and keep the semantic guards passing too.
  it('every registered tool is covered by the reviewed snapshot, with no string left unpinned', () => {
    const registered = buildToolList().map((t) => t.name).sort()
    expect(Object.keys(EXPECTED_AGENT_TEXT).sort(), 'a tool was added or renamed without reviewing its agent-facing text').toEqual(
      registered,
    )
    for (const name of registered) {
      expect(
        agentStrings(name).map((s) => s.path).sort(),
        `${name}: an inputSchema description was added or removed without reviewing it`,
      ).toEqual(Object.keys(EXPECTED_AGENT_TEXT[name]).sort())
    }
  })

  it.each(Object.keys(EXPECTED_AGENT_TEXT))(
    '%s: every agent-facing string is exactly the reviewed set of sentences, so none can change unseen',
    (name) => {
      for (const { path, text } of agentStrings(name)) {
        expect(
          splitSentences(text),
          `${name} ${path} no longer matches its reviewed snapshot. Re-review the money-claim wording of ` +
            `every changed sentence (never assert the fee was or was not taken on a path that cannot know ` +
            `it; never endorse a retry on a branch where money may have moved; never call an indeterminate ` +
            `outcome progressing or succeeded), then update src/__tests__/fixtures/agent-facing-text.ts ` +
            `deliberately.`,
        ).toEqual([...EXPECTED_AGENT_TEXT[name][path]])
      }
    },
  )

  // R11-M02, the semantic half. The guards above ran on ONE string of ONE tool each; these run the same
  // reasoning over every agent-facing string of every money-touching tool, so a planted sentence has to
  // pass the reasoning as well as the snapshot. Each carries its own non-vacuity assertion: a guard that
  // stops matching anything is a guard that has gone blind, not a codebase that has become safe.
  //
  // Hedged and conditional statements are NOT assertions, and some of them are the correct thing to say:
  // subscribe_and_issue must be able to say a 4012 payment "may well have landed" (that is the whole
  // point of an INDETERMINATE outcome), check_ must be able to say an aged OUTCOME UNKNOWN fee was "most
  // likely" already taken, and describing WHEN a field is populated ("paidAsset/amountPaid are set ONLY
  // when this call paid", "any failure after the payment has settled on chain reports paymentAttempted")
  // claims nothing about the call in hand. Those frames are enumerated rather than blanket-excluded, so
  // what is carved out is visible and reviewable -- and an unhedged assertion still fails.
  const HEDGED_OR_CONDITIONAL =
    /\bmay (well )?have\b|\bmight have\b|\bmay already\b|\bmost likely\b|\bINDETERMINATE\b|\bset ONLY when\b|\bany failure after\b/i

  it('no agent-facing string of a money-touching tool asserts the money arrived unhedged and undenied', () => {
    const claiming = moneySentences().filter(({ sentence }) => SUCCESS_CLAIM.test(sentence))
    expect(claiming.length, 'SUCCESS_CLAIM matched nothing across every money-touching tool -- the guard has gone blind').toBeGreaterThan(0)
    for (const { tool, path, sentence } of claiming) {
      expect(
        EXPLICIT_DENIAL.test(sentence) || HEDGED_OR_CONDITIONAL.test(sentence),
        `${tool} ${path} asserts the money arrived, with neither a denial frame nor a hedge: ${sentence}`,
      ).toBe(true)
    }
  })

  it('no agent-facing string of a money-touching tool says the money did not move, unscoped', () => {
    const claiming = moneySentences().filter(({ sentence }) => NO_CHARGE_CLAIM.test(sentence))
    expect(claiming.length, 'NO_CHARGE_CLAIM matched nothing across every money-touching tool -- the guard has gone blind').toBeGreaterThan(0)
    for (const { tool, path, sentence } of claiming) {
      expect(
        SAFE_SCOPE.test(sentence) || EXPLICIT_DENIAL.test(sentence),
        `${tool} ${path} tells the agent the money did not move, with neither the safe scope nor a prohibition frame: ${sentence}`,
      ).toBe(true)
    }
  })

  it('no agent-facing string of a money-touching tool endorses a retry of a paying call unscoped', () => {
    // Only sentences that actually point at something that SPENDS: "call check_ai_birthcert_verification
    // again" is free and must stay endorsable, while "call request_ai_birthcert_verification again" is a
    // second fee. A retry endorsement aimed at a paying action must name the safe scope (insufficient
    // funds / payment cap, where nothing was paid) or carry the consent caveat.
    const PAYING_ACTION = /request_ai_birthcert_verification|subscribe_and_issue|pay_and_fetch|discardStuckReceiptAndPayFresh|\b(fee|payment|pay|charge)\b/i
    const sentences = moneySentences()
    const endorsing = sentences.filter(({ sentence }) =>
      RETRY_ENDORSEMENT.test(sentence.replace(/whether retrying is safe/gi, '')),
    )
    expect(endorsing.length, 'RETRY_ENDORSEMENT matched nothing across every money-touching tool -- the guard has gone blind').toBeGreaterThan(0)
    for (const { tool, path, sentence } of endorsing) {
      if (!PAYING_ACTION.test(sentence)) continue
      expect(
        SAFE_SCOPE.test(sentence) || CONSENT_CAVEAT.test(sentence),
        `${tool} ${path} endorses re-running something that spends, with neither the safe scope nor a consent caveat: ${sentence}`,
      ).toBe(true)
    }
  })

  // R11-M03. The no-outcomeUnknown settlement_pending shape has TWO producers and both messages open
  // "PAYMENT SENT": a genuinely queued settlement ("...the sponsored settlement is still being
  // processed") and an outcome that is unknown but too young to be called stuck ("...the settlement has
  // not been confirmed yet"). check_'s description told the agent the whole shape was "queued and
  // progressing -- just check again in a few minutes", which reports an undeterminable outcome as
  // progress: R8-M02 in substance, already fixed on request_ but shipped on check_ (and in README.md).
  // So no surface may call anything progressing unless it is scoped to the confirmed-queued clause or is
  // a prohibition on saying it.
  const PROGRESSING_CLAIM = /\b(progressing|progresses|moving along|on its way|resolve(s)? (itself|on its own))\b/i
  it('no agent-facing string calls a settlement progressing unless it is the confirmed-queued case', () => {
    const claiming = moneySentences().filter(({ sentence }) => PROGRESSING_CLAIM.test(sentence))
    expect(claiming.length, 'PROGRESSING_CLAIM matched nothing -- the guard has gone blind').toBeGreaterThan(0)
    for (const { tool, path, sentence } of claiming) {
      expect(
        sentence.includes('still being processed') || EXPLICIT_DENIAL.test(sentence),
        `${tool} ${path} describes a settlement as progressing without scoping it to the confirmed-queued ` +
          `message ("still being processed") and without forbidding the claim: ${sentence}`,
      ).toBe(true)
    }
  })

  it('check_ai_birthcert_verification teaches the two-state split of the no-outcomeUnknown case', () => {
    const description = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')?.description ?? ''
    // The flat claim that was wrong for one of the two producers must not come back.
    expect(description).not.toMatch(/it is queued and progressing/i)
    expect(description).toMatch(/TWO different states/i)
    expect(description).toMatch(/still being processed/)
    expect(description).toMatch(/has not been confirmed yet/)
    expect(description).toMatch(/do NOT describe that one as progressing/i)
    expect(description).toMatch(/do NOT describe it as succeeded/i)
  })

  // Third guard, for the mutant with no dangerous name in it at all: "...and every other error too,
  // calling this tool again is the right next step". The sentence that endorses a retry must itself
  // carry the insufficient-funds / payment-cap scope, and must not widen it.
  it('request_ai_birthcert_verification: every retry-endorsing sentence is scoped to insufficient funds / payment cap and never widened', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    const endorsing = splitSentences(description).filter((s) => RETRY_ENDORSEMENT.test(s.replace(/whether retrying is safe/gi, '')))
    expect(endorsing.length).toBeGreaterThan(0)
    for (const sentence of endorsing) {
      expect(sentence, 'a retry-endorsing sentence must name the safe scope').toMatch(/insufficient funds|payment-cap/i)
      expect(sentence, 'a retry-endorsing sentence must not widen the scope').not.toMatch(/\b(any|every|all|other|others|also|too|each|otherwise)\b/i)
    }
  })

  it('request_ai_birthcert_verification: the retry-is-fine claim is actually scoped to insufficient funds / payment cap', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    expect(description).toMatch(/insufficient funds or a payment-cap block specifically/i)
  })

  // R7-M02 / R8-M01, check_-side. The old shared it.each was vacuous here: "succeed" never appears
  // in check_'s description at all, so a positional split could never fail regardless of where the
  // split landed. check_'s actual money-safety property is different from request_'s (it never
  // discusses retrying, since it never pays) -- pin what's actually true for THIS tool instead of
  // reusing request_'s test shape on a description it doesn't fit.
  it('check_ai_birthcert_verification never claims a settlement_pending result is a known success', () => {
    const description = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')?.description ?? ''
    expect(description).not.toMatch(/is known to have succeeded/i)
    expect(description).not.toMatch(/payment genuinely succeeded/i)
  })

  // R8-M02. The round-7 fix claimed the no-flag settlementPending bucket is "known to have
  // succeeded" -- false on a reachable path. That bucket is a union of two states that produce the
  // IDENTICAL shape (no issuerRejected/paymentInvalid/outcomeUnknown set): genuinely-still-queued
  // (SettlementStillQueuedError) and outcome-unknown-but-young (SettlementOutcomeUnknownError before
  // it has aged into "stuck" -- see that class's own docstring: "we don't know whether the settlement
  // actually failed or is merely still in flight"). The description must say so, not assert a
  // certainty that the second sub-case doesn't have.
  //
  // R10: corrected wording. BOTH messages open "PAYMENT SENT — ", so neither phrase below LEADS the
  // message; they are the discriminating CLAUSE that follows ("...the sponsored settlement is still
  // being processed" vs "...the settlement has not been confirmed yet"). And the young indeterminate
  // message now has two halves -- it admits this call's own payment on the fresh-pay route instead of
  // saying "Nothing is lost" (R10-M01/R10-LOW) -- so neither half may be assumed. This test pins only
  // that the DESCRIPTION teaches the discriminator; that the ORCHESTRATOR still emits exactly these
  // two phrases, and neither one in the other's message, is pinned in verify-ai-birthcert.test.ts
  // ("R10: the paid-this-call wording is pinned on every half of every branch") -- R10-M05 found
  // nothing held that end of the contract, so rewording either message broke this advice silently.
  it('request_ai_birthcert_verification does not claim the no-flag settlementPending case is known to have succeeded', () => {
    const description = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.description ?? ''
    // The false certainty this finding was about must not reappear. The lookbehind exempts the
    // description's own denial ("do NOT assume the payment is known to have succeeded"), which
    // contains the same words -- only a POSITIVE claim should trip this.
    expect(description).not.toMatch(/(?<!assume )the payment is known to have succeeded/i)
    expect(description).not.toMatch(/the payment genuinely succeeded/i)
    // It must instead say the bucket is two states, and tell the agent how to tell them apart.
    expect(description).toMatch(/TWO different/i)
    expect(description).toMatch(/still being processed/i)
    expect(description).toMatch(/has not been confirmed yet/i)
    expect(description).toMatch(/do NOT assume the payment is known to have succeeded/i)
  })

  // R10-LOW(a). discardStuckReceiptAndPayFresh's own description said flatly that the result "carries
  // discardedPaymentReceipt — support needs it to trace the lost payment", which names the WRONG receipt
  // on the compound path: when this call also discards a void receipt of its own, the field holds the
  // VOID id and the id the user confirmed survives only in the error text (REQ-19e, and the orchestrator
  // test 'names BOTH receipts when the fresh payment is then ruled void'). An agent that quotes only the
  // field there gives support the receipt nobody confirmed and loses the one they did.
  it('discardStuckReceiptAndPayFresh says which receipt the field holds when this call kills two', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    const prop = (tool?.inputSchema as unknown as { properties?: Record<string, { description?: string }> }).properties
      ?.discardStuckReceiptAndPayFresh
    const text = prop?.description ?? ''
    expect(text).toMatch(/Normally the result carries the id you confirmed as discardedPaymentReceipt/i)
    // The compound case, both halves: the field holds the VOID receipt, and the confirmed id is in the text.
    expect(text).toMatch(/discardedPaymentReceipt holds THAT receipt instead/i)
    expect(text).toMatch(/ALSO DISCARDED earlier on this same call/)
    expect(text).toMatch(/quote BOTH ids/i)
    // The flat claim that was wrong on that path must not come back.
    expect(text).not.toMatch(/The result carries discardedPaymentReceipt —/)
  })

  // agentName is the ONLY thing the caller supplies — id/ownerReference are auto-filled and must
  // never be exposed as inputs, and the description must warn about uniqueness without leaking
  // the internal id-mirroring mechanism.
  it('request_ai_birthcert_verification exposes agentName as the only required input, with a uniqueness warning', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.inputSchema.properties.id).toBeUndefined()
    expect(tool?.inputSchema.properties.ownerReference).toBeUndefined()
    expect(tool?.inputSchema.properties.agentName).toBeDefined()
    expect(tool?.description).toMatch(/unique/i)
    expect(tool?.description).not.toMatch(/\bid\b.*mirror|copy of agentName/i)
  })

  it('check_ai_birthcert_verification takes no required input', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.inputSchema.required).toBeUndefined()
  })

  it('subscribe_and_issue is disambiguated from the Verified AI Birthcert flow', () => {
    const tool = buildToolList().find((t) => t.name === 'subscribe_and_issue')
    expect(tool?.description).toMatch(/self-declared/i)
    expect(tool?.description).toMatch(/NOT.*identity-verified|not.*identity-verified/)
    expect(tool?.description).toMatch(/request_ai_birthcert_verification/)
  })

  it('request_ai_birthcert_verification points back at subscribe_and_issue for the non-verified case', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/subscribe_and_issue/)
    expect(tool?.description).toMatch(/self-declared|non-verified|not verified/i)
  })

  it('advertises an optional gasPayer enum on request_ai_birthcert_verification', () => {
    const tool = buildToolList().find(t => t.name === 'request_ai_birthcert_verification')
    const prop = (tool?.inputSchema as unknown as { properties?: Record<string, { enum?: string[] }> }).properties
      ?.gasPayer
    expect(prop?.enum).toEqual(['sponsored', 'self'])
    const required = (tool?.inputSchema as { required?: string[] }).required ?? []
    expect(required).not.toContain('gasPayer')
  })

  it('advertises every policy tool as free of payment and signing', () => {
    for (const name of ['get_my_policy', 'get_policy_template_schema', 'policy_preflight']) {
      const tool = buildToolList().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.description, name).toMatch(/free|no payment/i)
    }
  })

  it('tells the agent that a clean policy_preflight is not a guarantee of enforcement', () => {
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.description).toMatch(/not a guarantee|notChecked/i)
  })

  it('promises the plain-words interpretation, so an agent knows to show it on a PASS', () => {
    // An agent that reports only ready:true hides exactly what that layer exists to surface.
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.description).toMatch(/interpretation|what it means|plain words/i)
  })

  it('requires a draft policy for policy_preflight', () => {
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.inputSchema.required).toEqual(['policyKey', 'attributes', 'validFromBlock', 'validToBlock'])
  })

  it('asks for nothing mandatory on the two read tools, so a bare call works', () => {
    const byName = Object.fromEntries(buildToolList().map((t) => [t.name, t]))
    expect(byName.get_my_policy.inputSchema.required).toBeUndefined()
    expect(byName.get_policy_template_schema.inputSchema.required).toBeUndefined()
  })
})

/**
 * The README's tool table is the first thing anyone reads on GitHub and on the npm page, and nothing
 * enforced it: three policy tools shipped, were registered, were documented in the plugin's SKILL.md
 * (which IS enforced), and were simply missing from the README — where a reader is most likely to
 * look. It went public that way before anyone noticed.
 *
 * The plugin already has this guard; this is the same one for the wallet's own README.
 */
describe('README documents every tool', () => {
  const readme = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8')
  const documented = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort()

  it('names exactly the tools the server registers — no more, no fewer', () => {
    const registered = buildToolList().map((t) => t.name).sort()
    expect(documented).toEqual(registered)
  })
})

/**
 * The DOC half of the same money-safety contract. SPEC.md makes several of these claims a MUST on
 * "every surface", and a surface nothing reads is a surface that drifts: the tool-description half of
 * each rule below is pinned above, while the README half was pinned by nothing at all (R11-LOW).
 *
 * These read the shipped files rather than a copy, so a README edit that contradicts the tool
 * descriptions fails here instead of reaching a user.
 */
describe('the docs agree with the tool descriptions about money', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const readme = read('../../README.md')
  // SPEC.md is an internal design doc that is not part of the published tree, so its checks run only
  // where it exists (the source repo) and are skipped, not failed, in a public checkout.
  const specPath = '../../docs/verified-birthcert-vc/SPEC.md'
  const spec: string | undefined = existsSync(new URL(specPath, import.meta.url)) ? read(specPath) : undefined
  const skill = read('../../openclaw-plugin/skills/zetrix-agentic-wallet/SKILL.md')
  const row = (tool: string): string =>
    readme.split(/\r?\n/).find((line) => line.startsWith(`| \`${tool}\``)) ?? ''

  // SPEC.md REQ-19e: "Every surface that documents the field (README.md, the
  // discardStuckReceiptAndPayFresh tool description) MUST say which receipt it holds on that path,
  // rather than naming the confirmed one flatly." The description side is pinned by
  // 'discardStuckReceiptAndPayFresh says which receipt the field holds when this call kills two'.
  it('README says which receipt discardedPaymentReceipt holds on the compound discard path', () => {
    const request = row('request_ai_birthcert_verification')
    expect(request, 'no request_ai_birthcert_verification row found in README.md').not.toBe('')
    // The field holds the VOID receipt on that path...
    expect(request).toMatch(/When both happen[^|]*the field holds the \*\*void\*\* receipt/i)
    // ...and the confirmed id survives in the text, named as such, with both quoted to support.
    expect(request).toMatch(/ALSO DISCARDED earlier on this same call/)
    expect(request).toMatch(/quote both ids to support/i)
    // The flat claim REQ-19e forbids must not be the only thing said about the field.
    expect(request).toMatch(/discardedPaymentReceipt/)
  })

  it('SPEC, README and the tool description do not contradict each other on that path', () => {
    const description =
      (
        buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')?.inputSchema as unknown as {
          properties?: Record<string, { description?: string }>
        }
      ).properties?.discardStuckReceiptAndPayFresh?.description ?? ''
    const surfaces: Array<readonly [string, string]> = [
      ['README.md', row('request_ai_birthcert_verification')],
      ['the tool description', description],
    ]
    if (spec !== undefined) surfaces.unshift(['SPEC.md', spec])
    for (const [label, text] of surfaces) {
      expect(text, `${label} does not name the compound-path marker`).toContain('ALSO DISCARDED earlier on this same call')
      expect(text, `${label} does not say the field holds the void receipt there`).toMatch(/void/i)
    }
  })

  // R11-M03. Same finding as the check_ description half: the no-outcomeUnknown shape has two
  // producers and both open "PAYMENT SENT", so calling the whole shape "queued and progressing" tells
  // the agent to report an undeterminable outcome as progress.
  it.each([
    ['README.md', () => row('check_ai_birthcert_verification')],
    ...(spec !== undefined ? [['SPEC.md', () => spec] as [string, () => string]] : []),
    ['the plugin skill', () => skill],
  ])('%s teaches the clause-level split instead of calling the whole shape progressing', (_label, get) => {
    const text = get()
    expect(text).not.toMatch(/it is queued and progressing/i)
    expect(text).toContain('still being processed')
    expect(text).toContain('has not been confirmed yet')
  })

  it('no doc surface claims the fee was not taken on a path that cannot know', () => {
    for (const [label, text] of [
      ['README.md', row('check_ai_birthcert_verification')],
      ['the plugin skill', skill],
    ] as const) {
      expect(text, `${label} claims the money is safe`).not.toMatch(
        /payment is safe|funds are safe|unspent|has not been spent|was not charged/i,
      )
    }
  })
})
