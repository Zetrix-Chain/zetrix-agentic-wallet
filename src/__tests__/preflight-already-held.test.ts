/**
 * "get me a verified birthcert" must not walk a user towards paying 1 JMYR for a credential they already hold.
 *
 * What happened: the wallet held a valid Verified AI Birthcert. The agent called credential_preflight, got "no blockers",
 * and went on to ask for an agent name. The only check for an existing credential lives in the PAID call
 * (request_ai_birthcert_verification), after the agent has already steered the user; the free quote path skips it on
 * purpose (so a price can be read while a session is in flight) and preflight never looked at what the wallet holds.
 *
 * So preflight now looks, locally and for free, and stops with "you already hold one" before anything is collected.
 */
import { describe, it, expect, vi } from 'vitest'
import { credentialPreflight, VERIFIED_AI_BIRTHCERT, type HeldCredential } from '../orchestrator/preflight'
import { createHeldCredentialFinder } from '../held-credential'
import { createTools } from '../mcp-tools'
import type { CachedVc, VcCacheStore } from '../clients/vc-cache'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const VERIFIED_ID = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
const BASIC_TESTNET = 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959'
const NOW = new Date('2026-10-08T00:00:00.000Z')

const balances = (byToken: Record<string, string>) =>
  vi.fn(async (token: string) => {
    const raw = byToken[token] ?? byToken[token.toUpperCase()]
    if (raw === undefined) return { token, error: 'query_failed' as const }
    const symbol = token === JMYR ? 'JMYR' : token.toUpperCase()
    return { token: symbol, balance: raw, decimals: 6, display: `${Number(raw) / 1e6} ${symbol}` }
  })

const held: HeldCredential = { label: 'Verified AI Birthcert', vcId: 'did:zid:7ad1eaef', validUntil: '2027-09-28T00:00:00Z' }

const deps = (over: Record<string, unknown> = {}) => ({
  quoteVerified: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1000000', gasModel: 'sponsored' } }),
  quoteTemplate: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1000000' }, schema: { required: ['agentUsername'], optional: [] } }),
  queryTokenBalance: balances({ [JMYR]: '5000000', ZTX: '2000000' }),
  caps: { [JMYR]: '5000000', '*': '0' },
  ...over,
})

