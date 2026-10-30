import { describe, it, expect, vi, afterEach } from 'vitest'
import { MbiClient, MbiError, type MbiAgentApplyReply, type MbiVcEntry } from '../clients/mbi-client'
import type { CachedVc, VcCacheStore } from '../clients/vc-cache'
import { applySubAgentPolicyVc, type ApplySubAgentPolicyDeps } from '../orchestrator/sub-agent-policy'
import { downloadPolicyVc, type DownloadPolicyVcDeps } from '../orchestrator/policy-download'
import { createTools, type ToolDeps } from '../mcp-tools'
import { resolveTemplateAlias } from '../template-aliases'

const NOW = new Date('2026-10-23T05:00:00Z')
const NETWORK = 'zetrix:testnet'
const DELEGATION_TEMPLATE = 'did:zid:1724245eb96cb0092c3ae354a68d9e21466aa5ef3e74019f4cfc7554b28cf1a9'
const POLICY_TEMPLATE = 'did:zid:d3e08efbeea484bcb21483b269230f250abb34d097e88ef22059b0aafbce6ce9'
const VERIFIED_TEMPLATE = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
const BASIC_TEMPLATE = resolveTemplateAlias('ai birthcert', NETWORK)!
const VC_ID = `did:zid:${'b'.repeat(64)}`
const HOLDER = 'did:zid:sub-holder'
const SUB_PUBKEY = 'b001subpublickey'

function memoryCache(initial: CachedVc[] = []): VcCacheStore & { entries: Map<string, CachedVc> } {
  const entries = new Map(initial.map((e) => [e.templateId, e]))
  return { entries, get: async (id) => entries.get(id) ?? null, set: async (id, e) => void entries.set(id, e), list: async () => [...entries.values()] }
}
const held = (templateId: string, validUntil = '2027-10-13T00:00:00Z'): CachedVc => ({ templateId, vc: { id: `vc-of-${templateId.slice(-4)}`, validUntil }, issuedAt: '2026-10-01T00:00:00Z', validUntil })

/** The Verified AI Birthcert as the wallet caches it: the name and the owner check are read from it. */
const vBirth = (name = 'my-agent', ownerVerified: string | null = 'true', validUntil = '2027-10-13T00:00:00Z'): CachedVc => ({
  templateId: VERIFIED_TEMPLATE,
  vc: { id: `vc-of-${VERIFIED_TEMPLATE.slice(-4)}`, validUntil, credentialSubject: { id: 'did:zid:me', verifiedAiBirthcert: { agentName: name, ...(ownerVerified !== null ? { ownerVerified } : {}) } } },
  issuedAt: '2026-10-01T00:00:00Z',
  validUntil,
})
/** The main agent's own AI Policy Credential, carrying the name it was issued under. */
const policyOf = (name = 'my-agent', validUntil = '2027-10-13T00:00:00Z'): CachedVc => ({
  ...held(POLICY_TEMPLATE),
  vc: { id: `vc-of-${POLICY_TEMPLATE.slice(-4)}`, validUntil, credentialSubject: { id: 'did:zid:me', aiPolicyCredential: { id: name, agentUsername: name, agentRole: 'main' } } },
  validUntil,
})
/** The delegation credential, carrying the name it was issued under. */
const delegationOf = (name = 'my-agent'): CachedVc => ({
  ...held(DELEGATION_TEMPLATE),
  vc: { id: `vc-of-${DELEGATION_TEMPLATE.slice(-4)}`, validUntil: '2027-10-13T00:00:00Z', credentialSubject: { id: 'did:zid:me', aiDelegationCredential: { id: name, agentUsername: name } } },
})

/** A PROOF-REQUEST header as MBI's x401 service sends it: the claims it asks for are the paths under credential_requirements.query. */
const challenge = (claims: string[] | undefined, nonce = 'n') =>
  Buffer.from(JSON.stringify({ verification_data: { nonce }, credential_requirements: { requirementsId: 'r', query: { credentials: [{ id: 'did:zid:issuer', claims: claims?.map((c) => ({ path: [c] })) }] } } })).toString('base64url')
const REQ_BIRTHCERT = challenge(['agentName', 'ownerVerified'], 'birthcert')
const REQ_DELEGATION = challenge(['agentUsername', 'allowDelegateTransfer', 'maxDelegationDepth'], 'delegation')

