import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountOwnershipError,
  accountFileName,
  createAccountFiles,
  createNetworkAccountStore,
  explainHolderFailure,
  networkSlug,
  otherNetwork,
  probeOwnership,
  readAccountForExport,
  resolveNetworkAccount,
  type Ownership,
} from '../account-resolution'
import { WalletBeError } from '../clients/wallet-be-client'
import type { StoredAccount } from '../clients/account-store'

const TESTNET = 'zetrix:testnet'
const MAINNET = 'zetrix:mainnet'

const legacyAccount: StoredAccount = {
  zetrixAddress: 'ZTX3Legacy', holderDid: 'did:zid:legacy', hsmPassword: 'pw-legacy', createdAt: '2026-10-13T09:09:00Z',
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'account-resolution-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const put = (name: string, account: StoredAccount) => writeFileSync(join(dir, name), JSON.stringify(account))
const has = (name: string) => existsSync(join(dir, name))
const readJson = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as StoredAccount

/** A probe whose answer per network is scripted; records every call so a test can prove a network was never asked. */
function scriptedProbe(answers: Partial<Record<string, Ownership>>) {
  return vi.fn(async (network: string) => answers[network] ?? 'unknown')
}

function deps(answers: Partial<Record<string, Ownership>>) {
  const probe = scriptedProbe(answers)
  const log = vi.fn()
  return { probe, log, deps: { files: createAccountFiles(dir), probe, log } }
}

describe('file naming', () => {
  it('keeps one file per network, named after the network', () => {
    expect(accountFileName(TESTNET)).toBe('account.testnet.json')
    expect(accountFileName(MAINNET)).toBe('account.mainnet.json')
  })

  it('never lets a network string escape the state directory', () => {
    expect(networkSlug('zetrix:../../etc')).not.toContain('/')
    expect(networkSlug('zetrix:../../etc')).not.toContain('.')
  })

  it('pairs the two known networks and nothing else', () => {
    expect(otherNetwork(TESTNET)).toBe(MAINNET)
    expect(otherNetwork(MAINNET)).toBe(TESTNET)
    expect(otherNetwork('zetrix:devnet')).toBeUndefined()
  })
})

describe('probeOwnership: asking a Wallet BE whether it knows an account', () => {
  const account = legacyAccount

  it('says the account is owned when Wallet BE signs for it', async () => {
    const sign = vi.fn().mockResolvedValue({ signBlob: 'x', publicKey: 'y' })
    expect(await probeOwnership(sign, account)).toBe('owns')
    expect(sign).toHaveBeenCalledWith(account.zetrixAddress, account.zetrixAddress, account.hsmPassword)
  })

  it('says not provisioned only for Wallet BE error 1000026', async () => {
    const sign = vi.fn().mockRejectedValue(new WalletBeError('Wallet BE /wallet/hsm/sign-message errorCode 1000026', 1000026))
    expect(await probeOwnership(sign, account)).toBe('not_provisioned')
  })

  it('says unknown for any other Wallet BE error, so an outage is never read as "not mine"', async () => {
    const sign = vi.fn().mockRejectedValue(new WalletBeError('Wallet BE returned errorCode 5000', 5000))
    expect(await probeOwnership(sign, account)).toBe('unknown')
  })

  it('says unknown when Wallet BE cannot be reached at all', async () => {
    const sign = vi.fn().mockRejectedValue(new WalletBeError('Wallet BE request failed', undefined, new Error('ECONNREFUSED')))
    expect(await probeOwnership(sign, account)).toBe('unknown')
  })

  it('says unknown for an error that is not a Wallet BE error', async () => {
    const sign = vi.fn().mockRejectedValue(new Error('boom'))
    expect(await probeOwnership(sign, account)).toBe('unknown')
  })
})

describe('resolveNetworkAccount', () => {
  it('uses the saved account for the configured network and asks no Wallet BE anything', async () => {
    put('account.mainnet.json', { ...legacyAccount, zetrixAddress: 'ZTX3Main', network: MAINNET })
    const { probe, deps: d } = deps({})

    const r = await resolveNetworkAccount(d, MAINNET)

    expect(r).toMatchObject({ kind: 'saved', source: 'network', fileName: 'account.mainnet.json' })
    expect(r.kind === 'saved' && r.account.zetrixAddress).toBe('ZTX3Main')
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports nothing saved, so a new account is created, on a fresh install', async () => {
    const { probe, deps: d } = deps({})
    expect(await resolveNetworkAccount(d, TESTNET)).toEqual({ kind: 'none' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('adopts an old account.json for the configured network when that Wallet BE knows it, and leaves the old file alone', async () => {
    put('account.json', legacyAccount)
    const { probe, deps: d } = deps({ [TESTNET]: 'owns' })

    const r = await resolveNetworkAccount(d, TESTNET)

    expect(r).toMatchObject({ kind: 'saved', source: 'adopted', fileName: 'account.testnet.json' })
    expect(readJson('account.testnet.json')).toMatchObject({ zetrixAddress: 'ZTX3Legacy', network: TESTNET })
    expect(readJson('account.json')).toEqual(legacyAccount)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('gives the old account to the OTHER network when only that Wallet BE knows it, and asks for a new account here', async () => {
    put('account.json', legacyAccount)
    const { probe, deps: d } = deps({ [MAINNET]: 'not_provisioned', [TESTNET]: 'owns' })

    const r = await resolveNetworkAccount(d, MAINNET)

    expect(r).toEqual({ kind: 'none' })
    expect(readJson('account.testnet.json')).toMatchObject({ zetrixAddress: 'ZTX3Legacy', network: TESTNET })
    expect(has('account.mainnet.json')).toBe(false)
    expect(readJson('account.json')).toEqual(legacyAccount)
    expect(probe.mock.calls.map((c) => c[0])).toEqual([MAINNET, TESTNET])
  })

  it('creates nothing and says so when neither Wallet BE knows the old account', async () => {
    put('account.json', legacyAccount)
    const { deps: d } = deps({ [MAINNET]: 'not_provisioned', [TESTNET]: 'not_provisioned' })

    await expect(resolveNetworkAccount(d, MAINNET)).rejects.toBeInstanceOf(AccountOwnershipError)
    expect(has('account.mainnet.json')).toBe(false)
    expect(has('account.testnet.json')).toBe(false)
  })

  it('creates nothing when the configured network cannot be checked (an outage must not mint a second account)', async () => {
    put('account.json', legacyAccount)
    const { probe, deps: d } = deps({ [MAINNET]: 'unknown', [TESTNET]: 'owns' })

    await expect(resolveNetworkAccount(d, MAINNET)).rejects.toBeInstanceOf(AccountOwnershipError)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(has('account.testnet.json')).toBe(false)
  })

  it('creates nothing when the old account is not on this network and the other network cannot be checked', async () => {
    put('account.json', legacyAccount)
    const { deps: d } = deps({ [MAINNET]: 'not_provisioned', [TESTNET]: 'unknown' })

    await expect(resolveNetworkAccount(d, MAINNET)).rejects.toBeInstanceOf(AccountOwnershipError)
    expect(has('account.testnet.json')).toBe(false)
  })

  it('ignores an old account.json that a network file has already claimed', async () => {
    put('account.json', legacyAccount)
    put('account.testnet.json', { ...legacyAccount, network: TESTNET })
    const { probe, deps: d } = deps({})

    expect(await resolveNetworkAccount(d, MAINNET)).toEqual({ kind: 'none' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('refuses to guess for a network it has no pair for', async () => {
    put('account.json', legacyAccount)
    const { deps: d } = deps({ 'zetrix:devnet': 'not_provisioned' })

    await expect(resolveNetworkAccount(d, 'zetrix:devnet')).rejects.toBeInstanceOf(AccountOwnershipError)
  })

  it('keeps both accounts across switches: testnet adopted first, then a new mainnet one, then back', async () => {
    put('account.json', legacyAccount)
    const first = deps({ [TESTNET]: 'owns' })
    expect((await resolveNetworkAccount(first.deps, TESTNET)).kind).toBe('saved')

    const onMainnet = deps({})
    expect(await resolveNetworkAccount(onMainnet.deps, MAINNET)).toEqual({ kind: 'none' })
    await createNetworkAccountStore(createAccountFiles(dir), MAINNET).set({
      zetrixAddress: 'ZTX3Main', holderDid: 'did:zid:main', hsmPassword: 'pw-main', createdAt: '2026-10-22T00:00:00Z',
    })

    const back = deps({})
    const r = await resolveNetworkAccount(back.deps, TESTNET)
    expect(r.kind === 'saved' && r.account.zetrixAddress).toBe('ZTX3Legacy')
    expect(back.probe).not.toHaveBeenCalled()
    expect(readJson('account.mainnet.json')).toMatchObject({ zetrixAddress: 'ZTX3Main', network: MAINNET })
  })

  it('names the account, the networks and what was not done, in the refusal', async () => {
    put('account.json', legacyAccount)
    const { deps: d } = deps({ [MAINNET]: 'not_provisioned', [TESTNET]: 'not_provisioned' })

    const err = await resolveNetworkAccount(d, MAINNET).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(AccountOwnershipError)
    expect(err.message).toContain('ZTX3Legacy')
    expect(err.message).toMatch(/mainnet/)
    expect(err.message).toMatch(/testnet/)
    expect(err.message).toMatch(/no (new )?account was created/i)
    expect(err.message).not.toContain('pw-legacy')
  })
})

describe('createNetworkAccountStore', () => {
  it('writes to the network file and records the network inside it', async () => {
    const store = createNetworkAccountStore(createAccountFiles(dir), MAINNET)
    await store.set({ zetrixAddress: 'ZTX3Main', holderDid: 'did:zid:main', hsmPassword: 'pw', createdAt: 'now' })

    expect(readJson('account.mainnet.json')).toMatchObject({ zetrixAddress: 'ZTX3Main', network: MAINNET })
    expect(has('account.json')).toBe(false)
    expect(await store.get()).toMatchObject({ zetrixAddress: 'ZTX3Main' })
  })

  it('does not read the other network\'s account', async () => {
    put('account.testnet.json', { ...legacyAccount, network: TESTNET })
    expect(await createNetworkAccountStore(createAccountFiles(dir), MAINNET).get()).toBeNull()
  })
})

describe('readAccountForExport', () => {
  it('exports the configured network\'s account', async () => {
    put('account.mainnet.json', { ...legacyAccount, zetrixAddress: 'ZTX3Main', network: MAINNET })
    const a = await readAccountForExport(createAccountFiles(dir), MAINNET)
    expect(a?.account.zetrixAddress).toBe('ZTX3Main')
    expect(a?.legacy).toBe(false)
  })

  it('falls back to an old account.json when the network has none', async () => {
    put('account.json', legacyAccount)
    const a = await readAccountForExport(createAccountFiles(dir), MAINNET)
    expect(a?.account.zetrixAddress).toBe('ZTX3Legacy')
    expect(a?.fileName).toBe('account.json')
    expect(a?.legacy).toBe(true)
  })

  it('returns nothing when there is nothing to export', async () => {
    expect(await readAccountForExport(createAccountFiles(dir), MAINNET)).toBeNull()
  })
})

describe('explainHolderFailure: the start-up error when Wallet BE does not know the account', () => {
  const notProvisioned = new WalletBeError(
    'Wallet BE /wallet/hsm/sign-message errorCode 1000026: HSM service call failed — this usually means ZETRIX_ADDRESS is not a provisioned HSM account',
    1000026,
  )

  it('names the network and the Wallet BE it asked, and says an account may belong to the other network', () => {
    const e = explainHolderFailure(notProvisioned, { address: 'ZTX3Old', network: MAINNET, walletBeUrl: 'https://wallet-api.zetrix.com/server' })

    expect(e.message).toContain('ZTX3Old')
    expect(e.message).toContain('zetrix:mainnet')
    expect(e.message).toContain('https://wallet-api.zetrix.com/server')
    expect(e.message).toMatch(/other network/i)
    expect(e.message).toContain('1000026')
  })

  it('leaves every other failure untouched', () => {
    const other = new WalletBeError('Wallet BE request failed', undefined, new Error('ECONNREFUSED'))
    expect(explainHolderFailure(other, { address: 'ZTX3Old', network: MAINNET, walletBeUrl: 'u' })).toBe(other)
    const plain = new Error('boom')
    expect(explainHolderFailure(plain, { address: 'ZTX3Old', network: MAINNET, walletBeUrl: 'u' })).toBe(plain)
  })
})
