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
   * Whether the node is reached over https. True for every host except a loopback one, because the SDK uses plain http unless
   * told otherwise and the mainnet node refuses a POSTed contract call over http. See {@link deriveNodeSecure}.
   */
  nodeSecure: boolean
  /**
   * Whether an owner's policy that governs an asset stands the default per-call cap aside for it (see policy-cap-bypass.ts).
   * That is only safe where Wallet BE enforces the policy, so it is on for testnet and mainnet and OFF elsewhere. Set
   * `POLICY_CAP_BYPASS=false` if the Wallet BE you use does not enforce policies: a policy then no longer limits payments at
   * all. A value that is not true or false turns it OFF. See {@link derivePolicyCapBypass}.
   */
  policyCapBypass: boolean
  /**
   * Whether `prove_identity` binds the presentation to the verifier's session: the nonce and the verifier's origin go to MBI, and each
   * challenge is answered once. On by default; `X401_BIND_PRESENTATION=false` turns it off, for a deployment whose verifier is not ready for it
   * (a verifier that does not read the holder's key from the holder binding refuses a bound presentation, after it has been signed). A value
   * that is not true or false is ignored with a warning: binding stays on.
   */
  bindPresentation: boolean
  /**
   * Template-registry account address — the on-chain account whose metadata holds every credential
   * template (`template__<templateId>` → applyFormat). Fixed per network; auto-derived when not set.
   * `subscribe_and_issue` reads it to check a template's required attributes before paying.
   */
  templateRegistryAddress: string
  /**
   * Policy Registry contract address — the entry point for every policy read (`getPolicyContract`,
   * `getPolicy`, and the proxied `getTemplate`). Built in for testnet and mainnet; `undefined` on any other network unless
   * `POLICY_REGISTRY_ADDRESS` is set, and the policy tools then report the network as unsupported instead of querying.
   */
  policyRegistryAddress?: string
  /**
   * Policy Template contract address — needed only for `getTemplateById`, which the Registry does
   * not proxy. Built in for testnet and mainnet, `undefined` elsewhere, for the same reason as {@link policyRegistryAddress}.
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
   * MyID's universal link, so a phone without the app is sent to the store. Defaults to the UAT link on testnet and to MyID's
   * production link on mainnet (see deriveMyidVerifyLinkTemplate). MYID_VERIFY_LINK_TEMPLATE overrides either.
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
   * payment rather than by a JWT, exposed exactly
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
   * `MAX_PAYMENT_AMOUNT` replaces it. Mainnet has the same default as testnet.
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
   * same too; they were different on mainnet, where `maxPaymentAmount` kept `pay_and_fetch`
   * fail-closed. See `defaultCredentialIssuanceCaps`.
   */
  credentialIssuanceCaps: Record<string, string>
  /**
   * myid's SSIVC "AI Birthcert" session API base URL — backs request_ai_birthcert_verification /
   * check_ai_birthcert_verification. Derived per network (see deriveSsivcBaseUrl); SSIVC_BASE_URL
   * overrides it.
   */
  ssivcBaseUrl?: string
  /**
   * The Verified AI Birthcert's on-chain templateId, distinct from the Basic Birthcert's.
   * Derived per network, both read from chain (see deriveAiBirthcertVerifiedTemplateId);
   * AI_BIRTHCERT_VERIFIED_TEMPLATE_ID overrides it.
   */
  aiBirthcertVerifiedTemplateId?: string
  /**
   * The AI Delegation Credential's on-chain templateId: the permission a main agent holds to give a sub-agent a policy credential.
   * Deployed on testnet only so far, so undefined on any other network (the tool says so); AI_DELEGATION_TEMPLATE_ID overrides it.
   */
  aiDelegationTemplateId?: string
  /**
   * The AI Policy Credential's on-chain templateId (one template for the main agent and its sub-agents). Deployed on testnet only
   * so far, so undefined on any other network; AI_POLICY_TEMPLATE_ID overrides it.
   */
  aiPolicyTemplateId?: string
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

