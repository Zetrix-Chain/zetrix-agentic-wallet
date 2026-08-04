import { describe, it, expect } from 'vitest'
import { loadConfig } from '../config'
import { resolveStartupEnv } from '../startup-env'
import { loadConfigFileEnv } from '../config-file'

/**
 * A fully-specified .mcp.json env block, the way an existing user has it today.
 * If any assertion here fails, an existing installation's behaviour changed — which is only
 * ever acceptable for the two documented breaks (payment-cap default, create_holder_account's
 * password parameter). Anything else is a regression in the change, not a test to update.
 */
const existingUserEnv: NodeJS.ProcessEnv = {
  ZETRIX_NETWORK: 'zetrix:mainnet',
  ZETRIX_ADDRESS: 'ZTX3ExistingHolder',
  HOLDER_DID: 'did:zid:' + 'b'.repeat(64),
  HSM_PASSWORD: 'the-users-own-password',
  MAX_PAYMENT_AMOUNT: '{"ZTX":"1000000000","*":"0"}',
}

describe('an existing .mcp.json env configuration still works unchanged', () => {
  it('honors every explicitly-set value', () => {
    const cfg = loadConfig(existingUserEnv)
    expect(cfg.network).toBe('zetrix:mainnet')
    expect(cfg.zetrixAddress).toBe('ZTX3ExistingHolder')
    expect(cfg.hsmPassword).toBe('the-users-own-password')
    expect(cfg.maxPaymentAmount).toEqual({ ZTX: '1000000000', '*': '0' })
    expect(cfg.walletBeUrl).toBe('https://wallet-api.zetrix.com/server')
  })

  it('keeps the default state directory, so existing account.json and vc-cache are still found', () => {
    expect(loadConfig(existingUserEnv).stateDir).toMatch(/[\\/]\.agentic-wallet-mcp$/)
  })

  it('never generates a password when the user supplied one', () => {
    const { env, passwordGenerated } = resolveStartupEnv({
      processEnv: existingUserEnv,
      storedAccount: { zetrixAddress: 'ZTX3Other', holderDid: 'did:zid:other', hsmPassword: 'stored' },
      generatePassword: () => 'SHOULD-NOT-BE-USED',
    })
    expect(passwordGenerated).toBe(false)
    expect(env.HSM_PASSWORD).toBe('the-users-own-password')
    expect(env.ZETRIX_ADDRESS).toBe('ZTX3ExistingHolder')
  })

  it('is unaffected by the config-file source when no --config flag is passed', () => {
    expect(loadConfigFileEnv(['node', 'server.js'], () => '{}')).toEqual({})
  })

  it('lets env override a config file, so a plugin default cannot hijack an explicit setting', () => {
    const { env } = resolveStartupEnv({
      processEnv: existingUserEnv,
      fileEnv: { ZETRIX_NETWORK: 'zetrix:testnet', ZETRIX_ADDRESS: 'ZTX3PluginDefault' },
      storedAccount: null,
      generatePassword: () => 'SHOULD-NOT-BE-USED',
    })
    expect(env.ZETRIX_NETWORK).toBe('zetrix:mainnet')
    expect(env.ZETRIX_ADDRESS).toBe('ZTX3ExistingHolder')
  })
})
