#!/usr/bin/env node
/**
 * agentic-wallet-mcp — stdio MCP server entry + live dependency wiring.
 *
 * `buildToolList()` is unit-tested; `main()` is the live wiring (the integration seam).
 * It constructs Wallet BE + signer, the x402 self-pay payer, and the MBI client (used both for
 * x402 VC issuance and VP creation/submission), then registers the 11 tools. Run the
 * esbuild bundle for the bin (x401-zetrix-client's ESM uses extensionless imports).
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' with { type: 'json' }
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { PaymentEngine, BlobBuilder } from 'x402-zetrix-client'
import { keypair } from 'zetrix-encryption-nodejs'
import type { PayRequest as X402PayRequest, WalletConfigData, ZetrixNodeConfig } from 'x402-zetrix-client'
import { X401Wallet, type ZetrixNetwork } from 'x401-zetrix-client'
import ZtxChainSDK from 'zetrix-sdk-nodejs'
import { loadConfig, resolveTokenAddress, type AgenticWalletConfig } from './config.js'
import { resolveAssetSymbol, resolveAssetInfo, formatHumanAmount, fetchTokenInfo, type ContractQuery } from './clients/token-info-client.js'
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
import type { TransferDeps } from './orchestrator/transfer.js'
import type { PayFetch } from './orchestrator/pay.js'
import { assertWithinPaymentCap, PaymentCapError, formatCapRefusal } from './payment-guard.js'
import { payWithReadinessCheck, PaymentReadinessError } from './payment-readiness.js'
import { resolveHolder } from './orchestrator/resolve-holder.js'
import { resolveStartupEnv } from './startup-env.js'
import { loadConfigFileEnv } from './config-file.js'
import { generateHsmPassword } from './hsm-password.js'
import { exportCredentials } from './export-credentials.js'
import { createFsVcCache } from './clients/vc-cache.js'
import { createFsAccountStore } from './clients/account-store.js'
import { buildToolContent } from './tool-result.js'
import { SsivcClient } from './clients/ssivc-client.js'
import { createFsSsivcSessionStore } from './clients/ssivc-session-store.js'
import { createFsDownloadQuarantineStore } from './clients/ssivc-download-quarantine-store.js'
import { requestAiBirthcertVerification, checkAiBirthcertVerification, clearStuckPaymentReceipt } from './orchestrator/verify-ai-birthcert.js'
import type { ClearStuckPaymentReceiptInput } from './orchestrator/verify-ai-birthcert.js'
import { PolicyDecisionClient } from './clients/policy-decision-client.js'
import { needsNativeGasCheck, orderAccepts, prepareBaseUrl } from './accept-selection.js'
import { PolicyWriteClient } from './clients/policy-write-client.js'
import { createFsPolicyWriteReceiptStore } from './clients/policy-write-receipt-store.js'
import type { WritePolicyDeps } from './orchestrator/write-policy.js'
import { policyPreflight, type DraftPolicy } from './orchestrator/policy-preflight.js'
import { getTemplateById } from './clients/policy-read-client.js'

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
          token: { type: 'string', description: 'Optional token symbol (e.g. "ZTX", "JMYR") OR a ZTP20 contract address, to check its balance for the active network alongside the usual status fields. Returns { balance, decimals, display } — `balance` is in the asset\'s raw base units and `display` is the same amount in whole tokens with its symbol (e.g. balance "473999900", decimals 6, display "473.9999 JMYR"). Quote a `display` value to the user, never a bare `balance`. A failed lookup reports { error: "query_failed" } rather than a zero balance; an unrecognised name reports { error: "unknown_token" }.' },
          tokens: { type: 'array', items: { type: 'string' }, description: 'Several tokens (symbols and/or ZTP20 contract addresses) in one call, returned as `tokenBalances` in the order asked. Prefer this over repeated single-token calls when checking affordability: a credential fee and the native ZTX needed for gas are separate balances, and asking one at a time is how "you hold the token but no gas" is discovered only after the first shortfall was already fixed. Each entry carries its own result or error, so one failure does not hide the rest.' },
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
      name: 'get_policy_template_schema',
      description:
        "Read a POLICY template's declared attribute vocabulary from chain — FREE, no payment, no " +
        'signing. This is the only vocabulary that means anything on chain: the policy contract ' +
        'validates nothing, so an attribute name outside this list deploys cleanly and then enforces ' +
        'nothing at all. Accepts either { publisher, policyKey } or { templateId }. A template that ' +
        'cannot be read reports { error } rather than { found: false }, so "no such template" is ' +
        'never confused with "could not look it up".',
      inputSchema: {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'Template id, as it appears inside a deployed policy.' },
          publisher: { type: 'string', description: 'Publisher address. Use together with policyKey.' },
          policyKey: { type: 'string', description: 'Policy key. Use together with publisher.' },
        },
      },
    },
    {
      name: 'get_my_policy',
      description:
        'Read the spending policies this owner has deployed on chain — FREE, no payment, no ' +
        "signing. Defaults to this wallet's own address. Costs 2 + N chain calls and warns above " +
        '50 keys. An owner who has never deployed a policy is reported as a normal absence, NOT an ' +
        'error — the policy contract is created lazily on first write. A failed lookup keeps its ' +
        'own error state, so "we could not list your policies" is never presented as "you have none".',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "Owner address. Defaults to this wallet's configured address." },
        },
      },
    },
    {
      name: 'check_policy_decision',
      description:
        'Ask whether a specific spend would be PERMITTED RIGHT NOW — the one policy question no ' +
        'chain read can answer, because a cap is measured against cumulative spend held off-chain. ' +
        'Three outcomes: "permitted", "refused", and "undetermined". ' +
        'UNDETERMINED IS NOT A REFUSAL AND NOT PERMISSION — it means nothing was evaluated (the ' +
        'service was unreachable, the ledger was stale, or no decision service is configured), so ' +
        'do not spend on the strength of it and do not tell the user their policy blocked them. ' +
        'There is NO step-up or approval-required verdict: the decision service answers only allow ' +
        'or deny, so this tool never reports that a human must approve something. ' +
        'A PERMITTED ANSWER RESERVES THE OWNER\'S BUDGET FOR 15 MINUTES. This is free of charge ' +
        'but NOT free of consequence: the reserved amount is unavailable to any other payment for ' +
        'that owner until the matching transfer settles or the 15 minutes lapse, and there is no ' +
        'way to release it early. ' +
        'SO DO NOT EXPLORE WITH THIS TOOL. Do not probe amounts to find one that fits — asking ' +
        '"can I send 5? no? can I send 3?" reserves the budget for EVERY allow along the way, so ' +
        'an agent that probes three amounts and sends the smallest has locked several times what ' +
        'it spent, and the owner\'s next real payment can be refused by their own agent. Nothing ' +
        'errors and nothing warns when this happens. ' +
        'To find an amount that fits, call ONCE and read "remaining" from that one answer, then ' +
        'work it out locally — that is what the field is for. A refusal reserves nothing, so a ' +
        'probe that succeeds is the expensive one. ' +
        'Call this only when actually about to send, and call it BEFORE building the transaction ' +
        'rather than before signing one — the verdict depends on the amount, recipient, asset and ' +
        'method, and a reservation abandoned after signing is worse than one never taken. ' +
        'NEVER retry automatically after a timeout or an error: a timeout may mean the decision ' +
        'succeeded and already reserved the budget, and asking again reserves it a second time. ' +
        'Always read "ignored" back to the user even on a permitted answer: it lists constraints ' +
        'the policy carries that the service could not enforce, which makes a permitted answer ' +
        'narrower evidence than it looks. Omit policyKey to have every policy governing the asset ' +
        'resolved, all of which must then allow. ' +
        'Note for testnet today: the spend ledger crawl is switched off, so EVERY ' +
        'decision currently answers "undetermined" with reason EVALUATION_UNAVAILABLE. That is ' +
        'the correct behaviour rather than an outage — there is no settled-spend history to ' +
        'evaluate against yet — and it still means stop.',
      inputSchema: {
        type: 'object',
        properties: {
          ownerAddress: { type: 'string', description: 'Whose policy to consult.' },
          asset: {
            description: '"ZTX", a ZTP20 contract address, or { scope, tokenAddress }.',
          },
          amount: {
            type: 'string',
            description: "The amount to spend, as a whole number string in the chain's own unit.",
          },
          policyKey: {
            type: 'string',
            description:
              'Optional. Omit it and EVERY policy governing this asset is resolved and all must ' +
              'allow. An owner with no policy for the asset is a refusal, not a pass.',
          },
          recipientAddress: { type: 'string', description: 'Who receives the funds, when the policy restricts that.' },
          method: { type: 'string', description: 'ZTP20 only. Defaults to "transfer" server-side.' },
          payTo: { type: 'string', description: 'Required when the policy sets payToAllowlist.' },
          paymentNonce: {
            type: 'string',
            description:
              'The x402 payment nonce, for correlating this decision with a payment. The policy ' +
              'attribute it relates to, settlementChannel, is recorded but never enforced, so ' +
              'omitting this cannot cause a refusal.',
          },
          requestKey: {
            type: 'string',
            description:
              'A correlation id for support to find this decision later. NOT an idempotency ' +
              'key: repeating it does not deduplicate, every call gets a fresh verdict, and ' +
              'every permitted answer reserves the budget again. Never reuse one to make a ' +
              'retry "safe".',
          },
        },
        required: ['ownerAddress', 'asset', 'amount'],
      },
    },
    {
      name: 'write_policy',
      description:
        'Deploy a spending policy on chain. THIS PAYS A REAL FEE. Run policy_preflight first and ' +
        'show the user its `interpretation`, because a policy that is valid can still mean ' +
        'something other than what they asked for, and this tool cannot take that back once it is ' +
        'written. ' +
        'The flow is three steps and the middle one is where care is needed: a free pre-check, a ' +
        'payment that writes NOTHING, and a collect that finishes the write once the payment ' +
        'settles. Between the payment and the settlement A PAYMENT HAS BEEN MADE and no policy ' +
        'exists — that window is normal, not a failure. ' +
        'If `state` is "settling" or "submitted", A PAYMENT HAS BEEN MADE: never call this tool ' +
        'again for the same policy, never tell the user it failed, and pass `paymentReceipt` to ' +
        'check_policy_write instead. "submitted" means the transaction is on chain but the block ' +
        'has not confirmed it — do NOT report the policy as created, even though a txHash is ' +
        'present. ' +
        '"written" is the only state that means the policy exists. ' +
        '"already_exists" and "refused" both come from the FREE pre-check, so nothing was paid. ' +
        '"payment_refused" is different: a payment was presented and the service rejected it, and ' +
        'that says nothing either way about whether the fee was taken — never tell the user they ' +
        'were not charged, and never tell them they were. ' +
        '"receipt_void" is the one state where paying again is correct — the settlement failed and ' +
        'the receipt bought nothing; `payFresh` is set to say so. ' +
        '"write_failed" and "unknown" both mean money moved and paying again would NOT help: quote ' +
        '`paymentReceipt` to support rather than retrying. ' +
        'Never ask the user for their HSM password — this tool does not take one.',
      inputSchema: {
        type: 'object',
        properties: {
          policyKey: {
            type: 'string',
            description:
              'The key this policy is stored under. Free-form, and independent of the template — ' +
              'use it to separate policies that govern different things for the same owner.',
          },
          attributes: {
            type: 'array',
            description:
              'The rules, one { attributeName, attributeType, value } each. A cap expressed "per ' +
              'month" needs BOTH the cap and its window attribute — a cap alone is a LIFETIME cap, ' +
              'which is not what the user asked for. policy_preflight checks this.',
            items: {
              type: 'object',
              properties: {
                attributeName: { type: 'string' },
                attributeType: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['attributeName', 'value'],
            },
          },
          templateContractAddress: {
            type: 'string',
            description: 'The Template contract the template lives on. Required: it is what makes this an adopt.',
          },
          templateId: {
            type: 'string',
            description:
              'The template to type these attributes against. The chain checks the attribute names ' +
              'against it, so a typo is refused instead of deploying a policy that enforces nothing.',
          },
          validFromBlock: { type: 'string', description: 'Block this policy starts at, as a string. Omit for unbounded.' },
          validToBlock: { type: 'string', description: 'Block it ends at, as a string. Omit for unbounded.' },
          requestKey: {
            type: 'string',
            description:
              'A correlation id for this write, generated automatically when omitted. Do NOT treat ' +
              'it as an idempotency key: repeating one is not a safe way to retry. If a write may ' +
              'already have been paid for, ask for the same policyKey again — the free pre-check ' +
              'reports it before any payment.',
          },
          pollBudgetMs: {
            type: 'number',
            description:
              'How long to wait for the settlement before handing back the receipt. The default is ' +
              'about a minute; settlement usually takes around twenty seconds.',
          },
        },
        required: ['policyKey', 'attributes', 'templateContractAddress', 'templateId'],
      },
    },
    {
      name: 'check_policy_write',
      description:
        'Finish a policy write that has already been PAID FOR. FREE — this tool never pays, on any ' +
        'path, which is why it is the right answer to "did my policy get created?" and calling ' +
        'write_policy again is not. ' +
        'Call it with the `paymentReceipt` from a "settling" or "submitted" result, or with no ' +
        'arguments to resume the most recent pending write. ' +
        'The states mean the same as in write_policy: "written" is the only one where the policy ' +
        'exists, "settling" and "submitted" mean keep waiting, and "unknown" means the outcome ' +
        'could not be determined — none of which is a reason to pay again. ' +
        'If this wallet holds no record of the receipt, that does NOT mean the write failed: the ' +
        'service completes a paid write on its own, and asking to write the same policyKey again ' +
        'will report the truth for free before any payment.',
      inputSchema: {
        type: 'object',
        properties: {
          paymentReceipt: {
            type: 'string',
            description: 'The receipt from a pending write. Omit to resume the most recent one.',
          },
          pollBudgetMs: {
            type: 'number',
            description: 'How long to wait for the settlement before reporting back. Defaults to about a minute.',
          },
        },
      },
    },
    {
      name: 'policy_preflight',
      description:
        'Check a draft policy BEFORE it is deployed — FREE, no payment, no signing. It answers two ' +
        'questions. First, is the draft well-formed: every blocker is returned at once in ' +
        '`blockers`, so one round of fixes is enough rather than discovering them one failure at a ' +
        'time. Second, and more important, does the policy MEAN what the user thinks: ' +
        '`interpretation` states in plain words what it actually does. ALWAYS show `interpretation` ' +
        'to the user, INCLUDING when ready is true — a policy can be perfectly valid and still mean ' +
        'something other than what was intended (a spending cap with no window is a LIFETIME cap, ' +
        'not a monthly one), and reporting only "ready" hides exactly that. A clean result is NOT a ' +
        'guarantee: `notChecked` lists what could not be verified, including whether the policy will ' +
        'be enforced at all and whether a payment would currently be allowed.',
      inputSchema: {
        type: 'object',
        properties: {
          policyKey: { type: 'string', description: 'The key this policy would be stored under.' },
          attributes: {
            type: 'array',
            description: 'The draft rules — one { attributeName, attributeType, value } per rule.',
            items: {
              type: 'object',
              properties: {
                attributeName: { type: 'string' },
                attributeType: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['attributeName', 'attributeType', 'value'],
            },
          },
          validFromBlock: { type: 'string', description: 'Block this policy starts at, written as a string.' },
          validToBlock: { type: 'string', description: 'Block it ends at, as a string. "0" means no end.' },
          templateId: { type: 'string', description: 'Template id. Supply this OR publisher + policyKey.' },
          publisher: { type: 'string', description: 'Publisher address, used together with policyKey.' },
        },
        required: ['policyKey', 'attributes', 'validFromBlock', 'validToBlock'],
      },
    },
    {
      name: 'transfer_token',
      description:
        'Send native ZTX or any ZTP20 token (e.g. JMYR) to a Zetrix address. THIS MOVES REAL FUNDS ' +
        'and is irreversible. `token` accepts "ZTX", a registered symbol (resolved from the built-in ' +
        'token list — no contract address needed), or a raw ZTP20 contract address; an unregistered ' +
        "symbol returns needsTokenAddress:true, at which point ask the user for the contract address " +
        "rather than guessing. State the amount as `amountHuman` (\"1.5\", converted using the token's " +
        'on-chain decimals) or `amount` (raw base units) — if you pass both they must agree, which is ' +
        'the cheapest way to catch a 1-vs-1000000 error. Nothing is signed until `confirm: true`: ' +
        'call once without it (or with dryRun:true) to get the resolved amount, destination and fee, ' +
        'SHOW THOSE TO THE USER, and only then re-call with confirm:true. If the result has ' +
        'outcomeUnknown:true the transaction may already be on chain — do NOT retry; check the ' +
        'reported nonce first.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: '"ZTX" for the native coin, a registered symbol (e.g. "JMYR"), or a ZTP20 contract address.' },
          to: { type: 'string', description: 'Destination Zetrix address.' },
          amountHuman: { type: 'string', description: 'Human-readable amount, e.g. "1.5". Converted using the token\'s on-chain decimals. Preferred over `amount`.' },
          amount: { type: 'string', description: 'Amount in the token\'s raw base units, e.g. "1500000" for 1.5 of a 6-decimal token.' },
          confirm: { type: 'boolean', description: 'Must be true to actually send. Never infer this — the user must have seen the amount and destination.' },
          dryRun: { type: 'boolean', description: 'Resolve and price the transfer, then stop without signing or sending.' },
        },
        required: ['token', 'to'],
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
        'no payment (fromCache: true). Setting forceReissue:true alone does NOT pay again — it only asks to ' +
        'be shown that existing credential first: you get back { issued: false, vcId, vc, fromCache: true, ' +
        'reason } instead, and nothing is paid. Show that existing credential to the user and ask whether ' +
        'they actually want to replace it; only call this tool again, with BOTH forceReissue:true and ' +
        'confirmReplaceExistingVc set to exactly the vcId you were shown, if they explicitly say yes. Never ' +
        'pass confirmReplaceExistingVc on your own judgement. When nothing valid is cached, forceReissue has ' +
        'no effect either way — that case has always paid and issued fresh. When a call DOES render a full ' +
        'credential to the user (a fresh issuance, a plain cache hit, or a confirmed replace), show every ' +
        'claim under vc.credentialSubject as a table — not a cherry-picked subset — labelling each key by ' +
        'title-casing it (the exact claim set varies by template; use schema.required/optional to know what ' +
        'to expect), plus vcId and validUntil if present. If vcPassImagePaths is also present, the ' +
        "credential's own pass-design image(s) came back attached to this result — tell the user their " +
        'credential\'s official pass design is shown below and display the image(s); do not silently drop ' +
        'them from your summary just because they are not text. Payment ' +
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
        'Every response also includes { schema: { required, optional } } whenever the template schema could ' +
        "be read from chain — the template's full declared attribute list, so you see the complete field " +
        'list, not just what went wrong. ' +
        'For the AI Birthcert specifically: this issues the BASIC one — self-declared by the agent, ' +
        'agent-paid via x402, owner identity NOT identity-verified. If the user asked for a "verified" AI ' +
        'birthcert (owner identity confirmed via MyDigital ID), use request_ai_birthcert_verification ' +
        'instead — this tool cannot produce that credential.',
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
              'did:zid:... for the configured network. ' +
              'This resolves to the BASIC (self-declared, non-verified) template — for the Verified ' +
              'AI Birthcert, use request_ai_birthcert_verification, not this tool.',
          },
          attributes: {
            type: 'object',
            description:
              'Claim values for the credential (schema varies by template — check what the issuer requires ' +
              'before guessing). ALWAYS ask the human owner directly for any name/identifier-type value ' +
              '(e.g. an agentUsername or similar field) — NEVER invent, guess, or silently reuse one of ' +
              'your own choosing; if the template requires one, get it from the user first. "agentDid" is ' +
              'the one exception: it does not need to be supplied, since it is auto-filled with this ' +
              "wallet's own holder DID (the credential's self-referential subject) unless you explicitly " +
              'override it.',
          },
          expirationDate: { type: 'string' },
          dryRun: {
            type: 'boolean',
            description:
              'Price the credential without paying, signing, or issuing anything. Returns ' +
              '{ quote: { asset, maxAmountRequired, payTo, gasModel, paymentRequired? }, schema: { required, optional } }. ' +
              'Priced via MBI\'s /quote endpoint, which cannot issue — so this is safe even on a template that ' +
              'issues for free (such a template mints synchronously on the real path, which is why pricing never ' +
              'goes through it). Never writes the VC cache, so it cannot displace a credential you already hold. ' +
              '`quote.paymentRequired` is the authoritative free-vs-paid answer: false means issuance is currently ' +
              'free and `maxAmountRequired` will not be charged. When the field is ABSENT the MBI predates it and ' +
              'the amount is unconfirmed — report it as a possible charge, never as certainly free. ' +
              'Still validates required attributes locally first — a missing one blocks before any MBI call.',
          },
          forceReissue: {
            type: 'boolean',
            description:
              'Alone, this does NOT pay again — if a valid credential is already cached it only returns that ' +
              'credential (issued: false, fromCache: true, reason) so it can be shown to the user first. Pair ' +
              'it with confirmReplaceExistingVc to actually pay and reissue over a still-valid one. Has no ' +
              'effect when nothing valid is cached — that case always pays and issues fresh regardless.',
          },
          confirmReplaceExistingVc: {
            type: 'string',
            description:
              'Only for replacing a cached credential that is STILL VALID (not expired). Pass the exact vcId ' +
              'from a prior forceReissue response — never a guess, never made up. Only set this after the ' +
              'user has SEEN that existing credential and explicitly asked to replace it; omit it otherwise, ' +
              'and never set it without forceReissue also being true. A mismatched value is ignored: nothing ' +
              'is paid and you get the same { issued: false, reason } response again, naming the id to ' +
              'confirm. Setting it without forceReissue does nothing at all either way — that case is a ' +
              'plain cache hit ({ issued: true }) regardless of what this field is set to.',
          },
        },
        required: ['templateId', 'attributes'],
      },
    },
    {
      name: 'request_ai_birthcert_verification',
      description:
        'Start a Verified AI Birthcert issuance session with myid (MyDigital ID owner verification). ' +
        'ALWAYS run credential_preflight for "verified_ai_birthcert" immediately before calling this, ' +
        'even if you checked earlier in the conversation — preflight is free, this tool spends real ' +
        'funds, and a balance the user topped up a minute ago is not the balance you read before that. ' +
        'Returns { sessionId, verificationUrl, expiresAt, expiresIn, expiresInSeconds, message } — show verificationUrl to the human owner ' +
        'and ask them to open it and complete MyDigital ID verification (typically finishes in ' +
        'seconds). Tell them how long the link is good for by quoting `expiresIn` exactly as given: ' +
        'the wallet works it out from its own clock, so never calculate the time remaining yourself ' +
        'from `expiresAt` — your clock and timezone may differ from the server\'s. `message` here ' +
        'contains a "Tell the user:" sentence about following up — relay it rather than composing ' +
        'your own reassurance. ' +
        'Once they confirm they are done, call check_ai_birthcert_verification to see ' +
        'whether the credential was issued. Nothing keeps running after this call returns — there is ' +
        'no background polling, webhook, or timer, so you can only check status when the user sends ' +
        'you a new message. NEVER tell the user you have "set up an automation" or that you will ' +
        '"alert them" when it completes — you cannot act on your own between messages, and promising ' +
        'that leaves them waiting for a notification that will never come. Instead, tell them how ' +
        'long the link is good for and ask them to message you back once done (or after a few ' +
        'minutes) so you can check_ai_birthcert_verification again. ALWAYS ask the human owner directly what agentName they ' +
        'want to use for a NEW session — NEVER invent, guess, or silently choose one yourself. (Calling ' +
        'again with the SAME name to resume an already-pending session, as described below, is not ' +
        '"inventing" one — that is reusing the exact name the owner already gave.) IMPORTANT: agentName ' +
        'must be unique — if this exact name has already been used to request a Verified AI Birthcert, ' +
        'issuance will fail. ' +
        'Before calling, ' +
        'ask the human owner whether they want to supply any of the optional fields — agentPurpose, ' +
        'evidenceAssuranceLevel, ownerType, ownerVerified — do not silently omit them; they only need ' +
        'to say no. Calling this ' +
        'again with the SAME agentName while a prior session is still pending returns that same ' +
        'session unchanged — no new session is started and nothing is paid again. This tool spends ' +
        'real funds: it self-pays an x402 challenge, subject to the same credential-issuance payment ' +
        'cap as subscribe_and_issue — a separate, narrower cap than pay_and_fetch\'s, which defaults ' +
        'to refusing everything on mainnet. Set MAX_PAYMENT_AMOUNT to override either. It can return ' +
        '{ error: "..." } instead of a session. Read `message` before deciding what to tell the ' +
        'user or whether retrying is safe — it does NOT always mean nothing was paid. For ' +
        'insufficient funds or a payment-cap block specifically, nothing is created and nothing ' +
        'was paid, so once the underlying problem is fixed (e.g. the user tops up), calling this ' +
        'tool again is the right next step. Several OTHER { error } shapes mean the opposite: a ' +
        'payment may already have been sent on a prior or even this call (blob_already_settled, a ' +
        'receipt that could not be saved locally, RECEIPT VOID, OUTCOME UNKNOWN) — for any of ' +
        'those, calling this tool again pays the fee AGAIN, so do NOT retry without ' +
        'explicit agreement from the user, exactly as `message` itself will say. ' +
        'It can also return { settlementPending: true, paymentReceipt, message } instead — a ' +
        'payment WAS SENT and no session exists yet. That is NOT a failure and NOT an error, but do ' +
        'NOT pay again and do NOT call this tool again to retry it — call ' +
        'check_ai_birthcert_verification to follow it through instead. It covers three different ' +
        'situations, told apart by the `issuerRejected` and `paymentInvalid` fields. With neither ' +
        'set, do NOT assume the payment is known to have succeeded — this shape covers TWO different ' +
        'states that look identical from these fields alone: usually the settlement is genuinely ' +
        'still clearing (the message says "still being processed"), but sometimes the outcome could not ' +
        'be determined at all yet (the message says "has not been confirmed yet" and does not say "still being processed") — an indeterminate ' +
        'state, not a confirmed one, even though neither flag is set. Either way the receipt is ' +
        'saved and you must not pay again, so report it as "payment sent, still settling" without ' +
        'promising the user it definitely succeeded. When the message contains a "Tell the user:" ' +
        'sentence, relay that sentence rather than composing your own reassurance, and if asked what ' +
        'the service said, quote only what the message says it answered. With ' +
        'issuerRejected: true the credential service was reached and refused the request — the ' +
        'settlement is NOT what failed, but do NOT describe this as the payment having succeeded ' +
        'either: `message` quotes its reason, and you must relay that reason rather than ' +
        'describing it as still settling or as a success. With paymentInvalid: true the service ' +
        'has specifically ruled the payment or receipt invalid — do NOT say "the settlement is not ' +
        'what failed" for this one, since this verdict IS about the payment; relay what it said ' +
        'instead, and do NOT describe it as a success either. Neither this case nor issuerRejected ' +
        'tells you whether the fee was taken, in either direction — never tell the user they were ' +
        'not charged, and just as much, never tell them they WERE charged either. That no-claim ' +
        'rule covers issuerRejected and paymentInvalid specifically. The plain no-flag case above is ' +
        'different again, and NOT simply "known to have succeeded" either — see the note on it above: ' +
        'it is two states, only one of which is confirmed, so read `message` there too rather than ' +
        'assuming success from the shape alone. ' +
        'If the user did NOT ask for a "verified" credential specifically, they most likely want the ' +
        'self-declared, non-verified Basic AI Birthcert instead — use subscribe_and_issue for that. ' +
        'BEFORE this pays or starts a session, it checks whether this holder already has a Verified ' +
        'AI Birthcert — found in the local cache, or (if the cache has not seen it yet) resolved from ' +
        'a previously-issued session. If one exists and is STILL VALID, nothing is paid and no session ' +
        'is started — you get back { existingVerifiedVc: { vcId, validUntil }, message } instead. Show ' +
        'that existing credential to the user and ask whether they actually want to replace it; only ' +
        'call this tool again, with confirmReplaceExistingVc set to exactly existingVerifiedVc.vcId, if ' +
        'they explicitly say yes. Never pass confirmReplaceExistingVc on your own judgement. If the ' +
        'existing VC has already EXPIRED, this proceeds automatically — no confirmation needed — and ' +
        'the result carries replacedExpiredVc: { vcId, validUntil } naming the one it replaced. That ' +
        'field can appear on a settled session, on a payment still settling, or on an EARLIER call\'s ' +
        'still-pending session simply being returned unchanged — so treat it only as "the holder\'s old ' +
        'VC had expired", never as proof that THIS call itself just spent money; read the rest of the ' +
        'result (an error, a settled session, or settlementPending) to know what this call actually did. ' +
        'It can also return { error } specifically because an already-issued VC exists but could not be ' +
        'confirmed as valid or expired (a resolution problem, not a payment problem) — nothing is paid ' +
        'on that path either; relay `error` as given, since it names the concrete next step (retry ' +
        'check_ai_birthcert_verification, or as a last resort clear_stuck_payment_receipt with the ' +
        'user\'s explicit agreement).',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: {
            type: 'string',
            description:
              'A unique, human-readable name for this agent. Must not already be in use for a Verified ' +
              'AI Birthcert, or issuance will fail. ALWAYS ask the human owner directly which name to ' +
              'use for a new session — NEVER invent, guess, or silently choose one yourself.',
          },
          agentPurpose: { type: 'string', description: 'Optional — what this agent does, e.g. "Negotiate and settle supplier invoices".' },
          evidenceAssuranceLevel: { type: 'string', description: 'Optional — assurance level of the identity evidence, e.g. "high".' },
          ownerType: { type: 'string', description: 'Optional — the owner\'s type, e.g. "Individual".' },
          ownerVerified: { type: 'string', description: 'Optional — whether the owner is already verified, as the string "true" or "false".' },
          gasPayer: {
            type: 'string',
            enum: ['sponsored', 'self'],
            description:
              'Who pays network gas. "sponsored" (default) asks the platform paymaster to cover gas, ' +
              'so this wallet needs no ZTX. "self" pays gas from this wallet\'s own ZTX balance. ' +
              'Omit to use the configured default.',
          },
          dryRun: {
            type: 'boolean',
            description:
              'Ask the price WITHOUT paying. Returns { quote: { asset, maxAmountRequired, payTo, gasModel } } ' +
              'and spends nothing, creates no session, and starts no verification — so you can tell the user ' +
              'the cost before collecting anything. `maxAmountRequired` is in the asset\'s RAW base units; ' +
              'resolve decimals (wallet_status returns `display`) before quoting a figure to a human. ' +
              'A quote does NOT reserve the name and does NOT check whether it is already taken — myid checks ' +
              'uniqueness only at issuance, so a name already in use still quotes cleanly. `agentName` is still ' +
              'required because the server rejects a request without one, but the fee does not depend on it.',
          },
          discardStuckReceiptAndPayFresh: {
            type: 'string',
            description:
              'DESTRUCTIVE, and it SPENDS. Only for a payment that is genuinely stuck (outcome still ' +
              'unresolved). While the wallet holds a stuck receipt this tool can only replay it — it ' +
              'will never buy a new credential — so this is the way to start over: it throws that ' +
              'payment away and pays a SECOND fee. Not needed for a VOID receipt (settlement ruled ' +
              'expired/failed): the wallet discards that one itself, with no flag and no confirmation, ' +
              'so the next call is already an ordinary fresh purchase. Pass ' +
              'the stuck receipt id EXACTLY as check_ai_birthcert_verification or ' +
              'clear_stuck_payment_receipt reported it — never a guess, never true. A mismatched id ' +
              'discards nothing and pays nothing. Before using it, show the user the receipt id, tell ' +
              'them the first payment is forfeit and that this costs the fee again, and get their ' +
              'explicit agreement. If the receipt turns out to belong to a live session this is refused: ' +
              'that session is already paid for, so call check_ai_birthcert_verification instead. ' +
              'Normally the result carries the id you confirmed as discardedPaymentReceipt — keep it, ' +
              'support needs it to trace the lost payment. But if this call ALSO threw away a void ' +
              'receipt of its own (the fresh payment it just made was then ruled void), ' +
              'discardedPaymentReceipt holds THAT receipt instead, and the id the user confirmed is ' +
              'named at the end of the error text ("ALSO DISCARDED earlier on this same call") — so on ' +
              'that path quote BOTH ids to support, not just the field. ' +
              'A receipt only counts as stuck once it is older than SETTLEMENT_STUCK_AFTER_MS (24h by ' +
              'default, e.g. SETTLEMENT_STUCK_AFTER_MS=3600000 for one hour); before that the wallet ' +
              'REFUSES this parameter outright — nothing is discarded and nothing is paid — so do not ' +
              'offer the user this option for a receipt that is not stuck yet. A bare "retry" or "yes" ' +
              'from the user is not agreement to pay again.',
          },
          confirmReplaceExistingVc: {
            type: 'string',
            description:
              'Only for replacing a Verified AI Birthcert VC that is STILL VALID (not expired). Pass ' +
              'the exact vcId from a prior existingVerifiedVc response — never a guess, never made up. ' +
              'Only set this after the user has SEEN that existing credential and explicitly asked to ' +
              'replace it; omit it otherwise. A mismatched or unconfirmed value is ignored: nothing is ' +
              'paid and no session is started, and you get the same existingVerifiedVc block again. ' +
              'Not needed at all when the existing VC has already expired — that case replaces itself ' +
              'automatically.',
          },
        },
        required: ['agentName'],
      },
    },
    {
      name: 'credential_preflight',
      description:
        'FREE readiness check — call this FIRST, before collecting ANY application detail from the user, ' +
        'whenever they ask for a credential. Spends nothing, signs no transaction, creates no session. ' +
        'Returns { ready, fee, balances, cap, schema?, blockers, notChecked }: the live fee and which side ' +
        'pays gas, the balances that matter, whether the spending limit permits it, and — for a template ' +
        'credential — the attributes it requires. `blockers` lists EVERY reason it is not ready at once ' +
        '(a low balance and a too-low spending limit are different problems and both appear together), so ' +
        'one round of fixes is enough rather than discovering them one failed payment at a time. ' +
        'ALWAYS relay `notChecked` too: a clean result is not a guarantee. In particular it does NOT ' +
        'check whether an agent name is free — myid decides that at issuance, after payment. ' +
        'Report `fee.display` and each balance\'s `display` to the user, never the raw base-unit numbers. ' +
        '`fee.paymentRequired: false` means issuance is currently FREE — `fee.display` is then only what it ' +
        'WOULD cost if payment were switched back on, so do not ask the user to fund it and do not present ' +
        'that amount as a charge. Gas is separate and can still block a free credential. When the field is ' +
        'ABSENT the cost is unknown (an older MBI), and it is treated as chargeable — never report absent as free.',
      inputSchema: {
        type: 'object',
        properties: {
          credential: {
            type: 'string',
            description:
              'Which credential to price: "verified_ai_birthcert" for the MyDigital-ID-verified AI Birthcert, ' +
              'or a template id (did:zid:...) / known template name (e.g. "AI Birthcert") for a template-issued one.',
          },
          agentName: {
            type: 'string',
            description:
              'Optional, and only used for "verified_ai_birthcert". The fee does not depend on it, so omit it ' +
              'when pricing before the user has chosen a name — the wallet substitutes a placeholder purely to ' +
              'satisfy the server. Never present that placeholder as the name that will be used.',
          },
        },
        required: ['credential'],
      },
    },
    {
      name: 'check_ai_birthcert_verification',
      description:
        'Check the status of the most recently requested Verified AI Birthcert session (see ' +
        'request_ai_birthcert_verification). FREE — it never pays for anything. Use this, not ' +
        'request_ai_birthcert_verification, whenever the user asks where their verification link is, ' +
        'what happened to their session, or whether their credential is ready. This tool has NO ' +
        'background/automatic polling — calling it once checks the status once, right now, and ' +
        'nothing more. If status is still pending, do not claim you will keep checking or alert the ' +
        'user later: you cannot act again until they send you another message, so ask them to message ' +
        'you back (now or in a few minutes) and you will check_ai_birthcert_verification again then. ' +
        'While the session is ' +
        'still open the result carries `verificationUrl` (the same link issued at creation) and ' +
        '`expiresAt` and `expiresIn` — give the user the link and `expiresIn` exactly as given, so ' +
        'they know how long it is good for; never work out the time remaining yourself from ' +
        '`expiresAt`, because your clock and timezone may differ from the server\'s. ' +
        'Returns { status: "pending" } while the owner has not ' +
        'yet completed MyDigital ID verification, or { status: "issued", vcId } once myid has minted ' +
        'the credential — myid returns vcId ONLY when status is "issued", never otherwise. On ' +
        '{ status: "issued" }, the wallet also fetches the credential from MBI, verifies it, and caches ' +
        'it locally, returning it as `vc` — it is then also visible via wallet_status and usable by ' +
        'prove_identity without any further call. ' +
        'When `vc` is present, show the user the FULL credential, not a partial summary — render a ' +
        '"Credential Details" table covering vcId (label it "VC ID"), validUntil ("Valid Until"), and ' +
        'EVERY claim under `vc.credentialSubject` (whatever nested object holds them) — do not cherry-pick ' +
        'a few and drop the rest. Use these labels for the claim keys you recognise: agentName -> "Agent ' +
        'Name", ownerName -> "Owner Name", ownerId -> "Owner ID", dob -> "Date of Birth", ownerVerified -> ' +
        '"Owner Verified", evidenceMethod -> "Evidence Method", evidenceProvider -> "Evidence Provider", ' +
        'evidenceDate -> "Evidence Date"; for any other key present, title-case it rather than omitting it ' +
        '— the template can carry optional claims (agentPurpose, ownerType, countryOfOrigin, ' +
        'additionalDetails, etc.) that were not enumerated here. If `vcPassImagePaths` is also present, ' +
        'the credential\'s own pass-design image(s) came back attached to this result — tell the user ' +
        'their credential\'s official pass design is shown below and display the image(s); do not ' +
        'silently drop them from your summary just because they are not text. ' +
        'If `cacheError` is present instead of `vc`, the ' +
        'credential WAS issued successfully but could not be fetched/verified/cached yet (e.g. a ' +
        'transient MBI error) — this is NOT the same as issuance failing, so do not retry ' +
        'request_ai_birthcert_verification; call check_ai_birthcert_verification again instead. Returns ' +
        '{ status: "no_session" } if request_ai_birthcert_verification has never been called. ' +
        'If a previous payment is still clearing, this tool ACTIVELY ADVANCES it — so in that one ' +
        'case it can take up to ~90s to return (it is waiting on the settlement, not hung; every ' +
        'other case returns immediately). It replays the ' +
        'saved receipt (never a new payment) and returns the live session once it settles, so ' +
        'telling the user to check back here genuinely moves things forward. While it is still ' +
        'clearing you get { status: "settlement_pending", paymentReceipt, message }: a payment HAS ' +
        'been made, so never call request_ai_birthcert_verification and never tell the user it ' +
        'failed. With issuerRejected: true (message leads "PAYMENT SENT, BUT THE CREDENTIAL ' +
        'SERVICE REFUSED THE REQUEST") the credential service was reached and refused the request, ' +
        'and message quotes what it said — relay that reason to the user and tell them the ' +
        'verification service is not completing requests right now. Do NOT describe it as a ' +
        'settlement still processing: the settlement is not what failed. The receipt is kept and no ' +
        'new payment was made, so it is worth asking the user to message you back so you can check ' +
        'again later — an outage on their side can clear. This says NOTHING about whether the fee ' +
        'was taken, so never tell the user they were not charged. ' +
        'With paymentInvalid: true (message leads "PAYMENT SENT, BUT THE CREDENTIAL SERVICE SAYS ' +
        'THIS PAYMENT DID NOT VALIDATE") the service has specifically ruled the payment or receipt ' +
        'invalid — different from issuerRejected: do NOT say "the settlement is not what failed" ' +
        'here, because this verdict IS about the payment. Relay what the service said, but this one ' +
        'says NOTHING about whether the fee was taken in EITHER direction — never tell the user they ' +
        'were not charged, and just as much, never tell them they WERE charged either. Do not pay ' +
        'again either way. stuckFor may appear alongside EITHER issuerRejected or paymentInvalid (the ' +
        'receipt happens to also be old) — it is just context on how long this has been retried, not ' +
        'a reason to change any of the advice above for either case. ' +
        'Otherwise, outcomeUnknown tells the remaining cases apart, and without it the message ' +
        'splits again. Without outcomeUnknown the message leads "PAYMENT SENT", and that shape is ' +
        'TWO different states you tell apart by the clause that follows. If it says "still being ' +
        'processed" the settlement is confirmed queued and progressing — ask the user to message ' +
        'you back in a few minutes so you can check again. If it says "has not been confirmed yet" ' +
        'the outcome could not be determined at all yet: do NOT describe that one as progressing ' +
        'and do NOT describe it as succeeded, because it is indeterminate, not confirmed. Either ' +
        'way the receipt is saved, so do not pay again, and ask the user to message you back so ' +
        'you can check again later — you cannot act again on your own between messages. When the ' +
        'message contains a "Tell the user:" sentence, ' +
        'relay it rather than composing your own reassurance. With outcomeUnknown: true (message leads "OUTCOME UNKNOWN") ' +
        'the settlement outcome could not be determined at all and has been unresolved long enough ' +
        'that it is not coming back (stuckFor says how long). The fee was most likely ALREADY TAKEN ' +
        'and no credential was issued — say that plainly rather than implying it may still land. ' +
        'do not just tell the user to wait; give them the paymentReceipt and tell them to quote it ' +
        'to support. Quote paymentReceipt to support in either case if they ask. ' +
        'Separately, { status: "receipt_void" } is TERMINAL: the payment service has ruled that this ' +
        'receipt is finished (it expired, or the settlement failed), so checking again cannot help ' +
        'and no credential will come from it. That does NOT mean the fee was refunded — never tell ' +
        'the user they were not charged; give them paymentReceipt for support. The wallet has already ' +
        'DISCARDED the dead receipt, so nothing is blocking a new purchase: if the user wants the ' +
        'credential, call request_ai_birthcert_verification again and it pays normally. That is the ' +
        'fee AGAIN, so ask them first rather than calling it on their behalf.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'clear_stuck_payment_receipt',
      description:
        'LAST RESORT. Discard a stuck Verified AI Birthcert payment receipt that the wallet is ' +
        'holding and refusing to pay past. DESTRUCTIVE and CANNOT BE UNDONE: the payment it ' +
        'represents becomes unrecoverable — if that settlement ever completes, the funds are ' +
        'forfeit and no credential is issued. Do NOT use this as a retry. If the wallet reports ' +
        '{ status: "settlement_pending" }, a payment has already been made and the settlement may ' +
        'still complete by itself — but that same shape also covers an indeterminate outcome and a ' +
        'service refusal, so do not promise the user it will resolve on its own; call ' +
        'check_ai_birthcert_verification again instead; it actively ' +
        'advances a queued settlement. Only reach for this tool when the outcome has been stuck ' +
        'with no change for a long time and the user accepts losing the payment. The wallet enforces ' +
        'that: a receipt younger than SETTLEMENT_STUCK_AFTER_MS (24h by default) is REFUSED on both ' +
        'steps, so do not offer this option for one. ' +
        'Two steps, deliberately: call it with no arguments first and it clears NOTHING — it returns ' +
        'the receipt id and a warning. Show that id to the user, get their explicit agreement, then ' +
        'call again with confirmReceiptId set to exactly that id. A mismatched id clears nothing. ' +
        'If the settlement completed in between — which is exactly what happens when you follow the ' +
        'advice above and call check_ai_birthcert_verification first — the receipt now belongs to a ' +
        'LIVE, paid-for session and this tool REFUSES to clear on the id alone: it hands back the ' +
        'session id and verification link instead. Give that link to the user; only if they truly ' +
        'want to abandon a session they already paid for, call again with confirmDiscardLiveSession ' +
        'set to true as well.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmReceiptId: {
            type: 'string',
            description:
              'The receipt id to discard, copied exactly from a prior no-argument call. Omit it to be ' +
              'shown the id and the warning first — never guess or invent this value.',
          },
          confirmDiscardLiveSession: {
            type: 'boolean',
            description:
              'Set true ONLY after the tool has refused because the receipt now belongs to a live ' +
              'verification session, and the user has been shown that session\'s link and has ' +
              'explicitly chosen to throw it away anyway. Never set it pre-emptively.',
          },
        },
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

type Payer = (accept: PayRequirement) => Promise<string>

/**
 * Builds every consumer of the two payment-cap maps in one place — the auto-pay closures AND the
 * read-only map `credential_preflight` reports against — so no line in `main()` (istanbul-ignored,
 * live-wiring-only) ever pairs a cap with a payer on its own. `pay_and_fetch` pays whatever an
 * ARBITRARY url demands, so it must keep the refuse-all-by-default map; credential issuance pays a
 * known issuer, so it gets the (possibly more permissive) issuance map, and preflight must report
 * against that same map or it and the guard enforcing it could disagree.
 *
 * `makePay` is injected rather than called directly so this is testable without the live
 * dependencies (contract queries, Wallet BE) `makePay` itself closes over in `main()`.
 *
 * An earlier version of this (`resolvePaymentCapWiring`) pinned which map was which,
 * but `main()` still separately wrote `makePay(payCaps)` / `makePay(payForCredentialCaps)` at the
 * call site — an unguarded pairing a swap there could still flip with every test green. Folding
 * the `makePay(...)` calls in here removes that call site entirely.
 */
