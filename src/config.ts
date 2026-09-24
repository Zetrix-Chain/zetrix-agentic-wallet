/**
 * Environment → AgenticWalletConfig.
 *
 * Reconciled against the real dependencies:
 *  - Wallet BE holds the holder Ed25519 key; all signing routes through it (HSM password).
 *  - MBI RS issues the VC and derives the BBS+ VP proof server-side — needs only its own base URL.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parsePaymentCaps } from './payment-guard.js'
import type { GasPreference } from './accept-selection.js'

export interface AgenticWalletConfig {
  /** Wallet BE base URL — HSM holder-key sign (POST /wallet/hsm/sign-blob). Auto-derived from network when not set. */
  walletBeUrl: string
  /**
   * OID4VP verifier base URL override — x401 presentation fetch/submit. Optional: when unset,
   * the x401 SDK itself derives it from `network` — testnet -> sandbox, mainnet -> prod.
   */
  oid4vpBaseUrl?: string
  /** MBI RS base URL — x402 VC issuance (POST /v1/vc/pay/apply). Auto-derived from network when not set. */
  mbiBaseUrl: string
  /** Zetrix network, e.g. "zetrix:testnet" | "zetrix:mainnet". */
  network: string
  /**
   * Directory holding this wallet's own state — `account.json` and `vc-cache/<scope>`.
   * Defaults to `~/.agentic-wallet-mcp`. Configurable so a plugin-hosted wallet can keep
   * state inside its own data directory rather than a shared home directory. That matters when one
   * machine hosts more than one wallet: this directory's `account.json` holds the HSM password, so two
   * wallets sharing a home directory would read each other's credentials, and whichever started last
   * would overwrite the stored identity.
   */
  stateDir: string
  /**
   * Holder Zetrix address (the HSM account that pays + holder-binds). Optional — omit on
   * first run (only `hsmPassword` set) to have the MCP create a new HSM account at startup
   * (see `orchestrator/resolve-holder.ts`).
   */
  zetrixAddress?: string
  /**
   * Holder DID (used by x401 prove / VC MCP vp_create). Optional — when `zetrixAddress` is
   * set but this isn't, the MCP derives it at startup from the account's public key (a
   * Wallet BE sign-message call). Ignored (recomputed) when `zetrixAddress` is unset.
   */
  holderDid?: string
  /** HSM password — required, both to sign and (when `zetrixAddress` is unset) to create a new HSM account at startup. Sensitive. */
  hsmPassword: string
  /** Zetrix RPC node host — auto-derived from network when not set. */
  nodeHost: string
  /** Zetrix RPC node port — empty when using default DNS-mapped hosts. */
  nodePort: string
  /**
   * Template-registry account address — the on-chain account whose metadata holds every credential
   * template (`template__<templateId>` → applyFormat). Fixed per network; auto-derived when not set.
   * `subscribe_and_issue` reads it to check a template's required attributes before paying.
   */
  templateRegistryAddress: string
  /**
   * Policy Registry contract address — the entry point for every policy read (`getPolicyContract`,
   * `getPolicy`, and the proxied `getTemplate`). `undefined` on mainnet, where the Registry is not
   * deployed; the policy tools then report the network as unsupported instead of querying.
   */
  policyRegistryAddress?: string
  /**
   * Policy Template contract address — needed only for `getTemplateById`, which the Registry does
   * not proxy. `undefined` on mainnet for the same reason as {@link policyRegistryAddress}.
   */
  policyTemplateAddress?: string
  /** ZID resolver base URL (issuer DID → BBS+/Ed25519 verification keys) — auto-derived from network when not set. */
  zidResolverBaseUrl: string
  /**
   * Per-asset x402 auto-pay ceiling, asset -> max raw-unit string, `"*"` as fallback.
   * Defaults to `{ "*": "0" }` — every payment is refused until a cap is set explicitly.
   * See src/payment-guard.ts.
   */
  maxPaymentAmount: Record<string, string>
  /**
   * The cap for credential issuance specifically (`subscribe_and_issue`, Verified AI Birthcert).
   * Identical to `maxPaymentAmount` whenever `MAX_PAYMENT_AMOUNT` is set; when it is not, this one
   * permits the credential fee on mainnet while `maxPaymentAmount` keeps `pay_and_fetch`
   * fail-closed there. See `defaultCredentialIssuanceCaps`.
   */
  credentialIssuanceCaps: Record<string, string>
  /**
   * myid's SSIVC "AI Birthcert" session API base URL — backs request_ai_birthcert_verification /
   * check_ai_birthcert_verification. Auto-derived on testnet only (the only host ever actually
   * reached and confirmed live); undefined on mainnet unless SSIVC_BASE_URL is set explicitly
   * (APP-M04 — the mainnet host, {@link UNVERIFIED_MAINNET_SSIVC_BASE_URL}, was an assumption by
   * analogy, never tested). Unset means the AI Birthcert verification tools report themselves as
   * not configured rather than being wired against an unconfirmed endpoint.
   */
  ssivcBaseUrl?: string
  /**
   * The Verified AI Birthcert's on-chain templateId, distinct from the Basic Birthcert's.
   * Auto-derived on testnet only (confirmed on-chain, see deriveAiBirthcertVerifiedTemplateId);
   * undefined on mainnet unless AI_BIRTHCERT_VERIFIED_TEMPLATE_ID is set explicitly (APP-M04 — a
   * chain read at the mainnet registry address returned `result: null`, so the id was never
   * confirmed). Unset means check_ai_birthcert_verification reports a cacheError instead of
   * caching a mainnet credential under a possibly-wrong key.
   */
  aiBirthcertVerifiedTemplateId?: string
  /** Which side pays network gas when the resource server offers a choice. Default 'sponsored'. */
  gasPreference: GasPreference
  /** How many times to re-poll SSIVC for a queued sponsored settlement before giving up. */
  maxSettlementAttempts: number
  /** Total wall-clock wait for a queued settlement, in ms. Bounds what the attempt cap cannot. */
  settlementWaitBudgetMs: number
  /**
   * How old an unconfirmed settlement must be before the wallet stops calling it "still settling"
   * and calls it permanently stuck, in ms.
   *
   * SSIVC returns the same `status_code 69` for a settlement two minutes old and one three weeks
   * old, so this age — not their code — is what separates "check back shortly" from "this is not
   * coming back, and the fee was most likely already taken". Measured basis for the default: a
   * healthy settlement completed in under a second on 2026-09-21, and that incident's blob
   * was queued at 11:07:55 and reported EXPIRED by the facilitator at 11:28:31 — 20m36s, their
   * payment window. (Not to be confused with the wallet's own ~20 minutes, which was its old
   * blocking loop, 20 attempts x 60s. Two unrelated clocks that happen to land near each other.)
   * A full day is far past any genuine in-flight case.
   */
  settlementStuckAfterMs: number
}

