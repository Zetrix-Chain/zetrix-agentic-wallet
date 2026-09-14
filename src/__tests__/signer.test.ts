import { describe, it, expect, vi } from 'vitest'
import { WalletBeSigner } from '../signer'
import type { WalletBeClient } from '../clients/wallet-be-client'

describe('WalletBeSigner (x401 HolderSigner over Wallet BE)', () => {
  it('hex-encodes the verifier nonce and delegates to WalletBeClient.signBlob', async () => {
    const be = { signBlob: vi.fn().mockResolvedValue({ signBlob: 'sb', publicKey: 'pk' }) }
    const signer = new WalletBeSigner(be as unknown as WalletBeClient, 'ZTX3Holder', 'pw123456')

    const out = await signer.sign('nonce-abc')

    const expectedHex = Buffer.from('nonce-abc', 'utf8').toString('hex')
    expect(be.signBlob).toHaveBeenCalledWith(expectedHex, 'ZTX3Holder', 'pw123456')
    expect(out).toEqual({ signBlob: 'sb', publicKey: 'pk' })
  })
})
