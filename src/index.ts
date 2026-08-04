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
import { readFileSync } from 'node:fs'
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
import { loadConfig, resolveTokenAddress } from './config.js'
import { resolveAssetSymbol, type ContractQuery } from './clients/token-info-client.js'
import { queryContract as runContractQuery, type ContractQueryInput, type ContractQueryResult } from './clients/contract-query-client.js'
import {
  parseNativeBalance,
  queryTokenBalance as runTokenBalanceQuery,
  type TokenBalanceDeps,
  type TokenBalanceResult,
} from './clients/token-balance-client.js'
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
import { payWithReadinessCheck, PaymentReadinessError } from './payment-readiness.js'
import { resolveHolder } from './orchestrator/resolve-holder.js'
import { resolveStartupEnv } from './startup-env.js'
import { loadConfigFileEnv } from './config-file.js'
import { generateHsmPassword } from './hsm-password.js'
import { exportCredentials } from './export-credentials.js'
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
          token: { type: 'string', description: 'Optional token symbol (e.g. "ZTX", "JMYR") to check its balance for the active network, alongside the usual status fields. Returns { balance, decimals } where balance is in the asset\'s raw base units — divide by 10^decimals for the human amount (e.g. balance "473999900" with decimals 6 is 473.9999 JMYR). A failed lookup reports { error: "query_failed" } rather than a zero balance.' },
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
      name: 'get_template_schema',
      description:
        "Read a VC template's declared attribute schema from chain — FREE, no payment, no signing, " +
        'no MBI issuance. Call this BEFORE subscribe_and_issue to find out which attributes a ' +
        'template requires, rather than discovering a missing one by attempting an issuance and ' +
        'being rejected. Accepts a did:zid:... credential-definition id or a known template name ' +
        '(e.g. "AI Birthcert"). Returns { templateId, schema: { required, optional } }; attributes ' +
        'the wallet fills in itself (agentDid, alias-derived keys) are omitted since you never supply ' +
        'them. A template that cannot be read reports { error } rather than an empty schema, so ' +
        '"needs nothing" is never confused with "could not look it up".',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: {
            type: 'string',
            description: 'The MBI credential-definition id (did:zid:...) or a known template name, e.g. "AI Birthcert".',
          },
        },
        required: ['templateId'],
      },
    },
    {
      name: 'query_contract',
      description:
        'Read-only query against a Zetrix contract or account — call an arbitrary contract method ' +
        '(e.g. "balanceOf", "contractInfo") and return its raw result. No signing, no state change.',
      inputSchema: {
        type: 'object',
        properties: {
          contractAddress: { type: 'string', description: 'Zetrix contract address to query.' },
          method: { type: 'string', description: 'Contract method name, e.g. "balanceOf", "contractInfo".' },
          params: { type: 'object', description: 'Method parameters, e.g. { "address": "ZTX..." } for balanceOf.' },
        },
        required: ['contractAddress', 'method'],
      },
    },
    {
      name: 'subscribe_and_issue',
      description:
        'Obtain a VC from MBI: build the signed payload, pay x402, and return the issued credential. If a ' +
        'still-valid credential for this templateId is already cached locally, it is returned directly with ' +
        'no payment (fromCache: true) — pass forceReissue:true to pay and issue fresh regardless. Payment ' +
        "is asset-agnostic — MBI's 402 challenge may quote the native ZETRIX token or a ZTP20 token (e.g. " +
        'JMYR); pass dryRun:true first to see the quoted asset/amount for free before committing to pay. ' +
        'What a call actually cost is reported precisely: paidAsset/amountPaid are set ONLY when this call ' +
        'paid, a cache hit reports the earlier charge under originalPayment instead (never as amountPaid, so ' +
        'summing spend cannot double-count), and any failure after the payment has settled on chain reports ' +
        'paymentAttempted: { asset, amount, paymentId }. Two such failures exist and mean different things: ' +
        'MBI 4006 is a definitive facilitator rejection, while 4012 (HTTP 502) means the outcome is ' +
        'INDETERMINATE — the payment may well have landed. On 4012 the wallet automatically polls MBI\'s ' +
        'recovery endpoint and reports recovery: { status, txHash?, vcId?, polls }, where status is ISSUED ' +
        '(the credential exists after all — fetch it by vcId, since recovery returns no VC body), FAILED, or ' +
        'REQUIRED/SETTLED (still unresolved) / UNKNOWN (recovery itself unreachable). NEVER retry a payment ' +
        'after either failure: the funds may already be gone, and a retry charges the full amount again — ' +
        'look the paymentId up instead. ' +
        'Every response except a cache hit also includes { schema: { required, optional } } — the ' +
        "template's full declared attribute schema read from chain — so you see the complete field list, " +
        'not just what went wrong; a cache hit skips the chain lookup and omits it.',
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
              "Stop after MBI's free phase-1 quote and return { quote: { asset, maxAmountRequired, payTo }, " +
              'schema: { required, optional } } without paying or issuing — use this to check the payment ' +
              "requirement AND the template's full attribute schema (read from chain) before spending funds. " +
              'Still validates required attributes locally first — a missing one blocks before any MBI call.',
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
        'Create a new holder HSM account on Wallet BE (onboarding). ALWAYS check first: if an account ' +
        'already exists for this session, this returns { alreadyExists: true, existing: {...} } WITHOUT ' +
        'creating anything — ask the user whether to keep using the existing account or create a new one, ' +
        'then call again with confirmNew:true only if they choose new. The wallet manages its own ' +
        'credentials; you neither need nor can supply any. A freshly created account is saved to this ' +
        "MCP's local account store and reused automatically on the next restart; an explicit " +
        'ZETRIX_ADDRESS in the MCP config still overrides it.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          purpose: { type: 'string' },
          confirmNew: {
            type: 'boolean',
            description: 'Set true to mint a new account even though one already exists for this session — only after the user has confirmed they want a new one.',
          },
        },
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
  // stdio-spawned process can't reliably discover). Read BEFORE resolveStartupEnv so a
  // stored value can fill in for an unset env var; see startup-env.ts for full precedence.
  // The config file is read first because it can set the state directory, and the store must be
  // read before resolveStartupEnv/loadConfig run — a stored account is one of their inputs. Env
  // still wins over the file here, matching the precedence resolveStartupEnv applies.
  const fileEnv = loadConfigFileEnv(process.argv, (p) => readFileSync(p, 'utf8'))
  const stateDir = (
    process.env.ZETRIX_WALLET_STATE_DIR ??
    fileEnv.ZETRIX_WALLET_STATE_DIR ??
    join(homedir(), '.agentic-wallet-mcp')
  ).replace(/\/+$/, '')
  const accountStore = createFsAccountStore(join(stateDir, 'account.json'))

  // Backup path for a self-provisioned wallet, before any server setup: it needs no password,
  // no network and no Wallet BE. Writing to stdout is safe here precisely because this branch
  // never starts the MCP server, so there is no protocol stream to corrupt.
  if (process.argv[2] === 'export-credentials') {
    const { exitCode } = await exportCredentials({
      getAccount: () => accountStore.get(),
      isTty: Boolean(process.stdout.isTTY),
      write: (s) => process.stdout.write(s),
      writeErr: (s) => process.stderr.write(s),
    })
    process.exit(exitCode)
  }

  const storedAccount = process.env.ZETRIX_ADDRESS ? null : await accountStore.get()
  const { env, passwordGenerated } = resolveStartupEnv({
    processEnv: process.env,
    storedAccount,
    fileEnv,
    generatePassword: generateHsmPassword,
  })

  const config = loadConfig(env)
  const hsmPassword = config.hsmPassword

  const be = new WalletBeClient(config.walletBeUrl)
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  // Scenario 1 (no ZETRIX_ADDRESS, no stored account either): create a new HSM account.
  // Scenario 2 (ZETRIX_ADDRESS resolved from env or the local store): always derive + verify
  // the DID from the account's actual public key — a supplied HOLDER_DID is never trusted
  // blindly. See resolve-holder.ts.
  const { zetrixAddress, holderDid, created, didMismatch, activated } = await resolveHolder(
    {
      createAccount: (password) => be.createAccount(password),
      signMessage: (message, address, password) => be.signMessage(message, address, password),
      checkActivationStatus: (address) => be.checkActivationStatus(address),
      sleep,
    },
    { zetrixAddress: config.zetrixAddress, holderDid: config.holderDid, hsmPassword },
  )
  if (created) {
    await accountStore.set({ zetrixAddress, holderDid, hsmPassword, createdAt: new Date().toISOString() })
    process.stderr.write(
      `agentic-wallet-mcp: no ZETRIX_ADDRESS was set — created a new HSM account and saved it to ` +
        `~/.agentic-wallet-mcp/account.json; it will be reused automatically next run. ` +
        `ZETRIX_ADDRESS=${zetrixAddress} (HOLDER_DID=${holderDid} is optional; it re-derives automatically).` +
        (passwordGenerated
          ? ` An HSM password was generated for this account — you never need to enter it, but it is the ` +
            `ONLY thing that can authorize signing for this wallet. If this file is lost the account cannot ` +
            `be recovered. Back it up with: npx agentic-wallet-mcp export-credentials\n`
          : `\n`),
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
  if (created && !activated) {
    process.stderr.write(
      `agentic-wallet-mcp: the newly created HSM account (ZETRIX_ADDRESS=${zetrixAddress}) has not completed ` +
        `on-chain activation yet — balance/on-chain calls for this address may fail until it does.\n`,
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

  // Token balance lookup backing wallet_status({ token }). Reads go through the SDK directly
  // rather than PaymentEngine.fetchAccountInfo/fetchZTP20Balance: those return `{ balance: '0' }`
  // on any failure, which reports an unreachable node as an empty wallet. Here a failed read
  // throws and surfaces as `query_failed`.
  // parseNativeBalance handles the node omitting `balance` when it is zero — see its docblock.
  const fetchNativeBalance = async (address: string): Promise<string> =>
    parseNativeBalance(await sdk.account.getInfo(address))
  const tokenBalanceDeps: TokenBalanceDeps = {
    address: zetrixAddress,
    fetchNativeBalance,
    resolveTokenAddress: (symbol) => resolveTokenAddress(symbol, config.network) ?? null,
    query: contractQuery,
  }
  const queryTokenBalance = (token: string): Promise<TokenBalanceResult> =>
    runTokenBalanceQuery(tokenBalanceDeps, token)

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
  const vcCache = createFsVcCache(join(config.stateDir, 'vc-cache', cacheScope))

  // x402 self-pay: build the X-PAYMENT header for a given accept. Shared by pay_and_fetch
  // (below) and subscribe_and_issue (subscribeDeps.pay), so the cap covers both
  // auto-pay tools from this one call site — a hard ceiling on maxAmountRequired, enforced
  // regardless of what the calling agent was told to do.
  const pay = (accept: PayRequirement) => {
    assertWithinPaymentCap(accept, config.maxPaymentAmount)
    return payWithReadinessCheck(
      String(accept.asset ?? ''),
      () => PaymentEngine.pay(asPayRequest(accept), walletCfg, node, {}, walletBeSignerFn),
      activated,
    )
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
    let xPayment: string
    try {
      xPayment = await pay(accept)
    } catch (err) {
      if (err instanceof PaymentReadinessError) {
        return { status: 402, body: '', paymentMade: false, amountPaid: '', amountPaidHuman: '', asset: '', insufficientFunds: err.shortfall }
      }
      throw err
    }
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
    queryContract: (input: ContractQueryInput): Promise<ContractQueryResult> => runContractQuery(input, contractQuery),
    queryTokenBalance,
    // The session password is bound here, in the wiring, so it never crosses into the tool
    // layer — create_holder_account has no password parameter for a model to be asked for.
    createAccount: (label, purpose) => be.createAccount(hsmPassword, label, purpose),
    saveAccount: (account) => accountStore.set({ ...account, hsmPassword, createdAt: new Date().toISOString() }),
    checkActivationStatus: (address: string) => be.checkActivationStatus(address),
    sleep,
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
