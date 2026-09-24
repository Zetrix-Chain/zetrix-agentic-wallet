import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { SsivcClient } from '../clients/ssivc-client'

/**
 * opt-in wire tracing (`SSIVC_TRACE=1`). It exists because a stalled settlement could not
 * be diagnosed from either side — SSIVC keeps no full response bodies and the wallet sits behind the
 * plugin host — so the wallet itself must be able to print the exact request and response. It is
 * OFF by default because the trace contains the payment receipt, a bearer handle on a real payment.
 */

const ssivc = new SsivcClient('https://ssivc.test/api')

const requestBody = {
  publicKey: 'b001pk', address: 'ZTX3Agent', timestamp: '2026-08-17T09:00:00Z',
  signedData: 'sig', agentName: 'Procurement Assistant', id: 'Procurement Assistant',
  ownerReference: 'did:zid:owner',
}

function resp(status: number, body: unknown, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const text = JSON.stringify(body)
  const self = {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    // The tracer reads a CLONE so the caller can still read the body.
    clone: () => ({ text: async () => text }),
  }
  return self
}

const ok200 = {
  status_code: '00',
  data: { sessionId: 's-1', verification_url: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:15:00+00:00' },
}

let stderr: ReturnType<typeof vi.spyOn>
const written = (): string => stderr.mock.calls.map((c) => String(c[0])).join('')

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})
afterEach(() => {
  stderr.mockRestore()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('SSIVC_TRACE wire logging', () => {
  it('writes nothing by default', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'receipt-abc' })))
    await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')
    expect(written()).toBe('')
  })

  it.each(['true', '0', 'yes', ''])('is enabled ONLY by the exact value "1" (not %j)', async (value) => {
    vi.stubEnv('SSIVC_TRACE', value)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'receipt-abc' })))
    await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')
    expect(written()).toBe('')
  })

  it('prints the exact request and response, and the caller still gets its parsed result', async () => {
    vi.stubEnv('SSIVC_TRACE', '1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'receipt-abc' })))

    const out = await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')

    const t = written()
    expect(t).toContain('[ssivc-trace] --> POST https://ssivc.test/api/v2/verify/ai-birthcert/sessions')
    expect(t).toContain('[ssivc-trace] --> X-Payment-Response: receipt-abc')
    expect(t).toContain('[ssivc-trace] --> body: ' + JSON.stringify(requestBody))
    expect(t).toContain('[ssivc-trace] <-- 200 POST')
    expect(t).toContain('[ssivc-trace] <-- X-Payment-Response: receipt-abc')
    expect(t).toContain('"sessionId":"s-1"')
    // Reading the body for the trace must not consume it.
    expect(out).toEqual({
      kind: 'settled',
      session: { sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-17T09:15:00+00:00' },
      paymentReceipt: 'receipt-abc',
    })
  })

  // The question that started this: was BOTH an X-Payment and an X-Payment-Response header sent on
  // one request? The trace answers it from the wire, for either call.
  it('shows exactly one payment header per call', async () => {
    vi.stubEnv('SSIVC_TRACE', '1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'r-1' })))

    await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')
    const replay = written()
    expect(replay).toMatch(/--> X-Payment-Response: /)
    expect(replay).not.toMatch(/--> X-Payment: /)

    stderr.mockClear()
    await ssivc.createSessionSettle(requestBody, 'BASE64PAYMENT')
    const paid = written()
    expect(paid).toMatch(/--> X-Payment: BASE64PAYMENT/)
    expect(paid).not.toMatch(/--> X-Payment-Response: /)
  })

  it('also traces an error response, and the error is still raised normally', async () => {
    vi.stubEnv('SSIVC_TRACE', '1')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(resp(400, { status_code: '69', errors: ['could not be confirmed, please retry'] })),
    )

    await expect(ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')).rejects.toMatchObject({
      httpStatus: 400, statusCode: '69', kind: 'settlement_unconfirmed',
    })
    expect(written()).toContain('[ssivc-trace] <-- 400 POST')
    expect(written()).toContain('could not be confirmed, please retry')
  })

  it('never breaks a request when writing the trace fails', async () => {
    vi.stubEnv('SSIVC_TRACE', '1')
    stderr.mockImplementation(() => {
      throw new Error('stderr closed')
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'receipt-abc' })))

    await expect(ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')).resolves.toMatchObject({ kind: 'settled' })
  })

  it('never writes to stdout, which is the MCP protocol channel', async () => {
    vi.stubEnv('SSIVC_TRACE', '1')
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp(200, ok200, { 'X-Payment-Response': 'receipt-abc' })))
    await ssivc.createSessionWithReceipt(requestBody, 'receipt-abc')
    expect(stdout).not.toHaveBeenCalled()
    stdout.mockRestore()
  })
})
