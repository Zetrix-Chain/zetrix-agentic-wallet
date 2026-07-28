import { describe, it, expect, vi } from 'vitest'
import { createTools } from '../mcp-tools'

function makeDeps() {
  const wallet = { respondToChallenge: vi.fn().mockResolvedValue({ headerValue: 'HDR', verified: true, presentationId: 'req-1' }) }
  const makeWallet = vi.fn().mockReturnValue(wallet)
  const payer = vi.fn().mockResolvedValue({ status: 200, body: 'ok', paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '' })
  const mbi = {
    applyChallenge: vi.fn().mockResolvedValue({ x402Version: 2, accepts: [{ extra: { paymentId: 'pid' } }], paymentId: 'pid' }),
    applySettle: vi.fn().mockResolvedValue({ vcId: 'vc-1', verifiableCredential: { id: 'vc' }, txHash: '0x' }),
  }
  const sign = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' })
  const pay = vi.fn().mockResolvedValue('XPAY')
  const createAccount = vi.fn().mockResolvedValue({
    zetrixAddress: 'ZTX3New',
    publicKeyHex: 'b001ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b94a10ec51',
    activated: true,
    activationTxHash: '0xabc',
  })
  const saveAccount = vi.fn().mockResolvedValue(undefined)
  const queryContract = vi.fn().mockResolvedValue({ ok: true, result: { balance: '5000000' } })
  const checkActivationStatus = vi.fn().mockResolvedValue({ address: 'ZTX3New', activated: true })
  const sleep = vi.fn().mockResolvedValue(undefined)
  const deps = {
    config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
    makeWallet: makeWallet as never,
    payer,
    subscribeDeps: { mbi: mbi as never, sign, pay, holderDid: 'did:zid:h' },
    createAccount,
    saveAccount,
    queryContract,
    checkActivationStatus,
    sleep,
  }
  return { deps, wallet, makeWallet, payer, mbi, sign, pay, createAccount, saveAccount, queryContract, checkActivationStatus, sleep }
}

