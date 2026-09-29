/**
 * policy_preflight — one free, read-only answer to two questions, before the policy write tools ever sign or pay
 * for a deploy:
 *
 *   1. "is the policy I am about to deploy well-formed?"  -> blockers
 *   2. "does it MEAN what I think it means?"              -> interpretation
 *
 * The first exists because the chain validates NOTHING. Not attribute names, not values against
 * their declared types, not block ordering, not even an empty attribute list. A policy naming
 * `x4O2` (letter O) deploys perfectly cleanly and then enforces nothing at all, while the user
 * believes they have restricted their agent's spending.
 *
 * The second is the more dangerous question, because every case it catches PASSES the first. A
 * `cumulativeMax` with no window is well-formed, accepted, and enforced — as a lifetime cap, when
 * the user meant per month. Nothing on the write path will catch it either: `PolicyWriteValidator`
 * is deliberately independent of the v1 vocabulary and only asks whether the input is well-formed
 * enough to sign. So `interpretation` is returned on CLEAN results too. A user who can read what
 * their policy means will catch the mistake; a user who sees a green tick will not.
 *
 * Mirrors credential_preflight's contract deliberately: every blocker is reported TOGETHER, so one
 * round of fixes is enough rather than discovering them one failed deploy at a time; and
 * `notChecked` names what no amount of preflight can settle, so a clean result is never mistaken
 * for a guarantee.
 */

import { declaredVocabulary, type PolicyRead, type TemplateRecord } from '../clients/policy-read-client.js'
import {
  INFORMATIONAL_ATTRIBUTES,
  QUALIFIER_ATTRIBUTES,
  ATTRIBUTE_TYPES,
  isListType,
  listPolarity,
  windowRuleFor,
} from '../policy-window-rules.js'

export interface DraftPolicyAttribute {
  attributeName: string
  attributeType: string
  value: string
}

export interface DraftPolicy {
  policyKey: string
  attributes: DraftPolicyAttribute[]
  validFromBlock: string
  validToBlock: string
  /** Either identifies the template; the caller supplies whichever it has. */
  templateId?: string
  publisher?: string
}

export interface PolicyPreflightResult {
  policyKey: string
  /** True only when nothing in `blockers` stands in the way. */
  ready: boolean
  /** The template's declared attribute names, when the template resolved. */
  declared?: string[]
  /**
   * Everything standing in the way, together — never one at a time.
   *
   * Bounded at MAX_LINES for a draft with hundreds of faults, and the last line says how many were
   * omitted. Draft-level blockers are added BEFORE the per-attribute ones so a flood of attribute
   * faults can never be what pushes out "this policy would never be in force".
   */
  blockers: string[]
  /**
   * What this draft actually MEANS, in plain words. Returned on clean results too — that is the
   * point. See the module comment.
   */
  interpretation: string[]
  /** What preflight could not verify, so a clean result is not mistaken for a guarantee. */
  notChecked: string[]
}

export interface PolicyPreflightDeps {
  /** Resolves the draft's template, by id or by publisher+policyKey. */
  readTemplate: (draft: DraftPolicy) => Promise<PolicyRead<TemplateRecord>>
  /**
   * The active network, so `notChecked` can say that nothing is deployed on mainnet. Optional:
   * omitting it simply drops that one line rather than asserting something untrue.
   */
  network?: string
  /**
   * Checksum validator for ADDRESS values and for every entry of an ADDRESS_LIST. The same KIND
   * of check transfer_token performs, wired separately through ToolDeps rather than shared with it.
   * Optional: without it those values are reported as NOT CHECKED rather than silently accepted.
   *
   * The ADDRESS_LIST half of that was once only a claim: the list branch returned before the
   * address checks ran, so entries were never validated and no notChecked line was emitted.
   * Both halves are now true.
   */
  isValidAddress?: (address: string) => boolean
}

