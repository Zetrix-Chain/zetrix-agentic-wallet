import { describe, it, expect, vi } from 'vitest'
import { resolveIssuerProofKeys } from '../clients/resolve-issuer-proof-keys'

const ISSUER = 'did:zid:issuer1'

function makeVc(proof: unknown) {
  return {
    id: 'did:zid:vc-1',
    issuer: ISSUER,
    proof,
  }
}

function makeResolver(didDocument: unknown) {
  return { resolveDid: vi.fn().mockResolvedValue(didDocument) }
}

describe('resolveIssuerProofKeys', () => {
  it('resolves both the BBS+ (multibase) and Ed25519 (hex) issuer keys, matched by proof.verificationMethod', async () => {
    const didDocument = {
      id: ISSUER,
      verificationMethod: [
        { id: `${ISSUER}#delegateKey-6`, type: 'Bls12381G2Key2020', publicKeyMultibase: 'zBBSMULTIBASE' },
        { id: `${ISSUER}#controllerKey`, type: 'Ed25519VerificationKey2020', publicKeyHex: 'ed25519hexkey' },
      ],
    }
    const resolver = makeResolver(didDocument)
    const vc = makeVc([
      { type: 'BbsBlsSignature2020', verificationMethod: `${ISSUER}#delegateKey-6` },
      { type: 'Ed25519Signature2020', verificationMethod: `${ISSUER}#controllerKey` },
    ])

    const out = await resolveIssuerProofKeys(vc, resolver)

    expect(resolver.resolveDid).toHaveBeenCalledWith(ISSUER)
    expect(out).toEqual({ bbsPublicKey: 'zBBSMULTIBASE', ed25519PublicKey: 'ed25519hexkey' })
  })

  it('handles a single proof object (not an array) and the BbsBlsSignatureProof2020 variant', async () => {
    const didDocument = {
      id: ISSUER,
      verificationMethod: [{ id: `${ISSUER}#delegateKey-1`, type: 'Bls12381G2Key2020', publicKeyMultibase: 'zBBS2' }],
    }
    const resolver = makeResolver(didDocument)
    const vc = makeVc({ type: 'BbsBlsSignatureProof2020', verificationMethod: `${ISSUER}#delegateKey-1` })

    const out = await resolveIssuerProofKeys(vc, resolver)

    expect(out).toEqual({ bbsPublicKey: 'zBBS2', ed25519PublicKey: '' })
  })

  it('returns an empty string for a key whose proof type is absent from the VC (no resolver call needed for that half)', async () => {
    const didDocument = {
      id: ISSUER,
      verificationMethod: [{ id: `${ISSUER}#controllerKey`, type: 'Ed25519VerificationKey2020', publicKeyHex: 'edhex' }],
    }
    const resolver = makeResolver(didDocument)
    const vc = makeVc([{ type: 'Ed25519Signature2020', verificationMethod: `${ISSUER}#controllerKey` }])

    const out = await resolveIssuerProofKeys(vc, resolver)

    expect(out).toEqual({ bbsPublicKey: '', ed25519PublicKey: 'edhex' })
  })

  it('does not call the resolver at all when the VC has no proof', async () => {
    const resolver = makeResolver({ id: ISSUER, verificationMethod: [] })
    const vc = makeVc(undefined)

    const out = await resolveIssuerProofKeys(vc, resolver)

    expect(resolver.resolveDid).not.toHaveBeenCalled()
    expect(out).toEqual({ bbsPublicKey: '', ed25519PublicKey: '' })
  })

  it('throws when a proof references a verificationMethod not found in the resolved DID document', async () => {
    const didDocument = { id: ISSUER, verificationMethod: [] }
    const resolver = makeResolver(didDocument)
    const vc = makeVc([{ type: 'BbsBlsSignature2020', verificationMethod: `${ISSUER}#missing` }])

    await expect(resolveIssuerProofKeys(vc, resolver)).rejects.toThrow(/verification method/i)
  })

  it('throws when the VC has a proof but no issuer field', async () => {
    const resolver = makeResolver({ id: ISSUER, verificationMethod: [] })
    const vc = { id: 'did:zid:vc-1', proof: [{ type: 'BbsBlsSignature2020', verificationMethod: `${ISSUER}#k` }] }

    await expect(resolveIssuerProofKeys(vc, resolver)).rejects.toThrow(/issuer/i)
  })
})
