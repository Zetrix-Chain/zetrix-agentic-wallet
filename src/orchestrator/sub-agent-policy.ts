/**
 * apply_sub_agent_policy_vc: a main agent has MBI issue a policy credential to a sub-agent.
 *
 * MBI's endpoint is protected by x401 and asks for two proofs, one credential each: the main agent's Verified AI Birthcert first, then its
 * AI Delegation Credential. So one application is three calls, each with the SAME body:
 *
 *   1. no proof            -> 401 + PROOF-REQUEST (the birthcert)
 *   2. birthcert proof     -> 401 + PROOF-REQUEST (the delegation credential)
 *   3. delegation proof    -> 200 { vcId, holderDid, holderAddress }
 *
 * The credential is issued to the sub-agent's key and is NOT in the answer, so the main agent never holds it: it passes the vcId to the
 * sub-agent, which fetches it with download_policy_vc. MBI chooses every value in it (the main agent's levels, a limit it caps).
 *
 * No call is ever repeated here. A proof is single-use and valid for minutes, a challenge is bound to the body, and MBI counts
 * applications per address, so any failure ends the attempt and the caller starts over from call 1 only if the cause is gone.
 */

import type { MbiAgentApplyBody, MbiAgentApplyReply } from '../clients/mbi-client.js'
import { MbiError } from '../clients/mbi-client.js'
import { isVcValid, type VcCacheStore } from '../clients/vc-cache.js'
import { readVerifiedBirthcert, subjectAttributes, subjectContainerKey, verifiedBirthcertProblem, VERIFIED_CONTAINER } from './verified-birthcert.js'
import { expirationProblem } from './expiration-date.js'

export interface ApplySubAgentPolicyInput {
  /** The sub-agent's public key, as it gave it to the main agent. */
  subAgentPublicKey: string
  /** The sub-agent's username. */
  agentUsername: string
  purpose?: string
  additionalDetails?: string
  expirationDate?: string
  /**
   * Set only after the USER has confirmed that MBI already holds this agent's own AI Policy Credential although this wallet has no saved copy of
   * it (a copy lost from the cache). The wallet then does not stop on the missing copy and lets MBI decide, as it did before the check existed.
   * It is never sent to MBI, and only the boolean true counts. An agent must not set it on its own initiative.
   */
  ownPolicyCredentialConfirmedAtMbi?: boolean
}

export type SubAgentPolicyReason =
  | 'unavailable'
  | 'needs_birthcert'
  | 'owner_not_verified'
  | 'needs_delegation'
  | 'invalid_request'
  | 'main_policy_missing'
  | 'sub_agent_has_one'
  | 'holder_mismatch'
  | 'proof_refused'
  | 'rate_limited'
  | 'service_unavailable'
  | 'unexpected'

export type ApplySubAgentPolicyResult =
  | {
      issued: true
      vcId: string
      holderDid?: string
      holderAddress?: string
      /** What to do next, in plain words: the sub-agent fetches it, the main agent does not. */
      nextStep: string
      message: string
    }
  | {
      issued: false
      reason: SubAgentPolicyReason
      message: string
      /** True when nothing may have been issued and the whole application can be started again once the cause is fixed. */
      safeToStartAgain: boolean
    }

export interface SubAgentProofResult {
  proofResponseHeader?: string
  verified?: boolean
}

export interface ApplySubAgentPolicyDeps {
  cache: VcCacheStore
  network: string
  verifiedTemplateId?: string
  /** Where the AI Delegation Credential is cached; undefined where it is not deployed. */
  delegationTemplateId?: string
  /** Where the main agent's own AI Policy Credential is cached; its name is checked against the birthcert's before anything is sent. */
  policyTemplateId?: string
  apply: (bodyText: string, proofResponse?: string) => Promise<MbiAgentApplyReply>
  /** Answers one x401 challenge with one credential (prove_identity). Throws when the proof cannot be made. */
  /** `revealAttribute` is the fixed list of dotted paths this step may disclose; the wallet has already refused a challenge asking for more. */
  prove: (proofRequest: string, vc: unknown, revealAttribute: string[]) => Promise<SubAgentProofResult>
  now?: () => Date
}

