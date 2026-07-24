import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsVcCache, isVcValid, extractValidUntil } from '../clients/vc-cache'

/** Mirrors the module's private cacheFileName() so tests can plant a raw file at the same path. */
function cacheFileNameFor(id: string): string {
  return `${createHash('sha256').update(id).digest('hex')}.json`
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-cache-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const templateId = 'did:zid:c042e49e55ffe1b0ee835e6a8b3d1aec720fb1cb01dca17c4b3e5c2194949a6c'

describe('createFsVcCache', () => {
  it('returns null for a templateId never cached', async () => {
    const cache = createFsVcCache(dir)
    expect(await cache.get(templateId)).toBeNull()
  })

  it('round-trips a cached entry through set/get', async () => {
    const cache = createFsVcCache(dir)
    const entry = { templateId, vc: { id: 'did:zid:vc' }, vcId: 'vc-1', txHash: '0xabc', issuedAt: '2026-07-23T00:00:00Z', validUntil: '2027-07-16T00:00:00Z' }
    await cache.set(templateId, entry)
    expect(await cache.get(templateId)).toEqual(entry)
  })

  it('handles templateId containing colons (did:zid:...) safely as a filename', async () => {
    const cache = createFsVcCache(dir)
    await cache.set(templateId, { templateId, vc: {}, issuedAt: '2026-07-23T00:00:00Z' })
    // Shouldn't throw, and a second distinct templateId must not collide.
    const other = 'did:zid:another-template-id'
    await cache.set(other, { templateId: other, vc: { marker: 'other' }, issuedAt: '2026-07-23T00:00:00Z' })
    expect(await cache.get(templateId)).not.toBeNull()
    expect(await cache.get(other)).toMatchObject({ vc: { marker: 'other' } })
  })

  it('list() returns every cached entry', async () => {
    const cache = createFsVcCache(dir)
    await cache.set('did:zid:a', { templateId: 'did:zid:a', vc: {}, issuedAt: '2026-07-23T00:00:00Z' })
    await cache.set('did:zid:b', { templateId: 'did:zid:b', vc: {}, issuedAt: '2026-07-23T00:00:00Z' })
    const all = await cache.list()
    expect(all).toHaveLength(2)
    expect(all.map((e) => e.templateId).sort()).toEqual(['did:zid:a', 'did:zid:b'])
  })

  it('list() returns [] when the cache directory does not exist yet', async () => {
    const cache = createFsVcCache(join(dir, 'never-created'))
    expect(await cache.list()).toEqual([])
  })

  it('set() overwrites an existing entry for the same templateId', async () => {
    const cache = createFsVcCache(dir)
    await cache.set(templateId, { templateId, vc: { v: 1 }, issuedAt: '2026-07-23T00:00:00Z' })
    await cache.set(templateId, { templateId, vc: { v: 2 }, issuedAt: '2026-07-24T00:00:00Z' })
    const got = await cache.get(templateId)
    expect(got?.vc).toEqual({ v: 2 })
    const all = await cache.list()
    expect(all).toHaveLength(1)
  })

  it('creates the cache directory and file as owner-only (0700/0600), not world-readable', async () => {
    const baseDir = join(dir, 'fresh-cache-dir')
    const cache = createFsVcCache(baseDir)
    await cache.set(templateId, { templateId, vc: {}, issuedAt: '2026-07-23T00:00:00Z' })
    // POSIX file-mode bits aren't meaningfully enforced on Windows; only assert them elsewhere.
    if (process.platform !== 'win32') {
      expect(statSync(baseDir).mode & 0o777).toBe(0o700)
      const [file] = readdirSync(baseDir)
      expect(statSync(join(baseDir, file)).mode & 0o777).toBe(0o600)
    }
  })

  it('get() treats a shape-invalid cached file (missing vc/templateId) as a cache miss', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, cacheFileNameFor(templateId)), JSON.stringify({ notAVc: true }), 'utf8')
    const cache = createFsVcCache(dir)
    expect(await cache.get(templateId)).toBeNull()
  })

  it('list() excludes a shape-invalid cached file rather than serving it as a credential', async () => {
    await createFsVcCache(dir).set('did:zid:a', { templateId: 'did:zid:a', vc: {}, issuedAt: '2026-07-23T00:00:00Z' })
    writeFileSync(join(dir, cacheFileNameFor('did:zid:corrupt')), JSON.stringify({ notAVc: true }), 'utf8')
    const all = await createFsVcCache(dir).list()
    expect(all).toHaveLength(1)
    expect(all[0].templateId).toBe('did:zid:a')
  })
})

describe('isVcValid', () => {
  it('is valid when validUntil is in the future', () => {
    expect(isVcValid({ validUntil: '2027-07-16T00:00:00Z' }, new Date('2026-07-23T00:00:00Z'))).toBe(true)
  })

  it('is invalid when validUntil is in the past', () => {
    expect(isVcValid({ validUntil: '2026-01-01T00:00:00Z' }, new Date('2026-07-23T00:00:00Z'))).toBe(false)
  })

  it('is valid when validUntil is absent (no known expiry)', () => {
    expect(isVcValid({}, new Date('2026-07-23T00:00:00Z'))).toBe(true)
  })

  it('is invalid (fails closed) on a malformed validUntil string', () => {
    expect(isVcValid({ validUntil: 'not-a-date' }, new Date('2026-07-23T00:00:00Z'))).toBe(false)
  })
})

describe('extractValidUntil', () => {
  it("reads the VC's own validUntil field when present", () => {
    expect(extractValidUntil({ validUntil: '2027-07-16T00:00:00Z' })).toBe('2027-07-16T00:00:00Z')
  })

  it('falls back to the provided fallback when the VC has no validUntil', () => {
    expect(extractValidUntil({ id: 'did:zid:x' }, '2027-01-01T00:00:00Z')).toBe('2027-01-01T00:00:00Z')
  })

  it('returns undefined when neither the VC nor a fallback carries one', () => {
    expect(extractValidUntil({ id: 'did:zid:x' })).toBeUndefined()
  })

  it('ignores a non-string validUntil field on the VC', () => {
    expect(extractValidUntil({ validUntil: 12345 }, 'fallback')).toBe('fallback')
  })

  it('handles a non-object vc without throwing', () => {
    expect(extractValidUntil(null, 'fallback')).toBe('fallback')
    expect(extractValidUntil('not-an-object')).toBeUndefined()
  })
})
