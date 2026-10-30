import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { encodePublicKey } from '../public-key'
import { buildToolConfig } from '../index'
import { createTools, type ToolDeps } from '../mcp-tools'

// The library ships no types; its own key pairs are the reference for the encoded form MBI reads.
const enc = createRequire(import.meta.url)('zetrix-encryption-nodejs') as { keypair: { getKeyPair: () => { encPublicKey: string } } }

describe('encodePublicKey', () => {
  it('leaves an encoded key as it is, and encodes a raw 32-byte key to the library\'s own form', () => {
    for (let i = 0; i < 5; i++) {
      const { encPublicKey } = enc.keypair.getKeyPair()
      expect(encPublicKey).toHaveLength(76)
      expect(encodePublicKey(encPublicKey)).toBe(encPublicKey)
      expect(encodePublicKey(encPublicKey.slice(4, 68))).toBe(encPublicKey)
    }
  })

  it('ignores case and surrounding spaces', () => {
    const { encPublicKey } = enc.keypair.getKeyPair()
    expect(encodePublicKey(`  ${encPublicKey.toUpperCase()} `)).toBe(encPublicKey)
    expect(encodePublicKey(encPublicKey.slice(4, 68).toUpperCase())).toBe(encPublicKey)
  })

  it('leaves out anything that is not a Zetrix public key rather than showing a key MBI would refuse', () => {
    const { encPublicKey } = enc.keypair.getKeyPair()
    const badChecksum = encPublicKey.slice(0, 68) + (encPublicKey.slice(68) === '00000000' ? '00000001' : '00000000')
    for (const bad of [undefined, '', '   ', 'b001pk', 'zz'.repeat(32), encPublicKey.slice(0, 75), `${encPublicKey}00`, badChecksum, 'b002' + encPublicKey.slice(4)]) {
      expect(encodePublicKey(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('wallet_status and the public key', () => {
  const KEY = enc.keypair.getKeyPair().encPublicKey
  const tools = (config: Record<string, unknown>) =>
    createTools({ config: { holderDid: 'did:zid:me', zetrixAddress: 'ZTX3me', network: 'zetrix:testnet', ...config }, queryTokenBalance: async () => ({}) } as unknown as ToolDeps)

  it('returns the wallet\'s own public key beside its address and DID, and says nothing when it is not known', async () => {
    const withKey = await tools({ publicKey: KEY }).wallet_status({ heldCredentials: [] })
    expect(withKey).toMatchObject({ holderDid: 'did:zid:me', zetrixAddress: 'ZTX3me', network: 'zetrix:testnet', publicKey: KEY })
    expect('publicKey' in (await tools({}).wallet_status({ heldCredentials: [] }))).toBe(false)
  })

  it('buildToolConfig carries it from the wiring, encoded form only', () => {
    const base = { network: 'zetrix:testnet' } as Parameters<typeof buildToolConfig>[0]
    expect(buildToolConfig(base, 'did:zid:me', 'ZTX3me', KEY).publicKey).toBe(KEY)
    expect('publicKey' in buildToolConfig(base, 'did:zid:me', 'ZTX3me')).toBe(false)
    expect('publicKey' in buildToolConfig(base, 'did:zid:me', 'ZTX3me', encodePublicKey('nonsense'))).toBe(false)
  })
})
