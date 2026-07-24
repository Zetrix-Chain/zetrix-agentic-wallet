import { describe, it, expect, vi, afterEach } from 'vitest'
import { MbiClient, MbiError } from '../clients/mbi-client'

const mbi = new MbiClient('https://mbi.test/')
afterEach(() => vi.unstubAllGlobals())

function resp(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

const applyBody = { data: '[{"templateId":"t"}]', signData: 'sig', publicKey: 'pk' }

describe('MbiClient', () => {
  it('applyChallenge POSTs /v1/vc/pay/apply (no X-PAYMENT) and parses the 402 + paymentId', async () => {
    const body402 = {
      x402Version: 2, error: 'payment required',
      accepts: [{ scheme: 'exact', payTo: 'ZTXissuer', asset: 'JMYR', maxAmountRequired: '1000000', extra: { paymentId: 'pid-1', templateCode: 'agent-identity-credential' } }],
    }
    const fetchMock = vi.fn().mockResolvedValue(resp(402, body402))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applyChallenge(applyBody)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.method).toBe('POST')
    expect(init.headers['X-PAYMENT']).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual(applyBody)
    expect(out.paymentId).toBe('pid-1')
    expect(out.accepts).toHaveLength(1)
    expect(out.x402Version).toBe(2)
  })

  it('applySettle sends X-PAYMENT + paymentId in body and unwraps the issued VC', async () => {
    const ok = { status: 200, message: 'Success', data: { vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applySettle({ ...applyBody, paymentId: 'pid-1' }, 'BASE64PAYMENT')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.headers['X-PAYMENT']).toBe('BASE64PAYMENT')
    expect(JSON.parse(init.body)).toEqual({ ...applyBody, paymentId: 'pid-1' })
    expect(out).toEqual({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } })
  })

  it('getStatus GETs /v1/vc/pay/status/{paymentId} and unwraps data', async () => {
    const ok = { status: 200, data: { paymentId: 'pid-1', status: 'ISSUED', txHash: '0xabc', vcId: 'did:zid:vc' } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.getStatus('pid-1')

    expect(fetchMock.mock.calls[0][0]).toBe('https://mbi.test/v1/vc/pay/status/pid-1')
    expect(out.status).toBe('ISSUED')
    expect(out.vcId).toBe('did:zid:vc')
  })

  it('applyChallenge throws MbiError when phase 1 returns a non-402 error (e.g. 401 signature invalid)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { status: 401, message: 'X402_SIGNATURE_INVALID' })))
    await expect(mbi.applyChallenge(applyBody)).rejects.toMatchObject({ name: 'MbiError', httpStatus: 401 })
  })

  it('applyChallenge returns the issued VC (no accepts/paymentId) when phase 1 returns 200 for a free template', async () => {
    const ok = { status: 200, message: 'Success', data: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applyChallenge(applyBody)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.headers['X-PAYMENT']).toBeUndefined()
    expect(out).toEqual({
      x402Version: 1,
      accepts: [],
      issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } },
    })
    expect(out.paymentId).toBeUndefined()
  })

  it('error() caps the echoed response body so a large/malicious payload cannot bloat the error message', async () => {
    const hugeMessage = 'x'.repeat(1000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { status: 401, message: 'short reason', huge: hugeMessage })))

    await expect(mbi.applyChallenge(applyBody)).rejects.toMatchObject({
      name: 'MbiError',
      httpStatus: 401,
      message: expect.stringContaining('truncated'),
    })
    try {
      await mbi.applyChallenge(applyBody)
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(1000)
    }
  })

  it('applySettle throws MbiError on a non-2xx (e.g. 402 payment invalid)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(402, { status: 402, message: 'X402_PAYMENT_INVALID' })))
    await expect(mbi.applySettle({ ...applyBody, paymentId: 'pid-1' }, 'BASE64')).rejects.toBeInstanceOf(MbiError)
  })

  it('createVp POSTs /v1/vp/ext/create with the signedData/publicKey auth headers and unwraps {blobId,blob}', async () => {
    const ok = { status: 200, message: 'Success', data: { blobId: 'b1', blob: 'deadbeef' } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.createVp(
      { vc: { id: 'vc-1' }, revealAttributes: ['mykad.name'] },
      { signedData: 'sig-over-address', publicKey: 'b001pk' },
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vp/ext/create')
    expect(init.method).toBe('POST')
    expect(init.headers.signedData).toBe('sig-over-address')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(JSON.parse(init.body)).toEqual({ vc: { id: 'vc-1' }, revealAttributes: ['mykad.name'] })
    expect(out).toEqual({ blobId: 'b1', blob: 'deadbeef' })
  })

  it('createVp throws MbiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { status: 403, message: 'Authenticated DID does not match VC credential subject ID' })))
    await expect(
      mbi.createVp({ vc: {}, revealAttributes: [] }, { signedData: 's', publicKey: 'pk' }),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 403 })
  })

  it('submitVp POSTs /v1/vp/ext/submit with includeVp + the auth headers and unwraps {id,vp}', async () => {
    const vp = { holder: 'did:zid:h', verifiableCredential: [{ id: 'vc-1' }] }
    const ok = { status: 200, message: 'Success', data: { id: 'v2-ref-1', vp } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.submitVp(
      { blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk', includeVp: true },
      { signedData: 'sig-over-address', publicKey: 'b001pk' },
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vp/ext/submit')
    expect(init.headers.signedData).toBe('sig-over-address')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(JSON.parse(init.body)).toEqual({ blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk', includeVp: true })
    expect(out).toEqual({ id: 'v2-ref-1', vp })
  })

  it('submitVp omits vp from the result when includeVp is not set (MBI omits the key entirely)', async () => {
    const ok = { status: 200, message: 'Success', data: { id: 'v2-ref-2' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok)))

    const out = await mbi.submitVp(
      { blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk' },
      { signedData: 's', publicKey: 'b001pk' },
    )

    expect(out).toEqual({ id: 'v2-ref-2' })
    expect(out.vp).toBeUndefined()
  })

  it('submitVp throws MbiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { status: 403, message: 'Authenticated address does not match request public key address' })))
    await expect(
      mbi.submitVp({ blobId: 'b1', signedBlob: 's', publicKey: 'pk' }, { signedData: 's', publicKey: 'pk' }),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 403 })
  })
})
