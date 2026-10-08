/**
 * What the service's own attribute vocabulary adds to a preflight, on top of the wallet's built-in
 * rules.
 *
 * The built-in rules (policy-scope-rules.ts, policy-window-rules.ts, the qualifier and informational
 * sets) stay: they are the fallback when the vocabulary cannot be read, and the tripwire the tests
 * hold against a recorded copy of it. This module only adds what they cannot know:
 *
 *  1. An attribute the service does not recognise. `unknownAttributePolicy` defaults to "deny", so a
 *     policy carrying one refuses every transfer — and the chain template does not say so, because a
 *     template may declare a name the service has never heard of.
 *  2. An attribute used outside the scope it applies to (`allowedMethods` on a native policy), which
 *     the service accepts on write and then cannot enforce.
 *  3. A role, or a "what happens without its pair" answer, that the service gives an attribute and the
 *     built-in rules disagree with. Reported in `notChecked`, and where it matters the STRICTER of the two
 *     answers is used, never the looser: the service's prose is not the evaluator, so a disagreement is
 *     something to confirm, and a label that would make a refused policy pass is not obeyed.
 *
 * It never invents a verdict. Each finding names the attribute, the vocabulary's own words for what
 * happens, and where it applies, the service's bounded description.
 */

import { echoSafe } from './policy-preflight.js'
import type { PolicyVocabulary, VocabularyAttribute, VocabularyRead } from '../clients/policy-vocabulary-client.js'
import { describeUnavailable } from '../clients/policy-vocabulary-client.js'
import { INFORMATIONAL_ATTRIBUTES, QUALIFIER_ATTRIBUTES, windowRuleFor } from '../policy-window-rules.js'

export interface VocabularyFindings {
  blockers: string[]
  interpretation: string[]
  notChecked: string[]
}

interface DraftAttributeLike {
  attributeName: string
  value: string
}

/** The role the built-in sets give a name: what the wallet believed before it could ask. */
function builtInRole(name: string): 'INFORMATIONAL' | 'QUALIFIER' | 'CONSTRAINT' {
  if (INFORMATIONAL_ATTRIBUTES.has(name)) return 'INFORMATIONAL'
  if (QUALIFIER_ATTRIBUTES.has(name)) return 'QUALIFIER'
  return 'CONSTRAINT'
}

/**
 * Whether an attribute enforces anything by itself: only when BOTH the built-in sets and the service call it a
 * constraint. This is the refusal "a policy of only qualifiers enforces nothing", so a disagreement must never loosen
 * it: a service label that calls a qualifier a CONSTRAINT would make a policy the service answers
 * NO_ENFORCEABLE_CONSTRAINTS look ready, and it would be paid for. The service saying something is NOT a constraint
 * does tighten it. An attribute the service does not list falls back to the built-in sets, except that when the
 * policy sets `unknownAttributePolicy: "ignore"` an attribute the service does not know restricts nothing.
 */
export function isEnforceableAttribute(name: string, vocabulary: PolicyVocabulary | null, ignoreUnknown = false): boolean {
  const entry = vocabulary?.attributes.find((a) => a.name === name)
  if (!entry) return vocabulary !== null && ignoreUnknown ? false : builtInRole(name) === 'CONSTRAINT'
  return builtInRole(name) === 'CONSTRAINT' && (entry.role === null || entry.role === 'CONSTRAINT')
}

/** What the built-in window rules say a missing window means, in the service's vocabulary. */
function builtInWithoutPair(cap: string): string | undefined {
  const outcome = windowRuleFor(cap)?.outcome
  if (outcome === 'lifetime') return 'LIFETIME'
  if (outcome === 'denied') return 'UNENFORCEABLE'
  if (outcome === 'not-requested') return 'NOT_A_LIMIT'
  return undefined
}

/** The scope a draft governs when it says so plainly; undefined when it does not. */
function governedScope(attributes: DraftAttributeLike[]): 'native' | 'ztp20' | 'unstated' | undefined {
  const scope = attributes.find((a) => a.attributeName === 'assetScope')
  if (!scope) return 'unstated'
  if (scope.value === 'native' || scope.value === 'ztp20') return scope.value
  return undefined
}

