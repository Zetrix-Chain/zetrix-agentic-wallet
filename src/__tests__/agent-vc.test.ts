import { describe, it, expect, vi, afterEach } from 'vitest'
import { MbiClient, MbiError, type MbiAgentVcBody, type MbiRequestSigner } from '../clients/mbi-client'
import type { CachedVc, VcCacheStore } from '../clients/vc-cache'
import { applyAgentVc, type AgentVcKind, type ApplyAgentVcDeps } from '../orchestrator/agent-vc'
import { createTools, type ToolDeps } from '../mcp-tools'
import { resolveTemplateAlias } from '../template-aliases'

const NOW = new Date('2026-10-23T04:00:00Z')
const NETWORK = 'zetrix:testnet'
const DELEGATION_TEMPLATE = 'did:zid:1724245eb96cb0092c3ae354a68d9e21466aa5ef3e74019f4cfc7554b28cf1a9'
const POLICY_TEMPLATE = 'did:zid:d3e08efbeea484bcb21483b269230f250abb34d097e88ef22059b0aafbce6ce9'
const VERIFIED_TEMPLATE = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
const BASIC_TEMPLATE = resolveTemplateAlias('ai birthcert', NETWORK)!
const VC_ID = `did:zid:${'a'.repeat(64)}`

function memoryCache(initial: CachedVc[] = []): VcCacheStore & { entries: Map<string, CachedVc> } {
  const entries = new Map(initial.map((e) => [e.templateId, e]))
  return {
    entries,
    get: async (id) => entries.get(id) ?? null,
    set: async (id, entry) => void entries.set(id, entry),
    list: async () => [...entries.values()],
  }
}

/** The Verified AI Birthcert: the credential the name and the owner check come from. */
const birthcert = (name: string, validUntil = '2027-10-13T00:00:00Z', ownerVerified: string | null = 'true'): CachedVc => ({
  templateId: VERIFIED_TEMPLATE,
  vc: {
    type: ['VerifiableCredential', 'Verified AI Birthcert'],
    credentialSubject: { id: 'did:zid:holder', verifiedAiBirthcert: { agentName: name, ...(ownerVerified !== null ? { ownerVerified } : {}) } },
    validUntil,
  },
  issuedAt: '2026-10-01T00:00:00Z',
  validUntil,
})

/** The Basic AI Birthcert, which no longer counts. */
const basicBirthcert = (name: string): CachedVc => ({
  templateId: BASIC_TEMPLATE,
  vc: { type: ['VerifiableCredential', 'AI Birthcert'], credentialSubject: { id: 'did:zid:holder', aiBirthcert: { agentUsername: name } }, validUntil: '2027-10-13T00:00:00Z' },
  issuedAt: '2026-10-01T00:00:00Z',
  validUntil: '2027-10-13T00:00:00Z',
})

const issuedVc = (kind: AgentVcKind) => ({
  id: VC_ID,
  type: ['VerifiableCredential', kind === 'delegation' ? 'AI Delegation Credential' : 'AI Policy Credential'],
  validUntil: '2027-10-23T00:00:00Z',
  credentialSubject: {
    id: 'did:zid:holder',
    ...(kind === 'delegation'
      ? { aiDelegationCredential: { id: 'my-agent', agentUsername: 'my-agent', allowDelegateTransfer: 'true', maxDelegationDepth: '1' } }
      : { aiPolicyCredential: { id: 'my-agent', agentUsername: 'my-agent', agentRole: 'main', policyA: 'low', policyB: 'moderate', policyC: 'high', transferMax: 10, transferCurrency: 'JMYR' } }),
  },
})