describe('applySubAgentPolicyVc', () => {
  const reply = (r: Partial<MbiAgentApplyReply> & { status: number }): MbiAgentApplyReply => r
  const script = (...replies: (MbiAgentApplyReply | Error)[]) => {
    const calls: { bodyText: string; proof?: string }[] = []
    const apply = vi.fn(async (bodyText: string, proof?: string) => {
      calls.push({ bodyText, proof })
      const next = replies[calls.length - 1]
      if (next instanceof Error) throw next
      return next
    })
    return { apply, calls }
  }
  const happy = () => script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 401, proofRequest: REQ_DELEGATION }),
    reply({ status: 200, data: { vcId: VC_ID, holderDid: HOLDER, holderAddress: 'ZTX3sub' } }))

  function setup(over: Partial<ApplySubAgentPolicyDeps> = {}, s = happy()) {
    const cache = memoryCache([vBirth(), delegationOf(), policyOf()])
    const prove = vi.fn(async (req: string, _vc?: unknown, _reveal?: string[]) => ({ proofResponseHeader: `PROOF-FOR-${req}`, verified: true }))
    const deps: ApplySubAgentPolicyDeps = { cache, network: NETWORK, verifiedTemplateId: VERIFIED_TEMPLATE, delegationTemplateId: DELEGATION_TEMPLATE, policyTemplateId: POLICY_TEMPLATE, apply: s.apply, prove, now: () => NOW, ...over }
    return { deps, prove, ...s, cache }
  }
  const input = { subAgentPublicKey: SUB_PUBKEY, agentUsername: 'sub agent 1' }

  it('makes the three calls in order, each with the same body, one proof per call, and returns the vcId without a credential', async () => {
    const { deps, prove, calls } = setup()
    const r = await applySubAgentPolicyVc({ ...input, purpose: 'helper' }, deps)
    expect(r).toMatchObject({ issued: true, vcId: VC_ID, holderDid: HOLDER, holderAddress: 'ZTX3sub' })
    expect(calls.map((c) => c.proof)).toEqual([undefined, `PROOF-FOR-${REQ_BIRTHCERT}`, `PROOF-FOR-${REQ_DELEGATION}`])
    expect(new Set(calls.map((c) => c.bodyText)).size).toBe(1)
    expect(JSON.parse(calls[0].bodyText)).toEqual({ subAgentPublicKey: SUB_PUBKEY, agentUsername: 'sub agent 1', purpose: 'helper' })
    // the birthcert answers the first challenge and the delegation credential the second
    expect(prove.mock.calls.map((c) => [c[0], (c[1] as { id: string }).id])).toEqual([
      [REQ_BIRTHCERT, `vc-of-${VERIFIED_TEMPLATE.slice(-4)}`],
      [REQ_DELEGATION, `vc-of-${DELEGATION_TEMPLATE.slice(-4)}`],
    ])
    expect(r.issued && r.nextStep).toMatch(/download_policy_vc/)
    expect(JSON.stringify(r)).not.toMatch(/verifiableCredential/)
  })

  it('trims the inputs and sends nothing a caller invented', async () => {
    const { deps, calls } = setup()
    await applySubAgentPolicyVc({ subAgentPublicKey: `  ${SUB_PUBKEY} `, agentUsername: ' x ', policyA: 'high', transferMax: 99999 } as never, deps)
    expect(JSON.parse(calls[0].bodyText)).toEqual({ subAgentPublicKey: SUB_PUBKEY, agentUsername: 'x' })
  })

  it.each([
    [{ subAgentPublicKey: ' ', agentUsername: 'a' }, /subAgentPublicKey/],
    [{ subAgentPublicKey: 'k', agentUsername: '' }, /agentUsername/],
  ])('refuses incomplete input %#, and sends nothing', async (bad, words) => {
    const { deps, apply } = setup()
    const r = await applySubAgentPolicyVc(bad, deps)
    expect(r).toMatchObject({ issued: false, reason: 'invalid_request' })
    expect(r.issued === false && r.message).toMatch(words)
    expect(apply).not.toHaveBeenCalled()
  })

  it('needs both credentials before it sends anything', async () => {
    const noBirth = setup({ cache: memoryCache([delegationOf()]) })
    expect(await applySubAgentPolicyVc(input, noBirth.deps)).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    const noDelegation = setup({ cache: memoryCache([vBirth()]) })
    const r = await applySubAgentPolicyVc(input, noDelegation.deps)
    expect(r).toMatchObject({ issued: false, reason: 'needs_delegation' })
    expect(r.issued === false && r.message).toMatch(/apply_delegation_vc/)
    const expired = setup({ cache: memoryCache([vBirth('my-agent', 'true', '2026-01-01T00:00:00Z'), delegationOf()]) })
    expect(await applySubAgentPolicyVc(input, expired.deps)).toMatchObject({ reason: 'needs_birthcert' })
    for (const x of [noBirth, noDelegation, expired]) expect(x.apply).not.toHaveBeenCalled()
  })

  it('says a Basic AI Birthcert alone is not enough, and where the delegation template is not deployed', async () => {
    const basic: CachedVc = { ...held(BASIC_TEMPLATE), vc: { id: 'vc-basic', type: ['VerifiableCredential', 'AI Birthcert'], validUntil: '2027-10-13T00:00:00Z', credentialSubject: { id: 'did:zid:me', aiBirthcert: { agentUsername: 'my-agent' } } } }
    const onlyBasic = setup({ cache: memoryCache([basic, delegationOf()]) })
    const r = await applySubAgentPolicyVc(input, onlyBasic.deps)
    expect(r).toMatchObject({ issued: false, reason: 'needs_birthcert' })
    expect(r.issued === false && r.message).toMatch(/Basic AI Birthcert does not count/)
    expect(onlyBasic.apply).not.toHaveBeenCalled()
    const nowhere = setup({ delegationTemplateId: undefined })
    expect(await applySubAgentPolicyVc(input, nowhere.deps)).toMatchObject({ reason: 'unavailable' })
    expect(nowhere.apply).not.toHaveBeenCalled()
  })

  it('discloses exactly the claims the step needs and nothing else: a fixed list per proof, in the credential\'s own container', async () => {
    const { deps, prove } = setup()
    await applySubAgentPolicyVc(input, deps)
    expect(prove.mock.calls.map((c) => c[2])).toEqual([
      ['verifiedAiBirthcert.agentName', 'verifiedAiBirthcert.ownerVerified'],
      ['aiDelegationCredential.agentUsername', 'aiDelegationCredential.allowDelegateTransfer', 'aiDelegationCredential.maxDelegationDepth'],
    ])
  })

  it('a challenge that asks for only some of the allowed claims discloses only those', async () => {
    const s = script(reply({ status: 401, proofRequest: challenge(['agentName']) }), reply({ status: 401, proofRequest: REQ_DELEGATION }), reply({ status: 200, data: { vcId: VC_ID, holderDid: HOLDER, holderAddress: 'ZTX3sub' } }))
    const { deps, prove } = setup({}, s)
    expect(await applySubAgentPolicyVc(input, deps)).toMatchObject({ issued: true })
    expect(prove.mock.calls[0][2]).toEqual(['verifiedAiBirthcert.agentName'])
  })

  it.each([
    ['the owner\'s name, ID number or date of birth', ['agentName', 'ownerName', 'ownerId', 'dob'], /more than it needs \(ownerName, ownerId, dob\)/],
    ['one claim too many', ['agentName', 'ownerVerified', 'evidenceProvider'], /evidenceProvider/],
    ['no claim at all (which would reveal everything)', [], /no particular claims/],
    ['no claims list', undefined, /no particular claims|cannot read/],
  ] as const)('does not answer a birthcert challenge that asks for %s: nothing is revealed, nothing is sent on', async (_label, claims, words) => {
    const s = script(reply({ status: 401, proofRequest: challenge(claims as string[] | undefined) }))
    const { deps, prove } = setup({}, s)
    const r = await applySubAgentPolicyVc(input, deps)
    expect(r).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(words)
    expect(r.issued === false && r.message).toMatch(/nothing was revealed/)
    expect(prove).not.toHaveBeenCalled()
    expect(s.calls).toHaveLength(1)
  })

  it('does not answer a challenge it cannot read, and refuses a delegation challenge that asks for more as well', async () => {
    const unreadable = setup({}, script(reply({ status: 401, proofRequest: 'not-a-challenge' })))
    expect(await applySubAgentPolicyVc(input, unreadable.deps)).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: false })
    expect(unreadable.prove).not.toHaveBeenCalled()

    const greedy = setup({}, script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 401, proofRequest: challenge(['agentUsername', 'allowDelegateTransfer', 'maxDelegationDepth', 'purpose']) })))
    const r = await applySubAgentPolicyVc(input, greedy.deps)
    expect(r).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(/delegation challenge asks for more than it needs \(purpose\)/)
    expect(greedy.prove).toHaveBeenCalledTimes(1) // only the birthcert proof was made
  })

  it('refuses before anything is sent when the main agent\'s own policy credential was issued under another name, and names that credential', async () => {
    const policy: CachedVc = { ...held(POLICY_TEMPLATE), vc: { id: 'vc-policy', validUntil: '2027-10-13T00:00:00Z', credentialSubject: { id: 'did:zid:me', aiPolicyCredential: { agentUsername: 'jak 0007', agentRole: 'main' } } } }
    const x = setup({ policyTemplateId: POLICY_TEMPLATE, cache: memoryCache([vBirth('owner-agent-02'), delegationOf('owner-agent-02'), policy]) })
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason: 'holder_mismatch', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(/AI Policy Credential/)
    expect(r.issued === false && r.message).toMatch(/jak 0007/)
    expect(x.apply).not.toHaveBeenCalled()
    // the same name passes, and so does a wallet that holds no copy (MBI checks its own records)
    const same = setup({ policyTemplateId: POLICY_TEMPLATE, cache: memoryCache([vBirth('owner-agent-02'), delegationOf('owner-agent-02'), { ...policy, vc: { ...(policy.vc as object), credentialSubject: { id: 'did:zid:me', aiPolicyCredential: { agentUsername: 'owner-agent-02' } } } }]) })
    expect(await applySubAgentPolicyVc(input, same.deps)).toMatchObject({ issued: true })
    // no copy at all is now refused before anything is sent (see the next test)
    const none = setup({ cache: memoryCache([vBirth('owner-agent-02'), delegationOf('owner-agent-02')]) })
    expect(await applySubAgentPolicyVc(input, none.deps)).toMatchObject({ issued: false, reason: 'main_policy_missing' })
  })

  it('refuses before anything is sent when this agent has no policy credential of its own, and says to get it with apply_policy_vc', async () => {
    const x = setup({ cache: memoryCache([vBirth(), delegationOf()]) })
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason: 'main_policy_missing', safeToStartAgain: true })
    expect(r.issued === false && r.message).toMatch(/apply_policy_vc/)
    expect(r.issued === false && r.message).toMatch(/Nothing was sent/)
    // and how to go on when MBI holds a credential the wallet lost
    expect(r.issued === false && r.message).toMatch(/ask the user to confirm[\s\S]*ownPolicyCredentialConfirmedAtMbi: true/)
    expect(x.apply).not.toHaveBeenCalled()
    expect(x.prove).not.toHaveBeenCalled()
  })

  it('an expired policy credential of its own counts as none, and the words say it expired', async () => {
    const x = setup({ cache: memoryCache([vBirth(), delegationOf(), policyOf('my-agent', '2026-01-01T00:00:00Z')]) })
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason: 'main_policy_missing' })
    expect(r.issued === false && r.message).toMatch(/expired/)
    expect(x.apply).not.toHaveBeenCalled()
  })

  it('asks for the delegation credential first when both it and the policy credential are missing', async () => {
    const x = setup({ cache: memoryCache([vBirth()]) })
    expect(await applySubAgentPolicyVc(input, x.deps)).toMatchObject({ issued: false, reason: 'needs_delegation' })
    expect(x.apply).not.toHaveBeenCalled()
  })

  it('does not check the policy credential where its template is not deployed (nothing to look it up by)', async () => {
    const x = setup({ policyTemplateId: undefined, cache: memoryCache([vBirth(), delegationOf()]) })
    expect(await applySubAgentPolicyVc(input, x.deps)).toMatchObject({ issued: true })
  })

  it('needs_delegation and needs_birthcert are safe to start again once fixed: nothing was sent', async () => {
    const noDelegation = setup({ cache: memoryCache([vBirth()]) })
    expect(await applySubAgentPolicyVc(input, noDelegation.deps)).toMatchObject({ reason: 'needs_delegation', safeToStartAgain: true })
    const noBirth = setup({ cache: memoryCache([delegationOf(), policyOf()]) })
    expect(await applySubAgentPolicyVc(input, noBirth.deps)).toMatchObject({ reason: 'needs_birthcert', safeToStartAgain: true })
  })

  describe('ownPolicyCredentialConfirmedAtMbi (the user confirmed that MBI holds a credential the wallet lost)', () => {
    it('lets a missing copy through, so MBI decides as before, and the flag is never sent to MBI', async () => {
      const x = setup({ cache: memoryCache([vBirth(), delegationOf()]) })
      const r = await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: true }, x.deps)
      expect(r).toMatchObject({ issued: true })
      expect(x.calls).toHaveLength(3)
      for (const c of x.calls) expect(c.bodyText).not.toMatch(/ownPolicy|confirmed/i)
    })

    it('lets an expired copy through as well', async () => {
      const x = setup({ cache: memoryCache([vBirth(), delegationOf(), policyOf('my-agent', '2026-01-01T00:00:00Z')]) })
      expect(await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: true }, x.deps)).toMatchObject({ issued: true })
    })

    it.each([['"true"', 'true'], ['1', 1], ['false', false], ['"yes"', 'yes']])('only the boolean true opens it: %s does not', async (_label, value) => {
      const x = setup({ cache: memoryCache([vBirth(), delegationOf()]) })
      const r = await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: value as never }, x.deps)
      expect(r).toMatchObject({ issued: false, reason: 'main_policy_missing' })
      expect(x.apply).not.toHaveBeenCalled()
    })

    it('does not bypass a copy that names another agent: that mismatch is still caught before anything is sent', async () => {
      const x = setup({ cache: memoryCache([vBirth('owner-agent-02'), delegationOf('owner-agent-02'), policyOf('jak 0007')]) })
      const r = await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: true }, x.deps)
      expect(r).toMatchObject({ issued: false, reason: 'holder_mismatch' })
      expect(x.apply).not.toHaveBeenCalled()
    })

    it('does not bypass the delegation credential or the Verified birthcert', async () => {
      const noDelegation = setup({ cache: memoryCache([vBirth()]) })
      expect(await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: true }, noDelegation.deps)).toMatchObject({ reason: 'needs_delegation' })
      const noBirth = setup({ cache: memoryCache([delegationOf()]) })
      expect(await applySubAgentPolicyVc({ ...input, ownPolicyCredentialConfirmedAtMbi: true }, noBirth.deps)).toMatchObject({ reason: 'needs_birthcert' })
    })
  })

  it('a saved policy credential with no expiry counts as held, as it does for every other credential', async () => {
    const noExpiry: CachedVc = { ...policyOf(), validUntil: undefined }
    const x = setup({ cache: memoryCache([vBirth(), delegationOf(), noExpiry]) })
    expect(await applySubAgentPolicyVc(input, x.deps)).toMatchObject({ issued: true })
  })

  it('WRONG_CREDENTIAL is not safe to start again, and the words do not say it is', async () => {
    const { deps } = setup({}, script(reply({ status: 403, code: 'WRONG_CREDENTIAL' })))
    const r = await applySubAgentPolicyVc(input, deps)
    expect(r).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(/Do not retry/)
    expect(r.issued === false && r.message).not.toMatch(/started again/)
  })

  it.each([['"false"', 'false'], ['missing', null]] as const)('refuses a Verified AI Birthcert whose ownerVerified is %s, before anything is sent', async (_label, ownerVerified) => {
    const x = setup({ cache: memoryCache([vBirth('my-agent', ownerVerified), delegationOf()]) })
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason: 'owner_not_verified', safeToStartAgain: true })
    expect(r.issued === false && r.message).toMatch(/ownerVerified/)
    expect(x.apply).not.toHaveBeenCalled()
    expect(x.prove).not.toHaveBeenCalled()
  })

  it('refuses before anything is sent when the delegation credential was issued under another name than the Verified birthcert (the old Basic rule)', async () => {
    const x = setup({ cache: memoryCache([vBirth('owner-agent-02'), delegationOf('jak 0007'), policyOf('owner-agent-02')]) })
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason: 'holder_mismatch', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(/jak 0007/)
    expect(r.issued === false && r.message).toMatch(/owner-agent-02/)
    expect(r.issued === false && r.message).toMatch(/revoked and issued again/)
    expect(x.apply).not.toHaveBeenCalled()
    expect(x.prove).not.toHaveBeenCalled()
  })

  it('compares the names with their ends trimmed, as MBI does', async () => {
    const x = setup({ cache: memoryCache([vBirth('  my-agent '), delegationOf('my-agent '), policyOf('my-agent ')]) })
    expect(await applySubAgentPolicyVc(input, x.deps)).toMatchObject({ issued: true })
  })

  it.each([
    [{ status: 403, code: 'OWNER_NOT_VERIFIED' }, 'owner_not_verified', /ownerVerified/],
    [{ status: 403, code: 'WRONG_CREDENTIAL' }, 'proof_refused', /Basic AI Birthcert does not count/],
    [{ status: 422, mbiStatus: 6004 }, 'needs_birthcert', /valid Verified AI Birthcert/],
    [{ status: 422, mbiStatus: 6005 }, 'holder_mismatch', /AI Policy Credential/],
  ] as const)('the new MBI refusal %j becomes %s, safe never to retry', async (answer, reason, words) => {
    const x = setup({}, script(reply({ ...answer })))
    const r = await applySubAgentPolicyVc(input, x.deps)
    expect(r).toMatchObject({ issued: false, reason, safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(words)
    expect(x.apply).toHaveBeenCalledTimes(1)
  })

  it('an expirationDate that is not a real, future YYYY-MM-DD is refused before anything is sent', async () => {
    for (const expirationDate of ['2026-02-30', '23-10-2027', 'next year', '2026-10-01']) {
      const { deps, calls, prove } = setup()
      const r = await applySubAgentPolicyVc({ ...input, expirationDate }, deps)
      expect(r).toMatchObject({ issued: false, reason: 'invalid_request', safeToStartAgain: true })
      expect(calls).toHaveLength(0)
      expect(prove).not.toHaveBeenCalled()
    }
  })

  it('stops at once when MBI does not ask for a proof, and never repeats a call', async () => {
    const s = script(reply({ status: 404 }))
    const { deps, prove } = setup({}, s)
    expect(await applySubAgentPolicyVc(input, deps)).toMatchObject({ issued: false, reason: 'main_policy_missing', safeToStartAgain: false })
    expect(s.apply).toHaveBeenCalledTimes(1)
    expect(prove).not.toHaveBeenCalled()
  })

  it.each([
    ['400 invalid', reply({ status: 400, message: 'subAgentPublicKey: bad' }), 'invalid_request', true],
    ['409', reply({ status: 409 }), 'sub_agent_has_one', false],
    ['429', reply({ status: 429 }), 'rate_limited', false],
    ['503', reply({ status: 503 }), 'service_unavailable', true],
    ['403 holders differ', reply({ status: 403, code: 'HOLDER_MISMATCH' }), 'holder_mismatch', false],
    ['403 replay', reply({ status: 403, code: 'REPLAY_DETECTED' }), 'proof_refused', true],
  ] as const)('call 3 answered %s -> %s (safe to start again: %s)', async (_n, last, reason, safe) => {
    const s = script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 401, proofRequest: REQ_DELEGATION }), last)
    const r = await applySubAgentPolicyVc(input, setup({}, s).deps)
    expect(r).toMatchObject({ issued: false, reason })
    expect(r.issued === false && r.safeToStartAgain).toBe(safe)
    expect(s.apply).toHaveBeenCalledTimes(3)
  })

  it('a refused proof ends the attempt and says to start from the beginning', async () => {
    const s = script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 403, code: 'PROOF_NOT_VERIFIED' }))
    const r = await applySubAgentPolicyVc(input, setup({}, s).deps)
    expect(r).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: true })
    expect(s.apply).toHaveBeenCalledTimes(2)
  })

  it('a proof the wallet cannot make, or the verifier does not accept, ends the attempt without asking MBI again', async () => {
    const throwing = setup({ prove: async () => { throw new Error('this challenge has already been answered') } })
    const r1 = await applySubAgentPolicyVc(input, throwing.deps)
    expect(r1).toMatchObject({ issued: false, reason: 'proof_refused', safeToStartAgain: true })
    expect(r1.issued === false && r1.message).toMatch(/already been answered/)
    expect(throwing.apply).toHaveBeenCalledTimes(1)

    const rejected = setup({ prove: async () => ({ proofResponseHeader: 'H', verified: false }) })
    expect(await applySubAgentPolicyVc(input, rejected.deps)).toMatchObject({ issued: false, reason: 'proof_refused' })
    expect(rejected.apply).toHaveBeenCalledTimes(1)
  })

  it('a lost answer to the last call is "may have been issued, do not apply again"; before that it is safe to start again', async () => {
    const lostLast = script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 401, proofRequest: REQ_DELEGATION }), new MbiError('socket hang up'))
    const r = await applySubAgentPolicyVc(input, setup({}, lostLast).deps)
    expect(r).toMatchObject({ issued: false, reason: 'unexpected', safeToStartAgain: false })
    expect(r.issued === false && r.message).toMatch(/do not apply again/)

    const lostFirst = script(new MbiError('socket hang up'))
    expect(await applySubAgentPolicyVc(input, setup({}, lostFirst).deps)).toMatchObject({ reason: 'service_unavailable', safeToStartAgain: true })
  })

  it('a success with no vcId is not treated as success and is not retried', async () => {
    const s = script(reply({ status: 401, proofRequest: REQ_BIRTHCERT }), reply({ status: 401, proofRequest: REQ_DELEGATION }), reply({ status: 200, data: {} }))
    const r = await applySubAgentPolicyVc(input, setup({}, s).deps)
    expect(r).toMatchObject({ issued: false, reason: 'unexpected', safeToStartAgain: false })
  })

  it('does not download anything: the main agent never holds the sub-agent credential', () => {
    const { deps } = setup()
    expect(Object.keys(deps).filter((k) => /download/i.test(k))).toEqual([])
  })
})

