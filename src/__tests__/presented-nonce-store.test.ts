import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsPresentedNonceStore } from '../clients/presented-nonce-store'

/** The challenges this wallet has answered: each nonce is answered once, across wallet processes. */
describe('presented nonce store', () => {
  const dirs: string[] = []
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
  })
  async function freshDir(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'nonce-store-'))
    dirs.push(base)
    return join(base, 'presented-nonces')
  }
  const hashOf = (nonce: string) => createHash('sha256').update(nonce, 'utf8').digest('hex')

  it('claims a nonce once, and refuses a second claim of it', async () => {
    const store = createFsPresentedNonceStore(await freshDir())
    expect(await store.claim('nonce-1')).toBe(true)
    expect(await store.claim('nonce-1')).toBe(false)
    expect(await store.claim('nonce-2')).toBe(true)
  })

  it('remembers across instances (a new process reads the same directory)', async () => {
    const dir = await freshDir()
    expect(await createFsPresentedNonceStore(dir).claim('nonce-1')).toBe(true)
    expect(await createFsPresentedNonceStore(dir).claim('nonce-1')).toBe(false)
  })

  it('lets exactly one of many wallet PROCESSES claiming the same nonce at once win (separate stores, one shared directory)', async () => {
    const dir = await freshDir()
    const processes = Array.from({ length: 12 }, () => createFsPresentedNonceStore(dir))
    const results = await Promise.all(processes.map((p) => p.claim('nonce-race')))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('lets exactly one of many simultaneous claims within one store win', async () => {
    const store = createFsPresentedNonceStore(await freshDir())
    const results = await Promise.all(Array.from({ length: 25 }, () => store.claim('nonce-race')))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('does not let one process erase another process\'s claim of a DIFFERENT nonce', async () => {
    const dir = await freshDir()
    const a = createFsPresentedNonceStore(dir)
    const b = createFsPresentedNonceStore(dir)
    await Promise.all([a.claim('only-a'), b.claim('only-b')])
    expect(await createFsPresentedNonceStore(dir).claim('only-a')).toBe(false)
    expect(await createFsPresentedNonceStore(dir).claim('only-b')).toBe(false)
  })

  it('gives a claim back with release, and releasing what is not claimed is fine', async () => {
    const store = createFsPresentedNonceStore(await freshDir())
    await store.claim('nonce-1')
    await store.release('nonce-1')
    expect(await store.claim('nonce-1')).toBe(true)
    await expect(store.release('never-claimed')).resolves.toBeUndefined()
  })

  it('forgets a claim after the time to live, once a sweep has removed it, and not before', async () => {
    let now = 1_000_000
    const store = createFsPresentedNonceStore(await freshDir(), { ttlMs: 60_000, now: () => now, sweepEvery: 1 })
    expect(await store.claim('nonce-1')).toBe(true)
    now += 59_000
    expect(await store.claim('other-1')).toBe(true) // sweeps: nonce-1 is still within its time
    expect(await store.claim('nonce-1')).toBe(false)
    now += 2_000
    expect(await store.claim('other-2')).toBe(true) // sweeps: nonce-1 is now expired and goes
    expect(await store.claim('nonce-1')).toBe(true)
  })

  it('an expired claim that has not been swept yet still refuses the same nonce: nothing replaces a claim on the claim path', async () => {
    let now = 1_000_000
    const store = createFsPresentedNonceStore(await freshDir(), { ttlMs: 1_000, now: () => now, sweepEvery: 1_000_000 })
    await store.claim('nonce-1') // the first claim sweeps; the next sweep is a million claims away
    now += 5_000
    expect(await store.claim('nonce-1')).toBe(false)
  })

  it('two processes finding the same claim old cannot both win it', async () => {
    let now = 1_000_000
    const dir = await freshDir()
    const a = createFsPresentedNonceStore(dir, { ttlMs: 1_000, now: () => now, sweepEvery: 1_000_000 })
    const b = createFsPresentedNonceStore(dir, { ttlMs: 1_000, now: () => now, sweepEvery: 1_000_000 })
    await a.claim('nonce-1')
    now += 5_000
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).claim('nonce-1')))
    expect(results.filter(Boolean)).toHaveLength(0)
  })

  it('sweeps expired claims, and past the cap the oldest ones, from the directory', async () => {
    let now = 1_000
    const dir = await freshDir()
    const store = createFsPresentedNonceStore(dir, { maxEntries: 3, ttlMs: 10_000_000, now: () => now, sweepEvery: 1 })
    for (const n of ['a', 'b', 'c', 'd', 'e']) {
      await store.claim(n)
      now += 10
    }
    const kept = (await readdir(dir)).sort()
    expect(kept).toHaveLength(3)
    expect(kept).toEqual([hashOf('c'), hashOf('d'), hashOf('e')].sort())
    // an expired claim is swept even though nothing claims it again
    now += 20_000_000
    await store.claim('f')
    expect(await readdir(dir)).toEqual([hashOf('f')])
  })

  it('stores only a hash of the nonce, named by it, with the time as content', async () => {
    const dir = await freshDir()
    await createFsPresentedNonceStore(dir, { now: () => 1_234_567 }).claim('super-secret-looking-nonce-value')
    const files = await readdir(dir)
    expect(files).toEqual([hashOf('super-secret-looking-nonce-value')])
    const text = await readFile(join(dir, files[0]), 'utf8')
    expect(text).toBe('1234567')
    expect(files.join() + text).not.toContain('super-secret-looking-nonce-value')
  })

  it.skipIf(process.platform === 'win32')('creates the claim with owner-only permissions, in an owner-only directory', async () => {
    const dir = await freshDir()
    await createFsPresentedNonceStore(dir).claim('nonce-1')
    expect((await stat(join(dir, hashOf('nonce-1')))).mode & 0o777).toBe(0o600)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('leaves nothing but claim files in the directory', async () => {
    const dir = await freshDir()
    const store = createFsPresentedNonceStore(dir)
    await store.claim('a')
    await store.claim('b')
    await store.release('a')
    expect(await readdir(dir)).toEqual([hashOf('b')])
  })

  it('treats a claim file whose content is not a time as a LIVE claim, never as an absent one', async () => {
    const dir = await freshDir()
    const store = createFsPresentedNonceStore(dir)
    await store.claim('nonce-1')
    await writeFile(join(dir, hashOf('nonce-1')), 'garbage')
    expect(await store.claim('nonce-1')).toBe(false)
    await writeFile(join(dir, hashOf('nonce-1')), '')
    expect(await store.claim('nonce-1')).toBe(false)
  })

  it('fails closed when the claim cannot be created for a reason other than it existing', async () => {
    const dir = await freshDir()
    // a plain file where the directory should be: the claim can be neither created nor trusted
    await writeFile(join(dir, '..', 'presented-nonces'), 'not a directory')
    await expect(createFsPresentedNonceStore(dir).claim('nonce-1')).rejects.toThrow()
  })

  it('names the path when a claim cannot be created', async () => {
    const dir = await freshDir()
    await writeFile(join(dir, '..', 'presented-nonces'), 'not a directory')
    await expect(createFsPresentedNonceStore(dir).claim('nonce-1')).rejects.toThrow(/presented-nonce claim|ENOTDIR|EEXIST|not a directory/i)
  })
})
