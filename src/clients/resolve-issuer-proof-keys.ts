/**
 * resolveIssuerProofKeys — extracts the *issuer's* BBS+ and Ed25519 verification keys for a
 * client-held VC, by resolving the issuer's DID document and matching each of the VC's own
 * `proof[]` entries to a verification method by `id === proof.verificationMethod`.
 *
 * Why this exists: the OID4VP verifier (`openid4vp-verifier-be`, `VpCommonService.
 * verifyCredentials`) checks each VC's own issuer-signed proof(s) — `BbsBlsSignature2020` /
 * `BbsBlsSignatureProof2020` and `Ed25519Signature2020` — against a supplied public key, because
 * its own DID-resolution fallback is not implemented server-side (`zidResolver` is hardcoded
 * `null` there). Sending an empty/wrong key makes verification throw. These are the *issuer's*
 * keys, not the holder's — unrelated to the holder's own Ed25519 signing via Wallet BE.
 */

import type { ZidDidDocument } from './zid-resolver-client.js'

export interface IssuerProofKeys {
  bbsPublicKey: string
  ed25519PublicKey: string
}

export type DidResolver = Pick<{ resolveDid(did: string): Promise<ZidDidDocument> }, 'resolveDid'>

interface VcProof {
  type?: string
  verificationMethod?: string
}

const BBS_PROOF_TYPES = new Set(['BbsBlsSignature2020', 'BbsBlsSignatureProof2020'])
const ED25519_PROOF_TYPE = 'Ed25519Signature2020'

function asProofArray(proof: unknown): VcProof[] {
  if (proof === undefined || proof === null) return []
  return Array.isArray(proof) ? (proof as VcProof[]) : [proof as VcProof]
}

function findVerificationKey(
  doc: ZidDidDocument,
  verificationMethod: string,
  keyType: string,
  field: 'publicKeyMultibase' | 'publicKeyHex',
): string {
  const vm = doc.verificationMethod.find((v) => v.id === verificationMethod && v.type === keyType)
  const key = vm?.[field]
  if (!key) {
    throw new Error(`resolveIssuerProofKeys: no verification method found for ${verificationMethod} (type ${keyType})`)
  }
  return key
}

export async function resolveIssuerProofKeys(vc: unknown, resolver: DidResolver): Promise<IssuerProofKeys> {
  const proofs = asProofArray((vc as { proof?: unknown } | null | undefined)?.proof)
  const bbsProof = proofs.find((p) => p.type !== undefined && BBS_PROOF_TYPES.has(p.type))
  const ed25519Proof = proofs.find((p) => p.type === ED25519_PROOF_TYPE)

  if (!bbsProof && !ed25519Proof) {
    return { bbsPublicKey: '', ed25519PublicKey: '' }
  }

  const issuer = (vc as { issuer?: unknown } | null | undefined)?.issuer
  if (typeof issuer !== 'string' || !issuer) {
    throw new Error('resolveIssuerProofKeys: VC has a proof but no issuer field to resolve')
  }

  const doc = await resolver.resolveDid(issuer)

  const bbsPublicKey = bbsProof?.verificationMethod
    ? findVerificationKey(doc, bbsProof.verificationMethod, 'Bls12381G2Key2020', 'publicKeyMultibase')
    : ''
  const ed25519PublicKey = ed25519Proof?.verificationMethod
    ? findVerificationKey(doc, ed25519Proof.verificationMethod, 'Ed25519VerificationKey2020', 'publicKeyHex')
    : ''

  return { bbsPublicKey, ed25519PublicKey }
}
