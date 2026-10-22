/**
 * Gap G8: has the issuer revoked a credential the wallet is about to present? The wallet asks MBI (`/v1/vc/ext/revoke/status`)
 * and only ever WARNS: a failed or slow check, a credential with no id, or a credential MBI says is revoked never stops a
 * presentation.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MbiClient, MbiError } from '../clients/mbi-client'
import {
  createCredentialStatusChecker,
  credentialId,
  describeCredentialStatus,
  statusForResult,
  withCachedCredentialStatus,
} from '../orchestrator/credential-status'
import { createTools } from '../mcp-tools'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const sign = () => vi.fn().mockResolvedValue({ signBlob: 'sig-hex', publicKey: 'b001pk' })
const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
const mbi = new MbiClient('https://mbi.test/')

describe('MbiClient.revokeStatus', () => {
  it('POSTs /v1/vc/ext/revoke/status with the vcId, signed like the other /ext calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { status: 200, data: { revoked: false } }))
    vi.stubGlobal('fetch', fetchMock)
    const signer = sign()

    await mbi.revokeStatus('did:zid:vc-1', signer)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/ext/revoke/status')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ vcId: 'did:zid:vc-1' })
    expect(init.headers.signedData).toBe('sig-hex')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(signer).toHaveBeenCalledWith(expect.stringMatching(/^POST\|\/v1\/vc\/ext\/revoke\/status\|[0-9a-f]{64}\|/))
  })

  it.each([
    ['revoked', { revoked: true, revokedAt: '2026-10-01T00:00:00' }, { revoked: true, revokedAt: '2026-10-01T00:00:00' }],
    ['isRevoked', { isRevoked: true, revokedAt: '2026-10-01T00:00:00' }, { revoked: true, revokedAt: '2026-10-01T00:00:00' }],
    ['revoked false', { revoked: false, revokedAt: null }, { revoked: false }],
    ['isRevoked false', { isRevoked: false }, { revoked: false }],
    ['an empty revokedAt', { revoked: false, revokedAt: '' }, { revoked: false }],
  ])('reads either spelling of the flag (%s)', async (_name, data, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200, data })))
    await expect(mbi.revokeStatus('vc-1', sign())).resolves.toEqual(expected)
  })

  it('a 2xx with no flag is an error, never "not revoked"', async () => {
    for (const data of [{}, null, { revoked: 'false' }, { revokedAt: 'x' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200, data })))
      await expect(mbi.revokeStatus('vc-1', sign())).rejects.toThrow(/returned no revoked flag/)
    }
  })

  it('an HTTP error is an MbiError carrying the status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(500, { status: 500, message: 'VC not found: vc-1' })))
    const e = await mbi.revokeStatus('vc-1', sign()).catch((err) => err)
    expect(e).toBeInstanceOf(MbiError)
    expect(String(e.message)).toMatch(/vc\/ext\/revoke\/status failed — HTTP 500/)
  })
})

describe('credentialId', () => {
  it('is the credential id, and nothing else', () => {
    expect(credentialId({ id: 'did:zid:vc-1' })).toBe('did:zid:vc-1')
    for (const vc of [undefined, null, 'x', 5, {}, { id: '' }, { id: '   ' }, { id: 7 }]) expect(credentialId(vc)).toBeUndefined()
  })
})

describe('createCredentialStatusChecker', () => {
  const vc = { id: 'did:zid:vc-1' }

  it('active', async () => {
    const check = createCredentialStatusChecker({ revokeStatus: vi.fn().mockResolvedValue({ revoked: false }) })
    expect(await check(vc)).toEqual({ state: 'active' })
  })

  it('revoked, with when', async () => {
    const check = createCredentialStatusChecker({ revokeStatus: vi.fn().mockResolvedValue({ revoked: true, revokedAt: '2026-10-01' }) })
    expect(await check(vc)).toEqual({ state: 'revoked', revokedAt: '2026-10-01' })
  })

  it('MBI failing is unknown, with the reason, and never throws', async () => {
    const check = createCredentialStatusChecker({ revokeStatus: vi.fn().mockRejectedValue(new Error('MBI /x request failed: fetch failed')) })
    expect(await check(vc)).toEqual({ state: 'unknown', reason: 'MBI /x request failed: fetch failed' })
  })

  it('a long error body is clipped, not relayed whole', async () => {
    const check = createCredentialStatusChecker({ revokeStatus: vi.fn().mockRejectedValue(new Error('x'.repeat(5000))) })
    const s = await check(vc)
    expect(s.state === 'unknown' && s.reason.length).toBeLessThanOrEqual(200)
  })

  it('the raw response MBI\'s client appends for logs is cut from the reason, so a real "VC not found" reads cleanly', async () => {
    const real =
      'MBI vc/ext/revoke/status failed — HTTP 500: VC not found: did:zid:abc | full body: {"status":500,"message":"VC not found: did:zid:abc","data":null}'
    const check = createCredentialStatusChecker({ revokeStatus: vi.fn().mockRejectedValue(new Error(real)) })
    expect(await check(vc)).toEqual({ state: 'unknown', reason: 'MBI vc/ext/revoke/status failed — HTTP 500: VC not found: did:zid:abc' })
  })

  it('a credential with no id is unknown and MBI is not asked', async () => {
    const revokeStatus = vi.fn()
    const check = createCredentialStatusChecker({ revokeStatus })
    expect(await check({})).toEqual({ state: 'unknown', reason: 'the credential has no id to ask MBI about' })
    expect(revokeStatus).not.toHaveBeenCalled()
  })

  it('an answer that takes too long is unknown, and a late rejection afterwards is harmless', async () => {
    vi.useFakeTimers()
    let reject!: (e: Error) => void
    const revokeStatus = vi.fn().mockReturnValue(new Promise((_, r) => (reject = r)))
    const check = createCredentialStatusChecker({ revokeStatus, timeoutMs: 8_000 })
    const pending = check(vc)
    await vi.advanceTimersByTimeAsync(8_001)
    expect(await pending).toEqual({ state: 'unknown', reason: 'MBI did not answer within 8 seconds' })
    reject(new Error('late'))
    await vi.advanceTimersByTimeAsync(10)
  })

  it('an active answer is reused for a few minutes, then asked again', async () => {
    let t = 0
    const revokeStatus = vi.fn().mockResolvedValue({ revoked: false })
    const check = createCredentialStatusChecker({ revokeStatus, activeTtlMs: 5 * 60_000, now: () => t })
    await check(vc)
    t = 4 * 60_000
    await check(vc)
    expect(revokeStatus).toHaveBeenCalledTimes(1)
    t = 5 * 60_000 + 1
    await check(vc)
    expect(revokeStatus).toHaveBeenCalledTimes(2)
  })

  it('a revoked answer is kept far longer than an active one, because revocation is final', async () => {
    let t = 0
    const revokeStatus = vi.fn().mockResolvedValue({ revoked: true })
    const check = createCredentialStatusChecker({ revokeStatus, now: () => t })
    await check(vc)
    t = 60 * 60_000
    expect(await check(vc)).toEqual({ state: 'revoked' })
    expect(revokeStatus).toHaveBeenCalledTimes(1)
  })

  it('an unknown answer is never cached, so the next presentation tries again', async () => {
    const revokeStatus = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce({ revoked: false })
    const check = createCredentialStatusChecker({ revokeStatus })
    expect((await check(vc)).state).toBe('unknown')
    expect(await check(vc)).toEqual({ state: 'active' })
    expect(revokeStatus).toHaveBeenCalledTimes(2)
  })

  it('concurrent checks of one credential share one call; different credentials do not', async () => {
    const revokeStatus = vi.fn().mockImplementation(async () => ({ revoked: false }))
    const check = createCredentialStatusChecker({ revokeStatus })
    await Promise.all([check(vc), check(vc), check({ id: 'did:zid:vc-2' })])
    expect(revokeStatus).toHaveBeenCalledTimes(2)
  })
})

describe('what the agent is told', () => {
  it('nothing for an active credential', () => {
    expect(describeCredentialStatus({ state: 'active' })).toBeUndefined()
    expect(statusForResult({ state: 'active' })).toEqual({ state: 'active' })
  })

  it('a revoked credential: say so, say when, do not keep presenting it', () => {
    const text = describeCredentialStatus({ state: 'revoked', revokedAt: '2026-10-01' })!
    expect(text).toMatch(/REVOKED by its issuer \(since 2026-10-01\)/)
    expect(text).toMatch(/do not keep presenting it/)
    expect(statusForResult({ state: 'revoked' })).toMatchObject({ state: 'revoked', message: expect.stringMatching(/REVOKED/) })
  })

  it('an unknown answer says it could not check, why, and that the credential was used anyway', () => {
    const text = describeCredentialStatus({ state: 'unknown', reason: 'MBI did not answer within 8 seconds' })!
    expect(text).toMatch(/Could not check whether this credential has been revoked \(MBI did not answer within 8 seconds\)/)
    expect(text).toMatch(/used anyway/)
  })

  it('in a listing (nothing is being presented) it does NOT say the credential was used, and says unknown is not "revoked"', () => {
    const text = describeCredentialStatus({ state: 'unknown', reason: 'VC not found' }, false)!
    expect(text).not.toMatch(/used anyway/)
    expect(text).toMatch(/a warning, not a finding/)
    expect(text).toMatch(/does not mean the credential is revoked/)
    // A revoked credential reads the same whether it is listed or presented.
    expect(describeCredentialStatus({ state: 'revoked' }, false)).toBe(describeCredentialStatus({ state: 'revoked' }, true))
  })
})

describe('withCachedCredentialStatus (subscribe_and_issue)', () => {
  const cacheHit = { issued: true, fromCache: true, vcId: 'did:zid:vc-1', vc: { id: 'did:zid:vc-1' } }

  it('adds the status to a credential handed back from the cache, so a revoked one is not reused silently', async () => {
    const check = vi.fn().mockResolvedValue({ state: 'revoked', revokedAt: '2026-10-01' })
    const out = await withCachedCredentialStatus(cacheHit, check)
    expect(check).toHaveBeenCalledWith(cacheHit.vc)
    expect(out).toMatchObject({ ...cacheHit, credentialStatus: { state: 'revoked', message: expect.stringMatching(/REVOKED/) } })
  })

  it('leaves a freshly issued credential, a result with no credential, and a missing checker alone', async () => {
    const check = vi.fn().mockResolvedValue({ state: 'active' })
    const fresh = { issued: true, fromCache: false, vc: { id: 'x' } }
    expect(await withCachedCredentialStatus(fresh, check)).toBe(fresh)
    const noVc = { issued: false, reason: 'no', fromCache: true }
    expect(await withCachedCredentialStatus(noVc, check)).toBe(noVc)
    expect(await withCachedCredentialStatus(cacheHit, undefined)).toBe(cacheHit)
    expect(check).not.toHaveBeenCalled()
  })
})

// ---- the tools -------------------------------------------------------------------------------------------------------

function toolDeps(over: Record<string, unknown> = {}) {
  const wallet = { respondToChallenge: vi.fn().mockResolvedValue({ headerValue: 'HDR', verified: true, presentationId: 'req-1' }) }
  return {
    wallet,
    deps: {
      config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
      makeWallet: vi.fn().mockReturnValue(wallet) as never,
      payer: vi.fn(),
      subscribeDeps: {} as never,
      createAccount: vi.fn(),
      saveAccount: vi.fn(),
      queryContract: vi.fn(),
      chainQuery: vi.fn(),
      checkActivationStatus: vi.fn(),
      sleep: vi.fn(),
      ...over,
    },
  }
}

describe('prove_identity', () => {
  const vc = { id: 'did:zid:vc-1' }

  it('adds the credential status to the proof, and a revoked credential is STILL presented: it only warns', async () => {
    const credentialStatus = vi.fn().mockResolvedValue({ state: 'revoked', revokedAt: '2026-10-01' })
    const { deps, wallet } = toolDeps({ credentialStatus })
    const out = (await createTools(deps as never).prove_identity({ proofRequest: 'REQ', vc })) as Record<string, unknown>
    expect(wallet.respondToChallenge).toHaveBeenCalled()
    expect(out).toMatchObject({ proofResponseHeader: 'HDR', verified: true, presentationId: 'req-1' })
    expect(out.credentialStatus).toMatchObject({ state: 'revoked', revokedAt: '2026-10-01', message: expect.stringMatching(/REVOKED/) })
    expect(credentialStatus).toHaveBeenCalledWith(vc)
  })

  it('an unknown answer is a warning too, and the proof still comes back', async () => {
    const credentialStatus = vi.fn().mockResolvedValue({ state: 'unknown', reason: 'MBI down' })
    const { deps } = toolDeps({ credentialStatus })
    const out = (await createTools(deps as never).prove_identity({ proofRequest: 'REQ', vc })) as Record<string, unknown>
    expect(out.proofResponseHeader).toBe('HDR')
    expect(out.credentialStatus).toMatchObject({ state: 'unknown', message: expect.stringMatching(/used anyway/) })
  })

  it('an active credential carries just the state, no message', async () => {
    const { deps } = toolDeps({ credentialStatus: vi.fn().mockResolvedValue({ state: 'active' }) })
    const out = (await createTools(deps as never).prove_identity({ proofRequest: 'REQ', vc })) as Record<string, unknown>
    expect(out.credentialStatus).toEqual({ state: 'active' })
  })

  it('asks while the proof is being built, not before it: a slow check adds no wait beyond the slower of the two', async () => {
    const order: string[] = []
    const credentialStatus = vi.fn().mockImplementation(async () => {
      order.push('status asked')
      return { state: 'active' }
    })
    const { deps, wallet } = toolDeps({ credentialStatus })
    wallet.respondToChallenge.mockImplementation(async () => {
      order.push('proof built')
      return { headerValue: 'HDR', verified: true, presentationId: 'req-1' }
    })
    await createTools(deps as never).prove_identity({ proofRequest: 'REQ', vc })
    expect(order).toEqual(['status asked', 'proof built'])
  })

  it('with no checker configured the result is exactly what it was', async () => {
    const { deps } = toolDeps()
    const out = await createTools(deps as never).prove_identity({ proofRequest: 'REQ', vc })
    expect(out).toEqual({ proofResponseHeader: 'HDR', verified: true, presentationId: 'req-1' })
  })
})

describe('wallet_status', () => {
  it('lists each held credential\'s status NEXT TO the credentials, never inside them', async () => {
    const a = { id: 'did:zid:a', proof: [{ signature: 'untouched' }] }
    const b = { id: 'did:zid:b' }
    const credentialStatus = vi.fn().mockImplementation(async (vc: { id: string }) => (vc.id === 'did:zid:b' ? { state: 'revoked' } : { state: 'active' }))
    const { deps } = toolDeps({ credentialStatus })
    const out = (await createTools(deps as never).wallet_status({ heldCredentials: [a, b] })) as Record<string, unknown>
    expect(out.credentials).toEqual([a, b])
    expect(a).toEqual({ id: 'did:zid:a', proof: [{ signature: 'untouched' }] })
    expect(out.credentialStatus).toEqual([
      { id: 'did:zid:a', state: 'active' },
      { id: 'did:zid:b', state: 'revoked', message: expect.stringMatching(/REVOKED/) },
    ])
  })

  it('an unknown status in the list does not claim the credential was used', async () => {
    const { deps } = toolDeps({ credentialStatus: vi.fn().mockResolvedValue({ state: 'unknown', reason: 'VC not found' }) })
    const out = (await createTools(deps as never).wallet_status({ heldCredentials: [{ id: 'did:zid:a' }] })) as { credentialStatus: Array<{ message: string }> }
    expect(out.credentialStatus[0].message).not.toMatch(/used anyway/)
    expect(out.credentialStatus[0].message).toMatch(/warning, not a finding/)
  })

  it('asks about at most ten credentials', async () => {
    const credentialStatus = vi.fn().mockResolvedValue({ state: 'active' })
    const { deps } = toolDeps({ credentialStatus })
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `did:zid:${i}` }))
    const out = (await createTools(deps as never).wallet_status({ heldCredentials: many })) as { credentials: unknown[]; credentialStatus: unknown[] }
    expect(out.credentials).toHaveLength(15)
    expect(out.credentialStatus).toHaveLength(10)
    expect(credentialStatus).toHaveBeenCalledTimes(10)
  })

  it('no credentials: no status list; no checker: no status list', async () => {
    const { deps } = toolDeps({ credentialStatus: vi.fn() })
    const none = (await createTools(deps as never).wallet_status({ heldCredentials: [] })) as Record<string, unknown>
    expect(none.credentialStatus).toBeUndefined()
    const { deps: plain } = toolDeps()
    const out = (await createTools(plain as never).wallet_status({ heldCredentials: [{ id: 'x' }] })) as Record<string, unknown>
    expect(out.credentialStatus).toBeUndefined()
  })
})

describe('create_verification_qr', () => {
  const created = {
    created: true as const,
    link: 'https://myid.test/verify?referenceId=ref-1',
    referenceId: 'ref-1',
    expiresAt: '2026-10-19T00:00:00.000Z',
    expiresInMinutes: 5,
    revealed: 'all' as const,
    message: 'Show this link or QR code to the person.',
  }
  const vc = { id: 'did:zid:vc-1', type: ['VerifiableCredential'], credentialSubject: { agentName: 'Agent' } }

  it('attaches the credential status and warns in the message when revoked; the link is still made', async () => {
    const createVerificationLink = vi.fn().mockResolvedValue(created)
    const credentialStatus = vi.fn().mockResolvedValue({ state: 'revoked', revokedAt: '2026-10-01' })
    const { deps } = toolDeps({ createVerificationLink, credentialStatus })
    const out = (await createTools(deps as never).create_verification_qr({ vc, revealAll: true })) as Record<string, unknown>
    expect(createVerificationLink).toHaveBeenCalled()
    expect(out.created).toBe(true)
    expect(out.credentialStatus).toMatchObject({ state: 'revoked', revokedAt: '2026-10-01' })
    expect(String(out.message)).toMatch(/REVOKED by its issuer/)
  })

  it('an active credential adds the state and no warning', async () => {
    const createVerificationLink = vi.fn().mockResolvedValue(created)
    const { deps } = toolDeps({ createVerificationLink, credentialStatus: vi.fn().mockResolvedValue({ state: 'active' }) })
    const out = (await createTools(deps as never).create_verification_qr({ vc, revealAll: true })) as Record<string, unknown>
    expect(out.credentialStatus).toEqual({ state: 'active' })
    expect(String(out.message)).not.toMatch(/REVOKED|revoked/)
  })

  it('a link that could not be made is returned as it was: no status is added to a refusal', async () => {
    const refused = { created: false as const, reason: 'no link template' }
    const { deps } = toolDeps({ createVerificationLink: vi.fn().mockResolvedValue(refused), credentialStatus: vi.fn().mockResolvedValue({ state: 'active' }) })
    const out = await createTools(deps as never).create_verification_qr({ vc, revealAll: true })
    expect(out).toEqual(refused)
  })
})
