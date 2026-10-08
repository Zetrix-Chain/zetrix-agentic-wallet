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
| `wallet_status` | Report holder DID/address/network + held VCs (client-supplied, or the local cache); optionally one token balance (`token`) or several in one call (`tokens`). Each balance carries `balance` (raw base units), `decimals` and `display` — the same amount in whole tokens with its symbol. Quote `display`; a raw count beside a ticker is wrong by orders of magnitude. A token may be named by ticker **or** contract address, and a ZTP20 result also carries its contract address as `tokenAddress` — the value a policy needs, so it never has to be asked for | `{ heldCredentials?, token?, tokens? }` | `{ holderDid, zetrixAddress, network, credentials, balances?, tokenBalance?, tokenBalances? }` |
| `credential_preflight` | **Free.** The first call for any credential — composes the quote, the balances and the spending cap into one answer, before a single application field is collected. Spends nothing, starts nothing. `blockers` lists *every* reason the wallet is not ready, at once; `notChecked` lists what preflight cannot know — agent-name availability is decided by myid at issuance, after payment, so a `ready` result is never a reservation. **It also says when the wallet already holds a valid copy of the credential** (`alreadyHeld`, with `ready: false`): it looks at the credentials the wallet has saved, locally and for free, before pricing anything, so the agent stops with "you already have one" instead of asking for an agent name. Buying another would replace it (one credential per template) and costs the fee; only when the user explicitly wants a replacement is it run again with `replacing: true`. An expired credential does not count, and a lookup that fails is reported in `notChecked`, never as "nothing is held" | `{ credential, agentName?, replacing? }` | `{ credential, ready, fee?, balances, cap?, schema?, alreadyHeld?, blockers, notChecked }` |
| `prove_identity` | Answer an x401 `PROOF-REQUEST` → return the `PROOF-RESPONSE` header to replay | `{ proofRequest, vc?, revealAttribute?, issuerKeys? }` | `{ proofResponseHeader, verified, presentationId }` |
| `create_verification_qr` | Create a link and a QR code that open this wallet's credential in the MyID app, for a human to verify the agent. Presents the credential to MBI — with no `vc` given, the Verified AI Birthcert if the wallet holds one, otherwise the Basic AI Birthcert, and if it holds neither it answers `created: false` and says to create one first. The link holds only the reference id, but that id grants access to whatever is revealed until it expires (5 minutes by default, up to 60), so by default it reveals only a standard minimal set (Verified: `agentName`, `evidenceProvider`, `ownerVerified`; Basic: `agentUsername`) — name other attributes with `revealAttribute`, and pass `revealAll: true` only when the user explicitly asks to reveal everything; show the link only to the human user. A Basic credential does not mean the owner was verified, and the result says so. Needs `MYID_VERIFY_LINK_TEMPLATE`; without it the tool answers `created: false` before anything is created | `{ vc?, revealAttribute?, revealAll?, expiryMinutes? }` | `{ created, link, referenceId, expiresAt, expiresInMinutes, revealed (the attribute paths, or `"all"`), credentialUsed, revealedByDefault, qrCodePngBase64 (sent as an image; absent with a `qrError` if it could not be drawn), message }` or `{ created: false, reason }` |
| `pay_and_fetch` | Fetch a URL, auto-pay with x402 (self-pay via Wallet BE) on `402` | `{ url, method?, headers?, body? }` | `{ status, body, paymentMade, amountPaid, amountPaidHuman, asset }` |
| `subscribe_and_issue` | Reuse a cached VC if still valid, else pay x402 → MBI issues → return the VC. Replacing a still-valid cached VC needs `forceReissue: true` **and** `confirmReplaceExistingVc` set to the exact `vcId` you were shown first — `forceReissue` alone only shows you the existing VC (`issued: false`), it never pays | `{ templateId, attributes, expirationDate?, dryRun?, forceReissue?, confirmReplaceExistingVc? }` | `{ issued, vcId, vc, txHash, fromCache?, schema?, originalPayment?, paymentAttempted?, recovery?, vcPassImagePaths? }` — `issued: false` with `fromCache: true` means an existing valid VC is being shown, not an error |
| `create_holder_account` | Onboarding: mint an HSM account (the MCP already auto-creates one at startup if `ZETRIX_ADDRESS` is omitted — see Environment below). Always checks for an existing account first — if one is active for this session, returns `{ alreadyExists: true, existing }` without creating anything; pass `confirmNew: true` (after asking the user) to mint a new one anyway | `{ password, label?, purpose?, confirmNew? }` | `{ created, alreadyExists, existing?, zetrixAddress?, holderDid?, publicKeyHex?, message }` |
| `get_template_schema` | **Free** read of a VC template's declared attribute schema. Call before `subscribe_and_issue` to learn which attributes it requires | `{ templateId }` | `{ templateId, schema: { required, optional } }` or `{ templateId, error }` |
| `query_contract` | Read-only query against any Zetrix contract — call an arbitrary method and return its raw result. No signing, no state change | `{ contractAddress, method, params? }` | `{ ok: true, result }` or `{ ok: false, error }` |
| `get_policy_template_schema` | **Free** read of POLICY templates — and the place to START when writing a policy. With **no arguments** it lists the templates on offer (on testnet `native-v1` and `ztp20-v1`), each with its declared attributes and the `templateId` that `write_policy` needs, so nobody has to supply a publisher or a template contract address. `{ policyKey }` reads one template of the default publisher, `{ publisher }` lists a different publisher’s, and `{ publisher, policyKey }` and `{ templateId }` still work. An id is only ever returned once the chain has confirmed it: it is derived from the publisher and key, and an id that does not resolve is withheld rather than handed over. The listing is bounded (20 templates, 40 attributes each) and says what it left out. This is the only vocabulary that means anything on chain — the policy contract validates nothing, so an attribute outside it deploys cleanly and then enforces nothing at all. A template that cannot be read reports `{ error }` rather than `{ found: false }`, so "no such template" is never confused with "could not look it up". Beside `declared` it returns `attributeMeanings` — the description each declared attribute has in the service (`GET /policy/vocabulary`), including what an empty list means and what an attribute applies to or needs, labelled by `attributeMeaningsSource` as text from ms-zetrix that describes and does not instruct — and `attributesUnknownToService` for a declared name the service does not recognise (which refuses every transfer). If the vocabulary cannot be read the result carries `attributeMeaningsNote` saying so and `declared` is unchanged | `{ templateId?, publisher?, policyKey? }` | `{ found, publisher?, publisherSource?, templates?, templateId?, templateIdConfirmed?, declared?, attributeMeanings?, attributeMeaningsSource?, attributeMeaningsNote?, attributesUnknownToService?, error? }` |
| `get_my_policy` | **Free** read of the spending policies this owner has deployed on chain; defaults to this wallet's own address. Costs 2 + N chain calls and warns above 50 keys. An owner who has never deployed one is a normal absence, **not** an error — the policy contract is created lazily on first write — and a failed lookup keeps its own error state, so "we could not list your policies" is never presented as "you have none". Each policy that was read carries `forUpdate.expectedUpdatedAtBlock`, the value `update_policy` needs, already as a string | `{ owner? }` | `{ owner, policies?, warning?, error? }` |
| `policy_preflight` | **Free** check of a draft policy *before* it is deployed. An amount may be given as `valueHuman` (whole tokens, `"100"` for 100 JMYR) instead of `value`: the wallet converts it with the token's own decimals, shows both forms, and never sends `valueHuman` on. It is only for the amount attributes (`perTransactionMax`, `cumulativeMax`, `velocityCap`, and any attribute the service lists as an amount in the smallest unit): `maxTransactionCount` is a count and a window is a duration, and neither is ever scaled. Each amount attribute may carry its own `valueHuman`. Never put `convertedAmounts` in `valueHuman`: those are raw base units. A number is accepted only as a safe whole number; write anything else, such as `"0.5"`, as text. An attribute needs a `value` or a `valueHuman`, whatever its type. If `value` and `valueHuman` are both given they must agree, and `amountUnit` does not apply to a `valueHuman`. Two questions: is it well-formed (`blockers` lists every problem at once, so one round of fixes is enough — on a hostile draft with hundreds of faults the list is capped, and it says so on the last line), and — more important — does it MEAN what the user thinks (`interpretation` states in plain words what it actually does). Always show `interpretation`, **including when `ready` is true**: a valid policy can still mean something unintended — a spending cap with no window is a LIFETIME cap, not a monthly one. It also applies the write service’s scope rules, so a draft the service would refuse is refused here for free: `assetScope` must be exactly `native` or `ztp20` (never a token symbol such as JMYR), a `ztp20` policy needs a `tokenAddress`, and any amount or count cap needs an `assetScope`. A token symbol written where `tokenAddress` belongs is refused with the registered address to use, and a `ztp20` draft with no `tokenAddress` names the registered ones. Every `*Window` must be a duration such as `7d`, `12h` or `30m` (or ISO `P7D`) — `week`, a bare number or a value with spaces around it is refused, and `interpretation` states each window's period in words (`1M` is one minute, not one month) — and `interpretation` states what each amount means in whole tokens, because amounts are raw base units. A non-zero amount cap (`perTransactionMax`, `cumulativeMax`, `velocityCap`) under one whole token is refused unless `amountUnit` says what is meant: `"whole"` gives whole-token amounts (`"1"`, `"0.5"`) that the wallet converts by the token's decimals and returns in `convertedAmounts`, and `"base"` confirms a tiny raw value is intended. `convertedAmounts` is for showing the user — never send it back as the values; a `"whole"` draft whose every amount already looks raw is refused with both readings and the exact raw value for each. `notChecked` lists what could not be verified, including whether the policy would be enforced at all | `{ policyKey, attributes, validFromBlock?, validToBlock?, templateId?, publisher?, amountUnit? }` | `{ policyKey, ready, declared?, blockers, interpretation, notChecked, convertedAmounts? }` — `declared` is the template's own attribute names, present only when the template resolved; long results are bounded, and anything omitted is stated in `notChecked` rather than dropped silently |
| `check_policy_decision` | **Free** — but NOT free of consequence. Ask whether a specific spend is permitted RIGHT NOW: the one policy question no chain read can answer, because a cap is measured against cumulative spend held off-chain. Three outcomes — `permitted`, `refused`, `undetermined`. **`undetermined` is neither a refusal nor permission**: it means nothing was evaluated (service unreachable, ledger stale, or none configured), and it is what every failure produces — no transport error, bad envelope or unknown verdict string can ever yield `permitted`. There is **no step-up verdict**; the decision service answers only allow or deny, so the wallet never reports that a human must approve a spend. **A permitted answer reserves the owner’s budget for 15 minutes**, with no way to release it early — so do not poll it, do not probe amounts (every allow along the way reserves again, and the owner’s next real payment can be refused by their own agent), and **never retry automatically after a timeout**: the call may have succeeded and reserved already. To find an amount that fits, read `remaining` from one answer and compute locally. `requestKey` is **correlation only, not idempotency**: repeating it does not deduplicate and each permitted answer reserves again. While the spend-ledger crawl is off, every decision answers `undetermined` / `EVALUATION_UNAVAILABLE`, which is correct behaviour rather than an outage. `ignored` is surfaced on a permitted answer too — it lists constraints the policy carries that the service could not enforce | `{ ownerAddress, asset, amount, policyKey?, recipientAddress?, method?, payTo?, paymentNonce?, requestKey? }` | `{ outcome, summary, reasonCode?, policyKey?, enforced?, ignored?, remaining?, capacityReturnsAt?, reservationId?, notChecked }` |
| `write_policy` | **Pays a real fee, and only with `confirm: true`** (the user must have seen the interpretation and the price; without it the call returns the price and pays nothing). Deploy a spending policy on chain over x402. An amount may be given as `valueHuman` (whole tokens, `"100"` for 100 JMYR) instead of `value`: the wallet converts it with the token's own decimals, shows both forms, and never sends `valueHuman` on. It is only for the amount attributes (`perTransactionMax`, `cumulativeMax`, `velocityCap`, and any attribute the service lists as an amount in the smallest unit): `maxTransactionCount` is a count and a window is a duration, and neither is ever scaled. Each amount attribute may carry its own `valueHuman`. Never put `convertedAmounts` in `valueHuman`: those are raw base units. A number is accepted only as a safe whole number; write anything else, such as `"0.5"`, as text. An attribute needs a `value` or a `valueHuman`, whatever its type. If `value` and `valueHuman` are both given they must agree, and `amountUnit` does not apply to a `valueHuman`. Three steps: a free pre-check, a payment that writes **nothing**, and a collect that finishes the write once the payment settles. Between the payment and the settlement a payment has been made and no policy exists — **that window is normal, not a failure**. `settling` and `submitted` both mean a payment has been made: pass `paymentReceipt` to `check_policy_write`, never call this again. `submitted` carries a `txHash` and still is **not** a written policy — the block has not confirmed it. `written` is the only state where the policy exists. `already_exists` / `refused` come from the free pre-check, so nothing was paid; `payment_refused` says nothing either way about whether the fee was taken. `receipt_void` is the one state where paying again is right (`payFresh`). The fee goes through the same payment cap as every other paying tool, and the wallet never builds a blob, permit digest or canonical JSON — ms-zetrix signs with the owner’s own key. `templateContractAddress` is optional and best left out: the wallet uses the one Template contract it is configured for and refuses any other before any payment, so there is nothing for a user to supply. **`dryRun: true` returns the price without paying** — it runs every free check and stops at the quote (`quoted`): nothing is paid, collected or written to chain, and it never collects an already-paid write, because collecting signs and writes (it only keeps a local bookmark so `check_policy_write` can finish it). The quote also carries `affordability` — whether the wallet holds the quoted amount of the fee asset (plus some ZTX for gas, when the payer needs it) and whether the payment cap would refuse it, each shortfall named separately and a failed balance read reported as `unknown`, never as a yes. It does not estimate the network fee: a payment made in ZTX needs the amount plus that fee from one balance, so `feeNotEstimated` says when "affordable" means only "holds the amount". A quote is what the service asked for just now, not a promise the payment will be allowed: balances move and the cap is enforced again when paying | `{ policyKey, attributes, templateId, templateContractAddress?, validFromBlock?, validToBlock?, requestKey?, pollBudgetMs?, amountUnit?, dryRun? }` | `{ state, message, paymentReceipt?, policyKey?, txHash?, paid?, payFresh?, quote?, affordability? }` |
| `update_policy` | **Pays a real fee, and only with `confirm: true`.** Replace a deployed policy's attributes and validity window over x402. `attributes` is the **full replacement set**, not a patch. An amount may be given as `valueHuman` (whole tokens, `"100"` for 100 JMYR) instead of `value`: the wallet converts it with the token's own decimals, shows both forms, and never sends `valueHuman` on. It is only for the amount attributes (`perTransactionMax`, `cumulativeMax`, `velocityCap`, and any attribute the service lists as an amount in the smallest unit): `maxTransactionCount` is a count and a window is a duration, and neither is ever scaled. Each amount attribute may carry its own `valueHuman`. Never put `convertedAmounts` in `valueHuman`: those are raw base units. A number is accepted only as a safe whole number; write anything else, such as `"0.5"`, as text. An attribute needs a `value` or a `valueHuman`, whatever its type. If `value` and `valueHuman` are both given they must agree, and `amountUnit` does not apply to a `valueHuman`. Read the policy first with `get_my_policy` and pass its `forUpdate.expectedUpdatedAtBlock` (a string): if the policy has changed since, the update is refused for free (`modified`). The policy keeps the template it already references — pass none — and its validity window is kept unless `validFromBlock` / `validToBlock` are given. The same three steps, states and `dryRun` as `write_policy`; `check_policy_write` finishes a paid update from its receipt. Free refusals, each saying nothing was paid: `not_found`, `modified`, `template_unavailable`, `refused`. `written` is the only state that means the policy was updated; `submitted` is **not** (the block has not confirmed it); `write_failed` means the update was **not** applied, the policy is unchanged and a payment may have been taken. The fee goes through the same payment cap as every other paying tool | `{ policyKey, attributes, expectedUpdatedAtBlock, validFromBlock?, validToBlock?, amountUnit?, confirm?, dryRun?, pollBudgetMs? }` | `{ state, message, paymentReceipt?, policyKey?, txHash?, paid?, payFresh?, quote?, affordability?, interpretation? }` |
| `remove_policy` | **Free, but it lifts every limit the policy set** — Wallet BE then signs spends of that asset without any limit — so nothing is sent without `confirm: true`. Without it you get `needs_confirmation` with what the policy currently limits. `removed` is the only state that means the policy is gone, and it is reported only when a chain read no longer holds it; `submitted` is a removal on its way, **not** a removed policy. Repeating the call never submits a second removal. `not_found` means there was nothing to remove (or it is already gone); `in_progress` means a paid update has not been collected yet (`check_policy_write` first) | `{ policyKey, confirm?, pollBudgetMs? }` | `{ state, message, policyKey?, txHash?, currentAttributes? }` |
| `check_policy_write` | **Free — never pays, on any path.** Finish a policy write or update that has already been paid for, from its `paymentReceipt` (or the most recent pending one when omitted). This is the right answer to “did my policy get created?”; calling `write_policy` again is not. A receipt this wallet does not recognise does **not** mean the write failed — the service completes a paid write on its own, and asking to write the same `policyKey` again reports the truth for free before any payment. When a collect ends with an error that says nothing about the write (a gateway timeout, a 5xx), the wallet reads the chain itself (up to 45 seconds, less when the poll has already used part of its budget; each read is cut off at 10 seconds) and reports `written` only when the chain holds exactly the attributes that were submitted, under the same template (for an update, with `updatedAtBlock` moved). That covers every answer the wallet cannot read: a 5xx, a gateway page, the service's own "unknown", and any other status it does not recognise (a 4xx included); the service's own "the chain rejected it" is never second-guessed. `check_policy_write` looks at the chain first for a receipt that still carries what to verify, so a write that already landed costs no collect. A receipt stops being verified against the chain once the service has said its write failed, or once a newer paid write for the same `policyKey` has been made, and a receipt bought by another owner is never checked against this owner's policy. An error answer is returned apart in `upstream: { status, detail }` (control characters replaced, at most 200 characters) | `{ paymentReceipt?, pollBudgetMs? }` | `{ state, message, paymentReceipt?, policyKey?, txHash?, paid?, payFresh?, upstream? }` |
| `request_ai_birthcert_verification` | Start a **Verified** AI Birthcert issuance session with myid (MyDigital ID owner verification) — distinct from `subscribe_and_issue`'s self-declared Basic AI Birthcert. Optional `gasPayer` (`"sponsored"` | `"self"`) overrides the gas payer for this call only — precedence is per-call `gasPayer` > `GAS_PREFERENCE` config > `sponsored` hardcoded default. If a sponsored quote is refused before any money moved, the wallet automatically falls back to paying gas itself; it never falls back once payment is merely pending/indeterminate. `dryRun: true` quotes instead of paying: it stops after the 402 challenge, pays nothing, creates no session, and returns `{ quote }` — the asset, the amount and which side pays gas. Quote and paid request send byte-identical signed bodies. **Checks for an existing Verified AI Birthcert VC before paying**: if this holder already has a still-valid one (found in the local cache, or resolved from a previously-issued session the cache never saw), nothing is paid and no session is started — you get `{ existingVerifiedVc: { vcId, validUntil }, message }` instead; call again with `confirmReplaceExistingVc` set to exactly that `vcId` to replace it anyway. An existing VC that has already expired is replaced automatically, no confirmation needed, and the result carries `replacedExpiredVc: { vcId, validUntil }` naming the one it replaced. It can also refuse with `{ error }` specifically because an already-issued credential exists but could not be confirmed as valid or expired — nothing is paid on that path either; relay `error` as given, which names the concrete next step | `{ agentName, agentPurpose?, evidenceAssuranceLevel?, ownerType?, ownerVerified?, gasPayer?, dryRun?, discardStuckReceiptAndPayFresh?, confirmReplaceExistingVc? }` | `{ sessionId, verificationUrl, expiresAt, expiresIn, expiresInSeconds, message, replacedExpiredVc? }` (`expiresIn` / `expiresInSeconds` are worked out by the wallet from its own clock, so an agent quotes `expiresIn` instead of doing timezone arithmetic itself; `message` carries a "Tell the user:" sentence about following up, worded to match how much time is actually left on the link), `{ quote: { asset, maxAmountRequired, payTo?, gasModel } }`, `{ existingVerifiedVc: { vcId, validUntil? }, message }` (nothing paid, see above), or — instead of a session — `{ settlementPending: true, paymentReceipt, message }` after ~90s, whose meaning depends on which flag (if any) is set below: never assume the payment succeeded from this shape alone. While a merely-stuck receipt (outcome still unresolved) is held this tool can only REPLAY it — it never buys a new credential, which is what stops a second charge. A credential-service refusal is different again: `issuerRejected: true` means the service was reached and refused the request (the settlement is NOT what failed); `paymentInvalid: true` means the service specifically ruled the payment or receipt invalid (this one IS about the payment). Neither tells you whether the fee was taken, in either direction. A **void** receipt (SSIVC status_code 67/68) is different again: the wallet discards it itself, with no confirmation and no flag, so the very next call is an ordinary fresh purchase — see `{ error }` below. `discardStuckReceiptAndPayFresh: "<exact receipt id>"` is the way to start over on a merely-stuck receipt instead: it throws that payment away and pays the fee again, refuses a mismatched id (discarding and paying nothing), refuses a receipt that belongs to a live session, **refuses a receipt that is not stuck yet** (younger than `SETTLEMENT_STUCK_AFTER_MS`, 24h by default — enforced by the wallet, so an agent that mistakes a bare "retry" for consent still cannot cause a second payment; nothing is discarded and nothing is paid), and returns `discardedPaymentReceipt` so the lost payment stays traceable. `{ error }` (`RequestVerificationFailure`) also carries `discardedPaymentReceipt` when this call itself discarded a dead receipt — that confirmed stuck-receipt discard, or an unprompted void one, or **both on one call**; it also rides on `settlementPending` results, not only successes. When both happen (the confirmed discard, then the fresh payment ruled void) the field holds the **void** receipt and the id the user confirmed is named at the end of the `error`/`message` text ("ALSO DISCARDED earlier on this same call") — quote both ids to support, not just the field. Retrying is fine only for an insufficient-funds or payment-cap `{ error }` (nothing was paid); any other `{ error }` (already-settled, receipt not saved, receipt void, outcome unknown) may mean money moved, so get the user's explicit agreement before calling again |
| `check_ai_birthcert_verification` | **Free** (never pays). Poll the most recently requested Verified AI Birthcert session; on `status: "issued"`, also fetches, verifies, and caches the credential. While the session is still open it replays the stored `verificationUrl` alongside SSIVC's live `expiresAt` and the wallet's own `expiresIn` / `expiresInSeconds` (time left, worked out from the wallet clock, never from the agent's) — SSIVC issues the link only once, at creation, so this store is the only place it survives. That makes *"where is my link?"* answerable without touching the paid tool. No link is returned once `status` is `"issued"`: the link is spent. If a prior payment is still clearing this tool **advances** it — it replays the saved receipt (never a new payment) and returns the live session once it settles, so "check back in a few minutes" genuinely progresses the flow | (none) | `{ status: "pending" | "issued" | "no_session" | "settlement_pending" | "receipt_void", verificationUrl?, expiresAt?, vcId?, vc?, cacheError?, paymentReceipt?, outcomeUnknown?, issuerRejected?, paymentInvalid?, message? }` — `settlement_pending` means a payment was made and is being followed: without `outcomeUnknown`, `issuerRejected` or `paymentInvalid` the message leads `PAYMENT SENT` and covers **two** states that the following clause tells apart — *"still being processed"* is a confirmed queued settlement (check again shortly), while *"has not been confirmed yet"* means the outcome could not be determined at all yet, so it must not be reported as progressing or as succeeded; either way the receipt is saved, nothing is paid again, and checking again later is the next step; with `outcomeUnknown: true` the outcome could not be determined at all and has been unresolved longer than `SETTLEMENT_STUCK_AFTER_MS` (24h default), so it is not coming back on its own — `stuckFor` says how long, the fee was most likely already taken, and quoting `paymentReceipt` to support is the way forward. Starting over via `clear_stuck_payment_receipt` costs a second fee. `issuerRejected: true` is a distinct case: the credential service was reached and refused the request (a `4xx` that is not a settlement verdict — measured live as `status_code 99` "Error retrieving ZVG access token"), so the settlement is NOT what failed; `message` quotes what it said, the receipt is kept, no new payment was made, and it can clear once the service recovers. `paymentInvalid: true` is different again: the service has specifically ruled the payment or receipt invalid — this one IS about the payment. Both say nothing about whether the fee was taken, in either direction. `receipt_void` is terminal and different: SSIVC has ruled the receipt finished (status_code 67 expired / 68 failed), so checking again cannot help. The wallet **discards the dead receipt itself** here — no confirmation needed, because a receipt the server will never honour protects nothing and only blocks the next purchase — and returns it as `discardedPaymentReceipt`. It does NOT mean the fee was refunded, and buying the credential means calling `request_ai_birthcert_verification` again, which pays the fee again |
| `clear_stuck_payment_receipt` | **Free, last resort, destructive.** Discard a stuck Verified AI Birthcert payment receipt the wallet is holding and refusing to pay past — the supported replacement for deleting `<stateDir>/ssivc-session.json` by hand, which a hosted subscriber cannot do. Two steps by construction: with no argument it clears nothing and returns the receipt id plus a warning; clearing requires echoing that exact id back as `confirmReceiptId`, and a mismatch clears nothing. A receipt younger than `SETTLEMENT_STUCK_AFTER_MS` (24h by default) is refused on both steps. If the settlement completed in between — which is what happens when you follow the advice to call `check_ai_birthcert_verification` first — the receipt now belongs to a **live, paid-for session**, and the id alone no longer clears it: the tool hands back `sessionId` and `verificationUrl` instead, and only `confirmDiscardLiveSession: true` will discard them. The discarded payment is unrecoverable | `{ confirmReceiptId?, confirmDiscardLiveSession? }` | `{ cleared, paymentReceipt?, requiresConfirmation?, sessionId?, verificationUrl?, message?, error? }` |
| `transfer_token` | **Moves real funds, irreversible.** Send native ZTX or any ZTP20 token to an address. `token` takes `"ZTX"`, a registered symbol (no contract address needed) or a raw ZTP20 address; an unregistered symbol returns `needsTokenAddress: true` and signs nothing. Give `amountHuman` or `amount` — if both, they must agree, which is the cheapest way to catch a 1-vs-1000000 error. Nothing is signed without `confirm: true`, and the wallet never infers it. `outcomeUnknown: true` means the transaction may already be on chain — **do not retry**, check the reported nonce. `policyDenied: true` means the spending policy refused it (Wallet BE errorCode 1000033): a decision, not a failure, so retrying will not help. `policyCheckUnavailable: true` means Wallet BE could not complete the policy check (errorCode 1000034): nothing was signed or sent, it is transient, and trying again shortly is right | `{ token, to, amountHuman?, amount?, confirm?, dryRun? }` | `{ sent, txHash?, nonce, token, asset, amount, amountHuman, decimals, fee, needsConfirmation?, needsTokenAddress?, outcomeUnknown?, policyDenied?, policyCheckUnavailable? }` |

> **A spending-policy refusal on a paying tool is a result, not an error.** Wallet BE checks the owner's spending policy
> before it signs any transaction that spends the wallet's assets (a message, a nonce or a presentation is not checked), so
> `pay_and_fetch`, `subscribe_and_issue`, `request_ai_birthcert_verification`, `write_policy` and `update_policy` can each be refused at the
> signature. The result then carries `policyDenied: true` (the policy said no: a decision, retrying will not help) or
> `policyCheckUnavailable: true` (the check could not complete and Wallet BE failed closed: transient, trying again shortly is
> right), never both. The signature is the last step before the X-PAYMENT header exists, so in both cases **nothing was
> paid**, and the message says what the call had already done (a quote, the free pre-check, the issuer's payment request),
> none of which moves money. `pay_and_fetch` returns it as `{ status: 402, paymentMade: false, policyDenied | policyCheckUnavailable,
> reason }`; `subscribe_and_issue` as `{ issued: false, … }`; `request_ai_birthcert_verification` as `{ error, … }`;
> `write_policy` and `update_policy` as state `refused` (a decision) or `unavailable` (transient), with `paid: false`. A refusal is never retried on
> the other gas option. Every other failure is unchanged. `transfer_token` reports the same two outcomes.

> **VCs are cached locally**, keyed by `templateId`, under `~/.agentic-wallet-mcp/vc-cache/`
> (scoped per network + holder — different identities or networks never share a cache).
> `subscribe_and_issue` checks the cache before paying: a still-valid cached VC is returned
> immediately with `fromCache: true` and **no payment made**. `forceReissue: true` on its own does
> NOT pay — it returns that same existing VC as `{ issued: false, fromCache: true, reason }` instead,
> so it can be shown to the user first; only with `confirmReplaceExistingVc` also set to the exact
> `vcId` shown does it actually pay and reissue. `wallet_status`/`prove_identity` fall back to the cache
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
| `ZETRIX_NETWORK` | no | `zetrix:testnet` or `zetrix:mainnet` — also selects the default `WALLET_BE_URL`/`MBI_BASE_URL`/`OID4VP_BASE_URL`/`ZID_RESOLVER_BASE_URL` below. **Defaults to `zetrix:testnet`**; mainnet is always a deliberate choice |
| `HSM_PASSWORD` | no* | HSM password. Omit it and the wallet generates one on first run and stores it in its own state directory — see "Onboarding" below |
| `ZETRIX_ADDRESS` | no | Holder Zetrix address (the HSM account). Omit on first run — see "Onboarding" below |
| `HOLDER_DID` | no | Holder DID. Omit and the MCP derives it automatically — see "Onboarding" below |
| `WALLET_BE_URL` | no | Wallet BE base URL override (HSM `/wallet/hsm/sign-blob`) — auto-derived from `ZETRIX_NETWORK` when not set |
| `MBI_BASE_URL` | no | MBI RS base URL override (`/v1/vc/pay/apply`; `/v1/*/ext/*` calls are signed over the API path `/v1/...` only; a path prefix here is sent but not signed, so a gateway must strip it before MBI verifies the request) — auto-derived from `ZETRIX_NETWORK` when not set |
| `OID4VP_BASE_URL` | no | OID4VP verifier base URL override — auto-derived from `ZETRIX_NETWORK` by the x401 SDK when not set |
| `ZETRIX_NODE_HOST` / `ZETRIX_NODE_PORT` | no | RPC node override (auto-derived from network) |
| `ZID_RESOLVER_BASE_URL` | no | ZID resolver override (auto-derived from network: sandbox for testnet, prod for mainnet) |
| `MAX_PAYMENT_AMOUNT` | no** | Per-asset x402 auto-pay cap — JSON `{ "<asset>": "<maxRawUnits>", "*": "<fallback>" }`. `pay_and_fetch`/`subscribe_and_issue` are asset-agnostic: the resource server's 402 challenge may quote the native ZETRIX token (asset code `ZTX`) **or** a ZTP20 token (e.g. `JMYR`) — cap whichever assets you expect. **Either the ticker or the contract address works** — the challenge identifies a ZTP20 token by its contract address, and the wallet resolves a known ticker (e.g. `JMYR`) to it. If both are written for the same asset, the contract address wins. An unrecognised ticker still matches nothing and falls through to `"*"`. e.g. `{"ZTX":"1000000000","ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b":"5000000","*":"0"}`. **Default when unset:** both networks allow exactly the AI Birthcert fee (1 JMYR), keyed to that network's JMYR contract, and refuse everything else. **The cap is per call, not cumulative** — so an unconfigured wallet, mainnet included, can pay that fee once per call with no overall ceiling. Set this explicitly to lock a wallet down. **A spending policy stands the DEFAULT cap aside for an asset it governs** (an `assetScope` for that asset, a `perTransactionMax`, and no block range), so the owner's own limit applies instead of a 1 JMYR default underneath it; an explicit `MAX_PAYMENT_AMOUNT` is never bypassed, and a failed read of the policy list leaves the cap in force. The policy is only as strong as Wallet BE's enforcement of it, which is off in prod as shipped. **The agent could write such a policy itself**, so `write_policy` pays and writes only with `confirm: true`, which the user must have given after seeing the interpretation and the price; the wallet cannot verify a person said yes, it is the same instruction-level gate `transfer_token` uses. Collecting a write that was paid for elsewhere needs the same confirmation, and `pay_and_fetch` refuses the policy-write service's paid paths. |
| `ZETRIX_WALLET_STATE_DIR` | no | Where the wallet keeps `account.json` and its VC cache. Defaults to `~/.agentic-wallet-mcp` |
| `SSIVC_BASE_URL` | no | myid's SSIVC API base URL, for the Verified AI Birthcert flow (`request_ai_birthcert_verification`/`check_ai_birthcert_verification`). **Auto-derived per network** — testnet `https://ssivc-api-uat.myegdev.com/api`, mainnet `https://verifyid-api.zetrix.com/api`. Override only if either changes |
| `MYID_VERIFY_LINK_TEMPLATE` | no | The link `create_verification_qr` gives the user, with `{referenceId}` where the MBI reference id goes — MyID's universal link, e.g. `https://<MyID link domain>/<path>?referenceId={referenceId}` — must be `https`, with the placeholder in the path or query (not the host); a template that breaks this is warned about at startup and refused by the tool. **Defaults on testnet** to the UAT link the MyID app is registered for, `https://ssivc-api-uat.myegdev.com/api/agentic-verify?referenceId={referenceId}` (read from that host's `apple-app-site-association`, which claims exactly that path and query). **No default on mainnet** until MyID's production side is verified: MyID has stated `https://myid-verifier.zetrix.com/api/agentic-verify?referenceId={referenceId}`, but it was not deployed when this was written, so the tool refuses before it creates anything rather than hand out a link that may not open. Set this variable to use it (or any other link) there; it also overrides the testnet default |
| `POLICY_DECISION_URL` | no | Base URL of the policy DECISION service, for `check_policy_decision`. **No default**: the endpoint sits behind an authenticated path this wallet has no credential for, so guessing a host would turn "nobody has wired this up" into a connection error. With none configured the tool answers `undetermined` and says why |
| `POLICY_DECISION_AUTH` | no* | `Authorization` header value for the policy decision service (e.g. `Bearer …`). Without it the service answers 401 and the tool reports that the wallet is not authorised — not that the request was wrong |
| `POLICY_TEMPLATE_PUBLISHER` | no | The publisher whose policy templates the wallet offers when the caller names none. **Auto-derived per network** — on testnet `ZTX3QFo5oc3Ep8rdJZKgfPDFNN29qjxn5ofED`, and none elsewhere: no policy module is deployed on mainnet, so a guessed publisher would read as "this publisher has no templates" instead of "there is no policy system here". Override only to point at a different publisher |
| `AI_BIRTHCERT_VERIFIED_TEMPLATE_ID` | no | The Verified AI Birthcert's on-chain `did:zid:...` template id. Auto-derived per network by default — **the mainnet default is unverified**, so override this explicitly once the mainnet template id is confirmed |
| `GAS_PREFERENCE` | no | `sponsored` or `self` — the default gas payer for the Verified AI Birthcert flow (`request_ai_birthcert_verification`). **Defaults to `sponsored`; any unrecognised value also falls back to `sponsored`** rather than throwing. Sponsorship only actually engages when the resource server's x402 quote offers a sponsored option (`extra.gasModel: "facilitator"`) — a server that only quotes self-pay behaves unchanged. **Sponsorship is testnet-only today**; override per-call with the tool's `gasPayer` parameter |
| `MAX_SETTLEMENT_ATTEMPTS` | no | Cap on retry attempts while polling a sponsored payment for settlement after SSIVC returns `202 Accepted` (queued). **Defaults to `20`; a non-positive or unparseable value also falls back to `20`** |
| `SETTLEMENT_WAIT_BUDGET_MS` | no | Total time `request_ai_birthcert_verification` **and** `check_ai_birthcert_verification` will each wait for a queued settlement before returning `{ settlementPending: true }` / `{ status: "settlement_pending" }` — `check_` advances the settlement too, so it can block for this long. The attempt cap alone cannot bound this, because the delay between attempts is server-supplied. At least one poll always happens, even if the budget is shorter than the first retry delay. Not capped at the top end — raising it *and* `MAX_SETTLEMENT_ATTEMPTS` together can reinstate the long blocking call this budget exists to prevent, so raise it deliberately and temporarily. **Defaults to `90000` (90s); a non-positive or unparseable value also falls back to `90000`** |
| `SETTLEMENT_STUCK_AFTER_MS` | no | How long a settlement SSIVC cannot confirm may stay unresolved before `check_ai_birthcert_verification` stops calling it "still settling" and calls it permanently stuck. SSIVC returns the same `status_code 69` for a settlement two minutes old and one three weeks old, so the receipt's own age is what separates *"payment sent, check back shortly"* from *"this is not coming back, the fee was most likely already taken, and starting over costs a second fee"*. It also decides when starting over is allowed: a receipt younger than this is **refused** by both discard routes (`discardStuckReceiptAndPayFresh` and `clear_stuck_payment_receipt`), with nothing discarded and nothing paid, so a very low value makes the second-fee path available after a shorter wait for a settlement that may still resolve. Lower it only deliberately, for an operator or a test. Either side of the line the wallet never pays again or discards the receipt by itself. **Defaults to `86400000` (24h); a non-positive or unparseable value also falls back to `86400000`** |
| `SSIVC_TRACE` | no | Set to exactly `1` to print every request to and response from SSIVC (headers, body, status) to **stderr**, for diagnosing a settlement that will not resolve. Off by default. **Reproduction only:** the trace contains the payment receipt, which is a bearer handle on a real payment, plus the request signature — never leave it on, never ship it to a log pipeline. Nothing is ever written to stdout. |

\* sensitive — never logged, never returned in a tool result, and never a tool parameter.

### Onboarding: two ways to set up your holder identity

`ZETRIX_ADDRESS` and `HOLDER_DID` are both optional — the MCP resolves your holder identity at
startup, in one of two ways:

1. **First-time user — nothing set at all, or only `HSM_PASSWORD` set.** The MCP creates a
   brand-new HSM account on Wallet BE (`POST /wallet/hsm/account/create`) and derives the DID from
   the returned public key. If you did not set `HSM_PASSWORD`, it generates one for you first. It
   logs the new `ZETRIX_ADDRESS` (and `HOLDER_DID`) to stderr on startup, and saves the address,
   DID, and password to a local account store (`~/.agentic-wallet-mcp/account.json`, owner-only) —
   it's reused automatically next run, no config edit required. An explicit
   `ZETRIX_ADDRESS`/`HSM_PASSWORD` set later in your MCP config still overrides the saved account.

   **If the wallet generated your password, back it up — see below.**
2. **Existing user — `ZETRIX_ADDRESS` + `HSM_PASSWORD` set, `HOLDER_DID` optional.** The MCP
   always self-signs the address via the existing `POST /wallet/hsm/sign-message` call and
   derives the DID from the `publicKey` the response carries — no separate lookup endpoint
   needed. A supplied `HOLDER_DID` is never trusted blindly: it's compared against this derived
   value, and if they don't match, the derived (correct) one wins — the mismatch is logged to
   stderr so you know to fix your config. Omit `HOLDER_DID` entirely and the derived value is
   just used directly.

Either way, `wallet_status` always reports the resolved `zetrixAddress`/`holderDid` for the
running session, so you can confirm what the MCP resolved to at any time.

### Backing up a self-provisioned wallet

If you never set `HSM_PASSWORD`, the wallet generated one and stored it in
`~/.agentic-wallet-mcp/account.json`. You never have to type it — but it is the only thing that
can authorize signing for your account. Wallet BE holds the key and will not use it without this
password, so if you lose the file the account cannot be recovered and any funds in it are gone.
Back it up with:

```bash
npx agentic-wallet-mcp export-credentials
```

This only runs in an interactive terminal, so it can't be piped into a file or a log, and it is
deliberately **not** available as an MCP tool — an AI agent can never read your password.

\*\* **You must set this before the wallet will pay for anything.** It defaults to `{"*":"0"}`,
which refuses every payment. `pay_and_fetch` and `subscribe_and_issue` auto-pay whatever
`maxAmountRequired` a remote server's 402 challenge demands, so without a ceiling a prompt-injected
or misled agent calling either tool against a hostile endpoint would pay whatever that endpoint
asks for, bounded only by the account balance. `MAX_PAYMENT_AMOUNT` is a hard, code-enforced cap
that holds regardless of what the calling agent decides. It is also an allowlist: an asset with no
entry and no `"*"` fallback is **denied**, not passed through uncapped.

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

