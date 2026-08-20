import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, UNVERIFIED_MAINNET_SSIVC_BASE_URL } from '../config'

const base = {
  ZETRIX_NETWORK: 'zetrix:testnet',
  HSM_PASSWORD: 'pw123456',
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('reads required fields, strips trailing slashes, and derives testnet defaults', () => {
    const cfg = loadConfig(base)
    expect(cfg).toEqual({
      walletBeUrl: 'https://wallet-api-sandbox.zetrix.com/server',
      oid4vpBaseUrl: undefined,
      mbiBaseUrl: 'https://mbi-vc-sandbox.zetrix.com',
      network: 'zetrix:testnet',
      zetrixAddress: undefined,
      holderDid: undefined,
      hsmPassword: 'pw123456',
      nodeHost: 'test-node.zetrix.com',
      nodePort: '',
      templateRegistryAddress: 'ZTX3JszqPgRUx743SAp7q7zURfjvkWuH2FMEz',
      zidResolverBaseUrl: 'https://zid-resolver-sandbox.zetrix.com',
      maxPaymentAmount: { '*': '0' },
      stateDir: join(homedir(), '.agentic-wallet-mcp'),
      ssivcBaseUrl: 'https://ssivc-api-uat.myegdev.com/api',
      aiBirthcertVerifiedTemplateId: 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80',
    })
  })

  it('defaults stateDir to ~/.agentic-wallet-mcp', () => {
    expect(loadConfig(base).stateDir).toBe(join(homedir(), '.agentic-wallet-mcp'))
  })

  it('honors ZETRIX_WALLET_STATE_DIR and strips a trailing slash', () => {
    const cfg = loadConfig({ ...base, ZETRIX_WALLET_STATE_DIR: '/var/lib/zetrix-wallet/' } as NodeJS.ProcessEnv)
    expect(cfg.stateDir).toBe('/var/lib/zetrix-wallet')
  })

  it('derives the mainnet template-registry address and honors the override', () => {
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).templateRegistryAddress).toBe(
      'ZTX3GqJM1U6ifMPonwD4fGvrgoTKJua7b2cKX',
    )
    expect(
      loadConfig({ ...base, ZETRIX_TEMPLATE_REGISTRY_ADDRESS: 'ZTX3Custom' } as NodeJS.ProcessEnv).templateRegistryAddress,
    ).toBe('ZTX3Custom')
  })

  it('leaves the mainnet Verified AI Birthcert templateId undefined (unverified, APP-M04) unless explicitly overridden', () => {
    // The mainnet id was never confirmed on-chain (a read at the registry address returned null) —
    // auto-deriving it anyway would let a mainnet credential get cached under a possibly-wrong key
    // that prove_identity might never find. Fail closed instead: require an explicit override.
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).aiBirthcertVerifiedTemplateId).toBeUndefined()
    expect(
      loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', AI_BIRTHCERT_VERIFIED_TEMPLATE_ID: 'did:zid:custom' } as NodeJS.ProcessEnv)
        .aiBirthcertVerifiedTemplateId,
    ).toBe('did:zid:custom')
  })

  it('still auto-derives the testnet Verified AI Birthcert templateId (confirmed on-chain)', () => {
    expect(loadConfig(base).aiBirthcertVerifiedTemplateId).toBe(
      'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80',
    )
    expect(
      loadConfig({ ...base, AI_BIRTHCERT_VERIFIED_TEMPLATE_ID: 'did:zid:custom' } as NodeJS.ProcessEnv).aiBirthcertVerifiedTemplateId,
    ).toBe('did:zid:custom')
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

  it('auto-derives the testnet SSIVC base URL, and honors an SSIVC_BASE_URL override (stripping a trailing slash)', () => {
    expect(loadConfig(base).ssivcBaseUrl).toBe('https://ssivc-api-uat.myegdev.com/api')
    const cfg = loadConfig({ ...base, SSIVC_BASE_URL: 'https://ssivc-custom.example.com/api/' } as NodeJS.ProcessEnv)
    expect(cfg.ssivcBaseUrl).toBe('https://ssivc-custom.example.com/api')
  })

  it('leaves the mainnet SSIVC base URL undefined (unverified, APP-M04) unless explicitly overridden', () => {
    // Only the testnet host was ever actually reached and confirmed; the mainnet URL was an
    // assumption by analogy, never tested live. Fail closed rather than wire the whole AI
    // Birthcert verification feature against an unconfirmed mainnet endpoint.
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).ssivcBaseUrl).toBeUndefined()
    const overridden = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', SSIVC_BASE_URL: 'https://ssivc.example.com/api' } as NodeJS.ProcessEnv)
    expect(overridden.ssivcBaseUrl).toBe('https://ssivc.example.com/api')
  })

  it('keeps the known-but-unverified mainnet SSIVC host as a documented constant, not wired into loadConfig', () => {
    // The URL is worth keeping on hand so enabling it later (once confirmed reachable) is a
    // one-line change in deriveSsivcBaseUrl rather than someone having to rediscover it — but it
    // must not be what a mainnet wallet actually gets by default; SSIVC_BASE_URL is the opt-in.
    expect(UNVERIFIED_MAINNET_SSIVC_BASE_URL).toBe('https://verifyid-api.zetrix.com/api')
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).ssivcBaseUrl).not.toBe(
      UNVERIFIED_MAINNET_SSIVC_BASE_URL,
    )
  })

  it('SSIVC_ISSUANCE_TOKEN, if set, has no effect (the session API needs no bearer token)', () => {
    const cfg = loadConfig({ ...base, SSIVC_ISSUANCE_TOKEN: 'tok-abc' } as NodeJS.ProcessEnv)
    expect(cfg).not.toHaveProperty('ssivcIssuanceToken')
  })

  it('leaves zetrixAddress and holderDid undefined when unset (first-time user — see resolve-holder.ts)', () => {
    const cfg = loadConfig(base)
    expect(cfg.zetrixAddress).toBeUndefined()
    expect(cfg.holderDid).toBeUndefined()
  })

  it('defaults network to zetrix:testnet when ZETRIX_NETWORK is unset', () => {
    const { ZETRIX_NETWORK, ...withoutNetwork } = base
    const cfg = loadConfig(withoutNetwork as NodeJS.ProcessEnv)
    expect(cfg.network).toBe('zetrix:testnet')
    expect(cfg.walletBeUrl).toBe('https://wallet-api-sandbox.zetrix.com/server')
  })

  it('honors an explicit mainnet network over the testnet default', () => {
    const { ZETRIX_NETWORK, ...withoutNetwork } = base
    const cfg = loadConfig({ ...withoutNetwork, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv)
    expect(cfg.network).toBe('zetrix:mainnet')
  })

  it('throws naming the missing required var', () => {
    const { HSM_PASSWORD, ...withoutHsmPassword } = base
    expect(() => loadConfig(withoutHsmPassword as NodeJS.ProcessEnv)).toThrow(/HSM_PASSWORD/)
  })

  it('throws a hint pointing at main() when loadConfig is called directly without a password', () => {
    const { HSM_PASSWORD, ...withoutHsmPassword } = base
    expect(() => loadConfig(withoutHsmPassword as NodeJS.ProcessEnv)).toThrow(/generates a password when none exists/)
  })

  it('defaults maxPaymentAmount to a zero cap when MAX_PAYMENT_AMOUNT is unset — fail closed', () => {
    expect(loadConfig(base).maxPaymentAmount).toEqual({ '*': '0' })
  })

  it('still honors an explicit MAX_PAYMENT_AMOUNT over the zero default', () => {
    const cfg = loadConfig({ ...base, MAX_PAYMENT_AMOUNT: '{"ZTX":"500"}' } as NodeJS.ProcessEnv)
    expect(cfg.maxPaymentAmount).toEqual({ ZTX: '500' })
  })

  it('parses MAX_PAYMENT_AMOUNT into maxPaymentAmount', () => {
    const cfg = loadConfig({ ...base, MAX_PAYMENT_AMOUNT: '{"ZTX":"1000000000","*":"0"}' } as NodeJS.ProcessEnv)
    expect(cfg.maxPaymentAmount).toEqual({ ZTX: '1000000000', '*': '0' })
  })

  it('throws naming the problem when MAX_PAYMENT_AMOUNT is malformed', () => {
    expect(() => loadConfig({ ...base, MAX_PAYMENT_AMOUNT: 'not json' } as NodeJS.ProcessEnv)).toThrow(/MAX_PAYMENT_AMOUNT/)
  })
})

import { resolveTokenAddress } from '../config'

describe('resolveTokenAddress', () => {
  it('resolves JMYR to its testnet contract address', () => {
    expect(resolveTokenAddress('JMYR', 'zetrix:testnet')).toBe('ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b')
  })

  it('resolves JMYR to its mainnet contract address', () => {
    expect(resolveTokenAddress('JMYR', 'zetrix:mainnet')).toBe('ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr')
  })

  it('is case-insensitive on the symbol', () => {
    expect(resolveTokenAddress('jmyr', 'zetrix:testnet')).toBe('ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b')
  })

  it('returns undefined for an unknown symbol', () => {
    expect(resolveTokenAddress('DOGE', 'zetrix:testnet')).toBeUndefined()
  })
})
