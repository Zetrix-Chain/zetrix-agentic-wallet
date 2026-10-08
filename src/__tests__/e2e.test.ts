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
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import jsQR from 'jsqr'
import { X401Wallet } from 'x401-zetrix-client'
import { WalletBeClient } from '../clients/wallet-be-client'
import { WalletBeSigner } from '../signer'
import { MbiVpAdapter, type VcPresentInput } from '../clients/mbi-vp-adapter'
import { MbiClient } from '../clients/mbi-client'
import { ZidResolverClient } from '../clients/zid-resolver-client'
import { resolveIssuerProofKeys } from '../clients/resolve-issuer-proof-keys'
import { createTools, type ToolDeps } from '../mcp-tools'
import { createVerificationLink, type VerificationLinkInput } from '../orchestrator/verification-qr'
import { renderQrPng } from '../qr-png'
import { buildToolContent } from '../tool-result'

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
        { signer, vc: new MbiVpAdapter(mbi, walletBeSignerFn, messageSigner, resolveIssuerKeys, present) },
      )

    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
      makeWallet,
      payer: vi.fn() as never,
      subscribeDeps: { mbi: {} as never, sign: vi.fn(), pay: vi.fn(), holderDid: 'did:zid:h' },
      // The RAW contract seam the policy tools use; unused by this flow but required by ToolDeps.
      chainQuery: vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [] } }),
      createAccount: vi.fn(),
    })

    const out = await tools.prove_identity({ proofRequest: proofRequestHeader(), vc: heldVc })

    expect(out.verified).toBe(true)
    expect(out.presentationId).toBe('req-1')
    expect(out.proofResponseHeader.length).toBeGreaterThan(0)

    // MBI was driven create → submit(includeVp:true); Wallet BE signed one request-bound login per
    // /ext call, the VP blob, and (separately) the holder-binding nonce.
    const createCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/create'))
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({ vc: heldVc, revealAttributes: [] })
    const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/submit'))
    expect(JSON.parse((submitCall![1] as RequestInit).body as string)).toEqual({
      blobId: 'b1', signedBlob: 'sig', publicKey: 'edpk', includeVp: true,
    })

    // Each MBI /ext call carries signedData, publicKey and its own timestamp; Wallet BE was asked to
    // sign METHOD|PATH|sha256(body)|timestamp for that call, not the bare address.
    const bodyOf = (call: unknown[]) => (call[1] as RequestInit).body as string
    const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>
    const signedMessages = fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/wallet/hsm/sign-message'))
      .map((c) => JSON.parse(bodyOf(c)).message as string)
    for (const [call, path] of [[createCall!, '/v1/vp/ext/create'], [submitCall!, '/v1/vp/ext/submit']] as const) {
      const h = headersOf(call)
      expect(h.signedData).toBe('addr-sig')
      expect(h.publicKey).toBe('authpk')
      expect(signedMessages).toContain(`POST|${path}|${createHash('sha256').update(bodyOf(call), 'utf8').digest('hex')}|${h.timestamp}`)
    }
    expect(signedMessages).not.toContain('ZTX3H')

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

