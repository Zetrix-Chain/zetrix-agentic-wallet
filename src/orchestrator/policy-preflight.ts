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
  isListAttribute,
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
  /** Everything standing in the way, together — never one at a time. */
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
   * omitting it simply drops that one line rather than asserting something untrue (APP-M01).
   */
  network?: string
}

/** Declared types we know how to check. An unrecognised type is NOT a blocker — see notChecked. */
const NUMERIC_TYPES = new Set(['uint', 'uint256', 'int', 'number'])
const BOOLEAN_TYPES = new Set(['bool', 'boolean'])

function isNumericString(value: unknown): boolean {
  return typeof value === 'string' && /^\d+$/.test(value)
}

/** An empty list value, however the caller chose to write it. */
function isEmptyList(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed === '[]') return true
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) && parsed.length === 0
  } catch {
    // Unparseable is not empty — leave it to the type check rather than guessing.
    return false
  }
}

/**
 * What preflight can never settle, stated on EVERY result — including error and unconfigured ones.
 * A clean preflight is not permission to spend, and the one network where that matters most is the
 * one where the contracts do not exist (APP-C02, APP-M01).
 */
export function baseNotChecked(network?: string): string[] {
  const items = [
    'Whether the policy will actually be ENFORCED. Nothing outside the policy registry currently ' +
      'consults the decision service, so a valid policy may gate nothing today.',
    'Whether the write will be accepted, and what it will cost — the deploy path is not built yet.',
    'Whether a decision would currently be ALLOW, STEP_UP or DENY — that needs off-chain spend ' +
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
  return {
    policyKey,
    ready: false,
    blockers: [reason],
    interpretation: [],
    notChecked: baseNotChecked(network),
  }
}

/**
 * Reject a draft that is not shaped like a draft at all, returning blockers rather than throwing.
 *
 * The MCP SDK does NOT validate `inputSchema` at runtime — `index.ts` dispatches `fn(args ?? {})`
 * straight through — so an agent can reach this with literally anything. A raw TypeError escaping
 * the tool is not an answer anyone can act on (APP-M05).
 */
function structuralBlockers(draft: DraftPolicy): string[] {
  const blockers: string[] = []
  if (typeof draft?.policyKey !== 'string' || draft.policyKey === '') {
    blockers.push('policyKey is required — it is the key this policy would be stored under.')
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

/** Blockers and interpretation for ONE attribute, given the template vocabulary (null when unread). */
function checkAttribute(
  attribute: DraftPolicyAttribute,
  vocabulary: Map<string, string> | null,
  present: ReadonlySet<string>,
): { blockers: string[]; interpretation: string[]; notChecked: string[] } {
  const blockers: string[] = []
  const interpretation: string[] = []
  const notChecked: string[] = []
  const { attributeName: name, value } = attribute

  if (vocabulary && !vocabulary.has(name)) {
    blockers.push(
      `"${name}" is not declared by this template, so it would deploy and then enforce nothing. ` +
        `Declared attributes are: ${[...vocabulary.keys()].join(', ')}.`,
    )
    return { blockers, interpretation, notChecked }
  }

  if (INFORMATIONAL_ATTRIBUTES.has(name)) {
    // Legitimate to write, but presenting it as a control is false assurance.
    interpretation.push(
      `"${name}" is informational only and is never enforced — it records an intention and ` +
        `restricts nothing. Do not rely on it as a control.`,
    )
  }

  const rule = windowRuleFor(name)
  if (rule && !present.has(rule.window)) {
    if (rule.outcome === 'denied') {
      blockers.push(
        `"${name}" has no "${rule.window}", so the chain rejects it as VALUE_INVALID: ${rule.withoutWindowMeans}.`,
      )
    } else {
      interpretation.push(`"${name}" has no "${rule.window}", so it means ${rule.withoutWindowMeans}.`)
    }
  } else if (rule) {
    interpretation.push(`"${name}" is measured over each "${rule.window}" period, not over the policy's lifetime.`)
  }

  if (isListAttribute(name)) {
    if (isEmptyList(value)) {
      blockers.push(
        `"${name}" is an empty list, which denies EVERYTHING — an empty list contains no one, so ` +
          `every recipient fails the check. This is stored and enforced exactly as written.`,
      )
    } else {
      interpretation.push(`"${name}" allows ONLY the entries listed; everything absent from it is denied.`)
    }
    return { blockers, interpretation, notChecked }
  }

  const type = vocabulary?.get(name) ?? attribute.attributeType
  if (NUMERIC_TYPES.has(type) && !isNumericString(value)) {
    blockers.push(`"${name}" is declared ${type} but its value "${value}" is not a whole number.`)
  } else if (BOOLEAN_TYPES.has(type) && value !== 'true' && value !== 'false') {
    blockers.push(`"${name}" is declared ${type} but its value "${value}" is not true or false.`)
  } else if (!NUMERIC_TYPES.has(type) && !BOOLEAN_TYPES.has(type)) {
    notChecked.push(
      `Whether "${name}"'s value suits its declared type "${type}" — that type is not one this ` +
        `wallet knows how to check.`,
    )
  } else if (vocabulary && !INFORMATIONAL_ATTRIBUTES.has(name) && !rule) {
    // Guarded on `vocabulary`: without the template we do not know this attribute is even
    // declared, and stating what it is "limited to" would be a confident claim about a rule that
    // may enforce nothing. Caught live — an x4O2 typo was reported as limited to 1.
    interpretation.push(`"${name}" is limited to ${value}.`)
  }

  return { blockers, interpretation, notChecked }
}

/** `validFromBlock` / `validToBlock` are STRINGS on chain, and `"0"` on the end means open-ended. */
function checkBlockRange(draft: DraftPolicy): string[] {
  const blockers: string[] = []
  if (!isNumericString(draft.validFromBlock)) {
    blockers.push(`validFromBlock must be a whole number written as a string, got "${draft.validFromBlock}".`)
  }
  if (!isNumericString(draft.validToBlock)) {
    blockers.push(`validToBlock must be a whole number written as a string, got "${draft.validToBlock}".`)
  }
  if (
    isNumericString(draft.validFromBlock) &&
    isNumericString(draft.validToBlock) &&
    // "0" means no end date, so from > to is not an inversion here.
    BigInt(draft.validToBlock) !== 0n &&
    BigInt(draft.validFromBlock) > BigInt(draft.validToBlock)
  ) {
    blockers.push(
      `validFromBlock (${draft.validFromBlock}) is after validToBlock (${draft.validToBlock}), so this ` +
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
    return {
      policyKey: typeof draft?.policyKey === 'string' ? draft.policyKey : '',
      ready: false,
      blockers: structural,
      interpretation: [],
      notChecked,
    }
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

  const present = new Set(draft.attributes.map((attribute) => attribute.attributeName))
  for (const attribute of draft.attributes) {
    const found = checkAttribute(attribute, vocabulary, present)
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

  blockers.push(...checkBlockRange(draft))

  return {
    policyKey: draft.policyKey,
    ready: blockers.length === 0,
    ...(declared ? { declared } : {}),
    blockers,
    interpretation,
    notChecked,
  }
}