/**
 * The wallet's address validator. Two identical defaults exist — this one and
 * buildTransferSafetyWiring's — and both are pinned by tests, so they cannot drift silently; they
 * are not, however, "one place".
 *
 * `checkAddress` is a DEFAULT rather than something a call site passes, so the default itself is
 * what a test exercises and what ships. That closes the mutation class at the CONSUMER: replacing
 * `isValidAddress` inside `mcp-tools.ts` now fails a test.
 *
 * WHAT IT DOES NOT CLOSE, and an earlier version of this comment wrongly claimed it did: the
 * `...buildAddressValidator()` spread in `main()` is itself an expression, and DELETING it still
 * passes the suite — `deps.isValidAddress` becomes undefined and every ADDRESS check degrades to
 * `notChecked`. `main()`'s dep objects are untested as a whole, a gap shared with
 * buildTransferSafetyWiring's own call site rather than one this introduced. Closing it means
 * extracting main()'s ToolDeps construction into something a test can call. Tracked, not done here.
 * Do not read "there is no expression to mutate" into this: there is one, a level up.
 *
 * policy_preflight's ADDRESS gate was wired as
 * `isValidAddress: deps.transferDeps?.isValidAddress` at the mcp-tools call site. Replacing that
 * with `undefined` or `() => true` silently disabled the whole gate and left 1204/1204 green,
 * because every test supplied its own validator locally. That is the class the preceding commit
 * existed to close, so this extends the pattern rather than adding a seam beside it.
 */
