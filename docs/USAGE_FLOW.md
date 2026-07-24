# End-to-end usage flow

A concrete prompt-by-prompt script for driving `agentic-wallet-mcp` through the same 4-phase
flow shown in the "x402 Payment — VC Issuance via MBI & Pay-Per-Use" sequence diagrams
(**P1** VC issuance, **P2** pay-per-use, **E2E** combined). Each phase there maps directly onto
one of this MCP's 5 tools — nothing new to build, this is just the script for using what exists.

| Diagram phase | This MCP's tool |
|---|---|
| Phase 1 — access + VC pre-check | `wallet_status` |
| Phase 2 — x402 VC issuance via MBI (skipped if a valid one is already cached) | `subscribe_and_issue` |
| Phase 3 — x401 identity proof (OID4VP) | `prove_identity` |
| Phase 4 — x402 pay-per-use | `pay_and_fetch` |
| *(one-time, before any of the above)* | `create_holder_account` |

One thing is simplified vs. the diagram, intentionally: there's no separate on-chain `txHash`
re-verify step on the wallet's side — MBI settles the x402 payment and issues the VC in one
place, so the wallet just relays.

The wallet also keeps a small local cache of issued VCs (keyed by `templateId`), so repeating
Phase 2 for the same credential doesn't pay and re-issue every time — see Phase 2 below. The
client can still pass a VC explicitly on every call (`heldCredentials` on `wallet_status`, `vc`
on `prove_identity`) to override the cache, e.g. to present a credential from somewhere else.

---

## Step 0 — onboarding (once, only if `ZETRIX_ADDRESS` isn't provisioned yet)

`ZETRIX_ADDRESS`/`HOLDER_DID` are both optional — set only `HSM_PASSWORD` and the MCP creates a
new HSM account automatically at startup, logging the new address to stderr and saving it
(address, DID, and password) to a local account store (`~/.agentic-wallet-mcp/account.json`,
owner-only) for automatic reuse on the next restart. Alternatively:

> **You:** "My wallet_status call is failing — I don't have a holder account yet. Set one up.
> The password should be `<your-choice>`."

→ `create_holder_account` `{ password }`. This always checks first whether an account is already
active for this session — if so, it returns `{ alreadyExists: true, existing }` and creates
nothing; ask the user whether to keep that one or replace it, then call again with
`{ password, confirmNew: true }` only if they want a new one. A newly minted account is saved
locally the same way as above and reused automatically next restart — no manual config edit
needed unless an explicit `ZETRIX_ADDRESS`/`HSM_PASSWORD` is also set via env, which still takes
precedence and should be updated too. `HOLDER_DID` is optional and re-derives automatically.
Skip this step entirely if the account already exists and you want to keep using it.

---

## Phase 1 — access + VC pre-check

The agent hits a protected resource externally (outside this MCP) and gets back a `401` with an
x401 `PROOF-REQUEST` header. Before doing anything else, it checks what it's already holding:

> **You:** "Check my wallet status — do I already have an agent-identity credential?"

→ `wallet_status { heldCredentials?: [...] }` — pass whatever VCs the calling application already
holds, or omit `heldCredentials` entirely to report whatever the wallet has cached locally from
prior `subscribe_and_issue` calls. Returns `{ holderDid, holderAddress, network, credentials }`.

**If `credentials` already contains the VC the resource requires → skip to Phase 3.**
**If not → Phase 2.**

---

## Phase 2 — VC issuance via MBI (skipped if a valid VC is already cached)

Matches diagram **P1** exactly: build the signed payload → MBI returns the x402 `402` → self-pay
→ MBI settles **and** issues the VC in the same call (it holds the issuer key — no separate
Wallet BE on-chain re-verify, no ms-credential hop).

> **You:** "I don't have the agent-identity credential yet. Apply for it with these attributes
> and pay for it: agentName=Jak Sparrow, controllerName=Haha A222, purpose=To gain access with
> x401 + x402 APIs."

→ `subscribe_and_issue { templateId: "did:zid:c042e49e55ffe1b0ee835e6a8b3d1aec720fb1cb01dca17c4b3e5c2194949a6c", attributes: {...} }`
(the real MBI credential-definition id. It is *not* a human-readable slug like
"agent-identity-credential", and it is not the x401 challenge's `requirementsId` label
either — take it from `credential_requirements.query.credentials[].id`.)
Internally: `data = [{templateId, metadata}]` → holder-sign via Wallet BE → MBI `applyChallenge`
(`402` + `paymentId`) → self-pay (Wallet BE signer, x402 `PaymentEngine`) → MBI `applySettle`
(+ `X-PAYMENT` + `paymentId`) → `{ issued: true, vcId, vc, txHash }`.

