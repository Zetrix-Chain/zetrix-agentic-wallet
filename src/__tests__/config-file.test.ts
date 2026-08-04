import { describe, it, expect } from 'vitest'
import { loadConfigFileEnv } from '../config-file'

const read = (contents: string) => () => contents

describe('loadConfigFileEnv', () => {
  it('returns an empty overlay when no --config flag is given', () => {
    expect(loadConfigFileEnv(['node', 'server.js'], read('{}'))).toEqual({})
  })

  it('maps known config keys to their env-var names', () => {
    const env = loadConfigFileEnv(
      ['node', 'server.js', '--config', '/etc/wallet.json'],
      read(
        JSON.stringify({
          network: 'zetrix:mainnet',
          zetrixAddress: 'ZTX3A',
          maxPaymentAmount: { ZTX: '500' },
          stateDir: '/var/lib/w',
        }),
      ),
    )
    expect(env).toEqual({
      ZETRIX_NETWORK: 'zetrix:mainnet',
      ZETRIX_ADDRESS: 'ZTX3A',
      MAX_PAYMENT_AMOUNT: '{"ZTX":"500"}',
      ZETRIX_WALLET_STATE_DIR: '/var/lib/w',
    })
  })

  it('accepts --config=<path> as one argument', () => {
    const env = loadConfigFileEnv(['node', 'server.js', '--config=/etc/wallet.json'], read('{"network":"zetrix:testnet"}'))
    expect(env.ZETRIX_NETWORK).toBe('zetrix:testnet')
  })

  it('rejects a secret field so no credential can ever live in the config file', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/etc/w.json'], read('{"hsmPassword":"leaked"}'))).toThrow(
      /must not contain a secret/,
    )
  })

  it('rejects an unknown key rather than ignoring it', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/etc/w.json'], read('{"netwrok":"zetrix:testnet"}'))).toThrow(
      /unknown config key "netwrok"/,
    )
  })

  it('names the file when it cannot be read', () => {
    const boom = () => {
      throw new Error('ENOENT')
    }
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/missing.json'], boom)).toThrow(/\/missing\.json/)
  })

  it('names the file when it is not valid JSON', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/bad.json'], read('not json'))).toThrow(
      /\/bad\.json.*not valid JSON/,
    )
  })

  it('rejects a JSON array or scalar — it must be an object', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '/w.json'], read('[1,2]'))).toThrow(/must contain a JSON object/)
  })

  it('throws when --config is given with no path', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config'], read('{}'))).toThrow(/--config requires a file path/)
  })

  it('throws when --config is followed by another flag rather than a path', () => {
    expect(() => loadConfigFileEnv(['node', 's.js', '--config', '--verbose'], read('{}'))).toThrow(
      /--config requires a file path/,
    )
  })
})
