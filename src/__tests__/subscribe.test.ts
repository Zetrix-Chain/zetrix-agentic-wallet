import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeAndIssue } from '../orchestrator/subscribe'
import { zetrixHexStringToBytes } from '../zetrix-hex'
import { PaymentReadinessError } from '../payment-readiness'
import { MbiError } from '../clients/mbi-client'
import type { DownloadQuarantineStore } from '../clients/ssivc-download-quarantine-store'

const holderDid = 'did:zid:holder-self-1'
// confirm: true, so the tests below reach the payment they are about.
const opts = {
  templateId: 'did:zid:t-1',
  attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' },
  // The quote for `accept` below, echoed back; the raw asset counts as the same token.
  confirm: { asset: 'ZTX3jmyrcontract0000000000000000000', maxAmountRequired: '1000000', payTo: 'ZTXissuer', gasModel: 'self' },
}
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
    expect(out).toEqual({ nextStep: 'show_credential',
      issued: true, vcId: 'did:zid:vc', vc: { id: 'vc' }, txHash: '0xabc',
      paidAsset: 'JMYR', amountPaid: '1000000',
      schema: { required: [], optional: ['agentDid', 'agentName', 'purpose'] },
    })
  })

  it('includes passDesignId in the signed data payload, right after templateId, when deps.passDesignId is configured', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)
    const dataWithPassDesignId = JSON.stringify([
      { templateId: 'did:zid:t-1', passDesignId: 'pd-123', metadata: { agentDid: holderDid, agentName: 'Jak Sparrow', purpose: 'x401+x402' } },
    ])

    await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields, passDesignId: 'pd-123' }, opts)

    expect(mbi.applyChallenge).toHaveBeenCalledWith({ data: dataWithPassDesignId, signData: 'sig', publicKey: 'pk' })
    expect(sign).toHaveBeenCalledWith(zetrixHexStringToBytes(dataWithPassDesignId).toString('hex'))
  })

  it('omits passDesignId entirely from the data payload when deps.passDesignId is not configured (unchanged wire shape)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(mbi.applyChallenge).toHaveBeenCalledWith({ data: expectedData, signData: 'sig', publicKey: 'pk' })
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
      { templateId: 'did:zid:t-1', attributes: undefined as unknown as Record<string, unknown>, confirm: opts.confirm },
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

    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'templateId must be a did:zid:... credential-definition id, got "agent-identity"',
    })
    expect(sign).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
  })

  // dryRun prices via /v1/vc/pay/quote, which cannot issue. It must NOT reach
  // applyChallenge — for a free template applyChallenge IS the real synchronous issuance, so
  // routing a dry run through it mints a permanent VC as the side effect of asking a price.
  it('dryRun quotes via /quote without paying, never calling applyChallenge, resolving the asset symbol', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: true }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid }, { ...opts, dryRun: true })

    expect(mbi.quote).toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    // /quote takes no holder signature, so a dry run need not touch the signing key at all.
    expect(sign).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(resolveSymbol).toHaveBeenCalledWith('ZTX3jmyrcontract0000000000000000000')
    expect(out).toEqual({
      issued: false,
      reason: 'dry run — quoted only, no payment made',
      quote: {
        asset: 'JMYR',
        maxAmountRequired: '1000000',
        payTo: 'ZTXissuer',
        gasModel: 'self',
        paymentRequired: true,
      },
    })
  })

  // The whole point of this design: free mode must be reported as free, rather than quoting a price
  // nobody will be charged. accepts[] stays populated in free mode, so it cannot answer this.
  it('dryRun reports issuance as free when MBI says paymentRequired is false, without issuing anything', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: false }),
    }
    const sign = vi.fn()
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid }, { ...opts, dryRun: true })

    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: false,
      reason: 'dry run — issuance is free right now, no payment required',
      quote: {
        asset: 'JMYR',
        maxAmountRequired: '1000000',
        payTo: 'ZTXissuer',
        gasModel: 'self',
        paymentRequired: false,
      },
    })
  })

  // An older MBI without this field omits it. Say so rather than presenting the quoted amount as
  // a charge that will definitely happen — that overstatement is exactly what this design avoids.
  it('dryRun flags the quoted amount as unconfirmed when MBI omits paymentRequired', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept] }),
    }
    const out = await subscribeAndIssue(
      { mbi, sign: vi.fn(), pay: vi.fn(), resolveSymbol: vi.fn().mockResolvedValue('JMYR'), holderDid },
      { ...opts, dryRun: true },
    )

    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: false,
      reason:
        'dry run — quoted only, no payment made. This MBI does not report whether issuance is free, so the quoted amount may not actually be charged.',
      quote: { asset: 'JMYR', maxAmountRequired: '1000000', payTo: 'ZTXissuer', gasModel: 'self' },
    })
  })

  // Falling back to applyChallenge here would mint on a free template — the exact bug. Refusing
  // is the safe direction: a dry run that cannot be done safely must do nothing.
  it('dryRun refuses rather than falling through to applyChallenge when no quote client is wired', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid }, { ...opts, dryRun: true })

    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason:
        'dry run unavailable — this wallet has no MBI quote client, and pricing any other way risks issuing the credential',
    })
  })

  // R1-M01: credentialPreflight reads a missing gasModel as self-pay, so a sponsored template
  // credential must say so explicitly on the dryRun quote — mirroring the Verified Birthcert path.
  it('dryRun reports gasModel: sponsored when MBI quotes an actionable facilitator-sponsored option', async () => {
    const sponsoredAccept = {
      payTo: 'ZTXissuer',
      asset: 'ZTX3jmyrcontract0000000000000000000',
      maxAmountRequired: '1000000',
      extra: { paymentId: 'pid-1', gasModel: 'facilitator', prepareEndpoint: 'https://facilitator/api/prepare' },
    }
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [sponsoredAccept], paymentRequired: true }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid }, { ...opts, dryRun: true })

    expect(out).toEqual({
      issued: false,
      reason: 'dry run — quoted only, no payment made',
      quote: {
        asset: 'JMYR',
        maxAmountRequired: '1000000',
        payTo: 'ZTXissuer',
        gasModel: 'sponsored',
        paymentRequired: true,
      },
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

    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'template requires attribute(s) not supplied: controllerDid — no payment made',
      schema: { required: ['agentName', 'purpose', 'controllerDid'], optional: [] },
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

  it('dryRun also blocks BEFORE calling MBI when a template-required attribute is missing, reporting the full schema', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
    }
    const sign = vi.fn()
    const pay = vi.fn()
    // A field the caller did NOT supply — for a free template, applyChallenge IS the real
    // synchronous issuance, so dryRun must block locally rather than risk a live MBI call.
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'agentName', 'purpose', 'controllerDid'],
      allKeys: ['agentDid', 'agentName', 'purpose', 'controllerDid'],
    })

    const out = await subscribeAndIssue(
      { mbi, sign, pay, holderDid, resolveTemplateFields },
      { ...opts, dryRun: true },
    )

    expect(sign).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'template requires attribute(s) not supplied: controllerDid — no payment made',
      schema: { required: ['agentDid', 'agentName', 'purpose', 'controllerDid'], optional: [] },
    })
  })

  it('dryRun still quotes normally when every template-required attribute is present, and attaches the full schema', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: true }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'agentName', 'purpose'],
      allKeys: ['agentDid', 'agentName', 'purpose', 'nickname'],
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
        gasModel: 'self',
        paymentRequired: true,
      },
      schema: { required: ['agentDid', 'agentName', 'purpose'], optional: ['nickname'] },
    })
  })

  it('returns a clean structured error (not a raw throw) when MBI rejects the template itself (e.g. 404 not found/inactive)', async () => {
    const { MbiError } = await import('../clients/mbi-client')
    const mbi = {
      applyChallenge: vi.fn().mockRejectedValue(new MbiError('MBI apply (phase 1) expected 402 — HTTP 404: Template not found, inactive, or not issued by the configured issuer', 404)),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn()

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid }, opts)

    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'MBI apply (phase 1) expected 402 — HTTP 404: Template not found, inactive, or not issued by the configured issuer',
      httpStatus: 404,
    })
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
  })

  it('returns a clean structured error (not a raw throw) when applySettle rejects with an MbiError', async () => {
    const { MbiError } = await import('../clients/mbi-client')
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockRejectedValue(new MbiError('MBI apply (phase 2) failed — HTTP 400: X402_SIGNATURE_INVALID', 400)),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'MBI apply (phase 2) failed — HTTP 400: X402_SIGNATURE_INVALID',
      httpStatus: 400,
      schema: { required: [], optional: ['agentDid', 'agentName', 'purpose'] },
      paymentAttempted: { asset: 'ZTX3jmyrcontract0000000000000000000', amount: '1000000', paymentId: 'pid-1' },
    })
  })

  // A phase-2 failure happens AFTER deps.pay has already put the payment on chain, so the
  // funds are gone even though no VC came back (observed live as MBI 4006 "Facilitator
  // settlement failed: timeout"). Reporting what was paid is the only way the caller can
  // reconcile the debit — the MBI error body carries no txHash or amount.
  it('reports the payment already made when applySettle fails, resolving the asset symbol', async () => {
    const { MbiError } = await import('../clients/mbi-client')
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockRejectedValue(new MbiError('MBI apply (phase 2) failed — HTTP 402: Facilitator settlement failed: timeout', 402)),
    }
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')

    const out = await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, resolveSymbol, holderDid },
      opts,
    )

    expect(pay).toHaveBeenCalled()
    expect(out.issued).toBe(false)
    expect(out.paymentAttempted).toEqual({ asset: 'JMYR', amount: '1000000', paymentId: 'pid-1' })
  })

  it('does NOT report a payment when the failure happens in phase 1, before anything is paid', async () => {
    const { MbiError } = await import('../clients/mbi-client')
    const mbi = {
      applyChallenge: vi.fn().mockRejectedValue(new MbiError('MBI apply (phase 1) expected 402 — HTTP 404: Template not found', 404)),
      applySettle: vi.fn(),
    }
    const pay = vi.fn()

    const out = await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, holderDid },
      opts,
    )

    expect(pay).not.toHaveBeenCalled()
    expect(out.paymentAttempted).toBeUndefined()
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
      issued: false, alreadyHeld: true, nextStep: 'tell_user_already_held', reason: expect.stringMatching(/^Already held/), vcId: 'did:zid:vc-cached', vc: { id: 'cached-vc' }, fromCache: true,
      originalPayment: { txHash: '0xold', asset: 'JMYR', amount: '1000000' },
    })
  })

  // A cache hit costs nothing. Replaying the original txHash/paidAsset/amountPaid at the top
  // level made a free call look like a fresh charge — anything summing amountPaid across calls
  // double-counted. The historical values stay available, but only under originalPayment.
  it('a cache hit reports no payment for this call, keeping the original charge separate', async () => {
    const cached = {
      templateId: 'did:zid:t-1', vc: { id: 'cached-vc' }, vcId: 'did:zid:vc-cached', txHash: '0xold',
      paidAsset: 'JMYR', amountPaid: '1000000', issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(cached), set: vi.fn(), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() }, sign: vi.fn(), pay: vi.fn(), holderDid, cache },
      opts,
    )

    expect(out.fromCache).toBe(true)
    expect(out.amountPaid).toBeUndefined()
    expect(out.paidAsset).toBeUndefined()
    expect(out.txHash).toBeUndefined()
    expect(out.originalPayment).toEqual({ txHash: '0xold', asset: 'JMYR', amount: '1000000' })
  })

  // The free-template path writes paidAsset:'none'/amountPaid:'0' (not undefined), so a guard
  // that only checks for undefined reports originalPayment: { asset:'none', amount:'0' } on a
  // free cache hit — truthful but contradicting the documented "omitted when free". The
  // fixture mirrors what the free path actually caches.
  it('omits originalPayment entirely for a cached VC that was issued without any payment (free template)', async () => {
    const cached = {
      templateId: 'did:zid:t-1', vc: { id: 'free-vc' }, vcId: 'did:zid:vc-free',
      txHash: '0xfree', paidAsset: 'none', amountPaid: '0',
      issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(cached), set: vi.fn(), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() }, sign: vi.fn(), pay: vi.fn(), holderDid, cache },
      opts,
    )

    expect(out).toEqual({
      issued: false, alreadyHeld: true, nextStep: 'tell_user_already_held', reason: expect.stringMatching(/^Already held/), vcId: 'did:zid:vc-free', vc: { id: 'free-vc' }, fromCache: true,
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

  it('forceReissue alone (no confirmation) is blocked: shows the existing VC, asks for confirmation, pays nothing', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, resolveSymbol, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, vcId: 'did:zid:vc-old', vc: { id: 'old' }, fromCache: true })
    expect(out.reason).toContain('did:zid:vc-old')
    expect(out.reason).toContain('confirmReplaceExistingVc')
  })

  it('forceReissue with confirmReplaceExistingVc matching the cached vcId pays fresh and overwrites the cache', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-new', txHash: '0xnew', verifiableCredential: { id: 'fresh-vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const resolveSymbol = vi.fn().mockResolvedValue('JMYR')
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi, sign, pay, resolveSymbol, holderDid, cache },
      { ...opts, forceReissue: true, confirmReplaceExistingVc: 'did:zid:vc-old' },
    )

    expect(pay).toHaveBeenCalled()
    expect(out).toMatchObject({ issued: true, vc: { id: 'fresh-vc' }, vcId: 'did:zid:vc-new' })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({ vc: { id: 'fresh-vc' } }))
  })

  it('forceReissue with a mismatched/stale confirmReplaceExistingVc is not treated as confirmation: pays nothing', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi, sign, pay, holderDid, cache },
      { ...opts, forceReissue: true, confirmReplaceExistingVc: 'did:zid:some-other-vc' },
    )

    expect(pay).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, vcId: 'did:zid:vc-old', fromCache: true })
  })

  it('without forceReissue, a valid cache hit is still served automatically (unchanged) even if confirmReplaceExistingVc happens to be set', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, confirmReplaceExistingVc: 'did:zid:vc-old' })

    expect(pay).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, alreadyHeld: true, vc: { id: 'old' }, vcId: 'did:zid:vc-old', fromCache: true })
  })

  // A cached entry can be valid but carry no `vcId` (an older record, or a writer that omitted it)
  // — the gate falls back to the VC document's own `id`, and must still fail CLOSED (no pay)
  // without the matching confirmation.
  it('a valid cached VC with no recorded vcId falls back to the VC document\'s own id, and still refuses without confirmation', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const validCachedNoVcId = {
      templateId: 'did:zid:t-1', vc: { id: 'did:zid:vc-from-body' },
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCachedNoVcId), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(out.issued).toBe(false)
    // R1-L01: the blocked response must carry the fallback id under `vcId` too, not only in `reason`
    // text — docs/tool description all point the model at a `vcId` field to echo back.
    expect(out.vcId).toBe('did:zid:vc-from-body')
  })

  it('a valid cached VC with no recorded vcId, confirmed against the VC document\'s own id, pays fresh', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-new', txHash: '0xnew', verifiableCredential: { id: 'fresh-vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const validCachedNoVcId = {
      templateId: 'did:zid:t-1', vc: { id: 'did:zid:vc-from-body' },
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCachedNoVcId), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi, sign, pay, holderDid, cache },
      { ...opts, forceReissue: true, confirmReplaceExistingVc: 'did:zid:vc-from-body' },
    )

    expect(pay).toHaveBeenCalled()
    expect(out).toMatchObject({ issued: true, vc: { id: 'fresh-vc' } })
  })

  // R1-M01 (round-3 review): distinct from the fallback tests above — this cached entry has NO
  // usable id anywhere (`vcId` absent, `vc` carries none either), so it must reach the true
  // "refuse outright" branch, not the fallback-then-mismatch branch. Genuinely rare (every real
  // MBI-issued VC has an `id`), but the refusal code path itself needs its own test or its removal
  // would silently reopen the fail-open this whole gate exists to close.
  it('a valid cached VC with NO usable id anywhere (no vcId, no vc.id) refuses to replace it at all, even with forceReissue', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const validCachedNoUsableId = {
      templateId: 'did:zid:t-1', vc: {},
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(validCachedNoUsableId), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false })
    expect(out.reason).toContain('no confirmable credential id')
    // Confirming with ANY value must not bypass this — there is nothing to confirm against.
    const outWithConfirm = await subscribeAndIssue(
      { mbi, sign, pay, holderDid, cache },
      { ...opts, forceReissue: true, confirmReplaceExistingVc: 'anything' },
    )
    expect(pay).not.toHaveBeenCalled()
    expect(outWithConfirm.issued).toBe(false)
  })

  // APP-M02 (round-2 review): forceReissue must still be a no-op against an expired or empty
  // cache — pays fresh exactly as it always did with no cached VC to protect.
  it('forceReissue against an EXPIRED cache entry still pays fresh and overwrites the cache (APP-M02)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-new', txHash: '0xnew', verifiableCredential: { id: 'fresh-vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const expiredCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2020-01-01T00:00:00Z', validUntil: '2020-02-01T00:00:00Z',
    }
    const cache = { get: vi.fn().mockResolvedValue(expiredCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).toHaveBeenCalled()
    expect(out).toMatchObject({ issued: true, vc: { id: 'fresh-vc' } })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({ vc: { id: 'fresh-vc' } }))
  })

  it('forceReissue against an EMPTY cache still pays fresh (APP-M02)', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-new', txHash: '0xnew', verifiableCredential: { id: 'fresh-vc' } }),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockResolvedValue('X-PAYMENT-B64')
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, forceReissue: true })

    expect(pay).toHaveBeenCalled()
    expect(out).toMatchObject({ issued: true, vc: { id: 'fresh-vc' } })
  })

  // APP-L04 (round-2 review): the cache-hit and blocked-replace responses must carry the cached
  // pass-design image too, not only a fresh issuance — otherwise the "show the pass design" tool
  // instruction has nothing to act on whenever the VC came from cache.
  it('a plain cache hit carries the cached vcPassImagePaths (APP-L04)', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
      vcPassImagePaths: ['/state/vc-pass/did:zid:vc-old-0.png'],
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, opts)

    expect(out.vcPassImagePaths).toEqual(['/state/vc-pass/did:zid:vc-old-0.png'])
  })

  it('the blocked (forceReissue, unconfirmed) response also carries the cached vcPassImagePaths (APP-L04)', async () => {
    const mbi = { applyChallenge: vi.fn(), applySettle: vi.fn() }
    const sign = vi.fn()
    const pay = vi.fn()
    const validCached = {
      templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old',
      issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
      vcPassImagePaths: ['/state/vc-pass/did:zid:vc-old-0.png'],
    }
    const cache = { get: vi.fn().mockResolvedValue(validCached), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, cache }, { ...opts, forceReissue: true })

    expect(out.issued).toBe(false)
    expect(out.vcPassImagePaths).toEqual(['/state/vc-pass/did:zid:vc-old-0.png'])
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
    expect(out).toEqual({ nextStep: 'show_credential',
      issued: true, vcId: 'did:zid:vc-free', vc: { id: 'vc-free' }, txHash: '0xfree',
      paidAsset: 'none', amountPaid: '0',
    })
    expect(cache.set).toHaveBeenCalledWith('did:zid:t-1', expect.objectContaining({
      templateId: 'did:zid:t-1', vc: { id: 'vc-free' }, vcId: 'did:zid:vc-free', txHash: '0xfree',
      paidAsset: 'none', amountPaid: '0',
    }))
  })

  // Regression coverage: a dry run against a free template
  // used to reach applyChallenge, which for a free template IS the real synchronous issuance —
  // minting a permanent VC, burning one of the holder's 10 hourly free-mode issuances, and
  // evicting whatever the cache held for that template. Routing through /quote makes the
  // synchronous-issuance branch unreachable from a dry run, so none of that can happen.
  it('dryRun against a free template issues nothing and writes no cache — applyChallenge is never reached', async () => {
    const mbi = {
      // Would mint if called. It must not be.
      applyChallenge: vi.fn().mockResolvedValue({
        x402Version: 1,
        accepts: [],
        issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: { id: 'vc-free' } },
      }),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: false }),
    }
    const sign = vi.fn()
    const pay = vi.fn()
    const cache = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), list: vi.fn() }

    const out = await subscribeAndIssue(
      { mbi, sign, pay, resolveSymbol: vi.fn().mockResolvedValue('JMYR'), holderDid, cache },
      { ...opts, dryRun: true },
    )

    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({
      issued: false,
      reason: 'dry run — issuance is free right now, no payment required',
      quote: {
        asset: 'JMYR',
        maxAmountRequired: '1000000',
        payTo: 'ZTXissuer',
        gasModel: 'self',
        paymentRequired: false,
      },
    })
    // Nothing was issued, so nothing may displace the VC this template already holds.
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('dryRun never touches the cache, even when a valid entry exists', async () => {
    const mbi = {
      applyChallenge: vi.fn(),
      applySettle: vi.fn(),
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: true }),
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

  it('returns a structured insufficientFunds result instead of throwing when pay is short on funds', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const shortfall = { asset: 'JMYR', required: '1000000', available: '200000', reason: 'resource_payment' as const }
    const pay = vi.fn().mockRejectedValue(new PaymentReadinessError('Insufficient JMYR: required 1000000, available 200000', shortfall))
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    const out = await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)

    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toEqual({ nextStep: 'follow_message',
      issued: false,
      reason: 'insufficient funds: Insufficient JMYR: required 1000000, available 200000',
      insufficientFunds: shortfall,
    })
  })

  it('rethrows a non-readiness error from pay unchanged', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn(),
    }
    const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
    const pay = vi.fn().mockRejectedValue(new Error('network down'))
    const resolveTemplateFields = vi.fn().mockResolvedValue(fieldsWithAgentDid)

    await expect(subscribeAndIssue({ mbi, sign, pay, holderDid, resolveTemplateFields }, opts)).rejects.toThrow('network down')
  })
})

