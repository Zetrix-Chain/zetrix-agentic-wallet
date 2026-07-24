import { describe, it, expect, vi } from 'vitest'
import { deriveHolderDid, createHolderAccount } from '../orchestrator/onboard'

describe('deriveHolderDid', () => {
  it('prefixes a raw 64-hex-char pubkey directly', () => {
    const raw = 'ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9'.slice(0, 64)
    expect(deriveHolderDid(raw)).toBe(`did:zid:${raw}`)
  })

  it('strips the b001 prefix + trailing checksum from an encoded 76-hex-char pubkey', () => {
    const rawPart = 'ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9'
    const encoded = `b001${rawPart}4a10ec51`
    expect(deriveHolderDid(encoded)).toBe(`did:zid:${rawPart}`)
  })

  it('throws on an unrecognized public key hex length', () => {
    expect(() => deriveHolderDid('abcd')).toThrow(/unrecognized/i)
  })
})

const rawPart = 'ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9'

describe('createHolderAccount', () => {
  it('creates a new HSM account, saves it, and returns address/DID when no account exists yet', async () => {
    const create = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: `b001${rawPart}4a10ec51` })
    const getExistingAccount = vi.fn().mockResolvedValue(null)
    const saveAccount = vi.fn().mockResolvedValue(undefined)

    const out = await createHolderAccount(
      { create, getExistingAccount, saveAccount },
      { password: 'pw123456', label: 'agent', purpose: 'onboarding' },
    )

    expect(create).toHaveBeenCalledWith('pw123456', 'agent', 'onboarding')
    expect(out.created).toBe(true)
    expect(out.alreadyExists).toBe(false)
    expect(out.zetrixAddress).toBe('ZTX3New')
    expect(out.holderDid).toBe(`did:zid:${rawPart}`)
    expect(out.publicKeyHex).toBe(`b001${rawPart}4a10ec51`)
    expect(out.message).toMatch(/ZETRIX_ADDRESS/)
    expect(out.message).toMatch(/HOLDER_DID/)
    expect(out.message).toMatch(/restart/i)
    expect(saveAccount).toHaveBeenCalledWith({ zetrixAddress: 'ZTX3New', holderDid: `did:zid:${rawPart}`, hsmPassword: 'pw123456', label: 'agent', purpose: 'onboarding' })
  })

  it('does NOT create a new account when one already exists, and asks the caller to confirm instead', async () => {
    const create = vi.fn()
    const saveAccount = vi.fn()
    const existing = { zetrixAddress: 'ZTX3Old', holderDid: 'did:zid:old' }
    const getExistingAccount = vi.fn().mockResolvedValue(existing)

    const out = await createHolderAccount({ create, getExistingAccount, saveAccount }, { password: 'pw123456' })

    expect(create).not.toHaveBeenCalled()
    expect(saveAccount).not.toHaveBeenCalled()
    expect(out).toEqual({
      created: false,
      alreadyExists: true,
      existing,
      message: expect.stringMatching(/confirmNew/),
    })
  })

  it('creates a new account anyway when confirmNew is set, even though one already exists', async () => {
    const create = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: `b001${rawPart}4a10ec51` })
    const saveAccount = vi.fn().mockResolvedValue(undefined)
    const getExistingAccount = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3Old', holderDid: 'did:zid:old' })

    const out = await createHolderAccount(
      { create, getExistingAccount, saveAccount },
      { password: 'pw123456', confirmNew: true },
    )

    expect(create).toHaveBeenCalledWith('pw123456', undefined, undefined)
    expect(out.created).toBe(true)
    expect(out.alreadyExists).toBe(true)
    expect(out.zetrixAddress).toBe('ZTX3New')
    expect(saveAccount).toHaveBeenCalledWith({ zetrixAddress: 'ZTX3New', holderDid: `did:zid:${rawPart}`, hsmPassword: 'pw123456', label: undefined, purpose: undefined })
  })
})