/**
 * The only claims each proof may disclose (what MBI asks for, AgentX401Requirements). A challenge that asks for more, for nothing in particular
 * (which would reveal the whole credential) or in a form this wallet cannot read is not answered: the Verified AI Birthcert holds the owner's
 * name, ID number and date of birth, and no user is in the loop here.
 */
const BIRTHCERT_CLAIMS = ['agentName', 'ownerVerified']
const DELEGATION_CLAIMS = ['agentUsername', 'allowDelegateTransfer', 'maxDelegationDepth']

/** The claim names a PROOF-REQUEST header asks for (the last segment of each path), or undefined when it cannot be read. */
export function challengeClaims(proofRequest: string): string[] | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(proofRequest, 'base64url').toString('utf8')) as {
      credential_requirements?: { query?: { credentials?: { claims?: { path?: unknown }[] }[] } }
    }
    const credentials = decoded.credential_requirements?.query?.credentials
    if (!Array.isArray(credentials)) return undefined
    const names: string[] = []
    for (const credential of credentials) {
      for (const claim of credential.claims ?? []) {
        const path = claim.path
        if (!Array.isArray(path) || path.length === 0 || !path.every((s) => typeof s === 'string')) return undefined
        names.push(path[path.length - 1] as string)
      }
    }
    return [...new Set(names)]
  } catch {
    return undefined
  }
}

const refuse = (reason: SubAgentPolicyReason, message: string, safeToStartAgain: boolean): ApplySubAgentPolicyResult => ({
  issued: false,
  reason,
  message,
  safeToStartAgain,
})

