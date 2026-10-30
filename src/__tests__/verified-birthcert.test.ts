import { describe, it, expect } from 'vitest'
import type { CachedVc, VcCacheStore } from '../clients/vc-cache'
import { readVerifiedBirthcert, verifiedBirthcertProblem, subjectAttributes, subjectContainerKey } from '../orchestrator/verified-birthcert'

const TEMPLATE = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
const NOW = new Date('2026-10-28T05:00:00Z')

const entry = (attributes: Record<string, unknown>, validUntil = '2027-10-13T00:00:00Z'): CachedVc => ({
  templateId: TEMPLATE,
  vc: { credentialSubject: { id: 'did:zid:me', verifiedAiBirthcert: attributes } },
  issuedAt: '2026-10-01T00:00:00Z',
  validUntil,
})
const cacheOf = (...entries: CachedVc[]): VcCacheStore => {
  const m = new Map(entries.map((e) => [e.templateId, e]))
  return { get: async (id) => m.get(id) ?? null, set: async () => undefined, list: async () => [...m.values()] }
}

describe('readVerifiedBirthcert', () => {
  it('returns the credential and its agentName, trimmed, when the owner is verified', async () => {
    const e = entry({ agentName: '  owner-agent-02 ', ownerVerified: 'true' })
    expect(await readVerifiedBirthcert(cacheOf(e), TEMPLATE, NOW)).toEqual({ kind: 'ok', vc: e.vc, agentName: 'owner-agent-02' })
  })

  it('is missing when there is no template id, none cached, an expired one, or a cache that cannot be read', async () => {
    expect(await readVerifiedBirthcert(cacheOf(entry({ agentName: 'a', ownerVerified: 'true' })), undefined, NOW)).toEqual({ kind: 'missing' })
    expect(await readVerifiedBirthcert(cacheOf(), TEMPLATE, NOW)).toEqual({ kind: 'missing' })
    expect(await readVerifiedBirthcert(cacheOf(entry({ agentName: 'a', ownerVerified: 'true' }, '2026-01-01T00:00:00Z')), TEMPLATE, NOW)).toEqual({ kind: 'missing' })
    const broken: VcCacheStore = { get: async () => { throw new Error('disk gone') }, set: async () => undefined, list: async () => [] }
    expect(await readVerifiedBirthcert(broken, TEMPLATE, NOW)).toEqual({ kind: 'missing' })
  })

  it.each([['"false"', { agentName: 'a', ownerVerified: 'false' }], ['missing', { agentName: 'a' }], ['a boolean true (MBI wants the string)', { agentName: 'a', ownerVerified: true }]])(
    'is owner_not_verified when ownerVerified is %s',
    async (_label, attributes) => {
      expect(await readVerifiedBirthcert(cacheOf(entry(attributes)), TEMPLATE, NOW)).toEqual({ kind: 'owner_not_verified', agentName: 'a' })
    },
  )

  it('reads the named verifiedAiBirthcert container: a credential that carries its attributes anywhere else is not a Verified AI Birthcert', async () => {
    const elsewhere: CachedVc = { templateId: TEMPLATE, vc: { credentialSubject: { id: 'did:zid:me', aiBirthcert: { agentName: 'a', ownerVerified: 'true' } } }, issuedAt: '2026-10-01T00:00:00Z', validUntil: '2027-10-13T00:00:00Z' }
    expect(await readVerifiedBirthcert(cacheOf(elsewhere), TEMPLATE, NOW)).toEqual({ kind: 'missing' })
  })

  it('is no_name when the owner is verified but no agentName is there', async () => {
    expect(await readVerifiedBirthcert(cacheOf(entry({ ownerVerified: 'true' })), TEMPLATE, NOW)).toEqual({ kind: 'no_name' })
    expect(await readVerifiedBirthcert(cacheOf(entry({ agentName: '   ', ownerVerified: 'true' })), TEMPLATE, NOW)).toEqual({ kind: 'no_name' })
  })
})

describe('verifiedBirthcertProblem', () => {
  it.each(['missing', 'owner_not_verified', 'no_name'] as const)('says what is needed, that the Basic one does not count, and how to get a Verified one (%s)', (kind) => {
    const text = verifiedBirthcertProblem({ kind } as never, 'The sub-agent step')
    expect(text).toMatch(/^The sub-agent step needs/)
    expect(text).toMatch(/Basic AI Birthcert does not count/)
    expect(text).toMatch(/request_ai_birthcert_verification/)
    // the verification has a fee: the agent is told to ask the user first
    expect(text).toMatch(/ask the user whether they want one/)
    expect(text).toMatch(/only if they say yes/)
  })
})

describe('subjectAttributes', () => {
  it('reads the first object under credentialSubject, and nothing from anything else', () => {
    expect(subjectAttributes({ credentialSubject: { id: 'x', box: { a: 1 } } })).toEqual({ a: 1 })
    expect(subjectAttributes({ credentialSubject: { id: 'x' } })).toEqual({})
    expect(subjectAttributes(undefined)).toEqual({})
  })
})

describe('subjectContainerKey', () => {
  it('is the key of the first object under credentialSubject, for dotted reveal paths', () => {
    expect(subjectContainerKey({ credentialSubject: { id: 'x', aiDelegationCredential: { a: 1 } } })).toBe('aiDelegationCredential')
    expect(subjectContainerKey({ credentialSubject: { id: 'x' } })).toBeUndefined()
    expect(subjectContainerKey(undefined)).toBeUndefined()
  })
})
