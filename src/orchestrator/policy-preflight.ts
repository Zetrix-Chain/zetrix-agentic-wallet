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
import { isAmountCap, isAssetDenominatedCap, isAssetScope } from '../policy-scope-rules.js'
import { checkWindowValue, describeDuration, exceedsDefaultRetention, isWindowAttribute, windowHint } from '../policy-window-format.js'
import { formatHumanAmount, MAX_TOKEN_DECIMALS } from '../clients/token-info-client.js'
import { ZTX_DECIMALS } from '../clients/token-balance-client.js'
import type { PolicyVocabulary, VocabularyRead } from '../clients/policy-vocabulary-client.js'
import { checkAgainstVocabulary, isEnforceableAttribute } from './policy-vocabulary-checks.js'

export interface DraftPolicyAttribute {
  attributeName: string
  attributeType: string
  /** The raw value. Absent only when `valueHuman` is given instead. */
  value: string
  /**
   * A human amount, in whole tokens, for an amount attribute (perTransactionMax, cumulativeMax, velocityCap) — "100" for
   * 100 JMYR. The wallet converts it with the asset's own decimals and writes the raw value. Raw MCP input, so typed
   * `unknown` and validated here. Never for a count or a duration.
   */
  valueHuman?: unknown
}

export interface DraftPolicy {
  policyKey: string
  attributes: DraftPolicyAttribute[]
  validFromBlock: string
  validToBlock: string
  /** Either identifies the template; the caller supplies whichever it has. */
  templateId?: string
  publisher?: string
  /**
   * How the amount caps (perTransactionMax, cumulativeMax, velocityCap) are written. Omitted: raw base
   * units, and a non-zero cap under one whole token is refused as probably a unit mistake. `"whole"`:
   * whole-token amounts, converted by the wallet. `"base"`: raw units, and the small-value guard is
   * explicitly acknowledged. Typed `unknown` because it is raw MCP input and is validated here.
   */
  amountUnit?: unknown
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
  /**
   * Present only when `amountUnit: "whole"` converted amounts: attribute name -> the RAW value that
   * will be written. `write_policy` applies it, so the value paid for is the value shown here.
   */
  convertedAmounts?: Record<string, string>
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
  /**
   * Registered tokens on this network, symbol -> contract address. Lets preflight tell an agent the
   * address it would otherwise have to ask the user for, and recognise a SYMBOL written where an
   * address belongs. Optional: without it those two hints are simply absent.
   */
  knownTokens?: Readonly<Record<string, string>>
  /**
   * Symbol and decimals for an asset — `"native"` or a token contract address — so an amount can be
   * stated in whole tokens. Returns null when the decimals cannot be read. Optional: without it
   * preflight says it could not state the unit, and never assumes one.
   */
  describeUnit?: (asset: string) => Promise<{ symbol: string; decimals: number } | null>
  /**
   * The service's own attribute vocabulary (`GET /policy/vocabulary`). Optional: without it preflight
   * runs on its built-in rules alone and says nothing about the vocabulary. When it IS wired and the
   * read fails, the result says so in `notChecked` and every other finding is unchanged.
   */
  readVocabulary?: () => Promise<VocabularyRead>
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
    'Whether the policy will actually be ENFORCED. This wallet cannot see whether anything ' +
      'consults the decision service for a given spend, so a valid policy may still gate nothing.',
    'Whether the write will be accepted, and what it will cost. The write service applies rules of ' +
      'its own that this check mirrors but cannot guarantee, and the price is only known from its ' +
      'quote — write_policy with dryRun asks for it without paying.',
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
  } else {
    // Each name once. Every scope and token rule below reads the FIRST attribute with a name, so a
    // repeat could carry a value those rules never see — `assetScope: "native"` followed by
    // `assetScope: "JMYR"` read as ready. Which one the service takes is not knowable from here, so a
    // repeat is refused outright rather than guessed at.
    const counts = new Map<string, number>()
    for (const a of draft.attributes) counts.set(a.attributeName, (counts.get(a.attributeName) ?? 0) + 1)
    const repeated = [...counts].filter(([, count]) => count > 1)
    if (repeated.length > 0) {
      const shown = repeated.slice(0, MAX_REPEATED_SHOWN).map(([name, count]) => `"${echoSafe(name)}" (${count} times)`)
      const more = repeated.length > shown.length ? ` and ${repeated.length - shown.length} more` : ''
      blockers.push(
        `Each attribute may appear only once, but ${shown.join(', ')}${more} appear more than once. Which value ` +
          `the write service would take is not something this wallet can tell, so a repeated name is refused ` +
          `rather than guessed at — most dangerously for "assetScope" and "tokenAddress", where the repeat ` +
          `could carry a value the service refuses.`,
      )
    }
  }
  return blockers
}

