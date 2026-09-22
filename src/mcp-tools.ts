/**
 * createTools — the 11 agent-facing tools.
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
 *   check_ai_birthcert_verification     — poll that session; advances a queued settlement; caches the VC once issued
 *   clear_stuck_payment_receipt         — last-resort, confirmation-gated discard of a stuck payment receipt
 *   credential_preflight                — free readiness/price check before a paid issuance
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
import { resolveTemplateAlias, deriveTemplateAttributes, validateTemplateAttributes, derivedAttributeKeys, resolvePassDesignId } from './template-aliases.js'
import type { ContractQueryInput, ContractQueryResult } from './clients/contract-query-client.js'
import type {
  RequestAiBirthcertVerificationInput,
  RequestVerificationResult,
  CheckVerificationResult,
  ClearStuckPaymentReceiptInput,
  ClearStuckPaymentReceiptResult,
} from './orchestrator/verify-ai-birthcert.js'
import { credentialPreflight, VERIFIED_AI_BIRTHCERT, type PreflightInput } from './orchestrator/preflight.js'
import { isSponsored } from './accept-selection.js'
import type { ContractQuery } from './clients/token-info-client.js'
import {
  declaredVocabulary,
  getTemplateById,
  getTemplateViaRegistry,
  readOwnerPolicies,
} from './clients/policy-read-client.js'
import { policyPreflight, unavailableResult, type DraftPolicy } from './orchestrator/policy-preflight.js'

export interface ToolDeps {
  config: {
    holderDid: string
    zetrixAddress: string
    network: string
    /** Policy Registry address; undefined where the policy contracts are not deployed. */
    policyRegistryAddress?: string
    /** Policy Template address, for the id-only lookup the Registry does not proxy. */
    policyTemplateAddress?: string
  }
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
  /** The configured MAX_PAYMENT_AMOUNT map, so preflight can report cap headroom without attempting a payment. */
  paymentCaps?: Record<string, string>
  /**
   * The RAW read-only contract seam, as distinct from `queryContract` below, which is the
   * higher-level wrapper. The policy client needs the raw form because it interprets the
   * query_rets envelope itself — specifically it reads the LAST entry, which the wrapper does not.
   */
  chainQuery: ContractQuery
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
    clearStuckReceipt: (input: ClearStuckPaymentReceiptInput) => Promise<ClearStuckPaymentReceiptResult>
  }
}

