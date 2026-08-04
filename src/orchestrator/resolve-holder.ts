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
 * `hsmPassword` is a required (non-optional) field on `ResolveHolderInput` and this module never
 * invents one — but as of the self-service change it may receive a password that `startup-env.ts`
 * generated rather than one a human typed. That distinction is invisible here on purpose: from
 * this module's point of view the password is just an opaque credential.
 */

import { deriveHolderDid } from './onboard.js'
import { waitForActivation, type CheckActivationStatus } from './wait-for-activation.js'

export interface ResolveHolderDeps {
  createAccount: (password: string) => Promise<{ zetrixAddress: string; publicKeyHex: string; activated: boolean; activationTxHash: string | null }>
  signMessage: (message: string, address: string, password: string) => Promise<{ signBlob: string; publicKey: string }>
  checkActivationStatus: CheckActivationStatus
  sleep: (ms: number) => Promise<void>
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
  /** Final on-chain activation state after a bounded poll (scenario 1 only) — undefined when created is false. */
  activated?: boolean
}

export async function resolveHolder(deps: ResolveHolderDeps, input: ResolveHolderInput): Promise<ResolveHolderResult> {
  if (!input.zetrixAddress) {
    const { zetrixAddress, publicKeyHex, activated } = await deps.createAccount(input.hsmPassword)
    let finalActivated = activated
    if (!finalActivated) {
      try {
        finalActivated = await waitForActivation(deps.checkActivationStatus, zetrixAddress, deps.sleep)
      } catch {
        // Polling itself failing (HSM/BaaS hiccup, network error) must not crash resolveHolder —
        // the account was already minted on Wallet BE, so we still report it as created; the
        // caller persists it locally regardless, and just sees activated: false.
        finalActivated = false
      }
    }
    return { zetrixAddress, holderDid: deriveHolderDid(publicKeyHex), created: true, didMismatch: false, activated: finalActivated }
  }

  const { publicKey } = await deps.signMessage(input.zetrixAddress, input.zetrixAddress, input.hsmPassword)
  const derivedDid = deriveHolderDid(publicKey)
  const didMismatch = input.holderDid !== undefined && input.holderDid !== derivedDid

  return { zetrixAddress: input.zetrixAddress, holderDid: derivedDid, created: false, didMismatch }
}
