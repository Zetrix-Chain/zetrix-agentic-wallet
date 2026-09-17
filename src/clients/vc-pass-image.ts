/**
 * VC pass image extraction/materialization — the "pass design" PNG(s) MBI generates alongside a
 * VC, carried as base64 in `MbiVcEntry.extraData.vcPassBase64` (an array: a pass can be
 * multi-page). Optional on MBI's side — an older MBI, or a template with no configured pass
 * design, omits the field entirely, so callers must treat its absence as "no image", not an error.
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Robustness bounds, not a security boundary — MBI is first-party and nothing attacker-controlled
 * reaches this field. Still worth capping: nothing else limits how many pages or how large an
 * encoded entry can be, and every page is held in memory and written to the wallet's state volume
 * in full (APP-L01). An oversized page is skipped rather than aborting the whole array, so one bad
 * page cannot hide the rest.
 */
const MAX_PASS_IMAGE_PAGES = 10
/** ~6 MB decoded (base64 is ~4/3 the decoded size) — generous for a pass-design card, not a photo album. */
const MAX_PASS_IMAGE_BASE64_LENGTH = 8_000_000

/** Pulls `vcPassBase64` out of an MBI download entry's `extraData`, or undefined when there is none to show. */
export function extractVcPassBase64(extraData: unknown): string[] | undefined {
  if (typeof extraData !== 'object' || extraData === null) return undefined
  const raw = (extraData as Record<string, unknown>).vcPassBase64
  if (!Array.isArray(raw)) return undefined
  const strings = raw
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_PASS_IMAGE_BASE64_LENGTH)
    .slice(0, MAX_PASS_IMAGE_PAGES)
  return strings.length > 0 ? strings : undefined
}

/**
 * Decodes each base64 entry to a PNG file under `baseDir` and returns their paths, so a caller
 * (the wallet's tool result) can hand the user something to open rather than a raw base64 blob.
 *
 * Filenames are a sha256 hash of the vcId, not the vcId itself — a real vcId is a `did:zid:...`
 * string, and `:` is not a valid filename character on Windows (mirrors vc-cache.ts / ssivc-download-quarantine-store.ts).
 */
export async function writeVcPassImages(baseDir: string, vcId: string, base64Images: string[]): Promise<string[]> {
  await mkdir(baseDir, { recursive: true })
  const hash = createHash('sha256').update(vcId).digest('hex')
  const paths: string[] = []
  for (let i = 0; i < base64Images.length; i++) {
    const filePath = join(baseDir, `${hash}-${i}.png`)
    await writeFile(filePath, Buffer.from(base64Images[i], 'base64'))
    paths.push(filePath)
  }
  return paths
}
