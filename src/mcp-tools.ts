/**
 * createTools — the 9 agent-facing tools.
 *
 * Pure wiring: each tool composes an orchestrator + config. The concrete deps
 * (X401Wallet, x402 payer, MBI + Wallet-BE sign/pay) are built in index.ts
 * and injected here, so the tools unit-test without live services.
 *
 *   wallet_status                       — holder DID/address/network + client-supplied held VCs
 *   prove_identity                      — x401 PROOF-REQUEST → PROOF-RESPONSE
 *   pay_and_fetch                       — x402 pay-per-use
 *   subscribe_and_issue                 — MBI VC issuance (pay → settle → VC)
 *   create_holder_account               — HSM onboarding: create the account if it doesn't exist yet
 *   get_template_schema                 — free read of a template's declared attribute schema
 *   query_contract                      — read-only contract/account query
 *   request_ai_birthcert_verification   — start a myid SSIVC Verified AI Birthcert session
 *   check_ai_birthcert_verification     — poll that session; fetches + caches the VC once issued
 */

import type { X401Wallet } from 'x401-zetrix-client'
import type { VcPresentInput } from './clients/mbi-vp-adapter.js'
import { proveIdentity } from './orchestrator/prove.js'
import { payAndFetch, type PayFetch, type PayRequest } from './orchestrator/pay.js'
import { subscribeAndIssue, type SubscribeDeps, type SubscribeOpts } from './orchestrator/subscribe.js'
import type { TokenBalanceResult } from './clients/token-balance-client.js'
import { createHolderAccount, type CreateAccount, type CreateHolderAccountInput, type ExistingAccount } from './orchestrator/onboard.js'
import type { CheckActivationStatus } from './orchestrator/wait-for-activation.js'
import { type VcCacheStore, isVcValid } from './clients/vc-cache.js'
import { resolveTemplateAlias, deriveTemplateAttributes, validateTemplateAttributes, derivedAttributeKeys } from './template-aliases.js'
import type { ContractQueryInput, ContractQueryResult } from './clients/contract-query-client.js'
import type { RequestAiBirthcertVerificationInput, RequestVerificationResult, CheckVerificationResult } from './orchestrator/verify-ai-birthcert.js'

export interface ToolDeps {
  config: { holderDid: string; zetrixAddress: string; network: string }
  /** Builds a per-request X401Wallet bound to the client-supplied VC. */
  makeWallet: (present: VcPresentInput) => X401Wallet
  payer: PayFetch
  subscribeDeps: SubscribeDeps
  /** Optional chain-balance reader (e.g. via the connected zetrix-testnet MCP). */
  getBalances?: () => Promise<unknown>
  /**
   * Resolves a token symbol to its balance for the active network — backs wallet_status({ token }).
   * `balance` is in the asset's raw base units; `decimals` (null when unreadable) is what the
   * caller needs to render it, e.g. 473999900 with decimals 6 is 473.9999.
   */
  queryTokenBalance?: (token: string) => Promise<TokenBalanceResult>
  /** Read-only contract/account query, backing the query_contract tool. */
  queryContract: (input: ContractQueryInput) => Promise<ContractQueryResult>
  createAccount: CreateAccount
  /**
   * Persists a freshly created account locally so create_holder_account survives a restart.
   * The session's HSM password is added by the wiring in index.ts, not passed through here —
   * no credential crosses the tool boundary.
   */
  saveAccount: (account: ExistingAccount & { label?: string; purpose?: string }) => Promise<void>
  /** Ground-truth on-chain activation check — backs the polling create_holder_account does after minting a new account. */
  checkActivationStatus: CheckActivationStatus
  sleep: (ms: number) => Promise<void>
  /**
   * Local cache of previously-issued VCs (same store subscribe_and_issue writes to).
   * Optional — when omitted, wallet_status/prove_identity require the caller to pass
   * credentials explicitly, matching the original client-held-only behaviour.
   */
  cache?: VcCacheStore
  /**
   * Drives myid's SSIVC AI Birthcert session API. Optional in this type only so tests can omit
   * it — index.ts always wires it in practice; there is no config gate. Session creation is
   * x402-payment-gated (self-pay, capped by MAX_PAYMENT_AMOUNT), not bearer-token-gated.
   */
  verifyAiBirthcert?: {
    request: (input: RequestAiBirthcertVerificationInput) => Promise<RequestVerificationResult>
    check: () => Promise<CheckVerificationResult>
  }
}

