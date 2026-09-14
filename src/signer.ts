/**
 * WalletBeSigner — implements x401's `HolderSigner` over the Wallet BE HSM.
 *
 * The x401 client asks for a holder-binding signature over the verifier nonce;
 * we hex-encode the nonce and sign it via `POST /wallet/hsm/sign-blob` (the same
 * hex-blob convention MBI's holder-signature verify uses). Interface kept identical
 * to the future hardware-HSM signer, so the cutover is config-only.
 *
 * Hex-encoding the UTF-8 nonce is the byte-form the OID4VP verifier expects. Kept
 * isolated here regardless, so a future change is still a one-line edit.
 */

import type { HolderSigner } from 'x401-zetrix-client'
import type { HsmSignResult, WalletBeClient } from './clients/wallet-be-client.js'

export class WalletBeSigner implements HolderSigner {
  constructor(
    private readonly be: WalletBeClient,
    private readonly holderAddress: string,
    private readonly hsmPassword: string,
  ) {}

  sign(nonce: string): Promise<HsmSignResult> {
    const blobHex = Buffer.from(nonce, 'utf8').toString('hex')
    return this.be.signBlob(blobHex, this.holderAddress, this.hsmPassword)
  }
}
