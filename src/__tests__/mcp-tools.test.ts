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
  })
  const saveAccount = vi.fn().mockResolvedValue(undefined)
  const deps = {
    config: { holderDid: 'did:zid:h', zetrixAddress: 'ZTX3H', network: 'zetrix:testnet' },
    makeWallet: makeWallet as never,
    payer,
    subscribeDeps: { mbi: mbi as never, sign, pay, holderDid: 'did:zid:h' },
    createAccount,
    saveAccount,
  }
  return { deps, wallet, makeWallet, payer, mbi, sign, pay, createAccount, saveAccount }
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
    expect(sentData[0].templateId).toBe('did:zid:d6b783559acf6ba0f7ef6e1365bdaf0774d622d8d22728ca6323677f49ee94f8')
  })

  it('subscribe_and_issue resolves the alias to the mainnet id when configured for mainnet', async () => {
    const { deps, mbi } = makeDeps()
    deps.config.network = 'zetrix:mainnet'
    await createTools(deps).subscribe_and_issue({ templateId: 'birth cert', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].templateId).toBe('did:zid:032cb99be3577beccfc6252783c49c83673af38f8456d73462043654d7764e83')
  })

  it('subscribe_and_issue passes a raw did:zid:... templateId through unchanged', async () => {
    const { deps, mbi } = makeDeps()
    await createTools(deps).subscribe_and_issue({ templateId: 'did:zid:t', attributes: { name: 'x' } })
    const sentData = JSON.parse((mbi.applyChallenge.mock.calls[0][0] as { data: string }).data)
    expect(sentData[0].templateId).toBe('did:zid:t')
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
})