// MBI splits the post-payment failure into two outcomes: 4006 is a definitive
// facilitator rejection, 4012 X402_SETTLEMENT_INDETERMINATE means the settle result was UNKNOWN —
// the payment may well have gone through and the row is deliberately left recoverable via
// GET /v1/vc/pay/status/{paymentId}. Giving up on 4012 without asking throws away a VC the holder
// has already paid for.
describe('subscribeAndIssue — indeterminate settle recovery', () => {
  const indeterminate = () => {
    const e = new MbiError('MBI apply (phase 2) failed — HTTP 502: settlement indeterminate', 502)
    e.mbiStatus = 4012
    return e
  }
  const settleFails = (err: Error) => ({
    applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
    applySettle: vi.fn().mockRejectedValue(err),
  })
  const base = { sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay: vi.fn().mockResolvedValue('X'), holderDid, sleep: vi.fn().mockResolvedValue(undefined) }

  it('reports the paymentId alongside the amount so the caller can reconcile the debit', async () => {
    const mbi = settleFails(indeterminate())
    const out = await subscribeAndIssue({ ...base, mbi }, opts)
    expect(out.paymentAttempted).toEqual({
      asset: 'ZTX3jmyrcontract0000000000000000000', amount: '1000000', paymentId: 'pid-1',
    })
  })

  it('polls /status after an indeterminate settle and reports the VC it finds already issued', async () => {
    const mbi = { ...settleFails(indeterminate()), getStatus: vi.fn().mockResolvedValue({ paymentId: 'pid-1', status: 'ISSUED', txHash: '0xrecovered', vcId: 'did:zid:vc-recovered' }) }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(mbi.getStatus).toHaveBeenCalledWith('pid-1')
    expect(out.recovery).toEqual({ status: 'ISSUED', txHash: '0xrecovered', vcId: 'did:zid:vc-recovered', polls: 1 })
  })

  it('keeps polling while /status is still non-terminal, then stops at the terminal outcome', async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce({ paymentId: 'pid-1', status: 'REQUIRED' })
      .mockResolvedValueOnce({ paymentId: 'pid-1', status: 'SETTLED', txHash: '0xa' })
      .mockResolvedValueOnce({ paymentId: 'pid-1', status: 'ISSUED', txHash: '0xa', vcId: 'did:zid:vc-r' })
    const mbi = { ...settleFails(indeterminate()), getStatus }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(getStatus).toHaveBeenCalledTimes(3)
    expect(out.recovery).toMatchObject({ status: 'ISSUED', polls: 3 })
  })

  it('reports FAILED from /status as a terminal outcome, stopping immediately', async () => {
    const getStatus = vi.fn().mockResolvedValue({ paymentId: 'pid-1', status: 'FAILED' })
    const mbi = { ...settleFails(indeterminate()), getStatus }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(out.recovery).toMatchObject({ status: 'FAILED', polls: 1 })
  })

  it('gives up after the poll budget and reports the last non-terminal status', async () => {
    const getStatus = vi.fn().mockResolvedValue({ paymentId: 'pid-1', status: 'REQUIRED' })
    const mbi = { ...settleFails(indeterminate()), getStatus }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(getStatus.mock.calls.length).toBeGreaterThan(1)
    expect(out.recovery).toMatchObject({ status: 'REQUIRED' })
    expect(out.issued).toBe(false)
  })

  it('does NOT poll for a definitive 4006 failure — there is nothing indeterminate to recover', async () => {
    const err = new MbiError('MBI apply (phase 2) failed - HTTP 402: Facilitator settlement failed', 402)
    err.mbiStatus = 4006
    const mbi = { ...settleFails(err), getStatus: vi.fn() }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(mbi.getStatus).not.toHaveBeenCalled()
    expect(out.recovery).toBeUndefined()
    expect(out.paymentAttempted).toMatchObject({ paymentId: 'pid-1' })
  })

  it('still returns the structured failure when /status itself is unreachable', async () => {
    const mbi = { ...settleFails(indeterminate()), getStatus: vi.fn().mockRejectedValue(new Error('node down')) }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(out.issued).toBe(false)
    expect(out.recovery).toMatchObject({ status: 'UNKNOWN' })
    expect(out.paymentAttempted).toMatchObject({ paymentId: 'pid-1' })
  })

  it('skips recovery entirely when the wallet has no paymentId to look up', async () => {
    const mbi = {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [{ ...accept, extra: {} }] }),
      applySettle: vi.fn().mockRejectedValue(indeterminate()),
      getStatus: vi.fn(),
    }

    const out = await subscribeAndIssue({ ...base, mbi }, opts)

    expect(mbi.getStatus).not.toHaveBeenCalled()
    expect(out.paymentAttempted?.paymentId).toBeUndefined()
  })
})

