/**
 * Renders text as a PNG QR code.
 *
 * `uqr` computes the module matrix (it has no dependencies); the PNG itself is written here with
 * node:zlib, so the wallet gains one small package rather than an image stack. The image is 8-bit
 * grayscale, every module drawn as a square of MODULE_PX pixels, inside the 4-module white border the
 * QR specification asks for — without that border most phone cameras fail to lock on.
 */

import { deflateSync } from 'node:zlib'
import { encode } from 'uqr'

const MODULE_PX = 8
const QUIET_MODULES = 4

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

export async function renderQrPng(text: string): Promise<Buffer> {
  if (text === '') throw new Error('renderQrPng: cannot draw a QR code for empty text')

  // ecc 'M' tolerates a smudged or glared screen better than the default without making the code much denser.
  const { data: modules, size } = encode(text, { ecc: 'M', border: 0 })
  const side = (size + QUIET_MODULES * 2) * MODULE_PX

  const raw = Buffer.alloc((side + 1) * side, 0xff) // white; the first byte of each row is the PNG filter (0 = none)
  for (let y = 0; y < side; y++) raw[y * (side + 1)] = 0
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!modules[my][mx]) continue
      for (let dy = 0; dy < MODULE_PX; dy++) {
        const row = ((my + QUIET_MODULES) * MODULE_PX + dy) * (side + 1) + 1
        raw.fill(0x00, row + (mx + QUIET_MODULES) * MODULE_PX, row + (mx + QUIET_MODULES + 1) * MODULE_PX)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  // compression, filter and interlace stay 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