describe('createTools', () => {
  it('wallet_status reports identity + client-supplied held credentials', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).wallet_status({ heldCredentials: [{ id: 'vc-1' }] })
    expect(out).toMatchObject({
      holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet', credentials: [{ id: 'vc-1' }],
    })
  })

  it('wallet_status defaults credentials to [] when none supplied', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).wallet_status()
    expect(out.credentials).toEqual([])
  })

  it('wallet_status includes tokenBalance when token is provided and resolves', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn().mockResolvedValue({ token: 'JMYR', balance: '5000000' })
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ token: 'JMYR' })
    expect(queryTokenBalance).toHaveBeenCalledWith('JMYR')
    expect(out.tokenBalance).toEqual({ token: 'JMYR', balance: '5000000' })
  })

  it('wallet_status surfaces an unknown_token result without throwing', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn().mockResolvedValue({ token: 'DOGE', error: 'unknown_token' })
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ token: 'DOGE' })
    expect(out.tokenBalance).toEqual({ token: 'DOGE', error: 'unknown_token' })
  })

  it('wallet_status surfaces a query_failed result without throwing when the ZTP20 lookup errors', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn().mockResolvedValue({ token: 'JMYR', error: 'query_failed' })
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ token: 'JMYR' })
    expect(out.tokenBalance).toEqual({ token: 'JMYR', error: 'query_failed' })
  })

  it('wallet_status surfaces a query_failed result without throwing when the ZTX lookup errors', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn().mockResolvedValue({ token: 'ZTX', error: 'query_failed' })
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ token: 'ZTX' })
    expect(out.tokenBalance).toEqual({ token: 'ZTX', error: 'query_failed' })
  })

  it('wallet_status omits tokenBalance when token is not provided', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn()
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status()
    expect(queryTokenBalance).not.toHaveBeenCalled()
    expect(out.tokenBalance).toBeUndefined()
  })

  it('prove_identity builds a per-request wallet from the client VC and delegates', async () => {
    const { deps, wallet, makeWallet } = makeDeps()
    const out = await createTools(deps).prove_identity({
      proofRequest: 'REQ', vc: { id: 'vc-1' }, revealAttribute: ['mykad.name'],
    })
    expect(makeWallet).toHaveBeenCalledWith({ vc: { id: 'vc-1' }, revealAttribute: ['mykad.name'] })
    expect(wallet.respondToChallenge).toHaveBeenCalledWith('REQ', 'did:zid:h')
    expect(out).toEqual({ proofResponseHeader: 'HDR', verified: true, presentationId: 'req-1' })
  })

  it('pay_and_fetch passes the request to the injected payer', async () => {
    const { deps, payer } = makeDeps()
    await createTools(deps).pay_and_fetch({ url: 'https://api.test/x' })
    expect(payer).toHaveBeenCalledWith({ url: 'https://api.test/x' })
  })

  it('subscribe_and_issue runs the MBI flow and returns the issued VC', async () => {
    const { deps, mbi, pay } = makeDeps()
    const out = await createTools(deps).subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    expect(mbi.applyChallenge).toHaveBeenCalled()
    expect(pay).toHaveBeenCalled()
    expect(out).toEqual({ issued: true, vcId: 'vc-1', vc: { id: 'vc' }, txHash: '0x', paidAsset: '', amountPaid: '' })
  })

  it('subscribe_and_issue resolves a natural-language alias to the network-appropriate templateId', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].templateId).toBe('did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959')
  })

  it('subscribe_and_issue resolves the alias to the mainnet id when configured for mainnet', async () => {
    const { deps, mbi } = makeDeps()
    deps.config.network = 'zetrix:mainnet'
    await createTools(deps).subscribe_and_issue({ templateId: 'birth cert', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].templateId).toBe('did:zid:19091d19049abb8869b4b8e2f4a887bd1d1d86e5f5ebd0c8297000255f67765b')
  })

  it('subscribe_and_issue passes a raw did:zid:... templateId through unchanged', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].templateId).toBe('did:zid:t')
  })

  it('subscribe_and_issue derives the birthcert id attribute from agentUsername when id is not supplied', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { agentUsername: 'agent-007' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].metadata).toEqual({ agentUsername: 'agent-007', id: 'agent-007' })
  })

  it('subscribe_and_issue does not overwrite a caller-supplied birthcert id', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { agentUsername: 'agent-007', id: 'custom-id' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].metadata).toEqual({ agentUsername: 'agent-007', id: 'custom-id' })
  })

  it('subscribe_and_issue rejects an invalid birthcert dob without paying', async () => {
    const { deps, mbi, pay } = makeDeps()
    const out = await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { dob: '1990/05/17' } })
    expect(out).toEqual({ issued: false, reason: expect.stringMatching(/YYYY-MM-DD/) })
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
  })

  it('subscribe_and_issue rejects an invalid birthcert countryOfOrigin without paying', async () => {
    const { deps, mbi } = makeDeps()
    const out = await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { countryOfOrigin: 'Narnia' } })
    expect(out).toEqual({ issued: false, reason: expect.stringMatching(/ISO 3166/) })
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
  })

  it('subscribe_and_issue accepts a valid birthcert dob and countryOfOrigin', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({
      templateId: 'AI Birthcert',
      attributes: { agentUsername: 'agent-007', dob: '1990-05-17', countryOfOrigin: 'MY' },
    })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].metadata).toEqual({ agentUsername: 'agent-007', id: 'agent-007', dob: '1990-05-17', countryOfOrigin: 'MY' })
  })

  it('subscribe_and_issue hides the auto-derived "id" key from the schema surfaced back to the caller', async () => {
    const { deps } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentUsername', 'id'],
      allKeys: ['agentUsername', 'id', 'dob', 'countryOfOrigin'],
    })
    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { agentUsername: 'agent-007' } })
    expect(out.schema).toEqual({ required: ['agentUsername'], optional: ['dob', 'countryOfOrigin'] })
  })

  it('subscribe_and_issue hides the auto-filled "agentDid" key from the schema surfaced back to the caller', async () => {
    const { deps } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue({
      required: ['agentDid', 'name'],
      allKeys: ['agentDid', 'name'],
    })
    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    expect(out.schema).toEqual({ required: ['name'], optional: [] })
  })

  it('create_holder_account does NOT create when an account already exists for this session, and asks to confirm', async () => {
    const { deps, createAccount, saveAccount } = makeDeps()
    const out = await createTools(deps).create_holder_account({ password: 'pw123456' })
    expect(createAccount).not.toHaveBeenCalled()
    expect(saveAccount).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      created: false,
      alreadyExists: true,
      existing: { zetrixAddress: 'ZTX3H', holderDid: 'did:zid:h' },
    })
  })

  it('create_holder_account creates + saves a new HSM account when confirmNew is set', async () => {
    const { deps, createAccount, saveAccount } = makeDeps()
    const out = await createTools(deps).create_holder_account({ password: 'pw123456', confirmNew: true })
    expect(createAccount).toHaveBeenCalledWith('pw123456', undefined, undefined)
    expect(out.zetrixAddress).toBe('ZTX3New')
    expect(out.holderDid).toBe('did:zid:ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9')
    expect(out.message).toMatch(/ZETRIX_ADDRESS/)
    expect(saveAccount).toHaveBeenCalledWith({
      zetrixAddress: 'ZTX3New',
      holderDid: 'did:zid:ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9',
      hsmPassword: 'pw123456',
      label: undefined,
      purpose: undefined,
    })
  })

  it('create_holder_account threads checkActivationStatus/sleep through to the orchestrator', async () => {
    const { deps, checkActivationStatus } = makeDeps()
    await createTools(deps).create_holder_account({ password: 'pw123456', confirmNew: true })
    expect(checkActivationStatus).not.toHaveBeenCalled() // activated:true on create — no polling needed
  })

  it('wallet_status reports valid cached credentials when heldCredentials is omitted', async () => {
    const { deps } = makeDeps()
    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      list: vi.fn().mockResolvedValue([
        { templateId: 'did:zid:t1', vc: { id: 'cached-1' }, issuedAt: '2026-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' },
        { templateId: 'did:zid:t2', vc: { id: 'expired' }, issuedAt: '2020-01-01T00:00:00Z', validUntil: '2020-06-01T00:00:00Z' },
      ]),
    }
    const out = await createTools({ ...deps, cache }).wallet_status()
    expect(out.credentials).toEqual([{ id: 'cached-1' }])
  })

  it('wallet_status ignores the cache when the caller explicitly supplies heldCredentials (even empty)', async () => {
    const { deps } = makeDeps()
    const cache = { get: vi.fn(), set: vi.fn(), list: vi.fn().mockResolvedValue([{ templateId: 't', vc: { id: 'cached' }, issuedAt: '2026-01-01T00:00:00Z' }]) }
    const out = await createTools({ ...deps, cache }).wallet_status({ heldCredentials: [] })
    expect(out.credentials).toEqual([])
    expect(cache.list).not.toHaveBeenCalled()
  })

  it('prove_identity auto-loads the single valid cached VC when vc is omitted', async () => {
    const { deps, makeWallet } = makeDeps()
    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      list: vi.fn().mockResolvedValue([{ templateId: 'did:zid:t1', vc: { id: 'cached-1' }, issuedAt: '2026-01-01T00:00:00Z' }]),
    }
    await createTools({ ...deps, cache }).prove_identity({ proofRequest: 'REQ' })
    expect(makeWallet).toHaveBeenCalledWith({ vc: { id: 'cached-1' }, revealAttribute: undefined, issuerKeys: undefined })
  })

  it('prove_identity throws a clear error when vc is omitted and nothing is cached', async () => {
    const { deps } = makeDeps()
    const cache = { get: vi.fn(), set: vi.fn(), list: vi.fn().mockResolvedValue([]) }
    await expect(createTools({ ...deps, cache }).prove_identity({ proofRequest: 'REQ' })).rejects.toThrow(/no valid credential is cached/)
  })

  it('prove_identity throws a clear error when vc is omitted and multiple credentials are cached', async () => {
    const { deps } = makeDeps()
    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      list: vi.fn().mockResolvedValue([
        { templateId: 'did:zid:t1', vc: { id: 'a' }, issuedAt: '2026-01-01T00:00:00Z' },
        { templateId: 'did:zid:t2', vc: { id: 'b' }, issuedAt: '2026-01-01T00:00:00Z' },
      ]),
    }
    await expect(createTools({ ...deps, cache }).prove_identity({ proofRequest: 'REQ' })).rejects.toThrow(/multiple credentials are cached/)
  })

  it('query_contract delegates to the injected queryContract dep', async () => {
    const { deps, queryContract } = makeDeps()
    const out = await createTools(deps).query_contract({ contractAddress: 'ZTX3token', method: 'balanceOf', params: { address: 'ZTX3H' } })
    expect(queryContract).toHaveBeenCalledWith({ contractAddress: 'ZTX3token', method: 'balanceOf', params: { address: 'ZTX3H' } })
    expect(out).toEqual({ ok: true, result: { balance: '5000000' } })
  })
})

