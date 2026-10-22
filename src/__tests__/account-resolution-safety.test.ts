import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AccountOwnershipError,
  createAccountFiles,
  createNetworkAccountStore,
  probeOwnership,
  resolveNetworkAccount,
  type Ownership,
} from '../account-resolution'
import type { StoredAccount } from '../clients/account-store'

/**
 * Review findings on the first version of the per-network account change. An account file may hold the only
 * copy of an account's signing password, so none of these paths may replace, or guess at, a file it has not read.
 */

const TESTNET = 'zetrix:testnet'
const MAINNET = 'zetrix:mainnet'

const legacyAccount: StoredAccount = {
  zetrixAddress: 'ZTX3Legacy', holderDid: 'did:zid:legacy', hsmPassword: 'pw-legacy', createdAt: '2026-10-13T09:09:00Z',
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'account-safety-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const put = (name: string, account: StoredAccount) => writeFileSync(join(dir, name), JSON.stringify(account))
const has = (name: string) => existsSync(join(dir, name))
const readJson = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as StoredAccount
const probeFor = (answers: Partial<Record<string, Ownership>>) => vi.fn(async (network: string) => answers[network] ?? 'unknown')

describe('never writes where a different account already is', () => {
  const mainnetOwn: StoredAccount = { zetrixAddress: 'ZTX3M2', holderDid: 'did:zid:m2', hsmPassword: 'pw-m2', createdAt: 'y', network: MAINNET }

  it('stops, and leaves both accounts as they were, when the other network\'s file already holds a different account', async () => {
    put('account.json', legacyAccount)
    put('account.mainnet.json', mainnetOwn)
    // testnet does not know the old account and mainnet does: it would be placed in account.mainnet.json
    const probe = probeFor({ [TESTNET]: 'not_provisioned', [MAINNET]: 'owns' })

    const err = await resolveNetworkAccount({ files: createAccountFiles(dir), probe }, TESTNET).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(AccountOwnershipError)
    expect(readJson('account.mainnet.json')).toEqual(mainnetOwn)
    expect(readJson('account.json')).toEqual(legacyAccount)
    expect(err.message).toContain('ZTX3Legacy')
    expect(err.message).toContain('ZTX3M2')
    expect(err.message).toContain('account.mainnet.json')
    expect(err.message).toMatch(/nothing was written/i)
    expect(err.message).not.toContain('pw-m2')
    expect(err.message).not.toContain('pw-legacy')
  })

  it('stops, and writes nothing, when the other network\'s file appears between the check and the write', async () => {
    put('account.json', legacyAccount)
    const files = createAccountFiles(dir)
    const racing = { ...files, createExclusive: vi.fn(async () => false) }

    await expect(
      resolveNetworkAccount({ files: racing, probe: probeFor({ [TESTNET]: 'not_provisioned', [MAINNET]: 'owns' }) }, TESTNET),
    ).rejects.toBeInstanceOf(AccountOwnershipError)
    expect(has('account.mainnet.json')).toBe(false)
  })

  it('uses the account another process placed for this network while this one was checking', async () => {
    put('account.json', legacyAccount)
    const files = createAccountFiles(dir)
    const winner: StoredAccount = { ...legacyAccount, zetrixAddress: 'ZTX3Other', network: TESTNET }
    const racing = {
      ...files,
      createExclusive: vi.fn(async (name: string) => { put(name, winner); return false }),
    }

    const r = await resolveNetworkAccount({ files: racing, probe: probeFor({ [TESTNET]: 'owns' }) }, TESTNET)

    expect(r.kind === 'saved' && r.account.zetrixAddress).toBe('ZTX3Other')
  })

  it('still places an old account for the other network when that file does not exist yet', async () => {
    put('account.json', legacyAccount)
    const probe = probeFor({ [TESTNET]: 'not_provisioned', [MAINNET]: 'owns' })

    expect(await resolveNetworkAccount({ files: createAccountFiles(dir), probe }, TESTNET)).toEqual({ kind: 'none' })
    expect(readJson('account.mainnet.json')).toMatchObject({ zetrixAddress: 'ZTX3Legacy', network: MAINNET })
  })
})

describe('a file that is there but cannot be read is a stop, not "no account"', () => {
  const corrupt = (name: string) => writeFileSync(join(dir, name), '{ this is not json')

  it('stops for a corrupt file for the configured network, creates nothing, and leaves the file as it was', async () => {
    corrupt('account.mainnet.json')
    const probe = probeFor({})

    const err = await resolveNetworkAccount({ files: createAccountFiles(dir), probe }, MAINNET).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(AccountOwnershipError)
    expect(err.message).toContain('account.mainnet.json')
    expect(err.message).toMatch(/not valid JSON/)
    expect(err.message).toMatch(/no new account was created/i)
    expect(probe).not.toHaveBeenCalled()
    expect(readFileSync(join(dir, 'account.mainnet.json'), 'utf8')).toBe('{ this is not json')
  })

  it('stops for a corrupt old account.json', async () => {
    corrupt('account.json')
    await expect(resolveNetworkAccount({ files: createAccountFiles(dir), probe: probeFor({}) }, MAINNET)).rejects.toBeInstanceOf(AccountOwnershipError)
  })

  it('stops for a file with the wrong shape, such as one with no password', async () => {
    writeFileSync(join(dir, 'account.mainnet.json'), JSON.stringify({ zetrixAddress: 'ZTX3', holderDid: 'd' }))
    await expect(resolveNetworkAccount({ files: createAccountFiles(dir), probe: probeFor({}) }, MAINNET)).rejects.toThrow(/no address, DID or password/)
  })

  it('stops when the other network\'s file cannot be read while an old account is being placed, before asking any Wallet BE', async () => {
    put('account.json', legacyAccount)
    corrupt('account.testnet.json')
    const probe = probeFor({})

    await expect(resolveNetworkAccount({ files: createAccountFiles(dir), probe }, MAINNET)).rejects.toBeInstanceOf(AccountOwnershipError)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('the network recorded inside a file is checked', () => {
  it('stops when account.mainnet.json says its account belongs to testnet', async () => {
    put('account.mainnet.json', { ...legacyAccount, network: TESTNET })

    const err = await resolveNetworkAccount({ files: createAccountFiles(dir), probe: probeFor({}) }, MAINNET).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(AccountOwnershipError)
    expect(err.message).toContain('belongs to zetrix:testnet')
    expect(err.message).toContain('account.testnet.json')
  })

  it('accepts a network file that records no network (placed by hand)', async () => {
    put('account.mainnet.json', legacyAccount)
    expect((await resolveNetworkAccount({ files: createAccountFiles(dir), probe: probeFor({}) }, MAINNET)).kind).toBe('saved')
  })
})

describe('the refusal tells the user how to go on', () => {
  it('says to move account.json aside to start with a new account when neither network has the old one', async () => {
    put('account.json', legacyAccount)
    const probe = probeFor({ [MAINNET]: 'not_provisioned', [TESTNET]: 'not_provisioned' })

    const err = await resolveNetworkAccount({ files: createAccountFiles(dir), probe }, MAINNET).catch((e: unknown) => e as Error)

    expect(err.message).toMatch(/move account\.json aside \(keep a copy\)/)
    expect(err.message).toMatch(/sandbox reset/)
    expect(err.message).not.toMatch(/check the connection/i)
  })

  it('says to check the connection when a Wallet BE could not be asked', async () => {
    put('account.json', legacyAccount)
    const err = await resolveNetworkAccount({ files: createAccountFiles(dir), probe: probeFor({ [MAINNET]: 'unknown' }) }, MAINNET).catch(
      (e: unknown) => e as Error,
    )
    expect(err.message).toMatch(/check the connection/i)
  })
})

describe('probeOwnership does not wait for ever', () => {
  it('says unknown when Wallet BE does not answer in time', async () => {
    const never = vi.fn(() => new Promise<never>(() => {}))
    expect(await probeOwnership(never, legacyAccount, 20)).toBe('unknown')
  })

  it('still answers at once when Wallet BE is quick', async () => {
    expect(await probeOwnership(vi.fn().mockResolvedValue({}), legacyAccount, 5000)).toBe('owns')
  })
})

describe('writing a network file never silently replaces a different account', () => {
  it('keeps the old content beside the file when an overwrite changes the account', async () => {
    const store = createNetworkAccountStore(createAccountFiles(dir), MAINNET)
    await store.set({ zetrixAddress: 'ZTX3First', holderDid: 'did:zid:1', hsmPassword: 'pw-first', createdAt: 'a' })
    await store.set({ zetrixAddress: 'ZTX3Second', holderDid: 'did:zid:2', hsmPassword: 'pw-second', createdAt: 'b' })

    expect(readJson('account.mainnet.json').zetrixAddress).toBe('ZTX3Second')
    const kept = readdirSync(dir).filter((n) => n.startsWith('account.mainnet.json.replaced-'))
    expect(kept).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, kept[0]), 'utf8')).hsmPassword).toBe('pw-first')
  })

  it('makes no copy when the same account is saved again', async () => {
    const store = createNetworkAccountStore(createAccountFiles(dir), MAINNET)
    const acct = { zetrixAddress: 'ZTX3First', holderDid: 'did:zid:1', hsmPassword: 'pw', createdAt: 'a' }
    await store.set(acct)
    await store.set(acct)
    expect(readdirSync(dir).filter((n) => n.includes('.replaced-'))).toHaveLength(0)
  })

  it('creates a file exclusively, and says so when it was already there', async () => {
    const files = createAccountFiles(dir)
    expect(await files.createExclusive('account.testnet.json', legacyAccount)).toBe(true)
    expect(await files.createExclusive('account.testnet.json', { ...legacyAccount, zetrixAddress: 'ZTX3Other' })).toBe(false)
    expect(readJson('account.testnet.json').zetrixAddress).toBe('ZTX3Legacy')
  })
})
