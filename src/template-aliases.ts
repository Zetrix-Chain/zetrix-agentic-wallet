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
  },
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
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
