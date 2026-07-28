/**
 * End-to-end prove_identity (adapter uses MBI).
 *
 * Drives the REAL wiring — createTools → prove_identity → makeWallet → real X401Wallet
 * → real MbiVpAdapter (MBI HTTP mocked) → real WalletBeClient/Signer + real ZidResolverClient
 * + OID4VP client (global fetch mocked) — and asserts a PROOF-RESPONSE comes out. Only one
 * external boundary is stubbed: HTTP (fetch) — MBI, Wallet BE, the ZID resolver, and the OID4VP
 * verifier are all reached over it.
 *
 * The fetch stubs use the REAL OID4VP contract:
 * GET returns a `ResponseWrapper` `{ object: { presentation_id, credential_query, nonce,
 * response_uri, expires_at } }`; POST submit returns `{ object: { signed_result } }` + the
 * HMAC/timestamp as `X-Callback-*` headers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { X401Wallet } from 'x401-zetrix-client'
import { WalletBeClient } from '../clients/wallet-be-client'
import { WalletBeSigner } from '../signer'
import { MbiVpAdapter, type VcPresentInput } from '../clients/mbi-vp-adapter'
import { MbiClient } from '../clients/mbi-client'
import { ZidResolverClient } from '../clients/zid-resolver-client'
import { resolveIssuerProofKeys } from '../clients/resolve-issuer-proof-keys'
import { createTools } from '../mcp-tools'

afterEach(() => vi.unstubAllGlobals())

const OID4VP = 'https://verifier.test/api'
const SUBMIT_URI = `${OID4VP}/v1/presentation/submit`
const ZID_RESOLVER = 'https://zid-resolver.test'
const ISSUER_DID = 'did:zid:issuer1'

function proofRequestHeader() {
  return Buffer.from(
    JSON.stringify({
      verification_data: { requestUri: `${OID4VP}/v1/presentation/req-1`, nonce: 'nonce-1', expiresAt: '2026-12-31' },
      credential_requirements: { type: 'AgentIdentity' },
      request_id: 'req-1',
      request_uri: `${OID4VP}/v1/presentation/req-1`,
      nonce: 'nonce-1',
    }),
    'utf8',
  ).toString('base64url')
}

describe('agentic-wallet-mcp prove_identity — end to end', () => {
  it('parses the challenge, derives the VP via MBI, signs via Wallet BE, submits, returns a PROOF-RESPONSE', async () => {
    // GET /v1/presentation/{id} — real OID4VP: ResponseWrapper + snake_case.
    const definition = {
      object: { presentation_id: 'req-1', credential_query: {}, nonce: 'nonce-1', response_uri: SUBMIT_URI, expires_at: '2026-12-31' },
    }
    // POST submit — sync-HMAC: signed_result string in the body, HMAC/timestamp in headers.
    const submitBody = { object: { signed_result: '{"presentationId":"req-1","verified":true,"status":"VERIFIED"}' } }
    const cb = new Map([['X-Callback-Signature', 'hmac-sig'], ['X-Callback-Timestamp', '2026-01-01T00:00:00Z']])

    const finishedVp = { holder: 'did:zid:h', type: ['VerifiablePresentation'], verifiableCredential: [{ id: 'vc-1' }] }

    // The client-held VC — has its own issuer-signed proofs (BBS+ + Ed25519), same shape MBI issues.
    const heldVc = {
      id: 'did:zid:vc-1',
      issuer: ISSUER_DID,
      proof: [
        { type: 'BbsBlsSignature2020', verificationMethod: `${ISSUER_DID}#delegateKey-6` },
        { type: 'Ed25519Signature2020', verificationMethod: `${ISSUER_DID}#controllerKey` },
      ],
    }
    const issuerDidDocument = {
      id: ISSUER_DID,
      verificationMethod: [
        { id: `${ISSUER_DID}#delegateKey-6`, type: 'Bls12381G2Key2020', publicKeyMultibase: 'zISSUERBBSKEY' },
        { id: `${ISSUER_DID}#controllerKey`, type: 'Ed25519VerificationKey2020', publicKeyHex: 'issuered25519hex' },
      ],
    }

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/v1/presentation/req-1') && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, json: async () => definition } as unknown as Response
      }
      if (u.endsWith('/wallet/hsm/sign-message')) {
        return { ok: true, json: async () => ({ errorCode: 0, data: { signBlob: 'addr-sig', publicKey: 'authpk' } }) } as unknown as Response
      }
      if (u.endsWith('/wallet/hsm/sign-blob')) {
        return { ok: true, json: async () => ({ errorCode: 0, data: { signBlob: 'sig', publicKey: 'edpk' } }) } as unknown as Response
      }
      if (u.endsWith('/v1/vp/ext/create')) {
        return { ok: true, json: async () => ({ status: 200, data: { blobId: 'b1', blob: 'deadbeef' } }) } as unknown as Response
      }
      if (u.endsWith('/v1/vp/ext/submit')) {
        return { ok: true, json: async () => ({ status: 200, data: { id: 'v2-ref-1', vp: finishedVp } }) } as unknown as Response
      }
      if (u === `${ZID_RESOLVER}/1.0/identifiers/${ISSUER_DID}`) {
        return { ok: true, json: async () => ({ didDocument: issuerDidDocument }) } as unknown as Response
      }
      if (u === SUBMIT_URI && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => submitBody,
          headers: { get: (k: string) => cb.get(k) ?? null },
        } as unknown as Response
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const be = new WalletBeClient('https://wallet-be.test')
    const signer = new WalletBeSigner(be, 'ZTX3H', 'pw123456')
    const walletBeSignerFn = (blob: string) => be.signBlob(blob, 'ZTX3H', 'pw123456')
    const messageSigner = (message: string) => be.signMessage(message, 'ZTX3H', 'pw123456')
    const mbi = new MbiClient('https://mbi.test')
    const zidResolver = new ZidResolverClient(ZID_RESOLVER)
    const resolveIssuerKeys = (vc: unknown) => resolveIssuerProofKeys(vc, zidResolver)
    const makeWallet = (present: VcPresentInput) =>
      new X401Wallet(
        { oid4vpBaseUrl: OID4VP },
        { signer, vc: new MbiVpAdapter(mbi, walletBeSignerFn, messageSigner, 'ZTX3H', resolveIssuerKeys, present) },
      )

    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
      makeWallet,
      payer: vi.fn() as never,
      subscribeDeps: { mbi: {} as never, sign: vi.fn(), pay: vi.fn(), holderDid: 'did:zid:h' },
      createAccount: vi.fn(),
    })

    const out = await tools.prove_identity({ proofRequest: proofRequestHeader(), vc: heldVc })

    expect(out.verified).toBe(true)
    expect(out.presentationId).toBe('req-1')
    expect(out.proofResponseHeader.length).toBeGreaterThan(0)

    // MBI was driven create → submit(includeVp:true); Wallet BE signed the auth address,
    // the VP blob, and (separately) the holder-binding nonce.
    const createCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/create'))
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({ vc: heldVc, revealAttributes: [] })
    const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/submit'))
    expect(JSON.parse((submitCall![1] as RequestInit).body as string)).toEqual({
      blobId: 'b1', signedBlob: 'sig', publicKey: 'edpk', includeVp: true,
    })

    // The OID4VP submit body carries the VC's *issuer's* resolved keys, not the holder's signing key.
    const oid4vpSubmitCall = fetchMock.mock.calls.find(([u], i) => String(u) === SUBMIT_URI && fetchMock.mock.calls[i][1]?.method === 'POST')
    const oid4vpBody = JSON.parse((oid4vpSubmitCall![1] as RequestInit).body as string)
    expect(oid4vpBody.bbs_public_key).toBe('zISSUERBBSKEY')
    expect(oid4vpBody.ed25519_public_key).toBe('issuered25519hex')

    // PROOF-RESPONSE envelope carries the verbatim payload + HMAC + timestamp.
    const env = JSON.parse(Buffer.from(out.proofResponseHeader, 'base64url').toString('utf8'))
    expect(env.signature).toBe('hmac-sig')
    expect(env.timestamp).toBe('2026-01-01T00:00:00Z')
    expect(JSON.parse(env.payload)).toMatchObject({ presentationId: 'req-1', verified: true, status: 'VERIFIED' })
  })
})