export interface WalletStatusInput {
  /** Client-held VCs to report. Omit to report whatever's in the local cache instead. */
  heldCredentials?: unknown[]
  /** Optional token symbol (e.g. "ZTX", "JMYR") or ZTP20 contract address to check its balance for the active network. */
  token?: string
  /**
   * Several tokens in one call, reported as `tokenBalances` in the order asked.
   *
   * Affordability almost always needs the fee token AND native gas together, and asking one at a
   * time is how "you hold the token but no gas" gets discovered as a second, separate dead end after
   * the first was already resolved. A failure for one token does not suppress the others — each
   * entry carries its own result or error.
   */
  tokens?: string[]
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
  // Named rather than returned inline so credential_preflight can reuse get_template_schema's
  // template resolution and chain read rather than re-implementing them.
  const tools = {
    async wallet_status(input: WalletStatusInput = {}) {
      const balances = deps.getBalances ? await deps.getBalances() : undefined
      const tokenBalance = input.token && deps.queryTokenBalance ? await deps.queryTokenBalance(input.token) : undefined
      // Sequential, not Promise.all: each lookup is one or two chain reads, and a burst of them
      // against the node buys nothing on a list this short while making rate-limit behaviour harder
      // to reason about.
      let tokenBalances: TokenBalanceResult[] | undefined
      if (input.tokens?.length && deps.queryTokenBalance) {
        tokenBalances = []
        for (const t of input.tokens) tokenBalances.push(await deps.queryTokenBalance(t))
      }
      const credentials = input.heldCredentials ?? (await loadValidCachedCredentials(deps.cache)).map((entry) => entry.vc)
      return {
        holderDid: deps.config.holderDid,
        zetrixAddress: deps.config.zetrixAddress,
        network: deps.config.network,
        credentials,
        ...(balances !== undefined ? { balances } : {}),
        ...(tokenBalance !== undefined ? { tokenBalance } : {}),
        ...(tokenBalances !== undefined ? { tokenBalances } : {}),
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
      // passDesignId is per-template (only the Basic Birthcert has one configured so far — see
      // template-aliases.ts), never a wallet-wide default: resolved fresh per call so an unrelated
      // template's issuance never carries along a mismatched pass-design id. Explicitly setting the
      // key to undefined (rather than a conditional spread) matters if deps.subscribeDeps ever
      // carries an inherited value of its own — a spread can only add the key, never clear it
      // (APP-L02), which would otherwise let a stale id leak into the signed data payload.
      const passDesignId = resolvePassDesignId(templateId, deps.config.network)
      const result = await subscribeAndIssue(
        { ...deps.subscribeDeps, passDesignId },
        { ...input, templateId, attributes },
      )
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

    /**
     * One read-only answer to "can this wallet buy this, and what does it cost?", before any
     * application field is collected. Composes the free pieces that already exist — a phase-1 quote,
     * balances, the spending cap — into a single verdict, so the balance and the cap stop being two
     * sequential dead ends.
     */
    async credential_preflight(input: PreflightInput) {
      if (input.credential === VERIFIED_AI_BIRTHCERT && !deps.verifyAiBirthcert) {
        return { credential: input.credential, ready: false, balances: [], blockers: [AI_BIRTHCERT_NOT_CONFIGURED_ERROR], notChecked: [] }
      }
      if (!deps.queryTokenBalance) {
        return {
          credential: input.credential,
          ready: false,
          balances: [],
          blockers: ['This wallet cannot read balances, so readiness cannot be confirmed.'],
          notChecked: [],
        }
      }
      return credentialPreflight(
        {
          quoteVerified: (q) => deps.verifyAiBirthcert!.request(q as RequestAiBirthcertVerificationInput) as Promise<Record<string, unknown>>,
          quoteTemplate: async (templateId) => {
            const resolved = resolveTemplateAlias(templateId, deps.config.network) ?? templateId
            return priceTemplate(deps, tools, resolved)
          },
          queryTokenBalance: deps.queryTokenBalance,
          caps: deps.paymentCaps,
        },
        input,
      )
    },

    /**
     * Free vocabulary lookup. Prefers the Registry proxy when given publisher+policyKey, because
     * the Registry holds the Template address it trusts and the proxied reply also carries
     * templateAttributeIds. Falls back to a direct Template call for an id-only lookup, which the
     * Registry does not proxy.
     */
    async get_policy_template_schema(input: { templateId?: string; publisher?: string; policyKey?: string } = {}) {
      const registry = deps.config.policyRegistryAddress
      const templateContract = deps.config.policyTemplateAddress
      const hasPair = Boolean(input.publisher && input.policyKey)

      if (!registry && !templateContract) {
        return { error: `Policy contracts are not deployed on ${deps.config.network}.` }
      }
      if (!hasPair && !input.templateId) {
        return { error: 'Provide either { publisher, policyKey } or { templateId }.' }
      }

      // An explicit templateId wins. The pair route only reaches the same contract through the
      // Registry, so honouring a caller's exact id is never worse and is what they asked for.
      const read = input.templateId
        ? templateContract
          ? await getTemplateById(input.templateId, templateContract, deps.chainQuery)
          : null
        : registry
          ? await getTemplateViaRegistry(input.publisher!, input.policyKey!, registry, deps.chainQuery)
          : null

      if (!read) {
        // Distinguish "you gave me too little" from "this network has no contract to ask"
        // (APP-L01) — telling a caller to supply what they already supplied is a dead end.
        return {
          error: input.templateId
            ? `A templateId lookup needs the policy template contract, which is not configured on ${deps.config.network}.`
            : `A publisher + policyKey lookup needs the policy registry, which is not configured on ${deps.config.network}.`,
        }
      }
      // A failed read stays a failure. Reporting it as found:false would tell the user their
      // template does not exist, which is a different and wrong instruction.
      if ('error' in read) return { error: read.detail }
      if (read.found === false) return { found: false }
      return {
        found: true,
        declared: [...declaredVocabulary(read.value).entries()].map(([name, type]) => ({ name, type })),
        // Present only on the Registry route; the id-only read does not return them. Carried
        // through rather than dropped, since it is the stated reason to prefer that route and the
        // write path needs it (APP-M06).
        ...(read.value.templateAttributeIds ? { templateAttributeIds: read.value.templateAttributeIds } : {}),
      }
    },

    /** The owner's deployed policies. 2 + N chain calls; warns above 50 keys. */
    async get_my_policy(input: { owner?: string } = {}) {
      const registry = deps.config.policyRegistryAddress
      if (!registry) return { error: `The policy registry is not deployed on ${deps.config.network}.` }
      const owner = input.owner ?? deps.config.zetrixAddress
      if (!owner) return { error: 'No owner address — pass one, or configure ZETRIX_ADDRESS.' }
      return readOwnerPolicies(owner, registry, deps.chainQuery)
    },

    /** Validate a draft policy before anything signs or pays for it. Free, signs nothing. */
    async policy_preflight(input: DraftPolicy) {
      const registry = deps.config.policyRegistryAddress
      const templateContract = deps.config.policyTemplateAddress
      const network = deps.config.network

      if (!registry && !templateContract) {
        // A full PolicyPreflightResult, NOT a bare {error}. The design states twice that
        // notChecked appears on every result, precisely so a clean preflight is never read as
        // permission to spend — and mainnet, where no contract exists, is the network where that
        // warning matters most. Returning {error} here dropped it silently (APP-C02).
        return unavailableResult(
          typeof input?.policyKey === 'string' ? input.policyKey : '',
          `Policy contracts are not deployed on ${network}, so this draft could not be checked against a template.`,
          network,
        )
      }

      return policyPreflight(
        {
          network,
          readTemplate: async (draft) =>
            // An explicit templateId wins. `draft.policyKey` is the key this policy would be
            // STORED under, which is not necessarily the template's key — preferring the pair
            // made an explicitly supplied templateId unreachable (APP-M04).
            draft.templateId && templateContract
              ? getTemplateById(draft.templateId, templateContract, deps.chainQuery)
              : draft.publisher && draft.policyKey && registry
                ? getTemplateViaRegistry(draft.publisher, draft.policyKey, registry, deps.chainQuery)
                : {
                    error: 'query_failed' as const,
                    detail: 'no template identifier supplied — pass templateId, or publisher with policyKey',
                  },
        },
        input,
      )
    },

    check_ai_birthcert_verification() {
      if (!deps.verifyAiBirthcert) {
        return { error: AI_BIRTHCERT_NOT_CONFIGURED_ERROR }
      }
      return deps.verifyAiBirthcert.check()
    },

    clear_stuck_payment_receipt(input: ClearStuckPaymentReceiptInput = {}) {
      if (!deps.verifyAiBirthcert) {
        return { error: AI_BIRTHCERT_NOT_CONFIGURED_ERROR }
      }
      return deps.verifyAiBirthcert.clearStuckReceipt(input)
    },
  }

  return tools
}

/**
 * Price a template credential for `credential_preflight`, and report its declared attributes.
 *
 * Prices via `POST /v1/vc/pay/quote`, which cannot issue. Pricing through `applyChallenge` would
 * mint a credential on a FREE template — there, `applyChallenge` *is* the real synchronous issuance
 * — making an irreversible side effect the cost of asking a question. (Since
 * subscribe_and_issue({ dryRun: true }) now prices the same safe way, so it is no longer the hazard
 * this note used to warn against; both paths now go through `/quote`.)
 *
 * It also means the price no longer depends on the caller having collected any attribute first,
 * which is the point of a preflight: MBI derives the amount from the resolved template, not from
 * the values supplied. The throwaway `data` below exists only to satisfy MBI's non-empty check and
 * is never shown to anyone or reused at issuance.
 *
 * **What the quoted amount is not.** MBI builds it from its own service-wide asset config, so it is
 * the price of credential issuance on that MBI instance rather than of this specific template —
 * every template currently quotes the same amount.
 *
 * Whether that amount will actually be charged is reported separately, by `paymentRequired`:
 * MBI issues for free when its service-wide flag is off, while `accepts[]` still carries
 * a full price. A missing flag means an older MBI without this field — unknown, not free.
 */
async function priceTemplate(
  deps: ToolDeps,
  tools: { get_template_schema: (input: { templateId: string }) => Promise<{ schema?: { required: string[]; optional: string[] }; error?: string }> },
  templateId: string,
): Promise<Record<string, unknown>> {
  const schemaResult = await tools.get_template_schema({ templateId })
  const schema = schemaResult.schema

  // A malformed templateId is already known to be unusable here, and it names the problem far more
  // precisely than MBI's generic "Template not found, inactive, or not issued by the configured
  // issuer" — so report it rather than spending a round trip to be told something vaguer.
  if (!schema && schemaResult.error) {
    return { reason: schemaResult.error }
  }

  const quoteFn = deps.subscribeDeps.mbi.quote
  if (!quoteFn) {
    return { reason: 'this wallet cannot price template credentials (MBI quote unavailable)', ...(schema ? { schema } : {}) }
  }

  let accepts
  let paymentRequired: boolean | undefined
  try {
    ;({ accepts, paymentRequired } = await quoteFn.call(deps.subscribeDeps.mbi, templateId, { preflight: 'quote-only' }))
  } catch (err) {
    return { reason: (err as Error).message, ...(schema ? { schema } : {}) }
  }

  const accept = accepts?.[0]
  if (!accept) return { reason: 'MBI quoted no payment options for this template', ...(schema ? { schema } : {}) }

  return {
    quote: {
      asset: accept.asset,
      maxAmountRequired: accept.maxAmountRequired,
      payTo: accept.payTo,
      // Stated either way: preflight reads a missing gasModel as self-pay, so silence here would be
      // indistinguishable from a deliberate "you pay the gas".
      gasModel: isSponsored(accept) ? 'sponsored' : 'self',
      // Carried through: this is the only thing in the response that
      // says whether `maxAmountRequired` will actually be charged, and preflight gates on it.
      ...(paymentRequired === undefined ? {} : { paymentRequired }),
    },
    ...(schema ? { schema } : {}),
  }
}

export type Tools = ReturnType<typeof createTools>
