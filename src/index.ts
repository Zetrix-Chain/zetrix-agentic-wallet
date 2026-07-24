#!/usr/bin/env node
/**
 * agentic-wallet-mcp — stdio MCP server entry + live dependency wiring.
 *
 * `buildToolList()` is unit-tested; `main()` is the live wiring (the integration seam).
 * It constructs Wallet BE + signer, the x402 self-pay payer, and the MBI client (used both for
 * x402 VC issuance and VP creation/submission), then registers the 5 tools. Run the
 * esbuild bundle for the bin (x401-zetrix-client's ESM uses extensionless imports).
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { PaymentEngine } from 'x402-zetrix-client'
import type { PayRequest as X402PayRequest, WalletConfigData, ZetrixNodeConfig } from 'x402-zetrix-client'
import { X401Wallet, type ZetrixNetwork } from 'x401-zetrix-client'
import ZtxChainSDK from 'zetrix-sdk-nodejs'
import { loadConfig } from './config.js'
import { resolveAssetSymbol, type ContractQuery } from './clients/token-info-client.js'
import { fetchTemplateFields, type NodeMetaQuery } from './clients/template-info-client.js'
import { WalletBeClient } from './clients/wallet-be-client.js'
import { WalletBeSigner } from './signer.js'
import { MbiVpAdapter, type VcPresentInput } from './clients/mbi-vp-adapter.js'
import { MbiClient, type PayRequirement } from './clients/mbi-client.js'
import { ZidResolverClient } from './clients/zid-resolver-client.js'
import { resolveIssuerProofKeys } from './clients/resolve-issuer-proof-keys.js'
import { createTools, type ToolDeps } from './mcp-tools.js'
import type { PayFetch } from './orchestrator/pay.js'
import { assertWithinPaymentCap } from './payment-guard.js'
import { resolveHolder } from './orchestrator/resolve-holder.js'
import { createFsVcCache } from './clients/vc-cache.js'
import { createFsAccountStore } from './clients/account-store.js'

// esbuild resolves this JSON import at build time and inlines it into the bundle, so the
// reported version always matches whatever package.json said when this bundle was built.
const packageVersion = packageJson.version

export function buildToolList() {
  return [
    {
      name: 'wallet_status',
      description: 'Report the holder DID/address/network and the client-supplied held credentials.',
      inputSchema: {
        type: 'object',
        properties: {
          heldCredentials: { type: 'array', items: { type: 'object' }, description: 'VCs the client holds. Omit to report whatever the wallet has cached locally from prior subscribe_and_issue calls instead.' },
        },
      },
    },
    {
      name: 'prove_identity',
      description: 'Answer an x401 PROOF-REQUEST and return the PROOF-RESPONSE header to replay to the resource server.',
      inputSchema: {
        type: 'object',
        properties: {
          proofRequest: { type: 'string', description: 'The PROOF-REQUEST header value from the 401 challenge.' },
          vc: { type: 'object', description: 'The VerifiableCredential to present. Omit to use the wallet\'s single locally-cached credential, if there is exactly one — the call fails with a clear error if none or several are cached.' },
          revealAttribute: { type: 'array', items: { type: 'string' }, description: 'Dotted disclosure paths to reveal. Omit to reveal exactly the claims the challenge (DCQL) requests; a challenge naming no claims reveals all.' },
          issuerKeys: {
            type: 'object',
            properties: {
              bbsPublicKey: { type: 'string', description: "Issuer's BBS+ publicKeyMultibase (matches the VC's BbsBlsSignature2020 proof)." },
              ed25519PublicKey: { type: 'string', description: "Issuer's Ed25519 publicKeyHex (matches the VC's Ed25519Signature2020 proof)." },
            },
            description: 'Optional issuer verification keys to bypass the ZID resolver when it is unreachable (e.g. Cloudflare-gated). When set, resolution is skipped.',
          },
        },
        required: ['proofRequest'],
      },
    },
    {
      name: 'pay_and_fetch',
      description:
        'Fetch a URL, auto-paying with x402 (self-pay via Wallet BE) if the server returns 402. The asset ' +
        "charged is whatever the server's 402 challenge demands — the native ZETRIX token or a ZTP20 token " +
        "(e.g. JMYR) — never assume it's ZETRIX; the result's `asset` field reports what was actually paid.",
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string' },
          headers: { type: 'object' },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
    {
      name: 'subscribe_and_issue',
      description:
        'Obtain a VC from MBI: build the signed payload, pay x402, and return the issued credential. If a ' +
        'still-valid credential for this templateId is already cached locally, it is returned directly with ' +
        'no payment (fromCache: true) — pass forceReissue:true to pay and issue fresh regardless. Payment ' +
        "is asset-agnostic — MBI's 402 challenge may quote the native ZETRIX token or a ZTP20 token (e.g. " +
        'JMYR); pass dryRun:true first to see the quoted asset/amount for free before committing to pay.',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description:
              'The MBI credential-definition id to issue, e.g. "did:zid:...". Take this from the x401 ' +
              "challenge's credential_requirements.query.credentials[].id — NOT from requirementsId " +
              '(that\'s just a label for the requirement set, e.g. "agent-identity"). A known template\'s ' +
              'natural-language name (e.g. "AI Birthcert") is also accepted and resolved to the right ' +
              'did:zid:... for the configured network.',
          },
          attributes: {
            type: 'object',
            description:
              'Claim values for the credential (schema varies by template — check what the issuer requires ' +
              'before guessing). "agentDid" does not need to be supplied: it is auto-filled with this wallet\'s ' +
              "own holder DID (the credential's self-referential subject) unless you explicitly override it.",
          },
          expirationDate: { type: 'string' },
          dryRun: {
            type: 'boolean',
            description:
              "Stop after MBI's free phase-1 quote and return { quote: { asset, maxAmountRequired, payTo, " +
              'requiredAttributes? } } without paying or issuing — use this to check the payment requirement AND ' +
              "the template's required attributes (read from chain) before spending funds.",
          },
          forceReissue: {
            type: 'boolean',
            description: 'Skip the local cache and pay + issue a fresh credential regardless of what is already cached.',
          },
        },
        required: ['templateId', 'attributes'],
      },
    },
    {
      name: 'create_holder_account',
      description:
        'Create a new holder HSM account on Wallet BE (onboarding). Ask the user for a password first — never ' +
        'invent one. ALWAYS check first: if an account already exists for this session, this returns ' +
        '{ alreadyExists: true, existing: {...} } WITHOUT creating anything — ask the user whether to keep using ' +
        'the existing account or create a new one, then call again with confirmNew:true only if they choose new. ' +
        'A freshly created account is saved to this MCP\'s local account store and reused automatically on the ' +
        'next restart; an explicit ZETRIX_ADDRESS in the MCP config still overrides it.',
      inputSchema: {
        type: 'object',
        properties: {
          password: { type: 'string', description: 'HSM password to protect the new account. Must come from the user.' },
          label: { type: 'string' },
          purpose: { type: 'string' },
          confirmNew: {
            type: 'boolean',
            description: 'Set true to mint a new account even though one already exists for this session — only after the user has confirmed they want a new one.',
          },
        },
        required: ['password'],
      },
    },
  ]
}

// --- wiring helpers (integration seam) ---

/** MBI's accepts[] lack gasModel; x402 self-pay needs extra.gasModel = 'client'. */
function asPayRequest(accept: PayRequirement): X402PayRequest {
  const extra = (accept.extra ?? {}) as Record<string, unknown>
  return { ...(accept as Record<string, unknown>), extra: { gasModel: 'client', ...extra } } as unknown as X402PayRequest
}

