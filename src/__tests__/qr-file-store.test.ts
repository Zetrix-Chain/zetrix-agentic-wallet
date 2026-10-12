import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createFsQrFileStore } from '../qr-file-store'

const NOW = Date.parse('2026-10-12T08:00:00.000Z')
const MIN = 60_000
const REF = 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qr-store-'))
  dir = join(root, 'verification-qr')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('createFsQrFileStore', () => {
  // A chat channel can only attach a file or a link; the QR used to exist only inside the tool result, so the agent
  // sent the one image file it did have (the credential's pass design) and called it the QR code.
  it('writes the PNG to a file and returns an absolute path to it', async () => {
    const store = createFsQrFileStore(dir, { now: () => NOW })

    const path = await store.save(PNG, REF, NOW + 5 * MIN)

    expect(resolve(path)).toBe(path)
    expect(path.endsWith('.png')).toBe(true)
    expect(dirname(path)).toBe(resolve(dir))
    expect(readFileSync(path).equals(PNG)).toBe(true)
  })

  it('creates the directory when it is missing', async () => {
    expect(existsSync(dir)).toBe(false)
    const store = createFsQrFileStore(dir, { now: () => NOW })

    await store.save(PNG, REF, NOW + MIN)

    expect(existsSync(dir)).toBe(true)
  })

  it('does not put the whole reference id in the file name', async () => {
    const store = createFsQrFileStore(dir, { now: () => NOW })

    const path = await store.save(PNG, REF, NOW + MIN)

    expect(path).not.toContain(REF)
    expect(path).not.toContain('3f2b9c1e-7a44')
  })

  it('keeps a hostile reference id inside the directory', async () => {
    const store = createFsQrFileStore(dir, { now: () => NOW })

    const path = await store.save(PNG, '../../../etc/passwd', NOW + MIN)

    expect(dirname(path)).toBe(resolve(dir))
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('gives two presentations two files', async () => {
    const store = createFsQrFileStore(dir, { now: () => NOW })

    const a = await store.save(PNG, 'v2-aaaaaaaa-1111', NOW + MIN)
    const b = await store.save(PNG, 'v2-bbbbbbbb-2222', NOW + MIN)

    expect(a).not.toBe(b)
    expect(readdirSync(dir)).toHaveLength(2)
  })

  // Each file holds a live reference id, so a file must not outlive the presentation it opens.
  describe('removing expired files', () => {
    it('deletes a file whose presentation has expired the next time a QR is saved', async () => {
      let now = NOW
      const store = createFsQrFileStore(dir, { now: () => now })
      const old = await store.save(PNG, 'v2-oldoldol-1111', NOW + 5 * MIN)

      now = NOW + 6 * MIN
      await store.save(PNG, 'v2-newnewne-2222', now + 5 * MIN)

      expect(existsSync(old)).toBe(false)
      expect(readdirSync(dir)).toHaveLength(1)
    })

    it('keeps a file that has not expired yet', async () => {
      let now = NOW
      const store = createFsQrFileStore(dir, { now: () => now })
      const live = await store.save(PNG, 'v2-livelive-1111', NOW + 30 * MIN)

      now = NOW + 10 * MIN
      await store.save(PNG, 'v2-newnewne-2222', now + 5 * MIN)

      expect(existsSync(live)).toBe(true)
    })

    it('treats a file expiring exactly now as expired', async () => {
      let now = NOW
      const store = createFsQrFileStore(dir, { now: () => now })
      const edge = await store.save(PNG, 'v2-edgeedge-1111', NOW + 5 * MIN)

      now = NOW + 5 * MIN
      await store.save(PNG, 'v2-newnewne-2222', now + 5 * MIN)

      expect(existsSync(edge)).toBe(false)
    })

    it('leaves files it did not write alone', async () => {
      const store = createFsQrFileStore(dir, { now: () => NOW })
      await store.save(PNG, REF, NOW + MIN)
      writeFileSync(join(dir, 'notes.txt'), 'keep me')
      writeFileSync(join(dir, 'other.png'), 'keep me too')

      await store.save(PNG, 'v2-another1-3333', NOW + MIN)

      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me')
      expect(existsSync(join(dir, 'other.png'))).toBe(true)
    })

    it('still saves the new QR when an expired file cannot be removed', async () => {
      const store = createFsQrFileStore(dir, { now: () => NOW })
      await store.save(PNG, REF, NOW + MIN)
      // A directory under an expired QR's name: unlinking it fails, and that must not cost the user the new QR.
      mkdirSync(join(dir, `verification-qr-deadbeef-${NOW - MIN}-abc123.png`))

      const path = await store.save(PNG, 'v2-newnewne-2222', NOW + 5 * MIN)

      expect(existsSync(path)).toBe(true)
    })
  })

  // Review R1-L1: a file used to outlive its link when no later QR was made. A sweep at startup removes those.
  describe('sweeping at startup', () => {
    it('removes files whose link has expired, without a new QR being saved', async () => {
      let now = NOW
      const store = createFsQrFileStore(dir, { now: () => now })
      const old = await store.save(PNG, 'v2-oldoldol-1111', NOW + 5 * MIN)
      const live = await store.save(PNG, 'v2-livelive-2222', NOW + 60 * MIN)

      now = NOW + 10 * MIN
      await store.sweep()

      expect(existsSync(old)).toBe(false)
      expect(existsSync(live)).toBe(true)
    })

    it('does nothing, and does not throw, when the directory does not exist yet', async () => {
      const store = createFsQrFileStore(join(root, 'never-made'), { now: () => NOW })

      await expect(store.sweep()).resolves.toBeUndefined()
      expect(existsSync(join(root, 'never-made'))).toBe(false)
    })

    it('leaves files it did not write alone', async () => {
      const store = createFsQrFileStore(dir, { now: () => NOW })
      await store.save(PNG, REF, NOW + MIN)
      writeFileSync(join(dir, 'notes.txt'), 'keep me')

      await store.sweep()

      expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('keep me')
    })
  })

  // Review R1-L6: the boundary on the keep side, and the permissions, which are what make the file user-only.
  describe('keeping and permissions', () => {
    it('keeps a file that expires one millisecond from now', async () => {
      let now = NOW
      const store = createFsQrFileStore(dir, { now: () => now })
      const edge = await store.save(PNG, 'v2-edgeedge-1111', NOW + MIN)

      now = NOW + MIN - 1
      await store.save(PNG, 'v2-newnewne-2222', now + 5 * MIN)

      expect(existsSync(edge)).toBe(true)
    })

    it.skipIf(process.platform === 'win32')('creates the directory 0700 and the file 0600', async () => {
      const store = createFsQrFileStore(dir, { now: () => NOW })

      const path = await store.save(PNG, REF, NOW + MIN)

      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    })
  })

  it('gives up, rather than looping, when every name it picks is already taken', async () => {
    const store = createFsQrFileStore(dir, { now: () => NOW, randomSuffix: () => 'abc123' })
    await store.save(PNG, REF, NOW + MIN)

    await expect(store.save(PNG, REF, NOW + MIN)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  // Review R1-L2: a name collision must fail rather than silently overwrite another QR.
  it('never overwrites a file that already has the name it picked', async () => {
    const suffixes = ['abc123', 'abc123', 'def456']
    const store = createFsQrFileStore(dir, { now: () => NOW, randomSuffix: () => suffixes.shift() ?? 'fedcba' })
    const first = await store.save(PNG, REF, NOW + MIN)
    const other = Buffer.from('other-bytes')

    const second = await store.save(other, REF, NOW + MIN)

    expect(second).not.toBe(first)
    expect(readFileSync(first).equals(PNG)).toBe(true)
    expect(readFileSync(second).equals(other)).toBe(true)
  })
})
