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
  // The RAW contract seam the policy tools use, as distinct from the queryContract wrapper above.
  const chainQuery = vi.fn().mockResolvedValue({ errorCode: 0, result: { query_rets: [] } })
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
    chainQuery,
    checkActivationStatus,
    sleep,
  }
  return { deps, wallet, makeWallet, payer, mbi, sign, pay, createAccount, saveAccount, queryContract, chainQuery, checkActivationStatus, sleep }
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

  // Affordability usually needs the fee token AND gas together. One token per call meant the agent
  // discovered "you have the token but no gas" as a second, separate dead end.
  it('wallet_status reports several tokens in one call', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn(async (t: string) => ({ token: t, balance: '1', decimals: 6, display: `0.000001 ${t}` }))
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ tokens: ['JMYR', 'ZTX'] })
    expect(queryTokenBalance).toHaveBeenCalledWith('JMYR')
    expect(queryTokenBalance).toHaveBeenCalledWith('ZTX')
    expect(out.tokenBalances).toEqual([
      { token: 'JMYR', balance: '1', decimals: 6, display: '0.000001 JMYR' },
      { token: 'ZTX', balance: '1', decimals: 6, display: '0.000001 ZTX' },
    ])
  })

  it('wallet_status reports a per-token failure without losing the others', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn(async (t: string) =>
      t === 'ZTX' ? { token: t, error: 'query_failed' } : { token: t, balance: '1', decimals: 6, display: '0.000001 JMYR' },
    )
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ tokens: ['JMYR', 'ZTX'] })
    expect(out.tokenBalances).toEqual([
      { token: 'JMYR', balance: '1', decimals: 6, display: '0.000001 JMYR' },
      { token: 'ZTX', error: 'query_failed' },
    ])
  })

  it('wallet_status still honours the single-token form', async () => {
    const { deps } = makeDeps()
    const queryTokenBalance = vi.fn().mockResolvedValue({ token: 'JMYR', balance: '5000000' })
    const out = await createTools({ ...deps, queryTokenBalance }).wallet_status({ token: 'JMYR' })
    expect(out.tokenBalance).toEqual({ token: 'JMYR', balance: '5000000' })
    expect(out.tokenBalances).toBeUndefined()
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

  it('subscribe_and_issue includes the Basic Birthcert passDesignId (testnet) when issuing the birthcert alias', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'AI Birthcert', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].passDesignId).toBe('did:zid:992e1e18985ba36a09ba0fbfeb601ddeb449f5e4e882ed69d0d620085f399818')
  })

  it('subscribe_and_issue includes the Basic Birthcert passDesignId (mainnet) when configured for mainnet', async () => {
    const { deps, mbi } = makeDeps()
    deps.config.network = 'zetrix:mainnet'
    await createTools(deps).subscribe_and_issue({ templateId: 'birth cert', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].passDesignId).toBe('did:zid:915955cb71c6fd2a256d04344f57381084903cb6a85a1c9ddb71c746f08932ab')
  })

  it('subscribe_and_issue omits passDesignId entirely for a template that is not the Basic Birthcert', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0]).not.toHaveProperty('passDesignId')
  })

  // Code review (APP-L02): `{ ...deps.subscribeDeps, ...(passDesignId ? { passDesignId } : {}) }`
  // can only ADD the key, never clear it — an inherited passDesignId already sitting on
  // subscribeDeps would leak into an unrelated template's signed data, contradicting the comment's
  // "never a wallet-wide default" guarantee. Not live in the shipped wiring (index.ts sets no base
  // value), but the object must be built so an unresolved id explicitly clears one.
  it('subscribe_and_issue does not let an inherited subscribeDeps.passDesignId leak into an unrelated template', async () => {
    const { deps, mbi } = makeDeps()
    const out = await createTools({
      ...deps,
      subscribeDeps: { ...deps.subscribeDeps, passDesignId: 'did:zid:stale-inherited-pass-design' } as never,
    }).subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0]).not.toHaveProperty('passDesignId')
    expect(out.issued).toBe(true)
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
    const out = await createTools(deps).create_holder_account({})
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
    const out = await createTools(deps).create_holder_account({ confirmNew: true })
    expect(createAccount).toHaveBeenCalledWith(undefined, undefined)
    expect(out.zetrixAddress).toBe('ZTX3New')
    expect(out.holderDid).toBe('did:zid:ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9')
    expect(out.message).toMatch(/ZETRIX_ADDRESS/)
    expect(saveAccount).toHaveBeenCalledWith({
      zetrixAddress: 'ZTX3New',
      holderDid: 'did:zid:ba4f1fcf68831a5c689dfaa2195da1a3a7c37930228f886611f936fed0df66b9',
      label: undefined,
      purpose: undefined,
    })
  })

  it('create_holder_account threads checkActivationStatus/sleep through to the orchestrator', async () => {
    const { deps, checkActivationStatus } = makeDeps()
    await createTools(deps).create_holder_account({ confirmNew: true })
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

describe('createTools — AI Birthcert verification', () => {
  it('request_ai_birthcert_verification delegates to deps.verifyAiBirthcert.request', async () => {
    const { deps } = makeDeps()
    const request = vi.fn().mockResolvedValue({ sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-13T09:30:00+00:00' })
    const check = vi.fn()
    const out = await createTools({ ...deps, verifyAiBirthcert: { request, check } }).request_ai_birthcert_verification({ agentName: 'Procurement Assistant' })

    expect(request).toHaveBeenCalledWith({ agentName: 'Procurement Assistant' })
    expect(out).toEqual({ sessionId: 's-1', verificationUrl: 'https://zvg.test/verify/tok', expiresAt: '2026-08-13T09:30:00+00:00' })
  })

  it('request_ai_birthcert_verification reports unconfigured when verifyAiBirthcert deps are absent', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).request_ai_birthcert_verification({ agentName: 'Procurement Assistant' })
    expect(out).toEqual({ error: expect.stringContaining('not configured') })
  })

  it('check_ai_birthcert_verification delegates to deps.verifyAiBirthcert.check', async () => {
    const { deps } = makeDeps()
    const request = vi.fn()
    const check = vi.fn().mockResolvedValue({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' })
    const out = await createTools({ ...deps, verifyAiBirthcert: { request, check } }).check_ai_birthcert_verification()

    expect(check).toHaveBeenCalledTimes(1)
    expect(out).toEqual({ sessionId: 's-1', status: 'pending', expiresAt: '2026-08-13T09:30:00+00:00' })
  })

  it('check_ai_birthcert_verification reports unconfigured when verifyAiBirthcert deps are absent', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).check_ai_birthcert_verification()
    expect(out).toEqual({ error: expect.stringContaining('not configured') })
  })

  // R2-L07: the other two tools had both halves of this covered at the tool layer and clear_ had
  // neither. It is the destructive one, and its entire safety mechanism is the argument it forwards.
  it('clear_stuck_payment_receipt delegates to deps.verifyAiBirthcert.clearStuckReceipt, argument intact', async () => {
    const { deps } = makeDeps()
    const clearStuckReceipt = vi.fn().mockResolvedValue({ cleared: true, paymentReceipt: 'r-1' })
    const tools = createTools({ ...deps, verifyAiBirthcert: { request: vi.fn(), check: vi.fn(), clearStuckReceipt } })

    const out = await tools.clear_stuck_payment_receipt({ confirmReceiptId: 'r-1', confirmDiscardLiveSession: true })

    expect(clearStuckReceipt).toHaveBeenCalledWith({ confirmReceiptId: 'r-1', confirmDiscardLiveSession: true })
    expect(out).toEqual({ cleared: true, paymentReceipt: 'r-1' })
  })

  // A dropped argument here would turn the two-step gate into a one-step one: the orchestrator reads
  // an absent confirmReceiptId as "show me the warning first", so the default must stay an empty
  // object and never a silently-confirming one.
  it('clear_stuck_payment_receipt defaults to an argument-free call, which clears nothing', async () => {
    const { deps } = makeDeps()
    const clearStuckReceipt = vi.fn().mockResolvedValue({ cleared: false, requiresConfirmation: true })
    const tools = createTools({ ...deps, verifyAiBirthcert: { request: vi.fn(), check: vi.fn(), clearStuckReceipt } })

    await tools.clear_stuck_payment_receipt()

    expect(clearStuckReceipt).toHaveBeenCalledWith({})
  })

  it('clear_stuck_payment_receipt reports unconfigured when verifyAiBirthcert deps are absent', async () => {
    const { deps } = makeDeps()
    const out = await createTools(deps).clear_stuck_payment_receipt({ confirmReceiptId: 'r-1' })
    expect(out).toEqual({ error: expect.stringContaining('not configured') })
  })

  it('passes an explicit gasPayer through to the orchestrator', async () => {
    const { deps } = makeDeps()
    const request = vi.fn().mockResolvedValue({ session: { sessionId: 's-1' } })
    const check = vi.fn()
    const tools = createTools({ ...deps, verifyAiBirthcert: { request, check } })
    await tools.request_ai_birthcert_verification({ agentName: 'A', gasPayer: 'self' })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ gasPayer: 'self' }))
  })

  it('omits gasPayer when the caller does not set it, so the config default applies', async () => {
    const { deps } = makeDeps()
    const request = vi.fn().mockResolvedValue({ session: { sessionId: 's-1' } })
    const check = vi.fn()
    const tools = createTools({ ...deps, verifyAiBirthcert: { request, check } })
    await tools.request_ai_birthcert_verification({ agentName: 'A' })
    const arg = request.mock.calls[0][0]
    expect(arg.gasPayer).toBeUndefined()
  })

  // Pricing a template used to go through subscribe_and_issue({ dryRun: true }), which calls
  // applyChallenge — and for a FREE template applyChallenge IS the real synchronous issuance. So
  // asking "what does this cost?" could mint a credential carrying whatever attributes the pricing
  // call invented. POST /v1/vc/pay/quote cannot issue, which is why preflight uses it instead.
  describe('credential_preflight pricing a template credential', () => {
    const TPL = 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959'
    const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

    function templateDeps() {
      const { deps, mbi } = makeDeps()
      const quote = vi.fn().mockResolvedValue({
        accepts: [{ asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3issuer', extra: { paymentId: null, templateCode: 'ai-birthcert' } }],
        signPayload: '[{"templateId":"…"}]',
      })
      const queryTokenBalance = vi.fn(async (token: string) =>
        token === 'ZTX'
          ? { token: 'ZTX', balance: '4897510', decimals: 6, display: '4.89751 ZTX' }
          : { token: 'JMYR', balance: '0', decimals: 6, display: '0 JMYR' },
      )
      const resolveTemplateFields = vi.fn().mockResolvedValue({ required: ['agentUsername'], allKeys: ['agentUsername', 'ownerName'] })
      const full = {
        ...deps,
        subscribeDeps: { ...deps.subscribeDeps, mbi: { ...(deps.subscribeDeps.mbi as object), quote } as never, resolveTemplateFields },
        queryTokenBalance,
        paymentCaps: { [JMYR]: '5000000' },
      }
      return { full, quote, mbi, queryTokenBalance }
    }

    it('prices the template without ever calling applyChallenge — a free template must not be minted to answer a price question', async () => {
      const { full, quote, mbi } = templateDeps()
      await createTools(full).credential_preflight({ credential: TPL })
      expect(quote).toHaveBeenCalledTimes(1)
      expect(mbi.applyChallenge).not.toHaveBeenCalled()
      expect(mbi.applySettle).not.toHaveBeenCalled()
    })

    it('reports the amount to pay in human units, and checks ZTX gas because a template self-pays it', async () => {
      const { full, queryTokenBalance } = templateDeps()
      const out = await createTools(full).credential_preflight({ credential: TPL })
      expect(out.fee).toEqual({ asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3issuer', gasModel: 'self', display: '1 JMYR' })
      // Self-pay means gas is this wallet's problem, so ZTX is read alongside the fee asset.
      expect(queryTokenBalance.mock.calls.map((c) => c[0])).toEqual([JMYR, 'ZTX'])
      expect(out.cap).toMatchObject({ capRaw: '5000000', wouldPass: true })
      expect(out.blockers).toEqual(['Not enough JMYR: the fee is 1 JMYR, the balance is 0 JMYR.'])
    })

    // This covers the pass-through in priceTemplate — MBI's response to preflight's fee. The
    // preflight.ts unit tests inject `quoteTemplate` directly, so they never
    // cross that seam: deleting the pass-through left every other test in this suite green. This is the case that
    // fails when it is deleted, which is the only reason it is here rather than in preflight.test.ts.
    //
    // Note `templateDeps()` stubs a quote with NO paymentRequired, so the surrounding tests already
    // pin the "absent" half of the seam (they assert the balance blocker still fires). This pins
    // the "free" half.
    it('carries paymentRequired from MBI through to the fee, and stops blocking a free credential', async () => {
      const { full, quote } = templateDeps()
      quote.mockResolvedValue({
        accepts: [{ asset: JMYR, maxAmountRequired: '1000000', payTo: 'ZTX3issuer', extra: { paymentId: null, templateCode: 'ai-birthcert' } }],
        signPayload: '[{"templateId":"…"}]',
        paymentRequired: false,
      })

      const out = await createTools(full).credential_preflight({ credential: TPL })

      // The JMYR balance in templateDeps() is 0, so before this fix this blocked.
      expect(out.fee).toMatchObject({ maxAmountRequired: '1000000', display: '1 JMYR', paymentRequired: false })
      expect(out.blockers).toEqual([])
      expect(out.ready).toBe(true)
    })

    it('still reports the declared attribute schema alongside the price', async () => {
      const { full } = templateDeps()
      const out = await createTools(full).credential_preflight({ credential: TPL })
      expect(out.schema).toEqual({ required: ['agentUsername'], optional: ['ownerName'] })
    })

    it('needs no attribute values from the caller — the price comes from the template, not the data', async () => {
      const { full, quote } = templateDeps()
      await createTools(full).credential_preflight({ credential: TPL })
      const [, data] = quote.mock.calls[0]
      // Whatever is sent exists only to satisfy MBI's non-empty check; it must not look like a real value.
      expect(Object.keys(data as object)).toEqual(['preflight'])
    })

    it('reports a quote failure as a blocker rather than throwing', async () => {
      const { full, quote } = templateDeps()
      quote.mockRejectedValue(new Error('MBI quote failed: 404 Template not found'))
      const out = await createTools(full).credential_preflight({ credential: TPL })
      expect(out.ready).toBe(false)
      expect(out.blockers[0]).toMatch(/Template not found/)
      // The schema was still read, so the caller learns the fields even when pricing failed.
      expect(out.schema).toEqual({ required: ['agentUsername'], optional: ['ownerName'] })
    })

    // Reachable whenever subscribeDeps.mbi is built without the optional quote method — a wallet
    // wired by an older caller, or a test double. It must say so rather than report a free price.
    it('reports a blocker when this wallet has no MBI quote method at all', async () => {
      const { full } = templateDeps()
      const noQuote = { ...full, subscribeDeps: { ...full.subscribeDeps, mbi: { applyChallenge: vi.fn(), applySettle: vi.fn() } as never } }
      const out = await createTools(noQuote).credential_preflight({ credential: TPL })
      expect(out.ready).toBe(false)
      expect(out.blockers[0]).toMatch(/cannot price template credentials/i)
      expect(out.fee).toBeUndefined()
    })

    // A 200 from MBI carrying no accepts[] would otherwise read as "priced at nothing".
    it('reports a blocker when MBI answers with no payment options', async () => {
      const { full, quote } = templateDeps()
      quote.mockResolvedValue({ accepts: [] })
      const out = await createTools(full).credential_preflight({ credential: TPL })
      expect(out.ready).toBe(false)
      expect(out.blockers[0]).toMatch(/no payment options/i)
      expect(out.fee).toBeUndefined()
    })

    // CHECKLIST.md records a shipped defect where a sponsored credential was preflighted as
    // self-pay, demanding ZTX the holder never needed. That was guarded by a test written against
    // subscribe_and_issue's dryRun; moving preflight onto priceTemplate moved it off that guard,
    // so the branch needs its own coverage here or the defect class quietly reopens.
    it('reports gasModel sponsored — and does not demand ZTX — when MBI quotes a facilitator-sponsored option', async () => {
      const { full, quote, queryTokenBalance } = templateDeps()
      quote.mockResolvedValue({
        accepts: [
          {
            asset: JMYR,
            maxAmountRequired: '1000000',
            payTo: 'ZTX3issuer',
            extra: { paymentId: null, gasModel: 'facilitator', prepareEndpoint: 'https://facilitator/api/prepare' },
          },
        ],
      })
      const out = await createTools(full).credential_preflight({ credential: TPL })
      expect(out.fee).toMatchObject({ gasModel: 'sponsored' })
      // Sponsored means the paymaster covers gas, so ZTX must not be read or reported as a blocker.
      expect(queryTokenBalance.mock.calls.map((c) => c[0])).toEqual([JMYR])
      expect(out.blockers.join(' ')).not.toMatch(/ZTX/)
    })

    // The schema read already knows a malformed id is unusable, and says so far more precisely than
    // MBI's generic "not found, inactive, or not issued by the configured issuer".
    it('reports the local schema error without calling MBI when the templateId is malformed', async () => {
      const { full, quote } = templateDeps()
      const out = await createTools(full).credential_preflight({ credential: 'not-a-did' })
      expect(quote).not.toHaveBeenCalled()
      expect(out.blockers[0]).toMatch(/must be a did:zid/i)
    })
  })
})

describe('create_verification_qr', () => {
  const link = { created: true, link: 'https://link.myid.test/agentic-verify?referenceId=v2-1', referenceId: 'v2-1' }
  const VERIFIED = 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80'
  const BASIC_TESTNET = 'did:zid:3c0fb79adff08e14e06dcd6e3243205010dd65f533434a3d96c55575d1d3d959'
  const BASIC_MAINNET = 'did:zid:19091d19049abb8869b4b8e2f4a887bd1d1d86e5f5ebd0c8297000255f67765b'
  const OTHER = 'did:zid:c042e49e55ffe1b0ee835e6a8b3d1aec720fb1cb01dca17c4b3e5c2194949a6c'
  type Held = { templateId: string; vc: unknown; validUntil?: string }
  const cacheOf = (...held: Held[]) => ({
    get: vi.fn(),
    set: vi.fn(),
    list: vi.fn().mockResolvedValue(held.map((h) => ({ ...h, issuedAt: '2026-01-01T00:00:00Z' }))),
  })
  /** A wallet that holds `held`, on testnet where the Verified AI Birthcert's template id is known. */
  const holding = (deps: ReturnType<typeof makeDeps>['deps'], ...held: Held[]) => ({
    ...deps,
    cache: cacheOf(...held),
    config: { ...deps.config, aiBirthcertVerifiedTemplateId: VERIFIED },
  })

  describe('which credential it presents when none is named', () => {
    it('presents the Verified AI Birthcert when the wallet holds one, and passes the other inputs through', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: { id: 'verified-vc' } }), createVerificationLink }).create_verification_qr({
        revealAttribute: ['a.b'],
        expiryMinutes: 10,
      })

      expect(createVerificationLink).toHaveBeenCalledWith({ vc: { id: 'verified-vc' }, revealAttribute: ['a.b'], revealAll: undefined, expiryMinutes: 10 })
      expect(out).toEqual({ ...link, credentialUsed: 'Verified AI Birthcert' })
    })

    it('prefers the Verified AI Birthcert over the Basic one and over any other credential held', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({
        ...holding(deps, { templateId: OTHER, vc: { id: 'other-vc' } }, { templateId: BASIC_TESTNET, vc: { id: 'basic-vc' } }, { templateId: VERIFIED, vc: { id: 'verified-vc' } }),
        createVerificationLink,
      }).create_verification_qr({})

      expect(createVerificationLink.mock.calls[0][0].vc).toEqual({ id: 'verified-vc' })
    })

    it('falls back to the Basic AI Birthcert when there is no Verified one', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      const out = await createTools({
        ...holding(deps, { templateId: OTHER, vc: { id: 'other-vc' } }, { templateId: BASIC_TESTNET, vc: { id: 'basic-vc' } }),
        createVerificationLink,
      }).create_verification_qr({})

      expect(createVerificationLink.mock.calls[0][0].vc).toEqual({ id: 'basic-vc' })
      expect(out).toMatchObject({ credentialUsed: 'Basic AI Birthcert' })
    })

    it('falls back to the Basic one when the Verified one has expired', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({
        ...holding(deps, { templateId: VERIFIED, vc: { id: 'verified-vc' }, validUntil: '2020-01-01T00:00:00Z' }, { templateId: BASIC_TESTNET, vc: { id: 'basic-vc' } }),
        createVerificationLink,
      }).create_verification_qr({})

      expect(createVerificationLink.mock.calls[0][0].vc).toEqual({ id: 'basic-vc' })
    })

    it("uses the active network's Basic template id, and copes with no Verified template id on mainnet", async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)
      const mainnet = {
        ...deps,
        config: { ...deps.config, network: 'zetrix:mainnet', aiBirthcertVerifiedTemplateId: undefined },
        cache: cacheOf({ templateId: BASIC_TESTNET, vc: { id: 'testnet-basic' } }, { templateId: BASIC_MAINNET, vc: { id: 'mainnet-basic' } }),
      }

      await createTools({ ...mainnet, createVerificationLink }).create_verification_qr({})

      expect(createVerificationLink.mock.calls[0][0].vc).toEqual({ id: 'mainnet-basic' })
    })

    it.each([
      ['holds only some other credential', [{ templateId: OTHER, vc: { id: 'other-vc' } }]],
      ['holds nothing', []],
    ])('tells the agent to create a credential first when the wallet %s, without calling MBI', async (_label, held) => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn()

      const out = await createTools({ ...holding(deps, ...(held as Held[])), createVerificationLink }).create_verification_qr({})

      expect(out).toMatchObject({ created: false })
      const reason = (out as { reason: string }).reason
      expect(reason).toMatch(/Verified AI Birthcert/)
      expect(reason).toMatch(/Basic AI Birthcert/)
      expect(reason).toMatch(/request_ai_birthcert_verification/)
      expect(reason).toMatch(/subscribe_and_issue/)
      expect(createVerificationLink).not.toHaveBeenCalled()
    })

    it('gives the same answer when there is no credential cache at all', async () => {
      const { deps } = makeDeps()

      const out = await createTools({ ...deps, createVerificationLink: vi.fn() }).create_verification_qr({})

      expect(out).toMatchObject({ created: false })
      expect((out as { reason: string }).reason).toMatch(/request_ai_birthcert_verification/)
    })
  })

  describe('what it reveals when the caller does not say', () => {
    const verifiedVc = {
      id: 'verified-vc',
      credentialSubject: {
        id: 'did:zid:h',
        verifiedAiBirthcert: { agentName: 'a', ownerName: 'n', ownerId: 'i', evidenceProvider: 'e', ownerVerified: true, dob: 'd' },
      },
    }
    const basicVc = { id: 'basic-vc', credentialSubject: { id: 'did:zid:h', aiBirthcert: { agentUsername: 'u', id: 'u' } } }
    const STANDARD_VERIFIED = ['verifiedAiBirthcert.agentName', 'verifiedAiBirthcert.evidenceProvider', 'verifiedAiBirthcert.ownerVerified']

    it('reveals agentName, evidenceProvider and ownerVerified for the Verified AI Birthcert, and says it was the default', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({})

      expect(createVerificationLink).toHaveBeenCalledWith({ vc: verifiedVc, revealAttribute: STANDARD_VERIFIED, revealAll: undefined, expiryMinutes: undefined })
      expect(out).toMatchObject({ revealedByDefault: true, credentialUsed: 'Verified AI Birthcert' })
    })

    it('reveals only the agent username for the Basic AI Birthcert, and says what a Basic credential does not show', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue({ ...link, message: 'Show the user the QR.' })

      const out = (await createTools({ ...holding(deps, { templateId: BASIC_TESTNET, vc: basicVc }), createVerificationLink }).create_verification_qr({})) as {
        message: string
      }

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toEqual(['aiBirthcert.agentUsername'])
      expect(out.message).toMatch(/Basic AI Birthcert/)
      expect(out.message).toMatch(/does not mean the owner was verified/)
    })

    it('does not add the Basic caveat to a Verified presentation', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue({ ...link, message: 'Show the user the QR.' })

      const out = (await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({})) as {
        message: string
      }

      expect(out.message).not.toMatch(/does not mean the owner was verified/)
    })

    it('treats an empty revealAttribute as not given', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({ revealAttribute: [] })

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toEqual(STANDARD_VERIFIED)
    })

    it('uses the attributes the caller names instead of the standard set, and does not call that a default', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({
        revealAttribute: ['verifiedAiBirthcert.ownerName'],
      })

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toEqual(['verifiedAiBirthcert.ownerName'])
      expect(out).not.toHaveProperty('revealedByDefault')
    })

    it('does not apply the standard set when revealAll is asked for', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({ revealAll: true })

      expect(createVerificationLink).toHaveBeenCalledWith({ vc: verifiedVc, revealAttribute: undefined, revealAll: true, expiryMinutes: undefined })
      expect(out).not.toHaveProperty('revealedByDefault')
    })

    it('reveals only the standard attributes the credential actually has', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)
      const noProvider = { ...verifiedVc, credentialSubject: { id: 'did:zid:h', verifiedAiBirthcert: { agentName: 'a', ownerVerified: true, ownerName: 'n' } } }

      await createTools({ ...holding(deps, { templateId: VERIFIED, vc: noProvider }), createVerificationLink }).create_verification_qr({})

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toEqual(['verifiedAiBirthcert.agentName', 'verifiedAiBirthcert.ownerVerified'])
    })

    it('refuses, naming what the credential has, when none of the standard attributes are there', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn()
      const odd = { id: 'odd', credentialSubject: { id: 'did:zid:h', verifiedAiBirthcert: { ownerName: 'n', dob: 'd' } } }

      const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: odd }), createVerificationLink }).create_verification_qr({})

      expect(out).toMatchObject({ created: false })
      expect((out as { reason: string }).reason).toMatch(/standard set/)
      expect((out as { reason: string }).reason).toContain('verifiedAiBirthcert.ownerName')
      expect(createVerificationLink).not.toHaveBeenCalled()
    })

    it('applies the standard set to a credential the caller passes in when it is the one the wallet holds', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({ vc: verifiedVc })

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toEqual(STANDARD_VERIFIED)
    })

    it('has no standard set for a credential it does not recognise, so the caller must say', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({ ...holding(deps, { templateId: VERIFIED, vc: verifiedVc }), createVerificationLink }).create_verification_qr({
        vc: { id: 'some-other-vc', credentialSubject: { id: 'did:zid:h', thing: { a: 1 } } },
      })

      expect(createVerificationLink.mock.calls[0][0].revealAttribute).toBeUndefined()
    })
  })

  it('presents the credential the caller names instead of the cache', async () => {
    const { deps } = makeDeps()
    const createVerificationLink = vi.fn().mockResolvedValue(link)
    const cache = cacheOf({ templateId: VERIFIED, vc: { id: 'verified-vc' } })

    const out = await createTools({ ...deps, cache, createVerificationLink }).create_verification_qr({ vc: { id: 'explicit' }, revealAttribute: ['a.b'] })

    expect(createVerificationLink.mock.calls[0][0].vc).toEqual({ id: 'explicit' })
    expect(cache.list).not.toHaveBeenCalled()
    expect(out).toMatchObject({ credentialUsed: 'the credential you supplied' })
  })

  it('passes revealAll through', async () => {
    const { deps } = makeDeps()
    const createVerificationLink = vi.fn().mockResolvedValue(link)

    await createTools({ ...holding(deps, { templateId: VERIFIED, vc: { id: 'verified-vc' } }), createVerificationLink }).create_verification_qr({ revealAll: true })

    expect(createVerificationLink).toHaveBeenCalledWith({ vc: { id: 'verified-vc' }, revealAttribute: undefined, revealAll: true, expiryMinutes: undefined })
  })

  it('does not label a failure with a credential', async () => {
    const { deps } = makeDeps()
    const createVerificationLink = vi.fn().mockResolvedValue({ created: false, reason: 'nope' })

    const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: { id: 'verified-vc' } }), createVerificationLink }).create_verification_qr({})

    expect(out).toEqual({ created: false, reason: 'nope' })
  })

  describe('a credential that is not this wallet\'s', () => {
    // MBI refuses it too, but the wallet should not need a round trip to know a credential issued to someone else
    // is not its own to present.
    it.each([
      ['named by the caller', (deps: ReturnType<typeof makeDeps>['deps']) => ({ ...deps, cache: cacheOf() }), { vc: { credentialSubject: { id: 'did:zid:someone-else' } } }],
      ['loaded from the cache', (deps: ReturnType<typeof makeDeps>['deps']) => holding(deps, { templateId: VERIFIED, vc: { credentialSubject: { id: 'did:zid:someone-else' } } }), {}],
    ])('is refused locally when it is %s', async (_label, withDeps, input) => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn()

      const out = await createTools({ ...withDeps(deps), createVerificationLink }).create_verification_qr(input)

      expect(out).toMatchObject({ created: false })
      expect((out as { reason: string }).reason).toMatch(/did:zid:someone-else/)
      expect((out as { reason: string }).reason).toMatch(/did:zid:h\b/)
      expect(createVerificationLink).not.toHaveBeenCalled()
    })

    it('is presented when its subject is this wallet', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({ ...deps, createVerificationLink }).create_verification_qr({ vc: { credentialSubject: { id: 'did:zid:h' } } })

      expect(createVerificationLink).toHaveBeenCalledTimes(1)
    })

    it('is presented when it carries no subject id, leaving the decision to MBI', async () => {
      const { deps } = makeDeps()
      const createVerificationLink = vi.fn().mockResolvedValue(link)

      await createTools({ ...deps, createVerificationLink }).create_verification_qr({ vc: { id: 'no-subject' } })

      expect(createVerificationLink).toHaveBeenCalledTimes(1)
    })
  })

  // The holder check and the reveal check both read the credential's fields; a value that is not an object skips
  // them, so it is refused here rather than passed on.
  it.each([
    ['a JSON string', '{"credentialSubject":{"id":"did:zid:someone-else"}}'],
    ['null', null],
    ['an array', [{ credentialSubject: { id: 'did:zid:someone-else' } }]],
    ['a number', 7],
  ])('refuses a vc that is %s, without calling MBI', async (_label, vc) => {
    const { deps } = makeDeps()
    const createVerificationLink = vi.fn()

    const out = await createTools({ ...deps, createVerificationLink }).create_verification_qr({ vc })

    expect(out).toMatchObject({ created: false })
    expect((out as { reason: string }).reason).toMatch(/credential object/)
    expect(createVerificationLink).not.toHaveBeenCalled()
  })

  it('answers created:false when the capability is not wired', async () => {
    const { deps } = makeDeps()

    const out = await createTools({ ...holding(deps, { templateId: VERIFIED, vc: { id: 'a' } }) }).create_verification_qr({})

    expect(out).toMatchObject({ created: false })
    expect((out as { reason: string }).reason).toMatch(/not configured/)
  })
})