describe('credentialPreflight when the wallet already holds the credential', () => {
  it('is NOT ready, says so first, and names what is held', async () => {
    const out = await credentialPreflight(deps({ findHeld: vi.fn().mockResolvedValue(held) }) as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(out.ready).toBe(false)
    expect(out.alreadyHeld).toMatchObject({ label: 'Verified AI Birthcert', vcId: 'did:zid:7ad1eaef', validUntil: '2027-09-28T00:00:00Z' })
    expect(out.blockers[0]).toMatch(/already holds a valid Verified AI Birthcert/)
    expect(out.blockers[0]).toMatch(/valid until 2027-09-28/)
  })

  it('says what buying another would do, and what to do instead', async () => {
    const out = await credentialPreflight(deps({ findHeld: vi.fn().mockResolvedValue(held) }) as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(out.blockers[0]).toMatch(/REPLACE/)
    expect(out.blockers[0]).toMatch(/costs the fee/)
    expect(out.blockers[0]).toMatch(/replacing: true/)
  })

  it('stops before any price is read: nothing is quoted, nothing is balanced, nothing is asked of a service', async () => {
    const d = deps({ findHeld: vi.fn().mockResolvedValue(held) })

    const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT })

    expect(d.quoteVerified).not.toHaveBeenCalled()
    expect(d.queryTokenBalance).not.toHaveBeenCalled()
    expect(out.fee).toBeUndefined()
    expect(out.balances).toEqual([])
  })

  it('also blocks a template credential that is already held', async () => {
    const d = deps({ findHeld: vi.fn().mockResolvedValue({ label: 'Basic AI Birthcert', vcId: 'did:zid:basic' }) })

    const out = await credentialPreflight(d as never, { credential: BASIC_TESTNET })

    expect(out.ready).toBe(false)
    expect(out.alreadyHeld?.label).toBe('Basic AI Birthcert')
    expect(d.quoteTemplate).not.toHaveBeenCalled()
  })

  it('asks the lookup about the credential it was asked about', async () => {
    const findHeld = vi.fn().mockResolvedValue(undefined)

    await credentialPreflight(deps({ findHeld }) as never, { credential: BASIC_TESTNET })

    expect(findHeld).toHaveBeenCalledWith(BASIC_TESTNET)
  })

  describe('a person who really wants a replacement can still get one', () => {
    it('with replacing: true it is priced as usual, and the held credential is still named', async () => {
      const d = deps({ findHeld: vi.fn().mockResolvedValue(held) })

      const out = await credentialPreflight(d as never, { credential: VERIFIED_AI_BIRTHCERT, replacing: true })

      expect(out.ready).toBe(true)
      expect(out.blockers).toEqual([])
      expect(out.fee).toBeDefined()
      expect(out.alreadyHeld).toMatchObject({ label: 'Verified AI Birthcert', replacing: true })
      expect(d.quoteVerified).toHaveBeenCalled()
    })

    it.each([['true'], [1], ['yes']])('does not treat replacing %j as a yes', async (replacing) => {
      const out = await credentialPreflight(deps({ findHeld: vi.fn().mockResolvedValue(held) }) as never, {
        credential: VERIFIED_AI_BIRTHCERT,
        replacing: replacing as never,
      })

      expect(out.ready).toBe(false)
    })
  })

  describe('and when it does not', () => {
    it('is unchanged when nothing is held', async () => {
      const out = await credentialPreflight(deps({ findHeld: vi.fn().mockResolvedValue(undefined) }) as never, { credential: VERIFIED_AI_BIRTHCERT })

      expect(out.ready).toBe(true)
      expect(out.alreadyHeld).toBeUndefined()
    })

    it('is unchanged when no lookup is wired', async () => {
      const out = await credentialPreflight(deps() as never, { credential: VERIFIED_AI_BIRTHCERT })

      expect(out.ready).toBe(true)
    })

    it('says what it could not check when the lookup fails, and never reports that nothing is held', async () => {
      const out = await credentialPreflight(deps({ findHeld: vi.fn().mockRejectedValue(new Error('disk gone')) }) as never, { credential: VERIFIED_AI_BIRTHCERT })

      expect(out.alreadyHeld).toBeUndefined()
      expect(out.notChecked.join(' ')).toMatch(/Whether this wallet already holds one could not be checked/)
      expect(out.notChecked.join(' ')).toContain('disk gone')
    })

    it('says that preflight only looks at what the wallet has saved', async () => {
      const out = await credentialPreflight(deps({ findHeld: vi.fn().mockResolvedValue(undefined) }) as never, { credential: VERIFIED_AI_BIRTHCERT })

      expect(out.notChecked.join(' ')).toMatch(/only looks at credentials this wallet has already saved/)
    })
  })
})

