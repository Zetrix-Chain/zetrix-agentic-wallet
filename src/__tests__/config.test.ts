import { describe, it, expect, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  loadConfig,
  MAINNET_SSIVC_BASE_URL,
  MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID,
  derivePolicyRegistryAddress,
  derivePolicyTemplateAddress,
  derivePolicyWriteUrl,
  derivePolicyCapBypass,
  deriveBindPresentation,
} from '../config'

const base = {
  ZETRIX_NETWORK: 'zetrix:testnet',
  HSM_PASSWORD: 'pw123456',
} as NodeJS.ProcessEnv

// The SDK uses plain http unless told otherwise, and the mainnet node refuses a POSTed contract call over http ("request must be
// in json format"), so every host is reached over https except a loopback one. The SDK builds its URL from the scheme and host only
// and ignores a separate port, so the decision is made on the host (a local node is ZETRIX_NODE_HOST=localhost:19333).
describe('node connection scheme', () => {
  const warn = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  it('is https for the public hosts on both networks', () => {
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:testnet' }).nodeSecure).toBe(true)
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' }).nodeSecure).toBe(true)
  })

  it('a public host stays https whatever ZETRIX_NODE_PORT says, because the SDK ignores the port', () => {
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', ZETRIX_NODE_PORT: '19333' }).nodeSecure).toBe(true)
    expect(loadConfig({ ...base, ZETRIX_NODE_HOST: 'node.zetrix.com:443' }).nodeSecure).toBe(true)
  })

  it.each(['localhost', 'localhost:19333', '127.0.0.1', '127.0.0.1:19333', '[::1]', '[::1]:19333', 'LOCALHOST:19333'])(
    'a loopback host keeps plain http: %s',
    (host) => {
      const w = warn()
      expect(loadConfig({ ...base, ZETRIX_NODE_HOST: host }).nodeSecure).toBe(false)
      expect(w).not.toHaveBeenCalled()
      w.mockRestore()
    },
  )

  it('a host that only looks like localhost is not loopback', () => {
    expect(loadConfig({ ...base, ZETRIX_NODE_HOST: 'localhost.evil.test:19333' }).nodeSecure).toBe(true)
    expect(loadConfig({ ...base, ZETRIX_NODE_HOST: '127.0.0.1.evil.test' }).nodeSecure).toBe(true)
  })

  it('ZETRIX_NODE_SECURE overrides either default', () => {
    const w = warn()
    expect(loadConfig({ ...base, ZETRIX_NODE_HOST: 'localhost:19333', ZETRIX_NODE_SECURE: 'TRUE' }).nodeSecure).toBe(true)
    expect(loadConfig({ ...base, ZETRIX_NODE_HOST: 'node.internal.test:19333', ZETRIX_NODE_SECURE: 'false' }).nodeSecure).toBe(false)
    w.mockRestore()
  })

  it('warns when plain http is sent to a node that is not on this machine, and says why', () => {
    const w = warn()
    loadConfig({ ...base, ZETRIX_NODE_HOST: 'node.internal.test:19333', ZETRIX_NODE_SECURE: 'false' })
    const text = w.mock.calls.map((c) => String(c[0])).join('')
    expect(text).toMatch(/node\.internal\.test:19333 is reached over plain http/)
    expect(text).toMatch(/public Zetrix nodes refuse a contract query over http/)
    w.mockRestore()
  })

  it('warns about a ZETRIX_NODE_SECURE value it does not recognise, and ignores it', () => {
    const w = warn()
    expect(loadConfig({ ...base, ZETRIX_NODE_SECURE: 'maybe' }).nodeSecure).toBe(true)
    expect(w.mock.calls.map((c) => String(c[0])).join('')).toMatch(/ZETRIX_NODE_SECURE must be true or false, so "maybe" is ignored/)
    w.mockRestore()
  })
})