describe('downloadPolicyVc', () => {
  const policyVc = { id: VC_ID, type: ['VerifiableCredential', 'AI Policy Credential'], validUntil: '2027-10-23T00:00:00Z',
    credentialSubject: { id: HOLDER, aiPolicyCredential: { agentUsername: 'sub agent 1', agentRole: 'sub', policyA: 'low', transferMax: 5, transferCurrency: 'JMYR', delegatedBy: 'jak-0007' } } }
  function setup(over: Partial<DownloadPolicyVcDeps> = {}, cache = memoryCache()) {
    const download = vi.fn(async (_b: { address: string; vcId: string }): Promise<MbiVcEntry[]> => [{ vc: policyVc }])
    const sign = vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'p' })
    const deps: DownloadPolicyVcDeps = { cache, policyTemplateId: POLICY_TEMPLATE, address: 'ZTX3sub', holderDid: HOLDER, download, sign, now: () => NOW, ...over }
    return { deps, download, sign, cache }
  }

  it('downloads only the credential named, for this wallet\'s own address, and saves it under the policy template', async () => {
    const { deps, download, sign, cache } = setup()
    const r = await downloadPolicyVc({ vcId: ` ${VC_ID} ` }, deps)
    expect(download).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith({ address: 'ZTX3sub', vcId: VC_ID }, sign)
    expect(r).toMatchObject({ downloaded: true, vcId: VC_ID, templateId: POLICY_TEMPLATE, saved: true, validUntil: '2027-10-23T00:00:00Z' })
    expect(r.downloaded && r.attributes).toMatchObject({ agentRole: 'sub', transferMax: 5, delegatedBy: 'jak-0007' })
    expect(cache.entries.get(POLICY_TEMPLATE)).toMatchObject({ vcId: VC_ID, templateId: POLICY_TEMPLATE })
  })

  it('has no address input: whatever address is passed is not used', async () => {
    const { deps, download } = setup()
    await downloadPolicyVc({ vcId: VC_ID, address: 'ZTX3someoneElse' } as never, deps)
    expect(download.mock.calls[0][0].address).toBe('ZTX3sub')
  })

  it.each(['', 'did:zid:short', 'not-a-vcid', `${VC_ID}x`])('does not spend the one download on a malformed vcId %j', async (bad) => {
    const { deps, download } = setup()
    expect(await downloadPolicyVc({ vcId: bad }, deps)).toMatchObject({ downloaded: false, reason: 'invalid_request' })
    expect(download).not.toHaveBeenCalled()
  })

  it('refuses before downloading when a valid policy credential is already held, because the cache would replace it', async () => {
    const { deps, download, cache } = setup({}, memoryCache([held(POLICY_TEMPLATE)]))
    const r = await downloadPolicyVc({ vcId: VC_ID }, deps)
    expect(r).toMatchObject({ downloaded: false, reason: 'already_held' })
    expect(download).not.toHaveBeenCalled()
    expect(cache.entries.get(POLICY_TEMPLATE)!.vc).toMatchObject({ id: `vc-of-${POLICY_TEMPLATE.slice(-4)}` })
    // an expired one does not count
    const expired = setup({}, memoryCache([held(POLICY_TEMPLATE, '2026-01-01T00:00:00Z')]))
    expect(await downloadPolicyVc({ vcId: VC_ID }, expired.deps)).toMatchObject({ downloaded: true })
  })

  it('says so, and sends nothing, where the policy template is not deployed', async () => {
    const { deps, download } = setup({ policyTemplateId: undefined })
    expect(await downloadPolicyVc({ vcId: VC_ID }, deps)).toMatchObject({ reason: 'unavailable' })
    expect(download).not.toHaveBeenCalled()
  })

  describe('what MBI can answer', () => {
    const failWith = (status: number | undefined) => async (): Promise<never> => { throw new MbiError(`MBI vc/ext/download failed${status ? ` — HTTP ${status}` : ''}`, status) }
    it.each([
      [404, 'not_available', /once/],
      [429, 'rate_limited', /do not retry now/],
      [403, 'refused', /address/],
      [401, 'refused', /signed request/],
      [500, 'outcome_unknown', /Do not call this again/],
      [503, 'outcome_unknown', /Do not call this again/],
      [200, 'outcome_unknown', /could not be read/],
    ] as const)('HTTP %i -> %s', async (status, reason, words) => {
      const r = await downloadPolicyVc({ vcId: VC_ID }, setup({ download: failWith(status) }).deps)
      expect(r).toMatchObject({ downloaded: false, reason })
      expect(r.downloaded === false && r.message).toMatch(words)
    })

    it('a lost answer is "outcome unknown, do not call again", never a failure to retry', async () => {
      const r = await downloadPolicyVc({ vcId: VC_ID }, setup({ download: failWith(undefined) }).deps)
      expect(r).toMatchObject({ downloaded: false, reason: 'outcome_unknown' })
      expect(r.downloaded === false && r.message).toMatch(/Do not call this again/)
    })

    it('anything else is thrown', async () => {
      await expect(downloadPolicyVc({ vcId: VC_ID }, setup({ download: failWith(418) }).deps)).rejects.toBeInstanceOf(MbiError)
      await expect(downloadPolicyVc({ vcId: VC_ID }, setup({ download: async () => { throw new Error('boom') } }).deps)).rejects.toThrow('boom')
    })
  })

  it('does not save a credential that is not this wallet\'s policy credential, and says so', async () => {
    const other = setup({ download: async () => [{ vc: { ...policyVc, credentialSubject: { ...policyVc.credentialSubject, id: 'did:zid:someone-else' } } }] })
    expect(await downloadPolicyVc({ vcId: VC_ID }, other.deps)).toMatchObject({ downloaded: false, reason: 'unexpected' })
    expect(other.cache.entries.size).toBe(0)
    const wrongType = setup({ download: async () => [{ vc: { ...policyVc, type: ['VerifiableCredential', 'AI Birthcert'] } }] })
    expect(await downloadPolicyVc({ vcId: VC_ID }, wrongType.deps)).toMatchObject({ reason: 'unexpected' })
    const missing = setup({ download: async () => [{ vc: { ...policyVc, id: `did:zid:${'c'.repeat(64)}` } }] })
    expect(await downloadPolicyVc({ vcId: VC_ID }, missing.deps)).toMatchObject({ reason: 'unexpected' })
  })

  it('keeps the only copy in the result when it cannot be saved', async () => {
    const cache = memoryCache()
    cache.set = async () => { throw new Error('disk full') }
    const r = await downloadPolicyVc({ vcId: VC_ID }, setup({}, cache).deps)
    expect(r).toMatchObject({ downloaded: true, saved: false })
    expect(r.downloaded && (r.verifiableCredential as { id: string }).id).toBe(VC_ID)
  })
})

