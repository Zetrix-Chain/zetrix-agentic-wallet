/**
 * proveIdentity — x401 orchestrator.
 *
 * Thin wrapper over the x401 client: hand it a PROOF-REQUEST header and the holder
 * DID, get back the PROOF-RESPONSE header the agent replays to the API RS. All the
 * work (fetch DCQL → build VP → holder-binding sign → submit → package) lives in
 * X401Wallet; VP derivation + signing are the injected VcProofProvider/HolderSigner.
 */

import type { X401Wallet } from 'x401-zetrix-client'

export interface ProveIdentityResult {
  proofResponseHeader: string
  verified: boolean
  presentationId: string
}

export async function proveIdentity(
  wallet: X401Wallet,
  proofRequestHeader: string,
  holderDid: string,
): Promise<ProveIdentityResult> {
  const pr = await wallet.respondToChallenge(proofRequestHeader, holderDid)
  return { proofResponseHeader: pr.headerValue, verified: pr.verified, presentationId: pr.presentationId }
}