describe('POLICY_WRITE_URL', () => {
  // The owner's HSM password rides in the body of the paid-write calls, so an override has to be https
  // (plain http only for a loopback host). A rejected override is a warning and no URL, never the default.
  const warn = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  it('accepts an https override and strips the trailing slash', () => {
    const w = warn()
    expect(loadConfig({ ...base, POLICY_WRITE_URL: 'https://policy.example.test/api/' }).policyWriteUrl).toBe('https://policy.example.test/api')
    expect(w).not.toHaveBeenCalled()
    w.mockRestore()
  })

  it.each(['http://localhost:8080/api', 'http://127.0.0.1:3000', 'http://[::1]:3000/api'])('accepts plain http for a loopback host: %s', (url) => {
    const w = warn()
    expect(loadConfig({ ...base, POLICY_WRITE_URL: url }).policyWriteUrl).toBe(url)
    expect(w).not.toHaveBeenCalled()
    w.mockRestore()
  })

  it.each(['http://policy.example.test/api', 'http://localhost.evil.test/api', 'ftp://policy.example.test', 'not a url'])(
    'ignores %s with a warning, and does not fall back to the default',
    (url) => {
      const w = warn()
      expect(loadConfig({ ...base, POLICY_WRITE_URL: url }).policyWriteUrl).toBeUndefined()
      const text = w.mock.calls.map((c) => String(c[0])).join('')
      expect(text).toMatch(/POLICY_WRITE_URL/)
      expect(text).toMatch(/policy write tools are unavailable/)
      w.mockRestore()
    },
  )

  it('leaves the built-in default alone when nothing is set', () => {
    expect(loadConfig(base).policyWriteUrl).toBe('https://public-api-sandbox.zetrix.com/api')
  })
})

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
      nodeSecure: true,
      // On for testnet and mainnet, where Wallet BE enforces policies; off elsewhere (see derivePolicyCapBypass).
      policyCapBypass: true,
      bindPresentation: true,
      templateRegistryAddress: 'ZTX3JszqPgRUx743SAp7q7zURfjvkWuH2FMEz',
      zidResolverBaseUrl: 'https://zid-resolver-sandbox.zetrix.com',
      policyRegistryAddress: 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk',
      policyTemplateAddress: 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5',
      myidVerifyLinkTemplate: 'https://ssivc-api-uat.myegdev2.com/api/agentic-verify?referenceId={referenceId}',
      // Derived like the other policy addresses; undefined on mainnet, where there is no policy
      // system to have a publisher for (see derivePolicyTemplatePublisher).
      policyTemplatePublisher: 'ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED',
      // Derived like every other service URL; undefined on mainnet, where the policy module
      // is not enabled at all (see derivePolicyWriteUrl).
      policyWriteUrl: 'https://public-api-sandbox.zetrix.com/api',
      // Testnet default: exactly the AI Birthcert fee, nothing else. See the network-scoped block below.
      maxPaymentAmount: { ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b: '1000000', '*': '0' },
      credentialIssuanceCaps: { ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b: '1000000', '*': '0' },
      paymentCapsExplicit: false,
      stateDir: join(homedir(), '.agentic-wallet-mcp'),
      ssivcBaseUrl: 'https://ssivc-api-uat.myegdev2.com/api',
      aiBirthcertVerifiedTemplateId: 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80',
      gasPreference: 'sponsored',
      maxSettlementAttempts: 20,
      settlementWaitBudgetMs: 90_000,
      settlementStuckAfterMs: 86_400_000,
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

  it('defaults the mainnet Verified AI Birthcert templateId to the one read from the mainnet registry, and honours an override', () => {
    // Read from the mainnet template registry (ZTX3GqJM1U6ifMPonwD4fGvrgoTKJua7b2cKX) on 2026-10-22.
    expect(MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID).toBe('did:zid:2d8f9476809fe20de103c43438f738a122ef53665e0b615b7414bdf1f1b19b52')
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).aiBirthcertVerifiedTemplateId).toBe(
      MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID,
    )
    expect(loadConfig(base).aiBirthcertVerifiedTemplateId).toBe('did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80')
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
    expect(loadConfig(base).ssivcBaseUrl).toBe('https://ssivc-api-uat.myegdev2.com/api')
    const cfg = loadConfig({ ...base, SSIVC_BASE_URL: 'https://ssivc-custom.example.com/api/' } as NodeJS.ProcessEnv)
    expect(cfg.ssivcBaseUrl).toBe('https://ssivc-custom.example.com/api')
  })

  it('defaults the mainnet SSIVC base URL to the production host, and honours an override', () => {
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).ssivcBaseUrl).toBe('https://verifyid-api.zetrix.com/api')
    const overridden = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', SSIVC_BASE_URL: 'https://ssivc.example.com/api' } as NodeJS.ProcessEnv)
    expect(overridden.ssivcBaseUrl).toBe('https://ssivc.example.com/api')
  })

  it('falls back to the default when SSIVC_BASE_URL or the template id is blank, on mainnet', () => {
    const mainnet = { ...base, ZETRIX_NETWORK: 'zetrix:mainnet', SSIVC_BASE_URL: '   ', AI_BIRTHCERT_VERIFIED_TEMPLATE_ID: '   ' } as NodeJS.ProcessEnv
    const cfg = loadConfig(mainnet)
    expect(cfg.ssivcBaseUrl).toBe(MAINNET_SSIVC_BASE_URL)
    expect(cfg.aiBirthcertVerifiedTemplateId).toBe(MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID)
  })

  it('has everything the Verified flow needs on mainnet with no setting at all', () => {
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv)
    // index.ts wires verifyAiBirthcert exactly when ssivcBaseUrl is set, and create_verification_qr needs the link.
    expect(cfg.ssivcBaseUrl).toBeTruthy()
    expect(cfg.aiBirthcertVerifiedTemplateId).toBeTruthy()
    expect(cfg.myidVerifyLinkTemplate).toBeTruthy()
  })

  it('pins the mainnet SSIVC host, and the testnet default does not change', () => {
    expect(MAINNET_SSIVC_BASE_URL).toBe('https://verifyid-api.zetrix.com/api')
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).ssivcBaseUrl).toBe(MAINNET_SSIVC_BASE_URL)
    expect(loadConfig(base).ssivcBaseUrl).toBe('https://ssivc-api-uat.myegdev2.com/api')
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

    // mainnet's GENERAL default is no longer refuse-all. It was, deliberately, so that
    // pay_and_fetch could not auto-pay an arbitrary URL on a wallet nobody had configured; now it can, up to 1 JMYR per call.
    it('gives mainnet the same GENERAL default as testnet: 1 JMYR per call, everything else refused', () => {
      expect(cfgFor('zetrix:mainnet').maxPaymentAmount).toEqual({ [JMYR_MAINNET]: '1000000', '*': '0' })
    })

    it('records whether the caps were set by the user, because an explicit cap is never bypassed by a policy', () => {
      expect(cfgFor('zetrix:mainnet').paymentCapsExplicit).toBe(false)
      const explicit = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', MAX_PAYMENT_AMOUNT: '{"*":"0"}' } as NodeJS.ProcessEnv)
      expect(explicit.paymentCapsExplicit).toBe(true)
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

  // The attempt cap alone cannot bound the wait, because the per-attempt delay is
  // server-supplied. Operators need the same env-var lever over the wall-clock budget.
  it('defaults settlementWaitBudgetMs to 90s and accepts an override', () => {
    expect(loadConfig(base).settlementWaitBudgetMs).toBe(90_000)
    expect(
      loadConfig({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '30000' } as NodeJS.ProcessEnv).settlementWaitBudgetMs,
    ).toBe(30_000)
  })

  // Decides only which of two true statements a user is told about an unconfirmed
  // settlement, so unlike the wait budget it is neither clamped nor warned about.
  it('defaults settlementStuckAfterMs to 24h and accepts an override', () => {
    expect(loadConfig(base).settlementStuckAfterMs).toBe(86_400_000)
    expect(
      loadConfig({ ...base, SETTLEMENT_STUCK_AFTER_MS: '3600000' } as NodeJS.ProcessEnv).settlementStuckAfterMs,
    ).toBe(3_600_000)
  })

  it('ignores a non-positive or unparseable stuck threshold', () => {
    expect(loadConfig({ ...base, SETTLEMENT_STUCK_AFTER_MS: '0' } as NodeJS.ProcessEnv).settlementStuckAfterMs).toBe(86_400_000)
    expect(loadConfig({ ...base, SETTLEMENT_STUCK_AFTER_MS: 'soon' } as NodeJS.ProcessEnv).settlementStuckAfterMs).toBe(86_400_000)
  })

  it('ignores a non-positive or unparseable settlement wait budget', () => {
    expect(loadConfig({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '0' } as NodeJS.ProcessEnv).settlementWaitBudgetMs).toBe(90_000)
    expect(loadConfig({ ...base, SETTLEMENT_WAIT_BUDGET_MS: 'abc' } as NodeJS.ProcessEnv).settlementWaitBudgetMs).toBe(90_000)
  })

  // R2-L05. APP-L02 deliberately does NOT clamp the budget — it warns instead, so the warning is
  // the entire safety mechanism for an oversized value and cannot be left untested.
  describe('an oversized settlement wait budget warns on stderr rather than being clamped', () => {
    function loadCapturingStderr(env: NodeJS.ProcessEnv): { budget: number; stderr: string } {
      const writes: string[] = []
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk))
        return true
      })
      try {
        return { budget: loadConfig(env).settlementWaitBudgetMs, stderr: writes.join('') }
      } finally {
        spy.mockRestore()
      }
    }

    it('warns above ~10 minutes, and still honours the value', () => {
      const { budget, stderr } = loadCapturingStderr({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '900000' } as NodeJS.ProcessEnv)

      expect(budget).toBe(900_000)
      expect(stderr).toContain('SETTLEMENT_WAIT_BUDGET_MS is 900000ms')
    })

    // APP-L03: check_ blocks on the same budget, so a warning that names only request_ understates
    // the effect an operator is being warned about.
    it('names both tools the budget can block', () => {
      const { stderr } = loadCapturingStderr({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '900000' } as NodeJS.ProcessEnv)

      expect(stderr).toContain('request_ai_birthcert_verification')
      expect(stderr).toContain('check_ai_birthcert_verification')
      expect(stderr.endsWith('\n')).toBe(true)
    })

    it('stays silent at the default, and at the threshold itself', () => {
      expect(loadCapturingStderr(base).stderr).toBe('')
      expect(
        loadCapturingStderr({ ...base, SETTLEMENT_WAIT_BUDGET_MS: '600000' } as NodeJS.ProcessEnv).stderr,
      ).toBe('')
    })
  })
})

