/**
 * The per-request x401 wallet, built in one place so a test can call it.
 *
 * Written inline in `main()` (coverage-ignored), dropping the answered-challenges store or the audience would have kept every test green;
 * here both are pinned. A wallet is built for each prove_identity call, bound to the credential it presents.
 *
 * Binding the presentation to the verifier's session (the nonce and audience go to MBI, and each challenge is answered once) can be turned
 * off with `X401_BIND_PRESENTATION=false`, for a deployment where the verifier is not yet ready for it.
 */
import { X401Wallet } from 'x401-zetrix-client'
import type { HolderSigner, SubmitAuthProvider, X401WalletConfig, ZetrixNetwork } from 'x401-zetrix-client'
import {
  MbiVpAdapter,
  type HexBlobSigner,
  type IssuerKeyResolver,
  type MbiVpCaller,
  type MessageSigner,
  type VcPresentInput,
} from './clients/mbi-vp-adapter.js'
import type { PresentedNonceStore } from './clients/presented-nonce-store.js'
import { verifierOrigin } from './x401-audience.js'

export interface X401WalletFactoryDeps {
  config: { oid4vpBaseUrl?: string; network: string; bindPresentation: boolean }
  mbi: MbiVpCaller
  signer: HolderSigner
  signHexBlob: HexBlobSigner
  signMessage: MessageSigner
  resolveIssuerKeys: IssuerKeyResolver
  submitAuth?: SubmitAuthProvider
  /** The challenges already answered (see presented-nonce-store.ts). */
  answered: PresentedNonceStore
  /** Test seam: builds the x401 wallet. Defaults to the real client. */
  construct?: (cfg: X401WalletConfig, deps: ConstructorParameters<typeof X401Wallet>[1]) => X401Wallet
}

export function createX401WalletFactory(d: X401WalletFactoryDeps): (present: VcPresentInput) => X401Wallet {
  const construct = d.construct ?? ((cfg, deps) => new X401Wallet(cfg, deps))
  const bind = d.config.bindPresentation
  // The origin of the verifier this wallet presents to, resolved the way the client resolves it (see x401-audience.ts).
  const audience = bind ? verifierOrigin(d.config) : undefined
  return (present) =>
    construct(
      { oid4vpBaseUrl: d.config.oid4vpBaseUrl, network: d.config.network as ZetrixNetwork },
      {
        signer: d.signer,
        vc: new MbiVpAdapter(
          d.mbi,
          d.signHexBlob,
          d.signMessage,
          d.resolveIssuerKeys,
          { ...present, audience, bindSession: bind },
          bind ? d.answered : undefined,
        ),
        submitAuth: d.submitAuth,
      },
    )
}