function stripTrailingSlash(v: string): string {
  return v.replace(/\/+$/, '')
}

function deriveNodeHost(network: string): string {
  return network.includes('testnet') ? 'test-node.zetrix.com' : 'node.zetrix.com'
}

function deriveZidResolverBaseUrl(network: string): string {
  return network.includes('testnet')
    ? 'https://zid-resolver-sandbox.zetrix.com'
    : 'https://zid-resolver.zetrix.com'
}

function deriveWalletBeUrl(network: string): string {
  return network.includes('testnet')
    ? 'https://wallet-api-sandbox.zetrix.com/server'
    : 'https://wallet-api.zetrix.com/server'
}

function deriveMbiBaseUrl(network: string): string {
  return network.includes('testnet') ? 'https://mbi-vc-sandbox.zetrix.com' : 'https://mbi-vc.zetrix.com'
}

function deriveTemplateRegistryAddress(network: string): string {
  return network.includes('testnet')
    ? 'ZTX3JszqPgRUx743SAp7q7zURfjvkWuH2FMEz'
    : 'ZTX3GqJM1U6ifMPonwD4fGvrgoTKJua7b2cKX'
}

/**
 * Policy Registry — the entry point for every policy read. The testnet address was verified live
 * (2026-09-18): the account exists, its `query()` dispatcher exposes getPolicyContract / getPolicy /
 * getTemplate, and a live call returned a well-formed reply.
 *
 * Mainnet returns undefined because the Registry is NOT DEPLOYED there — the same APP-M04 honesty
 * convention as {@link deriveSsivcBaseUrl}. A guessed address would make every read fail in a way
 * that reads as "you have no policy" rather than "this network has no policy system at all", which
 * is precisely the confusion the three-state read result exists to prevent.
 *
 * The field guide also lists a separate local/dev deployment. Those addresses are deliberately NOT
 * recorded here — POLICY_REGISTRY_ADDRESS is how local testing reaches them, so this file never
 * carries a second environment someone could resolve to by accident.
 */
