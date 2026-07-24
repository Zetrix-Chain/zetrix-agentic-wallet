import { describe, it, expect, vi, afterEach } from 'vitest'
import { WalletBeClient, WalletBeError } from '../clients/wallet-be-client'

const c = new WalletBeClient('https://wallet-be.test/')
afterEach(() => vi.unstubAllGlobals())

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('WalletBeClient', () => {
  it('signBlob POSTs /wallet/hsm/sign-blob and unwraps data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ errorCode: 0, message: 'SUCCESS', data: { signBlob: 'sb', publicKey: 'pk' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await c.signBlob('0102', 'ZTX3Holder', 'pw123456')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://wallet-be.test/wallet/hsm/sign-blob')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ blob: '0102', address: 'ZTX3Holder', password: 'pw123456' })
    expect(out).toEqual({ signBlob: 'sb', publicKey: 'pk' })
  })

  it('signMessage POSTs /wallet/hsm/sign-message with the message body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ errorCode: 0, data: { signBlob: 'sb', publicKey: 'pk' } }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await c.signMessage('hello world', 'ZTX3Holder', 'pw123456')

    expect(fetchMock.mock.calls[0][0]).toBe('https://wallet-be.test/wallet/hsm/sign-message')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      message: 'hello world', address: 'ZTX3Holder', password: 'pw123456',
    })
    expect(out).toEqual({ signBlob: 'sb', publicKey: 'pk' })
  })

  it('createAccount POSTs /wallet/hsm/account/create and returns the account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ errorCode: 0, data: { zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const acct = await c.createAccount('pw123456', 'my-wallet', 'testing')

    expect(fetchMock.mock.calls[0][0]).toBe('https://wallet-be.test/wallet/hsm/account/create')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: 'pw123456', label: 'my-wallet', purpose: 'testing' })
    expect(acct).toEqual({ zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc' })
  })

  it('throws WalletBeError (with errorCode + message) when errorCode !== 0 — HTTP is still 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 1000026, message: 'HSM service call failed', data: null }),
    ))
    await expect(c.signBlob('0102', 'ZTX3Holder', 'pw123456')).rejects.toMatchObject({
      name: 'WalletBeError', errorCode: 1000026,
    })
  })

  it('hints at create_holder_account when a sign call fails with errorCode 1000026 (unprovisioned account)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 1000026, message: 'HSM service call failed', data: null }),
    ))
    await expect(c.signBlob('0102', 'ZTX3Holder', 'pw123456')).rejects.toThrow(/create_holder_account/)
  })

  it('does not add the create_holder_account hint for a 1000026 failure on account/create itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 1000026, message: 'HSM service call failed', data: null }),
    ))
    await expect(c.createAccount('pw123456')).rejects.not.toThrow(/create_holder_account/)
  })

  it('surfaces validation errorList (errorCode 1) in the thrown error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 1, message: 'Invalid parameter', data: { errorList: ['password：Must not be blank'] } }),
    ))
    await expect(c.signBlob('0102', 'ZTX3Holder', '')).rejects.toThrow(/Must not be blank/)
  })

  it('throws WalletBeError on transport failure (non-2xx / network)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'bad gateway' }))
    await expect(c.signBlob('0102', 'ZTX3Holder', 'pw123456')).rejects.toBeInstanceOf(WalletBeError)
  })
})