/**
 * Everything the two policy-write tools need, or nothing.
 *
 * Returned as a spread, like buildAddressValidator. Be precise about what that buys, because the
 * first version of this comment overclaimed it (APP-M03): the SPREAD ITSELF is still an expression
 * in `main()`, and deleting it leaves both tools unwired. What the shape buys is that the BODY —
 * which client, which store, which payer — is a function a test can call directly, and one now
 * does. The remaining gap is `main()`'s dep object as a whole, which is untested here exactly as
 * it is for buildAddressValidator and buildTransferSafetyWiring; recorded as tracked,
 * not done, and that is still true.
 *
 * THE PAYER COMES FROM buildPayers. `pay` here is `payForPolicyWrite`, built from the same
 * `makePay` every other paying tool uses, so `assertWithinPaymentCap` applies to a policy write
 * exactly as it does to `pay_and_fetch` (per the ticket's AC #2). Which CAP it carries is decided inside
 * buildPayers and deliberately not restated here — that restatement is the R2-M01 defect.
 *
 * The HSM password is bound HERE, in the wiring, so it never crosses into the tool layer: an
 * agent cannot be asked for it, and no tool schema carries a field for it.
 */
export function buildPolicyWriteDeps(input: {
  policyWriteUrl?: string
  network: string
  stateDir: string
  ownerAddress: string
  hsmPassword: string
  /**
   * TYPED AS `Payer`, not as the orchestrator's looser accept type. The call site used to hand
   * this over through `as never`, which switched off the one check that the CAPPED payer is what
   * gets wired — a cast is a silent yes to whatever is passed (APP-M03).
   */
  pay: Payer
  gasPreference: AgenticWalletConfig['gasPreference']
  sleep: (ms: number) => Promise<void>
  /**
   * The Template contract this wallet trusts. Both the preflight read and the equality check
   * against the caller's `templateContractAddress` use it, so they cannot disagree.
   */
  policyTemplateAddress?: string
  /** The chain reader preflight types a draft with — the same seam every other read uses. */
  chainQuery: ContractQuery
}): { policyWriteDeps?: WritePolicyDeps } {
  // Both, not either. Without a template contract there is nothing to type a draft against, and
  // a write that cannot be checked for free is one this wallet will not pay for.
  if (!input.policyWriteUrl || !input.policyTemplateAddress) return {}
  const templateContract = input.policyTemplateAddress
  return {
    policyWriteDeps: {
      client: new PolicyWriteClient(input.policyWriteUrl, (url, init) => fetch(url, init)),
      receipts: createFsPolicyWriteReceiptStore(join(input.stateDir, 'policy-write-receipts')),
      // The one narrowing left, and it is here rather than at the call site so the call site
      // cannot pass something else entirely. The orchestrator describes an accept as an opaque
      // record because it never reads one; the payer wants the SDK's type.
      pay: (accept) => input.pay(accept as PayRequirement),
      // The same ordering every other x402 surface uses, so a policy write cannot end up
      // preferring a different gas model than the rest of the wallet.
      chooseAccept: (accepts) => orderAccepts(accepts as never, input.gasPreference)[0] as never,
      hsmPassword: input.hsmPassword,
      ownerAddress: input.ownerAddress,
      network: input.network,
      sleep: input.sleep,
      templateContract,
      // Built HERE rather than at the call site, because this function has tests and the call
      // site does not. It reads the template through the configured contract — the same address
      // the equality check above compares the caller's against — so the draft is typed against
      // exactly the template it will be written against.
      preflight: async (draft) =>
        policyPreflight(
          {
            network: input.network,
            isValidAddress: (address) => keypair.checkAddress(address),
            readTemplate: async (d: DraftPolicy) =>
              d.templateId
                ? getTemplateById(d.templateId, templateContract, input.chainQuery)
                : {
                    error: 'query_failed' as const,
                    detail: 'no templateId supplied, so the draft could not be typed against a template',
                  },
          },
          { ...draft, attributes: draft.attributes.map((a) => ({ ...a, attributeType: a.attributeType ?? '' })) },
        ),
    },
  }
}
export function buildAddressValidator(
  checkAddress: (address: string) => boolean = (address) => keypair.checkAddress(address),
): { isValidAddress: (address: string) => boolean } {
  return { isValidAddress: (address) => checkAddress(address) }
}

