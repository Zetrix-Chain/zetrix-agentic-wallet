import { describe, it, expect, vi, afterEach } from 'vitest'
import { createX401WalletFactory, type X401WalletFactoryDeps } from '../x401-wallet-factory'
import type { PresentedNonceStore } from '../clients/presented-nonce-store'

afterEach(() => vi.unstubAllGlobals())

/**
 * The per-request x401 wallet, as the server builds it. The wiring used to live inline in `main()`, where dropping the audience
 * or the answered-challenges store would have kept every test green; these pin both.
 */

function makeStore(): PresentedNonceStore & { claimed: Set<string> } {
  const claimed = new Set<string>()
  return {
    claimed,
    claim: async (n) => (claimed.has(n) ? false : (claimed.add(n), true)),
    release: async (n) => void claimed.delete(n),
  }
}

function makeMbi() {
  return {
    createVp: vi.fn().mockResolvedValue({ blobId: 'b1', blob: 'deadbeef' }),
    submitVp: vi.fn().mockResolvedValue({ id: 'v2-ref-1', vp: { id: 'vp-1' } }),
  }
}

function deps(over: Partial<X401WalletFactoryDeps> & { bind?: boolean; network?: string; oid4vpBaseUrl?: string } = {}) {
  const mbi = makeMbi()
  const answered = makeStore()
  const construct = vi.fn((cfg: unknown, d: unknown) => ({ cfg, d }) as never)
  const all: X401WalletFactoryDeps = {
    config: { network: over.network ?? 'zetrix:testnet', oid4vpBaseUrl: over.oid4vpBaseUrl, bindPresentation: over.bind ?? true },
    mbi: mbi as never,
    signer: { sign: vi.fn().mockResolvedValue({ signBlob: 'hb', publicKey: 'edpk' }) } as never,
    signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' }),
    signMessage: vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' }),
    resolveIssuerKeys: vi.fn().mockResolvedValue({ bbsPublicKey: 'bbs', ed25519PublicKey: 'ed' }),
    answered,
    construct: construct as never,
    ...over,
  }
  return { all, mbi, answered, construct }
}

/** The adapter the factory put inside the wallet it built. */
const adapterOf = (construct: ReturnType<typeof deps>['construct']) =>
  (construct.mock.results[0].value as { d: { vc: { createVp: (i: unknown) => Promise<unknown> } } }).d.vc

const input = (nonce: string) => ({ credentialQuery: {}, nonce, holderDid: 'did:zid:h' })

describe('createX401WalletFactory', () => {
  it('builds the client with the configured network and verifier address', () => {
    const { all, construct } = deps({ oid4vpBaseUrl: 'https://verifier.test/api' })

    createX401WalletFactory(all)({ vc: { id: 'vc-1' } })

    expect(construct.mock.calls[0][0]).toEqual({ oid4vpBaseUrl: 'https://verifier.test/api', network: 'zetrix:testnet' })
  })

  it('binds the presentation to the CONFIGURED verifier: its origin is the audience sent to MBI', async () => {
    const { all, mbi, construct } = deps({ network: 'zetrix:testnet' })
    createX401WalletFactory(all)({ vc: { id: 'vc-1' }, revealAttribute: [] })

    await adapterOf(construct).createVp(input('nonce-1'))

    expect(mbi.createVp.mock.calls[0][0]).toMatchObject({ nonce: 'nonce-1', audience: 'https://zid-oid4vp-sandbox.zetrix.com' })
  })

  it('takes the audience from an explicitly configured verifier address when there is one', async () => {
    const { all, mbi, construct } = deps({ oid4vpBaseUrl: 'https://Verifier.Test:8443/api' })
    createX401WalletFactory(all)({ vc: { id: 'vc-1' }, revealAttribute: [] })

    await adapterOf(construct).createVp(input('nonce-1'))

    expect(mbi.createVp.mock.calls[0][0].audience).toBe('https://verifier.test:8443')
  })

  it('keeps the caller\'s own input (the credential, the reveal list, the issuer keys)', async () => {
    const { all, mbi, construct } = deps()
    createX401WalletFactory(all)({ vc: { id: 'vc-1' }, revealAttribute: ['agentName'] })

    await adapterOf(construct).createVp(input('nonce-1'))

    expect(mbi.createVp.mock.calls[0][0]).toMatchObject({ vc: { id: 'vc-1' }, revealAttributes: ['agentName'] })
  })

  it('answers a challenge once: the answered-challenges store is the one the adapter uses', async () => {
    const { all, mbi, answered, construct } = deps()
    const make = createX401WalletFactory(all)
    make({ vc: { id: 'vc-1' }, revealAttribute: [] })

    await adapterOf(construct).createVp(input('nonce-1'))
    expect(answered.claimed.has('nonce-1')).toBe(true)
    await expect(adapterOf(construct).createVp(input('nonce-1'))).rejects.toThrow(/already been answered/)
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })

  it('shares that store between the wallets it builds: a second wallet cannot answer what the first did', async () => {
    const { all, mbi, construct } = deps()
    const make = createX401WalletFactory(all)
    make({ vc: { id: 'vc-1' }, revealAttribute: [] })
    make({ vc: { id: 'vc-1' }, revealAttribute: [] })

    const first = (construct.mock.results[0].value as { d: { vc: { createVp: (i: unknown) => Promise<unknown> } } }).d.vc
    const second = (construct.mock.results[1].value as { d: { vc: { createVp: (i: unknown) => Promise<unknown> } } }).d.vc
    await first.createVp(input('nonce-1'))
    await expect(second.createVp(input('nonce-1'))).rejects.toThrow(/already been answered/)
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })

  it('with binding off (X401_BIND_PRESENTATION=false): no nonce or audience to MBI, and the same challenge may be answered again', async () => {
    const { all, mbi, answered, construct } = deps({ bind: false })
    createX401WalletFactory(all)({ vc: { id: 'vc-1' }, revealAttribute: [] })

    await adapterOf(construct).createVp(input('nonce-1'))
    await adapterOf(construct).createVp(input('nonce-1'))

    for (const call of mbi.createVp.mock.calls) {
      expect('nonce' in call[0]).toBe(false)
      expect('audience' in call[0]).toBe(false)
    }
    expect(mbi.createVp).toHaveBeenCalledTimes(2)
    expect(answered.claimed.size).toBe(0)
  })

  it('leaves the audience out when no usable verifier address can be resolved, but still sends the nonce', async () => {
    const { all, mbi, construct } = deps({ network: 'zetrix:nowhere' })
    createX401WalletFactory(all)({ vc: { id: 'vc-1' }, revealAttribute: [] })

    await adapterOf(construct).createVp(input('nonce-1'))

    const body = mbi.createVp.mock.calls[0][0]
    expect(body.nonce).toBe('nonce-1')
    expect('audience' in body).toBe(false)
  })
})