// Reported from live testing: an agent holding a previously-issued VC tried to reissue using the
// fields it already had, and only discovered `agentUsername` was newly required by failing once.
// The wallet knows both the held VC's claims and the template's current declared schema — it just
// never compared them. isVcValid only asks "has it expired?", so a VC whose fields no longer match
// the template still reads as fine. Surfacing the delta on a cache hit removes the failed attempt.
describe('subscribeAndIssue — stale cached attributes', () => {
  const cachedWith = (attrs: Record<string, unknown>) => ({
    templateId: 'did:zid:t-1',
    vc: { credentialSubject: { id: holderDid, aiBirthcert: attrs } },
    vcId: 'did:zid:vc-cached',
    txHash: '0xold', paidAsset: 'JMYR', amountPaid: '1000000',
    issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
  })
  const idle = { mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() }, sign: vi.fn(), pay: vi.fn(), holderDid }
  // Template moved on: agentUsername is now required, agentName is no longer declared at all.
  const newTemplate = { required: ['agentUsername'], allKeys: ['agentUsername', 'ownerName', 'dob'] }

  it('reports the template schema on a cache hit so the caller can see what is required', async () => {
    const cache = { get: vi.fn().mockResolvedValue(cachedWith({ agentUsername: 'jak', ownerName: 'Izzatur' })), set: vi.fn(), list: vi.fn() }
    const resolveTemplateFields = vi.fn().mockResolvedValue(newTemplate)

    const out = await subscribeAndIssue({ ...idle, cache, resolveTemplateFields }, opts)

    expect(out.fromCache).toBe(true)
    expect(out.schema).toEqual({ required: ['agentUsername'], optional: ['ownerName', 'dob'] })
  })

  it('flags a required attribute the held VC is missing', async () => {
    const cache = { get: vi.fn().mockResolvedValue(cachedWith({ agentName: 'jak', ownerName: 'Izzatur' })), set: vi.fn(), list: vi.fn() }
    const resolveTemplateFields = vi.fn().mockResolvedValue(newTemplate)

    const out = await subscribeAndIssue({ ...idle, cache, resolveTemplateFields }, opts)

    expect(out.staleAttributes).toEqual({ missing: ['agentUsername'], dropped: ['agentName'] })
  })

  it('omits staleAttributes when the held VC still satisfies the template', async () => {
    const cache = { get: vi.fn().mockResolvedValue(cachedWith({ agentUsername: 'jak', ownerName: 'Izzatur' })), set: vi.fn(), list: vi.fn() }
    const resolveTemplateFields = vi.fn().mockResolvedValue(newTemplate)

    const out = await subscribeAndIssue({ ...idle, cache, resolveTemplateFields }, opts)

    expect(out.staleAttributes).toBeUndefined()
  })

  it('still serves the cached VC without paying when it is stale — reporting, not re-issuing', async () => {
    const cache = { get: vi.fn().mockResolvedValue(cachedWith({ agentName: 'jak' })), set: vi.fn(), list: vi.fn() }
    const resolveTemplateFields = vi.fn().mockResolvedValue(newTemplate)

    const out = await subscribeAndIssue({ ...idle, cache, resolveTemplateFields }, opts)

    expect(out.issued).toBe(false) // already held, not issued
    expect(out.alreadyHeld).toBe(true)
    expect(idle.pay).not.toHaveBeenCalled()
    expect(cache.set).not.toHaveBeenCalled()
  })

  it('serves the cached VC unchanged when the template lookup is unwired or fails (fail-open)', async () => {
    const cache = { get: vi.fn().mockResolvedValue(cachedWith({ agentName: 'jak' })), set: vi.fn(), list: vi.fn() }

    const out = await subscribeAndIssue({ ...idle, cache }, opts)

    expect(out.fromCache).toBe(true)
    expect(out.schema).toBeUndefined()
    expect(out.staleAttributes).toBeUndefined()
  })
})

