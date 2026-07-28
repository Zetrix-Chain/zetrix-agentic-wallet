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
      okJson({ errorCode: 0, data: { zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc', activated: true, activationTxHash: '0xabc' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const acct = await c.createAccount('pw123456', 'my-wallet', 'testing')

    expect(fetchMock.mock.calls[0][0]).toBe('https://wallet-be.test/wallet/hsm/account/create')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ password: 'pw123456', label: 'my-wallet', purpose: 'testing' })
    expect(acct).toEqual({ zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc', activated: true, activationTxHash: '0xabc' })
  })

  it('createAccount surfaces activated:false and a null activationTxHash (activation still pending)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 0, data: { zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc', activated: false, activationTxHash: null } }),
    ))
    const acct = await c.createAccount('pw123456')
    expect(acct).toEqual({ zetrixAddress: 'ZTX3New', publicKeyHex: 'ed25519:abc', activated: false, activationTxHash: null })
  })

  it('checkActivationStatus GETs /wallet/hsm/account/activate/status with the address query param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okJson({ errorCode: 0, data: { address: 'ZTX3Holder', activated: true } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await c.checkActivationStatus('ZTX3Holder')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://wallet-be.test/wallet/hsm/account/activate/status?address=ZTX3Holder')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(out).toEqual({ address: 'ZTX3Holder', activated: true })
  })

  it('checkActivationStatus reports activated:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 0, data: { address: 'ZTX3Holder', activated: false } }),
    ))
    const out = await c.checkActivationStatus('ZTX3Holder')
    expect(out).toEqual({ address: 'ZTX3Holder', activated: false })
  })

  it('checkActivationStatus throws WalletBeError when errorCode !== 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      okJson({ errorCode: 1000026, message: 'HSM service error', data: null }),
    ))
    await expect(c.checkActivationStatus('ZTX3Holder')).rejects.toMatchObject({ name: 'WalletBeError', errorCode: 1000026 })
  })

  it('checkActivationStatus URL-encodes the address query param (URLSearchParams encodes space as +)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ errorCode: 0, data: { address: 'ZTX3 Holder', activated: true } }))
    vi.stubGlobal('fetch', fetchMock)
    await c.checkActivationStatus('ZTX3 Holder')
    expect(fetchMock.mock.calls[0][0]).toBe('https://wallet-be.test/wallet/hsm/account/activate/status?address=ZTX3+Holder')
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
