import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireCreationLock, createFsCreationLock, CreationLockTimeoutError, type CreationLockDeps } from '../account-lock'
import type { StoredAccount } from '../clients/account-store'

const account: StoredAccount = { zetrixAddress: 'ZTX3First', holderDid: 'did:zid:first', hsmPassword: 'pw', createdAt: 'now' }

/** In-memory lock deps whose clock only moves when sleep is called, so no test waits in real time. */
function fakeDeps(opts: { lockTaken?: boolean; lockAgeMs?: number; accountAppearsAfterSleeps?: number } = {}) {
  const state = { lockTaken: opts.lockTaken ?? false, sleeps: 0, removed: 0, created: 0 }
  const deps: CreationLockDeps = {
    tryCreate: async () => {
      if (state.lockTaken) return false
      state.lockTaken = true
      state.created++
      return true
    },
    ageMs: async () => (state.lockTaken ? (opts.lockAgeMs ?? 1000) : null),
    remove: async () => { state.lockTaken = false; state.removed++ },
    readAccount: async () =>
      opts.accountAppearsAfterSleeps !== undefined && state.sleeps >= opts.accountAppearsAfterSleeps ? account : null,
    sleep: async () => { state.sleeps++ },
  }
  return { deps, state }
}

describe('acquireCreationLock', () => {
  it('hands the lock to the first process, which creates the account', async () => {
    const { deps, state } = fakeDeps()
    const lock = await acquireCreationLock(deps, { lockName: 'account.mainnet.json.lock' })

    expect(lock.kind).toBe('acquired')
    expect(state.created).toBe(1)
    if (lock.kind === 'acquired') {
      await lock.release()
      expect(state.lockTaken).toBe(false)
    }
  })

  it('makes a second process wait for the first one\'s account and use it, instead of creating another', async () => {
    const { deps, state } = fakeDeps({ lockTaken: true, accountAppearsAfterSleeps: 3 })
    const lock = await acquireCreationLock(deps, { lockName: 'x', pollMs: 100 })

    expect(lock).toEqual({ kind: 'found', account })
    expect(state.sleeps).toBe(3)
    expect(state.created).toBe(0)
  })

  it('uses an account that already exists without taking the lock at all', async () => {
    const { deps, state } = fakeDeps({ accountAppearsAfterSleeps: 0 })
    expect(await acquireCreationLock(deps, { lockName: 'x' })).toEqual({ kind: 'found', account })
    expect(state.created).toBe(0)
  })

  it('removes a lock left behind by a process that died, and takes it', async () => {
    const { deps, state } = fakeDeps({ lockTaken: true, lockAgeMs: 10 * 60_000 })
    const lock = await acquireCreationLock(deps, { lockName: 'x', staleMs: 120_000 })

    expect(lock.kind).toBe('acquired')
    expect(state.removed).toBe(1)
  })

  it('does not take a fresh lock that another process still holds', async () => {
    const { deps } = fakeDeps({ lockTaken: true, lockAgeMs: 1000 })
    await expect(acquireCreationLock(deps, { lockName: 'account.mainnet.json.lock', pollMs: 1000, waitMs: 3000 })).rejects.toBeInstanceOf(
      CreationLockTimeoutError,
    )
  })

  it('names the lock file in the timeout message so it can be deleted by hand', async () => {
    const { deps } = fakeDeps({ lockTaken: true })
    const err = await acquireCreationLock(deps, { lockName: 'account.mainnet.json.lock', pollMs: 1000, waitMs: 1000 }).catch((e: unknown) => e as Error)
    expect(err.message).toContain('account.mainnet.json.lock')
  })
})

describe('createFsCreationLock (real files)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'account-lock-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const noAccount = async () => null
  const noSleep = async () => {}

  it('creates the lock exclusively: the second try fails while the first holds it', async () => {
    const lockPath = join(dir, 'a.lock')
    const a = createFsCreationLock(lockPath, noAccount, noSleep)
    const b = createFsCreationLock(lockPath, noAccount, noSleep)

    expect(await a.tryCreate()).toBe(true)
    expect(await b.tryCreate()).toBe(false)
    await a.remove()
    expect(existsSync(lockPath)).toBe(false)
    expect(await b.tryCreate()).toBe(true)
  })

  it('reports no age when the lock is absent and a real age when it is present', async () => {
    const lockPath = join(dir, 'a.lock')
    const l = createFsCreationLock(lockPath, noAccount, noSleep)
    expect(await l.ageMs()).toBeNull()

    await l.tryCreate()
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(lockPath, old, old)
    expect(await l.ageMs()).toBeGreaterThan(4 * 60_000)
  })

  it('removing a lock that is not there is not an error', async () => {
    await expect(createFsCreationLock(join(dir, 'none.lock'), noAccount, noSleep).remove()).resolves.toBeUndefined()
  })
})
