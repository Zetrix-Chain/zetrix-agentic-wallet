import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { MbiClient, MbiError } from '../clients/mbi-client'

const mbi = new MbiClient('https://mbi.test/')
afterEach(() => vi.unstubAllGlobals())

/** A message signer as Wallet BE's sign-message provides it: UTF-8 message in, hex signature + public key out. */
const sign = () => vi.fn().mockResolvedValue({ signBlob: 'sig-hex', publicKey: 'b001pk' })
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

function resp(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

const applyBody = { data: '[{"templateId":"t"}]', signData: 'sig', publicKey: 'pk' }

describe('MbiClient', () => {
  it('applyChallenge POSTs /v1/vc/pay/apply (no X-PAYMENT) and parses the 402 + paymentId', async () => {
    const body402 = {
      x402Version: 2, error: 'payment required',
      accepts: [{ scheme: 'exact', payTo: 'ZTXissuer', asset: 'JMYR', maxAmountRequired: '1000000', extra: { paymentId: 'pid-1', templateCode: 'agent-identity-credential' } }],
    }
    const fetchMock = vi.fn().mockResolvedValue(resp(402, body402))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applyChallenge(applyBody)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.method).toBe('POST')
    expect(init.headers['X-PAYMENT']).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual(applyBody)
    expect(out.paymentId).toBe('pid-1')
    expect(out.accepts).toHaveLength(1)
    expect(out.x402Version).toBe(2)
  })

  it('applySettle sends X-PAYMENT + paymentId in body and unwraps the issued VC', async () => {
    const ok = { status: 200, message: 'Success', data: { vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applySettle({ ...applyBody, paymentId: 'pid-1' }, 'BASE64PAYMENT')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.headers['X-PAYMENT']).toBe('BASE64PAYMENT')
    expect(JSON.parse(init.body)).toEqual({ ...applyBody, paymentId: 'pid-1' })
    expect(out).toEqual({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } })
  })

  it('getStatus GETs /v1/vc/pay/status/{paymentId} and unwraps data', async () => {
    const ok = { status: 200, data: { paymentId: 'pid-1', status: 'ISSUED', txHash: '0xabc', vcId: 'did:zid:vc' } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.getStatus('pid-1')

    expect(fetchMock.mock.calls[0][0]).toBe('https://mbi.test/v1/vc/pay/status/pid-1')
    expect(out.status).toBe('ISSUED')
    expect(out.vcId).toBe('did:zid:vc')
  })

  it('applyChallenge throws MbiError when phase 1 returns a non-402 error (e.g. 401 signature invalid)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { status: 401, message: 'X402_SIGNATURE_INVALID' })))
    await expect(mbi.applyChallenge(applyBody)).rejects.toMatchObject({ name: 'MbiError', httpStatus: 401 })
  })

  it('applyChallenge returns the issued VC (no accepts/paymentId) when phase 1 returns 200 for a free template', async () => {
    const ok = { status: 200, message: 'Success', data: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.applyChallenge(applyBody)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/pay/apply')
    expect(init.headers['X-PAYMENT']).toBeUndefined()
    expect(out).toEqual({
      x402Version: 1,
      accepts: [],
      issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } },
    })
    expect(out.paymentId).toBeUndefined()
  })

  it('error() caps the echoed response body so a large/malicious payload cannot bloat the error message', async () => {
    const hugeMessage = 'x'.repeat(1000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(401, { status: 401, message: 'short reason', huge: hugeMessage })))

    await expect(mbi.applyChallenge(applyBody)).rejects.toMatchObject({
      name: 'MbiError',
      httpStatus: 401,
      message: expect.stringContaining('truncated'),
    })
    try {
      await mbi.applyChallenge(applyBody)
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(1000)
    }
  })

  it('applySettle throws MbiError on a non-2xx (e.g. 402 payment invalid)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(402, { status: 402, message: 'X402_PAYMENT_INVALID' })))
    await expect(mbi.applySettle({ ...applyBody, paymentId: 'pid-1' }, 'BASE64')).rejects.toBeInstanceOf(MbiError)
  })

  it('createVp POSTs /v1/vp/ext/create with signedData, publicKey and timestamp headers and unwraps {blobId,blob}', async () => {
    const ok = { status: 200, message: 'Success', data: { blobId: 'b1', blob: 'deadbeef' } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.createVp({ vc: { id: 'vc-1' }, revealAttributes: ['mykad.name'] }, sign())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vp/ext/create')
    expect(init.method).toBe('POST')
    expect(init.headers.signedData).toBe('sig-hex')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(init.headers.timestamp).toBeDefined()
    expect(JSON.parse(init.body)).toEqual({ vc: { id: 'vc-1' }, revealAttributes: ['mykad.name'] })
    expect(out).toEqual({ blobId: 'b1', blob: 'deadbeef' })
  })

  // MBI request-bound signing (UnifiedAuthenticationFilter / RequestSignatureCanonicalizer): the caller
  // signs `METHOD|PATH|sha256hex(body)|timestamp`, with the timestamp an ISO-8601 instant sent verbatim in
  // the `timestamp` header. Binding the method, path and body hash is what stops a captured signature being
  // replayed against another endpoint or payload; the legacy scheme signed the caller's own address instead.
  describe('request-bound signing of /ext requests', () => {
    const calls: Array<[string, (m: MbiClient, s: ReturnType<typeof sign>) => Promise<unknown>, unknown]> = [
      ['createVp', (m, s) => m.createVp({ vc: { id: 'vc-1' }, revealAttributes: ['a.b'] }, s), { status: 200, data: { blobId: 'b1', blob: 'dead' } }],
      ['submitVp', (m, s) => m.submitVp({ blobId: 'b1', signedBlob: 'sig', publicKey: 'pk', includeVp: true }, s), { status: 200, data: { id: 'v2-ref' } }],
      ['downloadVcs', (m, s) => m.downloadVcs({ address: 'ZTX3Holder' }, s), { status: 200, data: [] }],
    ]
    const paths: Record<string, string> = {
      createVp: '/v1/vp/ext/create',
      submitVp: '/v1/vp/ext/submit',
      downloadVcs: '/v1/vc/ext/download',
    }

    it.each(calls)('%s sends a timestamp header that is an ISO-8601 instant', async (_name, call, okBody) => {
      const fetchMock = vi.fn().mockResolvedValue(resp(200, okBody))
      vi.stubGlobal('fetch', fetchMock)

      await call(mbi, sign())

      const ts = fetchMock.mock.calls[0][1].headers.timestamp as string
      expect(new Date(ts).toISOString()).toBe(ts)
    })

    it.each(calls)('%s signs METHOD|PATH|sha256(exact body sent)|timestamp, never the bare address', async (name, call, okBody) => {
      const fetchMock = vi.fn().mockResolvedValue(resp(200, okBody))
      vi.stubGlobal('fetch', fetchMock)
      const signer = sign()

      await call(mbi, signer)

      const init = fetchMock.mock.calls[0][1]
      expect(signer).toHaveBeenCalledTimes(1)
      expect(signer).toHaveBeenCalledWith(`POST|${paths[name]}|${sha256Hex(init.body)}|${init.headers.timestamp}`)
    })

    it('signs once per request: two calls in one VP flow each get their own signature', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200, data: { blobId: 'b1', blob: 'dead', id: 'v2-ref' } })))
      const signer = sign()

      await mbi.createVp({ vc: {}, revealAttributes: [] }, signer)
      await mbi.submitVp({ blobId: 'b1', signedBlob: 's', publicKey: 'pk' }, signer)

      expect(signer).toHaveBeenCalledTimes(2)
      const [first, second] = signer.mock.calls.map((c: unknown[]) => c[0] as string)
      expect(first).not.toBe(second)
    })

    it('does not send the request when signing fails', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const failing = vi.fn().mockRejectedValue(new Error('Wallet BE unavailable'))

      await expect(mbi.createVp({ vc: {}, revealAttributes: [] }, failing)).rejects.toThrow('Wallet BE unavailable')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    // A signer that answers without a signature or key would otherwise put empty or "undefined" headers
    // on the wire, which MBI answers with an opaque 401/403 — and for the one-shot download that burns the call.
    const badSignerResults: Array<[string, unknown]> = [
      ['an empty signature', { signBlob: '', publicKey: 'b001pk' }],
      ['an empty public key', { signBlob: 'sig-hex', publicKey: '' }],
      ['no signature field', { publicKey: 'b001pk' }],
      ['no public key field', { signBlob: 'sig-hex' }],
      ['no result at all', undefined],
    ]
    describe.each(calls)('%s signer validation', (_name, call, okBody) => {
      it.each(badSignerResults)('does not send the request when the signer returns %s', async (_label, result) => {
        const fetchMock = vi.fn().mockResolvedValue(resp(200, okBody))
        vi.stubGlobal('fetch', fetchMock)
        const badSigner = vi.fn().mockResolvedValue(result) as unknown as ReturnType<typeof sign>

        await expect(call(mbi, badSigner)).rejects.toBeInstanceOf(MbiError)
        expect(fetchMock).not.toHaveBeenCalled()
      })
    })

    // A redirect on a signed POST would be followed with the same body, signature and timestamp, replaying
    // a signature MBI treats as single-use. A redirect is a misconfiguration to surface, not to follow.
    it.each(calls)('%s does not follow redirects', async (_name, call, okBody) => {
      const fetchMock = vi.fn().mockResolvedValue(resp(200, okBody))
      vi.stubGlobal('fetch', fetchMock)

      await call(mbi, sign())

      expect(fetchMock.mock.calls[0][1].redirect).toBe('error')
    })

    it.each(calls)('%s reports a redirect as a base-URL misconfiguration', async (_name, call) => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: new Error('unexpected redirect') }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(call(mbi, sign())).rejects.toThrow(/redirect.*check MBI_BASE_URL/)
    })

    // The signed path is the API path MBI itself sees. A base URL that carries a path prefix is sent as given
    // (a gateway in front of MBI is expected to strip it), and the prefix is deliberately not part of the signature.
    it('signs the API path, not a path prefix on the base URL', async () => {
      const fetchMock = vi.fn().mockResolvedValue(resp(200, { status: 200, data: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const signer = sign()

      await new MbiClient('https://mbi.test/gateway').downloadVcs({ address: 'ZTX3Holder' }, signer)

      expect(fetchMock.mock.calls[0][0]).toBe('https://mbi.test/gateway/v1/vc/ext/download')
      expect(signer.mock.calls[0][0]).toMatch(/^POST\|\/v1\/vc\/ext\/download\|/)
    })

    // MBI treats each signed request as single-use, keyed on the signed string. Two identical requests made in
    // the same millisecond would sign the same string and the second would be refused as already used.
    it('gives two identical requests in the same instant different timestamps and signatures', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-10-02T04:00:00.000Z'))
        const fetchMock = vi.fn().mockResolvedValue(resp(200, { status: 200, data: [] }))
        vi.stubGlobal('fetch', fetchMock)
        const signer = sign()

        await mbi.downloadVcs({ address: 'ZTX3Holder' }, signer)
        await mbi.downloadVcs({ address: 'ZTX3Holder' }, signer)

        const [first, second] = fetchMock.mock.calls.map((c) => c[1].headers.timestamp as string)
        expect(second).not.toBe(first)
        expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime())
        expect(signer.mock.calls[1][0]).not.toBe(signer.mock.calls[0][0])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('createVp throws MbiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { status: 403, message: 'Authenticated DID does not match VC credential subject ID' })))
    await expect(
      mbi.createVp({ vc: {}, revealAttributes: [] }, sign()),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 403 })
  })

  it('submitVp POSTs /v1/vp/ext/submit with includeVp + signedData, publicKey and timestamp headers and unwraps {id,vp}', async () => {
    const vp = { holder: 'did:zid:h', verifiableCredential: [{ id: 'vc-1' }] }
    const ok = { status: 200, message: 'Success', data: { id: 'v2-ref-1', vp } }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.submitVp({ blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk', includeVp: true }, sign())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vp/ext/submit')
    expect(init.headers.signedData).toBe('sig-hex')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(init.headers.timestamp).toBeDefined()
    expect(JSON.parse(init.body)).toEqual({ blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk', includeVp: true })
    expect(out).toEqual({ id: 'v2-ref-1', vp })
  })

  it('submitVp omits vp from the result when includeVp is not set (MBI omits the key entirely)', async () => {
    const ok = { status: 200, message: 'Success', data: { id: 'v2-ref-2' } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok)))

    const out = await mbi.submitVp(
      { blobId: 'b1', signedBlob: 'sig', publicKey: 'b001pk' },
      sign(),
    )

    expect(out).toEqual({ id: 'v2-ref-2' })
    expect(out.vp).toBeUndefined()
  })

  it('submitVp throws MbiError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { status: 403, message: 'Authenticated address does not match request public key address' })))
    await expect(
      mbi.submitVp({ blobId: 'b1', signedBlob: 's', publicKey: 'pk' }, sign()),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 403 })
  })

  it('downloadVcs POSTs /v1/vc/ext/download with signedData, publicKey and timestamp headers and unwraps the list', async () => {
    const ok = { status: 200, data: [{ vc: { id: 'did:zid:vc-1' }, extraData: { foo: 'bar' } }] }
    const fetchMock = vi.fn().mockResolvedValue(resp(200, ok))
    vi.stubGlobal('fetch', fetchMock)

    const out = await mbi.downloadVcs({ address: 'ZTX3Holder' }, sign())

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://mbi.test/v1/vc/ext/download')
    expect(init.headers.signedData).toBe('sig-hex')
    expect(init.headers.publicKey).toBe('b001pk')
    expect(init.headers.timestamp).toBeDefined()
    expect(JSON.parse(init.body)).toEqual({ address: 'ZTX3Holder' })
    expect(out).toEqual([{ vc: { id: 'did:zid:vc-1' }, extraData: { foo: 'bar' } }])
  })

  it('downloadVcs throws MbiError on a non-2xx response (e.g. address mismatch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(403, { status: 403, message: 'address mismatch' })))
    await expect(
      mbi.downloadVcs({ address: 'ZTX3Other' }, sign()),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 403 })
  })

  // Confirmed live against MBI (2026-08-17): a 2xx response whose `data` field is not an array
  // (observed transiently right as an async issuance was still landing) must not be handed to a
  // caller expecting MbiVcEntry[] — that produced a raw, undiagnosable
  // "entries.find is not a function" crash in checkAiBirthcertVerification instead of a clean error.
  it('downloadVcs throws MbiError (not a raw TypeError downstream) when a 2xx response has a non-array data field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200, data: {} })))
    await expect(
      mbi.downloadVcs({ address: 'ZTX3Holder' }, sign()),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 200, message: expect.stringContaining('non-array') })
  })

  it('downloadVcs throws MbiError when a 2xx response has no data field at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, { status: 200 })))
    await expect(
      mbi.downloadVcs({ address: 'ZTX3Holder' }, sign()),
    ).rejects.toMatchObject({ name: 'MbiError', httpStatus: 200 })
  })

  // Confirmed live against MBI (2026-08-17, real successful download captured after fixing the
  // crash above): MBI's actual response for this endpoint double-wraps the list —
  // `body.data.data` is the array, NOT `body.data` directly, contradicting SPEC.md's documented
  // (never-live-verified-until-now) single-level `{ data: [...] }` example.
  it('downloadVcs unwraps a double-nested { data: { data: [...] } } envelope (the real MBI shape)', async () => {
    const ok = {
      status: 200,
      message: 'OK',
      data: { data: [{ vc: { id: 'did:zid:vc-1' }, extraData: { vcPassBase64: null }, status: 'ISSUED' }] },
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok)))

    const out = await mbi.downloadVcs({ address: 'ZTX3Holder' }, sign())

    expect(out).toEqual([{ vc: { id: 'did:zid:vc-1' }, extraData: { vcPassBase64: null }, status: 'ISSUED' }])
  })
})