/** Words for each answer MBI gives a call that did not move the application forward. */
function refusalFor(reply: MbiAgentApplyReply, step: 'start' | 'birthcert' | 'delegation' | 'issue'): ApplySubAgentPolicyResult {
  const { status, code } = reply
  const startAgain = ' Nothing was issued to the sub-agent; the application can be started again from the beginning.'
  const issueUnknown = step === 'issue'
  if (code === 'HOLDER_MISMATCH') {
    return refuse(
      'holder_mismatch',
      'MBI says the Verified AI Birthcert and the AI Delegation Credential name different agents (the same agent, and the birthcert\'s agentName as the delegation\'s agentUsername, are required).' +
        ' Check that both were issued to this wallet under the same name.' + startAgain,
      false,
    )
  }
  if (code === 'OWNER_NOT_VERIFIED') {
    return refuse('owner_not_verified', 'MBI says the Verified AI Birthcert does not show the owner as verified (ownerVerified must be "true"). Nothing was issued; the owner has to complete the verification first.', false)
  }
  if (code === 'WRONG_CREDENTIAL') {
    return refuse('proof_refused', 'MBI asked for the Verified AI Birthcert and was given another credential (the Basic AI Birthcert does not count). Nothing was issued. Do not retry; tell the user.', false)
  }
  if (reply.status === 422 && reply.mbiStatus === 6004) {
    return refuse('needs_birthcert', 'MBI has no valid Verified AI Birthcert on record for this main agent, so it refused the application. The Basic AI Birthcert does not count. Nothing was issued.', false)
  }
  if (reply.status === 422 && reply.mbiStatus === 6005) {
    return refuse('holder_mismatch', 'MBI says this main agent\'s AI Policy Credential is not under the agentName of its Verified AI Birthcert in MBI\'s records. The old policy credential has to be revoked and issued again by whoever runs MBI. Nothing was issued; tell the user and do not retry.', false)
  }
  if (code === 'HOLDER_NOT_DISCLOSED') {
    return refuse('proof_refused', 'MBI says a proof did not reveal who the credential was issued to, which an older wallet does not do.' + startAgain, false)
  }
  if (status === 403 && code) {
    return refuse(
      'proof_refused',
      `MBI refused ${step === 'issue' ? 'the delegation proof' : 'the proof'} (${code}). A proof is good once and for a few minutes, so the whole application has to start again from the beginning.` + startAgain,
      code === 'REPLAY_DETECTED' || code === 'STALE_TIMESTAMP' || code === 'CHALLENGE_NOT_ISSUED' || code === 'CHALLENGE_NOT_COMPLETED' || code === 'PROOF_NOT_VERIFIED',
    )
  }
  if (status === 403) {
    return refuse('proof_refused', `MBI refused the application (HTTP 403): the delegation does not allow it, or a proof was already used.` + startAgain, false)
  }
  if (status === 404) {
    return refuse(
      'main_policy_missing',
      'MBI has no valid AI Policy Credential for this main agent (or the service is off). Get one first with apply_policy_vc, issued by the same key as the birthcert, then ask again.' + startAgain,
      false,
    )
  }
  if (status === 409) {
    return refuse(
      'sub_agent_has_one',
      'MBI says this sub-agent already holds a policy credential, an application for it is already running, or the main agent\'s own policy credential expires too soon.' +
        (issueUnknown ? ' If the sub-agent already holds one, ask the sub-agent for its vcId rather than applying again.' : '') + ' Do not retry now.',
      false,
    )
  }
  if (status === 429) {
    return refuse('rate_limited', 'MBI is limiting how many applications and credentials one address or one source can make per hour. Wait and try again later; do not retry now.', false)
  }
  if (status === 400) {
    return refuse('invalid_request', `MBI refused the request as invalid${reply.message ? `: ${reply.message}` : ''}. Fix the input and ask again.` + startAgain, true)
  }
  if (status === 502 || status === 503) {
    return refuse('service_unavailable', `MBI could not reach its verifier or is not set up for this service (HTTP ${status}).` + startAgain + ' Try again later.', true)
  }
  return refuse('unexpected', `MBI answered HTTP ${status}${reply.message ? ` (${reply.message})` : ''}, which this step does not know.` + (issueUnknown ? ' A credential may or may not have been issued; do not retry.' : startAgain), !issueUnknown)
}

