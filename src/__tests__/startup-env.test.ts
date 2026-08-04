import { describe, it, expect } from 'vitest'
import { resolveStartupEnv } from '../startup-env'

const stored = { zetrixAddress: 'ZTX3Stored', holderDid: 'did:zid:stored', hsmPassword: 'stored-pw' }
const generate = () => 'generated-pw'

describe('resolveStartupEnv', () => {
  it('generates a password when none is set anywhere', () => {
    const { env, passwordGenerated } = resolveStartupEnv({ processEnv: {}, storedAccount: null, generatePassword: generate })
    expect(env.HSM_PASSWORD).toBe('generated-pw')
    expect(passwordGenerated).toBe(true)
  })

  it('prefers the stored account password over generating a new one', () => {
    const { env, passwordGenerated } = resolveStartupEnv({ processEnv: {}, storedAccount: stored, generatePassword: generate })
    expect(env.HSM_PASSWORD).toBe('stored-pw')
    expect(env.ZETRIX_ADDRESS).toBe('ZTX3Stored')
    expect(env.HOLDER_DID).toBe('did:zid:stored')
    expect(passwordGenerated).toBe(false)
  })

  it('prefers an explicit env password over the stored account and the generator', () => {
    const { env, passwordGenerated } = resolveStartupEnv({
      processEnv: { HSM_PASSWORD: 'env-pw' },
      storedAccount: stored,
      generatePassword: generate,
    })
    expect(env.HSM_PASSWORD).toBe('env-pw')
    expect(passwordGenerated).toBe(false)
  })

  it('lets env win over the config file, and the config file win over defaults', () => {
    const { env } = resolveStartupEnv({
      processEnv: { ZETRIX_NETWORK: 'zetrix:mainnet' },
      fileEnv: { ZETRIX_NETWORK: 'zetrix:testnet', MAX_PAYMENT_AMOUNT: '{"ZTX":"5"}' },
      storedAccount: null,
      generatePassword: generate,
    })
    expect(env.ZETRIX_NETWORK).toBe('zetrix:mainnet')
    expect(env.MAX_PAYMENT_AMOUNT).toBe('{"ZTX":"5"}')
  })

  it('ignores a stored address when an explicit ZETRIX_ADDRESS is set', () => {
    const { env } = resolveStartupEnv({
      processEnv: { ZETRIX_ADDRESS: 'ZTX3Explicit' },
      storedAccount: stored,
      generatePassword: generate,
    })
    expect(env.ZETRIX_ADDRESS).toBe('ZTX3Explicit')
  })

  it('does not mutate the process env it was handed', () => {
    const processEnv: NodeJS.ProcessEnv = {}
    resolveStartupEnv({ processEnv, storedAccount: stored, generatePassword: generate })
    expect(processEnv.HSM_PASSWORD).toBeUndefined()
  })
})
