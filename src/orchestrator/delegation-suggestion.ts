/**
 * A suggestion, never an action: an agent that has a Verified AI Birthcert but no AI Delegation Credential can be offered one.
 *
 * The delegation credential is what lets a main agent give a sub-agent a policy (apply_sub_agent_policy_vc asks for it and the
 * birthcert together), so the moment to mention it is when the Verified birthcert has just been issued (check_ai_birthcert_verification)
 * and in wallet_status. The result carries `suggestion` with a question to put to the user; nothing is requested, signed or paid until the
 * user says yes and the agent calls apply_delegation_vc itself.
 *
 * Only a valid Verified AI Birthcert with the owner verified counts: the Basic one is refused by MBI for these credentials. Nothing
 * here calls the network: it reads what the wallet already holds, so it is free and cannot fail a result (a cache that cannot be read
 * is "nothing to suggest").
 */

import { isVcValid, type VcCacheStore } from '../clients/vc-cache.js'
import { readVerifiedBirthcert } from './verified-birthcert.js'

export interface DelegationSuggestion {
  tool: 'apply_delegation_vc'
  /** Why it is being raised, for the agent. */
  reason: string
  /** What to do with it: the question for the user, and the rule that nothing happens without their yes. */
  askUser: string
}

export interface DelegationSuggestionDeps {
  cache: VcCacheStore
  /** The Verified AI Birthcert's templateId on this network; without it there is nothing to suggest. */
  verifiedTemplateId?: string
  /** Where the AI Delegation Credential is cached; undefined where it is not deployed, and then there is nothing to suggest. */
  delegationTemplateId?: string
  now?: () => Date
}

export async function suggestDelegationVc(deps: DelegationSuggestionDeps): Promise<DelegationSuggestion | undefined> {
  if (!deps.delegationTemplateId || !deps.verifiedTemplateId) return undefined
  const now = deps.now?.() ?? new Date()
  try {
    const verified = await readVerifiedBirthcert(deps.cache, deps.verifiedTemplateId, now)
    if (verified.kind !== 'ok') return undefined
    const delegation = await deps.cache.get(deps.delegationTemplateId)
    if (delegation && isVcValid(delegation, now)) return undefined
  } catch {
    return undefined
  }
  return {
    tool: 'apply_delegation_vc',
    reason: 'This wallet holds a Verified AI Birthcert but no AI Delegation Credential, which is what lets this agent give a sub-agent a policy.',
    askUser:
      'Ask the user whether this agent will give sub-agents a policy. Only if they say yes, call apply_delegation_vc (it is free). ' +
      'Do not call it on your own, and do not raise it again in this conversation if they say no.',
  }
}