export interface WalletStatusInput {
  /** Client-held VCs to report. Omit to report whatever's in the local cache instead. */
  heldCredentials?: unknown[]
  /** Optional token symbol (e.g. "ZTX", "JMYR") to check its balance for the active network. */
  token?: string
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

/** Shared by both AI Birthcert verification tools when verifyAiBirthcert isn't wired (see ToolDeps) — the live wallet (index.ts) wires it whenever SSIVC_BASE_URL resolves (always on testnet; on mainnet only once set explicitly, APP-M04). */
const AI_BIRTHCERT_NOT_CONFIGURED_ERROR =
  'AI Birthcert verification is not configured on this wallet. On mainnet this is expected until ' +
  'SSIVC_BASE_URL is set explicitly (the mainnet host was never confirmed reachable — APP-M04); on ' +
  'testnet it means verifyAiBirthcert was not wired at all.'

export function createTools(deps: ToolDeps) {
  return {
    async wallet_status(input: WalletStatusInput = {}) {
      const balances = deps.getBalances ? await deps.getBalances() : undefined
      const tokenBalance = input.token && deps.queryTokenBalance ? await deps.queryTokenBalance(input.token) : undefined
      const credentials = input.heldCredentials ?? (await loadValidCachedCredentials(deps.cache)).map((entry) => entry.vc)
      return {
        holderDid: deps.config.holderDid,
        zetrixAddress: deps.config.zetrixAddress,
        network: deps.config.network,
        credentials,
        ...(balances !== undefined ? { balances } : {}),
        ...(tokenBalance !== undefined ? { tokenBalance } : {}),
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

    async subscribe_and_issue(input: SubscribeOpts) {
      const resolved = resolveTemplateAlias(input.templateId, deps.config.network)
      const templateId = resolved ?? input.templateId
      const attributes = deriveTemplateAttributes(templateId, deps.config.network, input.attributes ?? {})
      const errors = validateTemplateAttributes(templateId, deps.config.network, attributes)
      if (errors.length > 0) {
        return { issued: false, reason: errors.join('; ') }
      }
      const result = await subscribeAndIssue(deps.subscribeDeps, { ...input, templateId, attributes })
      if (!result.schema) return result
      // The caller never needs to know about a key the wallet fills in for them — agentDid is
      // always auto-filled from the wallet's own holderDid when a template declares it, and a
      // named alias (e.g. "id" derived from "agentUsername" for AI Birthcert) may auto-derive
      // others. Hide both from the schema surfaced back to the caller/user.
      const hidden = new Set(['agentDid', ...derivedAttributeKeys(templateId, deps.config.network)])
      return {
        ...result,
        schema: {
          required: result.schema.required.filter((k) => !hidden.has(k)),
          optional: result.schema.optional.filter((k) => !hidden.has(k)),
        },
      }
    },

    /**
     * Free schema lookup. Previously the only way to ask "what does this template need?" was
     * subscribe_and_issue({ dryRun: true }) — a tool whose name reads as "this charges money", so
     * an agent reasoning about required fields had no obvious reason to reach for it. Reported
     * live: an agent discovered a newly-required attribute only by failing an issuance first.
     */
    async get_template_schema(input: { templateId: string }) {
      const resolved = resolveTemplateAlias(input.templateId, deps.config.network)
      const templateId = resolved ?? input.templateId
      if (!/^did:zid:/.test(templateId)) {
        return {
          templateId,
          error:
            `templateId must be a did:zid:... credential-definition id or a known template name, ` +
            `got "${input.templateId}"`,
        }
      }
      const fields = deps.subscribeDeps.resolveTemplateFields
        ? await deps.subscribeDeps.resolveTemplateFields(templateId)
        : null
      if (!fields) {
        // Distinguish "no attributes" from "couldn't look it up" — an empty schema would read as
        // "this template needs nothing", which would send the caller on to pay for a doomed issue.
        return {
          templateId,
          error: `template schema could not be read from chain for ${templateId} (unknown/inactive template, or node unavailable)`,
        }
      }
      const hidden = new Set(['agentDid', ...derivedAttributeKeys(templateId, deps.config.network)])
      return {
        templateId,
        schema: {
          required: fields.required.filter((k) => !hidden.has(k)),
          optional: fields.allKeys.filter((k) => !fields.required.includes(k) && !hidden.has(k)),
        },
      }
    },

    query_contract(input: ContractQueryInput) {
      return deps.queryContract(input)
    },

    create_holder_account(input: CreateHolderAccountInput) {
      return createHolderAccount(
        {
          create: deps.createAccount,
          getExistingAccount: () =>
            Promise.resolve(deps.config.zetrixAddress ? { zetrixAddress: deps.config.zetrixAddress, holderDid: deps.config.holderDid } : null),
          saveAccount: deps.saveAccount,
          checkActivationStatus: deps.checkActivationStatus,
          sleep: deps.sleep,
        },
        input,
      )
    },

    request_ai_birthcert_verification(input: RequestAiBirthcertVerificationInput) {
      if (!deps.verifyAiBirthcert) {
        return { error: AI_BIRTHCERT_NOT_CONFIGURED_ERROR }
      }
      return deps.verifyAiBirthcert.request(input)
    },

    check_ai_birthcert_verification() {
      if (!deps.verifyAiBirthcert) {
        return { error: AI_BIRTHCERT_NOT_CONFIGURED_ERROR }
      }
      return deps.verifyAiBirthcert.check()
    },
  }
}

export type Tools = ReturnType<typeof createTools>
