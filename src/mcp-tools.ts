/**
 * createTools — the 4 agent-facing tools.
 *
 * Pure wiring: each tool composes an orchestrator + config. The concrete deps
 * (X401Wallet, x402 payer, MBI + Wallet-BE sign/pay) are built in index.ts
 * and injected here, so the tools unit-test without live services.
 *
 *   wallet_status        — holder DID/address/network + client-supplied held VCs
 *   prove_identity       — x401 PROOF-REQUEST → PROOF-RESPONSE
 *   pay_and_fetch        — x402 pay-per-use
 *   subscribe_and_issue  — MBI VC issuance (pay → settle → VC)
 *   create_holder_account — HSM onboarding: create the account if it doesn't exist yet
 */

import type { X401Wallet } from 'x401-zetrix-client'
import type { VcPresentInput } from './clients/mbi-vp-adapter.js'
import { proveIdentity } from './orchestrator/prove.js'
import { payAndFetch, type PayFetch, type PayRequest } from './orchestrator/pay.js'
import { subscribeAndIssue, type SubscribeDeps, type SubscribeOpts } from './orchestrator/subscribe.js'
import { createHolderAccount, type CreateAccount, type CreateHolderAccountInput, type ExistingAccount } from './orchestrator/onboard.js'
import { type VcCacheStore, isVcValid } from './clients/vc-cache.js'
import { resolveTemplateAlias } from './template-aliases.js'

export interface ToolDeps {
  config: { holderDid: string; zetrixAddress: string; network: string }
  /** Builds a per-request X401Wallet bound to the client-supplied VC. */
  makeWallet: (present: VcPresentInput) => X401Wallet
  payer: PayFetch
  subscribeDeps: SubscribeDeps
  /** Optional chain-balance reader (e.g. via the connected zetrix-testnet MCP). */
  getBalances?: () => Promise<unknown>
  createAccount: CreateAccount
  /** Persists a freshly created account (address, DID, password) locally so create_holder_account survives a restart. */
  saveAccount: (account: ExistingAccount & { hsmPassword: string; label?: string; purpose?: string }) => Promise<void>
  /**
   * Local cache of previously-issued VCs (same store subscribe_and_issue writes to).
   * Optional — when omitted, wallet_status/prove_identity require the caller to pass
   * credentials explicitly, matching the original client-held-only behaviour.
   */
  cache?: VcCacheStore
}

export interface WalletStatusInput {
  /** Client-held VCs to report. Omit to report whatever's in the local cache instead. */
  heldCredentials?: unknown[]
}

export interface ProveIdentityInput {
  proofRequest: string
  /** Client-held VC to present. Omit to use the single valid cached VC, if there is exactly one. */
  vc?: unknown
  /** Dotted disclosure paths; omit to reveal everything. */
  revealAttribute?: string[]
  /**
   * Optional issuer BBS+/Ed25519 keys, to bypass the ZID resolver when it's unreachable
   * (e.g. Cloudflare-gated). When set, the wallet skips resolution and uses these verbatim.
   */
  issuerKeys?: { bbsPublicKey: string; ed25519PublicKey: string }
}

/** Cached VCs that are still within their validity window, if a cache is configured. */
async function loadValidCachedCredentials(cache?: VcCacheStore) {
  if (!cache) return []
  const all = await cache.list()
  return all.filter((entry) => isVcValid(entry))
}

export function createTools(deps: ToolDeps) {
  return {
    async wallet_status(input: WalletStatusInput = {}) {
      const balances = deps.getBalances ? await deps.getBalances() : undefined
      const credentials = input.heldCredentials ?? (await loadValidCachedCredentials(deps.cache)).map((entry) => entry.vc)
      return {
        holderDid: deps.config.holderDid,
        zetrixAddress: deps.config.zetrixAddress,
        network: deps.config.network,
        credentials,
        ...(balances !== undefined ? { balances } : {}),
      }
    },

    async prove_identity(input: ProveIdentityInput) {
      let vc = input.vc
      if (vc === undefined) {
        const cached = await loadValidCachedCredentials(deps.cache)
        if (cached.length === 0) {
          throw new Error('prove_identity: no vc supplied and no valid credential is cached — call subscribe_and_issue first, or pass vc explicitly.')
        }
        if (cached.length > 1) {
          const ids = cached.map((entry) => entry.templateId).join(', ')
          throw new Error(`prove_identity: no vc supplied and multiple credentials are cached (templateIds: ${ids}) — pass vc explicitly to select one.`)
        }
        vc = cached[0].vc
      }
      const wallet = deps.makeWallet({
        vc,
        revealAttribute: input.revealAttribute,
        issuerKeys: input.issuerKeys,
      })
      return proveIdentity(wallet, input.proofRequest, deps.config.holderDid)
    },

    pay_and_fetch(input: PayRequest) {
      return payAndFetch(deps.payer, input)
    },

    subscribe_and_issue(input: SubscribeOpts) {
      const resolved = resolveTemplateAlias(input.templateId, deps.config.network)
      return subscribeAndIssue(deps.subscribeDeps, resolved ? { ...input, templateId: resolved } : input)
    },

    create_holder_account(input: CreateHolderAccountInput) {
      return createHolderAccount(
        {
          create: deps.createAccount,
          getExistingAccount: () =>
            Promise.resolve(deps.config.zetrixAddress ? { zetrixAddress: deps.config.zetrixAddress, holderDid: deps.config.holderDid } : null),
          saveAccount: deps.saveAccount,
        },
        input,
      )
    },
  }
}

export type Tools = ReturnType<typeof createTools>
