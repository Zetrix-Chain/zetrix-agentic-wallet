/**
 * Finding the templates a publisher has on chain — the step that has to come BEFORE a policy can
 * be written, and that nothing in the wallet could do.
 *
 * WHY THIS EXISTS. `write_policy` needs a `templateId`. The only place the wallet could learn one
 * was "as it appears inside a deployed policy", and a first-time user has none — the policy
 * contract is created lazily, by the first write. Asking it to "show me the policy template" went
 * nowhere: the agent asked the user for a publisher and a template contract, neither of which the
 * user should ever have to supply (verified live, 2026-09-30).
 *
 * WHAT THE CHAIN OFFERS, all read directly rather than assumed:
 *
 * - `listTemplateKeys({publisher})` on the Template contract returns the publisher's template keys
 *   (`["native-v1","ztp20-v1"]` for the testnet publisher).
 * - A template's id is `sha256('template|' + publisher + '|' + templateKey)`, 64 lowercase hex.
 * - The raw template record carries NO id field, so no read can simply hand one over; it has to be
 *   derived.
 *
 * DERIVED IS NOT CONFIRMED. The derivation is a rule of the contract as documented, and a wallet
 * that hands an agent an id which does not resolve sends it into a paid write that fails on chain.
 * So an id is only returned once `getTemplateById` has actually found it — the same call that
 * returns the attributes, so confirming costs nothing extra.
 */

import { createHash } from 'node:crypto'
import { getTemplateById, queryPolicy, declaredVocabulary, type PolicyRead } from './policy-read-client.js'
import type { ContractQuery } from './token-info-client.js'

/** `sha256('template|' + publisher + '|' + templateKey)` — see the file header. */
export function deriveTemplateId(publisher: string, templateKey: string): string {
  return createHash('sha256').update(`template|${publisher}|${templateKey}`).digest('hex')
}

/**
 * The most templates one listing will read.
 *
 * Keys come from chain, and a publisher controls how many it has. Each one costs a read, and each
 * is echoed into tool output an agent reads, so the count is bounded rather than trusted. Today's
 * testnet publisher has two.
 */
export const MAX_TEMPLATES = 20

/** The most declared attributes echoed per template. */
export const MAX_DECLARED = 40

/**
 * The longest key or attribute name that is echoed.
 *
 * Longer ones are OMITTED and counted, never truncated: these are identifiers the caller will pass
 * back (a key, an attribute name in a draft), and a shortened one still looks like a real one. Every
 * real v1 name is well under this.
 */
export const MAX_IDENTIFIER = 64

/**
 * The template keys a publisher has, on the Template contract.
 *
 * Three states, like every other read here: `found:false` means the chain answered and the
 * publisher has none; `error` means we do not know. An empty list is deliberately `found:false`
 * rather than `found:true` with nothing in it, so "no templates" cannot be read as "templates
 * exist".
 *
 * An empty `publisher` is refused BEFORE the call. The contract builds its storage key by
 * concatenation, so an absent publisher simply misses and answers like a real absence — a wallet
 * bug that dropped it would be indistinguishable from "this publisher has no templates".
 */
export async function listTemplateKeys(
  publisher: string,
  templateAddress: string,
  query: ContractQuery,
): Promise<PolicyRead<string[]>> {
  if (typeof publisher !== 'string' || publisher.trim() === '') {
    return {
      error: 'query_failed',
      detail: 'listTemplateKeys: no publisher supplied, so there is nothing to list templates for',
    }
  }
  const raw = await queryPolicy(templateAddress, 'listTemplateKeys', { publisher }, query)
  if (!raw.ok) return { error: 'query_failed', detail: raw.detail }
  if (!Array.isArray(raw.value)) {
    return { error: 'query_failed', detail: 'listTemplateKeys: expected an array of key strings' }
  }
  const keys = raw.value.filter((k): k is string => typeof k === 'string' && k !== '')
  // A non-empty answer that contained nothing usable is a malformed reply, not an absence.
  if (raw.value.length > 0 && keys.length === 0) {
    return { error: 'query_failed', detail: 'listTemplateKeys: the reply held no usable key strings' }
  }
  return keys.length === 0 ? { found: false } : { found: true, value: keys }
}

