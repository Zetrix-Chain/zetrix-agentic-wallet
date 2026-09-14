import { describe, it, expect } from 'vitest'
import { resolveTemplateAlias, deriveTemplateAttributes, validateTemplateAttributes } from '../template-aliases'

const TESTNET_ID = 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959'
const MAINNET_ID = 'did:zid:19091d19049abb8869b4b8e2f4a887bd1d1d86e5f5ebd0c8297000255f67765b'

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