describe('policy contract addresses', () => {
  it('returns the verified staging addresses on testnet', () => {
    expect(derivePolicyRegistryAddress('zetrix:testnet')).toBe('ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk')
    expect(derivePolicyTemplateAddress('zetrix:testnet')).toBe('ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5')
  })

  it('returns the deployed mainnet contracts, read back from chain', () => {
    expect(derivePolicyRegistryAddress('zetrix:mainnet')).toBe('ZTX3brJxpLuzHSbcNNLi2XrgWsQQQ2EHFZVWQ')
    expect(derivePolicyTemplateAddress('zetrix:mainnet')).toBe('ZTX3P7CKSvPAX33GNJCbDeLz1dGoyjKw4ZAy3')
    const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv)
    expect(cfg.policyRegistryAddress).toBe('ZTX3brJxpLuzHSbcNNLi2XrgWsQQQ2EHFZVWQ')
    expect(cfg.policyTemplateAddress).toBe('ZTX3P7CKSvPAX33GNJCbDeLz1dGoyjKw4ZAy3')
  })

  it('has none on any other network, and the mainnet ones are different from testnet', () => {
    // APP-M04: a guessed address would make every read fail as "you have no policy" rather
    // than "this network has no policy system at all".
    for (const network of ['zetrix:devnet', 'zetrix:local', '']) {
      expect(derivePolicyRegistryAddress(network)).toBeUndefined()
      expect(derivePolicyTemplateAddress(network)).toBeUndefined()
    }
    expect(derivePolicyRegistryAddress('zetrix:mainnet')).not.toBe(derivePolicyRegistryAddress('zetrix:testnet'))
    expect(derivePolicyTemplateAddress('zetrix:mainnet')).not.toBe(derivePolicyTemplateAddress('zetrix:testnet'))
  })

  it('the policy write URL is the sandbox proxy on testnet, the production proxy on mainnet, and none elsewhere', () => {
    expect(derivePolicyWriteUrl('zetrix:testnet')).toBe('https://public-api-sandbox.zetrix.com/api')
    expect(derivePolicyWriteUrl('zetrix:mainnet')).toBe('https://public-api.zetrix.com/api')
    for (const network of ['zetrix:devnet', 'zetrix:local', '']) expect(derivePolicyWriteUrl(network)).toBeUndefined()
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).policyWriteUrl).toBe('https://public-api.zetrix.com/api')
    // An override wins.
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', POLICY_WRITE_URL: 'https://other.test/api/' } as NodeJS.ProcessEnv).policyWriteUrl).toBe('https://other.test/api')
  })

  it('a rejected (non-https) override leaves no URL and does not fall back to the default, on either network', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    for (const network of ['zetrix:testnet', 'zetrix:mainnet']) {
      expect(loadConfig({ ...base, ZETRIX_NETWORK: network, POLICY_WRITE_URL: 'http://policy.example.test/api' } as NodeJS.ProcessEnv).policyWriteUrl).toBeUndefined()
    }
    w.mockRestore()
  })

  // A policy that governs an asset stands the default per-call cap aside, and the wallet never compares a payment with the policy's
  // own limit (Wallet BE does), so the bypass is on for testnet and mainnet and off elsewhere, and POLICY_CAP_BYPASS overrides it
  // either way. A value it does not understand turns it OFF (fails closed), whatever the network.
  it('the policy cap bypass is on for testnet and mainnet, off for everything else, and POLICY_CAP_BYPASS overrides', () => {
    expect(derivePolicyCapBypass('zetrix:testnet', undefined)).toBe(true)
    expect(derivePolicyCapBypass('zetrix:mainnet', undefined)).toBe(true)
    for (const network of ['zetrix:devnet', 'zetrix:local', '']) expect(derivePolicyCapBypass(network, undefined)).toBe(false)
    expect(derivePolicyCapBypass('zetrix:mainnet', 'false')).toBe(false)
    expect(derivePolicyCapBypass('zetrix:mainnet', ' FALSE ')).toBe(false)
    expect(derivePolicyCapBypass('zetrix:testnet', 'false')).toBe(false)
    expect(derivePolicyCapBypass('zetrix:devnet', 'true')).toBe(true)
    for (const off of ['0', 'no', 'No', ' false ']) expect(derivePolicyCapBypass('zetrix:mainnet', off)).toBe(false)
    for (const on of ['1', 'yes', 'TRUE', ' true ']) expect(derivePolicyCapBypass('zetrix:mainnet', on)).toBe(true)
    expect(derivePolicyCapBypass('zetrix:devnet', 'maybe')).toBe(false)
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv).policyCapBypass).toBe(true)
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', POLICY_CAP_BYPASS: 'false' } as NodeJS.ProcessEnv).policyCapBypass).toBe(false)
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:testnet' } as NodeJS.ProcessEnv).policyCapBypass).toBe(true)
  })

  // An operator who tries to turn it off and mistypes must not end up with it ON.
  it('a POLICY_CAP_BYPASS value that is not true or false turns the bypass OFF, on every network', () => {
    for (const network of ['zetrix:mainnet', 'zetrix:testnet', 'zetrix:devnet']) {
      for (const typo of ['off', 'flase', 'disabled', 'n', 'maybe', 'null', '2', 'false.']) {
        expect(derivePolicyCapBypass(network, typo), `${network} ${typo}`).toBe(false)
      }
    }
  })

  it('says so on stderr when POLICY_CAP_BYPASS is not true or false, and turns the bypass off', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const cfg = loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', POLICY_CAP_BYPASS: 'off' } as NodeJS.ProcessEnv)
      expect(cfg.policyCapBypass).toBe(false)
      const written = w.mock.calls.map((c) => String(c[0])).join('')
      expect(written).toContain('POLICY_CAP_BYPASS must be true or false')
      expect(written).toContain('"off" is treated as false')
    } finally {
      w.mockRestore()
    }
  })

  it('stays quiet for a recognised value, and a blank value is the same as not setting it', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      for (const v of ['true', 'false', '0', '1', 'yes', 'no']) {
        loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', POLICY_CAP_BYPASS: v } as NodeJS.ProcessEnv)
      }
      expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', POLICY_CAP_BYPASS: '  ' } as NodeJS.ProcessEnv).policyCapBypass).toBe(true)
      expect(w.mock.calls.map((c) => String(c[0])).join('')).not.toContain('POLICY_CAP_BYPASS')
    } finally {
      w.mockRestore()
    }
  })

  it('an override still wins on mainnet', () => {
    const cfg = loadConfig({
      ...base,
      ZETRIX_NETWORK: 'zetrix:mainnet',
      POLICY_REGISTRY_ADDRESS: 'ZTX3OverrideRegistry',
      POLICY_TEMPLATE_ADDRESS: 'ZTX3OverrideTemplate',
    } as NodeJS.ProcessEnv)
    expect(cfg.policyRegistryAddress).toBe('ZTX3OverrideRegistry')
    expect(cfg.policyTemplateAddress).toBe('ZTX3OverrideTemplate')
  })

  it('lets an explicit override reach a local deployment on any network', () => {
    const cfg = loadConfig({
      ...base,
      POLICY_REGISTRY_ADDRESS: 'ZTX3local',
      POLICY_TEMPLATE_ADDRESS: 'ZTX3localTemplate',
    } as NodeJS.ProcessEnv)
    expect(cfg.policyRegistryAddress).toBe('ZTX3local')
    expect(cfg.policyTemplateAddress).toBe('ZTX3localTemplate')
  })
})