describe('createHeldCredentialFinder', () => {
  const entry = (over: Partial<CachedVc> = {}): CachedVc => ({
    templateId: VERIFIED_ID,
    vc: { id: 'did:zid:7ad1eaef' },
    vcId: 'did:zid:7ad1eaef',
    issuedAt: '2026-09-28T00:00:00Z',
    validUntil: '2027-09-28T00:00:00Z',
    ...over,
  })
  const cacheOf = (...entries: CachedVc[]): VcCacheStore => ({
    get: async (id) => entries.find((e) => e.templateId === id) ?? null,
    set: async () => undefined,
    list: async () => entries,
  })
  const finder = (cache: VcCacheStore, over: Partial<Parameters<typeof createHeldCredentialFinder>[0]> = {}) =>
    createHeldCredentialFinder({ cache, network: 'zetrix:testnet', verifiedTemplateId: VERIFIED_ID, now: () => NOW, ...over })

  it('finds a valid Verified AI Birthcert under its own template', async () => {
    const r = await finder(cacheOf(entry()))(VERIFIED_AI_BIRTHCERT)

    expect(r).toEqual({ label: 'Verified AI Birthcert', vcId: 'did:zid:7ad1eaef', validUntil: '2027-09-28T00:00:00Z' })
  })

  it('finds a valid Basic AI Birthcert by its name or its template id', async () => {
    const cache = cacheOf(entry({ templateId: BASIC_TESTNET, vcId: 'did:zid:basic' }))

    expect((await finder(cache)('AI Birthcert'))?.label).toBe('Basic AI Birthcert')
    expect((await finder(cache)(BASIC_TESTNET))?.label).toBe('Basic AI Birthcert')
  })

  it('does not count an expired credential: it is not worth keeping, and buying a new one is right', async () => {
    const r = await finder(cacheOf(entry({ validUntil: '2026-01-01T00:00:00Z' })))(VERIFIED_AI_BIRTHCERT)

    expect(r).toBeUndefined()
  })

  it('does not mistake a credential of another template for this one', async () => {
    const r = await finder(cacheOf(entry({ templateId: BASIC_TESTNET })))(VERIFIED_AI_BIRTHCERT)

    expect(r).toBeUndefined()
  })

  it('finds nothing for the Verified credential where its template id is not known (mainnet), rather than guessing', async () => {
    const r = await finder(cacheOf(entry()), { verifiedTemplateId: undefined })(VERIFIED_AI_BIRTHCERT)

    expect(r).toBeUndefined()
  })

  it('treats a credential with no recorded expiry as valid', async () => {
    const r = await finder(cacheOf(entry({ validUntil: undefined })))(VERIFIED_AI_BIRTHCERT)

    expect(r).toMatchObject({ label: 'Verified AI Birthcert' })
  })

  it('names a credential of any other template by that template', async () => {
    const other = 'did:zid:c042e49e55ffe1b0ee835e6a8b3d1aec720fb1cb01dca17c4b3e5c2194949a6c'

    const r = await finder(cacheOf(entry({ templateId: other, vcId: 'did:zid:other' })))(other)

    expect(r?.label).toMatch(/credential for template did:zid:c042e49e/)
  })
})

describe('credential_preflight, as the agent calls it', () => {
  const toolsWith = (findHeldCredential: unknown) =>
    createTools({
      config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
      queryTokenBalance: balances({ [JMYR]: '5000000', ZTX: '2000000' }),
      paymentCaps: { [JMYR]: '5000000', '*': '0' },
      verifyAiBirthcert: {
        request: vi.fn().mockResolvedValue({ quote: { asset: JMYR, maxAmountRequired: '1000000', gasModel: 'sponsored' } }),
        check: vi.fn(),
        clearStuckReceipt: vi.fn(),
      },
      findHeldCredential,
    } as never)

  it('answers "you already hold it" for the Verified AI Birthcert, before any price is read', async () => {
    const tools = toolsWith(vi.fn().mockResolvedValue(held))

    const out = (await tools.credential_preflight({ credential: VERIFIED_AI_BIRTHCERT })) as { ready: boolean; alreadyHeld?: unknown; blockers: string[] }

    expect(out.ready).toBe(false)
    expect(out.alreadyHeld).toMatchObject({ label: 'Verified AI Birthcert' })
    expect(out.blockers[0]).toMatch(/already holds a valid Verified AI Birthcert/)
  })

  it('passes replacing through', async () => {
    const tools = toolsWith(vi.fn().mockResolvedValue(held))

    const out = (await tools.credential_preflight({ credential: VERIFIED_AI_BIRTHCERT, replacing: true })) as { ready: boolean }

    expect(out.ready).toBe(true)
  })
})