The asset in `applyChallenge`'s `402` is not fixed to the native ZETRIX token — MBI may quote a
ZTP20 token instead (e.g. `JMYR`). Pass `dryRun: true` to stop right after this free quote and see
`{ quote: { asset, maxAmountRequired, payTo } }` before any funds move.

**A still-valid VC for this `templateId` is cached locally** — call `subscribe_and_issue` again
later (even after restarting the MCP) and it returns the cached VC directly with `fromCache: true`
and **no payment made**, instead of paying and issuing again. Pass `forceReissue: true` to bypass
the cache and pay for a fresh one regardless. You can still hold onto `vc` from the response
yourself and pass it explicitly on future `prove_identity` calls if you prefer not to rely on
the cache (e.g. presenting a credential obtained elsewhere).

---

## Phase 3 — x401 identity proof (OID4VP)

Matches diagram **P3**: derive the BBS+ selective-disclosure VP, sign the holder-binding over the
verifier's nonce, submit to the OID4VP verifier, relay the result back as a `PROOF-RESPONSE`.

> **You:** "Here's the PROOF-REQUEST header from the 401 I got: `eyJ2ZXJpZmljYXRpb25f...`.
> Prove my identity using the agent-identity credential I just got, and give me the
> PROOF-RESPONSE to replay."

→ `prove_identity { proofRequest, vc?, revealAttribute? }` — omit `vc` to use the cached credential
from Phase 2 automatically (only auto-selects when exactly one valid VC is cached; with zero or
several, it errors and asks you to pass `vc` explicitly), or pass it yourself if you held onto it.
Internally: `MbiVpAdapter` signs the holder's address (auth) → MBI `/vp/ext/create` →
Wallet-BE-sign the blob → MBI `/vp/ext/submit` (`includeVp: true`) → resolve the **issuer's**
BBS+/Ed25519 keys via the ZID resolver (`resolveIssuerProofKeys`) → submit the finished VP + those
keys to the OID4VP verifier → relay `PROOF-RESPONSE` back. Returns `{ proofResponseHeader, verified, presentationId }`.

> **You:** "Replay that PROOF-RESPONSE header back to the resource server."

(This last hop — retrying the original request with the `PROOF-RESPONSE` header — happens outside
this MCP, in whatever client/agent framework is driving the conversation; this wallet only
produces the header value.)

### The `PROOF-REQUEST` header — format & how to get one

`prove_identity`'s `proofRequest` input is the **`PROOF-REQUEST` header value** a resource server
returns on its `401`. It is `base64url(UTF-8 JSON)` of this body (built by the x401 server SDK —
`x401-zetrix-js/packages/server/src/challenge.ts`):

```json
{
  "verification_data": {
    "requestUri": "https://zid-oid4vp-sandbox.zetrix.com/api/v1/presentation/pres_<REAL_ID>",
    "nonce": "<verifier-nonce>",
    "expiresAt": "2026-07-16 12:00:00"
  },
  "credential_requirements": {
    "credentials": [
      {
        "id": "did:zid:<query-or-issuer-id>",
        "credentialTypes": ["VerifiableCredential", "Agent Identity Credential"],
        "format": "ldp_vc",
        "claims": [
          { "path": ["agentName"] },
          { "path": ["controllerName"] },
          { "path": ["purpose"] }
        ]
      }
    ]
  },
  "request_id": "pres_<REAL_ID>",
  "nonce": "<verifier-nonce>",
  "request_uri": "https://zid-oid4vp-sandbox.zetrix.com/api/v1/presentation/pres_<REAL_ID>"
}
```

Field semantics (confirmed against `challenge.ts` + the live sandbox — see
`x401-zetrix-js/docs/Example-create-request.txt`):

- **`request_id`** is the OID4VP **`presentationId`** (the session-binding id, format
  `pres_<epochMillis>_<hex8>`) — it is *not* sliced from the URI; the RS reads it from the
  `POST /v1/verification/request` response. In practice it equals the last path segment of
  `requestUri`, but the wire value is the backend-supplied `presentationId`.
- **`credential_requirements`** is the verifier's DCQL query, **echoed verbatim** — the same
  `{ credentials: [ { id, credentialTypes, format, claims: [ { path: [...] } ] } ] }` structure
  the RS sent as `requirements`. It is *not* a fixed `{ credential_type, claims }` object. This is
  what `prove_identity` maps to MBI `revealAttributes` (`dcqlToRevealAttributes`, G4).
- **`nonce`** and the `requestUri`/`request_uri` are duplicated (top-level *and* inside
  `verification_data`) intentionally — some clients read the header body, others the nested block.