// Discovery fix: the only way to ask "what does this template need?" used to be
// subscribe_and_issue({ dryRun: true }) — a tool whose name reads as "this charges money", so an
// agent reasoning about required fields had no obvious reason to reach for it. Reported live: the
// agent learned agentUsername was required by failing an issuance first.
describe('get_template_schema', () => {
  it('returns the template schema without paying, signing, or calling MBI', async () => {
    const { deps, mbi, pay, sign } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue({ required: ['agentUsername'], allKeys: ['agentUsername', 'ownerName', 'dob'] })

    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .get_template_schema({ templateId: 'did:zid:t-1' })

    expect(out).toEqual({ templateId: 'did:zid:t-1', schema: { required: ['agentUsername'], optional: ['ownerName', 'dob'] } })
    expect(mbi.applyChallenge).not.toHaveBeenCalled()
    expect(pay).not.toHaveBeenCalled()
    expect(sign).not.toHaveBeenCalled()
  })

  it('resolves a named template alias to its did:zid id', async () => {
    const { deps } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue({ required: ['agentUsername'], allKeys: ['agentUsername'] })

    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .get_template_schema({ templateId: 'AI Birthcert' })

    expect(resolveTemplateFields).toHaveBeenCalledWith(expect.stringMatching(/^did:zid:/))
    expect(out.templateId).toMatch(/^did:zid:/)
  })

  it('hides attributes the wallet fills in itself (agentDid and alias-derived keys)', async () => {
    const { deps } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue({ required: ['agentDid', 'agentUsername'], allKeys: ['agentDid', 'agentUsername', 'id'] })

    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .get_template_schema({ templateId: 'AI Birthcert' })

    expect(out.schema?.required).not.toContain('agentDid')
    expect(out.schema?.optional).not.toContain('id')
    expect(out.schema?.required).toContain('agentUsername')
  })

  it('reports a clear error instead of an empty schema when the template cannot be read', async () => {
    const { deps } = makeDeps()
    const resolveTemplateFields = vi.fn().mockResolvedValue(null)

    const out = await createTools({ ...deps, subscribeDeps: { ...deps.subscribeDeps, resolveTemplateFields } })
      .get_template_schema({ templateId: 'did:zid:t-unknown' })

    expect(out.schema).toBeUndefined()
    expect(out.error).toMatch(/could not be read/i)
  })

  it('rejects a non-did:zid templateId that is not a known alias', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).get_template_schema({ templateId: 'agent-identity' })
    expect(out.error).toMatch(/did:zid/)
  })
})