/**
 * The Policy Decision Point client, or nothing.
 *
 * Returned as a spread, the same shape as buildAddressValidator. Be precise about what that
 * buys: the BODY is a function a test can call, and one does. The spread in main() is still an
 * expression, and deleting it leaves check_policy_decision answering "not configured" on a
 * wallet that is — a gap shared with the two builders beside it, and still tracked rather than
 * closed.
 *
 * Absent unless POLICY_DECISION_URL is set, and that absence is deliberate rather than a
 * missing default. There is no URL this wallet could reach today: ms-zetrix mounts the
 * decision endpoint under /policy/**, which carries no entry in its PUBLIC_PATHS and so
 * inherits anyRequest().authenticated(), and this wallet holds no BaaS token. Guessing a host
 * would turn "nobody has wired this up" into a connection error, which reads like a transient
 * fault rather than a missing integration — the same honesty convention as
 * derivePolicyRegistryAddress returning undefined on mainnet.
 *
 * With no client, check_policy_decision answers "undetermined" and says why. It never answers
 * "permitted".
 */
export function buildPolicyDecisionClient(config: {
  policyDecisionUrl?: string
  policyDecisionAuth?: string
}): { policyDecisionClient?: PolicyDecisionClient } {
  if (!config.policyDecisionUrl) return {}
  return {
    policyDecisionClient: new PolicyDecisionClient(
      config.policyDecisionUrl,
      (url, init) => fetch(url, init),
      config.policyDecisionAuth,
    ),
  }
}

