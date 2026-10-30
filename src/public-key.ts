/**
 * The wallet's own public key in Zetrix's encoded form, for wallet_status.
 *
 * A sub-agent hands its public key to the main agent that applies for its policy credential (apply_sub_agent_policy_vc), and MBI reads
 * that key with the Zetrix SDK, which wants the encoded form: `b001` + the 32-byte key + a 4-byte checksum, 76 hex characters (the
 * checksum is the first four bytes of a double SHA-256 over `b001` + the key). Wallet BE may hand the wallet either that form or the raw
 * 32-byte key (see onboard.ts), so a raw one is encoded here. A public key is not a secret: it is already sent in every signed request.
 */

import { createHash } from 'node:crypto'

const RAW = /^[0-9a-f]{64}$/i
const ENCODED = /^b001[0-9a-f]{72}$/i

function checksum(prefixedKeyHex: string): string {
  const once = createHash('sha256').update(Buffer.from(prefixedKeyHex, 'hex')).digest()
  return createHash('sha256').update(once).digest().subarray(0, 4).toString('hex')
}

/**
 * The encoded public key, or undefined when what was given is not a Zetrix public key (a wrong length, not hex, or an encoded key whose
 * checksum does not match): a key that would be refused is left out rather than shown.
 */
export function encodePublicKey(publicKeyHex: string | undefined): string | undefined {
  const key = publicKeyHex?.trim().toLowerCase()
  if (!key) return undefined
  if (RAW.test(key)) return `b001${key}${checksum(`b001${key}`)}`
  if (ENCODED.test(key)) return checksum(key.slice(0, 68)) === key.slice(68) ? key : undefined
  return undefined
}