/** How many repeated names the duplicate blocker spells out; the rest are counted. */
const MAX_REPEATED_SHOWN = 5

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
  knownTokens: Readonly<Record<string, string>> | undefined,
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
    if (rule.outcome === 'not-requested') {
      // Not an interpretation: with no period the count is not the limit that was asked for. The wallet's own rule says it
      // is not requested at all and ms-zetrix describes it as refusing every transfer; either way the owner does not get
      // the limit they wrote, and the fix (add the window) is free. Consistent with how a velocityCap without its window
      // is already refused.
      blockers.push(
        `"${echoSafe(name)}" has no "${rule.window}", so it is not the limit you asked for: ${rule.withoutWindowMeans}. ` +
          `ms-zetrix's published vocabulary (read 2026-10-07) says that without it every transfer is refused; either way it ` +
          `gives no count limit. ` +
          `Add "${rule.window}" (a duration such as 1d).`,
      )
    } else if (rule.outcome === 'denied') {
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
    : checkScalarAttribute(name, type, value, vocabulary, rule, isValidAddress, knownTokens)

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
  knownTokens: Readonly<Record<string, string>> | undefined,
): AttributeFindings {
  const blockers: string[] = []
  const interpretation: string[] = []
  const notChecked: string[] = []
  if (type === ATTRIBUTE_TYPES.NUMBER && !isNumericString(value)) {
    blockers.push(`"${echoSafe(name)}" is declared NUMBER but its value "${echoSafe(value)}" is not a whole number.`)
  } else if (type === ATTRIBUTE_TYPES.ADDRESS && isValidAddress && !isValidAddress(value) && name === 'tokenAddress' && registeredSymbol(value, knownTokens)) {
    // A registered SYMBOL where an address belongs. The draft-level token rule already says what
    // to write instead — and the generic advice below ("ask the user, do not correct it") would
    // contradict it, since for a registered token correcting it IS the right move.
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
    if (name === 'assetScope') {
      // A scope the service refuses gets NO meaning here: it is a draft-level blocker, and
      // "limited to JMYR" beside that blocker is the confident claim about an unusable value that
      // this rule exists to stop. A recognised one gets what it actually governs.
      if (isAssetScope(value)) interpretation.push(scopeMeaning(value))
    } else {
      interpretation.push(`"${echoSafe(name)}" is limited to ${echoSafe(value)}.`)
    }
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

/**
 * The write service's scope rules, applied to a whole draft — see `policy-scope-rules.ts` for what
 * they are, where they come from and why they are here.
 *
 * Draft-level, so they are pushed BEFORE the per-attribute blockers: attribute faults are as many
 * as the caller sends, and `capLines` would otherwise drop exactly these.
 *
 * `vocabulary` is only used to say something useful about a `ztp20` draft against a template that
 * cannot express one. It is null when the template could not be read, and the rules still apply —
 * none of them needs the template.
 */
/** The registered token whose SYMBOL this value is, if any — exact, case-insensitive. */
function registeredSymbol(value: unknown, knownTokens: Readonly<Record<string, string>> | undefined): string | undefined {
  if (typeof value !== 'string' || !knownTokens) return undefined
  const symbol = value.trim().toUpperCase()
  return Object.prototype.hasOwnProperty.call(knownTokens, symbol) ? symbol : undefined
}

function knownTokenList(knownTokens: Readonly<Record<string, string>> | undefined): string {
  const entries = Object.entries(knownTokens ?? {})
  return entries.map(([symbol, address]) => `${echoSafe(symbol)} is ${echoSafe(address)}`).join('; ')
}

function checkScopeRules(
  attributes: DraftPolicyAttribute[],
  vocabulary: Map<string, string> | null,
  knownTokens?: Readonly<Record<string, string>>,
): string[] {
  const blockers: string[] = []
  const scopeAttribute = attributes.find((a) => a.attributeName === 'assetScope')
  const scope: unknown = scopeAttribute?.value
  const recognised = isAssetScope(scope)

  // Rule 1. A scope the service does not recognise — and no meaning is offered for it anywhere else.
  if (scopeAttribute && !recognised) {
    blockers.push(
      `"assetScope" is "${echoSafe(scope)}", which the write service refuses. It must be written ` +
        `exactly "native" or "ztp20" — lower case, and never a token symbol such as JMYR. A token is ` +
        `named by its address in "tokenAddress", with "assetScope" set to "ztp20".`,
    )
  }

  // Rule 5. A native policy that also names a token governs only that token and is ignored for native payments,
  // so it would not limit ZTX at all while reading as if it did. Built in, not read from the vocabulary, so it holds when the
  // vocabulary could not be read.
  if (recognised && scope === 'native' && attributes.some((a) => a.attributeName === 'tokenAddress')) {
    blockers.push(
      `"assetScope" is "native" but a "tokenAddress" is also named. A policy that names a token governs only that token and never ` +
        `native payments, so this one would not limit ZTX at all. Use "assetScope": "ztp20" with the "tokenAddress" for a token, or ` +
        `remove "tokenAddress" for ZTX.`,
    )
  }

  // Rule 2. A ztp20 policy must say which token.
  if (recognised && scope === 'ztp20') {
    const token = attributes.find((a) => a.attributeName === 'tokenAddress')
    const named = typeof token?.value === 'string' && token.value.trim() !== ''
    if (!named) {
      blockers.push(
        `"assetScope" is "ztp20" but no "tokenAddress" says which token. Without one the cap does not ` +
          `limit "ztp20 spending" — it gives every token its own full-sized budget.` +
          // Only when we KNOW the template lacks it. An unread template says nothing either way.
          (vocabulary && !vocabulary.has('tokenAddress')
            ? ` The template you chose does not declare "tokenAddress", so it cannot express a ztp20 ` +
              `policy at all — choose a template that does (get_policy_template_schema lists them).`
            : '') +
          // The wallet already knows these. Saying so is the difference between an agent that asks the
          // user to paste a contract address and one that does not need to.
          (Object.keys(knownTokens ?? {}).length > 0
            ? ` Tokens this wallet knows on this network: ${knownTokenList(knownTokens)}. Use the address that matches ` +
              `the token the user named; if it is none of these, ask the user for the contract address.`
            : ''),
      )
    }
  }

  // Rule 4. A token SYMBOL where the contract address belongs.
  const tokenAttribute = attributes.find((a) => a.attributeName === 'tokenAddress')
  const symbol = registeredSymbol(tokenAttribute?.value, knownTokens)
  if (symbol && knownTokens) {
    blockers.push(
      `"tokenAddress" is "${echoSafe(tokenAttribute?.value)}", which is a token symbol, not an address. ` +
        `${echoSafe(symbol)} on this network is ${echoSafe(knownTokens[symbol])} — write that address instead.`,
    )
  }

  // Rule 3. A cap with no asset is a cap of nothing. When a scope IS present but unrecognised, rule 1
  // has already said what is wrong and repeating it per cap would only add noise.
  if (!scopeAttribute) {
    const caps = attributes.map((a) => a.attributeName).filter(isAssetDenominatedCap)
    if (caps.length > 0) {
      blockers.push(
        `${caps.map((c) => `"${c}"`).join(', ')} ${caps.length > 1 ? 'are caps' : 'is a cap'} measured in an ` +
          `asset, but no "assetScope" says which — a cap of 1000 with no asset is 1000 of nothing, and the ` +
          `write service refuses it. Add "assetScope": "native" for ZTX, or "ztp20" together with a ` +
          `"tokenAddress" for a token.`,
      )
    }
  }

  return blockers
}

/**
 * Every `*Window` the service would refuse, and a note for one it may. Draft-level, like the scope
 * rules, so a flood of attribute faults cannot push it out of the capped list. See
 * policy-window-format.ts for the rule and its source.
 */
function checkWindowFormats(attributes: DraftPolicyAttribute[]): { blockers: string[]; notes: string[]; interpretation: string[] } {
  const blockers: string[] = []
  const notes: string[] = []
  const interpretation: string[] = []
  for (const attribute of attributes) {
    if (!isWindowAttribute(attribute.attributeName)) continue
    const name = echoSafe(attribute.attributeName)
    const checked = checkWindowValue(attribute.value)
    if (!checked.ok) {
      const hint = windowHint(attribute.value)
      blockers.push(
        `"${name}" is "${echoSafe(attribute.value)}", which the write service refuses. A window is a duration ` +
          `written like 7d, 12h, 30m or 45s (or ISO-8601, P7D) — ${
            checked.reason === 'bare_number'
              ? 'a bare number is refused because it would be read as milliseconds'
              : checked.reason === 'not_positive'
                ? 'it must be greater than zero'
                : checked.reason === 'padded'
                  ? 'it has spaces around it — write it with none'
                  : checked.reason === 'too_large'
                    ? 'it is longer than anything the service could retain'
                    : `"${echoSafe(attribute.value)}" is not one`
          }.` + (hint ? ` For that, write ${hint}.` : ''),
      )
    } else {
      // The period, in words, beside the value as written. Without it a valid-but-wrong window passes
      // silently: "1M" is one MINUTE, so a monthly cap written that way resets ~43,000 times a month.
      interpretation.push(
        `"${name}" is "${echoSafe(attribute.value)}", which is ${describeDuration(checked.ms, checked.subMs)}.`,
      )
      if (exceedsDefaultRetention(checked.ms)) notes.push(
        `"${name}" is longer than 30d, which is the service's default retention. The service refuses a ` +
          `window it cannot retain, and whether this environment allows longer is not visible from here.`,
      )
    }
  }
  return { blockers, notes, interpretation }
}

/** What an amount is denominated in — resolved once, because three things need it. */
type UnitState = { kind: 'known'; symbol: string; decimals: number } | { kind: 'no-scope' } | { kind: 'unreadable' }

/**
 * The asset the amounts are in: native ZTX (a constant), or the token named by `tokenAddress`
 * (read through `describeUnit`). `no-scope` when the draft does not name a usable asset — the scope
 * rules have already blocked that, and a unit stated against an unknown asset would be a guess.
 * `unreadable` when the decimals could not be read: never assumed, never defaulted to a scale.
 */
async function resolveUnit(attributes: DraftPolicyAttribute[], deps: PolicyPreflightDeps): Promise<UnitState> {
  const scope = attributes.find((a) => a.attributeName === 'assetScope')?.value
  const tokenValue = attributes.find((a) => a.attributeName === 'tokenAddress')?.value
  // A policy that names a token governs ONLY that token and never native payments (the service's own words), so "native" with a
  // tokenAddress is not an amount of ZTX: its cap applies to the token, whose decimals are not ZTX's. No asset is known, so nothing
  // is converted; the scope rule below refuses the draft with the reason.
  if (scope === 'native' && attributes.some((a) => a.attributeName === 'tokenAddress')) return { kind: 'no-scope' }
  let asset: string | undefined
  if (scope === 'native') asset = 'native'
  else if (scope === 'ztp20' && typeof tokenValue === 'string' && tokenValue.trim() !== '') {
    // A malformed address is already a blocker; do not read the chain for one.
    if (!deps.isValidAddress || deps.isValidAddress(tokenValue)) asset = tokenValue.trim()
  }
  if (asset === undefined) return { kind: 'no-scope' }
  if (asset === 'native') return { kind: 'known', symbol: 'ZTX', decimals: ZTX_DECIMALS }
  if (!deps.describeUnit) return { kind: 'unreadable' }
  try {
    const unit = await deps.describeUnit(asset)
    // Validated again here, whoever supplied it: these decimals scale a value that is WRITTEN, so anything but
    // a bounded whole number is unreadable rather than a scale.
    const sound =
      unit !== null &&
      typeof unit.symbol === 'string' &&
      Number.isInteger(unit.decimals) &&
      unit.decimals >= 0 &&
      unit.decimals <= MAX_TOKEN_DECIMALS
    return sound ? { kind: 'known', symbol: unit.symbol, decimals: unit.decimals } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

const WHOLE_AMOUNT = /^\d{1,40}(\.\d{1,40})?$/
/** The most digits a 256-bit number has. No amount is larger, and a value past it is a mistake. */
const MAX_RAW_DIGITS = 77
const RAW_AMOUNT = /^\d{1,77}$/
/**
 * Why there is no magnitude ceiling on a converted amount. The service parses a NUMBER attribute with
 * `OnChainNumberParser`, which accepts a whole number of up to 200 digits (a BigInteger — nothing wraps at 64
 * bits). A whole part of at most 40 digits scaled by at most MAX_TOKEN_DECIMALS (36) is at most 76 digits, so
 * the bounds above already keep every converted value well inside it; a test pins that.
 */

/**
 * Amounts are written in RAW base units, and a user says "1 JMYR". A real policy went on chain with
 * `perTransactionMax: 1` and `cumulativeMax: 100` for a 6-decimal token — a million times tighter than
 * meant — because nothing made the difference visible before the payment. Two answers:
 *
 *  - `amountUnit: "whole"`: the caller gives whole-token amounts ("1", "0.5") and the WALLET converts
 *    them by the token's decimals. The converted raw values are returned in `convertedAmounts` and
 *    stated in `interpretation`, so what is paid for is what the user saw. Conversion needs known
 *    decimals; it never guesses a scale.
 *  - otherwise the values are raw, and a non-zero cap smaller than ONE WHOLE TOKEN is refused unless
 *    the caller says `amountUnit: "base"` — the explicit "yes, I mean that tiny a value". A guard that
 *    could be satisfied by silence would not be one.
 *
 * Only the amount caps are touched (see AMOUNT_CAPS); a count is not denominated in base units.
 */
function applyAmountUnit(
  attributes: DraftPolicyAttribute[],
  amountUnit: unknown,
  state: UnitState,
): { attributes: DraftPolicyAttribute[]; converted?: Record<string, string>; blockers: string[]; interpretation: string[] } {
  const blockers: string[] = []
  const interpretation: string[] = []
  // null is how a loosely typed channel says "omitted" — not a third unit.
  const mode: unknown = amountUnit === null ? undefined : amountUnit
  if (mode !== undefined && mode !== 'whole' && mode !== 'base') {
    blockers.push(
      `amountUnit is "${echoSafe(mode)}", which is not one of "whole" or "base". Omit it for raw base ` +
        `units, give "whole" to have the wallet convert whole-token amounts, or "base" to confirm raw values.`,
    )
    return { attributes, blockers, interpretation }
  }
  const caps = attributes.filter((a) => isAmountCap(a.attributeName) && typeof a.value === 'string')

  if (mode === 'whole') {
    if (caps.length === 0) return { attributes, blockers, interpretation }
    if (state.kind !== 'known') {
      blockers.push(
        state.kind === 'no-scope'
          ? `amountUnit "whole" needs to know which asset the amounts are in — set "assetScope" to "native", or ` +
            `to "ztp20" with a valid "tokenAddress". Or give raw values and leave amountUnit out.`
          : `amountUnit "whole" needs the token's decimals, which could not be read, so nothing was converted. ` +
            `Retry, or give raw base-unit values with amountUnit "base".`,
      )
      return { attributes, blockers, interpretation }
    }
    const scale = 10n ** BigInt(state.decimals)

    // Converting an already-converted value. `convertedAmounts` is for SHOWING the user; an agent that copies it
    // back into write_policy with amountUnit "whole" would convert it a second time — 1 JMYR becomes
    // 1,000,000 JMYR, a cap a million times LOOSER, written irreversibly. When EVERY amount is already
    // 10^decimals whole tokens or more it looks raw, so it is refused instead of converted. Decimals of 0
    // have no such ambiguity (one unit IS one token).
    if (state.decimals > 0 && caps.every((c) => WHOLE_AMOUNT.test(c.value as string))) {
      if (caps.every((c) => BigInt((c.value as string).split('.')[0]) >= scale)) {
        // The two readings need DIFFERENT routes, and picking the wrong one is the original incident or its
        // reverse: a copied raw value must go back unchanged with "base"; a genuine large cap must be sent as
        // N x 10^decimals with "base". So both are spelled out, with the second worked through for the first
        // amount, rather than one remedy that is wrong for the other reading.
        const first = caps[0]
        const [w, f = ''] = (first.value as string).split('.')
        const asRaw = (BigInt(w) * scale + BigInt(f.padEnd(state.decimals, '0').slice(0, state.decimals) || '0')).toString()
        blockers.push(
          `With amountUnit "whole", every amount here is ${scale.toString()} or more whole ${echoSafe(state.symbol)}, ` +
            `which is what a RAW value looks like, so nothing was converted. If they are already raw (for example ` +
            `copied from convertedAmounts) resend them UNCHANGED with amountUnit "base". If you really mean that ` +
            `many whole tokens, resend with amountUnit "base" and each value times ${scale.toString()} — ` +
            `"${echoSafe(first.attributeName)}" ${echoSafe(first.value)} becomes ${asRaw}. Guessing wrong makes a ` +
            `cap ${scale.toString()} times looser or tighter.`,
        )
        return { attributes, blockers, interpretation }
      }
    }

    const converted: Record<string, string> = {}
    const next = attributes.map((a) => {
      if (!isAmountCap(a.attributeName) || typeof a.value !== 'string') return a
      const name = echoSafe(a.attributeName)
      if (!WHOLE_AMOUNT.test(a.value)) {
        blockers.push(
          `"${name}" is "${echoSafe(a.value)}", which is not a plain amount such as 1 or 0.5. With amountUnit ` +
            `"whole" it must be a number of whole ${echoSafe(state.symbol)}, without units, signs or exponents.`,
        )
        return a
      }
      const [whole, frac = ''] = a.value.split('.')
      if (frac.length > state.decimals) {
        blockers.push(
          `"${name}" is "${echoSafe(a.value)}", which has more decimal places than ${echoSafe(state.symbol)} supports ` +
            `(${state.decimals}). Nothing was rounded.`,
        )
        return a
      }
      const raw = (BigInt(whole) * scale + BigInt(frac.padEnd(state.decimals, '0') || '0')).toString()
      converted[a.attributeName] = raw
      interpretation.push(
        `"${name}": ${echoSafe(a.value)} ${echoSafe(state.symbol)} is written as ${raw} — the raw base-unit value the ` +
          `service stores.`,
      )
      return { ...a, value: raw }
    })
    return Object.keys(converted).length > 0
      ? { attributes: next, converted, blockers, interpretation }
      : { attributes, blockers, interpretation }
  }

  // Raw values (omitted or "base"): bounded in length, because nothing bigger than 256 bits exists and the
  // interpretation below only describes values it can format.
  for (const a of caps) {
    if (/^\d+$/.test(a.value) && a.value.length > MAX_RAW_DIGITS) {
      blockers.push(
        `"${echoSafe(a.attributeName)}" has ${a.value.length} digits — more than any amount that fits in 256 bits ` +
          `(${MAX_RAW_DIGITS} at most). Check the value.`,
      )
    }
  }

  // Raw values. The guard fires only on SILENCE: an explicit "base" is the acknowledgement.
  if (mode === undefined && state.kind === 'known' && state.decimals > 0) {
    const scale = 10n ** BigInt(state.decimals)
    for (const a of caps) {
      if (!RAW_AMOUNT.test(a.value) || BigInt(a.value) === 0n || BigInt(a.value) >= scale) continue
      const value = BigInt(a.value)
      const human = formatHumanAmount(a.value, state.decimals)
      blockers.push(
        `"${echoSafe(a.attributeName)}" is ${a.value}, which is only ${human} ${echoSafe(state.symbol)} — amounts are raw ` +
          `base units, and this is less than one whole token. If you meant ${a.value} ${echoSafe(state.symbol)}, write ` +
          `${(value * scale).toString()} (or pass amountUnit "whole" and give ${a.value}). If ${human} ` +
          `${echoSafe(state.symbol)} really is what you want, pass amountUnit "base" to confirm.`,
      )
    }
  }
  return { attributes, blockers, interpretation }
}

/**
 * `valueHuman`: a human amount for ONE amount attribute, converted with the asset's own decimals.
 *
 * Runs BEFORE the `amountUnit` pass, and takes its attributes out of it: a value converted here is final, so letting
 * `amountUnit: "whole"` see it again would convert it a second time — 100 JMYR becoming 100,000,000 JMYR, a cap a
 * million times looser, written irreversibly.
 *
 * What is an amount comes from the SERVICE when it can be read (`unit: SMALLEST_UNIT`), and from the built-in amount list
 * when it cannot, never the other way round for a refusal: an attribute the service calls a count or a duration is never
 * scaled, whatever the built-in list believes. A conversion needs known decimals and a plain decimal number, and it never
 * rounds; anything it cannot convert exactly is refused with nothing converted.
 */
function applyValueHuman(
  attributes: DraftPolicyAttribute[],
  state: UnitState,
  served: PolicyVocabulary | null,
): {
  attributes: DraftPolicyAttribute[]
  /** Names that carried a valueHuman: finished here, so the `amountUnit` pass leaves them alone. */
  handled: Set<string>
  converted?: Record<string, string>
  blockers: string[]
  interpretation: string[]
} {
  const blockers: string[] = []
  const interpretation: string[] = []
  const handled = new Set<string>()
  const converted: Record<string, string> = {}

  const next = attributes.map((a) => {
    if (a.valueHuman === undefined) return a
    handled.add(a.attributeName)
    const { valueHuman, ...rest } = a
    const name = echoSafe(a.attributeName)
    // A raw value beside it has to be text. Anything else (a number, an object) would slip past the agreement check below and be
    // replaced by the conversion without ever being compared.
    const givenValue = (a as { value?: unknown }).value
    if (givenValue !== undefined && givenValue !== null && typeof givenValue !== 'string') {
      blockers.push(`"${name}" has a value that is not text: give value as text such as "1000000", or drop it and give valueHuman alone.`)
      return rest
    }

    // The text of what the caller said. A finite number is as good as a string: a model may send either.
    // A number is accepted only when it is a safe whole number: JSON has already rounded anything larger or fractional (a decimal
    // such as 0.1 + 0.2 arrives as 0.30000000000000004), so the text echoed back would not be what the user said. Write it as text.
    const text =
      typeof valueHuman === 'string' ? valueHuman : typeof valueHuman === 'number' && Number.isSafeInteger(valueHuman) && valueHuman >= 0 ? String(valueHuman) : undefined
    if (text === undefined) {
      blockers.push(
        typeof valueHuman === 'number'
          ? `"${name}" has a valueHuman given as a number that is not a whole number, or is too large to be exact: write it as text, ` +
              `for example "0.5" or "100", in whole tokens.`
          : `"${name}" has a valueHuman that is not an amount: give a plain number such as 100 or 0.5, in whole tokens.`,
      )
      return rest
    }

    // Is this an amount at all? The service's word first; the built-in list only when the service is silent.
    const unit = served?.attributes.find((x) => x.name === a.attributeName)?.unit ?? null
    if (unit === 'COUNT') {
      blockers.push(`"${name}" is a count, not an amount, so valueHuman does not apply to it: give it as value (for example "5"). A count is never scaled.`)
      return rest
    }
    if (unit === 'DURATION') {
      blockers.push(`"${name}" is a duration, not an amount, so valueHuman does not apply to it: give it as value, for example "7d". A duration is never scaled.`)
      return rest
    }
    // The service listed it, but not as an amount in the smallest unit (no unit, or one this wallet does not know): the built-in list
    // must not override that and scale it anyway. Only the service's own SMALLEST_UNIT, or the built-in list when the service is
    // silent, makes an attribute an amount.
    if (served?.attributes.some((x) => x.name === a.attributeName) === true && unit !== 'SMALLEST_UNIT') {
      blockers.push(
        `"${name}" is listed by the service as ${unit === null ? 'having no unit' : `a ${echoSafe(unit)}`}, not as an amount in the smallest unit, so valueHuman ` +
          `does not apply to it: give it as value.`,
      )
      return rest
    }
    if (unit !== 'SMALLEST_UNIT' && !isAmountCap(a.attributeName)) {
      blockers.push(`"${name}" is not an amount attribute, so valueHuman does not apply to it: give it as value.`)
      return rest
    }

    if (state.kind === 'no-scope') {
      blockers.push(
        `"${name}" has a valueHuman, which needs to know which asset the amount is in — set "assetScope" to "native", or to ` +
          `"ztp20" with a valid "tokenAddress". Or give the raw value instead.`,
      )
      return rest
    }
    if (state.kind === 'unreadable') {
      blockers.push(
        `"${name}" has a valueHuman, which needs the token's decimals, and they could not be read, so nothing was converted. ` +
          `Retry, or give the raw base-unit value.`,
      )
      return rest
    }

    if (!WHOLE_AMOUNT.test(text)) {
      blockers.push(
        `"${name}" has a valueHuman of "${echoSafe(text)}", which is not a plain amount such as 100 or 0.5. It must be a number of ` +
          `whole ${echoSafe(state.symbol)}, without units, signs, separators or exponents.`,
      )
      return rest
    }
    const [whole, frac = ''] = text.split('.')
    if (frac.length > state.decimals) {
      blockers.push(
        `"${name}" has a valueHuman of "${echoSafe(text)}", which has more decimal places than ${echoSafe(state.symbol)} supports ` +
          `(${state.decimals}). Nothing was rounded.`,
      )
      return rest
    }
    const scale = 10n ** BigInt(state.decimals)
    const raw = (BigInt(whole) * scale + BigInt(frac.padEnd(state.decimals, '0') || '0')).toString()

    // A raw value alongside it has to say the same thing — the same rule as transfer_token's amount and amountHuman.
    if (typeof rest.value === 'string' && rest.value !== '' && rest.value !== raw) {
      blockers.push(
        `"${name}" has a value of "${echoSafe(rest.value)}" and a valueHuman of "${echoSafe(text)}" ${echoSafe(state.symbol)}, which is ` +
          `${raw} in raw base units: they do not agree. Give one of them, or make them say the same thing.`,
      )
      return rest
    }

    converted[a.attributeName] = raw
    interpretation.push(
      `"${name}": ${echoSafe(text)} ${echoSafe(state.symbol)} is written as ${raw} — the raw base-unit value the service stores.`,
    )
    return { ...rest, value: raw }
  })

  return {
    attributes: next,
    handled,
    ...(Object.keys(converted).length > 0 ? { converted } : {}),
    blockers,
    interpretation,
  }
}

/**
 * What an amount MEANS in whole tokens, stated alongside the raw value. States the conversion and
 * nothing else — it does not guess which the user intended. When the decimals cannot be read it says
 * so rather than assuming a scale.
 */
function describeAmountUnits(attributes: DraftPolicyAttribute[], state: UnitState): { interpretation: string[]; notChecked: string[] } {
  const interpretation: string[] = []
  const notChecked: string[] = []
  const amounts = attributes.filter((a) => isAmountCap(a.attributeName) && typeof a.value === 'string' && RAW_AMOUNT.test(a.value))
  if (amounts.length === 0 || state.kind === 'no-scope') return { interpretation, notChecked }

  if (state.kind === 'unreadable') {
    notChecked.push(
      `What the amounts mean in whole tokens could not be worked out — the token's decimals could not be ` +
        `read. Amounts are in BASE units; do not assume a scale.`,
    )
    return { interpretation, notChecked }
  }

  const symbol = echoSafe(state.symbol)
  for (const attribute of amounts) {
    const raw = String(attribute.value)
    if (state.decimals <= 0) {
      interpretation.push(`"${echoSafe(attribute.attributeName)}" is ${raw} ${symbol} — this token has no decimals, so base units are whole tokens.`)
      continue
    }
    const whole = 10n ** BigInt(state.decimals)
    const human = formatHumanAmount(raw, state.decimals)
    interpretation.push(
      `"${echoSafe(attribute.attributeName)}" is ${raw} in BASE units: ${raw} = ${human} ${symbol}. ` +
        `If you meant 1 ${symbol}, the value is ${whole.toString()}.`,
    )
  }
  return { interpretation, notChecked }
}

/** What a RECOGNISED scope means. Never called for one that is not. */
function scopeMeaning(scope: 'native' | 'ztp20'): string {
  return scope === 'native'
    ? '"assetScope" is "native": this policy governs native ZTX only and does not limit any token.'
    : '"assetScope" is "ztp20": this policy governs payments in ONE ZTP20 token — the one named by ' +
        '"tokenAddress" — and nothing else.'
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

  // The unit is only read when there is an amount to read it for — no chain call otherwise. A valueHuman is an amount to
  // read it for too.
  const unitState: UnitState = draft.attributes.some((a) => isAmountCap(a.attributeName) || a.valueHuman !== undefined)
    ? await resolveUnit(draft.attributes, deps)
    : { kind: 'no-scope' }

  // The service's own vocabulary is read BEFORE the amount passes: valueHuman asks it what is an amount.
  // The reader is documented never to throw, but this is the last check before a paid write: a reader that does is
  // reported as unavailable, like any other read that could not be completed, and never takes preflight down.
  let vocabularyRead: VocabularyRead | undefined
  if (deps.readVocabulary) {
    try {
      vocabularyRead = await deps.readVocabulary()
    } catch (e) {
      vocabularyRead = { available: false, cause: 'unreachable', detail: `the vocabulary reader failed — ${echoSafe((e as Error)?.message ?? e, 120)}` }
    }
  }

  // valueHuman first. What it converts is final, so the amountUnit pass is given only the attributes it did not.
  const humanPass = applyValueHuman(draft.attributes, unitState, vocabularyRead?.available ? vocabularyRead.vocabulary : null)
  const plain = humanPass.attributes.filter((x) => !humanPass.handled.has(x.attributeName))
  const plainPass = applyAmountUnit(plain, draft.amountUnit, unitState)
  let plainIndex = 0
  const amountPass = {
    attributes: humanPass.attributes.map((x) => (humanPass.handled.has(x.attributeName) ? x : plainPass.attributes[plainIndex++])),
    blockers: [...humanPass.blockers, ...plainPass.blockers],
    interpretation: [...humanPass.interpretation, ...plainPass.interpretation],
    ...(humanPass.converted || plainPass.converted ? { converted: { ...humanPass.converted, ...plainPass.converted } } : {}),
  }
  // Everything below judges the attributes AS THEY WILL BE WRITTEN, so a converted amount is checked
  // like any other NUMBER rather than rejected for being "1.5".
  const attributes = amountPass.attributes

  // An attribute with neither `value` nor `valueHuman` has nothing to write. NUMBER, list, window and scope attributes were refused
  // for it already, but only incidentally; a STRING attribute (unknownAttributePolicy, settlementChannel) was not, and went on the
  // wire with no value. Refused here for every type, and skipped by the per-attribute checks below since it is already said.
  for (const a of attributes) {
    if (typeof a.value !== 'string') {
      blockers.push(`"${echoSafe(a.attributeName)}" has no value: give "value" (the exact text to store) or, for an amount, "valueHuman".`)
    }
  }

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

  if (attributes.length === 0) {
    blockers.push('This policy has no attributes — it would deploy successfully and restrict nothing.')
  }

  // BEFORE the per-attribute loop, not after. Draft-level blockers are few and fixed; attribute
  // blockers are as many as the caller sends. Appending these last meant `capLines` dropped exactly
  // them — 100 undeclared attributes plus an inverted block range lost the "would never be in
  // force" blocker, which is the one that matters most.
  blockers.push(...checkBlockRange(draft))
  // Draft-level, like the block range: the service refuses these at its free pre-check, so
  // preflight must too. Before the per-attribute loop so a flood of attribute faults cannot
  // push them out of the capped list.
  blockers.push(...checkScopeRules(attributes, vocabulary, deps.knownTokens))
  const windows = checkWindowFormats(attributes)
  blockers.push(...windows.blockers)
  interpretation.push(...windows.interpretation)
  blockers.push(...amountPass.blockers)
  interpretation.push(...amountPass.interpretation)

  const present = new Set(attributes.map((attribute) => attribute.attributeName))
  for (const attribute of attributes) {
    if (typeof attribute.value !== 'string') continue // already refused above
    const found = checkAttribute(attribute, vocabulary, present, deps.isValidAddress, deps.knownTokens)
    blockers.push(...found.blockers)
    interpretation.push(...found.interpretation)
    notChecked.push(...found.notChecked)
  }

  const fromService = checkAgainstVocabulary(attributes, vocabulary ? new Set(vocabulary.keys()) : null, vocabularyRead)
  blockers.push(...fromService.blockers)
  interpretation.push(...fromService.interpretation)
  notChecked.push(...fromService.notChecked)

  notChecked.push(...windows.notes)
  const units = describeAmountUnits(attributes, unitState)
  interpretation.push(...units.interpretation)
  notChecked.push(...units.notChecked)

  // A policy built only from qualifiers enforces nothing and is refused fail-closed.
  const enforceable = attributes.filter(
    (attribute) =>
      isEnforceableAttribute(
        attribute.attributeName,
        vocabularyRead?.available ? vocabularyRead.vocabulary : null,
        attributes.some((a) => a.attributeName === 'unknownAttributePolicy' && a.value === 'ignore'),
      ),
  )
  if (attributes.length > 0 && enforceable.length === 0) {
    blockers.push(
      `This policy has no enforceable constraint — only qualifiers and informational values. It ` +
        `answers NO_ENFORCEABLE_CONSTRAINTS, which is a DENY, so the agent could spend nothing at all.`,
    )
  }

  return finalize({
    policyKey: draft.policyKey,
    ready: blockers.length === 0,
    ...(declared ? { declared } : {}),
    ...(amountPass.converted ? { convertedAmounts: amountPass.converted } : {}),
    blockers,
    interpretation,
    notChecked,
  })
}
