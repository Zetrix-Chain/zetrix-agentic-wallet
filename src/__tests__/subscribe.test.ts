import { describe, it, expect, vi } from 'vitest'
import { subscribeAndIssue } from '../orchestrator/subscribe'
import { zetrixHexStringToBytes } from '../zetrix-hex'

const holderDid = 'did:zid:holder-self-1'
const opts = { templateId: 'did:zid:t-1', attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } }
// `data` on the wire is the raw JSON; the sign `blob` is the canonical hex of
// HexFormat.hexStringToBytes(data) — the exact bytes MBI's holder-signature verifier checks.
// agentDid is auto-filled from the wallet's own holderDid (self-referential credential subject).
const expectedData = JSON.stringify([
  { templateId: 'did:zid:t-1', metadata: { agentDid: holderDid, agentName: 'Jak Sparrow', purpose: 'x401+x402' } },
])
const expectedBlob = zetrixHexStringToBytes(expectedData).toString('hex')
// asset is a ZTP20 contract address on the wire; resolveSymbol maps it to the real symbol.
const accept = { payTo: 'ZTXissuer', asset: 'ZTX3jmyrcontract0000000000000000000', maxAmountRequired: '1000000', extra: { paymentId: 'pid-1' } }

// A template whose declared schema includes agentDid (e.g. Agent Identity Credential) —
// wire this to keep the agentDid auto-fill firing in tests that need it.
const fieldsWithAgentDid = { required: [] as string[], allKeys: ['agentDid', 'agentName', 'purpose'] }

