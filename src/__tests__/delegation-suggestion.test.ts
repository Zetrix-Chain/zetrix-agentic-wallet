import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CachedVc, VcCacheStore } from '../clients/vc-cache'
import { suggestDelegationVc, type DelegationSuggestion } from '../orchestrator/delegation-suggestion'
import { createTools, type ToolDeps } from '../mcp-tools'
import { resolveTemplateAlias } from '../template-aliases'

vi.mock('../orchestrator/subscribe', async (importOriginal) => ({ ...(await importOriginal<typeof import('../orchestrator/subscribe')>()), subscribeAndIssue: vi.fn() }))
vi.mock('../orchestrator/preflight', async (importOriginal) => ({ ...(await importOriginal<typeof import('../orchestrator/preflight')>()), credentialPreflight: vi.fn() }))
import { subscribeAndIssue } from '../orchestrator/subscribe'
import { credentialPreflight } from '../orchestrator/preflight'

const NOW = new Date('2026-10-23T06:00:00Z')
const NETWORK = 'zetrix:testnet'
const DELEGATION_TEMPLATE = 'did:zid:1724245eb96cb0092c3ae354a68d9e21466aa5ef3e74019f4cfc7554b28cf1a9'
const VERIFIED_TEMPLATE = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
const BASIC_TEMPLATE = resolveTemplateAlias('ai birthcert', NETWORK)!

const held = (templateId: string, validUntil = '2027-10-13T00:00:00Z'): CachedVc => ({ templateId, vc: { id: `vc-${templateId.slice(-4)}` }, issuedAt: '2026-10-01T00:00:00Z', validUntil })
/** A Verified AI Birthcert as the wallet caches it: the owner check and the name are read from it. */
const verified = (over: { ownerVerified?: string; agentName?: string; validUntil?: string } = {}): CachedVc => ({
  templateId: VERIFIED_TEMPLATE,
  vc: { credentialSubject: { id: 'did:zid:me', verifiedAiBirthcert: { agentName: over.agentName ?? 'my-agent', ownerVerified: over.ownerVerified ?? 'true' } } },
  issuedAt: '2026-10-01T00:00:00Z',
  validUntil: over.validUntil ?? '2027-10-13T00:00:00Z',
})
function memoryCache(initial: CachedVc[] = []): VcCacheStore {
  const m = new Map(initial.map((e) => [e.templateId, e]))
  return { get: async (id) => m.get(id) ?? null, set: async (id, e) => void m.set(id, e), list: async () => [...m.values()] }
}
const suggest = (cache: VcCacheStore, over: { delegationTemplateId?: string | undefined; verifiedTemplateId?: string | undefined } = {}) =>
  suggestDelegationVc({
    cache,
    verifiedTemplateId: 'verifiedTemplateId' in over ? over.verifiedTemplateId : VERIFIED_TEMPLATE,
    delegationTemplateId: 'delegationTemplateId' in over ? over.delegationTemplateId : DELEGATION_TEMPLATE,
    now: () => NOW,
  })

describe('suggestDelegationVc', () => {
  it('offers the delegation credential to an agent that has a Verified AI Birthcert (owner verified) and no delegation credential', async () => {
    const s = await suggest(memoryCache([verified()]))
    expect(s).toMatchObject({ tool: 'apply_delegation_vc' })
    expect(s!.reason).toMatch(/Verified AI Birthcert/)
    // a question for the user, and nothing happens without their yes
    expect(s!.askUser).toMatch(/Ask the user/)
    expect(s!.askUser).toMatch(/Only if they say yes/)
    expect(s!.askUser).toMatch(/Do not call it on your own/)
  })

  it.each([
    ['no birthcert at all', []],
    ['only the Basic AI Birthcert, which MBI no longer accepts for the delegation credential', [held(BASIC_TEMPLATE)]],
    ['an expired Verified AI Birthcert', [verified({ validUntil: '2026-01-01T00:00:00Z' })]],
    ['a Verified AI Birthcert whose ownerVerified is "false"', [verified({ ownerVerified: 'false' })]],
    ['a Verified AI Birthcert with no agentName', [verified({ agentName: '' })]],
    ['a delegation credential already held', [verified(), held(DELEGATION_TEMPLATE)]],
  ])('offers nothing with %s', async (_n, entries) => {
    expect(await suggest(memoryCache(entries))).toBeUndefined()
  })

  it('offers it again when the held delegation credential has expired', async () => {
    expect(await suggest(memoryCache([verified(), held(DELEGATION_TEMPLATE, '2026-01-01T00:00:00Z')]))).toMatchObject({ tool: 'apply_delegation_vc' })
  })

  it('offers nothing where a template is not deployed or known, and never fails on a cache it cannot read', async () => {
    expect(await suggest(memoryCache([verified()]), { delegationTemplateId: undefined })).toBeUndefined()
    expect(await suggest(memoryCache([verified()]), { verifiedTemplateId: undefined })).toBeUndefined()
    const broken: VcCacheStore = { get: async () => { throw new Error('disk gone') }, set: async () => undefined, list: async () => [] }
    expect(await suggest(broken)).toBeUndefined()
  })
})