export async function applySubAgentPolicyVc(input: ApplySubAgentPolicyInput, deps: ApplySubAgentPolicyDeps): Promise<ApplySubAgentPolicyResult> {
  const now = deps.now?.() ?? new Date()

  const subAgentPublicKey = input.subAgentPublicKey?.trim()
  const agentUsername = input.agentUsername?.trim()
  if (!subAgentPublicKey) return refuse('invalid_request', 'Pass subAgentPublicKey: the public key the sub-agent sent. Nothing was sent.', true)
  if (!agentUsername) return refuse('invalid_request', 'Pass agentUsername: the sub-agent\'s username. Nothing was sent.', true)

  const badDate = expirationProblem(input.expirationDate, now)
  if (badDate) return refuse('invalid_request', `${badDate} Nothing was sent.`, true)

  if (!deps.delegationTemplateId) {
    return refuse('unavailable', 'The AI Delegation Credential is not deployed on this network, so a sub-agent policy credential cannot be requested here. Nothing was sent.', false)
  }

  // Both credentials are presented, so both must be held. Checked before anything is sent: a missing one would only waste an application.
  const verified = await readVerifiedBirthcert(deps.cache, deps.verifiedTemplateId, now)
  if (verified.kind !== 'ok') {
    return refuse(
      verified.kind === 'owner_not_verified' ? 'owner_not_verified' : 'needs_birthcert',
      `${verifiedBirthcertProblem(verified, 'The sub-agent step')} Nothing was sent.`,
      true,
    )
  }
  const birthcert = verified.vc
  const delegationEntry = await deps.cache.get(deps.delegationTemplateId)
  const delegation = delegationEntry && isVcValid(delegationEntry, now) ? delegationEntry.vc : undefined
  if (delegation === undefined) {
    return refuse('needs_delegation', 'The sub-agent step asks for this agent\'s AI Delegation Credential, and this wallet has none. Get it with apply_delegation_vc first, then ask again. Nothing was sent.', true)
  }
  // MBI builds the sub-agent's credential from this main agent's OWN policy credential (its levels and its cap), and refuses without one only
  // at the end of the chain, after both proofs are spent. So the wallet checks its own copy first: none, or an expired one, ends it here.
  // (A copy lost from the cache while MBI still holds the credential cannot be solved from here either way: apply_policy_vc answers that.)
  // MBI also compares the name with that credential; the wallet can only check its copy.
  if (deps.policyTemplateId) {
    const policyEntry = await deps.cache.get(deps.policyTemplateId)
    const held = policyEntry !== null && policyEntry !== undefined && isVcValid(policyEntry, now)
    // Only the boolean true counts, and it was set on the user's confirmation that MBI holds the credential (see the input's comment).
    if (!held && input.ownPolicyCredentialConfirmedAtMbi !== true) {
      return refuse(
        'main_policy_missing',
        `This agent has no AI Policy Credential of its own ${policyEntry ? '(the one saved in this wallet has expired)' : 'saved in this wallet'}. MBI builds the sub-agent's credential from it (the policy levels and the transfer limit) and refuses without one, after the proofs are spent. ` +
          'Get it with apply_policy_vc first, then ask again. Nothing was sent. If apply_policy_vc says MBI already holds one that this wallet has no copy of, ask the user to confirm that, and only then ask again with ownPolicyCredentialConfirmedAtMbi: true (MBI then decides).',
        true,
      )
    }
    const policyName = held ? subjectAttributes(policyEntry.vc).agentUsername : undefined
    if (typeof policyName === 'string' && policyName.trim() !== verified.agentName) {
      return refuse(
        'holder_mismatch',
        `The AI Policy Credential in this wallet is for "${policyName.trim()}", but the Verified AI Birthcert names the agent "${verified.agentName}", so MBI would refuse the application. ` +
          'The old policy credential has to be revoked and issued again by whoever runs MBI; this wallet cannot do that. Tell the user. Nothing was sent.',
        false,
      )
    }
  }
  // MBI compares the name proven by the birthcert with the delegation's: a credential made under the old Basic rule has another name.
  const delegationName = subjectAttributes(delegation).agentUsername
  if (typeof delegationName === 'string' && delegationName.trim() !== verified.agentName) {
    return refuse(
      'holder_mismatch',
      `The AI Delegation Credential in this wallet is for "${delegationName.trim()}", but the Verified AI Birthcert names the agent "${verified.agentName}", so MBI would refuse the application. ` +
        'The old credential has to be revoked and issued again by whoever runs MBI; this wallet cannot do that. Tell the user. Nothing was sent.',
      false,
    )
  }

  // One body text, sent three times: MBI binds each challenge to it, so it must not change by a byte.
  const body: MbiAgentApplyBody = {
    subAgentPublicKey,
    agentUsername,
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.additionalDetails ? { additionalDetails: input.additionalDetails } : {}),
    ...(input.expirationDate?.trim() ? { expirationDate: input.expirationDate.trim() } : {}),
  }
  const bodyText = JSON.stringify(body)

  const call = async (step: 'start' | 'birthcert' | 'delegation' | 'issue', proof?: string): Promise<MbiAgentApplyReply | ApplySubAgentPolicyResult> => {
    try {
      return await deps.apply(bodyText, proof)
    } catch (err) {
      if (!(err instanceof MbiError)) throw err
      // The answer to the last call is the one that matters: if it was lost, a credential may have been issued.
      return step === 'issue'
        ? refuse('unexpected', `The answer from MBI to the last step was lost (${err.message}). A credential may have been issued to the sub-agent; do not apply again. Ask the sub-agent whether it was given a vcId, and tell the user.`, false)
        : refuse('service_unavailable', `MBI could not be reached (${err.message}).` + ' Nothing was issued; try again later.', true)
    }
  }
  const isRefusal = (x: MbiAgentApplyReply | ApplySubAgentPolicyResult): x is ApplySubAgentPolicyResult => 'issued' in x

  const prove = async (
    proofRequest: string,
    vc: unknown,
    what: string,
    allowed: string[],
    container: string,
  ): Promise<string | ApplySubAgentPolicyResult> => {
    const asked = challengeClaims(proofRequest)
    if (asked === undefined || asked.length === 0 || asked.some((claim) => !allowed.includes(claim))) {
      const extra = asked?.filter((claim) => !allowed.includes(claim)) ?? []
      const why =
        asked === undefined
          ? 'in a form this wallet cannot read'
          : asked.length === 0
            ? 'for no particular claims, which would reveal the whole credential'
            : `for more than it needs (${extra.join(', ')})`
      return refuse(
        'proof_refused',
        `MBI's ${what} challenge asks ${why}. This wallet only reveals ${allowed.join(', ')} for this step, so it did not answer: nothing was revealed and nothing was issued. Tell the user and do not retry.`,
        false,
      )
    }
    try {
      const proof = await deps.prove(proofRequest, vc, asked.map((claim) => `${container}.${claim}`))
      if (!proof.proofResponseHeader || proof.verified === false) {
        return refuse('proof_refused', `The ${what} proof was made but the verifier did not accept it. Nothing was issued; the application can be started again.`, true)
      }
      return proof.proofResponseHeader
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return refuse('proof_refused', `The wallet could not make the ${what} proof: ${reason}. Nothing was issued; a new application starts with a fresh challenge.`, true)
    }
  }

  // Call 1: ask, and be told to present the birthcert.
  const first = await call('start')
  if (isRefusal(first)) return first
  if (first.status !== 401 || !first.proofRequest) return refusalFor(first, 'start')

  const birthcertProof = await prove(first.proofRequest, birthcert, 'birthcert', BIRTHCERT_CLAIMS, VERIFIED_CONTAINER)
  if (typeof birthcertProof !== 'string') return birthcertProof

  // Call 2: present it, and be told to present the delegation credential.
  const second = await call('birthcert', birthcertProof)
  if (isRefusal(second)) return second
  if (second.status !== 401 || !second.proofRequest) return refusalFor(second, 'birthcert')

  const delegationProof = await prove(second.proofRequest, delegation, 'delegation', DELEGATION_CLAIMS, subjectContainerKey(delegation) ?? 'aiDelegationCredential')
  if (typeof delegationProof !== 'string') return delegationProof

  // Call 3: present it; MBI checks both name the same agent and issues.
  const third = await call('issue', delegationProof)
  if (isRefusal(third)) return third
  if (third.status !== 200) return refusalFor(third, 'issue')
  const { vcId, holderDid, holderAddress } = third.data ?? {}
  if (!vcId) {
    return refuse('unexpected', 'MBI answered the last step with success but no vcId. A credential may have been issued to the sub-agent; do not apply again, and tell the user.', false)
  }
  return {
    issued: true,
    vcId,
    ...(holderDid ? { holderDid } : {}),
    ...(holderAddress ? { holderAddress } : {}),
    nextStep:
      'Give the vcId to the sub-agent. It fetches the credential itself with download_policy_vc, once, from its own wallet. Do not try to fetch it from this wallet: it was issued to the sub-agent, and the main agent never holds it.',
    message: `MBI issued a policy credential to the sub-agent${holderAddress ? ` (${holderAddress})` : ''}. The values in it were chosen by MBI from this agent's own policy credential.`,
  }
}