describe('subscribeAndIssue — VC pass image (extraData.vcPassBase64 from /v1/vc/ext/download)', () => {
  let passImagesDir: string

  const mkQuarantine = (): DownloadQuarantineStore & { store: Map<string, unknown> } => {
    const store = new Map<string, unknown>()
    const locks = new Map<string, Promise<unknown>>()
    return {
      store,
      get: vi.fn(async (vcId: string) => (store.has(vcId) ? (store.get(vcId) as never) : null)),
      set: vi.fn(async (entry: { vcId: string }) => {
        store.set(entry.vcId, entry)
      }),
      filePathFor: (vcId: string) => `/quarantine/${vcId}`,
      withLock: vi.fn((vcId: string, fn: () => Promise<unknown>) => {
        const previous = locks.get(vcId) ?? Promise.resolve()
        const next = previous.then(fn, fn)
        locks.set(
          vcId,
          next.catch(() => undefined),
        )
        return next
      }),
    }
  }

  const passImageDeps = (overrides: Record<string, unknown> = {}) => ({
    mbi: {
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-1', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'did:zid:vc-1' } }),
      downloadVcs: vi.fn().mockResolvedValue([
        { vc: { id: 'did:zid:vc-1' }, extraData: { vcPassBase64: [Buffer.from('pass-png-bytes').toString('base64')] } },
      ]),
    },
    sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }),
    pay: vi.fn().mockResolvedValue('X-PAYMENT-B64'),
    holderDid,
    signRequest: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }),
    address: 'ZTX3Holder',
    quarantine: mkQuarantine(),
    passImagesDir,
    ...overrides,
  })

  beforeEach(() => {
    passImagesDir = mkdtempSync(join(tmpdir(), 'subscribe-vc-pass-image-test-'))
  })

  afterEach(() => {
    rmSync(passImagesDir, { recursive: true, force: true })
  })

  it('downloads and writes the pass image, returning its path, when extraData.vcPassBase64 is present', async () => {
    const deps = passImageDeps()

    const out = await subscribeAndIssue(deps as never, opts)

    expect(deps.mbi.downloadVcs).toHaveBeenCalledWith({ address: 'ZTX3Holder' }, deps.signRequest)
    expect(out.vcPassImagePaths).toHaveLength(1)
    expect(readFileSync(out.vcPassImagePaths![0], 'utf8')).toBe('pass-png-bytes')
  })

  it('caches vcPassImagePaths alongside the issued VC', async () => {
    const cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), list: vi.fn() }
    const deps = passImageDeps({ cache })

    await subscribeAndIssue(deps as never, opts)

    expect(cache.set).toHaveBeenCalledWith(
      'did:zid:t-1',
      expect.objectContaining({ vcPassImagePaths: expect.arrayContaining([expect.stringContaining(passImagesDir)]) }),
    )
  })

  it('does not set vcPassImagePaths when the downloaded entry carries no extraData.vcPassBase64 (null case)', async () => {
    const deps = passImageDeps({
      mbi: {
        applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
        applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-1', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'did:zid:vc-1' } }),
        downloadVcs: vi.fn().mockResolvedValue([{ vc: { id: 'did:zid:vc-1' }, extraData: null }]),
      },
    })

    const out = await subscribeAndIssue(deps as never, opts)

    expect(out.vcPassImagePaths).toBeUndefined()
  })

  it('skips the pass-image fetch entirely when the feature is not wired (downloadVcs unset)', async () => {
    const out = await subscribeAndIssue(
      { mbi: { applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }), applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-1', verifiableCredential: { id: 'vc' } }) }, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay: vi.fn().mockResolvedValue('X'), holderDid },
      opts,
    )
    expect(out.vcPassImagePaths).toBeUndefined()
  })

  it('reuses a quarantined download for the same vcId instead of hitting MBI again (one-shot download)', async () => {
    const deps = passImageDeps()
    await subscribeAndIssue(deps as never, opts)
    expect(deps.mbi.downloadVcs).toHaveBeenCalledTimes(1)

    // Second issuance of the SAME vcId (e.g. a retry) must read the quarantined copy, not re-download —
    // MBI's /v1/vc/ext/download returns 404 on a second live call for the same vcId (SEC-11/REQ-25).
    await subscribeAndIssue(deps as never, opts)
    expect(deps.mbi.downloadVcs).toHaveBeenCalledTimes(1)
  })

  // Code review (APP-L03): a bare get-then-download-then-set let two concurrent calls for the
  // SAME vcId both miss the quarantine `get` and both hit MBI's one-shot download — one of them gets
  // a 404 and the wallet loses the credential body entirely on that branch. withLock serializes them.
  it('serializes two concurrent issuances of the SAME vcId so only one downloads', async () => {
    const deps = passImageDeps()
    await Promise.all([subscribeAndIssue(deps as never, opts), subscribeAndIssue(deps as never, opts)])
    expect(deps.mbi.downloadVcs).toHaveBeenCalledTimes(1)
  })

  it('still returns the successfully issued VC (without vcPassImagePaths) when downloadVcs fails', async () => {
    const deps = passImageDeps({
      mbi: {
        applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
        applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc-1', paymentId: 'pid-1', txHash: '0xabc', verifiableCredential: { id: 'did:zid:vc-1' } }),
        downloadVcs: vi.fn().mockRejectedValue(new Error('MBI vc/ext/download failed — HTTP 503')),
      },
    })

    const out = await subscribeAndIssue(deps as never, opts)

    expect(out.issued).toBe(true)
    expect(out.vcId).toBe('did:zid:vc-1')
    expect(out.vcPassImagePaths).toBeUndefined()
  })

  // Code review (APP-M01): resolveVcPassImagePaths's docblock promises it never throws, but
  // only the downloadVcs call was wrapped — a failure in quarantine.set or the filesystem write was
  // not, so it rejected subscribeAndIssue and the already-paid, already-issued VC was reported as a
  // failure. Two probes, mirroring the review's own.
  it('still returns the successfully issued VC when the quarantine store write fails', async () => {
    const deps = passImageDeps({
      quarantine: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left on device')),
        filePathFor: (vcId: string) => `/quarantine/${vcId}`,
        withLock: (_vcId: string, fn: () => Promise<unknown>) => fn(),
      },
    })

    const out = await subscribeAndIssue(deps as never, opts)

    expect(out.issued).toBe(true)
    expect(out.vcId).toBe('did:zid:vc-1')
    expect(out.vcPassImagePaths).toBeUndefined()
  })

  it('still returns the successfully issued VC when writing the pass image to disk fails', async () => {
    // A file, not a directory, at passImagesDir — mkdir/writeFile inside writeVcPassImages must fail.
    rmSync(passImagesDir, { recursive: true, force: true })
    writeFileSync(passImagesDir, 'not a directory')
    const deps = passImageDeps()

    const out = await subscribeAndIssue(deps as never, opts)

    expect(out.issued).toBe(true)
    expect(out.vcId).toBe('did:zid:vc-1')
    expect(out.vcPassImagePaths).toBeUndefined()
  })

  it('also fetches the pass image on a FREE-template synchronous issuance (challenge.issued)', async () => {
    const deps = passImageDeps({
      mbi: {
        applyChallenge: vi.fn().mockResolvedValue({
          x402Version: 1,
          accepts: [],
          issued: { vcId: 'did:zid:vc-1', verifiableCredential: { id: 'did:zid:vc-1' } },
        }),
        applySettle: vi.fn(),
        downloadVcs: vi.fn().mockResolvedValue([
          { vc: { id: 'did:zid:vc-1' }, extraData: { vcPassBase64: [Buffer.from('free-pass-bytes').toString('base64')] } },
        ]),
      },
    })

    const out = await subscribeAndIssue(deps as never, opts)

    expect(out.vcPassImagePaths).toHaveLength(1)
    expect(readFileSync(out.vcPassImagePaths![0], 'utf8')).toBe('free-pass-bytes')
  })
})