describe('MYID_VERIFY_LINK_TEMPLATE', () => {
  // UAT's link is the one the MyID app is registered for: ssivc-api-uat.myegdev2.com publishes an apple-app-site-association that
  // claims exactly /api/agentic-verify with a referenceId query. The first link the wallet was given, /v1/agent-verification/{id},
  // matched none of it: the phone opened the browser and the server answered 404.
  const UAT_LINK = 'https://ssivc-api-uat.myegdev2.com/api/agentic-verify?referenceId={referenceId}'

  it('defaults to the UAT universal link on testnet, so nobody has to set it', () => {
    expect(loadConfig(base).myidVerifyLinkTemplate).toBe(UAT_LINK)
  })

  // PRODUCTION: MyID's verifier host, which MyID says is ready. It is the mainnet default, so nobody has to set it.
  const PROD_LINK = 'https://myid-verifier.zetrix.com/agentic-verify?referenceId={referenceId}'

  it('defaults to the MyID production link on mainnet', () => {
    const mainnet = { ...base, ZETRIX_NETWORK: 'zetrix:mainnet' } as NodeJS.ProcessEnv

    expect(loadConfig(mainnet).myidVerifyLinkTemplate).toBe(PROD_LINK)
  })

  it('pins the production link, and it is a link the wallet itself accepts', async () => {
    const { MAINNET_MYID_VERIFY_LINK_TEMPLATE } = await import('../config')
    const { checkVerifyLinkTemplate } = await import('../verify-link-template')

    expect(MAINNET_MYID_VERIFY_LINK_TEMPLATE).toBe(PROD_LINK)
    expect(checkVerifyLinkTemplate(MAINNET_MYID_VERIFY_LINK_TEMPLATE)).toBeNull()
  })

  it('is overridden by MYID_VERIFY_LINK_TEMPLATE, on either network', () => {
    const own = 'https://link.myid.test/v?referenceId={referenceId}'

    expect(loadConfig({ ...base, MYID_VERIFY_LINK_TEMPLATE: own } as NodeJS.ProcessEnv).myidVerifyLinkTemplate).toBe(own)
    expect(loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', MYID_VERIFY_LINK_TEMPLATE: own } as NodeJS.ProcessEnv).myidVerifyLinkTemplate).toBe(own)
  })

  it('falls back when the variable is blank: to the UAT link on testnet, to the production link on mainnet', () => {
    expect(loadConfig({ ...base, MYID_VERIFY_LINK_TEMPLATE: '   ' } as NodeJS.ProcessEnv).myidVerifyLinkTemplate).toBe(UAT_LINK)
    expect(
      loadConfig({ ...base, ZETRIX_NETWORK: 'zetrix:mainnet', MYID_VERIFY_LINK_TEMPLATE: '   ' } as NodeJS.ProcessEnv).myidVerifyLinkTemplate,
    ).toBe(PROD_LINK)
  })

  it('builds a default link the wallet itself accepts', async () => {
    const { checkVerifyLinkTemplate } = await import('../verify-link-template')

    expect(checkVerifyLinkTemplate(loadConfig(base).myidVerifyLinkTemplate as string)).toBeNull()
  })

  it('puts the reference id where the MyID app is registered to read it: the referenceId query of /api/agentic-verify', async () => {
    const { buildVerificationLink } = await import('../orchestrator/verification-qr')
    const link = buildVerificationLink(loadConfig(base).myidVerifyLinkTemplate, 'v2-e61eab66-45e2-4716-a7a2-37798be7ebf4')
    const url = new URL(link)

    expect(url.origin).toBe('https://ssivc-api-uat.myegdev2.com')
    expect(url.pathname).toBe('/api/agentic-verify')
    expect(url.searchParams.get('referenceId')).toBe('v2-e61eab66-45e2-4716-a7a2-37798be7ebf4')
  })

  it('is read as given, trimmed, and not altered (the placeholder and query must survive)', () => {
    const cfg = loadConfig({ ...base, MYID_VERIFY_LINK_TEMPLATE: '  https://link.myid.test/agentic-verify?referenceId={referenceId}  ' })
    expect(cfg.myidVerifyLinkTemplate).toBe('https://link.myid.test/agentic-verify?referenceId={referenceId}')
  })

  describe('is checked when the config loads', () => {
    function loadCapturingStderr(env: NodeJS.ProcessEnv): { stderr: string } {
      const writes: string[] = []
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk))
        return true
      })
      try {
        loadConfig(env)
        return { stderr: writes.join('') }
      } finally {
        spy.mockRestore()
      }
    }

    it.each([
      ['http', 'http://link.myid.test/v?referenceId={referenceId}'],
      ['a placeholder in the host', 'https://{referenceId}.link.myid.test/v'],
      ['no placeholder', 'https://link.myid.test/v'],
    ])('warns on stderr about %s, and the wallet still starts', (_label, template) => {
      const { stderr } = loadCapturingStderr({ ...base, MYID_VERIFY_LINK_TEMPLATE: template } as NodeJS.ProcessEnv)

      expect(stderr).toMatch(/MYID_VERIFY_LINK_TEMPLATE/)
      expect(stderr).toMatch(/create_verification_qr will refuse/)
    })

    it('says nothing for a good template or for none', () => {
      expect(loadCapturingStderr({ ...base, MYID_VERIFY_LINK_TEMPLATE: 'https://link.myid.test/v?referenceId={referenceId}' } as NodeJS.ProcessEnv).stderr).toBe('')
      expect(loadCapturingStderr(base).stderr).toBe('')
    })
  })

})

