import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsAccountStore } from '../clients/account-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'account-store-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createFsAccountStore', () => {
  it('returns null when no account has been saved yet', async () => {
    const store = createFsAccountStore(join(dir, 'account.json'))
    expect(await store.get()).toBeNull()
  })

  it('round-trips a saved account (including its password) through set/get', async () => {
    const store = createFsAccountStore(join(dir, 'account.json'))
    const account = {
      zetrixAddress: 'ZTX3New', holderDid: 'did:zid:new', hsmPassword: 'pw123456',
      label: 'agent', purpose: 'onboarding', createdAt: '2026-07-24T00:00:00Z',
    }
    await store.set(account)
    expect(await store.get()).toEqual(account)
  })

  it('overwrites a previously saved account', async () => {
    const store = createFsAccountStore(join(dir, 'account.json'))
    await store.set({ zetrixAddress: 'ZTX3Old', holderDid: 'did:zid:old', hsmPassword: 'pwOld', createdAt: '2026-01-01T00:00:00Z' })
    await store.set({ zetrixAddress: 'ZTX3New', holderDid: 'did:zid:new', hsmPassword: 'pwNew', createdAt: '2026-07-24T00:00:00Z' })
    expect(await store.get()).toMatchObject({ zetrixAddress: 'ZTX3New', holderDid: 'did:zid:new', hsmPassword: 'pwNew' })
  })

  it('creates the parent directory if it does not exist yet', async () => {
    const store = createFsAccountStore(join(dir, 'nested', 'dir', 'account.json'))
    await store.set({ zetrixAddress: 'ZTX3New', holderDid: 'did:zid:new', hsmPassword: 'pw123456', createdAt: '2026-07-24T00:00:00Z' })
    expect(await store.get()).toMatchObject({ zetrixAddress: 'ZTX3New' })
  })

  it('treats a saved account missing hsmPassword as no stored account (pre-upgrade file shape)', async () => {
    const filePath = join(dir, 'account.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ zetrixAddress: 'ZTX3Old', holderDid: 'did:zid:old', createdAt: '2026-01-01T00:00:00Z' }))
    const store = createFsAccountStore(filePath)
    expect(await store.get()).toBeNull()
  })

  it('treats a corrupt/truncated file as no stored account rather than throwing', async () => {
    const filePath = join(dir, 'account.json')
    writeFileSync(filePath, '{not valid json')
    const store = createFsAccountStore(filePath)
    expect(await store.get()).toBeNull()
  })

  it('treats a well-formed but wrong-shaped JSON file as no stored account', async () => {
    const filePath = join(dir, 'account.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ foo: 'bar' }))
    const store = createFsAccountStore(filePath)
    expect(await store.get()).toBeNull()
  })
})