// a Basic AI Birthcert asked for under a new username came back as issued: true with the cached
// one, username PMRBot, so the agent told the user a new credential had been issued under the name they gave.
describe('a cache hit is reported as already held, not as issued', () => {
  const held = {
    templateId: 'did:zid:t-1', vcId: 'did:zid:vc-held', issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    vc: { id: 'held', credentialSubject: { agentUsername: 'PMRBot', id: 'PMRBot', agentDid: holderDid } },
  }
  const run = (attributes: Record<string, unknown>) =>
    subscribeAndIssue(
      {
        mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() },
        sign: vi.fn(),
        pay: vi.fn(),
        holderDid,
        cache: { get: vi.fn().mockResolvedValue(held), set: vi.fn(), list: vi.fn() },
      },
      { ...opts, attributes },
    )

  it('says issued: false and alreadyHeld: true, and that nothing new was issued or paid', async () => {
    const out = await run({ agentUsername: 'PMRBot' })
    expect(out.issued).toBe(false)
    expect(out.alreadyHeld).toBe(true)
    expect(out.reason).toMatch(/^Already held/)
    expect(out.reason).toMatch(/nothing was paid and no new credential was issued/i)
    expect(out.reason).toMatch(/do not tell the user it was just issued/i)
    expect(out.differsFromRequest).toBeUndefined()
  })

  it('names a requested value that differs from the held one, and asks the user', async () => {
    const out = await run({ agentUsername: 'QA Basic' })
    expect(out.differsFromRequest).toEqual([{ attribute: 'agentUsername', held: 'PMRBot', requested: 'QA Basic' }])
    expect(out.reason).toMatch(/agentUsername "PMRBot", not the "QA Basic" asked for/)
    expect(out.reason).toMatch(/ask the user whether to keep it or replace it/i)
    expect(out.reason).toMatch(/forceReissue/)
  })

  it('ignores the derived id and agentDid, which the wallet fills in itself', async () => {
    const out = await run({ agentUsername: 'PMRBot', id: 'something-else', agentDid: 'did:zid:other' })
    expect(out.differsFromRequest).toBeUndefined()
  })

  it('ignores an attribute the caller left empty', async () => {
    const out = await run({ agentUsername: 'PMRBot', purpose: '' })
    expect(out.differsFromRequest).toBeUndefined()
  })
})

