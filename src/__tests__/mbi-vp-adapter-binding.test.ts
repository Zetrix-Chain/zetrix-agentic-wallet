import { describe, it, expect, vi } from 'vitest'
import { MbiVpAdapter } from '../clients/mbi-vp-adapter'
import type { PresentedNonceStore } from '../clients/presented-nonce-store'

/**
 * the presentation is made for the verifier's session. The nonce and the verifier's origin go to MBI (which has them written
 * into what the holder signs), and a challenge is answered once.
 */

const AUDIENCE = 'https://zid-oid4vp-sandbox.zetrix.com'

function makeMbi() {
  return {
    createVp: vi.fn().mockResolvedValue({ blobId: 'b1', blob: 'deadbeef' }),
    submitVp: vi.fn().mockResolvedValue({ id: 'v2-ref-1', vp: { id: 'vp-1' } }),
  }
}

/** In-memory stand-in for the nonce store, recording what was claimed and released. */
function makeStore(): PresentedNonceStore & { claimed: Set<string>; released: string[] } {
  const claimed = new Set<string>()
  const released: string[] = []
  return {
    claimed,
    released,
    claim: async (n) => (claimed.has(n) ? false : (claimed.add(n), true)),
    release: async (n) => {
      released.push(n)
      claimed.delete(n)
    },
  }
}

function adapter(opts: { mbi?: ReturnType<typeof makeMbi>; present?: Record<string, unknown>; store?: PresentedNonceStore; signHexBlob?: ReturnType<typeof vi.fn> } = {}) {
  const mbi = opts.mbi ?? makeMbi()
  const signHexBlob = opts.signHexBlob ?? vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' })
  const signMessage = vi.fn().mockResolvedValue({ signBlob: 'as', publicKey: 'apk' })
  const resolveIssuerKeys = vi.fn().mockResolvedValue({ bbsPublicKey: 'bbs', ed25519PublicKey: 'ed' })
  const a = new MbiVpAdapter(mbi as never, signHexBlob, signMessage, resolveIssuerKeys, { vc: { id: 'vc-1' }, revealAttribute: [], ...(opts.present ?? {}) }, opts.store)
  return { a, mbi, signHexBlob }
}

const input = (nonce: string) => ({ credentialQuery: {}, nonce, holderDid: 'did:zid:h' })

describe('MbiVpAdapter binds the presentation to the verifier session', () => {
  it('sends the nonce and the audience to MBI create', async () => {
    const { a, mbi } = adapter({ present: { audience: AUDIENCE } })

    await a.createVp(input('session-nonce-1'))

    expect(mbi.createVp.mock.calls[0][0]).toEqual({ vc: { id: 'vc-1' }, revealAttributes: [], nonce: 'session-nonce-1', audience: AUDIENCE })
  })

  it('sends the nonce alone when the challenge named no usable verifier', async () => {
    const { a, mbi } = adapter()

    await a.createVp(input('session-nonce-1'))

    const body = mbi.createVp.mock.calls[0][0]
    expect(body.nonce).toBe('session-nonce-1')
    expect('audience' in body).toBe(false)
  })

  it('sends neither when there is no nonce and no audience (the body is what it always was)', async () => {
    const { a, mbi } = adapter()

    await a.createVp(input(''))

    expect(mbi.createVp.mock.calls[0][0]).toEqual({ vc: { id: 'vc-1' }, revealAttributes: [] })
  })

  it('still returns the finished VP and the issuer keys, as before', async () => {
    const { a } = adapter({ present: { audience: AUDIENCE } })

    const out = await a.createVp(input('n'))

    expect(out.vp).toEqual({ id: 'vp-1' })
    expect(out.bbsPublicKey).toBe('bbs')
    expect(out.ed25519PublicKey).toBe('ed')
  })
})

