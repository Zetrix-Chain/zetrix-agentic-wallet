import { describe, it, expect } from 'vitest'
import { resolveTemplateAlias } from '../template-aliases'

const TESTNET_ID = 'did:zid:d6b783559acf6ba0f7ef6e1365bdaf0774d622d8d22728ca6323677f49ee94f8'
const MAINNET_ID = 'did:zid:032cb99be3577beccfc6252783c49c83673af38f8456d73462043654d7764e83'

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