// a paid subscribe_and_issue paid on the first call. Without confirm: true a chargeable issuance stops at
// the price; a free one (MBI says paymentRequired: false) goes ahead, since nothing is paid.
describe('subscribe_and_issue asks before it pays', () => {
  const unconfirmed = { templateId: 'did:zid:t-1', attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } }
  const paidMbi = () => ({
    quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: true }),
    applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }),
    applySettle: vi.fn(),
  })

  it('a chargeable issuance without confirm: quotes, signs nothing, pays nothing, issues nothing', async () => {
    const mbi = paidMbi()
    const sign = vi.fn()
    const pay = vi.fn()
    const out = (await subscribeAndIssue({ mbi, sign, pay, holderDid, resolveSymbol: async () => 'JMYR' } as never, unconfirmed)) as unknown as Record<string, unknown>
    expect(mbi.quote).toHaveBeenCalledTimes(1)
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      issued: false,
      needsConfirmation: true,
      quote: { asset: accept.asset, assetSymbol: 'JMYR', maxAmountRequired: '1000000' },
      nextStep: 'ask_user_to_confirm_payment',
    })
    expect(String(out.reason)).toMatch(/^NOT PAID YET/)
    expect(String(out.askUser)).toMatch(/Shall I go ahead\?$/)
  })

  it('an MBI that does not say whether it charges is treated as chargeable', async () => {
    const mbi = { ...paidMbi(), quote: vi.fn().mockResolvedValue({ accepts: [accept] }) }
    const out = (await subscribeAndIssue({ mbi, sign: vi.fn(), pay: vi.fn(), holderDid } as never, unconfirmed)) as unknown as Record<string, unknown>
    expect(out.needsConfirmation).toBe(true)
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
  })

  it('a free issuance goes ahead without confirm', async () => {
    const issuedVc = { id: 'vc', validUntil: '2099-01-01T00:00:00Z' }
    const mbi = {
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: false }),
      applyChallenge: vi.fn().mockResolvedValue({ issued: { vcId: 'did:zid:vc-free', txHash: '0xfree', verifiableCredential: issuedVc } }),
      applySettle: vi.fn(),
    }
    const out = (await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay: vi.fn(), holderDid } as never,
      unconfirmed,
    )) as unknown as Record<string, unknown>
    expect(mbi.applyChallenge).toHaveBeenCalledTimes(1)
    expect(out.issued).toBe(true)
    expect(out.needsConfirmation).toBeUndefined()
  })

  it('without a quote client, it stops after the free payment request and before paying', async () => {
    const mbi = { applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [accept], paymentId: 'pid-1' }), applySettle: vi.fn() }
    const pay = vi.fn()
    const out = (await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, holderDid } as never,
      unconfirmed,
    )) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, needsConfirmation: true, quote: { maxAmountRequired: '1000000' } })
  })

  it('with confirm: true it pays as before, without an extra quote', async () => {
    const mbi = {
      ...paidMbi(),
      applySettle: vi.fn().mockResolvedValue({ vcId: 'did:zid:vc', txHash: '0xnew', verifiableCredential: { id: 'vc', validUntil: '2099-01-01T00:00:00Z' } }),
    }
    const pay = vi.fn().mockResolvedValue('XPAY')
    const out = (await subscribeAndIssue(
      { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, holderDid } as never,
      { ...unconfirmed, confirm: opts.confirm },
    )) as unknown as Record<string, unknown>
    expect(mbi.quote).not.toHaveBeenCalled()
    expect(pay).toHaveBeenCalledTimes(1)
    expect(out.issued).toBe(true)
  })

  it('a credential already held needs no confirm and says to tell the user, or to ask when it differs', async () => {
    const held = {
      templateId: 'did:zid:t-1', vcId: 'did:zid:vc-held', issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
      vc: { id: 'held', credentialSubject: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } },
    }
    const cache = { get: vi.fn().mockResolvedValue(held), set: vi.fn(), list: vi.fn() }
    const mbi = paidMbi()
    const same = (await subscribeAndIssue({ mbi, sign: vi.fn(), pay: vi.fn(), holderDid, cache } as never, unconfirmed)) as unknown as Record<string, unknown>
    expect(same).toMatchObject({ alreadyHeld: true, nextStep: 'tell_user_already_held' })
    const differs = (await subscribeAndIssue({ mbi, sign: vi.fn(), pay: vi.fn(), holderDid, cache } as never, {
      ...unconfirmed,
      attributes: { agentName: 'PMRBot' },
    })) as unknown as Record<string, unknown>
    expect(differs).toMatchObject({ alreadyHeld: true, nextStep: 'ask_user_whether_to_replace' })
    expect(String(differs.askUser)).toMatch(/replace it\?$/)
    expect(mbi.quote).not.toHaveBeenCalled()
  })
})

