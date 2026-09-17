import { describe, it, expect, vi } from 'vitest'
import { buildToolContent } from '../tool-result'

describe('buildToolContent', () => {
  it('returns only a text block when the result has no vcPassImagePaths', async () => {
    const readFile = vi.fn()
    const blocks = await buildToolContent({ issued: true, vcId: 'did:zid:vc-1' }, readFile)
    expect(blocks).toEqual([{ type: 'text', text: JSON.stringify({ issued: true, vcId: 'did:zid:vc-1' }) }])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('embeds one base64 image block per path in vcPassImagePaths, after the text block', async () => {
    const readFile = vi.fn().mockResolvedValue(Buffer.from('fake-png-bytes'))
    const result = { issued: true, vcPassImagePaths: ['/state/vc-pass-images/abc-0.png'] }

    const blocks = await buildToolContent(result, readFile)

    expect(readFile).toHaveBeenCalledWith('/state/vc-pass-images/abc-0.png')
    expect(blocks).toEqual([
      { type: 'text', text: JSON.stringify(result) },
      { type: 'image', data: Buffer.from('fake-png-bytes').toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('embeds multiple image blocks in order for a multi-page pass', async () => {
    const readFile = vi.fn().mockImplementation(async (p: string) => Buffer.from(p))
    const result = { vcPassImagePaths: ['/a.png', '/b.png'] }

    const blocks = await buildToolContent(result, readFile)

    expect(blocks).toHaveLength(3)
    expect(blocks[1]).toEqual({ type: 'image', data: Buffer.from('/a.png').toString('base64'), mimeType: 'image/png' })
    expect(blocks[2]).toEqual({ type: 'image', data: Buffer.from('/b.png').toString('base64'), mimeType: 'image/png' })
  })

  it('skips a path whose file cannot be read, but still returns the text block and any other images', async () => {
    const readFile = vi.fn().mockImplementation(async (p: string) => {
      if (p === '/missing.png') throw new Error('ENOENT')
      return Buffer.from('ok')
    })
    const result = { vcPassImagePaths: ['/missing.png', '/ok.png'] }

    const blocks = await buildToolContent(result, readFile)

    expect(blocks).toEqual([
      { type: 'text', text: JSON.stringify(result) },
      { type: 'image', data: Buffer.from('ok').toString('base64'), mimeType: 'image/png' },
    ])
  })

  it('does not crash and returns only the text block when vcPassImagePaths is not an array', async () => {
    const readFile = vi.fn()
    const result = { vcPassImagePaths: 'not-an-array' }

    const blocks = await buildToolContent(result, readFile)

    expect(blocks).toEqual([{ type: 'text', text: JSON.stringify(result) }])
    expect(readFile).not.toHaveBeenCalled()
  })

  it('does not crash when result is null', async () => {
    const readFile = vi.fn()
    const blocks = await buildToolContent(null, readFile)
    expect(blocks).toEqual([{ type: 'text', text: 'null' }])
  })
})
