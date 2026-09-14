/**
 * HSM password generation for a self-provisioning wallet.
 *
 * The wallet used to require the human to supply `HSM_PASSWORD`, which made a
 * zero-configuration start impossible and forced any hosted deployment to carry a secret
 * store. It now generates one when no password exists in the environment, the config file
 * or the local account store, and persists it alongside the address and DID it already
 * creates on first run (see orchestrator/resolve-holder.ts, clients/account-store.ts).
 *
 * Consequences, both deliberate:
 *  - The password is never entered, transmitted or stored by anyone else, so it can never
 *    be leaked by a secret store, a config file, an env var or a tool parameter.
 *  - It is also unrecoverable if the state directory is lost. Wallet BE holds the key but
 *    will not sign without this password. That is why `export-credentials` exists.
 *
 * 24 random bytes (192 bits) is far beyond what a Wallet BE password needs and costs
 * nothing; base64url keeps it safe to place in JSON, a URL or a shell argument.
 */

import { randomBytes } from 'node:crypto'

export function generateHsmPassword(): string {
  return randomBytes(24).toString('base64url')
}
