/**
 * How the wallet reaches the Zetrix node. The SDK uses plain http unless `secure: true` is passed, and the mainnet node refuses a
 * POSTed contract call over http, so a setting that is built but never reaches an SDK is the failure these tests exist to catch.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PaymentEngine } from 'x402-zetrix-client'
import { createNodeSdk, secureNodeForPaymentEngine } from '../node-connection'

// The SDK ships no types; its instance keeps the options it was built with.
const optionsOf = (sdk: unknown) => (sdk as { options: { host: string; secure: boolean } }).options

describe('createNodeSdk', () => {
  it('builds the SDK with the configured scheme: https when nodeSecure is true', () => {
    const sdk = createNodeSdk({ nodeHost: 'node.zetrix.com', nodePort: '', nodeSecure: true })
    expect(optionsOf(sdk).secure).toBe(true)
    expect(optionsOf(sdk).host).toBe('node.zetrix.com')
  })

  it('and plain http when it is false', () => {
    expect(optionsOf(createNodeSdk({ nodeHost: 'localhost:19333', nodePort: '', nodeSecure: false })).secure).toBe(false)
  })
})

describe('secureNodeForPaymentEngine', () => {
  it('makes the seam build an https SDK for the node it is given', () => {
    const engine: { _createSdk?: (n: { host: string; port: string }) => unknown } = { _createSdk: () => 'http sdk' }
    expect(secureNodeForPaymentEngine(engine, true)).toBe(true)
    const sdk = engine._createSdk!({ host: 'node.zetrix.com', port: '' })
    expect(optionsOf(sdk).secure).toBe(true)
    expect(optionsOf(sdk).host).toBe('node.zetrix.com')
  })

  it('builds plain http when the configuration says http', () => {
    const engine: { _createSdk?: (n: { host: string; port: string }) => unknown } = { _createSdk: () => 'http sdk' }
    secureNodeForPaymentEngine(engine, false)
    expect(optionsOf(engine._createSdk!({ host: 'localhost:19333', port: '' })).secure).toBe(false)
  })

  it('says so when the library has no such seam, instead of failing quietly', () => {
    expect(secureNodeForPaymentEngine({}, true)).toBe(false)
  })

  it('the real PaymentEngine still has the seam (a library change that removes it must fail here, not on mainnet)', () => {
    expect(typeof (PaymentEngine as unknown as { _createSdk: unknown })._createSdk).toBe('function')
    const original = (PaymentEngine as unknown as { _createSdk: unknown })._createSdk
    try {
      expect(secureNodeForPaymentEngine(PaymentEngine as never, true)).toBe(true)
      const sdk = (PaymentEngine as unknown as { _createSdk: (n: { host: string; port: string }) => unknown })._createSdk({ host: 'node.zetrix.com', port: '' })
      expect(optionsOf(sdk).secure).toBe(true)
    } finally {
      ;(PaymentEngine as unknown as { _createSdk: unknown })._createSdk = original
    }
  })
})

// The startup code in index.ts cannot be run in a unit test, so this pins that it uses these two helpers: removing either call
// (which would put the wallet back on plain http on mainnet) fails here.
describe('index.ts wiring', () => {
  const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')

  it('builds the wallet SDK through createNodeSdk with the configuration', () => {
    expect(source).toMatch(/const sdk = createNodeSdk\(config\)/)
  })

  it('switches the payment library to the same scheme at startup', () => {
    expect(source).toMatch(/secureNodeForPaymentEngine\(PaymentEngine as never, config\.nodeSecure\)/)
  })

  it('builds the node base URL for template reads from the configured scheme, not a hard-coded one', () => {
    expect(source).toMatch(/const nodeBaseUrl = `\$\{config\.nodeSecure \? 'https' : 'http'\}:\/\//)
  })
})
