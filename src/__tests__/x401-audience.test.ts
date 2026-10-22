import { describe, it, expect } from 'vitest'
import { originOf, verifierOrigin } from '../x401-audience'

/** The audience is the origin of the verifier this wallet is configured to present to, never what a challenge says. */
describe('originOf', () => {
  it('reduces a URL to scheme://host[:port]: lower case, default port dropped, no path', () => {
    expect(originOf('https://Zid-OID4VP-Sandbox.zetrix.com/api/v1/presentation/pres_1?x=1#f')).toBe('https://zid-oid4vp-sandbox.zetrix.com')
    expect(originOf('https://host.example:443/a')).toBe('https://host.example')
    expect(originOf('http://host.example:80')).toBe('http://host.example')
    expect(originOf('http://localhost:8080/api/v1/presentation/submit')).toBe('http://localhost:8080')
    expect(originOf('https://host.example:8443/x')).toBe('https://host.example:8443')
  })

  it('drops userinfo, which is not part of an origin', () => {
    expect(originOf('https://user:pass@host.example/x')).toBe('https://host.example')
  })

  it('is undefined for anything that is not an http(s) URL', () => {
    for (const bad of ['', 'host.example', 'ftp://host.example', 'javascript:alert(1)', 'not a url', '//host.example']) {
      expect(originOf(bad), bad).toBeUndefined()
    }
  })
})

describe('verifierOrigin: the verifier the wallet presents to', () => {
  it('is the origin the x401 client derives from the network when no address is configured', () => {
    expect(verifierOrigin({ network: 'zetrix:testnet' })).toBe('https://zid-oid4vp-sandbox.zetrix.com')
    expect(verifierOrigin({ network: 'zetrix:mainnet' })).toBe('https://zid-oid4vp.zetrix.com')
  })

  it('is the origin of an explicitly configured verifier address, which wins over the network', () => {
    expect(verifierOrigin({ network: 'zetrix:testnet', oid4vpBaseUrl: 'https://Verifier.Test:8443/api' })).toBe('https://verifier.test:8443')
    expect(verifierOrigin({ network: 'zetrix:mainnet', oid4vpBaseUrl: 'http://localhost:8080/api' })).toBe('http://localhost:8080')
  })

  it('is the origin of the address the client would use: a blank override falls back to the network, like the client', () => {
    expect(verifierOrigin({ network: 'zetrix:testnet', oid4vpBaseUrl: '   ' })).toBe('https://zid-oid4vp-sandbox.zetrix.com')
  })

  it('is undefined, not an error, when the address is unusable or the network unknown', () => {
    expect(verifierOrigin({ network: 'zetrix:nowhere' })).toBeUndefined()
    expect(verifierOrigin({ network: 'zetrix:testnet', oid4vpBaseUrl: 'not a url' })).toBeUndefined()
    expect(verifierOrigin({ network: 'zetrix:testnet', oid4vpBaseUrl: 'ftp://verifier.test' })).toBeUndefined()
  })

  it('is not influenced by anything in a challenge: it takes no challenge at all', () => {
    // the function's whole input is the wallet's configuration; a challenge naming another host cannot change the answer
    expect(verifierOrigin.length).toBe(1)
  })
})
