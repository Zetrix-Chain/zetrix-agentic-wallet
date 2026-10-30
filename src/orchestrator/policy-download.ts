/**
 * download_policy_vc: the sub-agent fetches the policy credential MBI issued to it, by the vcId its main agent passed on.
 *
 * Three facts shape this, all from MBI:
 *  - a credential can be downloaded ONCE: MBI marks it DOWNLOADED in the same request, before the answer reaches the caller, so a lost
 *    answer is a lost credential. Nothing here is retried, and an unreadable outcome is reported as unknown, never as a failure to retry;
 *  - with a vcId only that credential is returned and marked, but the address is the signing key's own: the download is made for THIS
 *    wallet's address, with no address input, so the main agent cannot ask for the sub-agent's credential and the sub-agent cannot ask for
 *    anyone else's;
 *  - the wallet cache keeps one credential per template. A wallet that already holds a valid policy credential (a main agent's own, say)
 *    would have it replaced, so the download is refused BEFORE it is made rather than burning the credential and then having nowhere safe to put it.
 */

import { MbiError, type MbiRequestSigner, type MbiVcEntry } from '../clients/mbi-client.js'
import { isVcValid, type CachedVc, type VcCacheStore } from '../clients/vc-cache.js'

export interface DownloadPolicyVcInput {
  vcId: string
}

export type DownloadPolicyVcReason =
  | 'unavailable'
  | 'invalid_request'
  | 'already_held'
  | 'not_available'
  | 'refused'
  | 'rate_limited'
  | 'outcome_unknown'
  | 'unexpected'

export type DownloadPolicyVcResult =
  | {
      downloaded: true
      vcId: string
      templateId: string
      validUntil?: string
      attributes: Record<string, unknown>
      /** False only when the credential could not be written to the local cache; it is then in `verifiableCredential`. */
      saved: boolean
      verifiableCredential?: unknown
      message: string
    }
  | { downloaded: false; reason: DownloadPolicyVcReason; message: string; vcId?: string }

export interface DownloadPolicyVcDeps {
  cache: VcCacheStore
  /** Where the AI Policy Credential is cached; undefined where it is not deployed. */
  policyTemplateId?: string
  /** This wallet's own Zetrix address: the only address the download is ever made for. */
  address: string
  /** This wallet's holder DID, which the credential must have been issued to. */
  holderDid: string
  download: (body: { address: string; vcId: string }, sign: MbiRequestSigner) => Promise<MbiVcEntry[]>
  sign: MbiRequestSigner
  now?: () => Date
}

const VC_ID = /^did:zid:[0-9a-f]{64}$/

const no = (reason: DownloadPolicyVcReason, message: string, vcId?: string): DownloadPolicyVcResult => ({
  downloaded: false,
  reason,
  message,
  ...(vcId ? { vcId } : {}),
})

function subjectAttributes(vc: unknown): Record<string, unknown> {
  const subject = (vc as { credentialSubject?: Record<string, unknown> } | undefined)?.credentialSubject
  if (!subject || typeof subject !== 'object') return {}
  const inner = Object.values(subject).find((v) => v !== null && typeof v === 'object' && !Array.isArray(v))
  return (inner as Record<string, unknown> | undefined) ?? {}
}

export async function downloadPolicyVc(input: DownloadPolicyVcInput, deps: DownloadPolicyVcDeps): Promise<DownloadPolicyVcResult> {
  const now = deps.now?.() ?? new Date()
  const vcId = input.vcId?.trim()
  if (!vcId || !VC_ID.test(vcId)) {
    return no('invalid_request', 'Pass vcId exactly as the main agent gave it (it starts with "did:zid:"). Nothing was sent: a credential can be downloaded only once, so a wrong id is not tried.')
  }
  if (!deps.policyTemplateId) {
    return no('unavailable', 'The AI Policy Credential is not deployed on this network, so there is nothing to download here. Nothing was sent.', vcId)
  }

  const held = await deps.cache.get(deps.policyTemplateId)
  if (held && isVcValid(held, now)) {
    return no(
      'already_held',
      'This wallet already holds a valid AI Policy Credential, and it keeps one per template, so downloading another would replace it. Nothing was sent: a download can be made only once, and it would be lost. ' +
        'A sub-agent that is also a main agent needs a separate wallet for the sub-agent credential.',
      held.vcId ?? vcId,
    )
  }

  let entries: MbiVcEntry[]
  try {
    entries = await deps.download({ address: deps.address, vcId }, deps.sign)
  } catch (err) {
    if (!(err instanceof MbiError)) throw err
    const status = err.httpStatus
    if (status === 404) {
      return no(
        'not_available',
        'MBI has no such credential to give this wallet: the vcId is wrong, it was issued to a different sub-agent, or it was already downloaded (it can be fetched once). Do not retry; ask the main agent and tell the user.',
        vcId,
      )
    }
    if (status === 429) return no('rate_limited', 'MBI is limiting requests from this address. Wait and try again later; do not retry now.', vcId)
    if (status === 401 || status === 403) {
      return no('refused', `MBI did not accept the signed request (HTTP ${status}): this wallet's address is not the one the credential was issued to, or its clock is wrong. Nothing was handed over.`, vcId)
    }
    if (status === undefined || status >= 500 || (status >= 200 && status < 300)) {
      return no(
        'outcome_unknown',
        `The answer from MBI was lost, could not be read, or MBI failed while handling the download (${err.message}). The credential may already be marked as downloaded, and it cannot be downloaded again. Do not call this again for the same vcId. Tell the user and ask whoever runs MBI.`,
        vcId,
      )
    }
    throw err
  }

  const entry = entries.find((e) => (e.vc as { id?: unknown } | undefined)?.id === vcId)
  if (!entry) {
    return no(
      'unexpected',
      'MBI answered, but the credential with that vcId was not in the answer. It may already be marked as downloaded. Do not call this again for the same vcId; tell the user.',
      vcId,
    )
  }
  const vc = entry.vc as { type?: unknown; validUntil?: unknown; credentialSubject?: { id?: unknown } }
  const types = Array.isArray(vc.type) ? vc.type : []
  if (!types.includes('AI Policy Credential') || vc.credentialSubject?.id !== deps.holderDid) {
    return no(
      'unexpected',
      'MBI returned a credential that is not an AI Policy Credential for this wallet, so it was not saved. Do not call this again for the same vcId; tell the user.',
      vcId,
    )
  }

  const validUntil = typeof vc.validUntil === 'string' ? vc.validUntil : undefined
  const record: CachedVc = { templateId: deps.policyTemplateId, vc, vcId, issuedAt: now.toISOString(), ...(validUntil ? { validUntil } : {}) }
  let saved = true
  try {
    await deps.cache.set(deps.policyTemplateId, record)
  } catch {
    saved = false
  }
  return {
    downloaded: true,
    vcId,
    templateId: deps.policyTemplateId,
    ...(validUntil ? { validUntil } : {}),
    attributes: subjectAttributes(vc),
    saved,
    ...(saved ? {} : { verifiableCredential: vc }),
    message: saved
      ? 'The policy credential was downloaded and saved in this wallet. It can be downloaded only once, and it has been. The values in it were chosen by MBI.'
      : 'The policy credential was downloaded but could NOT be saved in this wallet; it is in "verifiableCredential" in this result. Keep it: it cannot be downloaded again.',
  }
}
