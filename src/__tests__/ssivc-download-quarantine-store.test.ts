import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsDownloadQuarantineStore, quarantineFileName } from '../clients/ssivc-download-quarantine-store'

// R2-L02: only `writeFile`/`rename` are spied; everything else (mkdir/readFile/...) stays real so the
// round-trip tests below still exercise the actual filesystem.
const fsCalls: string[] = []
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      fsCalls.push('writeFile')
      return actual.writeFile(...args)
    }),
    rename: vi.fn(async (...args: Parameters<typeof actual.rename>) => {
      fsCalls.push('rename')
      return actual.rename(...args)
    }),
  }
})
const fsp = await import('node:fs/promises')
const writeFileSpy = vi.mocked(fsp.writeFile)
const renameSpy = vi.mocked(fsp.rename)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssivc-quarantine-store-test-'))
  fsCalls.length = 0
  writeFileSpy.mockClear()
  renameSpy.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sample = {
  vcId: 'did:zid:vc-1',
  entries: [{ vc: { id: 'did:zid:vc-1' }, extraData: {}, status: 'ISSUED' }],
  downloadedAt: '2026-08-17T09:00:00Z',
}

describe('createFsDownloadQuarantineStore', () => {
  it('returns null when nothing has been quarantined for that vcId yet', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    expect(await store.get('did:zid:vc-1')).toBeNull()
  })

  it('round-trips a quarantined download through set/get by vcId', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    await store.set(sample)
    expect(await store.get('did:zid:vc-1')).toEqual(sample)
  })

  // R2-M01: the store used to be a single slot, so quarantining agent 2's download destroyed
  // agent 1's still-needed (paid-for, one-shot) preserved credential. Both must survive.
  it('does NOT destroy an earlier vcId entry when a second vcId is quarantined', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    const first = { ...sample, vcId: 'did:zid:vc-agent-1', entries: [{ vc: { id: 'did:zid:vc-agent-1' } }] }
    const second = { ...sample, vcId: 'did:zid:vc-agent-2', entries: [{ vc: { id: 'did:zid:vc-agent-2' } }] }

    await store.set(first)
    await store.set(second)

    expect(await store.get('did:zid:vc-agent-1')).toEqual(first)
    expect(await store.get('did:zid:vc-agent-2')).toEqual(second)
  })

  it('overwrites a previously quarantined download for the SAME vcId', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    await store.set({ ...sample, downloadedAt: '2020-01-01T00:00:00Z' })
    await store.set(sample)
    expect(await store.get('did:zid:vc-1')).toEqual(sample)
  })

  it('creates the base directory if it does not exist yet', async () => {
    const store = createFsDownloadQuarantineStore(join(dir, 'nested', 'deeper'))
    await store.set(sample)
    expect(await store.get('did:zid:vc-1')).toEqual(sample)
  })

  it('exposes the concrete on-disk path for a vcId (used in operator-facing error messages)', () => {
    const store = createFsDownloadQuarantineStore(dir)
    expect(store.filePathFor('did:zid:vc-1')).toBe(join(dir, quarantineFileName('did:zid:vc-1')))
    // Never the raw vcId — `:` is not a valid filename character on Windows.
    expect(store.filePathFor('did:zid:vc-1')).not.toContain('did:zid:vc-1')
  })

  it('treats a corrupt/truncated file for a vcId as nothing quarantined rather than throwing', async () => {
    writeFileSync(join(dir, quarantineFileName('did:zid:vc-1')), '{not valid json')
    const store = createFsDownloadQuarantineStore(dir)
    expect(await store.get('did:zid:vc-1')).toBeNull()
  })

  it('treats a well-formed but wrong-shaped JSON file as nothing quarantined', async () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, quarantineFileName('did:zid:vc-1')), JSON.stringify({ foo: 'bar' }))
    const store = createFsDownloadQuarantineStore(dir)
    expect(await store.get('did:zid:vc-1')).toBeNull()
  })

  it('writes atomically: no leftover temp file after set()', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    await store.set(sample)
    expect(readdirSync(dir)).toEqual([quarantineFileName('did:zid:vc-1')])
  })

  // R2-L02: the readdir assertion above also passes for a plain non-atomic writeFile(finalPath).
  // This one fails unless the implementation really is write-to-temp-then-rename.
  it('writes atomically: writes to a temp path first, then renames it onto the final path', async () => {
    const store = createFsDownloadQuarantineStore(dir)
    const finalPath = store.filePathFor('did:zid:vc-1')

    await store.set(sample)

    expect(writeFileSpy).toHaveBeenCalledTimes(1)
    const writtenPath = String(writeFileSpy.mock.calls[0][0])
    expect(writtenPath).toMatch(/\.tmp-/)
    expect(writtenPath).not.toBe(finalPath)

    expect(renameSpy).toHaveBeenCalledTimes(1)
    expect(renameSpy).toHaveBeenCalledWith(writtenPath, finalPath)

    // ...and in that order: the temp file is fully written before it becomes visible as the final one.
    expect(fsCalls).toEqual(['writeFile', 'rename'])
    expect(writeFileSpy.mock.invocationCallOrder[0]).toBeLessThan(renameSpy.mock.invocationCallOrder[0])
  })
})