describe('agentic-wallet-mcp create_verification_qr — end to end', () => {
  const TEMPLATE = 'https://link.myid.test/agentic-verify?referenceId={referenceId}'

  /** Read our own grayscale PNG back into RGBA pixels, as a phone camera would see the screen. */
  function decodeQr(pngBase64: string): string | undefined {
    const png = Buffer.from(pngBase64, 'base64')
    let offset = 8
    let width = 0
    let height = 0
    const idat: Buffer[] = []
    while (offset < png.length) {
      const length = png.readUInt32BE(offset)
      const type = png.toString('ascii', offset + 4, offset + 8)
      const body = png.subarray(offset + 8, offset + 8 + length)
      if (type === 'IHDR') {
        width = body.readUInt32BE(0)
        height = body.readUInt32BE(4)
      }
      if (type === 'IDAT') idat.push(body)
      offset += 12 + length
    }
    const raw = inflateSync(Buffer.concat(idat))
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = raw[y * (width + 1) + 1 + x]
        const i = (y * width + x) * 4
        data[i] = data[i + 1] = data[i + 2] = v
        data[i + 3] = 255
      }
    }
    return jsQR(data, width, height)?.data
  }

  function wire(linkTemplate: string | undefined) {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
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
        return { ok: true, json: async () => ({ status: 200, data: { id: 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77' } }) } as unknown as Response
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const be = new WalletBeClient('https://wallet-be.test')
    const mbi = new MbiClient('https://mbi.test')
    // Only the dependencies this tool touches are real; the rest are inert stand-ins.
    const tools = createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
      makeWallet: vi.fn() as never,
      payer: vi.fn() as never,
      subscribeDeps: { mbi: {} as never, sign: vi.fn(), pay: vi.fn(), holderDid: 'did:zid:h' },
      chainQuery: vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [] } }),
      createAccount: vi.fn(),
      createVerificationLink: (input: VerificationLinkInput) =>
        createVerificationLink(input, {
          mbi,
          signHexBlob: (blob) => be.signBlob(blob, 'ZTX3H', 'pw123456'),
          signMessage: (message) => be.signMessage(message, 'ZTX3H', 'pw123456'),
          linkTemplate,
          renderQr: renderQrPng,
        }),
    } as unknown as ToolDeps)
    return { tools, fetchMock }
  }

  const heldVc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:h', agentName: 'agent-007' } }
  const bodyOf = (call: unknown[]) => (call[1] as RequestInit).body as string
  const headersOf = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>

  it('presents the VC to MBI with request-bound signing and returns a link plus a QR that decodes to that link', async () => {
    const { tools, fetchMock } = wire(TEMPLATE)

    const out = await tools.create_verification_qr({ vc: heldVc, revealAttribute: ['agentName'] })

    const link = 'https://link.myid.test/agentic-verify?referenceId=v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77'
    expect(out).toMatchObject({ created: true, link, referenceId: 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77', expiresInMinutes: 5 })

    const createCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/create'))
    expect(JSON.parse(bodyOf(createCall!))).toEqual({ vc: heldVc, revealAttributes: ['agentName'] })
    const submitCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/v1/vp/ext/submit'))
    // vpExpiry is sent explicitly, and the VP is NOT asked back (includeVp): only the reference id leaves MBI.
    expect(JSON.parse(bodyOf(submitCall!))).toEqual({ blobId: 'b1', signedBlob: 'sig', publicKey: 'edpk', vpExpiry: 5 })

    const signedMessages = fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/wallet/hsm/sign-message'))
      .map((c) => JSON.parse(bodyOf(c)).message as string)
    for (const [call, path] of [[createCall!, '/v1/vp/ext/create'], [submitCall!, '/v1/vp/ext/submit']] as const) {
      const h = headersOf(call)
      expect(signedMessages).toContain(`POST|${path}|${createHash('sha256').update(bodyOf(call), 'utf8').digest('hex')}|${h.timestamp}`)
    }

    // What the MCP client receives: JSON text without the base64, then the image — and the image decodes to the link.
    const blocks = await buildToolContent(out, vi.fn())
    expect(blocks).toHaveLength(2)
    const text = JSON.parse((blocks[0] as { text: string }).text)
    expect(text.link).toBe(link)
    expect('qrCodePngBase64' in text).toBe(false)
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(decodeQr((blocks[1] as { data: string }).data)).toBe(link)
  })

  it('creates nothing on MBI when no link template is configured', async () => {
    const { tools, fetchMock } = wire(undefined)

    // revealAttribute is given so the call gets past the reveal check and is stopped by the template check itself
    const out = await tools.create_verification_qr({ vc: heldVc, revealAttribute: ['agentName'] })

    expect(out).toMatchObject({ created: false })
    expect((out as { reason: string }).reason).toMatch(/MYID_VERIFY_LINK_TEMPLATE/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
