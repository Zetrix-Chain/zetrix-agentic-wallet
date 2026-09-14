import { describe, it, expect, vi } from 'vitest'
import { MbiVpAdapter, dcqlToRevealAttributes } from '../clients/mbi-vp-adapter'

/** The DCQL query as it arrives at createVp — the sandbox `requirements`/`credential_query` shape. */
const AGENT_DCQL = {
  credentials: [
    {
      id: 'did:zid:c042e49e',
      credentialTypes: ['VerifiableCredential', 'Agent Identity Credential'],
      format: 'ldp_vc',
      claims: [{ path: ['agentName'] }, { path: ['controllerName'] }, { path: ['purpose'] }],
    },
  ],
}

/** The Agent Identity Credential — claims nested under agentIdentityCredential. */
const AGENT_VC = {
  id: 'did:zid:a3ceab0b',
  type: ['VerifiableCredential', 'Agent Identity Credential'],
  credentialSubject: {
    id: 'did:zid:71a84e43',
    agentIdentityCredential: {
      agentDid: 'did:zid:ba4f1fcf',
      agentName: 'Jak Sparrow',
      controllerName: 'Haha A222',
      controllerDid: 'did:zid:ba4f1fcf',
      purpose: 'To gain access with x401 + x402 APIs',
    },
  },
}

function makeMbi() {
  return {
    createVp: vi.fn().mockResolvedValue({ blobId: 'b1', blob: 'deadbeef' }),
    submitVp: vi.fn().mockResolvedValue({ id: 'v2-ref-1', vp: { id: 'vp-1', type: ['VerifiablePresentation'] } }),
  }
}