/**
 * The two safety-critical halves of the TRANSFER wiring: the address validator transfer_token
 * uses, and the submit wrapper that flags a node rejection.
 *
 * Its original docblock was orphaned when buildAddressValidator was inserted between the two —
 * this is a replacement, not the original text.
 *
 * Note this validator is SEPARATE from buildAddressValidator above. Same body, different object:
 * this one reaches transfer_token through TransferDeps, that one reaches policy_preflight through
 * ToolDeps. Neither is shared with the other, and comments claiming otherwise were a real
 * finding.
 *
 * checkAddress is a DEFAULT rather than a call-site argument, so the default is what a test
 * exercises and what ships.
 */
export function buildTransferSafetyWiring(
  submitTransaction: (args: {
    blob: string
    signature: Array<{ signData: string; publicKey: string }>
  }) => Promise<{ errorCode?: number; errorDesc?: string; result?: { hash?: string } }>,
  checkAddress: (address: string) => boolean = (address) => keypair.checkAddress(address),
): Pick<TransferDeps, 'isValidAddress' | 'submit'> {
  return {
    // The SDK's own checksum validator — the same one zetrix-sdk-nodejs uses for its
    // `address: true` schema fields. A shape regex accepts a one-character Base58 typo; this does
    // not.
    isValidAddress: (address) => checkAddress(address),
    submit: async ({ blob, signBlob, publicKey }) => {
      const res = await submitTransaction({ blob, signature: [{ signData: signBlob, publicKey }] })
      if (res.errorCode !== 0) {
        // REJECTED, not indeterminate: the node answered and refused. Flagged on a FIELD so the
        // orchestrator can tell it apart from a lost response without reading the message —
        // prose matching is a mistake this design deliberately unpicked.
        throw Object.assign(
          new Error(`submit rejected with errorCode ${res.errorCode}${res.errorDesc ? `: ${res.errorDesc}` : ''}`),
          { submitRejected: true as const, errorCode: res.errorCode },
        )
      }
      const hash = res.result?.hash
      if (!hash) throw new Error('submit returned no transaction hash')
      return { hash }
    },
  }
}

