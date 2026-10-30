/**
 * apply_delegation_vc and apply_policy_vc: a main agent asks MBI for the credentials that let it hand a policy to a sub-agent.
 *
 *  - the AI Delegation Credential is the permission to delegate (it carries no limits);
 *  - the AI Policy Credential carries the agent's policy levels and transfer limit.
 *
 * MBI issues both directly, with no payment and no presentation, and chooses every authority value itself, so the wallet sends only the
 * labels the agent may set. The credential is in the response; it is saved here at once, because MBI marks a credential DOWNLOADED once it
 * is downloaded and a second issue for the same holder is refused. Nothing in this file fetches an issued credential again.
 *
 * Both are tied to the Verified AI Birthcert: MBI refuses a signer that does not hold a valid one with the owner verified, and
 * the agentUsername sent must be that birthcert's agentName. So both tools read the cached Verified birthcert first, take the name from it,
 * and refuse without one, before a counted request is spent. This is a courtesy check in the wallet; MBI is the gate.
 */

import { MbiError, type MbiAgentVcBody, type MbiAgentVcIssued, type MbiRequestSigner } from '../clients/mbi-client.js'
import { isVcValid, type CachedVc, type VcCacheStore } from '../clients/vc-cache.js'
import { readVerifiedBirthcert, verifiedBirthcertProblem } from './verified-birthcert.js'
import { expirationProblem } from './expiration-date.js'

export type AgentVcKind = 'delegation' | 'policy'

export interface ApplyAgentVcInput {
  /** Defaults to the Verified AI Birthcert's agentName. When both are given they must be the same. */
  agentUsername?: string
  purpose?: string
  additionalDetails?: string
  /** YYYY-MM-DD, in the future, at most 365 days out. Omit to take MBI's default (365 days). */
  expirationDate?: string
}

export interface ApplyAgentVcDeps {
  cache: VcCacheStore
  network: string
  /** The Verified AI Birthcert's templateId: the credential the name and the owner check come from. */
  verifiedTemplateId?: string
  /** The two template ids; one is undefined where the template is not deployed. */
  templateIds: { delegation?: string; policy?: string }
  issue: (kind: AgentVcKind, body: MbiAgentVcBody, sign: MbiRequestSigner) => Promise<MbiAgentVcIssued>
  sign: MbiRequestSigner
  now?: () => Date
}

export type ApplyAgentVcRefusal =
  | 'unavailable'
  | 'needs_birthcert'
  | 'owner_not_verified'
  | 'username_mismatch'
  | 'already_held'
  | 'already_held_at_issuer'
  | 'rate_limited'
  | 'invalid_request'
  | 'refused'

export type ApplyAgentVcResult =
  | {
      issued: true
      kind: AgentVcKind
      credential: string
      vcId: string
      templateId: string
      validUntil?: string
      attributes: Record<string, unknown>
      /** False only when the credential could not be written to the local cache; it is then in `verifiableCredential`. */
      saved: boolean
      verifiableCredential?: unknown
      message: string
    }
  | { issued: false; kind: AgentVcKind; credential: string; reason: ApplyAgentVcRefusal; message: string; vcId?: string; validUntil?: string }

const NAMES: Record<AgentVcKind, string> = { delegation: 'AI Delegation Credential', policy: 'AI Policy Credential' }