/**
 * Whether an owner's policy may stand the default per-call cap aside. The wallet cannot ask Wallet BE whether it is
 * enforcing policies, and on a network where it is not, a policy that governs an asset removes the only limit the wallet had,
 * because the wallet never compares a payment with the policy's own limit. So the answer is per network, on for testnet and
 * mainnet (where Wallet BE enforces policies) and off for everything else, until `POLICY_CAP_BYPASS` says otherwise.
 *
 * FAILS CLOSED. A value that is not true or false (`off`, `flase`, `n`) turns the bypass OFF on every network, never leaves
 * the default on: an operator who is trying to switch it off must not end up with it on because of a typo. `loadConfig` says so
 * on stderr. (A blank value is the same as not setting it, like every other setting.)
 */
export function derivePolicyCapBypass(network: string, override: string | undefined): boolean {
  if (override !== undefined && override.trim() !== '') return parseBooleanSetting(override) ?? false
  return isTestnet(network) || network === 'zetrix:mainnet'
}

/** `X401_BIND_PRESENTATION`: on unless it says false. A value that is not true or false leaves it on (the loader warns). */
export function deriveBindPresentation(override: string | undefined): boolean {
  return parseBooleanSetting(override) ?? true
}

/** A node host with its optional `:port` taken off, lower-cased: `localhost:19333` -> `localhost`, `[::1]:19333` -> `[::1]`. */
function nodeHostName(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colons = h.split(':').length - 1
  return colons === 1 ? h.slice(0, h.indexOf(':')) : h
}