describe('through the real x401 client', () => {
  const BASE = 'https://verifier.test/api'
  const header = Buffer.from(
    JSON.stringify({
      verification_data: { requestUri: `${BASE}/v1/presentation/req-1`, nonce: 'nonce-1', expiresAt: '2026-12-31' },
      credential_requirements: { type: 'AgentIdentity' },
      request_id: 'req-1',
      // a resource server may write any host here: it is not the verifier this wallet presents to
      request_uri: 'https://attacker.example/v1/presentation/req-1',
      nonce: 'nonce-1',
    }),
    'utf8',
  ).toString('base64url')

  function stubVerifier() {
    const definition = { object: { presentation_id: 'req-1', credential_query: {}, nonce: 'nonce-1', response_uri: `${BASE}/v1/presentation/submit`, expires_at: '2026-12-31' } }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => definition }) as unknown as Response))
  }

  it('signs the configured verifier as the audience, whatever host the challenge names', async () => {
    stubVerifier()
    const mbi = makeMbi()
    const make = createX401WalletFactory({
      config: { network: 'zetrix:testnet', oid4vpBaseUrl: BASE, bindPresentation: true },
      mbi: mbi as never,
      signer: { sign: vi.fn().mockRejectedValue(new Error('stop here')) } as never,
      signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' }),
      signMessage: vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' }),
      resolveIssuerKeys: vi.fn().mockResolvedValue({ bbsPublicKey: 'bbs', ed25519PublicKey: 'ed' }),
      answered: makeStore(),
    })

    await expect(make({ vc: { id: 'vc-1' }, revealAttribute: [] }).respondToChallenge(header, 'did:zid:h')).rejects.toThrow()

    expect(mbi.createVp.mock.calls[0][0]).toMatchObject({ nonce: 'nonce-1', audience: 'https://verifier.test' })
  })

  it('keeps the challenge answered when a step AFTER the presentation was made fails (the holder binding), so it is not answered again', async () => {
    stubVerifier()
    const mbi = makeMbi()
    const make = createX401WalletFactory({
      config: { network: 'zetrix:testnet', oid4vpBaseUrl: BASE, bindPresentation: true },
      mbi: mbi as never,
      signer: { sign: vi.fn().mockRejectedValue(new Error('holder binding failed')) } as never,
      signHexBlob: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' }),
      signMessage: vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' }),
      resolveIssuerKeys: vi.fn().mockResolvedValue({ bbsPublicKey: 'bbs', ed25519PublicKey: 'ed' }),
      answered: makeStore(),
    })

    await expect(make({ vc: { id: 'vc-1' }, revealAttribute: [] }).respondToChallenge(header, 'did:zid:h')).rejects.toThrow()
    expect(mbi.createVp).toHaveBeenCalledTimes(1)

    const again = make({ vc: { id: 'vc-1' }, revealAttribute: [] }).respondToChallenge(header, 'did:zid:h')
    await expect(again).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringMatching(/already been answered/) }) })
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })
})