// binding the presentation to the verifier's session is on unless it is switched off.
describe('X401_BIND_PRESENTATION', () => {
  const base = { ZETRIX_NETWORK: 'zetrix:testnet', HSM_PASSWORD: 'pw123456' } as NodeJS.ProcessEnv

  it('is on by default, and off only when it says false', () => {
    expect(deriveBindPresentation(undefined)).toBe(true)
    for (const off of ['false', 'FALSE', ' false ', '0', 'no']) expect(deriveBindPresentation(off), off).toBe(false)
    for (const on of ['true', '1', 'yes', 'TRUE']) expect(deriveBindPresentation(on), on).toBe(true)
  })

  it('stays ON for a value that is not true or false, and says so on stderr', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      for (const typo of ['off', 'flase', 'disable']) expect(deriveBindPresentation(typo), typo).toBe(true)
      const cfg = loadConfig({ ...base, X401_BIND_PRESENTATION: 'off' } as NodeJS.ProcessEnv)
      expect(cfg.bindPresentation).toBe(true)
      expect(w.mock.calls.map((c) => String(c[0])).join('')).toContain('X401_BIND_PRESENTATION must be true or false')
    } finally {
      w.mockRestore()
    }
  })

  it('reads false from the environment, and stays quiet for a recognised value or none', () => {
    const w = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(loadConfig({ ...base, X401_BIND_PRESENTATION: 'false' } as NodeJS.ProcessEnv).bindPresentation).toBe(false)
      expect(loadConfig({ ...base, X401_BIND_PRESENTATION: 'true' } as NodeJS.ProcessEnv).bindPresentation).toBe(true)
      expect(loadConfig({ ...base, X401_BIND_PRESENTATION: '  ' } as NodeJS.ProcessEnv).bindPresentation).toBe(true)
      expect(loadConfig(base).bindPresentation).toBe(true)
      expect(w.mock.calls.map((c) => String(c[0])).join('')).not.toContain('X401_BIND_PRESENTATION')
    } finally {
      w.mockRestore()
    }
  })
})