// MBI's ResponseWrapper carries a numeric `status` code that is finer-grained than the HTTP
// status: 4012 X402_SETTLEMENT_INDETERMINATE (HTTP 502) means the settle outcome is UNKNOWN and
// may yet have succeeded, whereas 4006 (HTTP 402) is a definitive facilitator failure. Both used
// to arrive as an opaque message string, so the wallet could not branch on them.
describe('MbiClient error codes', () => {
  it('parses MBI\'s numeric status code out of the error body onto the MbiError', async () => {
    const body = { status: 4012, message: 'Payment settlement outcome is indeterminate', data: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(502, body)))

    const err = await mbi.applySettle(applyBody, 'X-PAYMENT-B64').catch((e: MbiError) => e)

    expect(err).toBeInstanceOf(MbiError)
    expect((err as MbiError).mbiStatus).toBe(4012)
    expect((err as MbiError).httpStatus).toBe(502)
  })

  it('distinguishes a definitive 4006 facilitator failure from the indeterminate 4012', async () => {
    const body = { status: 4006, message: 'Facilitator settlement failed: timeout', data: null }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(402, body)))

    const err = await mbi.applySettle(applyBody, 'X-PAYMENT-B64').catch((e: MbiError) => e)

    expect((err as MbiError).mbiStatus).toBe(4006)
  })

  it('leaves mbiStatus undefined when the error body carries no numeric status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(400, { message: 'X402_SIGNATURE_INVALID' })))

    const err = await mbi.applySettle(applyBody, 'X-PAYMENT-B64').catch((e: MbiError) => e)

    expect((err as MbiError).mbiStatus).toBeUndefined()
    expect((err as MbiError).httpStatus).toBe(400)
  })
})

