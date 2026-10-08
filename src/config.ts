/**
 * Environment → AgenticWalletConfig.
 *
 * Reconciled against the real dependencies:
 *  - Wallet BE holds the holder Ed25519 key; all signing routes through it (HSM password).
 *  - MBI RS issues the VC and derives the BBS+ VP proof server-side — needs only its own base URL.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { checkVerifyLinkTemplate } from './verify-link-template.js'
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
  /**
   * The publisher whose templates this wallet offers by default.
   *
   * Without one, a wallet with no deployed policy cannot find a template at all: a template id
   * is derived from the publisher, and the only other place the wallet could learn one was
   * "inside a deployed policy", which a first-time user does not have. The agent ended up asking
   * the user for an address the user has no way to know.
   *
   * Derived per network like the other policy addresses, and absent where the policy module is
   * not deployed — a guessed publisher on such a network would read as "this publisher has no
   * templates" rather than "there is no policy system here". POLICY_TEMPLATE_PUBLISHER overrides.
   */
  policyTemplatePublisher?: string
  /**
   * Base URL of the Policy DECISION service (ms-zetrix). Separate from every other URL here
   * because it is the one endpoint the wallet cannot currently reach: `/policy/**` carries no
   * entry in the server's `PUBLIC_PATHS`, so it inherits `anyRequest().authenticated()`, and this
   * wallet holds no BaaS token. `undefined` until POLICY_DECISION_URL is set, which is how a
   * developer points it at a reachable instance today.
   */
  policyDecisionUrl?: string
  /**
   * The link create_verification_qr hands the user, with `{referenceId}` where the MBI reference id goes —
   * MyID's universal link, so a phone without the app is sent to the store. On testnet it defaults to the UAT link (see
   * deriveMyidVerifyLinkTemplate). On mainnet there is **no default** until MyID's production side is verified, and the tool
   * then refuses before it creates anything on MBI. MYID_VERIFY_LINK_TEMPLATE overrides either.
   */
  myidVerifyLinkTemplate?: string
  /**
   * `Authorization` header value for the decision service, when one is available. Optional on
   * purpose: with none, the call is still made and the 401 is reported as "we could not tell",
   * which is the honest answer and a far better failure than refusing to try.
   */
  policyDecisionAuth?: string
  /**
   * Base URL of the pay-gated policy WRITE endpoint.
   *
   * Public by construction: the two paths live under `/pay/**`, which is gated by on-chain
   * payment rather than by a JWT, and a bug exposed exactly
   * `/api/pay/policy/adopt-template` and `…/collect` through ms-public-proxy on 2026-09-24 —
   * two exact paths, deliberately not a `/policy/**` wildcard.
   *
   * Derived per network like every other service URL. Absent on a network where the policy
   * module is not deployed, so the tool refuses with "nothing was paid" rather than failing
   * against a guessed host.
   */
  policyWriteUrl?: string
  /** ZID resolver base URL (issuer DID → BBS+/Ed25519 verification keys) — auto-derived from network when not set. */
  zidResolverBaseUrl: string
  /**
   * Per-asset x402 auto-pay ceiling, asset -> max raw-unit string, `"*"` as fallback.
   * Defaults to 1 JMYR per call (the JMYR contract of the active network) and refuses every other asset; an explicit
   * `MAX_PAYMENT_AMOUNT` replaces it. Mainnet now has the same default as testnet.
   * See src/payment-guard.ts.
   */
  maxPaymentAmount: Record<string, string>
  /**
   * True when `MAX_PAYMENT_AMOUNT` was set. An explicit cap is the user's own limit and is never bypassed by a spending
   * policy; only the DEFAULT caps stand aside for an asset the policy governs.
   */
  paymentCapsExplicit: boolean
  /**
   * The cap for credential issuance specifically (`subscribe_and_issue`, Verified AI Birthcert).
   * Identical to `maxPaymentAmount` whenever `MAX_PAYMENT_AMOUNT` is set. When it is not, the two defaults are now the
   * same too (1 JMYR per call); they were different on mainnet, where `maxPaymentAmount` kept `pay_and_fetch`
   * fail-closed. See `defaultCredentialIssuanceCaps`.
   */
  credentialIssuanceCaps: Record<string, string>
  /**
   * myid's SSIVC "AI Birthcert" session API base URL — backs request_ai_birthcert_verification /
   * check_ai_birthcert_verification. Auto-derived on testnet only (the only host ever actually
   * reached and confirmed live); undefined on mainnet unless SSIVC_BASE_URL is set explicitly
   * (the mainnet host, {@link UNVERIFIED_MAINNET_SSIVC_BASE_URL}, was an assumption by
   * analogy, never tested). Unset means the AI Birthcert verification tools report themselves as
   * not configured rather than being wired against an unconfirmed endpoint.
   */
  ssivcBaseUrl?: string
  /**
   * The Verified AI Birthcert's on-chain templateId, distinct from the Basic Birthcert's.
   * Auto-derived on testnet only (confirmed on-chain, see deriveAiBirthcertVerifiedTemplateId);
   * undefined on mainnet unless AI_BIRTHCERT_VERIFIED_TEMPLATE_ID is set explicitly (a
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

/**
 * MyID's production universal link, as MyID stated it. UNVERIFIED: not read from the host, and not deployed when it was recorded.
 * Kept as a named constant so confirming it later is a one-line change (return it from deriveMyidVerifyLinkTemplate's mainnet
 * branch) and so a test pins the exact string.
 */