/** Whether the node is on this machine (`localhost`, `127.0.0.1`, `[::1]`), with or without a port. */
export function isLoopbackNodeHost(host: string): boolean {
  const h = nodeHostName(host)
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

/** A true/false setting (`ZETRIX_NODE_SECURE`, `POLICY_CAP_BYPASS`) as a boolean, or undefined when unset or not recognised. */
function parseBooleanSetting(override: string | undefined): boolean | undefined {
  const v = override?.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return undefined
}

/**
 * Whether to reach the Zetrix node over https.
 *
 * zetrix-sdk-nodejs uses plain http unless `secure: true` is passed. The testnet node accepts that, the mainnet node does not:
 * it answers a POSTed contract call over http with "request must be in json format", so every contract query failed on mainnet
 * (a GET such as an account lookup worked either way). Both public nodes answer over https, so https is the default.
 *
 * Decided on the host alone: the SDK builds its URL from the scheme and `host` only and ignores a separate `port`. A loopback
 * host keeps plain http, as before, and a local node on a port is given as `ZETRIX_NODE_HOST=localhost:19333`.
 * `ZETRIX_NODE_SECURE` (true or false) overrides the default, for a private node reached over http.
 */
export function deriveNodeSecure(host: string, override: string | undefined): boolean {
  return parseBooleanSetting(override) ?? !isLoopbackNodeHost(host)
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

/** MyID's production universal link, on the MyID verifier host (the presentation is verified in the MyID app). */
export const MAINNET_MYID_VERIFY_LINK_TEMPLATE = 'https://myid-verifier.zetrix.com/agentic-verify?referenceId={referenceId}'

/**
 * MyID's universal link for create_verification_qr, per network.
 *
 * TESTNET (UAT): read from the MyID app's own registration, not from a description of it. ssivc-api-uat.myegdev2.com publishes
 * an apple-app-site-association that claims exactly `/api/agentic-verify` with a `referenceId` query (and an assetlinks.json
 * for com.zetrix.myid.uat), and serves a "open this on your phone" page at that address. The first link the wallet was given,
 * `/v1/agent-verification/{referenceId}`, is claimed by neither: the phone opened the browser and the server answered 404.
 *
 * MAINNET: {@link MAINNET_MYID_VERIFY_LINK_TEMPLATE}, MyID's production verifier host (MyID said it is ready).
 */
function deriveMyidVerifyLinkTemplate(network: string): string {
  return network.includes('testnet') ? 'https://ssivc-api-uat.myegdev2.com/api/agentic-verify?referenceId={referenceId}' : MAINNET_MYID_VERIFY_LINK_TEMPLATE
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
 * Mainnet: the Registry deployed on 2026-10-15 (the one ms-zetrix prod is configured with, `registryAddress` in its
 * `values-prod.yaml`), read back from chain on 2026-10-16 — its Factory and Template contract are wired and
 * `getPolicyContract` answers. Any other network returns undefined, an honest "not deployed":
 * a guessed address would make every read fail in a way that reads as "you have no policy" rather than "this network has no
 * policy system at all", which is precisely the confusion the three-state read result exists to prevent.
 *
 * The field guide also lists a separate local/dev deployment. Those addresses are deliberately NOT
 * recorded here — POLICY_REGISTRY_ADDRESS is how local testing reaches them, so this file never
 * carries a second environment someone could resolve to by accident.
 */
export function derivePolicyRegistryAddress(network: string): string | undefined {
  if (isTestnet(network)) return 'ZTX3Z2Fgsssx5fVq5v8EnhTBh6mqxJ8FQFqnk'
  if (network === 'zetrix:mainnet') return 'ZTX3brJxpLuzHSbcNNLi2XrgWsQQQ2EHFZVWQ'
  return undefined
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
 * Testnet is the sandbox proxy, which is where the flow was verified end to end on 2026-09-22. Mainnet is the production proxy,
 * `https://public-api.zetrix.com/api`, the host the team named for it (2026-10-16); its ingress allowlists the policy routes
 * (`/pay/policy/*`, GET `/policy/vocabulary`) to ms-zetrix. Every script client tried (Node and curl, with and without a
 * browser User-Agent, from the VPN and without it) gets a Cloudflare managed challenge on the mainnet API hosts, so the routes
 * could not be exercised from a script: the first request that gets through is the first real test. A price check (phase 1)
 * costs nothing, and a self-paid write pays only network gas. Any other network returns undefined, for the same reason
 * {@link derivePolicyRegistryAddress} does: a guessed host would turn "this network has no policy system configured" into a
 * connection error — and on a write path, a confusing failure is one a user may respond to by trying again and paying.
 */
export function derivePolicyWriteUrl(network: string): string | undefined {
  if (isTestnet(network)) return 'https://public-api-sandbox.zetrix.com/api'
  if (network === 'zetrix:mainnet') return 'https://public-api.zetrix.com/api'
  return undefined
}

/**
 * Why a POLICY_WRITE_URL override cannot be used, or undefined when it can. The owner's HSM password rides in the body of
 * the paid-write calls (phases 2 and 3, and remove), so the URL must be https; plain http is accepted only for a loopback
 * host, which is how local testing reaches a service on the same machine.
 */
export function checkPolicyWriteUrl(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'POLICY_WRITE_URL is not a valid URL.'
  }
  if (url.protocol === 'https:') return undefined
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && loopback) return undefined
  return 'POLICY_WRITE_URL must be https (plain http is accepted only for localhost), because the owner\'s HSM password is sent to it.'
}

/**
 * The publisher of the two deployed templates, `native-v1` and `ztp20-v1`, per network.
 *
 * Testnet, read from chain 2026-09-30: `listTemplateKeys` for this address returns both keys, and
 * both derived ids resolve through `getTemplateById`. Mainnet, read from chain 2026-10-16: the same
 * two keys on the mainnet Template contract, with attribute names and types identical to testnet's.
 * Undefined on any other network, for the same reason as {@link derivePolicyRegistryAddress}.
 */
export function derivePolicyTemplatePublisher(network: string): string | undefined {
  if (isTestnet(network)) return 'ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED'
  if (network === 'zetrix:mainnet') return 'ZTX3dco8hFcbYn3k1nxKJXVjeB3soikzNBStm'
  return undefined
}

export function derivePolicyTemplateAddress(network: string): string | undefined {
  if (isTestnet(network)) return 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
  // Mainnet, read from chain 2026-10-16: the Template contract the mainnet Registry proxies `getTemplate` to, holding
  // `native-v1` and `ztp20-v1` for the publisher in {@link derivePolicyTemplatePublisher}.
  if (network === 'zetrix:mainnet') return 'ZTX3P7CKSvPAX33GNJCbDeLz1dGoyjKw4ZAy3'
  return undefined
}

/**
 * The production SSIVC "AI Birthcert" session API (apply and quote). Its sessions and sessions/quote routes were reached on
 * 2026-10-22 and answer a request with no fields with the service's own validation error.
 */
export const MAINNET_SSIVC_BASE_URL = 'https://verifyid-api.zetrix.com/api'

/** myid's SSIVC "AI Birthcert" session API: the UAT host on testnet, {@link MAINNET_SSIVC_BASE_URL} on mainnet. */
function deriveSsivcBaseUrl(network: string): string {
  return network.includes('testnet') ? 'https://ssivc-api-uat.myegdev2.com/api' : MAINNET_SSIVC_BASE_URL
}

/**
 * The mainnet `AI_BIRTHCERT_VERIFIED` templateId. Read from the mainnet template registry (ZTX3GqJM1U6ifMPonwD4fGvrgoTKJua7b2cKX)
 * on 2026-10-22: "Verified AI Birthcert", version 1.0.0, the same issuer as the testnet one.
 */
export const MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID = 'did:zid:2d8f9476809fe20de103c43438f738a122ef53665e0b615b7414bdf1f1b19b52'

/**
 * `AI_BIRTHCERT_VERIFIED` templateId, deployed 2026-08-05 (`TEMPLATE_ONCHAIN_REFERENCE.md` §2). Both ids were read from chain.
 */
/**
 * The testnet `AI Delegation Credential` v1.0.0 and `AI Policy Credential` v1.0.0 templateIds, deployed 2026-10-22 and read back from
 * the testnet template registry on 2026-10-23 (same issuer as the AI Birthcert). Not deployed on mainnet yet.
 */
export const TESTNET_AI_DELEGATION_TEMPLATE_ID = 'did:zid:1724245eb96cb0092c3ae354a68d9e21466aa5ef3e74019f4cfc7554b28cf1a9'
export const TESTNET_AI_POLICY_TEMPLATE_ID = 'did:zid:d3e08efbeea484bcb21483b269230f250abb34d097e88ef22059b0aafbce6ce9'

function deriveAiDelegationTemplateId(network: string): string | undefined {
  return network.includes('testnet') ? TESTNET_AI_DELEGATION_TEMPLATE_ID : undefined
}

function deriveAiPolicyTemplateId(network: string): string | undefined {
  return network.includes('testnet') ? TESTNET_AI_POLICY_TEMPLATE_ID : undefined
}

function deriveAiBirthcertVerifiedTemplateId(network: string): string {
  return network.includes('testnet') ? 'did:zid:9641ee92552e9bcec672f300b071ff86d340ac78c83c225e95971cab8108fb80' : MAINNET_AI_BIRTHCERT_VERIFIED_TEMPLATE_ID
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

/** The `ZETRIX_NETWORK` setting exactly as `loadConfig` reads it: a blank value is unset, and unset is testnet. */
export function networkFromEnv(env: NodeJS.ProcessEnv): string {
  const v = env.ZETRIX_NETWORK
  return v && v.trim() ? v.trim() : 'zetrix:testnet'
}

/** Whether `network` is one `loadConfig` accepts. Lets a caller skip network-specific work for a value it will reject. */
export function isKnownNetwork(network: string): boolean {
  return (KNOWN_NETWORKS as readonly string[]).includes(network)
}

/** The default Wallet BE for a known network, for asking the OTHER network's Wallet BE about a saved account. */
export function walletBeUrlForNetwork(network: string): string {
  return deriveWalletBeUrl(network)
}

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
  const network = networkFromEnv(env)
  if (!(KNOWN_NETWORKS as readonly string[]).includes(network)) {
    throw new Error(
      `agentic-wallet-mcp: unrecognised ZETRIX_NETWORK "${network}" — expected one of ${KNOWN_NETWORKS.join(', ')}. ` +
        `Values are matched exactly and are case-sensitive; anything unrecognised would otherwise resolve to ` +
        `MAINNET addresses and grant a real spending allowance.`,
    )
  }

  // The scheme the node is reached over. A warning, not a failure, for a setting that is unrecognised or that sends plain http to a
  // node that is not on this machine (the public nodes refuse a contract query over http).
  const nodeHost = opt('ZETRIX_NODE_HOST') ?? deriveNodeHost(network)
  const nodeSecureOverride = opt('ZETRIX_NODE_SECURE')
  if (nodeSecureOverride !== undefined && parseBooleanSetting(nodeSecureOverride) === undefined) {
    process.stderr.write(`agentic-wallet-mcp: ZETRIX_NODE_SECURE must be true or false, so "${nodeSecureOverride}" is ignored.\n`)
  }
  const nodeSecure = deriveNodeSecure(nodeHost, nodeSecureOverride)
  if (!nodeSecure && !isLoopbackNodeHost(nodeHost)) {
    process.stderr.write(
      `agentic-wallet-mcp: the node ${nodeHost} is reached over plain http (ZETRIX_NODE_SECURE=false). The public Zetrix nodes refuse ` +
        `a contract query over http; this is only for a private node.\n`,
    )
  }

  const policyCapBypassOverride = opt('POLICY_CAP_BYPASS')
  if (policyCapBypassOverride !== undefined && parseBooleanSetting(policyCapBypassOverride) === undefined) {
    process.stderr.write(
      `agentic-wallet-mcp: POLICY_CAP_BYPASS must be true or false, so "${policyCapBypassOverride}" is treated as false: an owner's policy ` +
        `will not lift the default per-call payment cap.\n`,
    )
  }

  const bindPresentationOverride = opt('X401_BIND_PRESENTATION')
  if (bindPresentationOverride !== undefined && parseBooleanSetting(bindPresentationOverride) === undefined) {
    process.stderr.write(`agentic-wallet-mcp: X401_BIND_PRESENTATION must be true or false, so "${bindPresentationOverride}" is ignored: binding stays on.\n`)
  }

  const oid4vpBaseUrlOverride = opt('OID4VP_BASE_URL')
  const policyDecisionUrlOverride = opt('POLICY_DECISION_URL')
  // A warning, not a failure, like the other optional settings: the wallet starts, and the policy write tools are simply
  // not built for a URL that cannot be trusted with a password. The built-in default is https and is not checked.
  let policyWriteUrlOverride = opt('POLICY_WRITE_URL')
  let policyWriteUrlRejected = false
  if (policyWriteUrlOverride !== undefined) {
    const problem = checkPolicyWriteUrl(policyWriteUrlOverride)
    if (problem) {
      process.stderr.write(`agentic-wallet-mcp: ${problem} The policy write tools are unavailable until this is fixed.\n`)
      policyWriteUrlOverride = undefined
      policyWriteUrlRejected = true
    }
  }

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
    nodeHost,
    nodePort: opt('ZETRIX_NODE_PORT') ?? '',
    nodeSecure,
    policyCapBypass: derivePolicyCapBypass(network, policyCapBypassOverride),
    bindPresentation: deriveBindPresentation(bindPresentationOverride),
    templateRegistryAddress: opt('ZETRIX_TEMPLATE_REGISTRY_ADDRESS') ?? deriveTemplateRegistryAddress(network),
    zidResolverBaseUrl: stripTrailingSlash(opt('ZID_RESOLVER_BASE_URL') ?? deriveZidResolverBaseUrl(network)),
    policyRegistryAddress: opt('POLICY_REGISTRY_ADDRESS') ?? derivePolicyRegistryAddress(network),
    policyDecisionUrl: policyDecisionUrlOverride ? stripTrailingSlash(policyDecisionUrlOverride) : undefined,
    myidVerifyLinkTemplate,
    policyDecisionAuth: opt('POLICY_DECISION_AUTH'),
    // A rejected override does not fall back to the default: someone chose a different service on purpose.
    policyWriteUrl: policyWriteUrlOverride
      ? stripTrailingSlash(policyWriteUrlOverride)
      : policyWriteUrlRejected
        ? undefined
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
    aiDelegationTemplateId: opt('AI_DELEGATION_TEMPLATE_ID') ?? deriveAiDelegationTemplateId(network),
    aiPolicyTemplateId: opt('AI_POLICY_TEMPLATE_ID') ?? deriveAiPolicyTemplateId(network),
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
