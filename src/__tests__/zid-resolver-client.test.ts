import { describe, it, expect, vi, afterEach } from 'vitest'
import { ZidResolverClient, ZidResolverError } from '../clients/zid-resolver-client'

const client = new ZidResolverClient('https://zid-resolver-sandbox.zetrix.com/')
afterEach(() => vi.unstubAllGlobals())

function resp(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('ZidResolverClient', () => {
  it('GETs /1.0/identifiers/{did} and returns the didDocument', async () => {
    const didDocument = {
      id: 'did:zid:issuer1',
      verificationMethod: [
        { id: 'did:zid:issuer1#delegateKey-6', type: 'Bls12381G2Key2020', publicKeyMultibase: 'zBBSKEY' },
        { id: 'did:zid:issuer1#controllerKey', type: 'Ed25519VerificationKey2020', publicKeyHex: 'ed25519hex' },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { didDocument, didDocumentMetadata: {}, didResolutionMetadata: {} }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await client.resolveDid('did:zid:issuer1')

    expect(fetchMock.mock.calls[0][0]).toBe('https://zid-resolver-sandbox.zetrix.com/1.0/identifiers/did:zid:issuer1')
    expect(out).toEqual(didDocument)
  })

  it('throws ZidResolverError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(404, { message: 'not found' })))
    await expect(client.resolveDid('did:zid:missing')).rejects.toBeInstanceOf(ZidResolverError)
  })

  it('throws ZidResolverError when the response has no didDocument', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { didResolutionMetadata: { error: 'notFound' } })))
    await expect(client.resolveDid('did:zid:x')).rejects.toThrow(/didDocument/)
  })
})
