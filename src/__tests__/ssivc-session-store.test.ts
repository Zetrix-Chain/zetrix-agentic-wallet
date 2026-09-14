import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsSsivcSessionStore } from '../clients/ssivc-session-store'

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
  dir = mkdtempSync(join(tmpdir(), 'ssivc-session-store-test-'))
  fsCalls.length = 0
  writeFileSpy.mockClear()
  renameSpy.mockClear()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const sample = {
  sessionId: 's-1', agentName: 'Procurement Assistant', createdAt: '2026-08-17T09:00:00Z',
  verificationUrl: 'https://zvg.test/verify/tok', paymentReceipt: 'receipt-abc',
}

describe('createFsSsivcSessionStore', () => {
  it('returns null when no session has been saved yet', async () => {
    const store = createFsSsivcSessionStore(join(dir, 'ssivc-session.json'))
    expect(await store.get()).toBeNull()
  })

  it('round-trips a saved session (including verificationUrl + paymentReceipt) through set/get', async () => {
    const store = createFsSsivcSessionStore(join(dir, 'ssivc-session.json'))
    await store.set(sample)
    expect(await store.get()).toEqual(sample)
  })

  it('overwrites a previously saved session', async () => {
    const store = createFsSsivcSessionStore(join(dir, 'ssivc-session.json'))
    await store.set({ ...sample, sessionId: 's-old', agentName: 'Old Agent', paymentReceipt: 'receipt-old' })
    await store.set({ ...sample, sessionId: 's-new', agentName: 'New Agent', paymentReceipt: 'receipt-new' })
    expect(await store.get()).toEqual({ ...sample, sessionId: 's-new', agentName: 'New Agent', paymentReceipt: 'receipt-new' })
  })

  it('creates the parent directory if it does not exist yet', async () => {
    const store = createFsSsivcSessionStore(join(dir, 'nested', 'dir', 'ssivc-session.json'))
    await store.set(sample)
    expect(await store.get()).toMatchObject({ sessionId: 's-1' })
  })

  it('treats a corrupt/truncated file as no stored session rather than throwing', async () => {
    const filePath = join(dir, 'ssivc-session.json')
    writeFileSync(filePath, '{not valid json')
    const store = createFsSsivcSessionStore(filePath)
    expect(await store.get()).toBeNull()
  })

  it('treats a well-formed but wrong-shaped JSON file as no stored session', async () => {
    const filePath = join(dir, 'ssivc-session.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ foo: 'bar' }))
    const store = createFsSsivcSessionStore(filePath)
    expect(await store.get()).toBeNull()
  })

  it('treats a session saved by the pre-x402 shape (no verificationUrl/paymentReceipt) as no stored session', async () => {
    const filePath = join(dir, 'ssivc-session.json')
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify({ sessionId: 's-1', agentName: 'Old', createdAt: '2026-08-13T09:00:00Z' }))
    const store = createFsSsivcSessionStore(filePath)
    expect(await store.get()).toBeNull()
  })

  // APP-M02: a crash mid-write must never leave a torn/corrupt file that reads as "no session" and
  // silently triggers a fresh (double) payment. write-then-rename makes the write atomic — the
  // directory only ever contains the old complete file or the new complete file, never a partial one.
  it('writes atomically: no leftover temp file after set(), and no partial file is ever visible', async () => {
    const store = createFsSsivcSessionStore(join(dir, 'ssivc-session.json'))
    await store.set(sample)
    const files = readdirSync(dir)
    expect(files).toEqual(['ssivc-session.json'])
  })

  // R2-L02: the readdir assertion above also passes for a plain non-atomic writeFile(finalPath).
  // This one fails unless the implementation really is write-to-temp-then-rename.
  it('writes atomically: writes to a temp path first, then renames it onto the final path', async () => {
    const finalPath = join(dir, 'ssivc-session.json')
    const store = createFsSsivcSessionStore(finalPath)

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