// an older credential that does not carry the requested attribute at all, e.g. agentName
// "PMRBot" held while agentUsername "NewBot" is asked for, was reported as plainly held with no mismatch.
describe('a held credential missing a requested attribute', () => {
  const old = {
    templateId: 'did:zid:t-1', vcId: 'did:zid:vc-old', issuedAt: '2026-07-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z',
    vc: { id: 'old', credentialSubject: { agentName: 'PMRBot', note: null } },
  }
  const run = (attributes: Record<string, unknown>) =>
    subscribeAndIssue(
      {
        mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() },
        sign: vi.fn(),
        pay: vi.fn(),
        holderDid,
        cache: { get: vi.fn().mockResolvedValue(old), set: vi.fn(), list: vi.fn() },
      },
      { ...opts, attributes },
    )

  it('names the attribute the held credential does not have', async () => {
    const out = await run({ agentUsername: 'NewBot' })
    expect(out.differsFromRequest).toEqual([{ attribute: 'agentUsername', held: undefined, requested: 'NewBot' }])
    expect(out.reason).toMatch(/agentUsername not set, not the "NewBot" asked for/)
  })

  it('a null held value reads as not set, never as the word null', async () => {
    const out = await run({ note: 'hello' })
    expect(out.reason).toMatch(/note not set, not the "hello" asked for/)
    expect(out.reason).not.toMatch(/"null"/)
  })
})