/** Remote text, marked as such: it describes an attribute and is not an instruction to whoever reads it. */
function quoted(description: string): string {
  // JSON.stringify, not bare quotes: a description containing a double quote must not be able to close the quoting and
  // continue as wallet text. The escaping is what keeps the quoted span one span.
  return `The service describes it (text from ms-zetrix; it describes, it does not instruct): ${JSON.stringify(description)}`
}

function outsideScopeFinding(attribute: VocabularyAttribute, scope: string, hasTokenAddress: boolean): string | undefined {
  if (attribute.appliesTo.includes(scope)) return undefined
  const applies = attribute.appliesTo.join(' and ')
  const base =
    `"${echoSafe(attribute.name)}" applies to ${applies} policies only, but this policy's assetScope is ` +
    `"${scope}". ${quoted(attribute.description)}`
  if (attribute.outsideAppliesToMeans === 'UNENFORCEABLE') {
    // A tokenAddress takes the policy off native transfers entirely, which is a different outcome
    // the description spells out; do not call it a refusal when the draft names a token.
    if (hasTokenAddress) return undefined
    return `${base} Outside its scope the service treats it as unenforceable, so it cannot do what it says.`
  }
  if (attribute.outsideAppliesToMeans === 'NOT_GOVERNED' && scope === 'native') {
    return `${base} Outside its scope the policy is not governed by it, so it would never apply to native transfers.`
  }
  return undefined
}

/**
 * Findings from the vocabulary.
 *
 * @param declaredByTemplate names the chain template declares, or null when it was not read. An
 *   attribute the template does not declare is already refused by the template check, so it is not
 *   refused a second time here.
 * @param read the vocabulary read; undefined when this wallet has no vocabulary source at all, in
 *   which case nothing is said, because there is nothing it tried and failed to do.
 */
