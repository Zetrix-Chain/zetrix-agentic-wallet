import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config'

const base = {
  ZETRIX_NETWORK: 'zetrix:testnet',
  HSM_PASSWORD: 'pw123456',
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('reads required fields, strips trailing slashes, and derives testnet defaults', () => {
    const cfg = loadConfig(base)
    expect(cfg).toEqual({
      walletBeUrl: 'https://wallet-api.myegdev.com/server',
      oid4vpBaseUrl: undefined,
      mbiBaseUrl: 'https://mbi-vc.myegdev.com',
      network: 'zetrix:testnet',
      zetrixAddress: undefined,
      holderDid: undefined,
      hsmPassword: 'pw123456',
      nodeHost: 'test-node.zetrix.com',
      nodePort: '',
      templateRegistryAddress: 'ZTX3JszqPgRUx743SAp7q7zURfjvkWuH2FMEz',
      zidResolverBaseUrl: 'https://zid-resolver-sandbox.zetrix.com',
    })
  })

  it('derives the mainnet template-registry address and honors the override', () => {
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).templateRegistryAddress).toBe(
      'ZTX3GqJM1U6ifMPonwD4fGvrgoTKJua7b2cKX',
    )
    expect(
      loadConfig({ ...base, ZETRIX_TEMPLATE_REGISTRY_ADDRESS: 'ZTX3Custom' } as NodeJS.ProcessEnv).templateRegistryAddress,
    ).toBe('ZTX3Custom')
  })

  it('derives mainnet defaults for Wallet BE, MBI, node host + ZID resolver, and passes optional ZETRIX_ADDRESS/HOLDER_DID + node overrides through', () => {
    const cfg = loadConfig({
      ...base,
      ZETRIX_NETWORK: 'zetrix:mainnet',
      ZETRIX_ADDRESS: 'ZTX3Holder',
      HOLDER_DID: 'did:zid:holder',
      ZETRIX_NODE_HOST: 'node.custom.com',
      ZETRIX_NODE_PORT: '19333',
    } as NodeJS.ProcessEnv)
    expect(cfg.walletBeUrl).toBe('https://wallet-api.zetrix.com/server')
    expect(cfg.mbiBaseUrl).toBe('https://mbi-vc.zetrix.com')
    expect(cfg.nodeHost).toBe('node.custom.com')
    expect(cfg.nodePort).toBe('19333')
    expect(cfg.zetrixAddress).toBe('ZTX3Holder')
    expect(cfg.holderDid).toBe('did:zid:holder')
    expect(cfg.zidResolverBaseUrl).toBe('https://zid-resolver.zetrix.com')
  })

  it('allows overriding the ZID resolver base URL', () => {
    const cfg = loadConfig({ ...base, ZID_RESOLVER_BASE_URL: 'https://resolver.custom.com/' } as NodeJS.ProcessEnv)
    expect(cfg.zidResolverBaseUrl).toBe('https://resolver.custom.com')
  })

  it('allows overriding WALLET_BE_URL and MBI_BASE_URL with a custom URL', () => {
    const cfg = loadConfig({
      ...base,
      WALLET_BE_URL: 'https://wallet-be.custom.com/',
      MBI_BASE_URL: 'https://mbi.custom.com/',
    } as NodeJS.ProcessEnv)
    expect(cfg.walletBeUrl).toBe('https://wallet-be.custom.com')
    expect(cfg.mbiBaseUrl).toBe('https://mbi.custom.com')
  })

  it('leaves oid4vpBaseUrl undefined when unset (the x401 SDK derives it from network)', () => {
    const cfg = loadConfig(base)
    expect(cfg.oid4vpBaseUrl).toBeUndefined()
  })

  it('allows overriding OID4VP_BASE_URL with a custom URL, stripping the trailing slash', () => {
    const cfg = loadConfig({ ...base, OID4VP_BASE_URL: 'https://verifier.custom.com/api/' } as NodeJS.ProcessEnv)
    expect(cfg.oid4vpBaseUrl).toBe('https://verifier.custom.com/api')
  })

  it('leaves zetrixAddress and holderDid undefined when unset (first-time user — see resolve-holder.ts)', () => {
    const cfg = loadConfig(base)
    expect(cfg.zetrixAddress).toBeUndefined()
    expect(cfg.holderDid).toBeUndefined()
  })

  it('throws naming the missing required var', () => {
    const { HSM_PASSWORD, ...withoutHsmPassword } = base
    expect(() => loadConfig(withoutHsmPassword as NodeJS.ProcessEnv)).toThrow(/HSM_PASSWORD/)
  })

  it('throws a hint that the MCP never generates a password on the user\'s behalf when HSM_PASSWORD is missing', () => {
    const { HSM_PASSWORD, ...withoutHsmPassword } = base
    expect(() => loadConfig(withoutHsmPassword as NodeJS.ProcessEnv)).toThrow(/never generates|never invents/i)
  })

  it('leaves maxPaymentAmount undefined when MAX_PAYMENT_AMOUNT is unset (no cap enforced)', () => {
    expect(loadConfig(base).maxPaymentAmount).toBeUndefined()
  })

  it('parses MAX_PAYMENT_AMOUNT into maxPaymentAmount', () => {
    const cfg = loadConfig({ ...base, MAX_PAYMENT_AMOUNT: '{"ZTX":"1000000000","*":"0"}' } as NodeJS.ProcessEnv)
    expect(cfg.maxPaymentAmount).toEqual({ ZTX: '1000000000', '*': '0' })
  })

  it('throws naming the problem when MAX_PAYMENT_AMOUNT is malformed', () => {
    expect(() => loadConfig({ ...base, MAX_PAYMENT_AMOUNT: 'not json' } as NodeJS.ProcessEnv)).toThrow(/MAX_PAYMENT_AMOUNT/)
  })
})
