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

const requestBody = {
  publicKey: 'b001pk', address: 'ZTX3Agent', timestamp: '2026-08-17T09:00:00Z',
  signedData: 'sig', agentName: 'Procurement Assistant', id: 'Procurement Assistant',
  ownerReference: 'did:zid:owner',
}

describe('SsivcClient', () => {
  describe('createSessionChallenge', () => {
    it('POSTs with no payment headers or Authorization, and parses the 402 accepts[] envelope', async () => {
      const body402 = {
        x402Version: 2, error: 'payment_required',
        accepts: [{ scheme: 'exact', network: 'zetrix:testnet', asset: 'ZTX', payTo: 'ZTX3Pay', maxAmountRequired: '1000', extra: [] }],
      }
      const fetchMock = vi.fn().mockResolvedValue(resp(402, body402))
      vi.stubGlobal('fetch', fetchMock)

      const out = await ssivc.createSessionChallenge(requestBody)

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://ssivc.test/api/v2/verify/ai-birthcert/sessions')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBeUndefined()
      expect(init.headers['X-Payment']).toBeUndefined()
      expect(JSON.parse(init.body)).toEqual(requestBody)
      expect(out).toEqual({ x402Version: 2, accepts: body402.accepts })
    })

    it('throws SsivcError when phase 1 does not return 402 (unexpected)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: {} })))
      await expect(ssivc.createSessionChallenge(requestBody)).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 200 })
    })
  })

  describe('createSessionSettle', () => {
    it('retries with X-Payment (no Authorization) and returns the session plus the X-Payment-Response receipt', async () => {
      const ok = { status_code: '00', data: { sessionId: 's-1', verification_url: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' } }
      const fetchMock = vi.fn().mockResolvedValue(resp(200, ok, { 'X-Payment-Response': 'receipt-abc' }))
      vi.stubGlobal('fetch', fetchMock)

      const out = await ssivc.createSessionSettle(requestBody, 'BASE64PAYMENT')

      const [, init] = fetchMock.mock.calls[0]
      expect(init.headers['X-Payment']).toBe('BASE64PAYMENT')
      expect(init.headers['X-Payment-Response']).toBeUndefined()
      expect(init.headers.Authorization).toBeUndefined()
      expect(out).toEqual({
        session: { sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' },
        paymentReceipt: 'receipt-abc',
      })
    })

    it('throws SsivcError with kind "payment_invalid" on a 402 payment_invalid', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(402, { error: 'payment_invalid' })))
      await expect(ssivc.createSessionSettle(requestBody, 'BAD')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 402, kind: 'payment_invalid' })
    })

    it('throws SsivcError with kind "facilitator_unavailable" on a 503', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(503, { error: 'facilitator_unavailable' })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 503, kind: 'facilitator_unavailable' })
    })

    it('throws SsivcError with kind "blob_already_settled" on a 409', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { error: 'blob_already_settled' })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 409, kind: 'blob_already_settled' })
    })

    it('still classifies kind "blob_already_settled" on a 409 with a non-JSON body (e.g. a proxy error page)', async () => {
      // APP-L01: kind classification must not depend on the body parsing as JSON, since a 409
      // routed through an intermediary (a proxy, a gateway) can arrive as an HTML error page.
      const htmlResp = {
        ok: false, status: 409,
        json: async () => { throw new Error('not JSON') },
        text: async () => '<html><body>409 Conflict</body></html>',
        headers: { get: () => null },
      }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResp))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 409, kind: 'blob_already_settled' })
    })

    it('throws SsivcError on a 2xx with no X-Payment-Response header', async () => {
      const ok = { status_code: '00', data: { sessionId: 's-1', verification_url: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:30:00+00:00' } }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok)))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({
        name: 'SsivcError', message: expect.stringContaining('X-Payment-Response'),
      })
    })

    it('throws SsivcError on a 2xx with malformed data envelope', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: null }, { 'X-Payment-Response': 'r' })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({
        name: 'SsivcError', message: expect.stringContaining('malformed data envelope'),
      })
    })
  })

  describe('createSessionWithReceipt', () => {
    it('retries with X-Payment-Response only (no X-Payment, no Authorization)', async () => {
      const ok = { status_code: '00', data: { sessionId: 's-2', verification_url: 'https://zvg.test/verify/tok2', expiresAt: '2026-08-17T10:00:00+00:00' } }
      const fetchMock = vi.fn().mockResolvedValue(resp(200, ok, { 'X-Payment-Response': 'receipt-abc' }))
      vi.stubGlobal('fetch', fetchMock)

      const out = await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')

      const [, init] = fetchMock.mock.calls[0]
      expect(init.headers['X-Payment-Response']).toBe('receipt-abc')
      expect(init.headers['X-Payment']).toBeUndefined()
      expect(init.headers.Authorization).toBeUndefined()
      expect(out).toEqual({
        session: { sessionId: 's-2', verificationUrl: 'https://zvg.test/verify/tok2', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'receipt-abc',
      })
    })
  })

  describe('getSession', () => {
    it('GETs without any Authorization header and reports pending (no vcId)', async () => {
      const ok = { status_code: '00', data: { sessionId: 's-1', status: 'pending', expiresAt: '2026-08-17T09:30:00+00:00' } }
      const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
      vi.stubGlobal('fetch', fetchMock)

      const out = await ssivc.getSession('s-1')

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://ssivc.test/api/v2/verify/ai-birthcert/sessions/s-1')
      expect(init.headers.Authorization).toBeUndefined()
      expect(out).toEqual({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-17T09:30:00+00:00' })
      expect(out.vcId).toBeUndefined()
    })

    it('reports vcId when status is issued', async () => {
      const ok = { status_code: '00', data: { sessionId: 's-1', status: 'issued', expiresAt: '2026-08-17T09:30:00+00:00', vcId: 'did:zid:vc-1' } }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok)))
      const out = await ssivc.getSession('s-1')
      expect(out).toEqual({ sessionId: 's-1', status: 'issued', expiresAt: '2026-08-17T09:30:00+00:00', vcId: 'did:zid:vc-1' })
    })

    it('throws SsivcError on a 2xx with malformed data envelope', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status_code: '00', data: null })))
      await expect(ssivc.getSession('s-1')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 200, message: expect.stringContaining('malformed data envelope') })
    })

    it('throws SsivcError on a 404 (session not found)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(404, { status_code: '23', errors: ['Issuance session not found.'] })))
      await expect(ssivc.getSession('missing')).rejects.toMatchObject({ name: 'SsivcError', httpStatus: 404 })
    })

    it('URL-encodes the sessionId path segment', async () => {
      const ok = { status_code: '00', data: { sessionId: 'a/b', status: 'pending', expiresAt: '2026-08-17T09:30:00+00:00' } }
      const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
      vi.stubGlobal('fetch', fetchMock)
      await ssivc.getSession('a/b')
      expect(fetchMock.mock.calls[0][0]).toBe('https://ssivc.test/api/v2/verify/ai-birthcert/sessions/a%2Fb')
    })
  })
})
