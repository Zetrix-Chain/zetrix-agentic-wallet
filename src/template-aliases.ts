/**
 * Named-template alias registry — resolves a caller-friendly name (e.g. "AI Birthcert") to the
 * real per-network did:zid:... credential-definition id, so subscribe_and_issue's caller doesn't
 * need to already know or discover the raw id for well-known templates.
 *
 * A templateId that already looks like a raw did:zid:... is never run through this resolver
 * (see resolveTemplateAlias below) — resolution is purely additive.
 */

import { isValidCountry } from './iso3166.js'

export interface TemplateAliasEntry {
  /** Normalized (lowercased, non-alphanumeric stripped) substring to look for in the caller's input. */
  match: string
  testnet: string
  mainnet: string
  /**
   * Attribute keys this template needs auto-filled by copying another attribute's value —
   * maps target key -> source key. Applied only when the target key isn't already supplied
   * (a truthy caller-supplied value always wins), so this is purely additive like alias
   * resolution itself.
   */
  deriveAttributes?: Record<string, string>
  /**
   * Format/standard validators for optional attribute keys — maps attribute key -> a function
   * returning an error message when the supplied value is invalid, or undefined when it's fine.
   * Only run when the caller actually supplies a (non-empty) value for that key, since these
   * attributes are optional; an absent value is never validated.
   */
  validateAttributes?: Record<string, (value: unknown) => string | undefined>
  /**
   * MBI "pass design" id for this template's issuance, per network — sent as `passDesignId` in
   * `subscribe_and_issue`'s signed `data` payload (see subscribe.ts's `passDesignId` dep). Only the
   * Basic Birthcert has one confirmed so far (2026-09-15); other templates simply omit this key,
   * so `resolvePassDesignId` returns undefined for them rather than sending a mismatched id.
   */
  passDesignId?: { testnet: string; mainnet: string }
}

function validateDob(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'dob must be a string in YYYY-MM-DD format'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `dob must match the format YYYY-MM-DD, got "${value}"`
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  const isRealCalendarDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  if (!isRealCalendarDate) return `dob is not a valid calendar date: "${value}"`
  return undefined
}

function validateCountryOfOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return 'countryOfOrigin must be a non-empty string'
  if (!isValidCountry(value)) return `countryOfOrigin must be an ISO 3166 country code or name, got "${value}"`
  return undefined
}

const TEMPLATE_ALIASES: TemplateAliasEntry[] = [
  {
    match: 'birthcert',
    testnet: 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959',
    mainnet: 'did:zid:19091d19049abb8869b4b8e2f4a887bd1d1d86e5f5ebd0c8297000255f67765b',
    deriveAttributes: { id: 'agentUsername' },
    validateAttributes: { dob: validateDob, countryOfOrigin: validateCountryOfOrigin },
    passDesignId: {
      testnet: 'did:zid:bb7202482ef6053be6d46ad8e2190b0ba1e3b2024d24ce7f37bc4c3747e2378f',
      mainnet: 'did:zid:915955cb71c6fd2a256d04344f57381084903cb6a85a1c9ddb71c746f08932ab',
    },
  },
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * A word that says Verified. Matched inside the word, not as a whole word, so a name written without separators
 * ("VerifiedAIBirthcert", "MyIDverified") still counts (review R3: whole-word matching sent those to Basic).
 * "verifiable" is not one (every credential is verifiable), and "unverified" / "nonverified" / "notverified" say Basic.
 */
function saysVerified(word: string): boolean {
  if (/^(un|non|not)verif/.test(word)) return false
  return (word.includes('verif') && !word.includes('verifiable')) || word.includes('mydigital') || word === 'myid'
}

/** A word that says Basic: self-declared, or not verified. */
function saysBasic(word: string): boolean {
  return ['basic', 'self', 'selfdeclared', 'declared'].includes(word) || /^(un|non|not)verif/.test(word)
}

/** Words that cancel the Verified or Basic word right after them ("not verified", "not the basic one"). */
const NEGATORS = new Set(['not', 'non', 'no', 'un', 'without'])
/** "self" also cancels a Verified word: "self-verified" is self-declared. */
const VERIFIED_NEGATORS = new Set([...NEGATORS, 'self'])
/** A negation never reaches across these: in "not self-declared but verified" the "not" belongs to "self-declared". */
const CLAUSE_BREAKS = new Set(['but', 'and', 'or'])

/** Whether a negator stands up to three words before `i`, within the same clause. */
function negated(words: string[], i: number, negators: Set<string>): boolean {
  for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
    if (CLAUSE_BREAKS.has(words[j])) return false
    if (negators.has(words[j])) return true
  }
  return false
}

/**
 * Which AI Birthcert a loose name means: 'verified', 'basic', 'unclear' when it carries both kinds of wording ("Verified
 * basic AI Birthcert"), or undefined when it is not an AI Birthcert name at all. An unclear name resolves to
 * no template, so it is asked about rather than issued or priced as either kind.
 *
 * A negated word counts for the other side (review R3): "not yet verified" says Basic, and "not the basic one" or
 * "not self-declared" says Verified, so "Verified AI Birthcert, not the basic one" is plainly Verified.
 */
