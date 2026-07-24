import { describe, it, expect, vi } from 'vitest'
import { resolveHolder } from '../orchestrator/resolve-holder'

const rawPart = 'ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9'
const correctDid = `did:zid:${rawPart}`

describe('resolveHolder', () => {
  it('scenario 1 — first-time user (no zetrixAddress): creates a new HSM account and derives the DID from its public key', async () => {
    const createAccount = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: `b001${rawPart}4a10ec51` })
    const signMessage = vi.fn()

    const out = await resolveHolder({ createAccount, signMessage }, { hsmPassword: 'pw123456' })

    expect(createAccount).toHaveBeenCalledWith('pw123456')
    expect(signMessage).not.toHaveBeenCalled()
    expect(out).toEqual({ zetrixAddress: 'ZTX3New', holderDid: correctDid, created: true, didMismatch: false })
  })

  it('scenario 2a — existing user, holderDid supplied and correct: verifies via sign-message and keeps it, no mismatch', async () => {
    const createAccount = vi.fn()
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'sb', publicKey: `b001${rawPart}4a10ec51` })

    const out = await resolveHolder(
      { createAccount, signMessage },
      { zetrixAddress: 'ZTX3Existing', holderDid: correctDid, hsmPassword: 'pw123456' },
    )

    expect(createAccount).not.toHaveBeenCalled()
    expect(signMessage).toHaveBeenCalledWith('ZTX3Existing', 'ZTX3Existing', 'pw123456')
    expect(out).toEqual({ zetrixAddress: 'ZTX3Existing', holderDid: correctDid, created: false, didMismatch: false })
  })

  it('scenario 2b — existing user, holderDid omitted: derives it via sign-message, no mismatch (nothing supplied to compare)', async () => {
    const createAccount = vi.fn()
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'sb', publicKey: `b001${rawPart}4a10ec51` })

    const out = await resolveHolder({ createAccount, signMessage }, { zetrixAddress: 'ZTX3Existing', hsmPassword: 'pw123456' })

    expect(createAccount).not.toHaveBeenCalled()
    expect(signMessage).toHaveBeenCalledWith('ZTX3Existing', 'ZTX3Existing', 'pw123456')
    expect(out).toEqual({ zetrixAddress: 'ZTX3Existing', holderDid: correctDid, created: false, didMismatch: false })
  })

  it('scenario 2c — existing user, holderDid supplied but WRONG: overrides with the derived DID and flags didMismatch', async () => {
    const createAccount = vi.fn()
    const signMessage = vi.fn().mockResolvedValue({ signBlob: 'sb', publicKey: `b001${rawPart}4a10ec51` })

    const out = await resolveHolder(
      { createAccount, signMessage },
      { zetrixAddress: 'ZTX3Existing', holderDid: 'did:zid:wrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrongwrong', hsmPassword: 'pw123456' },
    )

    expect(out).toEqual({ zetrixAddress: 'ZTX3Existing', holderDid: correctDid, created: false, didMismatch: true })
  })

  it('never generates/invents a password — always creates the account with exactly the caller-supplied hsmPassword', async () => {
    const createAccount = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: `b001${rawPart}4a10ec51` })
    const signMessage = vi.fn()

    await resolveHolder({ createAccount, signMessage }, { hsmPassword: 'the-exact-password-the-user-supplied' })

    expect(createAccount).toHaveBeenCalledTimes(1)
    expect(createAccount).toHaveBeenCalledWith('the-exact-password-the-user-supplied')
    expect(createAccount.mock.calls[0]).toHaveLength(1) // no second/extra arg — nothing MCP-generated is passed alongside it
  })
})