/* istanbul ignore next — live wiring, exercised by the 4.5 integration/manual smoke test. */
async function main(): Promise<void> {
  // Local store for a holder account created via create_holder_account or first-run
  // auto-create — lets the account (address, DID, AND its password) survive a restart
  // without requiring the user to hand-edit their MCP host's config file (whose path this
  // stdio-spawned process can't reliably discover). Read BEFORE loadConfig so a stored
  // value can fill in for an unset env var; an explicit env value always wins over the store.
  const accountStore = createFsAccountStore(join(homedir(), '.agentic-wallet-mcp', 'account.json'))
  const storedAccount = process.env.ZETRIX_ADDRESS ? null : await accountStore.get()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (!env.ZETRIX_ADDRESS && storedAccount) env.ZETRIX_ADDRESS = storedAccount.zetrixAddress
  if (!env.HOLDER_DID && storedAccount) env.HOLDER_DID = storedAccount.holderDid
  if (!env.HSM_PASSWORD && storedAccount) env.HSM_PASSWORD = storedAccount.hsmPassword

  const config = loadConfig(env)
  const hsmPassword = config.hsmPassword

  const be = new WalletBeClient(config.walletBeUrl)

  // Scenario 1 (no ZETRIX_ADDRESS, no stored account either): create a new HSM account.
  // Scenario 2 (ZETRIX_ADDRESS resolved from env or the local store): always derive + verify
  // the DID from the account's actual public key — a supplied HOLDER_DID is never trusted
  // blindly. See resolve-holder.ts.
  const { zetrixAddress, holderDid, created, didMismatch } = await resolveHolder(
    {
      createAccount: (password) => be.createAccount(password),
      signMessage: (message, address, password) => be.signMessage(message, address, password),
    },
    { zetrixAddress: config.zetrixAddress, holderDid: config.holderDid, hsmPassword },
  )
  if (created) {
    await accountStore.set({ zetrixAddress, holderDid, hsmPassword, createdAt: new Date().toISOString() })
    process.stderr.write(
      `agentic-wallet-mcp: no ZETRIX_ADDRESS was set — created a new HSM account and saved it (address, DID, ` +
        `and password) to ~/.agentic-wallet-mcp/account.json; it will be reused automatically next run. ` +
        `ZETRIX_ADDRESS=${zetrixAddress} (HOLDER_DID=${holderDid} is optional; it re-derives automatically).\n`,
    )
  } else if (storedAccount && config.zetrixAddress === storedAccount.zetrixAddress) {
    process.stderr.write(
      `agentic-wallet-mcp: using the holder account saved in ~/.agentic-wallet-mcp/account.json ` +
        `(ZETRIX_ADDRESS=${zetrixAddress}) — no ZETRIX_ADDRESS/HSM_PASSWORD was set in the MCP config.\n`,
    )
  }
  if (didMismatch) {
    process.stderr.write(
      `agentic-wallet-mcp: configured HOLDER_DID=${config.holderDid} does not match the account's ` +
        `actual public key — using the derived HOLDER_DID=${holderDid} instead. Update your MCP config.\n`,
    )
  }

  const signer = new WalletBeSigner(be, zetrixAddress, hsmPassword)
  const walletBeSignerFn = (blob: string) => be.signBlob(blob, zetrixAddress, hsmPassword)

  const walletCfg: WalletConfigData = { privateKey: '', address: zetrixAddress, network: config.network }
  const node: ZetrixNodeConfig = { host: config.nodeHost, port: config.nodePort }

  // Read-only on-chain contract query (same node + call path x402 uses for balance lookups),
  // used to resolve an x402 asset's real token symbol from its ZTP20 `contractInfo`.
  const sdk = new ZtxChainSDK({ host: config.nodeHost, port: config.nodePort })
  const contractQuery: ContractQuery = (a) => sdk.contract.call(a)
  const resolveSymbol = (asset: string) => resolveAssetSymbol(asset, contractQuery)

  // Read-only node metadata GET (getAccountMetaData) against the same node, used by
  // subscribe_and_issue to check a template's declared attributes before paying — both to gate
  // the agentDid auto-fill and to catch a missing required field. Fail-open (required-fields
  // check)/fail-closed (agentDid auto-fill): any fetch/parse error resolves to null inside the
  // client (see template-info-client).
  const nodeBaseUrl = `https://${config.nodeHost}${config.nodePort ? `:${config.nodePort}` : ''}`
  const nodeMetaQuery: NodeMetaQuery = (url) => fetch(url, { headers: { Accept: 'application/json' } }).then((r) => r.json())
  const resolveTemplateFields = (templateId: string) =>
    fetchTemplateFields(templateId, config.templateRegistryAddress, nodeBaseUrl, nodeMetaQuery)

  // Local cache of issued VCs, so subscribe_and_issue can skip paying + re-issuing for a
  // credential the holder already has. Scoped by network + holder so different identities
  // or networks (e.g. testnet vs mainnet) never share a cache directory.
  const cacheScope = createHash('sha256').update(`${config.network}:${zetrixAddress}`).digest('hex')
  const vcCache = createFsVcCache(join(homedir(), '.agentic-wallet-mcp', 'vc-cache', cacheScope))

  // x402 self-pay: build the X-PAYMENT header for a given accept. Shared by pay_and_fetch
  // (below) and subscribe_and_issue (subscribeDeps.pay), so the cap covers both
  // auto-pay tools from this one call site — a hard ceiling on maxAmountRequired, enforced
  // regardless of what the calling agent was told to do.
  const pay = (accept: PayRequirement) => {
    assertWithinPaymentCap(accept, config.maxPaymentAmount)
    return PaymentEngine.pay(asPayRequest(accept), walletCfg, node, {}, walletBeSignerFn)
  }

  // pay_and_fetch: fetch → on 402, pay → retry.
  const payer: PayFetch = async (req) => {
    const init: RequestInit = { method: req.method ?? 'GET', headers: req.headers, body: req.body }
    const res = await fetch(req.url, init)
    if (res.status !== 402) {
      return { status: res.status, body: await res.text(), paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '' }
    }
    const parsed = (await res.json()) as { accepts?: PayRequirement[] }
    const accept = parsed.accepts?.[0]
    if (!accept) throw new Error('pay_and_fetch: 402 had no accepts[]')
    const xPayment = await pay(accept)
    const retry = await fetch(req.url, { ...init, headers: { ...(req.headers ?? {}), 'x-payment': xPayment } })
    // Report the real token symbol (resolved from the ZTP20 contract's contractInfo),
    // not the raw contract address the 402 challenge carries in `asset`.
    const asset = await resolveSymbol(String(accept.asset ?? ''))
    return {
      status: retry.status, body: await retry.text(), paymentMade: true,
      amountPaid: String(accept.maxAmountRequired ?? ''), amountPaidHuman: '', asset,
    }
  }

  // subscribe: holder-sign the VC payload via Wallet BE.
  // The `data` field MBI receives is the raw canonical JSON string.
  // subscribeAndIssue computes the exact bytes MBI verifies — HexFormat.hexStringToBytes(data), a
  // lenient decode of the raw JSON (see src/zetrix-hex.ts) — and passes their canonical hex as the
  // `blob`. Wallet BE `/sign-blob` decodes that hex and Ed25519-signs those bytes. Forward verbatim.
  const subscribeSign = (blob: string) => be.signBlob(blob, zetrixAddress, hsmPassword)

  const mbi = new MbiClient(config.mbiBaseUrl)
  // MBI's /vp/ext/* message-signing auth: sign the holder's own address (UTF-8), not a hex blob.
  const messageSigner = (message: string) => be.signMessage(message, zetrixAddress, hsmPassword)

  // The VC's *issuer* BBS+/Ed25519 keys, for the OID4VP submit body — see mbi-vp-adapter.ts.
  const zidResolver = new ZidResolverClient(config.zidResolverBaseUrl)
  const resolveIssuerKeys = (vc: unknown) => resolveIssuerProofKeys(vc, zidResolver)

  // Per-request X401Wallet bound to the client's held VC. oid4vpBaseUrl is an optional
  // override — when unset, the x401 SDK derives it from `network` itself.
  // OID4VP submit wallet-auth (verifier's WalletAuthenticationFilter): the holder signs their
  // own address (UTF-8) — same message-signing scheme as MBI /vp/ext/*. Sent as
  // X-Wallet-Public-Key / X-Wallet-Signed-Data on POST /v1/presentation/submit.
  const submitAuth = async () => {
    const { signBlob, publicKey } = await messageSigner(zetrixAddress)
    return { publicKey, signedData: signBlob }
  }

  const makeWallet = (present: VcPresentInput): X401Wallet =>
    new X401Wallet(
      { oid4vpBaseUrl: config.oid4vpBaseUrl, network: config.network as ZetrixNetwork },
      { signer, vc: new MbiVpAdapter(mbi, walletBeSignerFn, messageSigner, zetrixAddress, resolveIssuerKeys, present), submitAuth },
    )

  const deps: ToolDeps = {
    config: { holderDid, zetrixAddress, network: config.network },
    makeWallet,
    payer,
    subscribeDeps: { mbi, sign: subscribeSign, pay, resolveSymbol, holderDid, resolveTemplateFields, cache: vcCache },
    createAccount: (password, label, purpose) => be.createAccount(password, label, purpose),
    saveAccount: (account) => accountStore.set({ ...account, createdAt: new Date().toISOString() }),
    cache: vcCache,
  }
  const tools = createTools(deps) as unknown as Record<string, (a: unknown) => Promise<unknown> | unknown>

  const server = new Server({ name: 'agentic-wallet-mcp', version: packageVersion }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolList() }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    const fn = tools[name]
    if (!fn) throw new Error(`Unknown tool: ${name}`)
    try {
      const result = await fn((args as unknown) ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      // Wrapped SDK errors (e.g. VP_BUILD_FAILED) carry the real MBI/Wallet-BE failure on
      // `.cause`; the MCP transport keeps only the top message. Flatten the whole chain so
      // the caller sees the actionable root cause instead of a generic wrapper message.
      const chain: string[] = []
      let e: unknown = err
      while (e instanceof Error && chain.length < 8) {
        const code = (e as { code?: string }).code
        chain.push(code ? `${code}: ${e.message}` : e.message)
        e = (e as { cause?: unknown }).cause
      }
      throw new Error(chain.length ? chain.join(' <- ') : String(err))
    }
  })

  await server.connect(new StdioServerTransport())
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err: Error) => {
    process.stderr.write(`agentic-wallet-mcp: fatal — ${err.message}\n`)
    process.exit(1)
  })
}