export function checkAgainstVocabulary(
  attributes: DraftAttributeLike[],
  declaredByTemplate: ReadonlySet<string> | null,
  read: VocabularyRead | undefined,
): VocabularyFindings {
  const found: VocabularyFindings = { blockers: [], interpretation: [], notChecked: [] }
  if (!read) return found
  if (!read.available) {
    found.notChecked.push(
      `${describeUnavailable(read)} Checks that depend on it did not run: attributes the service does not ` +
        `recognise, and attributes used outside the scope they apply to.`,
    )
    return found
  }

  const byName = new Map(read.vocabulary.attributes.map((a) => [a.name, a] as const))
  const ignoreUnknown = attributes.some((a) => a.attributeName === 'unknownAttributePolicy' && a.value === 'ignore')
  const scope = governedScope(attributes)
  const hasTokenAddress = attributes.some((a) => a.attributeName === 'tokenAddress')

  const unknown: string[] = []
  for (const attribute of attributes) {
    const entry = byName.get(attribute.attributeName)
    if (!entry) {
      if (!declaredByTemplate || declaredByTemplate.has(attribute.attributeName)) unknown.push(attribute.attributeName)
      continue
    }

    const role = entry.role
    if (role && role !== builtInRole(entry.name)) {
      found.notChecked.push(
        `The service calls "${echoSafe(entry.name)}" ${role}, which differs from the wallet's built-in rules ` +
          `(${builtInRole(entry.name)}). The stricter of the two was used, so a disagreement never makes a policy look ready; ` +
          `the built-in rules may be out of date.`,
      )
    }
    const pair = entry.pairsWith
    if (pair && entry.withoutPairMeans && !attributes.some((a) => a.attributeName === pair)) {
      const service = entry.withoutPairMeans
      const rule = windowRuleFor(entry.name)
      // The built-in outcome speaks only about the window the built-in rule names. If the service pairs this attribute with
      // a DIFFERENT window (a rename), or one the built-in rules do not know at all, the built-in outcome says nothing about
      // this pair: it is unknown, and the only answer there is is the service's.
      const sameWindow = rule?.window === pair
      const builtIn = sameWindow ? builtInWithoutPair(entry.name) : undefined
      const meaning = service === 'NOT_A_LIMIT' ? 'not a limit at all' : service === 'UNENFORCEABLE' ? 'unenforceable' : service

      if (!sameWindow) {
        // ALWAYS said, whatever the service answered, so a rename is never silent.
        found.notChecked.push(
          `Without "${echoSafe(pair)}", the service says "${echoSafe(entry.name)}" is ${service}. The wallet's built-in rules ` +
            (rule ? `pair it with "${echoSafe(rule.window)}" instead` : 'do not know this pairing') +
            `, so nothing built in confirms that. ${quoted(entry.description)} Add "${echoSafe(pair)}" to remove the doubt.`,
        )
      } else if (builtIn && builtIn !== service) {
        found.notChecked.push(
          `Without "${echoSafe(pair)}", the service says "${echoSafe(entry.name)}" is ${service}, but the ` +
            `wallet's built-in note says ${builtIn}. They disagree, so what "${echoSafe(entry.name)}" does here is not ` +
            `confirmed. ${quoted(entry.description)} Add "${echoSafe(pair)}" to remove the doubt.`,
        )
      }
      // The preflight already refuses a cap whose built-in rule is "denied" or "not-requested". What it cannot know is a
      // pairing the service calls unenforceable or not a limit while the built-in rules call something looser, or do not know
      // it at all. The STRICTER answer wins: such a cap does not give the owner the limit they wrote, and the fix is free.
      const alreadyRefused = builtIn === 'UNENFORCEABLE' || builtIn === 'NOT_A_LIMIT'
      if ((service === 'UNENFORCEABLE' || service === 'NOT_A_LIMIT') && !alreadyRefused) {
        found.blockers.push(
          `"${echoSafe(entry.name)}" has no "${echoSafe(pair)}", and the service says that makes it ${meaning}. ` +
            `${quoted(entry.description)} Add "${echoSafe(pair)}".`,
        )
      }
    }
    if (role === 'INFORMATIONAL' && !INFORMATIONAL_ATTRIBUTES.has(entry.name)) {
      found.interpretation.push(
        `"${echoSafe(entry.name)}" is informational only and is never enforced — it records an intention and ` +
          `restricts nothing. Do not rely on it as a control.`,
      )
    }

    if (scope === 'native' || scope === 'ztp20') {
      const outside = outsideScopeFinding(entry, scope, hasTokenAddress)
      if (outside) found.blockers.push(outside)
    } else if (scope === 'unstated' && !hasTokenAddress && entry.outsideAppliesToMeans === 'UNENFORCEABLE') {
      const outside = outsideScopeFinding(entry, 'native', false)
      if (outside) found.blockers.push(outside.replace(`this policy's assetScope is "native"`, `this policy states no assetScope, which means native`))
    }
  }

  if (unknown.length > 0) {
    const names = unknown.map((n) => `"${echoSafe(n)}"`).join(', ')
    if (ignoreUnknown) {
      found.interpretation.push(
        `${names} ${unknown.length > 1 ? 'are not attributes' : 'is not an attribute'} the service recognises. ` +
          `"unknownAttributePolicy" is "ignore", so ${unknown.length > 1 ? 'they are' : 'it is'} skipped and restrict${unknown.length > 1 ? '' : 's'} nothing.`,
      )
    } else {
      found.blockers.push(
        `${names} ${unknown.length > 1 ? 'are not attributes' : 'is not an attribute'} the service recognises. ` +
          `"unknownAttributePolicy" defaults to "deny", so a policy carrying ${unknown.length > 1 ? 'them' : 'it'} ` +
          `refuses every transfer. Remove ${unknown.length > 1 ? 'them' : 'it'}, or set "unknownAttributePolicy" to "ignore" ` +
          `if skipping ${unknown.length > 1 ? 'them' : 'it'} is what is meant.`,
      )
    }
  }
  return found
}
