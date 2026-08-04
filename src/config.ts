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
  /** ZID resolver base URL (issuer DID → BBS+/Ed25519 verification keys) — auto-derived from network when not set. */
  zidResolverBaseUrl: string
  /**
   * Per-asset x402 auto-pay ceiling, asset -> max raw-unit string, `"*"` as fallback.
   * Defaults to `{ "*": "0" }` — every payment is refused until a cap is set explicitly.
   * See src/payment-guard.ts.
   */
  maxPaymentAmount: Record<string, string>
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
 * Symbol → per-network ZTP20 contract address, for standalone balance lookups
 * (e.g. wallet_status({ token: 'JMYR' })) independent of any active x402 challenge.
 * Extend this map to register additional known tokens.
 */
const TOKEN_REGISTRY: Record<string, { testnet: string; mainnet: string }> = {
  JMYR: { testnet: 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b', mainnet: 'ZTX3NCkXBqbyJWjZZxciQez945Lu6tGAcjNJr' },
}

export function resolveTokenAddress(symbol: string, network: string): string | undefined {
  const entry = TOKEN_REGISTRY[symbol.toUpperCase()]
  if (!entry) return undefined
  return network.includes('testnet') ? entry.testnet : entry.mainnet
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
  // payment cap, requires a deliberate act.
  const network = opt('ZETRIX_NETWORK') ?? 'zetrix:testnet'

  const oid4vpBaseUrlOverride = opt('OID4VP_BASE_URL')

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
    // Fail closed: an unset cap means "spend nothing", not "spend anything". A wallet that starts
    // with no configuration at all must not be able to auto-pay a hostile x402 challenge. Raising
    // it is a deliberate act.
    maxPaymentAmount: parsePaymentCaps(opt('MAX_PAYMENT_AMOUNT')) ?? { '*': '0' },
  }
}
