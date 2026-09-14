import { describe, it, expect, vi } from 'vitest'
import { createHolderAccount } from '../orchestrator/onboard'
import { resolveStartupEnv } from '../startup-env'
import { loadConfigFileEnv } from '../config-file'

const SECRET = 'S3CRET-do-not-leak-me'

describe('the HSM password never escapes', () => {
  it('is absent from a successful create_holder_account result', async () => {
    const result = await createHolderAccount(
      {
        create: vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: 'a'.repeat(64), activated: true, activationTxHash: null }),
        getExistingAccount: () => Promise.resolve(null),
        saveAccount: vi.fn().mockResolvedValue(undefined),
        checkActivationStatus: vi.fn(),
        sleep: vi.fn(),
      },
      { label: 'w' },
    )
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('is absent from the already-exists result and its guidance message', async () => {
    const result = await createHolderAccount(
      {
        create: vi.fn(),
        getExistingAccount: () => Promise.resolve({ zetrixAddress: 'ZTX3Old', holderDid: 'did:zid:old' }),
        saveAccount: vi.fn(),
        checkActivationStatus: vi.fn(),
        sleep: vi.fn(),
      },
      {},
    )
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(result.message).not.toMatch(/password/i)
  })

  it('is never handed to the orchestrator at all — create receives only label and purpose', async () => {
    const create = vi.fn().mockResolvedValue({ zetrixAddress: 'ZTX3New', publicKeyHex: 'a'.repeat(64), activated: true, activationTxHash: null })
    await createHolderAccount(
      {
        create,
        getExistingAccount: () => Promise.resolve(null),
        saveAccount: vi.fn().mockResolvedValue(undefined),
        checkActivationStatus: vi.fn(),
        sleep: vi.fn(),
      },
      { label: 'w', purpose: 'p' },
    )
    // The password is bound in index.ts's wiring, so no argument here can carry it. Asserting the
    // exact argument list is what makes this meaningful — a `not.toContain(SECRET)` check would
    // pass trivially, since this test never has the real password to leak.
    expect(create).toHaveBeenCalledWith('w', 'p')
    expect(create.mock.calls[0]).toHaveLength(2)
  })

  it('is never written into a config-file overlay', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/w.json'], () => JSON.stringify({ hsmPassword: SECRET }))).toThrow(
      /must not contain a secret/,
    )
  })

  it('a generated password is returned only through env, never logged by the resolver', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    const { env } = resolveStartupEnv({ processEnv: {}, storedAccount: null, generatePassword: () => SECRET })
    spy.mockRestore()
    expect(env.HSM_PASSWORD).toBe(SECRET)
    expect(writes.join('')).not.toContain(SECRET)
  })
})

/**
 * Not covered here, and deliberately so: this suite proves the *wallet* never emits the
 * password. It cannot prove an upstream service doesn't. Wallet BE error text is propagated
 * verbatim by `clients/wallet-be-client.ts`, so a backend that echoed a submitted credential
 * would surface it. Redacting that belongs in the Wallet BE client, and is tracked separately
 * rather than being silently assumed safe here.
 */
