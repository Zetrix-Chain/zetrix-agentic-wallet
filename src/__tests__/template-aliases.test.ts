import { describe, it, expect } from 'vitest'
import { resolveTemplateAlias, deriveTemplateAttributes, validateTemplateAttributes, resolvePassDesignId, isVerifiedAiBirthcertName, aiBirthcertKindOfName } from '../template-aliases'

const TESTNET_ID = 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959'
const MAINNET_ID = 'did:zid:19091d19049abb8869b4b8e2f4a887bd1d1d86e5f5ebd0c8297000255f67765b'
const BIRTHCERT_TESTNET_PASS_DESIGN_ID = 'did:zid:bb7202482ef6053be6d46ad8e2190b0ba1e3b2024d24ce7f37bc4c3747e2378f'
const BIRTHCERT_MAINNET_PASS_DESIGN_ID = 'did:zid:915955cb71c6fd2a256d04344f57381084903cb6a85a1c9ddb71c746f08932ab'

describe('resolveTemplateAlias', () => {
  it('resolves "AI Birthcert" to the testnet id on a testnet network', () => {
    expect(resolveTemplateAlias('AI Birthcert', 'zetrix:testnet')).toBe(TESTNET_ID)
  })

  it('resolves "ai-birthcert" to the mainnet id on a mainnet network', () => {
    expect(resolveTemplateAlias('ai-birthcert', 'zetrix:mainnet')).toBe(MAINNET_ID)
  })

  it('resolves "birth cert" (space-separated) to the testnet id', () => {
    expect(resolveTemplateAlias('birth cert', 'zetrix:testnet')).toBe(TESTNET_ID)
  })

  it('resolves "Birth Certificate" (longer phrasing) to the testnet id', () => {
    expect(resolveTemplateAlias('Birth Certificate', 'zetrix:testnet')).toBe(TESTNET_ID)
  })

  it('resolves "AI_BIRTH_CERT" (underscore-separated, upper case) to the testnet id', () => {
    expect(resolveTemplateAlias('AI_BIRTH_CERT', 'zetrix:testnet')).toBe(TESTNET_ID)
  })

  it('passes through a raw did:zid:... input unresolved (returns undefined)', () => {
    expect(resolveTemplateAlias('did:zid:someOtherTemplate', 'zetrix:testnet')).toBeUndefined()
  })

  it('returns undefined for an unrelated string with no matching alias', () => {
    expect(resolveTemplateAlias('agent-identity', 'zetrix:testnet')).toBeUndefined()
  })

  it('treats a network string without "testnet" as mainnet', () => {
    expect(resolveTemplateAlias('AI Birthcert', 'zetrix:mainnet')).toBe(MAINNET_ID)
  })
})

describe('resolvePassDesignId', () => {
  it('resolves the Basic Birthcert testnet pass design id from the alias name', () => {
    expect(resolvePassDesignId('AI Birthcert', 'zetrix:testnet')).toBe(BIRTHCERT_TESTNET_PASS_DESIGN_ID)
  })

  it('resolves the Basic Birthcert mainnet pass design id from the alias name', () => {
    expect(resolvePassDesignId('AI Birthcert', 'zetrix:mainnet')).toBe(BIRTHCERT_MAINNET_PASS_DESIGN_ID)
  })

  it('resolves it from the already-resolved raw testnet templateId too', () => {
    expect(resolvePassDesignId(TESTNET_ID, 'zetrix:testnet')).toBe(BIRTHCERT_TESTNET_PASS_DESIGN_ID)
  })

  it('resolves it from the already-resolved raw mainnet templateId too', () => {
    expect(resolvePassDesignId(MAINNET_ID, 'zetrix:mainnet')).toBe(BIRTHCERT_MAINNET_PASS_DESIGN_ID)
  })

  it('returns undefined for a templateId that is not the Basic Birthcert (no passDesignId for other templates)', () => {
    expect(resolvePassDesignId('did:zid:someOtherTemplate', 'zetrix:testnet')).toBeUndefined()
    expect(resolvePassDesignId('agent-identity', 'zetrix:testnet')).toBeUndefined()
  })
})

