import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import jsQR from 'jsqr'
import { renderQrPng } from '../qr-png'

/** Decode our own grayscale PNG back to RGBA, so jsQR reads exactly the pixels a phone camera would. */
function pngToRgba(png: Buffer): { width: number; height: number; data: Uint8ClampedArray } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      expect(body[8]).toBe(8) // bit depth
      expect(body[9]).toBe(0) // grayscale
    }
    if (type === 'IDAT') idat.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1)
    expect(raw[row]).toBe(0) // filter: none
    for (let x = 0; x < width; x++) {
      const v = raw[row + 1 + x]
      const i = (y * width + x) * 4
      data[i] = data[i + 1] = data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('renderQrPng', () => {
  it('produces a PNG that a QR reader decodes back to the exact text', async () => {
    const link = 'https://link.myid.test/agentic-verify?referenceId=v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77'

    const png = await renderQrPng(link)
    const { width, height, data } = pngToRgba(png)
    const decoded = jsQR(data, width, height)

    expect(decoded?.data).toBe(link)
  })

  it('decodes a link with characters that need URL-encoding', async () => {
    const link = 'https://link.myid.test/agentic-verify?referenceId=v2-a%26b%3Dc%20d%23x&lang=ms'

    const { width, height, data } = pngToRgba(await renderQrPng(link))

    expect(jsQR(data, width, height)?.data).toBe(link)
  })

  it('is large enough to scan from a screen: at least 200 px square with a white quiet zone', async () => {
    const { width, height, data } = pngToRgba(await renderQrPng('https://link.myid.test/x?referenceId=v2-1'))

    expect(width).toBe(height)
    expect(width).toBeGreaterThanOrEqual(200)
    // top-left pixel is inside the quiet zone, so it must be white
    expect(data[0]).toBe(255)
  })

  it('refuses empty text rather than drawing a meaningless code', async () => {
    await expect(renderQrPng('')).rejects.toThrow(/empty/i)
  })
})