export function derivePolicyRegistryAddress(network: string): string | undefined {
  return isTestnet(network) ? 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk' : undefined
}

/**
 * Policy Template contract. Used ONLY for `getTemplateById` — the Registry proxies `getTemplate`
 * but NOT `getTemplateById`, so the id-only lookup has to call the Template contract directly.
 *
 * Every `{publisher, policyKey}` lookup should still go through the Registry proxy, because the
 * Registry already holds the Template address it trusts; routing through it removes any chance of
 * reading a Template contract the Registry does not recognise. Verified live (2026-09-18) as the
 * address the staging Registry itself proxies to.
 */
export function derivePolicyTemplateAddress(network: string): string | undefined {
  return isTestnet(network) ? 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5' : undefined
}

/**
 * The mainnet SSIVC host, by analogy with the other services' testnet/mainnet naming — but
 * UNVERIFIED (APP-M04, 2026-08-17): nobody has actually reached it and gotten a real response.
 * Kept as a named constant, not inlined, so confirming it later is a one-line change — flip
 * deriveSsivcBaseUrl's mainnet branch to return this — instead of someone having to rediscover
 * the URL from scratch. Do NOT wire this into deriveSsivcBaseUrl's return value until confirmed;
 * SSIVC_BASE_URL is the correct way to opt in before that happens.
 */
export const UNVERIFIED_MAINNET_SSIVC_BASE_URL = 'https://verifyid-api.zetrix.com/api'

/**
 * myid's SSIVC "AI Birthcert" session API. Testnet confirmed reachable (fetched and read in full
 * 2026-08-13). Returns undefined on mainnet so the caller fails closed rather than wiring the
 * feature against {@link UNVERIFIED_MAINNET_SSIVC_BASE_URL}; set SSIVC_BASE_URL explicitly once
 * that host is confirmed reachable.
 */
function deriveSsivcBaseUrl(network: string): string | undefined {
  return network.includes('testnet') ? 'https://ssivc-api-uat.myegdev.com/api' : undefined
}

/**
 * `AI_BIRTHCERT_VERIFIED` templateId, deployed 2026-08-05 (`TEMPLATE_ONCHAIN_REFERENCE.md` §2).
 * Testnet id confirmed on-chain. The mainnet id is UNVERIFIED — a chain read at the mainnet
 * registry address returned `result: null` — so this returns undefined on mainnet (APP-M04,
 * 2026-08-17) rather than a guessed id a mainnet credential could get cached under incorrectly.
 * Set AI_BIRTHCERT_VERIFIED_TEMPLATE_ID explicitly once the mainnet registry account is confirmed.
 */
function deriveAiBirthcertVerifiedTemplateId(network: string): string | undefined {
  return network.includes('testnet') ? 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80' : undefined
}