describe('deriveTemplateAttributes', () => {
  it('copies agentUsername into id for the birthcert alias when id is not supplied', () => {
    const out = deriveTemplateAttributes('AI Birthcert', 'zetrix:testnet', { agentUsername: 'agent-007' })
    expect(out).toEqual({ agentUsername: 'agent-007', id: 'agent-007' })
  })

  it('copies agentUsername into id when templateId is already the raw did:zid:...', () => {
    const out = deriveTemplateAttributes(TESTNET_ID, 'zetrix:testnet', { agentUsername: 'agent-007' })
    expect(out).toEqual({ agentUsername: 'agent-007', id: 'agent-007' })
  })

  it('does not overwrite a caller-supplied id', () => {
    const out = deriveTemplateAttributes('AI Birthcert', 'zetrix:testnet', { agentUsername: 'agent-007', id: 'custom-id' })
    expect(out).toEqual({ agentUsername: 'agent-007', id: 'custom-id' })
  })

  it('leaves id unset when agentUsername is not supplied', () => {
    const out = deriveTemplateAttributes('AI Birthcert', 'zetrix:testnet', { name: 'x' })
    expect(out).toEqual({ name: 'x' })
  })

  it('is a no-op for a templateId with no matching entry', () => {
    const attrs = { agentUsername: 'agent-007' }
    expect(deriveTemplateAttributes('did:zid:someOtherTemplate', 'zetrix:testnet', attrs)).toEqual(attrs)
  })
})

describe('validateTemplateAttributes', () => {
  it('returns no errors when dob and countryOfOrigin are omitted (both optional)', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { agentUsername: 'x' })).toEqual([])
  })

  it('accepts a valid dob in YYYY-MM-DD format', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { dob: '1990-05-17' })).toEqual([])
  })

  it('rejects a dob in the wrong format', () => {
    const errors = validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { dob: '17/05/1990' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/YYYY-MM-DD/)
  })

  it('rejects a dob that is not a real calendar date', () => {
    const errors = validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { dob: '2023-02-30' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/not a valid calendar date/)
  })

  it('accepts countryOfOrigin as an ISO alpha-2 code', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { countryOfOrigin: 'MY' })).toEqual([])
  })

  it('accepts countryOfOrigin as an ISO alpha-3 code', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { countryOfOrigin: 'MYS' })).toEqual([])
  })

  it('accepts countryOfOrigin as a full country name, case-insensitively', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { countryOfOrigin: 'malaysia' })).toEqual([])
  })

  it('accepts a common informal country name', () => {
    expect(validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { countryOfOrigin: 'USA' })).toEqual([])
  })

  it('rejects an unrecognized countryOfOrigin', () => {
    const errors = validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { countryOfOrigin: 'Narnia' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/ISO 3166/)
  })

  it('reports both dob and countryOfOrigin errors together', () => {
    const errors = validateTemplateAttributes('AI Birthcert', 'zetrix:testnet', { dob: 'bad', countryOfOrigin: 'Narnia' })
    expect(errors).toHaveLength(2)
  })

  it('is a no-op for a templateId with no matching entry', () => {
    expect(validateTemplateAttributes('did:zid:someOtherTemplate', 'zetrix:testnet', { dob: 'bad' })).toEqual([])
  })
})

// "Verified AI Birthcert" contains "birthcert", so it resolved to the BASIC template.
describe('a Verified AI Birthcert name never resolves to the Basic template', () => {
  it.each(['Verified AI Birthcert', 'verified_ai_birthcert', 'verified birthcert', 'VERIFIED-AI-BIRTH-CERT', 'AI Birthcert (Verified)'])(
    '%s is the Verified one and does not resolve to the Basic template',
    (name) => {
      expect(isVerifiedAiBirthcertName(name)).toBe(true)
      expect(resolveTemplateAlias(name, 'zetrix:testnet')).toBeUndefined()
    },
  )

  it.each(['AI Birthcert', 'Basic AI Birthcert', 'ai-birthcert', 'non-verified AI Birthcert', 'unverified birthcert', 'not verified birthcert'])(
    '%s is not the Verified one and still resolves to the Basic template',
    (name) => {
      expect(isVerifiedAiBirthcertName(name)).toBe(false)
      expect(resolveTemplateAlias(name, 'zetrix:testnet')).toBe(TESTNET_ID)
    },
  )

  it('a raw did:zid id and an unrelated name are not the Verified one', () => {
    expect(isVerifiedAiBirthcertName(TESTNET_ID)).toBe(false)
    expect(isVerifiedAiBirthcertName('verified passport')).toBe(false)
  })
})

