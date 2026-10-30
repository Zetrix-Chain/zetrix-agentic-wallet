/**
 * The Verified AI Birthcert as the agent credential tools need it.
 *
 * The delegation credential, the main agent's policy credential and the sub-agent step are tied to the Verified AI Birthcert: the owner
 * has been proven with MyDigital ID. MBI refuses anything else, so the wallet reads the cached credential before it sends anything and
 * says what is missing instead of spending a counted request. The name every one of these credentials carries is the birthcert's
 * `agentName` (sent as `agentUsername`), and MBI compares them exactly (only the ends are trimmed).
 */

import { isVcValid, type VcCacheStore } from '../clients/vc-cache.js'

/** Where the Verified AI Birthcert's attributes sit under `credentialSubject` (the template name in camel case). */
export const VERIFIED_CONTAINER = 'verifiedAiBirthcert'

export type VerifiedBirthcertState =
  | { kind: 'ok'; vc: unknown; agentName: string }
  /** None cached, expired, not the Verified template's own shape, or the template is not known on this network. */
  | { kind: 'missing' }
  /** Held, but `ownerVerified` is not "true": MBI refuses it with OWNER_NOT_VERIFIED. */
  | { kind: 'owner_not_verified'; agentName?: string }
  /** Held and verified, but it names no agent. */
  | { kind: 'no_name' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The first object under credentialSubject: the template's own attributes (`aiPolicyCredential`, `aiDelegationCredential`, ...). */
export function subjectAttributes(vc: unknown): Record<string, unknown> {
  const subject = (vc as { credentialSubject?: unknown } | undefined)?.credentialSubject
  if (!isRecord(subject)) return {}
  const inner = Object.values(subject).find(isRecord)
  return inner ?? {}
}

/** The key that object sits under (`aiDelegationCredential`, ...), for dotted reveal paths; undefined when there is none. */
export function subjectContainerKey(vc: unknown): string | undefined {
  const subject = (vc as { credentialSubject?: unknown } | undefined)?.credentialSubject
  if (!isRecord(subject)) return undefined
  return Object.keys(subject).find((k) => isRecord(subject[k]))
}

/** Reads the wallet's own cache only: no network call, and an unreadable cache is "missing". */
export async function readVerifiedBirthcert(cache: VcCacheStore, templateId: string | undefined, now: Date): Promise<VerifiedBirthcertState> {
  if (!templateId) return { kind: 'missing' }
  let entry
  try {
    entry = await cache.get(templateId)
  } catch {
    return { kind: 'missing' }
  }
  if (!entry || !isVcValid(entry, now)) return { kind: 'missing' }
  // The named container, not whichever object comes first: a credential that does not carry the Verified template's own shape is not one.
  const subject = (entry.vc as { credentialSubject?: unknown } | undefined)?.credentialSubject
  const attributes = isRecord(subject) && isRecord(subject[VERIFIED_CONTAINER]) ? (subject[VERIFIED_CONTAINER] as Record<string, unknown>) : undefined
  if (!attributes) return { kind: 'missing' }
  const name = typeof attributes.agentName === 'string' && attributes.agentName.trim() !== '' ? attributes.agentName.trim() : undefined
  if (attributes.ownerVerified !== 'true') return { kind: 'owner_not_verified', ...(name ? { agentName: name } : {}) }
  if (!name) return { kind: 'no_name' }
  return { kind: 'ok', vc: entry.vc, agentName: name }
}

/** Why a state other than "ok" cannot be used, in words for the agent to relay. Ends with the way out. */
export function verifiedBirthcertProblem(state: Exclude<VerifiedBirthcertState, { kind: 'ok' }>, what: string): string {
  const getOne =
    'The Basic AI Birthcert does not count. A Verified one has a fee and needs the owner to verify with MyDigital ID: ask the user whether they want one, and only if they say yes ' +
    'call request_ai_birthcert_verification (then check_ai_birthcert_verification), and ask again afterwards.'
  switch (state.kind) {
    case 'missing':
      return `${what} needs a Verified AI Birthcert, and this wallet has no valid one. ${getOne}`
    case 'owner_not_verified':
      return `${what} needs a Verified AI Birthcert that shows the owner as verified (ownerVerified "true"), and the one in this wallet does not. ${getOne}`
    case 'no_name':
      return `${what} needs the agent's name from a Verified AI Birthcert, and the one in this wallet has no agentName. ${getOne}`
  }
}