describe('MbiVpAdapter (x401 VcProofProvider over MBI /vp/ext/*)', () => {
  it('runs create → Wallet-BE hex sign → submit(includeVp:true) and returns the finished VP + resolved issuer keys', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'addr-sig', publicKey: 'authpk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: 'issuer-bbs-pk', ed25519PublicKey: 'issuer-ed-hex' })

    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3Holder', resolveIssuerKeys, {
      vc: { id: 'vc-1' },
      revealAttribute: ['mykad.name'],
    })

    const out = await adapter.createVp({ credentialQuery: { q: 1 }, nonce: 'n1', holderDid: 'did:zid:h' })

    // Auth: sign the holder's own address once, reuse for both calls.
    expect(signMessage).toHaveBeenCalledWith('ZTX3Holder')
    expect(mbi.createVp).toHaveBeenCalledWith(
      { vc: { id: 'vc-1' }, revealAttributes: ['mykad.name'] },
      { signedData: 'addr-sig', publicKey: 'authpk' },
    )
    expect(signHexBlob).toHaveBeenCalledWith('deadbeef')
    expect(mbi.submitVp).toHaveBeenCalledWith(
      { blobId: 'b1', signedBlob: 'sig', publicKey: 'edpk', includeVp: true },
      { signedData: 'addr-sig', publicKey: 'authpk' },
    )
    // The issuer's resolved keys go to the OID4VP verifier — NOT the holder's signing key above.
    expect(resolveIssuerKeys).toHaveBeenCalledWith({ id: 'vc-1' })
    expect(out).toEqual({
      vp: { id: 'vp-1', type: ['VerifiablePresentation'] },
      ed25519PublicKey: 'issuer-ed-hex',
      bbsPublicKey: 'issuer-bbs-pk',
      presentationSubmission: { id: 'presentation', definition_id: 'presentation', descriptor_map: [] },
    })
  })

  it('returns a presentationSubmission (the OID4VP backend requires the field on submit)', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, { vc: { id: 'v' } })

    const out = await adapter.createVp({ credentialQuery: {}, nonce: 'n', holderDid: 'd' })

    // Empty descriptor_map is sufficient — the verifier's DcqlValidationService falls back to
    // matching by the VC's own id, or by position, when it's empty (see file docstring).
    expect(out.presentationSubmission).toEqual({ id: 'presentation', definition_id: 'presentation', descriptor_map: [] })
  })

  it('defaults revealAttribute to [] (reveal all) and forwards rangeProof when present', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, {
      vc: { id: 'v' },
      rangeProof: { ageOver: 18 },
    })

    await adapter.createVp({ credentialQuery: {}, nonce: 'n', holderDid: 'd' })

    expect(mbi.createVp).toHaveBeenCalledWith(
      { vc: { id: 'v' }, revealAttributes: [], rangeProof: { ageOver: 18 } },
      { signedData: 'as', publicKey: 'apk' },
    )
  })

  it('derives revealAttributes from the DCQL query, resolving leaf names against the nested VC', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    // No revealAttribute supplied -> derive from the challenge's DCQL, resolved against AGENT_VC.
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, { vc: AGENT_VC })

    await adapter.createVp({ credentialQuery: AGENT_DCQL, nonce: 'n', holderDid: 'd' })

    // Leaf DCQL paths (["agentName"]) resolve to the nested credentialSubject-relative paths.
    expect(mbi.createVp).toHaveBeenCalledWith(
      {
        vc: AGENT_VC,
        revealAttributes: [
          'agentIdentityCredential.agentName',
          'agentIdentityCredential.controllerName',
          'agentIdentityCredential.purpose',
        ],
      },
      { signedData: 'as', publicKey: 'apk' },
    )
  })

  it('an explicit caller revealAttribute overrides the DCQL query', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, {
      vc: { id: 'v' },
      revealAttribute: ['agentName'], // caller narrows further than the query
    })

    await adapter.createVp({ credentialQuery: AGENT_DCQL, nonce: 'n', holderDid: 'd' })

    expect(mbi.createVp).toHaveBeenCalledWith(
      { vc: { id: 'v' }, revealAttributes: ['agentName'] },
      { signedData: 'as', publicKey: 'apk' },
    )
  })

  describe('dcqlToRevealAttributes', () => {
    it('resolves leaf DCQL names against a nested VC credentialSubject (agentName -> agentIdentityCredential.agentName)', () => {
      expect(dcqlToRevealAttributes(AGENT_DCQL, AGENT_VC)).toEqual([
        'agentIdentityCredential.agentName',
        'agentIdentityCredential.controllerName',
        'agentIdentityCredential.purpose',
      ])
    })

    it('passes a full subject-relative DCQL path through unchanged when it already resolves', () => {
      const q = { credentials: [{ claims: [{ path: ['agentIdentityCredential', 'agentName'] }] }] }
      expect(dcqlToRevealAttributes(q, AGENT_VC)).toEqual(['agentIdentityCredential.agentName'])
    })

    it('falls back to a verbatim join when the leaf is not found in the VC', () => {
      const q = { credentials: [{ claims: [{ path: ['notAClaim'] }] }] }
      expect(dcqlToRevealAttributes(q, AGENT_VC)).toEqual(['notAClaim'])
    })

    it('joins verbatim when no VC is supplied (leaf names unresolved)', () => {
      expect(dcqlToRevealAttributes(AGENT_DCQL)).toEqual(['agentName', 'controllerName', 'purpose'])
    })

    it('joins multi-segment paths, collects across credentials, and de-dupes (first-seen order)', () => {
      const q = {
        credentials: [
          { claims: [{ path: ['credentialSubject', 'agentName'] }, { path: ['purpose'] }] },
          { claims: [{ path: ['purpose'] }, { path: ['controllerName'] }] },
        ],
      }
      expect(dcqlToRevealAttributes(q)).toEqual(['credentialSubject.agentName', 'purpose', 'controllerName'])
    })

    it('returns [] (reveal all) for empty, claim-less, or non-DCQL input', () => {
      expect(dcqlToRevealAttributes({})).toEqual([])
      expect(dcqlToRevealAttributes({ credentials: [{ id: 'x' }] })).toEqual([])
      expect(dcqlToRevealAttributes({ credentials: [{ claims: [] }] })).toEqual([])
      expect(dcqlToRevealAttributes(undefined)).toEqual([])
      expect(dcqlToRevealAttributes('nope')).toEqual([])
    })

    it('skips malformed claims (missing/empty/non-string path segments)', () => {
      const q = {
        credentials: [
          { claims: [{ path: [] }, { path: ['ok'] }, { path: ['a', 2] }, { nope: true }, { path: 'x' }] },
        ],
      }
      expect(dcqlToRevealAttributes(q)).toEqual(['ok'])
    })

    it('reorders resolved reveal paths to match the VC credentialSubject field order, not the DCQL claims order', () => {
      // The real Agent Identity template signs agentDid, agentName, purpose, controllerName in
      // that order — BBS+ selective disclosure must reveal them in the same order the issuer
      // signed them, regardless of what order the verifier's DCQL challenge happens to list them.
      const vcSignedOrder = {
        id: 'did:zid:a3ceab0b',
        type: ['VerifiableCredential', 'Agent Identity Credential'],
        credentialSubject: {
          id: 'did:zid:71a84e43',
          agentIdentityCredential: {
            agentDid: 'did:zid:ba4f1fcf',
            agentName: 'izzatur',
            purpose: 'for test',
            controllerName: 'jaksss',
          },
        },
      }
      // DCQL lists controllerName before purpose — the reverse of how the VC signed them.
      const dcqlOutOfOrder = {
        credentials: [{ claims: [{ path: ['agentName'] }, { path: ['controllerName'] }, { path: ['purpose'] }] }],
      }
      expect(dcqlToRevealAttributes(dcqlOutOfOrder, vcSignedOrder)).toEqual([
        'agentIdentityCredential.agentName',
        'agentIdentityCredential.purpose',
        'agentIdentityCredential.controllerName',
      ])
    })

    it('places a resolved path the VC does not contain after every path found in the VC, without disturbing found-path order', () => {
      const q = {
        credentials: [{ claims: [{ path: ['notAClaim'] }, { path: ['agentName'] }, { path: ['purpose'] }] }],
      }
      const vc = {
        credentialSubject: { agentIdentityCredential: { agentName: 'x', purpose: 'y' } },
      }
      expect(dcqlToRevealAttributes(q, vc)).toEqual([
        'agentIdentityCredential.agentName',
        'agentIdentityCredential.purpose',
        'notAClaim',
      ])
    })
  })

  it('uses caller-supplied issuerKeys and skips the ZID resolver when provided', async () => {
    const mbi = makeMbi()
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: 'RESOLVER', ed25519PublicKey: 'RESOLVER' })
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, {
      vc: AGENT_VC,
      issuerKeys: { bbsPublicKey: 'zBBS-OOB', ed25519PublicKey: 'edhex-OOB' },
    })

    const out = await adapter.createVp({ credentialQuery: AGENT_DCQL, nonce: 'n', holderDid: 'd' })

    expect(resolveIssuerKeys).not.toHaveBeenCalled()
    expect(out).toEqual({
      vp: { id: 'vp-1', type: ['VerifiablePresentation'] },
      ed25519PublicKey: 'edhex-OOB',
      bbsPublicKey: 'zBBS-OOB',
      presentationSubmission: { id: 'presentation', definition_id: 'presentation', descriptor_map: [] },
    })
  })

  it('throws when /vp/ext/create does not return blobId+blob', async () => {
    const mbi = { createVp: vi.fn().mockResolvedValue({ blob: 'aa' }), submitVp: vi.fn() } // missing blobId
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    const adapter = new MbiVpAdapter(mbi as never, vi.fn(), signMessage, 'ZTX3H', resolveIssuerKeys, { vc: {} })
    await expect(adapter.createVp({ credentialQuery: {}, nonce: 'n', holderDid: 'd' })).rejects.toThrow(/vp\/ext\/create/)
  })

  it('throws when /vp/ext/submit does not return vp (includeVp not honored)', async () => {
    const mbi = { createVp: vi.fn().mockResolvedValue({ blobId: 'b', blob: 'aa' }), submitVp: vi.fn().mockResolvedValue({ id: 'ref' }) }
    const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'pk' })
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
    const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: '', ed25519PublicKey: '' })
    const adapter = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, 'ZTX3H', resolveIssuerKeys, { vc: {} })
    await expect(adapter.createVp({ credentialQuery: {}, nonce: 'n', holderDid: 'd' })).rejects.toThrow(/vp\/ext\/submit/)
  })
})