export function buildPayers(
  config: { maxPaymentAmount: Record<string, string>; credentialIssuanceCaps: Record<string, string> },
  makePay: (caps: Record<string, string>) => Payer,
): {
  pay: Payer
  payForCredential: Payer
  payForPolicyWrite: Payer
  preflightCaps: Record<string, string>
} {
  return {
    pay: makePay(config.maxPaymentAmount),
    payForCredential: makePay(config.credentialIssuanceCaps),
    // THE GENERAL CAP, not the credential one. A policy write is a known service fee, which makes
    // it tempting to file beside credential issuance — but the credential allowance exists to let
    // a wallet buy CREDENTIALS, and a policy write drawing on it would spend an allowance granted
    // for something else. maxPaymentAmount is the map a user raises when they mean "this wallet
    // may spend", and it is refuse-all by default on mainnet, which is the right default for a
    // path that puts a spending policy on chain.
    payForPolicyWrite: makePay(config.maxPaymentAmount),
    preflightCaps: config.credentialIssuanceCaps,
  }
}

/**
 * The config-derived half of the Verified AI Birthcert deps, extracted so it is observable.
 *
 * Written inline in `main()`, `settlementWaitBudgetMs: config.settlementWaitBudgetMs` could
 * be deleted with the whole suite still green — `SETTLEMENT_WAIT_BUDGET_MS` would parse, validate
 * and warn exactly as tested, then never reach the retry loop. Same class as the cap wiring in
 * `buildPayers`, and the same remedy: the mapping lives in one place a test can call.
 */