/**
 * Every type the contract accepts is checkable, so an unrecognised type is now a real signal —
 * either a template declaring something outside `VALID_ATTRIBUTE_TYPES`, or our list going stale.
 *
 * The first cut listed `uint`/`uint256`/`int`/`number`/`bool`/`boolean`, which overlap the real
 * vocabulary in NOT ONE value, so every attribute fell through to "cannot check" and the type
 * check was dead code against every real template.
 */
const CHECKABLE_TYPES: ReadonlySet<string> = new Set(Object.values(ATTRIBUTE_TYPES))

function isNumericString(value: unknown): boolean {
  return typeof value === 'string' && /^\d+$/.test(value)
}

/**
 * Parse a list value, or say it is not a list.
 *
 * Returns a FAILURE rather than throwing or guessing. `value` is unchecked input — the MCP SDK
 * does not enforce inputSchema at runtime — and calling `.trim()` on it threw a raw TypeError for
 * undefined, null, a number or an object.
 */
/** Is one entry of a list usable for its declared list type? */
function isValidEntry(entry: unknown, type: string, isValidAddress?: (a: string) => boolean): boolean {
  if (type === ATTRIBUTE_TYPES.NUMBER_LIST) return isNumericString(entry)
  if (typeof entry !== 'string' || entry.trim() === '') return false
  // An ADDRESS_LIST entry is an address; without a validator its SHAPE still has to be a string,
  // and the caller is told separately that the checksum went unchecked.
  if (type === ATTRIBUTE_TYPES.ADDRESS_LIST && isValidAddress) return isValidAddress(entry)
  return true
}

/**
 * Cap ONE echoed value. This is half of the containment, not the whole of it — see `capMessage`.
 *
 * Results are returned to an LLM agent as MCP tool output and are built from untrusted policy JSON,
 * so an unbounded echo is a context-flood vector rather than an ugly message. Round 4 capped the
 * bad-entry list and left four siblings at ~50KB; a later pass capped those four and left FOURTEEN
 * more, two of which need no error at all — a `ready: true` interpretation and the raw
 * `validFromBlock`. Applying this at each site is now the thing that
 * makes a message READABLE; `capMessage` is what makes the size bound TRUE.
 *
 * Total by construction. `JSON.stringify` throws RangeError on a deeply nested value and TypeError
 * on a cyclic one, and a bare `String(value)` on a 20,000-deep array recurses the same way — which
 * is how a `RangeError` escaped `policyPreflight` from the interpretation path.
 */
export function echoSafe(value: unknown, max = 60): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  } catch {
    // Nested past the stack, or cyclic. The caller still needs a sentence, not an exception.
    return '<a value too deeply nested or self-referential to display>'
  }
  // The ellipsis counts toward the budget: a cap that returns max + 1 characters is off by one
  // in the direction that matters, since the point is an upper bound a test can state exactly.
  return text.length > max ? `${truncate(text, max - 1)}…` : text
}

/**
 * Slice without splitting a surrogate pair — a cut mid-emoji leaves a lone `�`, which is not a
 * character any consumer can render or re-encode. Cosmetic, but this is the function
 * whose whole job is making untrusted text safe to pass on.
 */