function deps(over: Partial<ApplyAgentVcDeps> & { cache?: ReturnType<typeof memoryCache> } = {}) {
  const issue = vi.fn(async (kind: AgentVcKind, _body: MbiAgentVcBody, _sign: MbiRequestSigner) => ({ vcId: VC_ID, verifiableCredential: issuedVc(kind) }))
  const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' })
  const cache = over.cache ?? memoryCache([birthcert('my-agent')])
  const d: ApplyAgentVcDeps = {
    cache, network: NETWORK, verifiedTemplateId: VERIFIED_TEMPLATE,
    templateIds: { delegation: DELEGATION_TEMPLATE, policy: POLICY_TEMPLATE },
    issue, sign, now: () => NOW, ...over,
  }
  return { d, issue, sign, cache }
}

describe('applyAgentVc', () => {
  it('issues the delegation credential for the agent named by the Verified AI Birthcert (its agentName), and saves it under the delegation template', async () => {
    const { d, issue, sign, cache } = deps()
    const r = await applyAgentVc('delegation', { purpose: 'delegate to helpers' }, d)
    expect(issue).toHaveBeenCalledTimes(1)
    expect(issue).toHaveBeenCalledWith('delegation', { agentUsername: 'my-agent', purpose: 'delegate to helpers' }, sign)
    expect(r).toMatchObject({ issued: true, kind: 'delegation', vcId: VC_ID, templateId: DELEGATION_TEMPLATE, saved: true, validUntil: '2027-10-23T00:00:00Z' })
    expect(r.issued && r.attributes).toMatchObject({ allowDelegateTransfer: 'true', maxDelegationDepth: '1' })
    expect(r.issued && r.verifiableCredential).toBeUndefined()
    const saved = cache.entries.get(DELEGATION_TEMPLATE)!
    expect(saved).toMatchObject({ templateId: DELEGATION_TEMPLATE, vcId: VC_ID, validUntil: '2027-10-23T00:00:00Z', issuedAt: NOW.toISOString() })
    expect((saved.vc as { id: string }).id).toBe(VC_ID)
  })

  it('never sends the policy levels, the limit or the role, whatever the caller tries', async () => {
    const { d, issue } = deps()
    await applyAgentVc('policy', { policyA: 'high', transferMax: 999999, agentRole: 'sub', purpose: 'p' } as never, d)
    expect(issue.mock.calls[0][1]).toEqual({ agentUsername: 'my-agent', purpose: 'p' })
  })

  it.each(['delegation', 'policy'] as const)('refuses the %s credential without a Verified AI Birthcert, and sends nothing', async (kind) => {
    const { d, issue, sign } = deps({ cache: memoryCache() })
    const r = await applyAgentVc(kind, {}, d)
    expect(r).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    expect(r.message).toMatch(/Verified AI Birthcert/)
    expect(r.message).toMatch(/request_ai_birthcert_verification/)
    expect(issue).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
  })

  it.each(['delegation', 'policy'] as const)('says a Basic AI Birthcert alone does not count for the %s credential', async (kind) => {
    const { d, issue } = deps({ cache: memoryCache([basicBirthcert('my-agent')]) })
    const r = await applyAgentVc(kind, { agentUsername: 'my-agent' }, d)
    expect(r).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    expect(r.message).toMatch(/Basic AI Birthcert does not count/)
    expect(issue).not.toHaveBeenCalled()
  })

  it('does not count an expired Verified AI Birthcert', async () => {
    const { d, issue } = deps({ cache: memoryCache([birthcert('my-agent', '2026-01-01T00:00:00Z')]) })
    expect(await applyAgentVc('delegation', {}, d)).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    expect(issue).not.toHaveBeenCalled()
  })

  it.each([['"false"', 'false'], ['missing', null]] as const)('refuses a Verified AI Birthcert whose ownerVerified is %s, before anything is sent', async (_label, ownerVerified) => {
    const { d, issue } = deps({ cache: memoryCache([birthcert('my-agent', '2027-10-13T00:00:00Z', ownerVerified)]) })
    const r = await applyAgentVc('delegation', {}, d)
    expect(r).toMatchObject({ issued: false, reason: 'owner_not_verified' })
    expect(r.message).toMatch(/ownerVerified/)
    expect(issue).not.toHaveBeenCalled()
  })

  it('sends the birthcert agentName with its ends trimmed, exactly as MBI compares it', async () => {
    const { d, issue } = deps({ cache: memoryCache([birthcert('  owner-agent-02 ')]) })
    expect(await applyAgentVc('delegation', {}, d)).toMatchObject({ issued: true })
    expect(issue.mock.calls[0][1].agentUsername).toBe('owner-agent-02')
  })

  it('refuses a different agentUsername from the birthcert agentName, because MBI and the sub-agent step compare the two', async () => {
    const { d, issue } = deps()
    const r = await applyAgentVc('policy', { agentUsername: 'someone-else' }, d)
    expect(r).toMatchObject({ issued: false, reason: 'username_mismatch' })
    expect(r.message).toMatch(/my-agent/)
    expect(issue).not.toHaveBeenCalled()
  })

  it('accepts the same agentUsername as the birthcert', async () => {
    const { d, issue } = deps()
    expect(await applyAgentVc('policy', { agentUsername: ' my-agent ' }, d)).toMatchObject({ issued: true })
    expect(issue.mock.calls[0][1].agentUsername).toBe('my-agent')
  })

  it('a given agentUsername does not replace the Verified birthcert: the main policy credential needs it too', async () => {
    const { d, issue } = deps({ cache: memoryCache() })
    expect(await applyAgentVc('policy', { agentUsername: 'named-agent' }, d)).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    expect(issue).not.toHaveBeenCalled()
  })

  it('a credential held under another name (issued under the old Basic rule) is not reused, and the wallet says MBI has to replace it', async () => {
    const old: CachedVc = { templateId: DELEGATION_TEMPLATE, vc: issuedVc('delegation'), vcId: VC_ID, issuedAt: '2026-10-01T00:00:00Z', validUntil: '2027-10-23T00:00:00Z' }
    const { d, issue } = deps({ cache: memoryCache([birthcert('owner-agent-02'), old]) })
    const r = await applyAgentVc('delegation', {}, d)
    expect(r).toMatchObject({ issued: false, reason: 'username_mismatch', vcId: VC_ID })
    expect(r.message).toMatch(/my-agent/)
    expect(r.message).toMatch(/owner-agent-02/)
    expect(r.message).toMatch(/revoked and issued again/)
    expect(issue).not.toHaveBeenCalled()
  })

  it('does not ask again for a credential the wallet already holds, and does ask when the held one has expired', async () => {
    const held: CachedVc = { templateId: POLICY_TEMPLATE, vc: issuedVc('policy'), vcId: VC_ID, issuedAt: '2026-10-01T00:00:00Z', validUntil: '2027-10-23T00:00:00Z' }
    const a = deps({ cache: memoryCache([birthcert('my-agent'), held]) })
    expect(await applyAgentVc('policy', {}, a.d)).toMatchObject({ issued: false, reason: 'already_held', vcId: VC_ID, validUntil: '2027-10-23T00:00:00Z' })
    expect(a.issue).not.toHaveBeenCalled()

    const b = deps({ cache: memoryCache([birthcert('my-agent'), { ...held, validUntil: '2026-01-01T00:00:00Z' }]) })
    expect(await applyAgentVc('policy', {}, b.d)).toMatchObject({ issued: true })
    expect(b.issue).toHaveBeenCalledTimes(1)
  })

  it('says so, and sends nothing, where the template is not deployed', async () => {
    const { d, issue } = deps({ templateIds: { delegation: undefined, policy: undefined }, network: 'zetrix:mainnet' })
    const r = await applyAgentVc('policy', { agentUsername: 'a' }, d)
    expect(r).toMatchObject({ issued: false, reason: 'unavailable' })
    expect(r.message).toMatch(/AI_POLICY_TEMPLATE_ID/)
    expect(issue).not.toHaveBeenCalled()
  })

  describe('what MBI can answer', () => {
    const failWith = (status: number, tail: string, mbiStatus?: number) => async (): Promise<never> => {
      throw new MbiError(`MBI vc/ext/agent/delegation/issue failed — HTTP ${status}: ${tail}`, status, mbiStatus)
    }

    it('409: MBI holds one the wallet has no copy of; it names the vcId and says not to retry', async () => {
      const { d } = deps({ issue: failWith(409, `Already holds it ${VC_ID}`, 6002) })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'already_held_at_issuer', vcId: VC_ID })
      expect(r.message).toMatch(/do not retry/i)
    })

    it.each([
      [429, 'rate_limited', /do not retry now/],
      [404, 'unavailable', /MBI_BASE_URL/],
      [422, 'needs_birthcert', /Basic AI Birthcert/],
      [401, 'refused', /signed request/],
    ] as const)('HTTP %i becomes %s', async (status, reason, words) => {
      const { d } = deps({ issue: failWith(status, 'x') })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason })
      expect(r.message).toMatch(words)
    })

    it('422 with 6005: the name is not the one in the Verified birthcert MBI holds', async () => {
      const { d } = deps({ issue: failWith(422, 'Name differs', 6005) })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'username_mismatch' })
      expect(r.message).toMatch(/Verified AI Birthcert/)
    })

    it('422 with 6004: MBI has no valid Verified birthcert on record, and says the Basic one does not count', async () => {
      const { d } = deps({ issue: failWith(422, 'No birthcert', 6004) })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'needs_birthcert' })
      expect(r.message).toMatch(/valid Verified AI Birthcert/)
      expect(r.message).toMatch(/Basic AI Birthcert does not count/)
    })

    it('an empty 403 is explained as a signed request MBI did not accept, not as a username problem', async () => {
      const { d } = deps({ issue: failWith(403, '') })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'refused' })
      expect(r.message).toMatch(/signed request was not accepted/)
      expect(r.message).not.toMatch(/agentUsername/)
    })

    it('400: MBI says what is wrong with the request and the wallet relays it, with nothing issued', async () => {
      const { d } = deps({ issue: failWith(400, 'agentUsername must not contain a colon | full body: {"status":400}') })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'invalid_request' })
      expect(r.message).toMatch(/agentUsername must not contain a colon/)
      expect(r.message).not.toMatch(/full body/)
      expect(r.message).toMatch(/Nothing was issued/)
    })

    it('a long non-JSON 400 body is shown capped, not whole', async () => {
      const { d } = deps({ issue: failWith(400, 'x'.repeat(1000)) })
      const r = await applyAgentVc('delegation', {}, d)
      expect(r).toMatchObject({ issued: false, reason: 'invalid_request' })
      expect(r.message.length).toBeLessThan(500)
      expect(r.message).toMatch(/x…/)
    })

    it('the trimmed expirationDate is the one sent', async () => {
      const { d, issue } = deps({})
      await applyAgentVc('delegation', { expirationDate: ' 2027-01-01 ' }, d)
      expect(issue.mock.calls[0][1]).toMatchObject({ expirationDate: '2027-01-01' })
    })

    it('an expirationDate that is not a real, future YYYY-MM-DD is refused before anything is sent', async () => {
      for (const expirationDate of ['2026-13-40', '12/10/2027', 'tomorrow', '2026-10-01']) {
        const { d, issue } = deps({})
        const r = await applyAgentVc('delegation', { expirationDate }, d)
        expect(r).toMatchObject({ issued: false, reason: 'invalid_request' })
        expect(r.message).toMatch(/expirationDate/)
        expect(issue).not.toHaveBeenCalled()
      }
    })

    it('a 403 that carries a reason, and any other failure, is thrown and not guessed at', async () => {
      await expect(applyAgentVc('delegation', {}, deps({ issue: failWith(403, 'Authenticated address does not match requested address') }).d)).rejects.toBeInstanceOf(MbiError)
      await expect(applyAgentVc('delegation', {}, deps({ issue: failWith(500, 'boom') }).d)).rejects.toThrow(/HTTP 500/)
      await expect(applyAgentVc('delegation', {}, deps({ issue: async () => { throw new Error('socket hang up') } }).d)).rejects.toThrow('socket hang up')
    })
  })

  it('keeps the only copy in the result when it cannot be saved', async () => {
    const cache = memoryCache([birthcert('my-agent')])
    cache.set = async () => { throw new Error('disk full') }
    const { d } = deps({ cache })
    const r = await applyAgentVc('delegation', {}, d)
    expect(r).toMatchObject({ issued: true, saved: false, vcId: VC_ID })
    expect(r.issued && (r.verifiableCredential as { id: string }).id).toBe(VC_ID)
    expect(r.message).toMatch(/could NOT be saved/)
  })

  it('never fetches the credential back: MBI marks it downloaded and would not give it again', async () => {
    const { d, issue } = deps()
    await applyAgentVc('delegation', {}, d)
    expect(Object.keys(d).filter((k) => /download/i.test(k))).toEqual([])
    expect(issue).toHaveBeenCalledTimes(1)
  })
})