describe('MbiClient.applyAgentPolicy', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  })

  it('carries the MBI number (not only the HTTP status) on a refusal (6004, 6005), beside the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(422, { status: 6005, message: 'name differs' })))
    expect(await new MbiClient('https://mbi.test').applyAgentPolicy('{}')).toEqual({ status: 422, mbiStatus: 6005, message: 'name differs' })
    // a body that only repeats the HTTP status adds nothing
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(404, { status: 404, message: 'nope' })))
    expect(await new MbiClient('https://mbi.test').applyAgentPolicy('{}')).toEqual({ status: 404, message: 'nope' })
  })

  it('POSTs the body as given, with no signed headers, and the proof only when there is one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(401, { verification_data: {} }, { 'proof-request': 'REQ' }))
      .mockResolvedValueOnce(res(200, { status: 200, data: { vcId: VC_ID, holderDid: HOLDER, holderAddress: 'ZTX3sub' } }))
    vi.stubGlobal('fetch', fetchMock)
    const mbi = new MbiClient('https://mbi.test/')
    const a = await mbi.applyAgentPolicy('{"k":1}')
    const b = await mbi.applyAgentPolicy('{"k":1}', 'PROOF')
    expect(a).toEqual({ status: 401, proofRequest: 'REQ' })
    expect(b).toEqual({ status: 200, data: { vcId: VC_ID, holderDid: HOLDER, holderAddress: 'ZTX3sub' } })
    const [url1, init1] = fetchMock.mock.calls[0]
    const [, init2] = fetchMock.mock.calls[1]
    expect(url1).toBe('https://mbi.test/v1/vc/x401/agent-policy/apply')
    expect(init1.body).toBe('{"k":1}')
    expect(init1.headers['PROOF-RESPONSE']).toBeUndefined()
    expect(init2.headers['PROOF-RESPONSE']).toBe('PROOF')
    for (const h of ['signedData', 'publicKey', 'timestamp']) expect(init1.headers[h]).toBeUndefined()
  })

  it('returns a refusal with its code and message instead of throwing, and an empty body as just a status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(res(403, { code: 'REPLAY_DETECTED', message: 'The proof was refused' })).mockResolvedValueOnce(res(500, '')))
    const mbi = new MbiClient('https://mbi.test')
    expect(await mbi.applyAgentPolicy('{}', 'P')).toEqual({ status: 403, code: 'REPLAY_DETECTED', message: 'The proof was refused' })
    expect(await mbi.applyAgentPolicy('{}', 'P')).toEqual({ status: 500 })
  })

  it('throws MbiError on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(new MbiClient('https://mbi.test').applyAgentPolicy('{}')).rejects.toBeInstanceOf(MbiError)
  })
})