/**
 * Symbol → per-network ZTP20 contract address, for standalone balance lookups
 * (e.g. wallet_status({ token: 'JMYR' })) independent of any active x402 challenge.
 * Extend this map to register additional known tokens.
 */
const TOKEN_REGISTRY: Record<string, { testnet: string; mainnet: string }> = {
  JMYR: { testnet: 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b', mainnet: 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr' },
}

/**
 * The GENERAL spending cap applied when `MAX_PAYMENT_AMOUNT` is unset — the ceiling on
 * `pay_and_fetch`, which auto-pays whatever an arbitrary URL demands behind a 402.
 *
 * **Mainnet stays refuse-all here, deliberately.** `pay_and_fetch` is the confused-deputy surface:
 * a prompt-injected or misled agent can point it at a hostile endpoint, and a permissive default
 * would auto-pay real value with nobody having configured anything. That is the attack
 * `payment-guard.ts` exists to close, and no default should reopen it. Testnet keeps the credential
 * fee allowance because the funds are worthless there.
 *
 * The narrower credential allowance lives in {@link defaultCredentialIssuanceCaps} — see its note
 * for why the two are separate.
 */
function defaultPaymentCaps(network: string): Record<string, string> {
  const jmyr = resolveTokenAddress('JMYR', network)
  return isTestnet(network) && jmyr ? { [jmyr]: '1000000', '*': '0' } : { '*': '0' }
}

/**
 * The cap applied to CREDENTIAL ISSUANCE when `MAX_PAYMENT_AMOUNT` is unset — `subscribe_and_issue`
 * and the Verified AI Birthcert flow, both of which pay a known issuer for a known credential.
 *
 * Out of the box the cap refused everything, so the first credential a user asked for failed on a
 * limit nobody had told them about. Both networks now allow exactly the AI Birthcert fee (1 JMYR)
 * under JMYR's per-network address, and nothing else.
 *
 * **Why this is separate from {@link defaultPaymentCaps}.** The product decision was that a first
 * credential should work out of the box on mainnet too — the requirement's own words are "so user
 * can apply the first VC without any issue". Granting that through the shared cap would also have
 * handed the same allowance to `pay_and_fetch` against any URL on earth, which nobody asked for and
 * which is the one direction that carries real risk. Scoping it to issuance delivers the ask
 * without reopening that surface.
 *
 * Still true, and worth knowing: the cap is enforced PER CALL with no cumulative ceiling, so an
 * unconfigured mainnet wallet can pay this fee more than once. An explicit `MAX_PAYMENT_AMOUNT`
 * overrides BOTH defaults and remains the way to lock a wallet down.
 *
 * The amount is the fee EXACTLY, with no headroom. Headroom would let the server raise its price and
 * be paid the higher amount silently; an exact cap turns a price rise into a visible, explainable
 * block that a human decides on. Note the 1 JMYR figure was verified live against SSIVC UAT; the
 * mainnet fee is assumed to match and has not been confirmed against a mainnet quote.
 */
function defaultCredentialIssuanceCaps(network: string): Record<string, string> {
  const jmyr = resolveTokenAddress('JMYR', network)
  return jmyr ? { [jmyr]: '1000000', '*': '0' } : { '*': '0' }
}

/**
 * The only accepted `ZETRIX_NETWORK` values.
 *
 * Validated rather than pattern-matched because every per-network derivation in this file asks
 * `includes('testnet')` and treats everything else as mainnet. That made an unrecognised value —
 * `zetrix:tesnet`, or merely `ZETRIX:TESTNET` — silently resolve to MAINNET addresses, which since
 * the credential allowance exists on mainnet would hand a typo a live spending allowance. Failing
 * at startup is the only safe reading of a network name nobody recognises.
 */
const KNOWN_NETWORKS = ['zetrix:testnet', 'zetrix:mainnet'] as const