describe('MbiClient.issueAgentVc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  const signer = () => vi.fn().mockResolvedValue({ signBlob: 'sig-hex', publicKey: 'b001pk' })

  it.each(['delegation', 'policy'] as const)('POSTs /v1/vc/ext/agent/%s/issue signed per request and returns the credential', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { status: 200, data: { vcId: VC_ID, verifiableCredential: { id: VC_ID }, extraData: { pass: 1 } } }))
    vi.stubGlobal('fetch', fetchMock)
    const sign = signer()
    const out = await new MbiClient('https://mbi.test/').issueAgentVc(kind, { agentUsername: 'my-agent', purpose: 'x' }, sign)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://mbi.test/v1/vc/ext/agent/${kind}/issue`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ agentUsername: 'my-agent', purpose: 'x' })
    expect(init.headers).toMatchObject({ signedData: 'sig-hex', publicKey: 'b001pk' })
    expect(init.headers.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(sign.mock.calls[0][0]).toMatch(new RegExp(`^POST\\|/v1/vc/ext/agent/${kind}/issue\\|[0-9a-f]{64}\\|`))
    expect(out).toEqual({ vcId: VC_ID, verifiableCredential: { id: VC_ID }, extraData: { pass: 1 } })
  })

  it('throws MbiError with the HTTP status on a refusal, and on a 2xx with no credential', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { status: 409, code: 6002, message: `holds ${VC_ID}` })))
    await expect(new MbiClient('https://mbi.test').issueAgentVc('policy', { agentUsername: 'a' }, signer())).rejects.toMatchObject({ httpStatus: 409 })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200, data: { vcId: VC_ID } })))
    await expect(new MbiClient('https://mbi.test').issueAgentVc('policy', { agentUsername: 'a' }, signer())).rejects.toThrow(/returned no credential/)
  })
})

describe('apply_delegation_vc and apply_policy_vc', () => {
  it('hand the input to the wiring with the right kind', async () => {
    const agentVc = vi.fn().mockResolvedValue({ issued: false })
    const tools = createTools({ agentVc } as unknown as ToolDeps)
    await tools.apply_delegation_vc({ purpose: 'a' })
    await tools.apply_policy_vc({ agentUsername: 'b' })
    expect(agentVc.mock.calls).toEqual([['delegation', { purpose: 'a' }], ['policy', { agentUsername: 'b' }]])
  })

  it('say the wallet is not set up, and send nothing, when the wiring is missing', async () => {
    const tools = createTools({} as unknown as ToolDeps)
    expect(await tools.apply_delegation_vc()).toMatchObject({ issued: false, kind: 'delegation', reason: 'unavailable' })
    expect(await tools.apply_policy_vc({})).toMatchObject({ issued: false, kind: 'policy', reason: 'unavailable' })
  })
})