export const UNVERIFIED_MAINNET_MYID_VERIFY_LINK_TEMPLATE = 'https://myid-verifier.zetrix.com/api/agentic-verify?referenceId={referenceId}'

/**
 * MyID's universal link for create_verification_qr, per network.
 *
 * TESTNET (UAT): read from the MyID app's own registration, not from a description of it. ssivc-api-uat.myegdev.com publishes
 * an apple-app-site-association that claims exactly `/api/agentic-verify` with a `referenceId` query (and an assetlinks.json
 * for com.zetrix.myid.uat), and serves a "open this on your phone" page at that address. The first link the wallet was given,
 * `/v1/agent-verification/{referenceId}`, is claimed by neither: the phone opened the browser and the server answered 404.
 *
 * MAINNET: deliberately none, so create_verification_qr refuses before it creates anything on MBI rather than store a presentation
 * behind a link nobody can open. MyID has stated `https://myid-verifier.zetrix.com/api/agentic-verify?referenceId={referenceId}`
 * (see {@link UNVERIFIED_MAINNET_MYID_VERIFY_LINK_TEMPLATE}), but their production side was not deployed and the host sits behind a
 * Cloudflare browser check, so its association files could not be read. Do NOT wire the constant into this function's return
 * value until the host publishes apple-app-site-association and assetlinks.json for the production app and serves the "open on your
 * phone" page. MYID_VERIFY_LINK_TEMPLATE is the way to opt in before then.
 */