export function aiBirthcertKindOfName(input: string): 'verified' | 'basic' | 'unclear' | undefined {
  if (/^did:zid:/.test(input)) return undefined
  if (!normalize(input).includes('birthcert')) return undefined
  const words = input.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let verified = false
  let basic = false
  words.forEach((w, i) => {
    if (saysVerified(w)) {
      if (negated(words, i, VERIFIED_NEGATORS)) basic = true
      else verified = true
    } else if (saysBasic(w)) {
      if (negated(words, i, NEGATORS)) verified = true
      else basic = true
    }
  })
  if (verified && basic) return 'unclear'
  return verified ? 'verified' : 'basic'
}

/**
 * True for a loose name of the VERIFIED AI Birthcert ("Verified AI Birthcert", "verified birthcert",
 * "verified_ai_birthcert", "birthcert verification", "MyDigital ID AI Birthcert"), which no template alias may
 * resolve. Every such name also contains "birthcert", so before this it resolved to the BASIC template:
 * in the Doc1 QA run a user who chose Verified was priced, and could have been issued, the Basic one.
 *
 * Verification wording (verified / verify / verification, MyDigital ID, MyID) means Verified; a negating or
 * self-declared word ("not yet verified", "non-verified", "self-verified", "without verification", "basic") means
 * Basic. A guess either way costs nothing: subscribe_and_issue refuses a Verified name, and the paid tools ask before
 * paying.
 */
export function isVerifiedAiBirthcertName(input: string): boolean {
  return aiBirthcertKindOfName(input) === 'verified'
}

/**
 * Find the registry entry for a caller-supplied templateId — either a natural-language alias
 * (matched by normalized substring) or an already-resolved raw did:zid:... id (matched by
 * equality against the entry's id for the active network). Shared by resolveTemplateAlias and
 * deriveTemplateAttributes so both recognize the same template regardless of which form the
 * caller passed.
 */
function findEntry(templateId: string, network: string): TemplateAliasEntry | undefined {
  if (/^did:zid:/.test(templateId)) {
    const key = network.includes('testnet') ? 'testnet' : 'mainnet'
    return TEMPLATE_ALIASES.find((e) => e[key] === templateId)
  }
  const kind = aiBirthcertKindOfName(templateId)
  if (kind === 'verified' || kind === 'unclear') return undefined
  const normalized = normalize(templateId)
  return TEMPLATE_ALIASES.find((e) => normalized.includes(e.match))
}

/**
 * Resolve a caller-supplied templateId to a known did:zid:... for the active network. Returns
 * undefined when `input` is already a raw did:zid:... id, or matches no known alias — in both
 * cases the caller's original value should be used as-is (subscribe.ts's own did:zid:... guard
 * reports a clear error for anything that's neither a valid id nor a known alias).
 */
export function resolveTemplateAlias(input: string, network: string): string | undefined {
  if (/^did:zid:/.test(input)) return undefined
  const entry = findEntry(input, network)
  if (!entry) return undefined
  return network.includes('testnet') ? entry.testnet : entry.mainnet
}

/**
 * Fill in any attribute keys the resolved template declares as derivable from another attribute
 * (see `deriveAttributes`), for whichever form of templateId the caller passed (alias or raw
 * did:zid:...). A target key already present and truthy in `attributes` is left untouched.
 */
export function deriveTemplateAttributes(
  templateId: string,
  network: string,
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const entry = findEntry(templateId, network)
  if (!entry?.deriveAttributes) return attributes
  const result = { ...attributes }
  for (const [target, source] of Object.entries(entry.deriveAttributes)) {
    if ((result[target] === undefined || result[target] === null || result[target] === '') && result[source] !== undefined) {
      result[target] = result[source]
    }
  }
  return result
}

/**
 * Attribute keys the resolved template auto-derives from another attribute (see `deriveAttributes`)
 * — the caller never needs to supply or even know about these, so callers presenting the template's
 * schema back to a user (e.g. subscribe_and_issue's `schema.required`/`schema.optional`) should
 * omit them. Returns [] for an unrecognized templateId/alias or a template with no derived keys.
 */
export function derivedAttributeKeys(templateId: string, network: string): string[] {
  const entry = findEntry(templateId, network)
  return entry?.deriveAttributes ? Object.keys(entry.deriveAttributes) : []
}

/**
 * Validate the optional attributes the resolved template declares a format/standard for (see
 * `validateAttributes`), for whichever form of templateId the caller passed. Returns one error
 * message per invalid attribute; an empty array means everything supplied is valid (an absent
 * optional attribute is not an error).
 */
export function validateTemplateAttributes(templateId: string, network: string, attributes: Record<string, unknown>): string[] {
  const entry = findEntry(templateId, network)
  if (!entry?.validateAttributes) return []
  const errors: string[] = []
  for (const [key, validate] of Object.entries(entry.validateAttributes)) {
    const value = attributes[key]
    if (value === undefined || value === null || value === '') continue
    const error = validate(value)
    if (error) errors.push(error)
  }
  return errors
}

/**
 * Resolve the confirmed MBI "pass design" id for whichever form of templateId the caller passed
 * (alias or raw did:zid:...). Returns undefined for any template with no configured pass design —
 * currently only the Basic Birthcert has one — so subscribe_and_issue never sends a mismatched
 * passDesignId alongside an unrelated template's issuance.
 */
export function resolvePassDesignId(templateId: string, network: string): string | undefined {
  const entry = findEntry(templateId, network)
  if (!entry?.passDesignId) return undefined
  return network.includes('testnet') ? entry.passDesignId.testnet : entry.passDesignId.mainnet
}