/**
 * Above this, SETTLEMENT_WAIT_BUDGET_MS starts reinstating the long blocking call the 90s default
 * exists to prevent, so it is warned about on stderr (APP-L02). Not a clamp — see the loader.
 */
const SETTLEMENT_WAIT_BUDGET_WARN_MS = 600_000

function isTestnet(network: string): boolean {
  return network.includes('testnet')
}

export function resolveTokenAddress(symbol: string, network: string): string | undefined {
  const entry = TOKEN_REGISTRY[symbol.toUpperCase()]
  if (!entry) return undefined
  return isTestnet(network) ? entry.testnet : entry.mainnet
}

export function loadConfig(env: NodeJS.ProcessEnv): AgenticWalletConfig {
  const req = (key: string, hint?: string): string => {
    const v = env[key]
    if (!v || !v.trim()) throw new Error(`agentic-wallet-mcp: missing required env ${key}${hint ? ` — ${hint}` : ''}`)
    return v.trim()
  }
  const opt = (key: string): string | undefined => {
    const v = env[key]
    return v && v.trim() ? v.trim() : undefined
  }

  // Testnet by default so a zero-configuration start is safe: mainnet, like a non-zero
  // payment cap, requires a deliberate act. An unrecognised value is rejected rather than
  // defaulted — see KNOWN_NETWORKS for why guessing is unsafe here.
  const network = opt('ZETRIX_NETWORK') ?? 'zetrix:testnet'
  if (!(KNOWN_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(
      `agentic-wallet-mcp: unrecognised ZETRIX_NETWORK "${network}" — expected one of ${KNOWN_NETWORKS.join(', ')}. ` +
        `Values are matched exactly and are case-sensitive; anything unrecognised would otherwise resolve to ` +
        `MAINNET addresses and grant a real spending allowance.`,
    )
  }

  const oid4vpBaseUrlOverride = opt('OID4VP_BASE_URL')

  const explicitCaps = parsePaymentCaps(opt('MAX_PAYMENT_AMOUNT'), {
    resolveSymbol: (symbol) => resolveTokenAddress(symbol, network),
    onWarn: (message) => process.stderr.write(`agentic-wallet-mcp: ${message}\n`),
  })

  return {
    walletBeUrl: stripTrailingSlash(opt('WALLET_BE_URL') ?? deriveWalletBeUrl(network)),
    oid4vpBaseUrl: oid4vpBaseUrlOverride ? stripTrailingSlash(oid4vpBaseUrlOverride) : undefined,
    mbiBaseUrl: stripTrailingSlash(opt('MBI_BASE_URL') ?? deriveMbiBaseUrl(network)),
    network,
    stateDir: stripTrailingSlash(opt('ZETRIX_WALLET_STATE_DIR') ?? join(homedir(), '.agentic-wallet-mcp')),
    zetrixAddress: opt('ZETRIX_ADDRESS'),
    holderDid: opt('HOLDER_DID'),
    hsmPassword: req(
      'HSM_PASSWORD',
      'the server is normally started through main(), which generates a password when none exists — ' +
        'reaching this error means loadConfig was called directly without one',
    ),
    nodeHost: opt('ZETRIX_NODE_HOST') ?? deriveNodeHost(network),
    nodePort: opt('ZETRIX_NODE_PORT') ?? '',
    templateRegistryAddress: opt('ZETRIX_TEMPLATE_REGISTRY_ADDRESS') ?? deriveTemplateRegistryAddress(network),
    zidResolverBaseUrl: stripTrailingSlash(opt('ZID_RESOLVER_BASE_URL') ?? deriveZidResolverBaseUrl(network)),
    policyRegistryAddress: opt('POLICY_REGISTRY_ADDRESS') ?? derivePolicyRegistryAddress(network),
    policyTemplateAddress: opt('POLICY_TEMPLATE_ADDRESS') ?? derivePolicyTemplateAddress(network),
    // Fail closed: an unset cap means "spend nothing", not "spend anything". A wallet that starts
    // with no configuration at all must not be able to auto-pay a hostile x402 challenge. Raising
    // it is a deliberate act.
    //
    // An explicit MAX_PAYMENT_AMOUNT governs BOTH caps below — a user who sets a limit means it
    // everywhere. Only the defaults differ, and only because the two surfaces carry different risk.
    maxPaymentAmount: explicitCaps ?? defaultPaymentCaps(network),
    credentialIssuanceCaps: explicitCaps ?? defaultCredentialIssuanceCaps(network),
    ssivcBaseUrl: (() => {
      const v = opt('SSIVC_BASE_URL') ?? deriveSsivcBaseUrl(network)
      return v ? stripTrailingSlash(v) : undefined
    })(),
    aiBirthcertVerifiedTemplateId: opt('AI_BIRTHCERT_VERIFIED_TEMPLATE_ID') ?? deriveAiBirthcertVerifiedTemplateId(network),
    // Unrecognised values fall back to the default rather than throwing — a typo here must not
    // brick startup, and 'sponsored' is always attemptable thanks to Task 5's self-pay fallback.
    gasPreference: env.GAS_PREFERENCE === 'self' ? 'self' : 'sponsored',
    maxSettlementAttempts: (() => {
      const attempts = Number(env.MAX_SETTLEMENT_ATTEMPTS)
      return Number.isInteger(attempts) && attempts > 0 ? attempts : 20
    })(),
    // APP-L02: deliberately NOT clamped to a ceiling. This is the ops escape hatch for a slow
    // paymaster, and a hard cap turns a tuning knob into a wall with no way around it. Setting it
    // very high cannot restore worse-than-before behaviour on its own either: maxSettlementAttempts
    // still bounds the loop independently, so the old ~20-minute block needs BOTH knobs
    // raised, deliberately.
    //
    // It IS warned about, though, on the same stderr channel parsePaymentCaps already uses above —
    // an earlier version of this comment claimed no logging channel existed, which was simply wrong.
    settlementWaitBudgetMs: (() => {
      const ms = Number(env.SETTLEMENT_WAIT_BUDGET_MS)
      const budget = Number.isInteger(ms) && ms > 0 ? ms : 90_000
      if (budget > SETTLEMENT_WAIT_BUDGET_WARN_MS) {
        process.stderr.write(
          `agentic-wallet-mcp: SETTLEMENT_WAIT_BUDGET_MS is ${budget}ms — request_ai_birthcert_verification ` +
            `and check_ai_birthcert_verification can each block a caller for that long (the budget bounds ` +
            `both). Above ~${SETTLEMENT_WAIT_BUDGET_WARN_MS}ms this reinstates the long blocking call the ` +
            `90s default exists to prevent. Intended for temporary debugging only.\n`,
        )
      }
      return budget
    })(),
    // Not clamped and not warned about: unlike the wait budget, nothing blocks on this. But it is NOT
    // just wording any more. It decides when a receipt counts as stuck, and a receipt that is not stuck
    // yet is REFUSED by both discard routes (discardStuckReceiptAndPayFresh and
    // clear_stuck_payment_receipt) — nothing discarded, nothing paid. So a very LOW value makes the
    // discard-and-pay-a-second-fee path available sooner, after a shorter wait for a settlement that may
    // still resolve. The default (24h) is the safe setting; lower it only deliberately, for an operator
    // or a test. It is not agent-reachable. Very high just means the wallet keeps saying "check back"
    // and never offers a fresh start. The wallet never pays again or discards on its own either way.
    settlementStuckAfterMs: (() => {
      const ms = Number(env.SETTLEMENT_STUCK_AFTER_MS)
      return Number.isInteger(ms) && ms > 0 ? ms : 86_400_000
    })(),
  }
}
