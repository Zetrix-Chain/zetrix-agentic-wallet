# Zetrix Agentic Wallet MCP

An agent-facing **MCP server** that gives an AI agent a Zetrix wallet: it **proves identity**
(x401), **pays** (x402), and **obtains verifiable credentials** (via the MBI issuer) — by
orchestrating existing SDKs/MCPs. It is a thin composer: all heavy crypto and payment logic
lives in the imported libraries. No private key ever exists in this process — everything signs
through Wallet BE's HSM.

- **x401** proof → [`x401-zetrix-client`](https://www.npmjs.com/package/x401-zetrix-client) (npm)
- **x402** payment → [`x402-zetrix-client`](https://www.npmjs.com/package/x402-zetrix-client) (npm)
- **VC presentation** (BBS+ VP derivation) → MBI RS (`/v1/vp/ext/create` + `/v1/vp/ext/submit`, `includeVp: true`)
- **issuer key resolution** (for the OID4VP submit body) → the Zetrix ZID resolver (`https://zid-resolver[-sandbox].zetrix.com`)
- **holder key custody + signing** → Wallet BE softHSM (`/wallet/hsm/*`)
- **VC issuance** → MBI RS (`/v1/vc/pay/*`)

[`docs/USAGE_FLOW.md`](https://github.com/Zetrix-Chain/zetrix-agentic-wallet/blob/main/docs/USAGE_FLOW.md) has a full end-to-end prompt script (onboarding →
VC issuance → identity proof → pay-per-use).

## Tools

| Tool | Does | Input | Output (shape) |
|---|---|---|---|
| `wallet_status` | Report holder DID/address/network + held VCs (client-supplied, or the local cache); optionally a token balance | `{ heldCredentials?, token? }` | `{ holderDid, zetrixAddress, network, credentials, tokenBalance? }` |
| `prove_identity` | Answer an x401 `PROOF-REQUEST` → return the `PROOF-RESPONSE` header to replay | `{ proofRequest, vc?, revealAttribute?, issuerKeys? }` | `{ proofResponseHeader, verified, presentationId }` |
| `pay_and_fetch` | Fetch a URL, auto-pay with x402 (self-pay via Wallet BE) on `402` | `{ url, method?, headers?, body? }` | `{ status, body, paymentMade, amountPaid, amountPaidHuman, asset }` |
| `subscribe_and_issue` | Reuse a cached VC if still valid, else pay x402 → MBI issues → return the VC | `{ templateId, attributes, expirationDate?, dryRun?, forceReissue? }` | `{ issued, vcId, vc, txHash, fromCache?, schema?, originalPayment?, paymentAttempted?, recovery? }` |
| `create_holder_account` | Onboarding: mint an HSM account (the MCP already auto-creates one at startup if `ZETRIX_ADDRESS` is omitted — see Environment below). Always checks for an existing account first — if one is active for this session, returns `{ alreadyExists: true, existing }` without creating anything; pass `confirmNew: true` (after asking the user) to mint a new one anyway | `{ password, label?, purpose?, confirmNew? }` | `{ created, alreadyExists, existing?, zetrixAddress?, holderDid?, publicKeyHex?, message }` |
| `get_template_schema` | **Free** read of a VC template's declared attribute schema. Call before `subscribe_and_issue` to learn which attributes it requires | `{ templateId }` | `{ templateId, schema: { required, optional } }` or `{ templateId, error }` |
| `query_contract` | Read-only query against any Zetrix contract — call an arbitrary method and return its raw result. No signing, no state change | `{ contractAddress, method, params? }` | `{ ok: true, result }` or `{ ok: false, error }` |

> **VCs are cached locally**, keyed by `templateId`, under `~/.agentic-wallet-mcp/vc-cache/`
> (scoped per network + holder — different identities or networks never share a cache).
> `subscribe_and_issue` checks the cache before paying: a still-valid cached VC is returned
> immediately with `fromCache: true` and **no payment made**; pass `forceReissue: true` to pay
> and issue fresh regardless. `wallet_status`/`prove_identity` fall back to the cache
> automatically when you don't pass `heldCredentials`/`vc` explicitly — `prove_identity` only
> auto-selects when there's exactly one valid cached VC; with zero or several, it errors and
> asks you to pass `vc` explicitly. Explicitly passing `vc`/`heldCredentials` (including `[]`)
> always overrides the cache. Validity is read from the VC's own `validUntil` field, falling
> back to the `expirationDate` requested at issuance; a VC with neither is cached indefinitely.
> All Ed25519 signing still goes through Wallet BE HSM; no plaintext private keys.

> `subscribe_and_issue` also returns `schema: { required, optional }` — the template's full
> declared attribute list, read from chain — on every outcome that reaches the chain (issued,
> dry-run quote, or a missing-attribute error), so you always see the complete field list rather
> than only what went wrong — **including on a cache hit**, so a caller holding a credential can
> still see what the template currently asks for.
> Attributes the wallet auto-fills for you (e.g. `agentDid`, or a template-declared derived
> key like the `AI Birthcert` template's `id` ← `agentUsername`) are omitted from `schema` since
> you never need to supply them. Some templates also declare format validators for optional
> attributes (e.g. `AI Birthcert`'s `dob` must be `YYYY-MM-DD`, `countryOfOrigin` must be a valid
> ISO 3166 code or name) — an invalid value is rejected locally before any payment or MBI call.

> **A held credential can go stale without expiring.** `isVcValid` only asks whether a VC is past
> its `validUntil` — a VC whose *fields* no longer match the template it came from still reads as
> valid. When an issuer changes a template (adds a required attribute, drops one), a cache hit now
> reports the delta:
>
> ```jsonc
> { "fromCache": true, "staleAttributes": { "missing": ["agentUsername"], "dropped": ["agentName"] } }
> ```
>
> `missing` is what a reissue would need you to supply; `dropped` is what the held VC carries that
> the template no longer declares. Absent when the held VC still satisfies the template. **The
> cached VC is still returned** — this reports, it does not re-issue or charge. Reported from live
> testing: without it, an agent reusing the attributes from a previously-issued credential only
> discovered a newly-required field by attempting an issuance and being rejected.

> **`get_template_schema` is the free way to ask what a template needs**, and is what an agent
> should reach for before building an issuance request. It takes a `did:zid:...` id *or* a known
> template name (e.g. `"AI Birthcert"`), performs no payment/signing/MBI call, and hides the
> attributes the wallet fills in itself. A template it cannot read returns `{ error }` rather than
> an empty schema, so *"needs nothing"* is never confused with *"couldn't look it up"*.
> (`subscribe_and_issue` with `dryRun: true` also returns the schema, alongside the price — use
> that when you want both.)

> `create_holder_account` mints a **brand-new** keypair — Wallet BE's `/account/create` has no
> way to provision a pre-chosen address. It always checks first whether an account is already
> active for this session; if so, it returns `{ alreadyExists: true, existing }` and creates
> nothing — ask the user whether to keep the existing account or replace it, then call again
> with `confirmNew: true` only if they want a new one. A freshly minted account (address, DID,
> **and** password) is saved to this MCP's own local account store
> (`~/.agentic-wallet-mcp/account.json`, owner-only) and reused automatically on the next
> restart — no manual config edit needed. An explicit `ZETRIX_ADDRESS`/`HSM_PASSWORD` still set
> in your MCP config always overrides the saved account (see Environment below); the tool never
> writes the MCP host's own config file or restarts the server for you.

> **What a call cost is reported precisely.** `paidAsset`/`amountPaid` are set **only when this
> call paid**. A cache hit reports the earlier charge under `originalPayment: { txHash, asset,
> amount }` — never as `amountPaid` — so summing spend across calls cannot double-count a free
> hit (omitted entirely when the cached VC was issued free). If issuance fails **after** the x402
> payment has already settled on chain (MBI phase 2), the response carries
> `paymentAttempted: { asset, amount, paymentId }`. MBI's own error body reports none of these, so
> this is the only in-band signal that you were charged — and `paymentId` is the handle MBI's
> recovery endpoint takes. It is never set for a phase-1 failure, which happens before anything is
> paid. **Never retry a post-payment failure: the funds may already be gone, and each attempt costs
> the full amount again — look the `paymentId` up instead.**

> **Two post-payment failures exist and they mean different things:**
> `4006` is a *definitive* facilitator rejection, while `4012` (HTTP 502) means the settle outcome
> is **indeterminate** — MBI stopped listening but the payment may well have landed, so it
> deliberately leaves the record recoverable rather than marking it failed. On `4012` the wallet
> polls `GET /v1/vc/pay/status/{paymentId}` for you and reports
> `recovery: { status, txHash?, vcId?, polls }`:
>
> | `recovery.status` | Means |
> |---|---|
> | `ISSUED` | The payment landed and the credential exists after all. `/status` returns only its `vcId`, **not** the VC body — so `vc` stays unset and you fetch it separately. |
> | `FAILED` | MBI's terminal verdict on the payment. |
> | `REQUIRED` / `SETTLED` | Still unresolved when the poll budget ran out — check again later with the `paymentId`. |
> | `UNKNOWN` | `/status` itself was unreachable. The charge still stands; retry the lookup, not the payment. |

> `wallet_status({ token })` returns `tokenBalance: { token, balance, decimals }` for `ZTX` or any
> registered ZTP20 symbol (e.g. `JMYR`). `balance` is in the asset's **raw base units** — the same
> unit x402 quotes `maxAmountRequired` in, so cap checks and quote comparisons stay integer-only.
> Divide by `10^decimals` to display it: `"473999900"` with `decimals: 6` is `473.9999 JMYR`.
> `decimals` is `null` if the token's `contractInfo` can't be read (the balance is still returned).
> A failed lookup reports `{ token, error: "query_failed" }` and an unregistered symbol
> `{ token, error: "unknown_token" }` — **never a zero balance**, so "0" always means you really
> hold nothing rather than that the node was unreachable.

> `query_contract` is a **pass-through**: whatever you put in `method` is sent to the contract
> as-is. It performs no validation and holds no ABI or method list — the contract decides what it
> understands, and an unknown method comes back as `{ ok: false, error: "query_contract: no result
> value returned" }`, the same shape as a typo. To discover what a token supports, start with
> `contractInfo` (returns `symbol`, `decimals`, `protocol`, `supply`, …); a `protocol: "ztp20"`
> contract implements at least `balanceOf({ address })`, `totalSupply()` and
> `allowance({ owner, spender })`. Read-only only (`optType: 2`) — state-changing methods like
> `transfer`/`approve` need signing and are not reachable through this tool.

> `revealAttribute` on `prove_identity` is optional and usually should stay that way. Omitted,
> it's derived automatically from the challenge's DCQL `credential_requirements` — each claim path
> is resolved against the presented VC's `credentialSubject` (e.g. a DCQL leaf name `agentName`
> resolves to the VC's actual nested path `agentIdentityCredential.agentName`). Only pass it
> explicitly to reveal a narrower or different set of claims than the challenge asked for.

> `prove_identity` no longer takes a `bbsPublicKey` input at all. The OID4VP verifier
> (`openid4vp-verifier-be`) checks each VC's own issuer-signed proof(s) against the
> `bbs_public_key`/`ed25519_public_key` it's sent — and its own DID-resolution fallback isn't
> implemented server-side, so it needs the real issuer keys, not a holder key. The wallet now
> resolves them itself: it reads the VC's `issuer` DID and each `proof[].verificationMethod`,
> resolves the issuer's DID document via the Zetrix ZID resolver, and matches the BBS+
> (`publicKeyMultibase`) and Ed25519 (`publicKeyHex`) verification methods referenced by the VC's
> own proofs. `issuerKeys` is still accepted as a manual escape hatch if the resolver is ever
> unreachable.

## Install

Run it directly via `npx` — no install step needed (see "Configuring in Claude Desktop / Claude
Code" below for wiring it into an MCP client):

```bash
npx agentic-wallet-mcp
```

Or install [`agentic-wallet-mcp`](https://www.npmjs.com/package/agentic-wallet-mcp) directly:

```bash
npm i agentic-wallet-mcp
```

Node ≥ 18 required (built-in `fetch`).

## Environment

| Variable | Required | Description |
|---|---|---|
| `ZETRIX_NETWORK` | yes | `zetrix:testnet` or `zetrix:mainnet` — also selects the default `WALLET_BE_URL`/`MBI_BASE_URL`/`OID4VP_BASE_URL`/`ZID_RESOLVER_BASE_URL` below |
| `HSM_PASSWORD` | yes* | HSM password |
| `ZETRIX_ADDRESS` | no | Holder Zetrix address (the HSM account). Omit on first run — see "Onboarding" below |
| `HOLDER_DID` | no | Holder DID. Omit and the MCP derives it automatically — see "Onboarding" below |
| `WALLET_BE_URL` | no | Wallet BE base URL override (HSM `/wallet/hsm/sign-blob`) — auto-derived from `ZETRIX_NETWORK` when not set |
| `MBI_BASE_URL` | no | MBI RS base URL override (`/v1/vc/pay/apply`) — auto-derived from `ZETRIX_NETWORK` when not set |
| `OID4VP_BASE_URL` | no | OID4VP verifier base URL override — auto-derived from `ZETRIX_NETWORK` by the x401 SDK when not set |
| `ZETRIX_NODE_HOST` / `ZETRIX_NODE_PORT` | no | RPC node override (auto-derived from network) |
| `ZID_RESOLVER_BASE_URL` | no | ZID resolver override (auto-derived from network: sandbox for testnet, prod for mainnet) |
| `MAX_PAYMENT_AMOUNT` | no** | Per-asset x402 auto-pay cap — JSON `{ "<asset>": "<maxRawUnits>", "*": "<fallback>" }`. `pay_and_fetch`/`subscribe_and_issue` are asset-agnostic: the resource server's 402 challenge may quote the native ZETRIX token (asset code `ZTX`) **or** a ZTP20 token (e.g. `JMYR`) — cap whichever assets you expect, e.g. `{"ZTX":"1000000000","JMYR":"5000000","*":"0"}`. Unset = no cap enforced. |

\* sensitive — never logged.

### Onboarding: two ways to set up your holder identity

`ZETRIX_ADDRESS` and `HOLDER_DID` are both optional — the MCP resolves your holder identity at
startup, in one of two ways:

1. **First-time user — only `HSM_PASSWORD` set.** The MCP creates a brand-new HSM account on
   Wallet BE (`POST /wallet/hsm/account/create`) and derives the DID from the returned public
   key. It logs the new `ZETRIX_ADDRESS` (and `HOLDER_DID`) to stderr on startup, and saves the
   address, DID, and password to a local account store
   (`~/.agentic-wallet-mcp/account.json`, owner-only) — it's reused automatically next run, no
   config edit required. An explicit `ZETRIX_ADDRESS`/`HSM_PASSWORD` set later in your MCP
   config still overrides the saved account.
2. **Existing user — `ZETRIX_ADDRESS` + `HSM_PASSWORD` set, `HOLDER_DID` optional.** The MCP
   always self-signs the address via the existing `POST /wallet/hsm/sign-message` call and
   derives the DID from the `publicKey` the response carries — no separate lookup endpoint
   needed. A supplied `HOLDER_DID` is never trusted blindly: it's compared against this derived
   value, and if they don't match, the derived (correct) one wins — the mismatch is logged to
   stderr so you know to fix your config. Omit `HOLDER_DID` entirely and the derived value is
   just used directly.

Either way, `wallet_status` always reports the resolved `zetrixAddress`/`holderDid` for the
running session, so you can confirm what the MCP resolved to at any time.

\*\* **strongly recommended before pointing this wallet at mainnet/real funds.** `pay_and_fetch`
and `subscribe_and_issue` auto-pay whatever `maxAmountRequired` a remote server's 402 challenge
demands, with no built-in ceiling — a prompt-injected or misled agent calling either tool against
a hostile endpoint would pay whatever that endpoint asks for, bounded only by the HSM account
balance. `MAX_PAYMENT_AMOUNT` is a hard, code-enforced cap that holds regardless of what the
calling agent decides. Once set, it becomes an allowlist: an asset with no entry and no `"*"`
fallback is **denied**, not passed through uncapped.

You don't need to look up or fill in `WALLET_BE_URL`/`MBI_BASE_URL`/`OID4VP_BASE_URL`/
`ZID_RESOLVER_BASE_URL` yourself — just pick `zetrix:testnet` or `zetrix:mainnet` for
`ZETRIX_NETWORK` and the MCP (and the x401 SDK it wires up) uses the built-in default for that
network:

| Network | `WALLET_BE_URL` default | `MBI_BASE_URL` default | `OID4VP_BASE_URL` default | `ZID_RESOLVER_BASE_URL` default |
|---|---|---|---|---|
| `zetrix:testnet` | `https://wallet-api-sandbox.zetrix.com/server` | `https://mbi-vc-sandbox.zetrix.com` | `https://zid-oid4vp-sandbox.zetrix.com/api` | `https://zid-resolver-sandbox.zetrix.com` |
| `zetrix:mainnet` | `https://wallet-api.zetrix.com/server` | `https://mbi-vc.zetrix.com` | `https://zid-oid4vp.zetrix.com/api` | `https://zid-resolver.zetrix.com` |

Only set any of the four explicitly if you run your own instance of that service instead of the
default one — an explicit value always wins over the network default. The `*-sandbox.zetrix.com`
(testnet) hosts are public endpoints — no VPN needed; if you're on a corporate VPN and one of
them times out, disconnecting it is more likely to fix that than connecting it. See "Network
reachability & troubleshooting" below.

That's the complete list — no VC-MCP subprocess, no BaaS gateway key, no manually-configured
BBS+ key to set up.

## Configuring in Claude Desktop / Claude Code

> **Deployment model: single-holder, config-based.** One MCP instance serves one holder;
> all setup (infra URLs, holder identity, `HSM_PASSWORD`, VC-backend key) is set once in the
> `env` block below. Per-transaction data (the VC to present, attributes to request) is passed
> by the agent at call time. (Multi-user — passing secrets/identity per tool-call — is a future
> option, not built.)

A ready-to-edit template lives at [`mcp.json`](mcp.json) — copy it into your client config and fill
the `<...>` placeholders (don't commit a filled copy; `mcp.local.json` is gitignored). Add to
`claude_desktop_config.json` (Desktop) or `~/.claude/settings.json` (Code):

```json
{
  "mcpServers": {
    "agentic-wallet": {
      "command": "npx",
      "args": ["-y", "agentic-wallet-mcp"],
      "env": {
        "ZETRIX_NETWORK": "zetrix:testnet",
        "HSM_PASSWORD": "your-hsm-password",
        "ZETRIX_ADDRESS": "ZTX3...",
        "HOLDER_DID": "did:zid:..."
      }
    }
  }
}
```

> First run, no account yet? Omit `ZETRIX_ADDRESS` (and `HOLDER_DID`) entirely — the MCP creates
> one for you at startup, logs it to stderr, and saves it (address, DID, password) to
> `~/.agentic-wallet-mcp/account.json` for automatic reuse next run. See "Onboarding" under
> Environment above.

> Working on this repo locally instead of the published package? Point `command`/`args` at the
> local build directly: `"command": "node"`, `"args": ["/absolute/path/to/zetrix-agentic-wallet/dist/server-bundle.cjs"]`.

> Prefer environment/secret managers over inline secrets for `HSM_PASSWORD` in production.
>
> Only add `WALLET_BE_URL` / `MBI_BASE_URL` / `OID4VP_BASE_URL` / `ZID_RESOLVER_BASE_URL` to the
> `env` block if you run your own instance of that service — otherwise leave them out and the MCP
> (and the x401 SDK) use the default for whichever `ZETRIX_NETWORK` you picked (see the table
> above).

## Example prompts

- *"Check my wallet status."* → `wallet_status`
- *"What's my JMYR balance?"* → `wallet_status({ token: "JMYR" })` (divide `balance` by `10^decimals` to display it)
- *"I got a 401 with this PROOF-REQUEST header — prove my identity and give me the PROOF-RESPONSE to replay."* → `prove_identity`
- *"Fetch `https://api.example/data` and pay automatically if it asks."* → `pay_and_fetch`
- *"What fields does the AI Birthcert template need?"* → `get_template_schema` (free — do this before issuing)
- *"Apply for the agent-identity credential with these attributes and pay for it."* → `subscribe_and_issue`
- *"My wallet_status call is failing — I don't have a holder account yet. Set one up."* → `create_holder_account` (asks you for a password; if an account already exists it reports that instead of creating — confirm with the user, then re-call with `confirmNew: true` to replace it)
- *"What's the total supply of this token contract?"* → `query_contract({ contractAddress, method: "totalSupply" })`

For the full ordered script (onboarding → check → issue → prove → pay), see [`docs/USAGE_FLOW.md`](https://github.com/Zetrix-Chain/zetrix-agentic-wallet/blob/main/docs/USAGE_FLOW.md).

## End-to-end usage flow

Full narrative version with example prompts: [`docs/USAGE_FLOW.md`](https://github.com/Zetrix-Chain/zetrix-agentic-wallet/blob/main/docs/USAGE_FLOW.md).

**Step 0 — onboarding (once).** Only if `ZETRIX_ADDRESS` isn't set yet: the MCP creates an HSM
account automatically at startup from `HSM_PASSWORD` alone (see "Onboarding" under Environment
above) and saves it locally for automatic reuse. Alternatively, call `create_holder_account
{ password }` manually — it always checks for an existing account first and reports it instead
of creating (pass `confirmNew: true`, after asking the user, to replace it anyway). Either way,
the account is saved to `~/.agentic-wallet-mcp/account.json` and picked up automatically on the
next restart; no manual config edit needed unless your MCP config also sets `ZETRIX_ADDRESS`/
`HSM_PASSWORD` via env, in which case those still take precedence and should be updated too.

**Phase 1 — `wallet_status` — pre-check.** Pass any VCs the caller already holds via
`heldCredentials`; the response tells you whether the agent-identity credential you need is
already there. Skip to Phase 3 if so.

**Phase 2 — `subscribe_and_issue` — VC issuance.**
`{ templateId, attributes }` → holder-signs the payload via Wallet BE → MBI's x402 `402` →
self-pay → MBI settles **and** issues the VC in one call. **Hold onto the returned `vc`** — it's
what you pass into every future `prove_identity` call.

**Phase 3 — `prove_identity` — x401 identity proof.**
`{ proofRequest, vc }` (omit `revealAttribute`/`issuerKeys` — both now resolve automatically).
Internally: fetch the OID4VP presentation definition → derive the BBS+ selective-disclosure VP
via MBI (`/vp/ext/create` + `/vp/ext/submit`, `includeVp: true`) → resolve the issuer's
verification keys via the ZID resolver → submit to the verifier with wallet-auth headers →
package the signed result as a `PROOF-RESPONSE`. Replaying that header back to the original
resource server happens outside this MCP, in whatever drove the conversation. See "The
`PROOF-REQUEST` header" section in [`docs/USAGE_FLOW.md`](https://github.com/Zetrix-Chain/zetrix-agentic-wallet/blob/main/docs/USAGE_FLOW.md) for the exact wire
structure and field semantics.

**Phase 4 — `pay_and_fetch` — pay-per-use.**
`{ url, method?, headers?, body? }` → fetch → on `402`, self-pay → retry with `X-PAYMENT`.
Independent of Phases 2/3 — no VC or identity proof involved, just a fresh payment per call.

## Network reachability & troubleshooting

The `*-sandbox.zetrix.com` testnet endpoints are public — no VPN needed to reach them. Reachability
differs per host, and this is the first thing to check when something that worked before suddenly
times out or 403s, before assuming a code regression.

- **`wallet-api-sandbox.zetrix.com` / `mbi-vc-sandbox.zetrix.com`** — direct origin IPs
  (`124.243.148.237` / `111.119.237.222` as of 2026-07-29), **not** CDN-fronted, unlike the ZID
  hosts and the mainnet endpoints. Being off-CDN is why the **corporate VPN blocks them
  specifically** while `test-node.zetrix.com` and the mainnet hosts keep working over the same
  VPN — so a failure here looks like a total outage while everything else looks healthy.
  Disconnect the VPN. Verified reachable over a plain internet path on 2026-07-29.
- **ZID resolver** sits behind a CDN edge with a managed challenge — see its row below.

| Symptom | Cause | Fix / status |
|---|---|---|
| `Wallet BE /wallet/hsm/sign-blob request failed <- fetch failed <- UND_ERR_CONNECT_TIMEOUT` (or same for `mbi-vc-sandbox.zetrix.com`) | Corporate VPN routing away from the public internet — it blocks these two direct-origin hosts specifically (observed 2026-07-29), or a transient network issue | **Disconnect the VPN and retry.** Verify reachability directly: `curl -sS -o /dev/null -w '%{http_code}\n' "https://wallet-api-sandbox.zetrix.com/server/wallet/hsm/account/activate/status?address=<yourAddress>"` — `200` (with an `errorCode: 0` body) is healthy; `000` means the TCP connect never completed, so it's a network path problem, not a code problem |
| `VP derivation failed <- ZID resolver HTTP 403 ... cf-mitigated: challenge` | ZID resolver (`zid-resolver-sandbox.zetrix.com`) sitting behind a Cloudflare **managed challenge** that blocks plain server-to-server `fetch` | Server-to-server access to the resolver must be allowlisted so it returns `200` directly. If the challenge is active, `prove_identity`'s `issuerKeys` input is the fallback — fetch the DID document via a real browser (it clears the JS challenge) and pass its `verificationMethod` entries' `publicKeyMultibase` (BBS+) / `publicKeyHex` (Ed25519) directly. |
| `OID4VP backend returned a malformed presentation definition` | Historical SDK bug: the live sandbox's `GET /v1/presentation/{id}` response has no `expires_at` field, but the SDK guard required one | **Fixed** in `x401-zetrix-client` — `expiresAt` is now optional on `PresentationDefinition`. If you see this, you're on a stale cached `npx` install — clear it (`npx clear-npx-cache` or bump the version) to pick up the current published `agentic-wallet-mcp`. |
| `SUBMIT_FAILED: OID4VP backend returned 401 ... Missing X-Wallet-Public-Key header` | Historical SDK gap: `POST /v1/presentation/submit` requires wallet-auth headers (`X-Wallet-Public-Key` / `X-Wallet-Signed-Data`, holder signs their own address) that the SDK didn't send | **Fixed** — `X401Wallet` now accepts an injected `submitAuth` provider and the wallet wires it automatically; nothing to configure. |
| `MBI /vp/ext/submit did not return vp` | MBI's `includeVp` opt-in not deployed on the target instance | Deployed on the sandbox (`mbi-vc-sandbox.zetrix.com`). If you see this against a different MBI instance, that instance needs the same rollout. |

## Security notes

- **No plaintext private key ever exists in this process.** All Ed25519 signing routes through
  Wallet BE's HSM (`/wallet/hsm/*`); `walletCfg.privateKey` is always `''`.
- **`MAX_PAYMENT_AMOUNT` is the real control against unbounded auto-spend** — see Environment
  above. Without it, `pay_and_fetch`/`subscribe_and_issue` will pay whatever a server's `402`
  challenge demands, up to the HSM account's balance. An agent-side "confirm before paying" step
  is not a real security boundary: the same prompt injection or bad instruction that drove the
  call in the first place could just as easily drive the confirmation.