// the user's yes is the quote they saw, echoed back, and only that price is paid.
describe('subscribe_and_issue pays only the confirmed price', () => {
  const base = { templateId: 'did:zid:t-1', attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } }
  const QUOTE = { asset: accept.asset, maxAmountRequired: '1000000', payTo: 'ZTXissuer', gasModel: 'self' as const }
  const settled = { vcId: 'did:zid:vc', txHash: '0xnew', verifiableCredential: { id: 'vc', validUntil: '2099-01-01T00:00:00Z' } }
  const harness = (challengeAccept: unknown = accept, quoteResult: unknown = { accepts: [accept], paymentRequired: true }) => {
    const mbi = {
      quote: vi.fn().mockResolvedValue(quoteResult),
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [challengeAccept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue(settled),
    }
    const pay = vi.fn().mockResolvedValue('XPAY')
    const deps = { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, holderDid, resolveSymbol: async () => 'JMYR' }
    return { mbi, pay, deps }
  }

  it('confirm: true is not a confirmation: stops at the price', async () => {
    const { deps, pay } = harness()
    const out = (await subscribeAndIssue(deps as never, { ...base, confirm: true })) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(out).toMatchObject({ needsConfirmation: true, quote: QUOTE })
    expect(String(out.reason)).toMatch(/confirm: true is not accepted/)
  })

  it('the confirmed quote, naming the raw token address, is paid without another /quote call', async () => {
    const { deps, pay, mbi } = harness()
    const out = (await subscribeAndIssue(deps as never, { ...base, confirm: QUOTE })) as unknown as Record<string, unknown>
    expect(mbi.quote).not.toHaveBeenCalled()
    expect(pay).toHaveBeenCalledTimes(1)
    expect(out.issued).toBe(true)
  })

  it.each([
    ['amount', { maxAmountRequired: '2000000' }, /the amount is 2000000, not 1000000/],
    ['payee', { payTo: 'ZTXother' }, /the payee is ZTXother, not ZTXissuer/],
  ])('an issuer payment request whose %s differs from the confirmed quote is not paid', async (_n, change, why) => {
    const { deps, pay, mbi } = harness({ ...accept, ...change })
    const out = (await subscribeAndIssue(deps as never, { ...base, confirm: QUOTE })) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(mbi.applySettle).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, needsConfirmation: true, nextStep: 'ask_user_to_confirm_payment' })
    expect(String(out.reason)).toMatch(/not what the user agreed to/)
    expect(String(out.reason)).toMatch(why)
  })

  it('/quote said free but the issuer asks for payment: stops before paying', async () => {
    const { deps, pay } = harness(accept, { accepts: [accept], paymentRequired: false })
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(out).toMatchObject({ needsConfirmation: true, quote: QUOTE })
  })

  it('/quote failing is relayed, and nothing is signed', async () => {
    const { deps, mbi } = harness()
    mbi.quote.mockRejectedValue(new MbiError('MBI quote failed: 404 Template not found', 404))
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(deps.sign).not.toHaveBeenCalled()
    expect(out).toMatchObject({ issued: false, nextStep: 'follow_message' })
    expect(String(out.reason)).toMatch(/Template not found/)
  })

  it('an issuer that does not say whether it charges: the question says it may cost up to the amount', async () => {
    const { deps } = harness(accept, { accepts: [accept] })
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(String(out.askUser)).toMatch(/may cost up to .*does not say whether it charges/)
  })

  it('a quote with no amount says so, never "costs  base units"', async () => {
    const { deps } = harness(accept, { accepts: [{ ...accept, maxAmountRequired: '' }], paymentRequired: true })
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(String(out.askUser)).toMatch(/an amount the issuer did not state/)
    expect(String(out.askUser)).not.toMatch(/costs\s+base units/)
  })

  it('replacing a held credential: the price stop says to keep forceReissue and confirmReplaceExistingVc', async () => {
    const { deps } = harness()
    const held = { templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old', issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }
    const cache = { get: vi.fn().mockResolvedValue(held), set: vi.fn(), list: vi.fn() }
    const out = (await subscribeAndIssue({ ...deps, cache } as never, { ...base, forceReissue: true, confirmReplaceExistingVc: 'did:zid:vc-old' })) as unknown as Record<
      string,
      unknown
    >
    expect(out.needsConfirmation).toBe(true)
    expect(String(out.reason)).toMatch(/forceReissue and confirmReplaceExistingVc too/)
  })

  it('forceReissue without the exact id: shows the held one and asks whether to replace it', async () => {
    const { deps } = harness()
    const held = { templateId: 'did:zid:t-1', vc: { id: 'old' }, vcId: 'did:zid:vc-old', issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }
    const cache = { get: vi.fn().mockResolvedValue(held), set: vi.fn(), list: vi.fn() }
    const out = (await subscribeAndIssue({ ...deps, cache } as never, { ...base, forceReissue: true })) as unknown as Record<string, unknown>
    expect(out).toMatchObject({ issued: false, nextStep: 'ask_user_whether_to_replace' })
  })
})

describe('subscribe_and_issue R2', () => {
  const base = { templateId: 'did:zid:t-1', attributes: { agentName: 'Jak Sparrow', purpose: 'x401+x402' } }
  const settled = { vcId: 'did:zid:vc', txHash: '0xnew', verifiableCredential: { id: 'vc', validUntil: '2099-01-01T00:00:00Z' } }
  const harness = (challengeAccept: unknown = accept) => {
    const mbi = {
      quote: vi.fn().mockResolvedValue({ accepts: [accept], paymentRequired: true }),
      applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [challengeAccept], paymentId: 'pid-1' }),
      applySettle: vi.fn().mockResolvedValue(settled),
    }
    const pay = vi.fn().mockResolvedValue('XPAY')
    const deps = { mbi, sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }), pay, holderDid, resolveSymbol: async () => 'JMYR' }
    return { mbi, pay, deps }
  }

  // Low 3: the symbol alone bound the token, so a different contract with the same symbol was paid.
  it('the quote carries the raw token address, with the symbol only for display', async () => {
    const { deps } = harness()
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(out.quote).toMatchObject({ asset: accept.asset, assetSymbol: 'JMYR' })
  })

  it('a different token contract with the same symbol, amount and payee is not paid', async () => {
    const { deps, pay } = harness({ ...accept, asset: 'ZTX3othercontract000000000000000000' })
    const confirmed = { asset: accept.asset, maxAmountRequired: '1000000', payTo: 'ZTXissuer', gasModel: 'self' }
    const out = (await subscribeAndIssue(deps as never, { ...base, confirm: confirmed })) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(out.needsConfirmation).toBe(true)
    expect(String(out.reason)).toMatch(/the token is ZTX3othercontract/)
  })

  it('a quote naming the token only by its symbol is not enough to pay', async () => {
    const { deps, pay } = harness()
    const bySymbol = { asset: 'JMYR', maxAmountRequired: '1000000', payTo: 'ZTXissuer', gasModel: 'self' }
    const out = (await subscribeAndIssue(deps as never, { ...base, confirm: bySymbol })) as unknown as Record<string, unknown>
    expect(pay).not.toHaveBeenCalled()
    expect(out.needsConfirmation).toBe(true)
  })

  it('the self-pay question says ZTX network gas is paid on top', async () => {
    const { deps } = harness()
    const out = (await subscribeAndIssue(deps as never, base)) as unknown as Record<string, unknown>
    expect(String(out.askUser)).toMatch(/plus network gas paid in ZTX/)
  })

  it('a refusal says follow_message', async () => {
    const out = await subscribeAndIssue({ mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() }, sign: vi.fn(), pay: vi.fn(), holderDid } as never, {
      templateId: 'not-a-did',
      attributes: {},
    })
    expect(out.nextStep).toBe('follow_message')
  })
})