function deriveMyidVerifyLinkTemplate(network: string): string | undefined {
  return network.includes('testnet') ? 'https://ssivc-api-uat.myegdev.com/api/agentic-verify?referenceId={referenceId}' : undefined
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
 * Mainnet returns undefined because the Registry is NOT DEPLOYED there — the same honesty
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
/**
 * The pay-gated policy write host, through ms-public-proxy.
 *
 * Testnet is the sandbox proxy, which is where the flow was verified end to end on 2026-09-22.
 * Mainnet returns undefined for the same reason {@link derivePolicyRegistryAddress} does: the
 * policy module is NOT enabled there (`POLICY_REGISTRY_ADDRESS` is empty in the prod profile), so
 * a guessed host would turn "this network has no policy system" into a connection error — and on
 * a write path, a confusing failure is one a user may respond to by trying again and paying.
 */
export function derivePolicyWriteUrl(network: string): string | undefined {
  return isTestnet(network) ? 'https://public-api-sandbox.zetrix.com/api' : undefined
}

/**
 * The publisher of the two deployed testnet templates, `native-v1` and `ztp20-v1`.
 *
 * Read from chain 2026-09-30: `listTemplateKeys` for this address returns both keys, and both
 * derived ids resolve through `getTemplateById`. Undefined off testnet for the same reason as
 * {@link derivePolicyRegistryAddress}.
 */
export function derivePolicyTemplatePublisher(network: string): string | undefined {
  return isTestnet(network) ? 'ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED' : undefined
}

export function derivePolicyTemplateAddress(network: string): string | undefined {
  return isTestnet(network) ? 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5' : undefined
}

/**
 * The mainnet SSIVC host, by analogy with the other services' testnet/mainnet naming — but
 * UNVERIFIED (as of 2026-08-17): nobody has actually reached it and gotten a real response.
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
 * registry address returned `result: null` — so this returns undefined on mainnet (as of
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
 * **Mainnet now carries the same default as testnet: 1 JMYR per call, everything else refused.** This was
 * refuse-all on mainnet, deliberately, because `pay_and_fetch` is the confused-deputy surface: a prompt-injected or
 * misled agent can point it at a hostile endpoint, and a permissive default auto-pays real value with nobody having
 * configured anything. Giving mainnet the same default is a deliberate decision; what it
 * costs is that an unconfigured mainnet wallet can now be made to pay up to 1 JMYR per call to an arbitrary URL, with no
 * running total. An explicit `MAX_PAYMENT_AMOUNT` replaces it, and a spending policy for JMYR stands it aside.
 *
 * The narrower credential allowance lives in {@link defaultCredentialIssuanceCaps} — see its note
 * for why the two are separate.
 */
function defaultPaymentCaps(network: string): Record<string, string> {
  const jmyr = resolveTokenAddress('JMYR', network)
  return jmyr ? { [jmyr]: '1000000', '*': '0' } : { '*': '0' }
}

/**
 * The cap applied to CREDENTIAL ISSUANCE when `MAX_PAYMENT_AMOUNT` is unset — `subscribe_and_issue`
 * and the Verified AI Birthcert flow, both of which pay a known issuer for a known credential.
 *
 * Out of the box the cap refused everything, so the first credential a user asked for failed on a
 * limit nobody had told them about. Both networks now allow exactly the AI Birthcert fee (1 JMYR)
 * under JMYR's per-network address, and nothing else.
 *
 * **Why this was separate from {@link defaultPaymentCaps}.** The product decision was that a first
 * credential should work out of the box on mainnet too — the requirement's own words are "so user
 * can apply the first VC without any issue". Granting that through the shared cap would also have
 * handed the same allowance to `pay_and_fetch` against any URL on earth, so it was scoped to issuance
 * to keep that surface closed. The general cap was then given the same default (1 JMYR per call) on
 * both networks, deliberately (see above), so that surface IS open to that amount now; the two
 * functions stay separate so they can diverge again.
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
 * exists to prevent, so it is warned about on stderr. Not a clamp — see the loader.
 */
const SETTLEMENT_WAIT_BUDGET_WARN_MS = 600_000

function isTestnet(network: string): boolean {
  return network.includes('testnet')
}

/** Every registered token on this network, symbol -> contract address. */
export function knownTokensFor(network: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [symbol, entry] of Object.entries(TOKEN_REGISTRY)) {
    out[symbol] = isTestnet(network) ? entry.testnet : entry.mainnet
  }
  return out
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
  const policyDecisionUrlOverride = opt('POLICY_DECISION_URL')
  const policyWriteUrlOverride = opt('POLICY_WRITE_URL')

  // Checked now rather than on the first call, so a bad template shows up at startup. It is a warning, not a
  // failure: an optional feature's setting must not stop the wallet starting, and create_verification_qr
  // refuses with the same reason when it is used.
  // Only a value someone SET is checked and warned about: the built-in default is tested to pass, and a person has no say in it.
  const myidVerifyLinkOverride = opt('MYID_VERIFY_LINK_TEMPLATE')
  if (myidVerifyLinkOverride !== undefined) {
    const problem = checkVerifyLinkTemplate(myidVerifyLinkOverride)
    if (problem) {
      process.stderr.write(`agentic-wallet-mcp: ${problem} create_verification_qr will refuse until this is fixed.\n`)
    }
  }
  const myidVerifyLinkTemplate = myidVerifyLinkOverride ?? deriveMyidVerifyLinkTemplate(network)

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
    policyDecisionUrl: policyDecisionUrlOverride ? stripTrailingSlash(policyDecisionUrlOverride) : undefined,
    myidVerifyLinkTemplate,
    policyDecisionAuth: opt('POLICY_DECISION_AUTH'),
    policyWriteUrl: policyWriteUrlOverride
      ? stripTrailingSlash(policyWriteUrlOverride)
      : derivePolicyWriteUrl(network),
    policyTemplateAddress: opt('POLICY_TEMPLATE_ADDRESS') ?? derivePolicyTemplateAddress(network),
    policyTemplatePublisher: opt('POLICY_TEMPLATE_PUBLISHER') ?? derivePolicyTemplatePublisher(network),
    // An unset cap is a small default, not "spend anything": 1 JMYR per call and every other asset refused (on
    // both networks). A wallet that starts with no configuration can still be made to pay up to that amount to a hostile x402
    // challenge, per call and with no running total. Raising it is a deliberate act, and so is lowering it.
    //
    // An explicit MAX_PAYMENT_AMOUNT governs BOTH caps below — a user who sets a limit means it everywhere, and it is never
    // bypassed by a spending policy. The two defaults are the same today; the two functions stay separate so they can differ
    // again if the two surfaces come to carry different risk.
    maxPaymentAmount: explicitCaps ?? defaultPaymentCaps(network),
    paymentCapsExplicit: explicitCaps !== undefined,
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
    // Deliberately NOT clamped to a ceiling. This is the ops escape hatch for a slow
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
