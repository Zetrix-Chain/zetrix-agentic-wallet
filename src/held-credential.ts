/**
 * "Does this wallet already hold a valid copy of this credential?" — answered locally and for free.
 *
 * It looks at the credentials the wallet has SAVED (the same cache subscribe_and_issue and
 * check_ai_birthcert_verification write to), under the template the credential is issued from. It makes no network call,
 * and it counts a credential only while it is still valid: an expired one is not worth keeping, and buying a new one is
 * then the right move.
 *
 * What it cannot see: a credential that was paid for and issued but never collected with check_ai_birthcert_verification
 * is not in the cache yet. The paid request_ai_birthcert_verification call has the heavier guard for that case, which also
 * consults the session store; this is the cheap check that lets the free preflight say "you already have one" before the
 * agent has asked the user for anything.
 */

import { isVcValid, type VcCacheStore } from './clients/vc-cache.js'
import { resolveTemplateAlias } from './template-aliases.js'
import { VERIFIED_AI_BIRTHCERT, type HeldCredential } from './orchestrator/preflight.js'

export interface HeldCredentialFinderDeps {
  cache: VcCacheStore
  network: string
  /** The Verified AI Birthcert's own templateId; undefined where it is not confirmed (mainnet), so nothing can be said. */
  verifiedTemplateId?: string
  now?: () => Date
}

export function createHeldCredentialFinder(deps: HeldCredentialFinderDeps): (credential: string) => Promise<HeldCredential | undefined> {
  const basicTemplateId = resolveTemplateAlias('ai birthcert', deps.network)

  return async (credential) => {
    const isVerified = credential === VERIFIED_AI_BIRTHCERT
    const templateId = isVerified ? deps.verifiedTemplateId : (resolveTemplateAlias(credential, deps.network) ?? credential)
    // Not a guess: with no template to look under, "nothing is held" would be a claim this cannot support.
    if (!templateId) return undefined

    const entry = await deps.cache.get(templateId)
    if (!entry || !isVcValid(entry, deps.now?.() ?? new Date())) return undefined

    const label = isVerified
      ? 'Verified AI Birthcert'
      : templateId === basicTemplateId
        ? 'Basic AI Birthcert'
        : `credential for template ${templateId.slice(0, 18)}…`
    return {
      label,
      ...(entry.vcId ? { vcId: entry.vcId } : {}),
      ...(entry.validUntil ? { validUntil: entry.validUntil } : {}),
    }
  }
}