export function buildSettlementWiring(
  config: Pick<
    AgenticWalletConfig,
    | 'gasPreference'
    | 'maxSettlementAttempts'
    | 'settlementWaitBudgetMs'
    | 'settlementStuckAfterMs'
    | 'aiBirthcertVerifiedTemplateId'
  >,
): {
  gasPreference: AgenticWalletConfig['gasPreference']
  maxSettlementAttempts: number
  settlementWaitBudgetMs: number
  settlementStuckAfterMs: number
  verifiedTemplateId: string | undefined
} {
  return {
    gasPreference: config.gasPreference,
    maxSettlementAttempts: config.maxSettlementAttempts,
    settlementWaitBudgetMs: config.settlementWaitBudgetMs,
    settlementStuckAfterMs: config.settlementStuckAfterMs,
    verifiedTemplateId: config.aiBirthcertVerifiedTemplateId,
  }
}

/** MBI's accepts[] lack gasModel; x402 self-pay needs extra.gasModel = 'client'. */
export function asPayRequest(accept: PayRequirement): X402PayRequest {
  const extra = (accept.extra ?? {}) as Record<string, unknown>
  const prepareEndpoint = extra.prepareEndpoint
  const normalizedExtra =
    typeof prepareEndpoint === 'string' && prepareEndpoint !== ''
      ? { ...extra, prepareEndpoint: prepareBaseUrl(prepareEndpoint) }
      : extra
  return { ...(accept as Record<string, unknown>), extra: { gasModel: 'client', ...normalizedExtra } } as unknown as X402PayRequest
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
  const { zetrixAddress, holderDid, publicKeyHex, created, didMismatch, activated } = await resolveHolder(
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

  const mbi = new MbiClient(config.mbiBaseUrl)
  // MBI's /vp/ext/* message-signing auth: sign the holder's own address (UTF-8), not a hex blob.
  const messageSigner = (message: string) => be.signMessage(message, zetrixAddress, hsmPassword)

  // Render a raw base-unit amount as "raw (human SYMBOL)" for error messages — resolving a ZTP20
  // contract address to its real symbol/decimals, same as pay_and_fetch's success path already
  // does for `asset`. Falls back to "raw SYMBOL"/"(unknown asset)" when resolution fails or the
  // human conversion is identical to the raw string (e.g. decimals unknown), so a payment amount
  // is never hidden behind a failed lookup.
  const formatAssetAmount = async (asset: string, raw: string): Promise<string> => {
    const { symbol, decimals } = await resolveAssetInfo(asset, contractQuery)
    const label = symbol || '(unknown asset)'
    const human = formatHumanAmount(raw, decimals)
    return human === raw ? `${raw} ${label}` : `${raw} (${human} ${label})`
  }

  // x402 self-pay: build the X-PAYMENT header for a given accept — a hard ceiling on
  // maxAmountRequired, enforced regardless of what the calling agent was told to do.
  //
  // Built per-caps rather than shared, because the two auto-pay surfaces do not deserve the same
  // default. `pay_and_fetch` pays whatever an ARBITRARY url demands, so its default stays
  // refuse-all on mainnet; credential issuance pays a known issuer for a known credential, so it
  // may carry the credential-fee allowance there. An explicit MAX_PAYMENT_AMOUNT collapses the two
  // back into one identical ceiling (see config.ts). Which map goes to which closure/consumer is
  // decided entirely inside buildPayers below, which is why that pairing must not be
  // written out again at this call site.
  const makePay = (caps: Record<string, string>) => async (accept: PayRequirement): Promise<string> => {
    const rawAsset = String(accept.asset ?? '')

    try {
      assertWithinPaymentCap(accept, caps)
    } catch (err) {
      // Rebuild the "exceeds cap" message with a resolved symbol + human amount instead of a raw
      // contract address and a bare integer — without this, a ZTP20 cap rejection reads as
      // "10000 <address>" (or gets mislabeled "ZTX" by whatever relays it), when it's actually a
      // tiny fraction of a real token. Config-shaped failures (no cap entry, malformed input) have
      // no `.detail` and no amount to humanize, so they pass through unchanged.
      //
      // Only the AMOUNTS are substituted — the explanation itself comes from formatCapRefusal, so
      // the "which key applied" wording cannot drift from the raw-unit message the guard threw.
      if (err instanceof PaymentCapError && err.detail) {
        const { asset, requiredRaw, capRaw } = err.detail
        throw new PaymentCapError(
          formatCapRefusal(
            err.detail,
            await formatAssetAmount(asset, requiredRaw),
            await formatAssetAmount(asset, capRaw),
          ),
          err.detail,
        )
      }
      throw err
    }

    // Stopgap for a bug in x402-zetrix-client: its ZTX-gas balance check for a ZTP20
    // payment runs AFTER an on-chain fee-estimation call, so a wallet holding the resource token
    // but zero ZTX hits an opaque node error from that estimation instead of a clean
    // insufficient-funds message (surfaces as a raw MCP -32603, not a readable result). Checking
    // gas balance here — before ever calling PaymentEngine.pay — catches exactly that common case
    // ("topped up the token, forgot gas") with our own clear message. A low-but-nonzero gas
    // balance still reaches PaymentEngine.pay unchanged; its (later, but working) check catches that.
    if (needsNativeGasCheck(accept)) {
      const gasBalance = await fetchNativeBalance(zetrixAddress).catch(() => null)
      if (gasBalance === '0') {
        const { symbol } = await resolveAssetInfo(rawAsset, contractQuery)
        throw new PaymentReadinessError(
          `this wallet has 0 ZTX to pay network gas — the ${symbol || rawAsset} balance is separate from ` +
            `gas, and every transaction costs a small amount of ZTX regardless of which token is being ` +
            `paid. Send some ZTX to ${zetrixAddress} first, then retry.`,
          { asset: 'ZTX', required: 'unknown', available: '0', reason: 'gas' },
        )
      }
    }

    try {
      return await payWithReadinessCheck(
        rawAsset,
        () => PaymentEngine.pay(asPayRequest(accept), walletCfg, node, {}, walletBeSignerFn),
        activated,
      )
    } catch (err) {
      // Same symbol/decimal enrichment for an insufficient-balance rejection — "gas" always means
      // ZTX regardless of what asset was being paid; "resource_payment" means the paid asset itself.
      if (err instanceof PaymentReadinessError && err.shortfall.reason !== 'not_activated') {
        const { asset, required, available, reason } = err.shortfall
        const label = reason === 'gas' ? 'ZTX for gas' : (await resolveAssetInfo(asset, contractQuery)).symbol || asset
        throw new PaymentReadinessError(
          `insufficient ${label} — required ${await formatAssetAmount(asset, required)}, ` +
            `available ${await formatAssetAmount(asset, available)}`,
          err.shortfall,
        )
      }
      throw err
    }
  }

  // `pay` (pay_and_fetch, arbitrary URLs — refuse-all by default on mainnet), `payForCredential`
  // (a known issuer — carries the credential-fee allowance on both networks) and `preflightCaps`
  // (the read-only map credential_preflight reports against) all come from one call so nothing
  // else in main() pairs a cap map with what consumes it.
  const { pay, payForCredential, payForPolicyWrite, preflightCaps } = buildPayers(config, makePay)

  // MBI's pass-design PNG(s) for an issued VC (extraData.vcPassBase64 from /v1/vc/ext/download).
  // Shared across both the Verified AI Birthcert flow and basic subscribe_and_issue — the download
  // is one-shot per vcId (see ssivc-download-quarantine-store.ts), so both paths
  // must guard against re-downloading the same vcId through the same quarantine store.
  // A DIRECTORY, not a single file — one quarantine file per vcId, so a later download can
  // never overwrite an earlier, still-needed preserved credential.
  const downloadQuarantine = createFsDownloadQuarantineStore(join(config.stateDir, 'ssivc-download-quarantine'))
  const passImagesDir = join(config.stateDir, 'vc-pass-images')
  const mbiAuth = async () => {
    const { signBlob, publicKey } = await messageSigner(zetrixAddress)
    return { signedData: signBlob, publicKey }
  }

  // AI Birthcert verification session (myid SSIVC) — persisted so check_ai_birthcert_verification
  // survives a restart. As of 2026-08-17 the session-create call needs no bearer token — it's
  // gated by x402 instead (see docs/verified-birthcert-vc/SPEC.md §5.0), so payment readiness/cap
  // checks (this same `pay` closure) are what gate spending. Wiring itself is gated on
  // `config.ssivcBaseUrl` being set: it's undefined on mainnet unless explicitly overridden
  // (the mainnet host was never actually confirmed reachable), so the feature reports
  // itself as not configured there rather than being wired against an unverified endpoint.
  const verifyAiBirthcert = config.ssivcBaseUrl
    ? (() => {
        const ssivcSessionStore = createFsSsivcSessionStore(join(config.stateDir, 'ssivc-session.json'))
        const ssivc = new SsivcClient(config.ssivcBaseUrl!)
        const verifyAiBirthcertDeps = {
          ssivc,
          signHexBlob: walletBeSignerFn,
          messageSigner,
          mbi,
          pay: payForCredential,
          publicKeyHex,
          address: zetrixAddress,
          holderDid,
          now: () => new Date(),
          sessionStore: ssivcSessionStore,
          cache: vcCache,
          quarantine: downloadQuarantine,
          // gasPreference, maxSettlementAttempts, settlementWaitBudgetMs and verifiedTemplateId —
          // see buildSettlementWiring.
          ...buildSettlementWiring(config),
          formatAssetAmount,
          passImagesDir,
        }
        return {
          request: (input: Parameters<typeof requestAiBirthcertVerification>[1]) => requestAiBirthcertVerification(verifyAiBirthcertDeps, input),
          check: () => checkAiBirthcertVerification(verifyAiBirthcertDeps),
          clearStuckReceipt: (input: ClearStuckPaymentReceiptInput) => clearStuckPaymentReceipt(verifyAiBirthcertDeps, input),
        }
      })()
    : undefined

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

  // transfer_token deps. Blob construction is BlobBuilder — the same tested code x402 payments
  // use — and signing is the same Wallet BE HSM path; the only genuinely new primitive is
  // submission, since nothing else in this server ever broadcasts a transaction itself.
  const transferDeps: TransferDeps = {
    sourceAddress: zetrixAddress,
    // isValidAddress and submit BOTH come from buildTransferSafetyWiring, which is where they are
    // tested. Writing either here again recreates the same unguarded call site problem.
    ...buildTransferSafetyWiring((args) => sdk.transaction.submit(args)),
    resolveTokenAddress: (symbol) => resolveTokenAddress(symbol, config.network),
    fetchDecimals: async (contractAddress) => {
      const info = await fetchTokenInfo(contractAddress, contractQuery)
      // `decimals` is 0 both for a genuine 0-decimal token and for an unreadable field, so the
      // flag is what makes the orchestrator's refusal possible at all.
      return info && info.decimalsReadable ? info.decimals : null
    },
    queryBalance: (token) => runTokenBalanceQuery(tokenBalanceDeps, token),
    fetchNativeBalance,
    fetchNonce: (address) => PaymentEngine.fetchNonce(address, node),
    buildOperation: (asset, payTo, amount, clientAddress) => BlobBuilder.buildOperation(asset, payTo, amount, clientAddress),
    estimateFee: (p) => PaymentEngine.estimateFee(p, node),
    buildBlob: (p) => BlobBuilder.build(p),
    sign: walletBeSignerFn,
    /**
     * ADVISORY ONLY — this is not the control that governs a transfer.
     *
     * Per the 2026-09-22 scope decision, transfer is governed by the POLICY ENGINE, and Wallet BE
     * is the enforcement point: it consults the policy decision service and refuses to sign — see
     * `docs/policy-engine/DESIGN.md` §7, which already routes transfer enforcement there. That
     * refusal is authoritative and this check cannot replace it, because a client-side ceiling is
     * only as honest as the client.
     *
     * It is kept, and wired to the general MAX_PAYMENT_AMOUNT bucket rather than the credential
     * one, for two reasons. It fails fast, so an obviously-doomed transfer never reaches the
     * signer. And Wallet BE does not enforce policy yet — until it does, removing this would leave
     * transfers bounded by nothing at all.
     */
    assertWithinCap: (asset, amount) => assertWithinPaymentCap({ asset, maxAmountRequired: amount }, config.maxPaymentAmount),
  }

  const deps: ToolDeps = {
    config: {
      holderDid,
      zetrixAddress,
      network: config.network,
      policyRegistryAddress: config.policyRegistryAddress,
      policyTemplateAddress: config.policyTemplateAddress,
    },
    makeWallet,
    payer,
    subscribeDeps: {
      mbi,
      sign: subscribeSign,
      pay: payForCredential,
      resolveSymbol,
      holderDid,
      resolveTemplateFields,
      cache: vcCache,
      auth: mbiAuth,
      address: zetrixAddress,
      quarantine: downloadQuarantine,
      passImagesDir,
    },
    // The RAW seam, for the policy client, which reads the query_rets envelope itself.
    transferDeps,
    // policy_preflight's validator. transfer_token has its OWN, from buildTransferSafetyWiring
    // above — two identical-bodied defaults, not one shared instance.
    ...buildAddressValidator(),
    // Absent unless POLICY_DECISION_URL is set — see buildPolicyDecisionClient for why there is
    // no default host. Its absence makes check_policy_decision answer "undetermined", never
    // "permitted".
    ...buildPolicyDecisionClient(config),
    // The policy write tools. Absent on a network with no write endpoint, which makes them
    // answer "not available, nothing was paid" rather than fail against a guessed host.
    ...buildPolicyWriteDeps({
      policyWriteUrl: config.policyWriteUrl,
      network: config.network,
      stateDir: config.stateDir,
      ownerAddress: zetrixAddress,
      hsmPassword,
      pay: payForPolicyWrite,
      gasPreference: config.gasPreference,
      sleep,
      policyTemplateAddress: config.policyTemplateAddress,
      chainQuery: contractQuery,
    }),
    chainQuery: contractQuery,
    queryContract: (input: ContractQueryInput): Promise<ContractQueryResult> => runContractQuery(input, contractQuery),
    queryTokenBalance,
    // Read-only, for credential_preflight's cap headroom. Preflight only ever prices credentials,
    // so it must report against the issuance cap — the same map payForCredential enforces, or
    // preflight and the guard would disagree about what is permitted.
    paymentCaps: preflightCaps,
    // The session password is bound here, in the wiring, so it never crosses into the tool
    // layer — create_holder_account has no password parameter for a model to be asked for.
    createAccount: (label, purpose) => be.createAccount(hsmPassword, label, purpose),
    saveAccount: (account) => accountStore.set({ ...account, hsmPassword, createdAt: new Date().toISOString() }),
    checkActivationStatus: (address: string) => be.checkActivationStatus(address),
    sleep,
    cache: vcCache,
    verifyAiBirthcert,
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
      return { content: await buildToolContent(result, (p) => readFile(p)) }
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
