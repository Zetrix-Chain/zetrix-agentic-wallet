import { describe, it, expect } from 'vitest'
import { loadConfig, networkFromEnv } from '../config'
import { mergeStartupEnv } from '../startup-env'

/**
 * The saved account is chosen by network BEFORE the config loads, so the network has to be read exactly the way
 * loadConfig reads it. A blank process value overrides the config file's value in the merged environment and then
 * reads as unset (testnet); reading the file's value instead would save a testnet account as the mainnet one.
 */

describe('networkFromEnv', () => {
  it('is testnet when the setting is absent', () => {
    expect(networkFromEnv({})).toBe('zetrix:testnet')
  })

  it('treats a blank or whitespace value as unset, like loadConfig', () => {
    expect(networkFromEnv({ ZETRIX_NETWORK: '' })).toBe('zetrix:testnet')
    expect(networkFromEnv({ ZETRIX_NETWORK: '   ' })).toBe('zetrix:testnet')
  })

  it('trims a real value', () => {
    expect(networkFromEnv({ ZETRIX_NETWORK: '  zetrix:mainnet ' })).toBe('zetrix:mainnet')
  })
})

describe('the network the account step uses is the network loadConfig will use', () => {
  const base = { HSM_PASSWORD: 'pw-test' }

  const both = (fileEnv: NodeJS.ProcessEnv, processEnv: NodeJS.ProcessEnv) => {
    const merged = mergeStartupEnv(fileEnv, processEnv)
    return { fromAccountStep: networkFromEnv(merged), fromConfig: loadConfig({ ...base, ...merged }).network }
  }

  it('a blank process value hides the config file\'s mainnet: both say testnet', () => {
    const { fromAccountStep, fromConfig } = both({ ZETRIX_NETWORK: 'zetrix:mainnet' }, { ZETRIX_NETWORK: '' })
    expect(fromConfig).toBe('zetrix:testnet')
    expect(fromAccountStep).toBe(fromConfig)
  })

  it('a whitespace-only process value does the same', () => {
    const { fromAccountStep, fromConfig } = both({ ZETRIX_NETWORK: 'zetrix:mainnet' }, { ZETRIX_NETWORK: '  ' })
    expect(fromAccountStep).toBe(fromConfig)
    expect(fromConfig).toBe('zetrix:testnet')
  })

  it('a real process value wins over the file', () => {
    const { fromAccountStep, fromConfig } = both({ ZETRIX_NETWORK: 'zetrix:testnet' }, { ZETRIX_NETWORK: 'zetrix:mainnet' })
    expect(fromConfig).toBe('zetrix:mainnet')
    expect(fromAccountStep).toBe(fromConfig)
  })

  it('the file\'s value is used when the process environment says nothing', () => {
    const { fromAccountStep, fromConfig } = both({ ZETRIX_NETWORK: 'zetrix:mainnet' }, {})
    expect(fromConfig).toBe('zetrix:mainnet')
    expect(fromAccountStep).toBe(fromConfig)
  })
})

describe('mergeStartupEnv', () => {
  it('lets the process environment override the config file', () => {
    expect(mergeStartupEnv({ A: 'file', B: 'file' }, { A: 'process' })).toEqual({ A: 'process', B: 'file' })
  })

  it('works without a config file', () => {
    expect(mergeStartupEnv(undefined, { A: 'process' })).toEqual({ A: 'process' })
  })
})