- **`expiresAt`** is `"YYYY-MM-DD HH:mm:ss"` (space-separated, **not** ISO-8601 with `T`/`Z`), taken
  verbatim from the backend. The SDK treats it as an opaque string (echoed, never date-parsed), so
  the format is harmless — do not assume it is ISO-8601.

**Structural example** (placeholders — good for a *parse/smoke* test only; it will fail at the
verifier because the session isn't real; decodes to the body above):

```
eyJ2ZXJpZmljYXRpb25fZGF0YSI6eyJyZXF1ZXN0VXJpIjoiaHR0cHM6Ly96aWQtb2lkNHZwLXNhbmRib3guemV0cml4LmNvbS9hcGkvdjEvcHJlc2VudGF0aW9uL3ByZXNfUkVQTEFDRV9XSVRIX1JFQUxfSUQiLCJub25jZSI6InZlcmlmaWVyLW5vbmNlLVJFUExBQ0UiLCJleHBpcmVzQXQiOiIyMDI2LTA3LTE2IDEyOjAwOjAwIn0sImNyZWRlbnRpYWxfcmVxdWlyZW1lbnRzIjp7ImNyZWRlbnRpYWxzIjpbeyJpZCI6ImRpZDp6aWQ6UkVQTEFDRV9XSVRIX1FVRVJZX09SX0lTU1VFUl9JRCIsImNyZWRlbnRpYWxUeXBlcyI6WyJWZXJpZmlhYmxlQ3JlZGVudGlhbCIsIkFnZW50IElkZW50aXR5IENyZWRlbnRpYWwiXSwiZm9ybWF0IjoibGRwX3ZjIiwiY2xhaW1zIjpbeyJwYXRoIjpbImFnZW50TmFtZSJdfSx7InBhdGgiOlsiY29udHJvbGxlck5hbWUiXX0seyJwYXRoIjpbInB1cnBvc2UiXX1dfV19LCJyZXF1ZXN0X2lkIjoicHJlc19SRVBMQUNFX1dJVEhfUkVBTF9JRCIsIm5vbmNlIjoidmVyaWZpZXItbm9uY2UtUkVQTEFDRSIsInJlcXVlc3RfdXJpIjoiaHR0cHM6Ly96aWQtb2lkNHZwLXNhbmRib3guemV0cml4LmNvbS9hcGkvdjEvcHJlc2VudGF0aW9uL3ByZXNfUkVQTEFDRV9XSVRIX1JFQUxfSUQifQ
```

> **A real, working header must carry a live `request_id`/`nonce`/`requestUri`** — an actual OID4VP
> verification session on the verifier. The wallet fetches the request from `requestUri` and submits
> the derived VP to it; a fabricated session id fails. Get a genuine one from the x401 sample
> resource-server (`x401-zetrix-js/examples/resource-server`): start it, `curl` its protected route,
> and copy the `PROOF-REQUEST` header from the `401`.

> **Live dependency:** the submit step needs MBI's `includeVp` opt-in on
> `POST /v1/vp/ext/submit` deployed on the target MBI instance — without it, `prove_identity`
> fails at `/vp/ext/submit` (no `vp` in the response). It is deployed on the sandbox
> (`mbi-vc.myegdev.com`); a different MBI instance needs the same rollout.

---

## Phase 4 — x402 pay-per-use

Matches diagram **P2**: every paid call from here on is its own fresh x402 payment — no issuance,
no VC involved at all.

> **You:** "Now fetch `https://api.example/agents/status` — pay automatically if it asks for
> payment."

→ `pay_and_fetch { url, method?, headers?, body? }`. Internally: `fetch` → if `402`, self-pay
(Wallet BE signer) → retry with `X-PAYMENT` header. Returns `{ status, body, paymentMade, amountPaid, asset }`.

Repeat Phase 4 for every subsequent paid call — Phases 2/3 only run again if the VC expires or a
different resource requires a different credential.

---

## Full script, back to back

```
1. "My wallet_status call is failing — I don't have a holder account yet. Set one up.
    Password: <your-choice>."                                    → create_holder_account
   [if alreadyExists:true comes back, ask the user existing-vs-new; re-call with
    confirmNew:true only if they want a new one — otherwise nothing to do, saved locally]

2. "Check my wallet status — do I already have an agent-identity credential?"
                                                                   → wallet_status
   [if no credential:]

3. "Apply for the agent-identity credential with these attributes and pay for it: ..."
                                                                   → subscribe_and_issue
   [hold onto the returned `vc`]

4. "Here's the PROOF-REQUEST header I got: ... Prove my identity and give me the
    PROOF-RESPONSE to replay."                                    → prove_identity

5. "Now fetch <protected-url> and pay automatically if it asks."  → pay_and_fetch
   [repeat step 5 for every further paid call]
```
