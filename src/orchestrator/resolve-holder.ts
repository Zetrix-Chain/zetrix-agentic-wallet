/**
 * resolveHolder — startup holder-identity resolution (2 scenarios).
 *
 * `ZETRIX_ADDRESS`/`HOLDER_DID` are both optional in config; only `HSM_PASSWORD` is required.
 * This runs once at process start (see index.ts) to settle on a concrete, *verified*
 * `{ zetrixAddress, holderDid }` for the rest of the session:
 *
 *   1. First-time user (no `zetrixAddress`) — create a new HSM account via Wallet BE
 *      (`POST /wallet/hsm/account/create`) and derive the DID from the returned public key.
 *   2. Existing user (`zetrixAddress` set) — self-sign the address via the existing
 *      `POST /wallet/hsm/sign-message` (no new Wallet BE endpoint needed) and derive the DID
 *      from the response's `publicKey`. This always runs, whether or not `holderDid` was
 *      supplied: a client-supplied DID is never trusted blindly — if it doesn't match what the
 *      account's actual public key derives to, the derived (correct) DID wins and the caller is
 *      told about the mismatch (`didMismatch: true`).
 *
 * Neither scenario persists anything to disk — env vars only load at process start (see
 * `orchestrator/onboard.ts`), so a freshly created account's address/DID must still be copied
 * into the MCP config for the *next* run. This just avoids requiring that round trip before the
 * first run can do anything at all.
 *
 * `hsmPassword` is always the caller's own — this module never generates, invents, or infers
 * one. It's a required (non-optional) field on `ResolveHolderInput`, and `config.ts` requires
 * `HSM_PASSWORD` from the environment before `main()` ever calls this function; there is no
 * code path in this file (or anywhere else in this repo — see the `createAccount` call below)
 * that creates a password on the user's behalf.
 */

import { deriveHolderDid } from './onboard.js'

export interface ResolveHolderDeps {
  createAccount: (password: string) => Promise<{ zetrixAddress: string; publicKeyHex: string }>
  signMessage: (message: string, address: string, password: string) => Promise<{ signBlob: string; publicKey: string }>
}

export interface ResolveHolderInput {
  zetrixAddress?: string
  holderDid?: string
  hsmPassword: string
}

export interface ResolveHolderResult {
  zetrixAddress: string
  holderDid: string
  /** True when a new HSM account was just created (scenario 1) — the caller should tell the user to save it. */
  created: boolean
  /** True when a supplied `holderDid` didn't match the account's derived DID — `holderDid` above is the corrected value. */
  didMismatch: boolean
}

export async function resolveHolder(deps: ResolveHolderDeps, input: ResolveHolderInput): Promise<ResolveHolderResult> {
  if (!input.zetrixAddress) {
    const { zetrixAddress, publicKeyHex } = await deps.createAccount(input.hsmPassword)
    return { zetrixAddress, holderDid: deriveHolderDid(publicKeyHex), created: true, didMismatch: false }
  }

  const { publicKey } = await deps.signMessage(input.zetrixAddress, input.zetrixAddress, input.hsmPassword)
  const derivedDid = deriveHolderDid(publicKey)
  const didMismatch = input.holderDid !== undefined && input.holderDid !== derivedDid

  return { zetrixAddress: input.zetrixAddress, holderDid: derivedDid, created: false, didMismatch }
}