/** The first object under credentialSubject: the template's own attributes (`aiBirthcert`, `aiPolicyCredential`, ...). */
function subjectAttributes(vc: unknown): Record<string, unknown> {
  const subject = (vc as { credentialSubject?: Record<string, unknown> } | undefined)?.credentialSubject
  if (!subject || typeof subject !== 'object') return {}
  const inner = Object.values(subject).find((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
  return (inner as Record<string, unknown> | undefined) ?? {}
}

function agentUsernameOf(vc: unknown): string | undefined {
  const name = subjectAttributes(vc).agentUsername
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

const VC_ID = /did:zid:[0-9a-f]{64}/

export async function applyAgentVc(kind: AgentVcKind, input: ApplyAgentVcInput, deps: ApplyAgentVcDeps): Promise<ApplyAgentVcResult> {
  const credential = NAMES[kind]
  const refuse = (reason: ApplyAgentVcRefusal, message: string, extra: { vcId?: string; validUntil?: string } = {}): ApplyAgentVcResult => ({
    issued: false, kind, credential, reason, message, ...extra,
  })
  const now = deps.now?.() ?? new Date()

  const badDate = expirationProblem(input.expirationDate, now)
  if (badDate) return refuse('invalid_request', `${badDate} Nothing was sent.`)

  const templateId = deps.templateIds[kind]
  if (!templateId) {
    return refuse(
      'unavailable',
      `The ${credential} is not deployed on ${deps.network}, so it cannot be requested here. Nothing was sent. ` +
        `(Set ${kind === 'delegation' ? 'AI_DELEGATION_TEMPLATE_ID' : 'AI_POLICY_TEMPLATE_ID'} only if the template is deployed and you know its id.)`,
    )
  }

  const verified = await readVerifiedBirthcert(deps.cache, deps.verifiedTemplateId, now)

  // One of each per agent: MBI refuses a second, so say so before asking.
  const held = await deps.cache.get(templateId)
  if (held && isVcValid(held, now)) {
    const heldName = agentUsernameOf(held.vc)
    // A credential made under the old Basic rule carries another name. MBI now requires the birthcert's agentName, and the sub-agent step
    // compares them, so it cannot be used: the wallet cannot replace it, only MBI can (revoke, then issue again).
    if (verified.kind === 'ok' && heldName !== undefined && heldName !== verified.agentName) {
      return refuse(
        'username_mismatch',
        `This wallet holds a ${credential} issued under the name "${heldName}", but its Verified AI Birthcert names the agent "${verified.agentName}". MBI now requires the same name, and giving a sub-agent a policy compares them. ` +
          'The old credential has to be revoked and issued again by whoever runs MBI; this wallet cannot do that. Tell the user and do not retry. Nothing was sent.',
        { ...(held.vcId ? { vcId: held.vcId } : {}), ...(held.validUntil ? { validUntil: held.validUntil } : {}) },
      )
    }
    return refuse('already_held', `This wallet already holds a valid ${credential}, so it was not requested again. Nothing was sent.`, {
      ...(held.vcId ? { vcId: held.vcId } : {}),
      ...(held.validUntil ? { validUntil: held.validUntil } : {}),
    })
  }

  if (verified.kind !== 'ok') {
    return refuse(verified.kind === 'owner_not_verified' ? 'owner_not_verified' : 'needs_birthcert', `${verifiedBirthcertProblem(verified, `The ${credential}`)} Nothing was sent.`)
  }

  const requested = input.agentUsername?.trim()
  if (requested && requested !== verified.agentName) {
    return refuse(
      'username_mismatch',
      `The Verified AI Birthcert here names the agent "${verified.agentName}", but "${requested}" was asked for. MBI requires the credential to carry the birthcert's name, and giving a sub-agent a policy later compares them. ` +
        "Leave agentUsername out to use the birthcert's. Nothing was sent.",
    )
  }
  const agentUsername = verified.agentName

  const body: MbiAgentVcBody = {
    agentUsername,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.additionalDetails ? { additionalDetails: input.additionalDetails } : {}),
    ...(input.expirationDate?.trim() ? { expirationDate: input.expirationDate.trim() } : {}),
  }

  let issued: MbiAgentVcIssued
  try {
    issued = await deps.issue(kind, body, deps.sign)
  } catch (err) {
    if (!(err instanceof MbiError)) throw err
    const status = err.httpStatus
    if (status === 409) {
      const vcId = VC_ID.exec(err.message)?.[0]
      return refuse(
        'already_held_at_issuer',
        `MBI says this account already holds a ${credential}${vcId ? ` (${vcId})` : ''}, but this wallet has no saved copy of it. It cannot simply be asked for again. ` +
          'If it was issued by an earlier attempt and never saved, it may have to be restored by whoever runs MBI. Tell the user and do not retry.',
        vcId ? { vcId } : {},
      )
    }
    if (status === 429) return refuse('rate_limited', `MBI is limiting how many of these one address can request per hour. Wait and try again later; do not retry now.`)
    if (status === 404) {
      return refuse('unavailable', `MBI does not offer the ${credential}: the template is not available there, or the MBI at MBI_BASE_URL does not have the agent credential service yet. Nothing was issued.`)
    }
    if (status === 422) {
      // 6005: the name is not the one in the Verified birthcert MBI holds; 6004 (and any other 422): no valid Verified birthcert on record.
      if (err.mbiStatus === 6005) {
        return refuse('username_mismatch', `MBI says the agentUsername is not the agentName in this account's Verified AI Birthcert, so it refused the ${credential}. Use the birthcert's own name (leave agentUsername out). Nothing was issued.`)
      }
      return refuse('needs_birthcert', `MBI has no valid Verified AI Birthcert on record for this account (one with the owner verified), so it refused the ${credential}. The Basic AI Birthcert does not count. Nothing was issued.`)
    }
    if (status === 400) {
      const said = /HTTP 400:\s*(.*?)(?: \| full body:.*)?$/s.exec(err.message)?.[1]?.trim()
      const shown = said && said.length > 300 ? `${said.slice(0, 300)}…` : said
      return refuse('invalid_request', `MBI refused the request as invalid${shown ? `: ${shown}` : ''}. Nothing was issued. Fix the input and ask again.`)
    }
    if (status === 401) return refuse('refused', `MBI did not accept the wallet's signed request (HTTP 401). Nothing was issued. Check that the wallet's clock is right and MBI_BASE_URL points at an MBI that has the agent credential service.`)
    if (status === 403 && /HTTP 403:\s*$/.test(err.message)) {
      return refuse(
        'refused',
        `MBI refused the request with an empty answer (HTTP 403): the signed request was not accepted (the wallet's clock, or an MBI without the agent credential service). Nothing was issued.`,
      )
    }
    throw err
  }

  const vc = issued.verifiableCredential
  const validUntil = (vc as { validUntil?: unknown } | undefined)?.validUntil
  const entry: CachedVc = {
    templateId,
    vc,
    vcId: issued.vcId,
    issuedAt: now.toISOString(),
    ...(typeof validUntil === 'string' ? { validUntil } : {}),
  }
  let saved = true
  try {
    await deps.cache.set(templateId, entry)
  } catch {
    saved = false
  }

  return {
    issued: true,
    kind,
    credential,
    vcId: issued.vcId,
    templateId,
    ...(typeof validUntil === 'string' ? { validUntil } : {}),
    attributes: subjectAttributes(vc),
    saved,
    // Only when it could not be saved: the one copy there is must not be lost.
    ...(saved ? {} : { verifiableCredential: vc }),
    message: saved
      ? `The ${credential} was issued by MBI and saved in the wallet. The values in it were chosen by MBI, not by the agent.`
      : `The ${credential} was issued by MBI but could NOT be saved in the wallet; it is in "verifiableCredential" in this result. Keep it: MBI will not issue another.`,
  }
}