describe('subscribeAndIssue', () => {
  it('builds data, holder-signs, gets 402, self-pays x402, settles, returns the VC with the resolved fee asset', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, resolveTemplateFields }, opts)

    expect(sign).toHaveBeenCalledWith(expectedBlob)
    expect(mbi.applyChallenge).toHaveBeenCalledWith({ data: expectedData, signData: 'sig', publicKey: 'pk' })
    expect(pay).toHaveBeenCalledWith(accept)
    expect(mbi.applySettle).toHaveBeenCalledWith(
      { data: expectedData, signData: 'sig', publicKey: 'pk', paymentId: 'pid-1' },
      'X-PAYMENT-B64',
    )
    expect(resolveSymbol).toHaveBeenCalledWith('ZTX3jmyrcontract0000000000000000000')
    expect(out).toEqual({
      issued: true, vcId: 'did:zid:vc', vc: { id: 'vc' }, txHash: '0xabc',
      paidAsset: 'JMYR', amountPaid: '1000000',
    })
  })

  it('reports the raw asset string when no resolveSymbol is provided', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } }),
    }
    const out = await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay: vi.fn().mockResolvedValue('X'), holderDid },
      opts,
    )
    expect(out.paidAsset).toBe('ZTX3jmyrcontract0000000000000000000')
    expect(out.amountPaid).toBe('1000000')
  })

  it('auto-fills attributes.agentDid with the wallet\'s own holderDid when the caller omits it and the template declares agentDid', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(mbi.applyChallenge).toHaveBeenCalledWith(expect.objectContaining({ data: expectedData }))
  })

  it('does NOT auto-fill agentDid when the template\'s declared schema does not include it (the AI Birthcert bug)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    // AI Birthcert-shaped template: declares ownerName/purpose, NOT agentDid.
    const resolveTemplateFields = vi.fn().mockResolvedValue({ required: ['ownerName', 'purpose'], allKeys: ['ownerName', 'purpose'] })

    await subscribeAndIssue(
      { mbi, sign, pay, holderDid, resolveTemplateFields },
      { templateId: 'did:zid:t-1', attributes: { ownerName: 'izzatur', purpose: 'testing' } },
    )

    const dataSent = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(dataSent[0].metadata).not.toHaveProperty('agentDid')
    expect(dataSent[0].metadata).toEqual({ ownerName: 'izzatur', purpose: 'testing' })
  })

  it('does NOT auto-fill agentDid when the template lookup fails (fail-closed, unlike the required-fields check below)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(null)

    await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    const dataSent = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(dataSent[0].metadata).not.toHaveProperty('agentDid')
    expect(dataSent[0].metadata).toEqual({ agentName: 'Jak Sparrow', purpose: 'x401+x402' })
  })

  it('does not override an explicit agentDid the caller already supplied, even when the template does not declare it', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const explicitAgentDid = 'did:zid:some-other-agent'
    // Template doesn't declare agentDid at all — still must not strip a caller-supplied one.
    const resolveTemplateFields = vi.fn().mockResolvedValue({ required: [], allKeys: ['agentName', 'purpose'] })

    await subscribeAndIssue(
      { mbi, sign, pay, holderDid, resolveTemplateFields },
      { ...opts, attributes: { agentDid: explicitAgentDid, ...opts.attributes } },
    )

    const dataSent = JSON.stringify([
      { templateId: 'did:zid:t-1', metadata: { agentDid: explicitAgentDid, agentName: 'Jak Sparrow', purpose: 'x401+x402' } },
    ])
    expect(mbi.applyChallenge).toHaveBeenCalledWith(expect.objectContaining({ data: dataSent }))
  })

  it('does not throw when a non-compliant caller omits attributes entirely', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    const out = await subscribeAndIssue(
      { mbi, sign, pay, holderDid, resolveTemplateFields },
      { templateId: 'did:zid:t-1', attributes: undefined as unknown as Record<string, unknown> },
    )

    const dataSent = JSON.stringify([{ templateId: 'did:zid:t-1', metadata: { agentDid: holderDid } }])
    expect(mbi.applyChallenge).toHaveBeenCalledWith(expect.objectContaining({ data: dataSent }))
    expect(out.issued).toBe(true)
  })

  it('treats an explicitly empty/undefined agentDid as not-supplied and still auto-fills when the template declares it', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    await subscribeAndIssue(
      { mbi, sign, pay, holderDid, resolveTemplateFields },
      { ...opts, attributes: { agentDid: '', ...opts.attributes } },
    )

    expect(mbi.applyChallenge).toHaveBeenCalledWith(expect.objectContaining({ data: expectedData }))
  })

  it('returns issued:false when the 402 carries no payment options', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [], paymentId: undefined }),
      applySettle: vi.fn(),
    }
    const out = await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 's', publicKey: 'p' }), pay: vi.fn(), holderDid },
      opts,
    )

    expect(out.issued).toBe(false)
    expect(mbi.applySettle).not.toHaveBeenCalled()
  })

  it('rejects a non-did:zid templateId before paying (e.g. a DCQL requirementsId label)', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid }, { ...opts, templateId: 'agent-identity' })

    expect(out).toEqual({
      issued: false,
      reason: 'templateId must be a did:zid:... credential-definition id, got "agent-identity"',
    })
    expect(sign).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
  })

  it('dryRun quotes the actual asset/amount from MBI\'s free phase-1 challenge without paying, resolving the asset symbol', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid }, { ...opts, dryRun: true })

    expect(mbi.applyChallenge).toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(resolveSymbol).toHaveBeenCalledWith('ZTX3jmyrcontract0000000000000000000')
    expect(out).toEqual({
      issued: false,
      reason: 'dry run — quoted only, no payment made',
      quote: { asset: 'JMYR', maxAmountRequired: '1000000', payTo: 'ZTXissuer' },
    })
  })

  it('blocks BEFORE signing/paying when a template-required attribute is missing', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    // opts supplies agentName + purpose; controllerDid is genuinely absent. Template doesn't
    // declare agentDid here, so the auto-fill (now gated) never even attempts to help.
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentName', 'purpose', 'controllerDid'],
      allKeys: ['agentName', 'purpose', 'controllerDid'],
    })

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(out).toEqual({
      issued: false,
      reason: 'template requires attribute(s) not supplied: controllerDid — no payment made',
    })
    expect(sign).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
  })

  it('proceeds and pays when every template-required attribute is present', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'agentName', 'purpose'],
      allKeys: ['agentDid', 'agentName', 'purpose'],
    })

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(resolveTemplateFields).toHaveBeenCalledWith('did:zid:t-1')
    expect(pay).toHaveBeenCalled()
    expect(out.issued).toBe(true)
  })

  it('is satisfied by the auto-filled agentDid (required agentDid + caller omits it + template declares it)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'agentName', 'purpose'],
      allKeys: ['agentDid', 'agentName', 'purpose'],
    })

    // opts has no agentDid — auto-fill runs before the required-fields check, so it must not block.
    await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(mbi.applyChallenge).toHaveBeenCalledWith(expect.objectContaining({ data: expectedData }))
    expect(pay).toHaveBeenCalled()
  })

  it('fail-open (required-fields check only): proceeds and pays when resolveTemplateFields returns null (node/parse failure)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(null)

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(pay).toHaveBeenCalled()
    expect(out.issued).toBe(true)
  })

  it('fail-open (required-fields check only): proceeds when resolveTemplateFields is not wired at all (back-compat)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid }, opts)

    expect(pay).toHaveBeenCalled()
    expect(out.issued).toBe(true)
  })

  it('dryRun surfaces requiredAttributes in the quote and never applies the missing-field block', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    // A field the caller did NOT supply — dryRun must still quote (not block) and list it.
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'agentName', 'purpose', 'controllerDid'],
      allKeys: ['agentDid', 'agentName', 'purpose', 'controllerDid'],
    })

    const out = await subscribeAndIssue(
      { mbi, sign, pay, resolveSymbol, holderDid, resolveTemplateFields },
      { ...opts, dryRun: true },
    )

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: false,
      reason: 'dry run — quoted only, no payment made',
      quote: {
        asset: 'JMYR',
        maxAmountRequired: '1000000',
        payTo: 'ZTXissuer',
        requiredAttributes: ['agentDid', 'agentName', 'purpose', 'controllerDid'],
      },
    })
  })

  it('returns a valid cached VC without signing, paying, or calling MBI at all', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const cached = {
      templateId: 'did:zid:t-1', vc: { id: 'cached-vc' }, vcId: 'did:zid:vc-cached', txHash: '0xold',
      paidAsset: 'JMYR', amountPaid: '1000000', issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(cached), set: vi.fn(), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, opts)

    expect(cache.get).toHaveBeenCalledWith('did:zid:t-1')
    expect(sign).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: true, vcId: 'did:zid:vc-cached', vc: { id: 'cached-vc' }, txHash: '0xold',
      paidAsset: 'JMYR', amountPaid: '1000000', fromCache: true,
    })
  })

  it('ignores an expired cached VC and pays + issues fresh, overwriting the stale cache entry', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', txHash: '0xnew', verifiableCredential: { id: 'vc', validUntil: '2027-01-01T00:00:00Z' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const expiredCached = {
      templateId: 'did:zid:t-1', vc: { id: 'stale' }, issuedAt: '2020-01-01T00:00:00Z', validUntil: '2020-06-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(expiredCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, cache }, opts)

    expect(pay).toHaveBeenCalled()
    expect(out.issued).toBe(true)
    expect(out.vc).toEqual({ id: 'vc', validUntil: '2027-01-01T00:00:00Z' })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({
      templateId: 'did:zid:t-1',
      vc: { id: 'vc', validUntil: '2027-01-01T00:00:00Z' },
      vcId: 'did:zid:vc',
      txHash: '0xnew',
      paidAsset: 'JMYR',
      amountPaid: '1000000',
      validUntil: '2027-01-01T00:00:00Z',
    }))
  })

  it('writes a fresh cache entry after a normal (cache-miss) issuance', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', txHash: '0xabc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, cache }, { ...opts, expirationDate: '2027-05-01T00:00:00Z' })

    // The freshly issued VC carries no validUntil of its own, so the cache falls back to
    // the expirationDate that was requested at issuance.
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({
      templateId: 'did:zid:t-1', vc: { id: 'vc' }, vcId: 'did:zid:vc', txHash: '0xabc',
      paidAsset: 'JMYR', amountPaid: '1000000', validUntil: '2027-05-01T00:00:00Z',
    }))
  })

  it('forceReissue bypasses a valid cache entry and pays fresh, then overwrites the cache', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-new', txHash: '0xnew', verifiableCredential: { id: 'fresh-vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).toHaveBeenCalled()
    expect(out).toMatchObject({ issued: true, vc: { id: 'fresh-vc' }, vcId: 'did:zid:vc-new' })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({ vc: { id: 'fresh-vc' } }))
  })

  it('short-circuits on a free template that MBI issues synchronously at phase 1 (challenge.issued), without calling pay/applySettle', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [],
        issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } },
      }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, opts)

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: true, vcId: 'did:zid:vc-free', vc: { id: 'vc-free' }, txHash: '0xfree',
      paidAsset: 'none', amountPaid: '0',
    })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({
      templateId: 'did:zid:t-1', vc: { id: 'vc-free' }, vcId: 'did:zid:vc-free', txHash: '0xfree',
      paidAsset: 'none', amountPaid: '0',
    }))
  })

  it('dryRun against a free template still reports the already-issued VC with an explanatory reason (issuance cannot be prevented)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [],
        issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } },
      }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const cache = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, dryRun: true })

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: true, vcId: 'did:zid:vc-free', vc: { id: 'vc-free' }, txHash: '0xfree',
      paidAsset: 'none', amountPaid: '0',
      reason: 'this template requires no payment — MBI issues synchronously at phase 1, so dryRun could not prevent this issuance',
    })
    // Still writes the cache — the issuance already happened on-chain regardless of dryRun.
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({ vcId: 'did:zid:vc-free' }))
  })

  it('dryRun never touches the cache, even when a valid entry exists', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const cache = { get: vi.fn(), set: vi.fn(), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, cache }, { ...opts, dryRun: true })

    expect(cache.get).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
    expect(out.quote).toBeDefined()
  })
})