describe('apply_sub_agent_policy_vc and download_policy_vc tools', () => {
  it('give the application a prove function that answers with prove_identity and nothing else', async () => {
    const subAgentPolicy = vi.fn(async (_i: unknown, prove: (r: string, vc: unknown, reveal: string[]) => Promise<unknown>) => {
      const p = await prove('REQ', { id: 'vc' }, ['verifiedAiBirthcert.agentName', 'verifiedAiBirthcert.ownerVerified'])
      return { issued: false, reason: 'unexpected', message: JSON.stringify(p), safeToStartAgain: true }
    })
    const makeWallet = vi.fn(() => ({ respondToChallenge: async () => ({ headerValue: 'HDR', verified: true, presentationId: 'p1' }) }))
    const tools = createTools({ subAgentPolicy, makeWallet, config: { holderDid: 'did:zid:me', zetrixAddress: 'ZTX3me', network: NETWORK } } as unknown as ToolDeps)
    const r = await tools.apply_sub_agent_policy_vc({ subAgentPublicKey: 'k', agentUsername: 'u' })
    expect(subAgentPolicy).toHaveBeenCalledTimes(1)
    expect((r as { message: string }).message).toBe(JSON.stringify({ proofResponseHeader: 'HDR', verified: true }))
    // the disclosure is the fixed list the step gave, not whatever the challenge names
    expect(makeWallet).toHaveBeenCalledWith(expect.objectContaining({ vc: { id: 'vc' }, revealAttribute: ['verifiedAiBirthcert.agentName', 'verifiedAiBirthcert.ownerVerified'] }))
  })

  it('say the wallet is not set up, and send nothing, when the wiring is missing', async () => {
    const tools = createTools({} as unknown as ToolDeps)
    expect(await tools.apply_sub_agent_policy_vc({ subAgentPublicKey: 'k', agentUsername: 'u' })).toMatchObject({ issued: false, reason: 'unavailable' })
    expect(await tools.download_policy_vc({ vcId: VC_ID })).toMatchObject({ downloaded: false, reason: 'unavailable' })
  })

  it('download_policy_vc hands only the vcId to the wiring', async () => {
    const policyDownload = vi.fn().mockResolvedValue({ downloaded: false })
    await createTools({ policyDownload } as unknown as ToolDeps).download_policy_vc({ vcId: VC_ID })
    expect(policyDownload).toHaveBeenCalledWith({ vcId: VC_ID })
  })
})
