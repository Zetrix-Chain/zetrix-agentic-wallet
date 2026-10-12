/**
 * Writes a verification QR code to a file, so a chat channel can attach it.
 *
 * `create_verification_qr` used to hand the QR over only as an MCP image block. A channel such as WhatsApp sends files
 * or links, so the agent had nothing to attach and sent the one image file it did have (the credential's pass design),
 * calling it the QR code. A file path gives it the right thing to attach.
 *
 * Each file holds a reference id that opens what the presentation reveals until it expires, so a file must not outlive
 * that. The expiry is part of the file name, and every save removes the files whose time has passed. Only files this
 * module named are ever touched.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface QrFileStore {
  /** Writes `png` and returns the absolute path. `expiresAtMs` is when the link it opens stops working. */
  save(png: Buffer, referenceId: string, expiresAtMs: number): Promise<string>
  /** Removes the files whose link has expired. Called at startup, so a file does not outlive its link when no later QR is made. */
  sweep(): Promise<void>
}

const PREFIX = 'verification-qr-'
/** `verification-qr-<up to 8 of the reference id>-<expiry ms>-<random>.png` */
const OWN_FILE = /^verification-qr-[a-z0-9]{1,8}-(\d+)-[a-f0-9]{6}\.png$/

/** A short, filename-safe tag from the reference id. Never the whole id, and nothing that can leave the directory. */
function tagFor(referenceId: string): string {
  const tag = referenceId
    .toLowerCase()
    .replace(/^v2-/, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 8)
  return tag === '' ? 'qr' : tag
}

export function createFsQrFileStore(dir: string, opts: { now?: () => number; randomSuffix?: () => string } = {}): QrFileStore {
  const now = opts.now ?? Date.now
  const randomSuffix = opts.randomSuffix ?? (() => randomBytes(3).toString('hex'))
  const root = resolve(dir)

  async function removeExpired(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      return
    }
    const at = now()
    for (const name of names) {
      const m = OWN_FILE.exec(name)
      if (!m) continue
      if (Number(m[1]) > at) continue
      try {
        await unlink(join(root, name))
      } catch {
        // One file that will not go must not cost the user the QR they just asked for.
      }
    }
  }

  return {
    async save(png, referenceId, expiresAtMs) {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await removeExpired()
      // `wx`: never overwrite a file that already has this name (and so never keep its looser mode). A collision, which
      // needs the same tag, the same millisecond and the same suffix, just takes another suffix.
      for (let attempt = 0; ; attempt++) {
        const name = `${PREFIX}${tagFor(referenceId)}-${Math.floor(expiresAtMs)}-${randomSuffix()}.png`
        const path = join(root, name)
        try {
          await writeFile(path, png, { mode: 0o600, flag: 'wx' })
          return path
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 4) throw e
        }
      }
    },
    sweep: removeExpired,
  }
}