// verification wording means Verified; negated or self-declared wording means Basic.
describe('the Verified name check reads verification wording and negation', () => {
  it.each(['birthcert verification', 'AI Birthcert (verify with MyDigital ID)', 'MyDigital ID AI Birthcert', 'MyID verified birthcert'])(
    '%s is the Verified one',
    (name) => {
      expect(isVerifiedAiBirthcertName(name)).toBe(true)
      expect(resolveTemplateAlias(name, 'zetrix:testnet')).toBeUndefined()
    },
  )

  it.each([
    'AI Birthcert, not yet verified',
    'AI Birthcert not MyDigital ID verified',
    'self-verified birthcert',
    'self-declared AI Birthcert',
    'AI Birthcert without verification',
  ])('%s is not the Verified one', (name) => {
    expect(isVerifiedAiBirthcertName(name)).toBe(false)
    expect(resolveTemplateAlias(name, 'zetrix:testnet')).toBe(TESTNET_ID)
  })
})

// an earlier change re-review follow-up: a name with both kinds of wording is unclear, not Basic.
describe('aiBirthcertKindOfName', () => {
  it.each([
    // R3: a negator cancels the word after it, Basic wording too, so these say Verified twice over.
    ['Verified AI Birthcert, not the basic one', 'verified'],
    ['Verified AI Birthcert (not self-declared)', 'verified'],
    ['AI Birthcert, not self-declared but verified', 'verified'],
    ['Verified basic AI Birthcert', 'unclear'],
    ['AI Birthcert verifiable credential', 'basic'],
    ['AI Birthcert with no verification', 'basic'],
    ['Verified AI Birthcert', 'verified'],
    ['AI Birthcert', 'basic'],
    ['verified passport', undefined],
  ])('%s -> %s', (name, kind) => {
    expect(aiBirthcertKindOfName(name)).toBe(kind)
  })

  it('an unclear name resolves to no template, so it is never quietly issued as the Basic one', () => {
    expect(resolveTemplateAlias('Verified basic AI Birthcert', 'zetrix:testnet')).toBeUndefined()
    expect(isVerifiedAiBirthcertName('Verified basic AI Birthcert')).toBe(false)
  })
})

// whole-word matching sent names written without separators to Basic.
describe('Verified names without separators', () => {
  it.each(['VerifiedAIBirthcert', 'verifiedaibirthcert', 'MyIDverified birthcert', 'MyDigitalID AI Birthcert', 'AIBirthcertVerified'])(
    '%s is the Verified one and never resolves to the Basic template',
    (name) => {
      expect(aiBirthcertKindOfName(name)).toBe('verified')
      expect(resolveTemplateAlias(name, 'zetrix:testnet')).toBeUndefined()
    },
  )

  it.each(['AIBirthcertVerifiable', 'unverifiedaibirthcert', 'nonverified birthcert'])('%s is not the Verified one', (name) => {
    expect(aiBirthcertKindOfName(name)).toBe('basic')
  })
})

// a negation written inside one word is seen too.
describe('a negation inside one word means Basic', () => {
  it.each(['AIBirthcertNotVerified', 'AIBirthcertUnverified', 'SelfVerifiedAIBirthcert', 'aibirthcertnonverified'])('%s is the Basic one', (name) => {
    expect(aiBirthcertKindOfName(name)).toBe('basic')
  })

  it.each(['VerifiedAIBirthcert', 'MyIDverified birthcert', 'AIBirthcertVerified'])('%s is still the Verified one', (name) => {
    expect(aiBirthcertKindOfName(name)).toBe('verified')
  })
})
