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
        kind: 'settled',
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

    // a 409 that SSIVC labels status_code 26 is a taken agentName, not a settled payment -
    // the two must not be conflated, because one says "your fee was taken" and the other says no fee was.
    it('classifies a 409 with status_code 26 as kind "agent_name_in_use", not blob_already_settled', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { status_code: '26', errors: ['agentName already in use'] })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({
        name: 'SsivcError', httpStatus: 409, statusCode: '26', kind: 'agent_name_in_use',
      })
    })

    // R12-M01: the classification is deliberately narrow, and every widening below turns a money
    // message from "cautious" to "confident". A status_code 26 on the wrong HTTP status, or a numeric 26
    // where the wire format is a string, must fail SAFE.
    it.each([400, 402, 422, 500, 503])(
      'does NOT classify status_code 26 on HTTP %i as agent_name_in_use',
      async (status) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(status, { status_code: '26', errors: ['x'] })))
        await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({ httpStatus: status })
        await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.not.toMatchObject({ kind: 'agent_name_in_use' })
      },
    )

    it('does NOT classify a numeric status_code 26 on a 409 - it falls back to the cautious kind', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { status_code: 26, errors: ['agentName already in use'] })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({
        httpStatus: 409, kind: 'blob_already_settled',
      })
    })

    it('keeps a 409 with any OTHER status_code as blob_already_settled', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(409, { status_code: '99', errors: ['conflict'] })))
      await expect(ssivc.createSessionSettle(requestBody, 'X')).rejects.toMatchObject({ httpStatus: 409, kind: 'blob_already_settled' })
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
        kind: 'settled',
        session: { sessionId: 's-2', verificationUrl: 'https://zvg.test/verify/tok2', expiresAt: '2026-08-17T10:00:00+00:00' },
        paymentReceipt: 'receipt-abc',
      })
    })
  })

  describe('createSessionSettle — sponsored settlement', () => {
    it('returns kind:queued with the receipt and Retry-After on 202', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        resp(202, { status_code: '00', data: { settlement: 'pending' } }, { 'X-Payment-Response': 'receipt-abc', 'Retry-After': '30' }),
      ))
      const out = await ssivc.createSessionSettle(requestBody, 'xpay-blob')
      expect(out).toEqual({ kind: 'queued', paymentReceipt: 'receipt-abc', retryAfterSeconds: 30 })
    })

    it('defaults retryAfterSeconds when Retry-After is absent or unparseable', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        resp(202, { status_code: '00', data: {} }, { 'X-Payment-Response': 'receipt-abc' }),
      ))
      const out = await ssivc.createSessionSettle(requestBody, 'xpay-blob')
      expect(out).toMatchObject({ kind: 'queued', retryAfterSeconds: 15 })
    })

    it('throws when a 202 carries no receipt — nothing to retry with', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(202, { status_code: '00', data: {} })))
      await expect(ssivc.createSessionSettle(requestBody, 'xpay-blob')).rejects.toThrow(/no X-Payment-Response/)
    })

    it('still returns kind:settled on 200 — self-pay unchanged', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        resp(200, { status_code: '00', data: { sessionId: 's-1', verification_url: 'https://zvg/verify/t', expiresAt: '2026-08-21T08:30:00Z' } }, { 'X-Payment-Response': 'receipt-xyz' }),
      ))
      const out = await ssivc.createSessionSettle(requestBody, 'xpay-blob')
      expect(out).toEqual({
        kind: 'settled',
        session: { sessionId: 's-1', verificationUrl: 'https://zvg/verify/t', expiresAt: '2026-08-21T08:30:00Z' },
        paymentReceipt: 'receipt-xyz',
      })
    })

    it('returns kind:queued from a receipt-only retry while still settling', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        resp(202, { status_code: '00', data: { settlement: 'pending' } }, { 'X-Payment-Response': 'receipt-abc', 'Retry-After': '10' }),
      ))
      const out = await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')
      expect(out).toMatchObject({ kind: 'queued', retryAfterSeconds: 10 })
    })

    // Observed live on UAT 2026-09-21 by replaying two independently stuck receipts
    // (5fa7ea4e, and the Avatar run's 7e549af8): SSIVC answers `400` + `status_code "69"` +
    // "Payment settlement status could not be confirmed. Please retry."
    //
    // Root cause per the SSIVC team: the facilitator left the blob QUEUED until its payment window
    // elapsed and reported EXPIRED, which SSIVC does not model — so the settlement outcome is
    // genuinely unresolved on their side, not confirmed-failed. It is emitted with a dedicated code
    // now, which is why this keys on `69` and not on the message text.
    describe('a settlement SSIVC cannot confirm', () => {
      it('classifies 400 + status_code 69 as kind "settlement_unconfirmed"', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          resp(400, { status_code: '69', errors: ['Payment settlement status could not be confirmed. Please retry.'] }),
        ))

        await expect(ssivc.createSessionWithReceipt(requestBody, 'r-stuck')).rejects.toMatchObject({
          name: 'SsivcError', httpStatus: 400, statusCode: '69', kind: 'settlement_unconfirmed',
        })
      })

      // The money-safety boundary. "99" is SSIVC's GENERIC bucket — observed on the same endpoint
      // for "Unknown or malformed payment receipt." Treating it as a settlement state would let an
      // ordinary server error drive the wallet's payment decisions.
      it('leaves a generic 400 + status_code 99 as plain validation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          resp(400, { status_code: '99', errors: ['Unknown or malformed payment receipt.'] }),
        ))

        await expect(ssivc.createSessionWithReceipt(requestBody, 'r-unknown')).rejects.toMatchObject({
          name: 'SsivcError', httpStatus: 400, kind: 'validation',
        })
      })

      // The UAT OpenAPI spec (Applications - AI Birthcert -> createAiBirthcertIssuanceSession, the
      // examples nested under its single 400) documents three settlement verdicts, not one. 67 and 68
      // are terminal; only 69 means "ask again later".
      it('classifies 67 (sponsored settlement expired) as kind "settlement_void"', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          resp(400, { status_code: '67', errors: ['Sponsored settlement expired. Payment required again.'] }),
        ))

        await expect(ssivc.createSessionWithReceipt(requestBody, 'r-expired')).rejects.toMatchObject({
          name: 'SsivcError', httpStatus: 400, statusCode: '67', kind: 'settlement_void',
        })
      })

      // The exact message the QA run received on 18 Sep, which now carries a code.
      it('classifies 68 (settlement failed, receipt unusable) as kind "settlement_void"', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          resp(400, { status_code: '68', errors: ['Payment settlement failed. This receipt can no longer be used.'] }),
        ))

        await expect(ssivc.createSessionWithReceipt(requestBody, 'r-failed')).rejects.toMatchObject({
          name: 'SsivcError', httpStatus: 400, statusCode: '68', kind: 'settlement_void',
        })
      })

      // Terminal and indeterminate must never collapse into one kind: one says stop, the other says wait.
      it('keeps 69 distinct from the two terminal codes', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
          resp(400, { status_code: '69', errors: ['Payment settlement status could not be confirmed. Please retry.'] }),
        ))

        const err = await ssivc.createSessionWithReceipt(requestBody, 'r-unknown').catch((e) => e)
        expect(err.kind).toBe('settlement_unconfirmed')
        expect(err.kind).not.toBe('settlement_void')
      })

      // 69 is about a settlement; on any other status it is not one we recognise.
      it('does not read 69 out of an unrelated HTTP status', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(500, { status_code: '69', errors: ['boom'] })))

        const err = await ssivc.createSessionWithReceipt(requestBody, 'r').catch((e) => e)
        expect(err.kind).not.toBe('settlement_unconfirmed')
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