describe('a challenge is answered once', () => {
  it('refuses a second answer to the same nonce, without calling MBI again', async () => {
    const store = makeStore()
    const { a, mbi } = adapter({ store })

    await a.createVp(input('nonce-1'))
    await expect(a.createVp(input('nonce-1'))).rejects.toThrow(/already been answered/)

    expect(mbi.createVp).toHaveBeenCalledTimes(1)
    expect(mbi.submitVp).toHaveBeenCalledTimes(1)
  })

  it('answers different nonces independently', async () => {
    const { a, mbi } = adapter({ store: makeStore() })

    await a.createVp(input('nonce-1'))
    await a.createVp(input('nonce-2'))

    expect(mbi.createVp).toHaveBeenCalledTimes(2)
  })

  it('lets exactly one of two simultaneous answers to the same nonce through', async () => {
    const { a, mbi } = adapter({ store: makeStore() })

    const results = await Promise.allSettled([a.createVp(input('nonce-1')), a.createVp(input('nonce-1'))])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })

  it('gives the claim back when MBI create fails, so the challenge can still be answered', async () => {
    const store = makeStore()
    const mbi = makeMbi()
    mbi.createVp.mockRejectedValueOnce(new Error('MBI is down'))
    const { a } = adapter({ store, mbi })

    await expect(a.createVp(input('nonce-1'))).rejects.toThrow('MBI is down')
    expect(store.released).toEqual(['nonce-1'])
    await expect(a.createVp(input('nonce-1'))).resolves.toBeDefined()
  })

  it('keeps the claim when the signing call itself fails: the signing service may have signed before it failed', async () => {
    const store = makeStore()
    const signHexBlob = vi.fn().mockRejectedValueOnce(new Error('HSM timed out')).mockResolvedValue({ signBlob: 'sig', publicKey: 'edpk' })
    const { a, mbi } = adapter({ store, signHexBlob })

    await expect(a.createVp(input('nonce-1'))).rejects.toThrow('HSM timed out')
    expect(store.released).toEqual([])
    await expect(a.createVp(input('nonce-1'))).rejects.toThrow(/already been answered/)
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })

  it('does not claim an empty nonce at all (there is nothing to answer once)', async () => {
    const store = makeStore()
    const { a, mbi } = adapter({ store })

    await a.createVp(input(''))
    await a.createVp(input(''))

    expect(store.claimed.size).toBe(0)
    expect(mbi.createVp).toHaveBeenCalledTimes(2)
  })

  it('keeps the claim once the holder has signed, even if a later step fails', async () => {
    const store = makeStore()
    const mbi = makeMbi()
    mbi.submitVp.mockRejectedValueOnce(new Error('submit failed'))
    const { a } = adapter({ store, mbi })

    await expect(a.createVp(input('nonce-1'))).rejects.toThrow('submit failed')
    expect(store.released).toEqual([])
    await expect(a.createVp(input('nonce-1'))).rejects.toThrow(/already been answered/)
    expect(mbi.createVp).toHaveBeenCalledTimes(1)
  })

  it('does not call MBI when the record cannot be trusted: it fails closed', async () => {
    const mbi = makeMbi()
    const broken: PresentedNonceStore = { claim: async () => { throw new Error('record is corrupt') }, release: async () => undefined }
    const { a } = adapter({ store: broken, mbi })

    await expect(a.createVp(input('nonce-1'))).rejects.toThrow('record is corrupt')
    expect(mbi.createVp).not.toHaveBeenCalled()
  })

  it('reports the original failure even when giving the claim back fails too', async () => {
    const mbi = makeMbi()
    mbi.createVp.mockRejectedValueOnce(new Error('MBI is down'))
    const flaky: PresentedNonceStore = { claim: async () => true, release: async () => { throw new Error('disk full') } }
    const { a } = adapter({ store: flaky, mbi })

    await expect(a.createVp(input('nonce-1'))).rejects.toThrow('MBI is down')
  })

  it('with binding off: no nonce, no audience, nothing claimed, and the same challenge can be answered again', async () => {
    const store = makeStore()
    const { a, mbi } = adapter({ store, present: { audience: AUDIENCE, bindSession: false } })

    await a.createVp(input('nonce-1'))
    await a.createVp(input('nonce-1'))

    for (const call of mbi.createVp.mock.calls) expect(call[0]).toEqual({ vc: { id: 'vc-1' }, revealAttributes: [] })
    expect(store.claimed.size).toBe(0)
  })

  it('binding is on unless it is explicitly off', async () => {
    const store = makeStore()
    const { a } = adapter({ store, present: { bindSession: true } })
    await a.createVp(input('nonce-1'))
    expect(store.claimed.has('nonce-1')).toBe(true)
  })

  it('behaves as it always did when no store is given: the same nonce can be answered again', async () => {
    const { a, mbi } = adapter()

    await a.createVp(input('nonce-1'))
    await a.createVp(input('nonce-1'))

    expect(mbi.createVp).toHaveBeenCalledTimes(2)
  })
})