describe('where the suggestion is raised', () => {
  const suggestion: DelegationSuggestion = { tool: 'apply_delegation_vc', reason: 'r', askUser: 'ask' }
  const tools = (extra: Partial<ToolDeps> = {}) =>
    createTools({
      config: { holderDid: 'did:zid:me', zetrixAddress: 'ZTX3me', network: NETWORK },
      queryTokenBalance: async () => ({}),
      subscribeDeps: {},
      delegationSuggestion: async () => suggestion,
      ...extra,
    } as unknown as ToolDeps)
  const verifyTool = (result: object, extra: Partial<ToolDeps> = {}) =>
    tools({ verifyAiBirthcert: { check: async () => result } as never, ...extra })

  beforeEach(() => { vi.mocked(subscribeAndIssue).mockReset(); vi.mocked(credentialPreflight).mockReset() })

  it('wallet_status carries it when there is one, and not when there is none', async () => {
    expect((await tools().wallet_status({ heldCredentials: [] })).suggestion).toEqual(suggestion)
    expect('suggestion' in (await tools({ delegationSuggestion: async () => undefined }).wallet_status({ heldCredentials: [] }))).toBe(false)
    expect('suggestion' in (await tools({ delegationSuggestion: undefined }).wallet_status({ heldCredentials: [] }))).toBe(false)
  })

  describe('check_ai_birthcert_verification', () => {
    it('right after the Verified AI Birthcert was issued, with the rest of the result unchanged', async () => {
      const r = (await verifyTool({ status: 'issued', vcId: 'v', vc: { id: 'v' } }).check_ai_birthcert_verification()) as unknown as Record<string, unknown>
      expect(r.suggestion).toEqual(suggestion)
      expect(r).toMatchObject({ status: 'issued', vcId: 'v', vc: { id: 'v' } })
    })
    it('not while the session is still open, not when the wallet has no suggestion, and not without the wallet wiring', async () => {
      expect('suggestion' in ((await verifyTool({ status: 'pending' }).check_ai_birthcert_verification()) as object)).toBe(false)
      expect('suggestion' in ((await verifyTool({ status: 'issued' }, { delegationSuggestion: async () => undefined }).check_ai_birthcert_verification()) as object)).toBe(false)
      expect(await tools({ verifyAiBirthcert: undefined }).check_ai_birthcert_verification()).toMatchObject({ error: expect.any(String) })
    })
  })

  describe('the Basic AI Birthcert flows no longer carry it (MBI does not accept that birthcert for the delegation credential)', () => {
    it('subscribe_and_issue', async () => {
      vi.mocked(subscribeAndIssue).mockResolvedValue({ issued: true, vcId: 'v', nextStep: 'show_credential' } as never)
      const r = (await tools().subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { agentUsername: 'a' } })) as unknown as Record<string, unknown>
      expect(r.issued).toBe(true)
      expect('suggestion' in r).toBe(false)
    })
    it('credential_preflight', async () => {
      vi.mocked(credentialPreflight).mockResolvedValue({ credential: 'AI Birthcert', ready: false, nextStep: 'tell_user_already_held', alreadyHeld: {} } as never)
      const r = (await tools().credential_preflight({ credential: 'AI Birthcert' })) as unknown as Record<string, unknown>
      expect(r.nextStep).toBe('tell_user_already_held')
      expect('suggestion' in r).toBe(false)
    })
  })

  it('never turns a result into a request: the suggestion is data and nothing is issued by it', async () => {
    const delegation = vi.fn()
    await verifyTool({ status: 'issued' }, { agentVc: delegation } as never).check_ai_birthcert_verification()
    expect(delegation).not.toHaveBeenCalled()
  })
})