function truncate(text: string, max: number): string {
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * THE SIZE BOUND, per string — see `finalize` for the whole-result one.
 *
 * Four rounds running, the fix was "cap the sites the new tests exercise" and the claim was "every
 * echo is capped". The sites are many, they are added freely, and a missed one is invisible until
 * someone measures. So the guarantee does not live at the sites any more: it lives at the one place
 * every field of the result passes through. A site that forgets `echoSafe` produces an UGLY
 * message, not a 50KB one.
 *
 * Well above the longest message this module can legitimately build — the unknown-polarity
 * empty-list blocker, ~230 characters, and the declared-attribute list, bounded separately at
 * `MAX_NAME_LIST` so the two constants cannot contradict each other.
 *
 * Pinned ABSOLUTELY, not against itself. Every size assertion used to compare against this same
 * constant, so raising it to 100000 passed the whole suite and silently restored the flood a
 * previous fix had closed.
 */
export const MAX_MESSAGE = 600

/**
 * The character budget for a comma list of attribute NAMES, small enough that a message carrying
 * one still fits in `MAX_MESSAGE` with its prose. The previous bound was `20 × 40` = ~1,024, which
 * EXCEEDED `MAX_MESSAGE`: two constants added in one commit that disagreed, so a legitimate
 * 20-name template had ~40% of its declared list cut off by the backstop while the docblock claimed
 * hitting the backstop meant something had gone wrong.
 */
const MAX_NAME_LIST = 300

/**
 * The most lines any one array may carry.
 *
 * `capMessage` bounds each string and says nothing about how many there are, and the count is
 * caller-controlled: 5,000 single-character attributes measured 314 KB of input producing 1.68 MB
 * of output. If the threat model is a context flood, the element count needs a bound too.
 *
 * Far above any real draft — the whole v1 vocabulary is sixteen names, so a draft cannot honestly
 * produce more than a few dozen lines per array.
 */
export const MAX_LINES = 50

/**
 * The longest a policyKey may be. It identifies the draft; it is not a message.
 *
 * A key longer than this is REFUSED rather than quietly shortened. An earlier fix capped the echo,
 * which meant a `ready: true` result could hand back a key that was not the key asked about — an agent
 * reusing it would write under a different key and never know. Silently altering an
 * identifier is worse than refusing it, and no real key is anywhere near this long: `PolicyKeyFormat`
 * on the write path bounds it far tighter.
 */
export const MAX_KEY = 120

/**
 * The most declared attribute names the result may carry back as structured data.
 *
 * When names are dropped the result SAYS SO, in `notChecked`. This module's own rule is that a
 * shortened list which looks complete is its own defect, and a previous fix broke it in the field right
 * beside the one the rule was written for. Today's real templates declare 11 and 13, so
 * nothing legitimate comes near this.
 */
export const MAX_DECLARED = 64

/**
 * A declared name longer than this is OMITTED, never truncated — for the same reason `policyKey` is
 * refused rather than cut. These are identifiers the caller may compare or reuse, and a corrupted
 * identifier is indistinguishable from a real one. Every real v1 name is under 25 characters.
 */
export const MAX_DECLARED_NAME = 40

function capMessage(text: string): string {
  return text.length > MAX_MESSAGE ? `${truncate(text, MAX_MESSAGE - 1)}…` : text
}

/**
 * Bound one array in BOTH directions — each line's length, and how many lines there are.
 *
 * Dropping lines cannot change a verdict: `ready` is computed from `blockers.length === 0` before
 * this runs, and the omission is stated rather than silent, so a reader is never shown a shortened
 * list that looks complete.
 */
function capLines(lines: string[]): string[] {
  const capped = lines.map(capMessage)
  if (capped.length <= MAX_LINES) return capped
  const shown = capped.slice(0, MAX_LINES - 1)
  return [...shown, `… and ${capped.length - shown.length} more, omitted to keep this result readable.`]
}

/**
 * The single exit. EVERY field of the result is bounded here, not just the three string arrays.
 *
 * An earlier fix bounded `blockers`, `interpretation` and `notChecked` and let `policyKey` and `declared`
 * through untouched on the same object — so a 50,000-character `policyKey` still produced a ~50 KB
 * tool-output block on a `ready: true` result with no error path anywhere, which is the exact shape
 * a fix before that had closed one field over. The guarantee is about the OBJECT the agent receives,
 * so it has to cover the object.
 */
export function finalize(result: PolicyPreflightResult): PolicyPreflightResult {
  const notChecked = [...result.notChecked]

  // Identifiers are kept WHOLE or dropped, never altered — a truncated name still looks like a
  // name. Over-long ones are the flood vector; omitting them says so out loud.
  let declared: string[] | undefined
  if (result.declared) {
    const usable = result.declared.filter((name) => name.length <= MAX_DECLARED_NAME)
    declared = usable.slice(0, MAX_DECLARED)
    const omitted = result.declared.length - declared.length
    if (omitted > 0) {
      notChecked.push(
        `${omitted} of this template's ${result.declared.length} declared attribute names are not ` +
          `listed above — they were omitted to keep this result readable, so treat "declared" as ` +
          `a partial list rather than the whole vocabulary.`,
      )
    }
  }

  return {
    ...result,
    // Raw MCP input. Refused upstream when over-long (see MAX_KEY), so this only ever shortens a
    // key that already carries a blocker saying why.
    policyKey: echoSafe(result.policyKey, MAX_KEY),
    ...(declared ? { declared } : {}),
    blockers: capLines(result.blockers),
    interpretation: capLines(result.interpretation),
    notChecked: capLines(notChecked),
  }
}

/**
 * A comma list of attribute NAMES, bounded by CHARACTERS rather than by count.
 *
 * These come from the template — chain data, not this wallet's — so "there cannot be many" is an
 * assumption about someone else's contract. A count bound made that assumption twice over: twenty
 * names of forty characters is ~1,024, which exceeds `MAX_MESSAGE`, so the backstop silently cut a
 * legitimate list short. A character budget cannot: whatever the names look like, the
 * result fits.
 */
function listNames(names: string[]): string {
  const shown: string[] = []
  let used = 0
  for (const name of names) {
    const rendered = echoSafe(name, 40)
    if (used + rendered.length + 2 > MAX_NAME_LIST) break
    shown.push(rendered)
    used += rendered.length + 2
  }
  const rest = names.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
}

/** At most a few entries are echoed — a caller can supply hundreds and the message is for a human. */
function describeBadEntries(bad: unknown[], type: string): string {
  const SHOWN = 3
  /** Long enough to recognise an entry, short enough that three of them stay readable. */
  const MAX_ENTRY = 40
  const shown = bad.slice(0, SHOWN).map((e) => echoSafe(e, MAX_ENTRY)).join(', ')
  const more = bad.length > SHOWN ? ` and ${bad.length - SHOWN} more` : ''
  const what =
    type === ATTRIBUTE_TYPES.ADDRESS_LIST
      ? 'a valid Zetrix address — a checksum mismatch usually means a mistyped character, so ask the user to confirm rather than correcting it yourself'
      : type === ATTRIBUTE_TYPES.NUMBER_LIST
        ? 'a whole number written as a string'
        : 'a non-empty string'
  return (
    `contains ${bad.length === 1 ? 'an entry that is' : `${bad.length} entries that are`} not ` +
    `${what}: ${shown}${more}.`
  )
}

function parseList(value: unknown): { ok: true; entries: unknown[] } | { ok: false } {
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '[]') return { ok: true, entries: [] }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? { ok: true, entries: parsed } : { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * What preflight can never settle, stated on EVERY result — including error and unconfigured ones.
 * A clean preflight is not permission to spend, and the one network where that matters most is the
 * one where the contracts do not exist.
 */
export function baseNotChecked(network?: string): string[] {
  const items = [
    'Whether the policy will actually be ENFORCED. Nothing outside the policy registry currently ' +
      'consults the decision service, so a valid policy may gate nothing today.',
    'Whether the write will be accepted, and what it will cost — the deploy path is not built yet.',
    // NOT "STEP_UP": the decision service answers ALLOW or DENY and has no third verdict — its
    // DecisionRespDto enforces that at both ends. This sentence shipped naming a state that does
    // not exist, in text an LLM agent reads back to a user.
    'Whether a decision would currently be ALLOW or DENY — that needs off-chain spend ' +
      'state this wallet cannot read. A clean preflight is not permission to spend.',
  ]
  if (network && !network.includes('testnet')) {
    items.push(
      `On ${network} none of this is deployed — there is no policy registry to read, so nothing ` +
        `here has been checked against a real contract.`,
    )
  }
  return items
}

/**
 * Shape a result for a draft we could not even begin to check. Still a full PolicyPreflightResult,
 * never a bare `{error}` — the caller reads every result the same way, and `notChecked` survives.
 */
export function unavailableResult(policyKey: string, reason: string, network?: string): PolicyPreflightResult {
  return finalize({
    policyKey,
    ready: false,
    blockers: [reason],
    interpretation: [],
    notChecked: baseNotChecked(network),
  })
}

/**
 * Reject a draft that is not shaped like a draft at all, returning blockers rather than throwing.
 *
 * The MCP SDK does NOT validate `inputSchema` at runtime — `index.ts` dispatches `fn(args ?? {})`
 * straight through — so an agent can reach this with literally anything. A raw TypeError escaping
 * the tool is not an answer anyone can act on.
 */
function structuralBlockers(draft: DraftPolicy): string[] {
  const blockers: string[] = []
  if (typeof draft?.policyKey !== 'string' || draft.policyKey === '') {
    blockers.push('policyKey is required — it is the key this policy would be stored under.')
  } else if (draft.policyKey.length > MAX_KEY) {
    // Refused, not shortened. The result echoes policyKey back and an agent may reuse it, so
    // handing back a truncated key on a ready:true result would be handing back a DIFFERENT key.
    // No real key is this long.
    blockers.push(
      `policyKey is ${draft.policyKey.length} characters long, which is far beyond any usable key ` +
        `(the limit here is ${MAX_KEY}). Shorten it — this wallet will not guess at a truncation, ` +
        `because a shortened key is a different key.`,
    )
  }
  if (!Array.isArray(draft?.attributes)) {
    blockers.push('attributes must be an array of { attributeName, attributeType, value } rules.')
  } else if (
    draft.attributes.some(
      (a) => !a || typeof a !== 'object' || typeof (a as DraftPolicyAttribute).attributeName !== 'string',
    )
  ) {
    blockers.push('every entry in attributes must be an object with a string attributeName.')
  }
  return blockers
}

/** What one attribute contributes to the three result arrays. */
interface AttributeFindings {
  blockers: string[]
  interpretation: string[]
  notChecked: string[]
}

/** Blockers and interpretation for ONE attribute, given the template vocabulary (null when unread). */
function checkAttribute(
  attribute: DraftPolicyAttribute,
  vocabulary: Map<string, string> | null,
  present: ReadonlySet<string>,
  isValidAddress: ((address: string) => boolean) | undefined,
): { blockers: string[]; interpretation: string[]; notChecked: string[] } {
  const blockers: string[] = []
  const interpretation: string[] = []
  const notChecked: string[] = []
  const { attributeName: name, value } = attribute
  // The TEMPLATE's declared type wins over whatever the draft claims — the template is the
  // authority, and a draft that mislabels a type must not thereby pick its own validation.
  const type = vocabulary?.get(name) ?? attribute.attributeType

  if (vocabulary && !vocabulary.has(name)) {
    blockers.push(
      `"${echoSafe(name)}" is not declared by this template, so it would deploy and then enforce nothing. ` +
        (vocabulary.size === 0
          ? `This template declares no attributes at all.`
          : `Declared attributes are: ${listNames([...vocabulary.keys()])}.`),
    )
    return { blockers, interpretation, notChecked }
  }

  if (INFORMATIONAL_ATTRIBUTES.has(name)) {
    // Legitimate to write, but presenting it as a control is false assurance.
    interpretation.push(
      `"${echoSafe(name)}" is informational only and is never enforced — it records an intention and ` +
        `restricts nothing. Do not rely on it as a control.`,
    )
  }

  const rule = windowRuleFor(name)
  if (rule && !present.has(rule.window)) {
    if (rule.outcome === 'denied') {
      blockers.push(
        `"${echoSafe(name)}" has no "${rule.window}", so the chain rejects it as VALUE_INVALID: ` +
          `${rule.withoutWindowMeans}.`,
      )
    } else {
      interpretation.push(`"${echoSafe(name)}" has no "${rule.window}", so it means ${rule.withoutWindowMeans}.`)
    }
  } else if (rule) {
    interpretation.push(
      `"${echoSafe(name)}" is measured over each "${rule.window}" period, not over the policy's lifetime.`,
    )
  }

  const found = isListType(type)
    ? checkListAttribute(name, type, value, isValidAddress)
    : checkScalarAttribute(name, type, value, vocabulary, rule, isValidAddress)

  return {
    blockers: [...blockers, ...found.blockers],
    interpretation: [...interpretation, ...found.interpretation],
    notChecked: [...notChecked, ...found.notChecked],
  }
}

/**
 * Everything a LIST attribute contributes. Lifted verbatim out of `checkAttribute`, which had
 * grown from 70 lines at base to 156 over five rounds of fixes. The seam is the one the
 * code already had: list handling returns early and shares nothing below it but the result arrays.
 */
function checkListAttribute(
  name: string,
  type: string,
  value: string,
  isValidAddress: ((address: string) => boolean) | undefined,
): AttributeFindings {
  const blockers: string[] = []
  const interpretation: string[] = []
  const notChecked: string[] = []
  const parsed = parseList(value)
  if (!parsed.ok) {
    // Previously this fell through to the affirmative interpretation, so "transfer" (a bare
    // string, not a list) and "[null]" both came back ready with a confident meaning claim.
    blockers.push(
      `"${echoSafe(name)}" is declared ${echoSafe(type)} but "${echoSafe(value)}" is not a list — write it as a JSON ` +
        `array, e.g. ["ZTX3..."].`,
    )
    return { blockers, interpretation, notChecked }
  }

  // Entries first. A list whose entries are unusable does NOT mean what its polarity suggests —
  // on chain `[null].contains('transfer')` is false, so a method allow-list holding [null]
  // permits NOTHING. Emitting "permits ONLY the entries listed" beside that blocker would be the
  // same false assurance in a quieter form.
  const badEntries = parsed.entries.filter((e) => !isValidEntry(e, type, isValidAddress))
  if (badEntries.length > 0) {
    blockers.push(`"${echoSafe(name)}" ${describeBadEntries(badEntries, type)}`)
    return { blockers, interpretation, notChecked }
  }
  if (type === ATTRIBUTE_TYPES.ADDRESS_LIST && !isValidAddress) {
    notChecked.push(
      `Whether "${echoSafe(name)}"'s entries are valid Zetrix addresses — no address validator is wired.`,
    )
  }

  // The four branches below that KNOW the polarity can only fire for a name listPolarity
  // recognises — four short vocabulary names — so their echoSafe calls are belt-and-braces and a
  // mutation removing one survives the suite. Said plainly rather than left as an unexplained
  // survivor: the unknown-polarity branches are the reachable ones, and those are pinned.
  const polarity = listPolarity(name)
  const empty = parsed.entries.length === 0

  if (polarity === 'allow' && empty) {
    blockers.push(
      `"${echoSafe(name)}" is an empty allow-list, which denies EVERYTHING — an empty list contains no one, ` +
        `so every candidate fails the check. This is stored and enforced exactly as written.`,
    )
  } else if (polarity === 'deny' && empty) {
    // NOT a blocker, and the opposite meaning from an empty allow-list. Worth saying plainly,
    // because an empty deny-list is a no-op a user may believe is a restriction.
    interpretation.push(
      `"${echoSafe(name)}" is an empty deny-list, so it blocks nobody — it restricts nothing at all. If you ` +
        `meant to limit who can be paid, that is an allow-list.`,
    )
  } else if (polarity === 'allow') {
    interpretation.push(
      `"${echoSafe(name)}" permits ONLY the entries listed; everything absent from it is denied.`,
    )
  } else if (polarity === 'deny') {
    interpretation.push(
      `"${echoSafe(name)}" BLOCKS the entries listed; everything absent from it is still permitted.`,
    )
  } else {
    // Unknown polarity. Saying nothing about DIRECTION is the only honest option: claiming a list
    // permits what it in fact blocks is worse than declining to interpret it.
    notChecked.push(
      `What "${echoSafe(name)}" means — this wallet does not know whether listing an entry permits it or ` +
        `blocks it, so it will not guess. Check the template's own documentation.`,
    )
    if (empty) {
      // The EMPTINESS is still worth flagging even when the direction is not known, because one
      // of the two readings denies everything. At base every empty list was blocked; scoping the
      // blocker to known polarities made an unknown empty list silent, which is a worse answer
      // than an uncertain one.
      blockers.push(
        `"${echoSafe(name)}" is an empty list. If it is an allow-list it denies EVERYTHING; if it is ` +
          `a deny-list it restricts nothing — this wallet cannot tell which, so it will not let ` +
          `an empty one through unexamined. Confirm the attribute's meaning before deploying.`,
      )
    }
  }


  return { blockers, interpretation, notChecked }
}

/** Everything a NON-list attribute contributes. Lifted verbatim; see `checkListAttribute`. */
function checkScalarAttribute(
  name: string,
  type: string,
  value: string,
  vocabulary: Map<string, string> | null,
  rule: ReturnType<typeof windowRuleFor>,
  isValidAddress: ((address: string) => boolean) | undefined,
): AttributeFindings {
  const blockers: string[] = []
  const interpretation: string[] = []
  const notChecked: string[] = []
  if (type === ATTRIBUTE_TYPES.NUMBER && !isNumericString(value)) {
    blockers.push(`"${echoSafe(name)}" is declared NUMBER but its value "${echoSafe(value)}" is not a whole number.`)
  } else if (type === ATTRIBUTE_TYPES.ADDRESS && isValidAddress && !isValidAddress(value)) {
    // Checksum, not shape. The same KIND of gate transfer_token uses, injected separately — not
    // the same instance; see ToolDeps.isValidAddress. A one-character Base58 typo in a
    // tokenAddress aims the whole policy at a contract that does not exist.
    blockers.push(
      `"${echoSafe(name)}" is declared ADDRESS but "${echoSafe(value)}" is not a valid Zetrix address — its checksum ` +
        `does not match. Ask the user to confirm it rather than correcting it yourself.`,
    )
  } else if (type === ATTRIBUTE_TYPES.ADDRESS && !isValidAddress) {
    // Say so rather than implying the address was accepted.
    notChecked.push(`Whether "${echoSafe(name)}" is a valid Zetrix address — no address validator is wired.`)
  } else if (!CHECKABLE_TYPES.has(type)) {
    notChecked.push(
      `Whether "${echoSafe(name)}"'s value suits its declared type "${echoSafe(type)}" — that type is not one the ` +
        `contract declares, so either this template is unusual or this wallet's type list is stale.`,
    )
  } else if (vocabulary && !INFORMATIONAL_ATTRIBUTES.has(name) && !rule) {
    // Guarded on `vocabulary`: without the template we do not know this attribute is even
    // declared, and stating what it is "limited to" would be a confident claim about a rule that
    // may enforce nothing. Caught live — an x4O2 typo was reported as limited to 1.
    // echoSafe on BOTH: this is the one interpretation that fires on a clean, ready:true result, so
    // an uncapped value here floods the agent's context with no error anywhere to explain it. It is
    // also where a 20,000-deep nested value used to throw RangeError out of the whole tool, because
    // a bare template literal calls Array.prototype.toString, which recurses.
    interpretation.push(`"${echoSafe(name)}" is limited to ${echoSafe(value)}.`)
  }

  return { blockers, interpretation, notChecked }
}


/** `validFromBlock` / `validToBlock` are STRINGS on chain, and `"0"` on the end means open-ended. */
function checkBlockRange(draft: DraftPolicy): string[] {
  const blockers: string[] = []
  if (!isNumericString(draft.validFromBlock)) {
    blockers.push(
      `validFromBlock must be a whole number written as a string, got "${echoSafe(draft.validFromBlock)}".`,
    )
  }
  if (!isNumericString(draft.validToBlock)) {
    blockers.push(
      `validToBlock must be a whole number written as a string, got "${echoSafe(draft.validToBlock)}".`,
    )
  }
  if (
    isNumericString(draft.validFromBlock) &&
    isNumericString(draft.validToBlock) &&
    // "0" means no end date, so from > to is not an inversion here.
    BigInt(draft.validToBlock) !== 0n &&
    BigInt(draft.validFromBlock) > BigInt(draft.validToBlock)
  ) {
    blockers.push(
      `validFromBlock (${echoSafe(draft.validFromBlock)}) is after validToBlock ` +
        `(${echoSafe(draft.validToBlock)}), so this ` +
        `policy would never be in force.`,
    )
  }
  return blockers
}

export async function policyPreflight(
  deps: PolicyPreflightDeps,
  draft: DraftPolicy,
): Promise<PolicyPreflightResult> {
  const notChecked = baseNotChecked(deps.network)

  // Anything that is not shaped like a draft stops here, as blockers rather than an exception.
  const structural = structuralBlockers(draft)
  if (structural.length > 0) {
    return finalize({
      policyKey: typeof draft?.policyKey === 'string' ? draft.policyKey : '',
      ready: false,
      blockers: structural,
      interpretation: [],
      notChecked,
    })
  }

  const blockers: string[] = []
  const interpretation: string[] = []

  const template = await deps.readTemplate(draft)

  if ('error' in template) {
    // A failed lookup is never a pass. Reporting it as "no template" would be a different, and
    // wrong, instruction to the user.
    blockers.push(`Could not read the template (${template.detail}) — retry before deploying.`)
  } else if (template.found === false) {
    blockers.push(
      `No template found for this policy. A policy whose template does not exist declares no ` +
        `vocabulary, so nothing in it can be enforced.`,
    )
  }

  const vocabulary = 'found' in template && template.found === true ? declaredVocabulary(template.value) : null
  const declared = vocabulary ? [...vocabulary.keys()] : undefined

  if (!vocabulary) {
    // FIRST, not last: this note governs everything that follows it, so it has to lead. Silence
    // would read as "nothing worth saying", which is different from "this is unverified".
    interpretation.push(
      'The template could not be read, so what these rules actually mean cannot be confirmed. ' +
        'Treat nothing below as verified until the template resolves.',
    )
  }

  if (draft.attributes.length === 0) {
    blockers.push('This policy has no attributes — it would deploy successfully and restrict nothing.')
  }

  // BEFORE the per-attribute loop, not after. Draft-level blockers are few and fixed; attribute
  // blockers are as many as the caller sends. Appending these last meant `capLines` dropped exactly
  // them — 100 undeclared attributes plus an inverted block range lost the "would never be in
  // force" blocker, which is the one that matters most.
  blockers.push(...checkBlockRange(draft))

  const present = new Set(draft.attributes.map((attribute) => attribute.attributeName))
  for (const attribute of draft.attributes) {
    const found = checkAttribute(attribute, vocabulary, present, deps.isValidAddress)
    blockers.push(...found.blockers)
    interpretation.push(...found.interpretation)
    notChecked.push(...found.notChecked)
  }

  // A policy built only from qualifiers enforces nothing and is refused fail-closed.
  const enforceable = draft.attributes.filter(
    (attribute) =>
      !QUALIFIER_ATTRIBUTES.has(attribute.attributeName) && !INFORMATIONAL_ATTRIBUTES.has(attribute.attributeName),
  )
  if (draft.attributes.length > 0 && enforceable.length === 0) {
    blockers.push(
      `This policy has no enforceable constraint — only qualifiers and informational values. It ` +
        `answers NO_ENFORCEABLE_CONSTRAINTS, which is a DENY, so the agent could spend nothing at all.`,
    )
  }

  return finalize({
    policyKey: draft.policyKey,
    ready: blockers.length === 0,
    ...(declared ? { declared } : {}),
    blockers,
    interpretation,
    notChecked,
  })
}