export interface DiscoveredTemplate {
  policyKey: string
  /**
   * Present ONLY when the chain resolved it. An id that was derived but did not resolve is not
   * handed over — see `templateIdConfirmed`.
   */
  templateId?: string
  templateIdConfirmed: boolean
  declared?: Array<{ name: string; type: string }>
  /** Declared attributes left out for being too many or too long; 0 and absent when none. */
  declaredOmitted?: number
  /** Why this entry has no usable id or attributes. Never a guess. */
  error?: string
}

export type TemplateListing =
  | {
      found: true
      publisher: string
      templates: DiscoveredTemplate[]
      /** How many keys the publisher has, including any not shown. */
      total: number
      /** Keys left out for being over the cap or too long; absent when none. */
      omitted?: number
    }
  | { found: false; publisher: string }
  | { error: string }

/** The declared vocabulary of a template record, bounded. */
function boundedDeclared(record: Parameters<typeof declaredVocabulary>[0]): {
  declared: Array<{ name: string; type: string }>
  omitted: number
} {
  const all = [...declaredVocabulary(record).entries()]
  const usable = all.filter(([name, type]) => name.length <= MAX_IDENTIFIER && type.length <= MAX_IDENTIFIER)
  const shown = usable.slice(0, MAX_DECLARED)
  return { declared: shown.map(([name, type]) => ({ name, type })), omitted: all.length - shown.length }
}

/**
 * List a publisher's templates, each with its declared attributes and a CONFIRMED id.
 *
 * One read per key — `getTemplateById` on the derived id — does both jobs: a `found:true` answer is
 * the confirmation and carries the attributes, so nothing is read twice.
 */
export async function discoverTemplates(
  publisher: string,
  templateAddress: string,
  query: ContractQuery,
): Promise<TemplateListing> {
  const listed = await listTemplateKeys(publisher, templateAddress, query)
  if ('error' in listed) return { error: listed.detail }
  if (listed.found === false) return { found: false, publisher }

  const all = listed.value
  const usable = all.filter((key) => key.length <= MAX_IDENTIFIER)
  const keys = usable.slice(0, MAX_TEMPLATES)

  const templates = await Promise.all(
    keys.map(async (policyKey): Promise<DiscoveredTemplate> => {
      const templateId = deriveTemplateId(publisher, policyKey)
      const read = await getTemplateById(templateId, templateAddress, query)
      if ('error' in read) {
        return { policyKey, templateIdConfirmed: false, error: read.detail }
      }
      if (read.found === false) {
        // The contract LISTED this key but the rule for deriving its id did not find it. Handing
        // over the derived id anyway would send an agent into a paid write against an id that does
        // not exist, so it is withheld.
        return {
          policyKey,
          templateIdConfirmed: false,
          error: 'the contract lists this template but its derived id did not resolve, so no id is offered',
        }
      }
      const { declared, omitted } = boundedDeclared(read.value)
      return {
        policyKey,
        templateId,
        templateIdConfirmed: true,
        declared,
        ...(omitted > 0 ? { declaredOmitted: omitted } : {}),
      }
    }),
  )

  const omitted = all.length - keys.length
  return {
    found: true,
    publisher,
    templates,
    total: all.length,
    ...(omitted > 0 ? { omitted } : {}),
  }
}

/**
 * The id for ONE template, only if the chain confirms it.
 *
 * Used by the explicit `{ publisher, policyKey }` read, which already has the attributes and only
 * needs to know whether the derived id is real.
 */
export async function confirmTemplateId(
  publisher: string,
  templateKey: string,
  templateAddress: string | undefined,
  query: ContractQuery,
): Promise<{ templateId?: string; confirmed: boolean; reason?: string }> {
  if (!templateAddress) {
    return { confirmed: false, reason: 'no Template contract is configured, so the id could not be checked' }
  }
  const templateId = deriveTemplateId(publisher, templateKey)
  const read = await getTemplateById(templateId, templateAddress, query)
  if ('error' in read) return { confirmed: false, reason: read.detail }
  if (read.found === false) {
    return { confirmed: false, reason: 'the derived id did not resolve on the Template contract' }
  }
  return { templateId, confirmed: true }
}
