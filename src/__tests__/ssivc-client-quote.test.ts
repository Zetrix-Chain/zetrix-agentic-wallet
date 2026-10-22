import { describe, it, expect, vi, afterEach } from 'vitest'
import { SsivcClient, SsivcError } from '../clients/ssivc-client'

const ssivc = new SsivcClient('https://ssivc.test/api')
afterEach(() => vi.unstubAllGlobals())

function resp(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  }
}

const quoteBody = { publicKey: 'b001pk', address: 'ZTX3Agent', timestamp: '2026-10-22T09:00:00Z', ownerReference: 'did:zid:owner', signedData: 'sig' }
const sessionBody = { ...quoteBody, agentName: 'Procurement Assistant', id: 'Procurement Assistant' }

const CLIENT_OPTION = { scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX3Jmyr', payTo: 'ZTX3Pay', maxAmountRequired: '0', extra: { gasModel: 'client' } }
const FACILITATOR_OPTION = {
  ...CLIENT_OPTION,
  extra: { gasModel: 'facilitator', prepareEndpoint: 'https://public-api-sandbox.zetrix.com/api/facilitator/prepare' },
}

describe('SsivcClient.quoteSession', () => {
  it('POSTs the body to /sessions/quote with no payment headers and returns paymentRequired and accepts[]', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: { paymentRequired: false, accepts: [CLIENT_OPTION, FACILITATOR_OPTION] } }))
    vi.stubGlobal('fetch', fetchMock)

    const out = await ssivc.quoteSession(quoteBody)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ssivc.test/api/v2/verify/ai-birthcert/sessions/quote')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual(quoteBody)
    expect(init.headers['X-Payment']).toBeUndefined()
    expect(out).toEqual({ paymentRequired: false, accepts: [CLIENT_OPTION, FACILITATOR_OPTION] })
  })

  it('reports paymentRequired true when SSIVC says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: { paymentRequired: true, accepts: [CLIENT_OPTION] } })))
    expect((await ssivc.quoteSession(quoteBody))?.paymentRequired).toBe(true)
  })

  it.each([
    ['absent', undefined],
    ['the string "false"', 'false'],
    ['the number 0', 0],
    ['null', null],
  ])('never reads %s as free: paymentRequired is undefined, not false', async (_label, value) => {
    const data: Record<string, unknown> = { accepts: [CLIENT_OPTION] }
    if (value !== undefined) data.paymentRequired = value
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data })))

    const out = await ssivc.quoteSession(quoteBody)

    expect(out?.paymentRequired).toBeUndefined()
  })

  it.each([404, 405])('returns undefined when this SSIVC has no quote route (HTTP %i), so the caller can use the 402 check', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(status, { message: 'not found' })))
    expect(await ssivc.quoteSession(quoteBody)).toBeUndefined()
  })

  it('throws a validation error for a 422, with SSIVC\'s status code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(422, { status_code: '22', errors: { publicKey: 'The public key field is required.' } })))
    const err = await ssivc.quoteSession(quoteBody).catch((e: unknown) => e as SsivcError)
    expect(err).toBeInstanceOf(SsivcError)
    expect(err.kind).toBe('validation')
    expect(err.statusCode).toBe('22')
  })

  it.each([
    ['50', 'Signature Verification failed.'],
    ['55', 'Session data expired. Please try again.'],
  ])('throws for SSIVC status code %s, the same errors /sessions gives', async (code, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(400, { status_code: code, errors: [message] })))
    const err = await ssivc.quoteSession(quoteBody).catch((e: unknown) => e as SsivcError)
    expect(err).toBeInstanceOf(SsivcError)
    expect(err.statusCode).toBe(code)
    expect(err.message).toContain(message)
  })

  it('throws on a 2xx that does not say it is free and has no accepts list, rather than inventing one', async () => {
    for (const data of [{ paymentRequired: true }, {}, { paymentRequired: 'false' }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data })))
      await expect(ssivc.quoteSession(quoteBody)).rejects.toThrow(/malformed data envelope/)
    }
  })

  it('accepts a free answer with no accepts list: there is nothing to choose, and it is still free', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: { paymentRequired: false } })))
    expect(await ssivc.quoteSession(quoteBody)).toEqual({ paymentRequired: false, accepts: [] })
  })

  it('throws when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(ssivc.quoteSession(quoteBody)).rejects.toThrow(/request failed/)
  })
})

describe('SsivcClient.startSession', () => {
  it('returns the challenge for a 402', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(402, { x402Version: 2, accepts: [CLIENT_OPTION] })))
    expect(await ssivc.startSession(sessionBody)).toEqual({ kind: 'challenge', challenge: { x402Version: 2, accepts: [CLIENT_OPTION] } })
  })

  it.each([200, 201])('returns the session SSIVC created without asking for payment (HTTP %i)', async (status) => {
    const created = { status_code: '00', data: { sessionId: 's-free', verification_url: 'https://zvg.test/verify/tok', expiresAt: '2026-10-22T09:30:00+00:00' } }
    const fetchMock = vi.fn().mockResolvedValue(resp(status, created))
    vi.stubGlobal('fetch', fetchMock)

    const out = await ssivc.startSession(sessionBody)

    expect(out).toEqual({
      kind: 'created',
      session: { sessionId: 's-free', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-10-22T09:30:00+00:00' },
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['X-Payment']).toBeUndefined()
    expect(init.headers['X-Payment-Response']).toBeUndefined()
  })

  it('throws on a created session with no link rather than handing back half a session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: { sessionId: 's-free' } })))
    await expect(ssivc.startSession(sessionBody)).rejects.toThrow(/malformed data envelope/)
  })

  it.each([[{ status_code: '00' }], [{ status_code: '00', data: null }], [{ status_code: '00', data: 'ok' }]])('throws on a 2xx with no usable data (%j)', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, body)))
    await expect(ssivc.startSession(sessionBody)).rejects.toBeInstanceOf(SsivcError)
  })

  it('classifies a taken name as agent_name_in_use', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { status_code: '26', errors: ['agent name already in use'] })))
    const err = await ssivc.startSession(sessionBody).catch((e: unknown) => e as SsivcError)
    expect(err.kind).toBe('agent_name_in_use')
  })

  it('throws for any other status instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(500, { message: 'boom' })))
    await expect(ssivc.startSession(sessionBody)).rejects.toBeInstanceOf(SsivcError)
  })

  it('leaves createSessionChallenge strict: it still refuses anything but a 402', async () => {
    const created = { status_code: '00', data: { sessionId: 's-free', verification_url: 'https://zvg.test/verify/tok', expiresAt: 'x' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, created)))
    await expect(ssivc.createSessionChallenge(sessionBody)).rejects.toThrow(/expected 402/)
  })
})