// MBI's facilitator read timeout is 60s, so any client-side deadline
// below that would abort a settle MBI is still legitimately waiting on — manufacturing exactly
// the indeterminate state that MR set out to avoid. Ours must be explicit and comfortably above it.
describe('MbiClient request timeout', () => {
  it('sends an AbortSignal whose timeout clears MBI\'s 60s facilitator read timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { data: { vcId: 'v' } }))
    vi.stubGlobal('fetch', fetchMock)

    await mbi.applySettle(applyBody, 'X-PAYMENT-B64')

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(MbiClient.DEFAULT_TIMEOUT_MS).toBeGreaterThan(60_000)
  })

  it('honours an explicit timeout override', async () => {
    const custom = new MbiClient('https://mbi.test/', { timeoutMs: 1234 })
    const fetchMock = vi.fn().mockResolvedValue(resp(200, { data: {} }))
    vi.stubGlobal('fetch', fetchMock)

    await custom.getStatus('pid-1')

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(custom.timeoutMs).toBe(1234)
  })

  describe('quote', () => {
    const quoteOk = {
      status: 200,
      message: 'Success',
      data: {
        accepts: [
          {
            scheme: 'exact',
            payTo: 'ZTX3issuer',
            asset: 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b',
            maxAmountRequired: '1000000',
            extra: { paymentId: null, templateCode: 'ai-birthcert' },
          },
        ],
        signPayload: '[{"templateId":"did:zid:t","metadata":{}}]',
      },
    }

    it('POSTs /v1/vc/pay/quote with templateId + data and unwraps accepts', async () => {
      const fetchMock = vi.fn().mockResolvedValue(resp(200, quoteOk))
      vi.stubGlobal('fetch', fetchMock)

      const out = await mbi.quote('did:zid:t', { preflight: 'quote-only' })

      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://mbi.test/v1/vc/pay/quote')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body)).toEqual({ templateId: 'did:zid:t', data: { preflight: 'quote-only' } })
      // No X-PAYMENT: a quote is not a payment, and sending one would be a different request.
      expect(init.headers['X-PAYMENT']).toBeUndefined()
      expect(out.accepts).toHaveLength(1)
      expect(out.accepts[0].maxAmountRequired).toBe('1000000')
      expect(out.signPayload).toContain('did:zid:t')
    })

    // paymentId being null is what marks the response as a quote rather than a payable challenge.
    // If MBI ever started issuing one here, a caller could mistake a quote for a live 402.
    it('carries a null paymentId, distinguishing a quote from a payable challenge', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, quoteOk)))
      const out = await mbi.quote('did:zid:t', { preflight: 'quote-only' })
      expect(out.accepts[0].extra?.paymentId).toBeNull()
    })

    it('throws MbiError on a non-2xx, carrying the status and the body', async () => {
      const notFound = { status: 4011, message: 'Template not found, inactive, or not issued by the configured issuer', data: null }
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(404, notFound)))

      await expect(mbi.quote('did:zid:nope', { preflight: 'quote-only' })).rejects.toThrow(MbiError)
      await expect(mbi.quote('did:zid:nope', { preflight: 'quote-only' })).rejects.toThrow(/Template not found/)
    })
  })
})
