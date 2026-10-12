import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const renames: Array<[string, string]> = []
const events: string[] = []
const failRename = { on: false }
const dirOpenError: { code?: string } = {}
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      // The directory is opened for fsync without a temp-file name; make that open fail when a test asks.
      if (dirOpenError.code && !String(args[0]).includes('.tmp-')) throw Object.assign(new Error('dir open failed'), { code: dirOpenError.code })
      const handle = await actual.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        events.push('sync')
        return sync()
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      events.push('rename')
      if (failRename.on) throw new Error('rename failed')
      renames.push([from, to])
      return actual.rename(from, to)
    },
  }
})

import { createFsSelfPayMarkerStore, markerFileName } from '../clients/self-pay-marker-store'

const MARKER = {
  policyKey: 'native-v1',
  ownerAddress: 'ZTX3Owner',
  operation: 'CREATE' as const,
  nonce: '41',
  txHash: 'ab'.repeat(32),
  ceilLedgerSeq: '1060',
  submittedAt: '2026-10-12T00:00:00.000Z',
}

describe('the note store writes atomically and durably', () => {
  it('writes a temp file and renames it onto the final name, never writing the final file in place', async () => {
    renames.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'self-pay-atomic-'))
    await createFsSelfPayMarkerStore(dir).set(MARKER)
    expect(renames).toHaveLength(1)
    expect(renames[0][0]).not.toBe(renames[0][1])
    expect(renames[0][1]).toBe(join(dir, markerFileName('ZTX3Owner', 'native-v1')))
  })

  it('fsyncs the temp file BEFORE the rename, so a power loss right after the submit cannot leave an empty note', async () => {
    events.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'self-pay-atomic-'))
    await createFsSelfPayMarkerStore(dir).set(MARKER)
    expect(events.indexOf('sync')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('sync')).toBeLessThan(events.indexOf('rename'))
  })

  it('a failed rename throws and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-pay-atomic-'))
    failRename.on = true
    try {
      await expect(createFsSelfPayMarkerStore(dir).set(MARKER)).rejects.toThrow('rename failed')
    } finally {
      failRename.on = false
    }
    expect(await readdir(dir)).toEqual([])
  })

  it('a platform that cannot fsync a directory is tolerated; a real I/O error is not', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-pay-atomic-'))
    try {
      for (const code of ['EPERM', 'EISDIR', 'EACCES', 'EINVAL', 'ENOTSUP', 'ENOSYS', 'EBADF']) {
        dirOpenError.code = code
        await expect(createFsSelfPayMarkerStore(dir).set(MARKER), code).resolves.toBeUndefined()
      }
      dirOpenError.code = 'EIO'
      await expect(createFsSelfPayMarkerStore(dir).set(MARKER)).rejects.toThrow('dir open failed')
    } finally {
      dirOpenError.code = undefined
    }
  })

  it('two sets for one key never share a temp file name', async () => {
    renames.length = 0
    const dir = await mkdtemp(join(tmpdir(), 'self-pay-atomic-'))
    const store = createFsSelfPayMarkerStore(dir)
    await store.set(MARKER)
    await store.set({ ...MARKER, nonce: '42' })
    expect(renames).toHaveLength(2)
    expect(renames[0][0]).not.toBe(renames[1][0])
  })
})
