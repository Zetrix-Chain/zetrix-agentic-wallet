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
      // Testnet default: exactly the AI Birthcert fee, nothing else. See the network-scoped block below.
      maxPaymentAmount: { ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b: '1000000', '*': '0' },
      credentialIssuanceCaps: { ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b: '1000000', '*': '0' },
      stateDir: join(homedir(), '.agentic-wallet-mcp'),
      ssivcBaseUrl: 'https://ssivc-api-uat.myegdev.com/api',
      aiBirthcertVerifiedTemplateId: 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80',
      gasPreference: 'sponsored',
      maxSettlementAttempts: 20,
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

  // Out of the box the cap refused everything, so the very first credential attempt failed on a
  // limit nobody had been told about. Credential ISSUANCE now allows exactly that fee on both
  // networks — the requirement's own words are "so user can apply the first VC without any issue".
  //
  // The general cap is deliberately NOT widened with it. It governs pay_and_fetch, which auto-pays
  // whatever an arbitrary URL demands, so a permissive mainnet default there would hand a
  // prompt-injected agent real money — the confused-deputy case payment-guard.ts exists to close.
  describe('the default spending cap is network-scoped', () => {
    const JMYR_TESTNET = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
    const JMYR_MAINNET = 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr'
    const cfgFor = (net: string) => loadConfig({ ...base, ZETRIX_NETWORK: net } as NodeJS.ProcessEnv)

    it('allows exactly the 1 JMYR credential fee on testnet, and nothing else', () => {
      expect(cfgFor('zetrix:testnet').maxPaymentAmount).toEqual({ [JMYR_TESTNET]: '1000000', '*': '0' })
    })

    it('allows exactly the 1 JMYR credential fee for ISSUANCE on mainnet too', () => {
      expect(cfgFor('zetrix:mainnet').credentialIssuanceCaps).toEqual({ [JMYR_MAINNET]: '1000000', '*': '0' })
    })

    it('keeps the GENERAL mainnet cap refuse-all, so pay_and_fetch cannot auto-pay an arbitrary url', () => {
      expect(cfgFor('zetrix:mainnet').maxPaymentAmount).toEqual({ '*': '0' })
    })

    // The two networks use different JMYR contracts, so a cap keyed to the wrong one would silently
    // fall through to "*": "0" and refuse the very fee it was meant to permit.
    it('keys the mainnet issuance default to the MAINNET JMYR address, never the testnet one', () => {
      const keys = Object.keys(cfgFor('zetrix:mainnet').credentialIssuanceCaps)
      expect(keys).not.toContain(JMYR_TESTNET)
      expect(keys).toContain(JMYR_MAINNET)
    })

    it('lets an explicit MAX_PAYMENT_AMOUNT govern BOTH caps — a configured limit means it everywhere', () => {
      const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', MAX_PAYMENT_AMOUNT: '{"ZTX":"500"}' } as NodeJS.ProcessEnv)
      expect(cfg.maxPaymentAmount).toEqual({ ZTX: '500' })
      expect(cfg.credentialIssuanceCaps).toEqual({ ZTX: '500' })
    })
  })

  // Every per-network derivation here asks includes('testnet') and treats anything else as mainnet,
  // so an unrecognised value resolved to MAINNET addresses. Once mainnet carries a credential
  // allowance, that means a typo would silently be granted real spending power.
  describe('ZETRIX_NETWORK is validated, not guessed', () => {
    for (const bad of ['zetrix:tesnet', 'ZETRIX:TESTNET', 'mainnet', 'staging', 'zetrix:testnet-2']) {
      it(`rejects ${JSON.stringify(bad)} at startup rather than resolving it to mainnet`, () => {
        expect(() => loadConfig({ ...base, ZETRIX_NETWORK: bad } as NodeJS.ProcessEnv)).toThrow(/unrecognised ZETRIX_NETWORK/)
      })
    }

    it('still accepts the two known networks', () => {
      expect(() => loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:testnet' } as NodeJS.ProcessEnv)).not.toThrow()
      expect(() => loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv)).not.toThrow()
    })
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

describe('sponsored gas config', () => {
  it('defaults gasPreference to sponsored', () => {
    expect(loadConfig(base).gasPreference).toBe('sponsored')
  })

  it('honours an explicit self-pay preference', () => {
    expect(loadConfig({ ...base, GAS_PREFERENCE: 'self' } as NodeJS.ProcessEnv).gasPreference).toBe('self')
  })

  it('falls back to sponsored for an unrecognised value rather than throwing', () => {
    expect(loadConfig({ ...base, GAS_PREFERENCE: 'banana' } as NodeJS.ProcessEnv).gasPreference).toBe('sponsored')
    expect(loadConfig({ ...base, GAS_PREFERENCE: '' } as NodeJS.ProcessEnv).gasPreference).toBe('sponsored')
  })

  it('defaults maxSettlementAttempts to 20 and accepts an override', () => {
    expect(loadConfig(base).maxSettlementAttempts).toBe(20)
    expect(loadConfig({ ...base, MAX_SETTLEMENT_ATTEMPTS: '5' } as NodeJS.ProcessEnv).maxSettlementAttempts).toBe(5)
  })

  it('ignores a non-positive or unparseable override', () => {
    expect(loadConfig({ ...base, MAX_SETTLEMENT_ATTEMPTS: '0' } as NodeJS.ProcessEnv).maxSettlementAttempts).toBe(20)
    expect(loadConfig({ ...base, MAX_SETTLEMENT_ATTEMPTS: 'abc' } as NodeJS.ProcessEnv).maxSettlementAttempts).toBe(20)
  })
})
