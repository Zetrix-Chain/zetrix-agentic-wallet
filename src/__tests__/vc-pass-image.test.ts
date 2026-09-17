import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractVcPassBase64, writeVcPassImages } from '../clients/vc-pass-image'

describe('extractVcPassBase64', () => {
  it('returns undefined when extraData is null', () => {
    expect(extractVcPassBase64(null)).toBeUndefined()
  })

  it('returns undefined when extraData is undefined', () => {
    expect(extractVcPassBase64(undefined)).toBeUndefined()
  })

  it('returns undefined when extraData carries no vcPassBase64 field', () => {
    expect(extractVcPassBase64({ someOtherField: 1 })).toBeUndefined()
  })

  it('returns undefined when vcPassBase64 is an empty array', () => {
    expect(extractVcPassBase64({ vcPassBase64: [] })).toBeUndefined()
  })

  it('returns the array when vcPassBase64 carries one or more base64 strings', () => {
    expect(extractVcPassBase64({ vcPassBase64: ['aGVsbG8=', 'd29ybGQ='] })).toEqual(['aGVsbG8=', 'd29ybGQ='])
  })

  it('drops non-string entries rather than passing them through', () => {
    expect(extractVcPassBase64({ vcPassBase64: ['aGVsbG8=', 42, null] })).toEqual(['aGVsbG8='])
  })

  // Code review (APP-L01): nothing bounded page count or decoded size, so an oversized or
  // very long vcPassBase64 array was held in memory and written to disk in full. Bounds are a
  // robustness measure (MBI is first-party, not attacker-controlled) — an oversized/excess page is
  // skipped rather than failing the whole array.
  it('caps the number of pages rather than writing an unbounded array', () => {
    const pages = Array.from({ length: 15 }, (_, i) => Buffer.from(`page-${i}`).toString('base64'))
    const result = extractVcPassBase64({ vcPassBase64: pages })
    expect(result).toHaveLength(10)
    expect(result).toEqual(pages.slice(0, 10))
  })

  it('skips a single page whose encoded length exceeds the size bound, keeping the rest', () => {
    const oversized = 'a'.repeat(9_000_000)
    const normal = Buffer.from('normal-page').toString('base64')
    expect(extractVcPassBase64({ vcPassBase64: [normal, oversized] })).toEqual([normal])
  })
})

describe('writeVcPassImages', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vc-pass-image-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes one PNG file per base64 entry and returns their paths', async () => {
    const png1 = Buffer.from('fake-png-bytes-1').toString('base64')
    const png2 = Buffer.from('fake-png-bytes-2').toString('base64')

    const paths = await writeVcPassImages(dir, 'did:zid:vc-1', [png1, png2])

    expect(paths).toHaveLength(2)
    expect(readFileSync(paths[0], 'utf8')).toBe('fake-png-bytes-1')
    expect(readFileSync(paths[1], 'utf8')).toBe('fake-png-bytes-2')
  })

  it('creates the base directory if it does not exist yet', async () => {
    const nested = join(dir, 'nested', 'deeper')
    const paths = await writeVcPassImages(nested, 'did:zid:vc-1', [Buffer.from('x').toString('base64')])
    expect(readFileSync(paths[0], 'utf8')).toBe('x')
  })

  it('never uses the raw vcId as a filename (":" is invalid on Windows)', async () => {
    const paths = await writeVcPassImages(dir, 'did:zid:vc-1', [Buffer.from('x').toString('base64')])
    expect(paths[0]).not.toContain('did:zid:vc-1')
  })
})
