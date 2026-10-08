# Changelog

All notable changes to `agentic-wallet-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Entries for 0.5.0 and earlier were reconstructed from commit history when this file was
> introduced in 0.6.0, so they summarise each release rather than being exhaustive.

## [Unreleased]

## [0.14.0] — 8 October 2026

### Fixed

- **`credential_preflight` now says when the wallet already holds the credential, before the agent asks the user for anything.** A user with a
  valid Verified AI Birthcert asked for one, was told "no blockers, 1 JMYR", and was asked to choose an agent name: the only check for an existing
  credential was in the paid `request_ai_birthcert_verification` call (the free quote path skips it on purpose, so a price can be read while a
  session is in flight), and preflight never looked at what the wallet holds. Preflight now looks, locally and for free, at the credentials the
  wallet has saved; if a valid copy is held it stops with `ready: false` and `alreadyHeld` (what it is, its id, its expiry), prices nothing, and
  tells the agent not to ask for a name or start an issuance. A new one would replace it and cost the fee, so only when the user explicitly wants a
  replacement does the agent run it again with `replacing: true`. Works for the Basic AI Birthcert and any template credential too. An expired
  credential does not count; a lookup that fails is reported in `notChecked`, never as "nothing is held". It does not see a credential that was
  paid for and issued but never collected with `check_ai_birthcert_verification` — the paid call's own guard still covers that.

### Changed

- **`create_verification_qr` has a built-in link on testnet (UAT), and it is the one the MyID app is registered for.** `MYID_VERIFY_LINK_TEMPLATE`
  now defaults to `https://ssivc-api-uat.myegdev.com/api/agentic-verify?referenceId={referenceId}` on testnet, so nobody has to set it. It was read from
  the host's own `apple-app-site-association`, which claims exactly `/api/agentic-verify` with a `referenceId` query (plus an `assetlinks.json` for
  `com.zetrix.myid.uat`), and that address serves an "open this on your phone" page. The first link the wallet was given,
  `/v1/agent-verification/{referenceId}`, is claimed by neither: a phone would not hand it to the app, and the server answers 404. **Mainnet has
  no default** until MyID's production side is verified (MyID stated `https://myid-verifier.zetrix.com/api/agentic-verify?referenceId={referenceId}`, but it was not deployed and its host sits behind a Cloudflare browser
  check, so the association files could not be read): the tool refuses before it creates anything on MBI, as for any unverified mainnet value, and the stated link is
  kept as `UNVERIFIED_MAINNET_MYID_VERIFY_LINK_TEMPLATE`. Set `MYID_VERIFY_LINK_TEMPLATE` to opt in. The variable still overrides the default on either
  network, and only a value someone set is warned about at startup.

### Added

- **`valueHuman`: give one amount in whole tokens, and the wallet does the multiplication.** On any attribute of `policy_preflight`,
  `write_policy` and `update_policy`, `valueHuman: "100"` stands in for `value` and means 100 whole tokens. The wallet converts it with
  the asset's own on-chain decimals (native ZTX, or the token named by `tokenAddress`), returns the raw value in `convertedAmounts`, shows
  both forms in `interpretation` ("perTransactionMax: 100 JMYR is written as 100000000"), and never sends `valueHuman` to the service.
  What counts as an amount comes from the service's served vocabulary (`unit: SMALLEST_UNIT`) when it can be read, and from the built-in
  list when it cannot; an attribute the service calls a COUNT or a DURATION is never scaled, whatever the built-in list believes
  (`maxTransactionCount` and the windows are refused). Anything it cannot convert exactly is refused with nothing converted: unknown
  asset, unreadable decimals, more decimal places than the token has, an exponent, a sign, a separator. A `value` given alongside must agree.
  It is applied BEFORE `amountUnit`, which then leaves it alone, so a human amount is never converted twice. The tool descriptions now
  also say that `maxTransactionCount` is a count, not an amount.

- **`update_policy` and `remove_policy`: users manage a policy through the agent after it is deployed.** `write_policy` is create-only
  (a second call with the same key answers `already_exists`); these add the other two on top of ms-zetrix's x402 routes.
  - **`update_policy`** replaces a policy's attributes and validity window and **pays the update fee** (through the same payment cap and
    `confirm: true` gate as `write_policy`, with the same `dryRun`). It takes the policy's `expectedUpdatedAtBlock` from
    `get_my_policy` (new `forUpdate.expectedUpdatedAtBlock`, already a string — the chain returns a number and the service wants a string),
    carries the policy's template forward rather than taking one, and keeps its validity window unless a new one is given (the service does
    not default an omitted bound, so sending nothing would have stripped an existing expiry). It reads the policy first and checks the draft
    against the policy's own template. Every refusal that can be known first is free and says nothing was paid: `not_found`, `modified`
    (the policy changed since it was read), `template_unavailable`, `refused`. A paid update that the chain then rejects is `write_failed`
    and says the policy is **unchanged** and a payment may have been taken.
  - **`remove_policy`** is free but lifts every limit the policy set, so nothing is sent without `confirm: true`; the unconfirmed call
    returns what the policy currently limits. It is reported as `removed` **only when a chain read shows the policy gone** — a submitted
    transaction is `submitted`, never "removed" — and repeating it never submits a second removal.
  - **`check_policy_write`** now collects an update receipt on the update route: the receipt bookmark records which write it pays for
    (`operation`), and one saved before this change reads as a create.
  - **`write_policy`'s default `requestKey`** is now a sha256 hex string. The old `owner-policyKey-timestamp` overflowed the service's
    128-character column for a policy key longer than about 65 characters.
  - A write the service says is already paid for is collected on the route **its own operation** names, which may not be the write just
    asked for (previously it was always collected as a create).
- **The service's own description of every policy attribute.** ms-zetrix now publishes the vocabulary at
  `GET /policy/vocabulary` (version `v1`, sixteen attributes, each with a description, unit, role, what it
  pairs with and what an empty list or a use outside its scope means). `get_policy_template_schema` returns
  it beside `declared` as `attributeMeanings`, so an agent can say what a rule means instead of guessing, and
  `policy_preflight` (and the check `write_policy` runs before paying) uses it to refuse what the built-in
  rules cannot know: an attribute the service does not recognise (`unknownAttributePolicy` defaults to
  deny, so it refuses every transfer) and an attribute used outside the scope it applies to
  (`allowedMethods` or `approvalPolicy` on a native policy). When the service and the built-in rules
  disagree about a role or about what a missing window means, that is reported in `notChecked` and the
  STRICTER of the two answers is used, so a service label can tighten the "enforceable" refusal but never loosen
  it. The read is strict (one malformed attribute fails the whole read, and an unknown version is refused),
  bounded (descriptions are flattened to one line, stripped of invisible formatting characters such as bidi
  overrides, cut at 600 characters, and shown as quoted text from ms-zetrix that describes and does not
  instruct; "bounded, not scrubbed"), never follows a redirect, refuses a declared oversize body before reading
  it, cached (ten minutes for a good answer, one for a failure) and never throws. **If it
  cannot be read, nothing else changes**: every existing preflight result is as before plus one `notChecked`
  line. Known limit: the route is behind a Cloudflare bot challenge that, as observed on 2026-10-06, some
  non-browser clients (Node `fetch`, Git's OpenSSL curl) receive as an HTML page with HTTP 403 and
  `cf-mitigated: challenge`; that is reported as `challenged` and the built-in rules are used until it is
  exempted.

- `create_verification_qr`: gives a human a link and a QR code that open the agent's credential in the MyID app. The wallet presents the credential to MBI, and the link holds only the reference id — which grants access to the revealed attributes until it expires, so by default only a standard minimal set is revealed — Verified AI Birthcert: `agentName`, `evidenceProvider`, `ownerVerified`; Basic AI Birthcert: `agentUsername` — never the owner's name, id or date of birth; other attributes need `revealAttribute`, and everything needs `revealAll: true`, which the agent uses only when the user explicitly asks. A Basic credential's result says it does not mean the owner was verified. The link is built from `MYID_VERIFY_LINK_TEMPLATE` (MyID's `https` universal link, with `{referenceId}` in the path or query); with none set, or one that breaks those rules, the tool refuses before anything is created on MBI, and a bad template is warned about at startup. A credential whose subject is not this wallet is refused locally. The link stays openable for 5 minutes by default, up to 60. With no `vc` given it presents the Verified AI Birthcert if the wallet holds one, otherwise the Basic AI Birthcert (the result says which, in `credentialUsed`), and if it holds neither it answers `created: false` and says to create one first; no other credential is picked for the caller. A refusal for a path the credential does not have lists the attribute names it does have. The OpenClaw plugin gains a `myidVerifyLinkTemplate` setting that is forwarded to the wallet. The named paths must each be a single attribute of the credential: a typo or a parent path is refused, and so is any path the wallet cannot check — a credential that is not an object, has no plain `credentialSubject`, or has an attribute name containing a dot — in which case the caller passes the credential object or uses `revealAll`. They are sent de-duplicated and in the credential's own order, and the result states what was revealed (`revealed`). The template is judged as a browser would read it: only printable ASCII, no backslash, no `@` before the host, and not containing the text `refidmarker`.

- **A unit guard, and `amountUnit`, for policy amounts.** A real policy went on chain with
  `perTransactionMax: 1` and `cumulativeMax: 100` for a 6-decimal token (JMYR) — 0.000001 and 0.0001 of
  it, a million times tighter than the "1 JMYR" and "100 JMYR" the user meant. Amounts are raw base units,
  and nothing made that visible before the payment. Now a non-zero `perTransactionMax`, `cumulativeMax` or
  `velocityCap` under one whole token is refused by `policy_preflight` and `write_policy` unless
  `amountUnit` says what is meant: `"whole"` gives whole-token amounts (`"1"`, `"0.5"`) which the wallet
  converts by the token's decimals, returns in `convertedAmounts` and states in `interpretation` — and
  `write_policy` then writes the converted raw values, so what is paid for is what the user saw; `"base"`
  confirms a tiny raw value is intended. Silence is not an acknowledgement. Conversion refuses to guess:
  unreadable decimals, a missing scale, more decimal places than the token has, or anything that is not a
  plain number all refuse the draft. Counts (`maxTransactionCount`) are not amounts and are untouched.
  A `"whole"` draft in which every amount is already 10^decimals tokens or more is refused too, because
  that is what an already-converted value looks like and converting it again would write a cap a million
  times looser; `convertedAmounts` is for showing the user and must never be sent back as the values.
  Because a genuine cap that large looks identical, the refusal names BOTH readings with the exact raw value
  for each (resend a copied raw value unchanged with `"base"`; send a real large cap as the value times
  10^decimals with `"base"`). It needs every amount to look raw, so a copied draft that also contains a zero
  or sub-token amount is not caught. Raw amounts are also bounded to 77 digits, the most a 256-bit number has.
  Token decimals are now typed strictly and bounded (0–36) at the read: `null`, an empty string, `false`
  or an array used to read as a genuine 0-decimal token, and an absurd value made preflight throw or
  stall. The guard cannot catch a raw value that is already one whole token or more (`interpretation` states
  what such an amount means), and does nothing when the decimals cannot be read (`notChecked` says so).
- **`policy_preflight` no longer leaves a token policy to guesswork.** A real transcript ("limit 1 JMYR
  per transaction, 100 a week") exposed three gaps. (1) The agent asked the user for the JMYR contract
  address, which the wallet already holds: `wallet_status({ token })` now returns it as `tokenAddress`,
  a `ztp20` draft with no `tokenAddress` names the registered ones, and a token symbol written where
  the address belongs is refused with the address to use (the generic "ask the user, do not correct it"
  advice is suppressed for that case, since correcting a registered symbol is the right move). (2) The
  amounts were never stated in whole tokens, so `1` of a 6-decimal token — 0.000001 of it — read as
  "1 JMYR"; `interpretation` now says what each amount means, and says so plainly when the decimals
  cannot be read instead of assuming a scale. (3) Preflight accepted `cumulativeWindow: "week"`, which
  the write service refuses: every `*Window` must be a duration such as `7d`, `12h` or `30m` (or ISO
  `P7D`) — not a word, not a bare number (which would be read as milliseconds), and not padded with spaces,
  and `interpretation` states each window's period in words, because `1M` is one minute, not one month. The window grammar is
  restated from the service, so it is a tripwire rather than a guarantee; a window over the default 30d
  retention is noted, not refused, because that limit is environment-specific.

- **The wallet can now find a policy template on its own.** Asking it to "show me the policy
  template" on a wallet with no deployed policy used to go nowhere: the tool described a template id
  as something found "inside a deployed policy", a first-time user has none, and the only way to get
  one is to write a policy — which needs the id. The agent ended up asking the user for a publisher
  and a template contract address, neither of which a user can be expected to know.

  `get_policy_template_schema` with no arguments now lists the default publisher's templates, each
  with its declared attributes and the `templateId` that `write_policy` needs. A single template can
  be read by key alone, and another publisher's listed by naming it. An id is only ever returned
  once the chain has confirmed it — it is derived from the publisher and key, and one that does not
  resolve is withheld. The listing is bounded and says what it left out.

  New optional setting `POLICY_TEMPLATE_PUBLISHER`. The default is derived per network, and there is
  none where no policy module is deployed.

- **`policy_preflight` no longer approves drafts the write service refuses.** A real transcript
  drafted "a 10 JMYR per-transaction max" as `assetScope: "JMYR"` on the native template and got
  `ready: true` and "limited to JMYR" — for a draft the service rejects twice over. Preflight now
  applies the service's scope rules: `assetScope` must be exactly `native` or `ztp20` (never a token
  symbol), a `ztp20` policy needs a `tokenAddress` and says plainly when the chosen template cannot
  express one, and an amount or count cap needs an `assetScope`. No meaning is offered for a scope it
  is refusing. These are restated from the service, so they are a tripwire rather than a guarantee.

- **`policy_preflight` refuses a repeated attribute name.** The scope and token rules read the first
  attribute with a given name, so `assetScope: "native"` followed by `assetScope: "JMYR"` was read as
  ready. Which value the write service would take is not knowable from the wallet, so a repeat is refused
  rather than guessed at.

- **`write_policy` can quote its price first.** `dryRun` runs every free check and returns what the
  service asked for, paying, collecting and writing no policy — including never collecting a write that
  has already been paid for (it only keeps a local bookmark so `check_policy_write` can finish it). Previously the price could only be learned by paying it.

- **`write_policy` `dryRun` now says whether the wallet can afford the quote.** (The network fee is not
  estimated, and a payment made in ZTX needs the amount plus that fee from one balance, so a ZTX balance
  equal to the quote is short and `feeNotEstimated` says when "affordable" means only "holds the amount".) It reads the fee-asset
  balance, ZTX for gas (only when the payer would check it) and the payment cap the policy payer
  carries, and reports each shortfall separately under `affordability`. A balance that cannot be read
  is `unknown`, never `affordable`. Nothing is paid, collected or written, and the check is not run on
  a real deploy.

### Fixed

- **A collect that answers with an error no longer leaves a landed write as "unknown".** On staging an `update_policy` was paid and the service finished the collect, but it took 12.7 seconds and something in front of it answered HTTP 500 at about 10; the wallet could only say "unknown, ask again later", and asking again spends one of the service's few collect retries, while the chain already held the update. Now, when the collect step ends with an error that says nothing about the write (a 5xx, a gateway page, a status this wallet does not recognise, or the service's own "unknown"), the wallet reads the chain for up to 45 seconds, which is free and spends no retry, and reports `written` when the chain holds **exactly** the attributes that were submitted (for an update, with `updatedAtBlock` moved from the value it had before). A policy that holds the same attributes but did not move, one with an extra or missing or repeated attribute, an unreadable chain, and the service's own "the chain rejected it" are all left as they were: the wallet says `written` from a chain read only on exactly that (and, for a create, under the same template). The answers that start the read include every status the wallet does not recognise, a 4xx too. `check_policy_write` looks at the chain first for a receipt that still carries what to verify, so a write that already landed costs no collect. A receipt stops being verified once the service has said its write failed, or once a newer paid write for the same `policyKey` is made (so a later, separately paid write of the same values is never credited to an older receipt), and a receipt bought by another owner is never checked against this owner's policy. The read gets what is left of the poll budget (at least 10 s, at most 45 s) and each read is cut off at 10 s. The bookmark now records the submitted attributes and the prior `updatedAtBlock` (public policy rules, no credential; a malformed record is dropped on read and the receipt stays usable). The result also carries `upstream: { status, detail }`, the service's own answer kept apart from the wallet's wording (control characters and line breaks replaced, at most 200 characters; the service's own "unknown" carries it too), and a `written` inferred from the chain carries `paymentReceipt`. **Not changed here, and not the wallet's to change:** the 500 itself. It is a gateway or ingress timeout on a collect that takes longer than it allows; raising that timeout for `/collect` (or making collect return before it finishes) is a server-side fix.

- **`valueHuman` review round 1.** A native policy that also names a `tokenAddress` is refused (the service ignores it for native payments, so it would not limit ZTX) and is never read as an amount of ZTX: before, a `valueHuman` on it was converted with ZTX decimals while the cap applied to the token, up to a million times off. An attribute with neither `value` nor `valueHuman` is refused for every type: before, a STRING attribute could reach the wire with no value. An attribute entry that is not an object is refused cleanly instead of with a raw error. An attribute the service lists with a unit other than the smallest unit is never scaled. A numeric `valueHuman` is accepted only as a safe whole number (write `"0.5"` as text), and a `value` that is not text beside a `valueHuman` is refused. The descriptions say never to put `convertedAmounts` into `valueHuman`.

- **`update_policy` / `remove_policy` review round 1.** Recovering a write that was already paid for now collects on the
  receipt's OWN route: a receipt the wallet holds decides it, the server's `operation` must agree or nothing is collected, and an
  update whose operation neither side names is refused instead of being collected as a create (which could lose the receipt and
  invite a second charge). `validFromBlock: null` / `validToBlock: null` are treated as "not named" and the current bound is carried
  forward, and a malformed bound is refused for free, so an agent can no longer strip an expiry by sending `null`. A malformed error
  envelope (`messages` that is not an array) can no longer throw out of a payment refusal. A paid create that is still being
  completed (409 with `errorCode` 461529) is reported as in progress, not as "the policy already exists, nothing was paid", and
  the messages no longer promise that asking again will hand back a receipt. An unexpected 2xx from remove, and a 5xx on the update
  pre-check, are reported as unknown or unavailable instead of "nothing was removed" / "refused"; a `getPolicy` reply with no
  boolean `found` is a failed read, not "removed". The idempotence of `remove_policy` is described as the server's, not the
  wallet's. Not done here, deliberately: saving the receipt before the phase-2 payment, which the server flag for owner-password
  collection depends on; that flag must stay off until it ships.

- **Follow-ups from the vocabulary review.** The quoting around a service description can no longer be closed by a
  double quote in the description (it is JSON-escaped, so it stays one quoted span). A pairing the service reports with a window the built-in rules do not name (a renamed
  window) is always reported in `notChecked`, and refused when the service says that without it the cap is unenforceable or not
  a limit at all, so a rename is never silent.
  The `maxTransactionCount` blocker states its reading as ms-zetrix's published vocabulary as read on 2026-10-07 rather
  than a hard-coded claim, `get_policy_template_schema` says the meanings are data from ms-zetrix and not instructions, and
  `attributeMeaningsSource` is listed in the README.

- **A `maxTransactionCount` with no `countWindow` is refused.** It was a quiet note on a `ready: true` result, so the
  owner paid for a policy with no count limit: the wallet's own rule says a count with no period is not requested at
  all, and ms-zetrix describes it as refusing every transfer, and neither gives the limit the owner wrote. The fix
  (add `countWindow`) is free, so it is now a blocker, as a `velocityCap` without its window already was. A pairing
  the service calls unenforceable and the built-in rules call something looser is refused too. Which reading is
  right still needs confirming with ms-zetrix.
- **An attribute the service does not know restricts nothing when `unknownAttributePolicy` is `"ignore"`**, so it no
  longer counts as the policy's enforceable constraint.

- **`tokenAddress` counted as an enforceable constraint.** The service's vocabulary calls it a QUALIFIER (it
  says which token a policy governs and caps nothing), and the wallet's built-in set did not, so a policy of
  `assetScope` plus `tokenAddress` alone passed preflight although the service would answer
  `NO_ENFORCEABLE_CONSTRAINTS` and refuse every transfer. It is now a qualifier.

- **The paying tools report a Wallet BE spending-policy refusal as what it is.** `transfer_token` told a policy denial
  (`1000033`, a decision) from a check that could not complete (`1000034`, transient) from a signing failure; the four x402
  paths did not, and Wallet BE signs the same way for all of them. `pay_and_fetch`, `subscribe_and_issue`, the Verified AI
  Birthcert session fee and `write_policy`'s fee surfaced the raw `Wallet BE /wallet/hsm/sign-blob errorCode 1000033: …`
  as a thrown error, with nothing to tell an agent that one is final and the other worth retrying. They now return
  `policyDenied: true` or `policyCheckUnavailable: true` with a message that says plainly what was and was not done: the
  refusal arrives at the signature, before the X-PAYMENT header exists, so nothing was paid, and each path adds what it
  had already done (a quote, the free pre-check, the issuer's payment request — none moves money). Matched on the numeric
  `errorCode` only, never on message text, and the failure text is bounded like `transfer_token`'s. A refusal is never
  retried on the other gas option. `write_policy` reports a denial as state `refused` and an unavailable check as
  `unavailable`, with `paid: false`. Every other failure still throws, as before. The matching moved to a shared module
  (`policy-refusal.ts`) and `pay_and_fetch`'s payer to `orchestrator/pay.ts`, where it can be tested.

- **`transfer_token` now tells a policy refusal from a signing failure.** Wallet BE enforces the user's
  policy at signing and answers a refusal as HTTP 200 with a numeric `errorCode`: `1000033` when
  the policy decision service said DENY (a decision, with the reason code in the message) and `1000034`
  when the policy check could not complete (it fails closed; transient). The wallet only recognised an HTTP
  403 or a `policyCode` field, neither of which Wallet BE sends, so both surfaced as "signing failed" — the
  same words as the signer being down, with nothing to tell an agent that one is final and the other is
  worth retrying. `1000033` now yields `policyDenied: true` ("a decision, retrying will not help", with the
  reason shown) and `1000034` yields `policyCheckUnavailable: true` ("transient, trying again shortly is
  right"). They are matched on the numeric field only, never on message text, so a lookalike message or a
  string code does not classify, and every other Wallet BE error is still "signing failed". The failure text
  is bounded on every path, including an ordinary "signing failed" — bounded and flattened to one line (whitespace and
  control characters collapse, so a remote message cannot lay out fake lines), cut by character so a surrogate pair is never
  split, and total (it never throws), but NOT scrubbed: markup in a remote message is still shown. A bare HTTP 403 no longer counts as a policy
  denial: it can come from a proxy or WAF, and reporting that as a final decision would be the inverse of this
  bug; a structured `policyCode` and `errorCode` 1000033 still do. Nothing changes for an environment where
  Wallet BE enforcement is off (the shipped default
  for test, UAT and prod). Only `transfer_token` is changed; the x402 payment paths surface the Wallet BE
  message as before.

- Existing tests used `cumulativeWindow: "43200"` — a bare number the service refuses — as a valid
  window, encoding the same false assurance. They now use `12h`.

- **A gateway's 5xx on `collect` is no longer reported as the chain rejecting the write.** A real run got a
  Spring `500` from `/collect` and then Cloudflare's "origin returned an invalid response" page as a `502`;
  the wallet read the second as the service's own `WRITE_FAILED` and told the user the chain had rejected a
  paid write, when nothing was known about it. The service's own 502 and 504 always carry JSON with
  `state: "WRITE_FAILED"` / `"UNKNOWN"`, so a 502/504 now counts as the service's only when its body says so.
  Any other 5xx is a new `server_error` outcome: state `unknown`, receipt kept, never retried (a failed
  collect uses one of a small number of retries), no claim about the chain, and one later `check_policy_write`.
  A gateway page is quoted as bounded plain text, and a 5xx carrying a state the wallet does not know stays on
  the unrecognised path. The `500` itself is an unhandled exception in ms-zetrix and needs fixing there.

### Changed

- **A spending policy for an asset replaces the default wallet cap for that asset; mainnet gets the same default cap as testnet.**
  A payment had to pass the wallet's own per-payment cap and then Wallet BE's policy, so a policy allowing 2 JMYR did not
  raise the default 1 JMYR cap: a 1.5 JMYR payment was refused by the wallet before the policy was consulted. Now, when the
  owner has a policy that governs the asset being paid (`assetScope` native for ZTX, or ztp20 with that `tokenAddress`, a
  `perTransactionMax`, and no block range), the DEFAULT cap is not applied on any paying path (`pay_and_fetch`,
  `subscribe_and_issue`, the AI Birthcert fee, `write_policy`'s fee, `transfer_token`) nor in the cap shown by
  `credential_preflight` and the `write_policy` quote, which then say the policy governs. It fails closed: no policy
  registry (mainnet today), a failed or timed-out read of the policy list, a policy for another asset, one with no
  `perTransactionMax`, one that repeats `assetScope`, `tokenAddress` or `perTransactionMax`, a native policy that also names a
  token (the service ignores it for native payments), or a policy bounded in time all leave the cap in force, and an explicit `MAX_PAYMENT_AMOUNT` is never bypassed. A good reading is cached for 30
  seconds, so a removed policy can still stand the cap aside for up to that long. Only the cap stands aside: a malformed amount in a payment challenge is still refused. **`write_policy` now needs
  `confirm: true` to pay and write** (without it the call returns the price, `needsConfirmation: true`, and nothing is paid),
  because the agent could otherwise write a high `perTransactionMax` and lift its own cap in two calls; the wallet cannot verify
  that a person said yes, it is an instruction to the agent like `transfer_token` `confirm`. The gate also covers collecting a write that was paid for elsewhere (a "already in flight" answer is neither saved nor collected without `confirm: true`, so `check_policy_write` has nothing to collect), and `pay_and_fetch` refuses the policy-write service's paid paths. A read of the policy list that times out is never cached when it finally answers, and no further read starts while it runs. **Two things this accepts, agreed with the
  reviewer:** the general default cap on mainnet is now 1 JMYR per call (it was refuse-all, deliberately, so `pay_and_fetch`
  could not auto-pay an arbitrary URL), with no running total; and the bypass trusts Wallet BE to enforce the policy, which it
  does not in prod as shipped.

- **Corrected the `notChecked` text on preflight results.** It said the deploy path "is not built
  yet", which stopped being true when `write_policy` shipped, and stated as fact that nothing consults
  the decision service — something this wallet cannot see.

- **`write_policy` no longer asks for `templateContractAddress`.** The wallet already knows the one
  Template contract it trusts and refuses any other before any payment, so requiring the caller to
  supply it could only invite a wrong value. Leave it out; one that is supplied and differs is still
  refused.

- **The wallet now signs each request it makes to MBI's `/ext` endpoints, instead of signing its own
  address once.** Creating and submitting a presentation, and downloading the Verified AI Birthcert,
  used to log in with a signature over the wallet's own address. That value never changes, so one
  captured set of headers stayed valid for that address indefinitely, and MBI has marked the scheme
  deprecated. Each call now signs its method, path, a hash of the exact body sent, and a fresh
  timestamp, and the signature is good for that one request. MBI has accepted this since 31 July 2026.
  If a Verified AI Birthcert download fails at the signing step, `check_ai_birthcert_verification`
  now reports it as a retryable fetch error instead of failing outright.

## [0.13.0] — 29 September 2026

### Added

- **`check_policy_decision` — ask whether a specific spend is permitted right now.** The one policy
  question no chain read can answer, because a cap is measured against cumulative spend held
  off-chain. Three outcomes: `permitted`, `refused` and `undetermined`, where undetermined is
  neither a refusal nor permission — it means nothing was evaluated, and every failure produces it,
  so no transport error, bad envelope or unknown verdict can ever yield a permitted answer. There is
  no step-up verdict, because the decision service has none.

  **A permitted answer reserves the owner's budget for fifteen minutes**, with no way to release it
  early, so the tool tells the agent not to poll it and not to probe amounts — every permitted
  answer along the way reserves again, and the owner's next real payment can be refused by their own
  agent. New optional settings: `POLICY_DECISION_URL` and `POLICY_DECISION_AUTH`. Without a URL the
  tool answers `undetermined` and says so, rather than failing against a guessed host.
- **`write_policy` / `check_policy_write` — deploy a spending policy on chain, pay-gated over x402.**
  Three phases: a free pre-check, a payment that writes nothing, and a collect that finishes the
  write once the settlement confirms. Two tools rather than one, because the settlement queue can
  outlast a single call. A `202` here is not a failure — between the payment and a confirmed
  settlement, a payment has been made and no policy exists yet, and that window is the normal case;
  `settling` and `submitted` both mean a payment has been made, so the agent is told to call
  `check_policy_write` rather than retry `write_policy`. `submitted` carries a `txHash` and is still
  not a written policy — the block hasn't confirmed it. A `receipt_void` result is the one state
  where paying again is correct.

### Fixed

- **The wallet's own follow-up guidance no longer promises the agent will "check again shortly" on
  its own.** QA saw an agent claim it had "set up an automation to check every 60 seconds" after a
  Verified AI Birthcert session came back pending — no such capability exists. Investigation found
  the wallet's own ready-made "Tell the user:" sentences ended the same way, and the new hardening
  text in the tool descriptions had nowhere near the reach of a sentence the model is told to relay
  verbatim. Every such sentence now asks the user to message back, never claims the agent will act
  between messages, and — since a link that has already expired (or is about to) makes "message back
  in a few minutes" actively wrong — the wording now depends on how much time is actually left on the
  verification link.
- **`request_ai_birthcert_verification` and `subscribe_and_issue` now explicitly instruct the agent
  to ask the human owner for an agent name, rather than inventing one.** The same QA session showed
  an agent silently picking its own agent name in both the Verified and Basic AI Birthcert flows.
  The "ask the user, never invent" rule previously lived only in a skill-layer document that not
  every MCP client loads; it is now in the MCP tool schemas themselves, including at the specific
  field the model fills in.

## [0.12.3] — 28 September 2026

### Fixed

- **`request_ai_birthcert_verification` now checks for an existing Verified AI Birthcert VC before
  paying for a new one.** Asking for a verified credential when the holder already had one used to
  start a brand-new paid session unconditionally, surfacing as a confusing "name already in use"
  error instead of reusing or asking about the existing VC. It now checks the local cache, and — if
  the cache never saw a previously-issued session — resolves that session's VC the same way
  `check_ai_birthcert_verification` does, rather than trusting an empty cache. A still-valid existing
  VC blocks the request and returns `{ existingVerifiedVc: { vcId, validUntil }, message }`; replacing
  it requires echoing its exact `vcId` back as `confirmReplaceExistingVc`. An expired existing VC is
  replaced automatically, with the result carrying `replacedExpiredVc: { vcId, validUntil }`.
- **After a Verified AI Birthcert is issued, the agent now shows the full credential, including its
  pass-design image when one is available.** The response used to summarise only a handful of fields
  (credential id, agent name, owner, valid-until, evidence) and never mentioned the credential's
  official pass-design image, even when the wallet already had it. Every claim on the credential is
  now shown, and the pass-design image is surfaced when present, instead of being silently dropped
  from the summary.
- **`policy_preflight` now validates against the real on-chain template vocabulary instead of an
  invented one.** Its type checking and the "this policy denies everything" blocker were built from a
  field guide written before any policy template existed on chain, so the real deployed types and
  list-attribute names didn't match what was actually being checked for — a spending cap of
  `"not-a-number"` could pass clean, and an empty allow-list wasn't flagged as blocking every payment.
  Both now fire correctly against the real templates.
- **A deny-list is no longer described as if it were an allow-list.** `policy_preflight` used to guess
  a list attribute's meaning from its data type alone, which says nothing about which way the list
  points — a recipient deny-list came back described as "allows ONLY the entries listed" when it
  actually does the opposite, and an empty deny-list (which blocks nobody) was wrongly flagged as
  blocking everything. Each list attribute's true direction is now looked up individually; one the
  wallet can't confirm is reported as "not checked" rather than given a guessed meaning.
- **`get_my_policy` no longer reports a policy as found when it isn't there.** A shape mismatch meant a
  genuine "no policy deployed" answer from the credential service was read as a successful, empty
  policy, so a real policy could look like it had no rules at all. It's now correctly reported as a
  failed read instead.

## [0.12.2] — 24 September 2026

### Fixed

- **A taken `agentName` is no longer reported as an already-settled payment.** The credential service
  answers both "this name is already taken" and "this exact payment was already settled" with the same
  HTTP 409, and the wallet used to treat every 409 as the settled case — telling the user their fee was
  most likely taken and warning that retrying would charge it again, when picking a different name was
  actually free to try. The two are now told apart, and a taken name says only that: choose a different
  `agentName`; it does not claim the fee was, or was not, taken.
- **A payment can no longer be discarded and paid again until it is genuinely stuck.** In a live run the
  first payment had already settled, the assistant offered to "discard the stuck receipt and start
  fresh" for a second 1 JMYR, and a bare "retry" from the user was taken as agreement, so the user paid
  twice. The rule that a receipt only counts as stuck after 24 hours (`SETTLEMENT_STUCK_AFTER_MS`) was
  only advice; the wallet now enforces it on both ways of discarding a receipt and pays nothing when the
  receipt is younger. Set `SETTLEMENT_STUCK_AFTER_MS` lower on purpose if you need to start over sooner.
- **The agent can now tell the user how long the verification link really lasts.** The wallet used to
  return the session's expiry untouched and leave the arithmetic to the agent, and in one run the agent
  mixed up timezones and said the link was good for about 8 hours when it had about 15 minutes. Results
  now carry `expiresIn` ("about 14 minutes") and `expiresInSeconds`, worked out by the wallet, and the
  tool descriptions tell the agent to quote them.
- **A payment the credential service has not confirmed yet is now reported with what the service actually
  said**, including its status code and message, plus a short sentence the agent can pass on to the user
  as-is. Previously the agent had nothing real to quote and sometimes made up an explanation.

### Added

- `SSIVC_TRACE=1` prints every request to and response from the credential service to stderr, for
  diagnosing a settlement that will not resolve. Off by default; the trace contains the payment receipt,
  so it is for reproductions only.

## [0.12.1] — 24 September 2026

### Fixed

- **A refused receipt replay is now reported as a refusal, not as a pending settlement.** When the
  credential service was reached and answered with a 4xx (for example a token failure on its side),
  the wallet used to say "PAYMENT SENT — nothing has gone wrong", even when something had. It now
  returns `issuerRejected: true` with the service's own message and status code, and
  `paymentInvalid: true` when the service specifically ruled the payment invalid. Neither says
  whether the fee was taken, in either direction. The receipt is still kept and the call stays
  retryable through `check_ai_birthcert_verification`. Indeterminate, void and already-settled
  answers are deliberately not treated as refusals.
- **A receipt the payment service has declared void is discarded automatically**, so the next
  request pays fresh instead of replaying a dead receipt forever. The discarded receipt id is
  returned so the lost payment stays traceable.
- **No message denies a payment this call itself made.** On a fresh purchase that then fails to
  settle, the wallet no longer says "no new payment was made" or "nothing is lost".
- **The already-settled answer no longer invites a second charge.** It now says the fee was most
  likely taken and asks for the user's explicit agreement before retrying.
- **`discardedPaymentReceipt` is returned on every result after a discard**, including errors and
  pending results. If the same call also discarded a void receipt, both ids are given.
- **Tool descriptions no longer tell an agent an undetermined settlement is "progressing".** Both
  `request_ai_birthcert_verification` and `check_ai_birthcert_verification` now separate a
  confirmed-queued settlement from one whose outcome could not be determined.

### Tests

- Every agent-facing tool and parameter description is now pinned by a reviewed snapshot plus
  guards against false money claims and unsafe retry advice.

## [0.12.0] — 22 September 2026

### Added

- **Three free policy read tools**: `get_policy_template_schema` (which spending rules a template
  allows), `get_my_policy` (the policies this owner has deployed on chain) and `policy_preflight`
  (is a draft policy valid, and does it MEAN what the user thinks). All read-only: they sign
  nothing, spend nothing and deploy nothing. Each reports a three-state result, so "this network has
  no policy system" is never reported as "you have no policy".
- **`clear_stuck_payment_receipt`**: the supported way to discard a Verified AI Birthcert payment
  receipt the wallet is holding and refusing to pay past — previously only possible by deleting a
  file on the server, which a hosted subscriber cannot do. Two steps by construction: the first call
  clears nothing and returns the receipt id, and clearing requires echoing that exact id back.
- **`request_ai_birthcert_verification` gains `discardStuckReceiptAndPayFresh`**: discard a stuck
  receipt and pay again in one call. Takes the receipt id, never a boolean, so a receipt cannot be
  discarded that was not first shown to the user. Refuses a mismatched id, a receipt belonging to a
  live session, and combination with `dryRun` — spending nothing in each case.
- **`SETTLEMENT_STUCK_AFTER_MS`** (default `86400000`, 24h): how long an unconfirmed settlement may
  stay unresolved before the wallet stops calling it "still settling" and calls it permanently stuck.

### Changed

- **`check_ai_birthcert_verification` now advances a queued settlement** instead of only reporting
  it. It replays the saved receipt — never a new payment — and returns the live session once it
  settles, so "check back in a few minutes" genuinely progresses the flow.
- **A queued settlement no longer blocks the tool call for ~20 minutes.** It returns within a bounded
  wall-clock budget (`SETTLEMENT_WAIT_BUDGET_MS`, default 90s) as
  `{ settlementPending: true, paymentReceipt, message }` — the payment succeeded and is in flight,
  which is not an error.
- **Settlement messages lead with their verdict** (`PAYMENT SENT` / `OUTCOME UNKNOWN` / `RECEIPT VOID`)
  and carry `paymentReceipt` as its own field, so an assistant summarising the result cannot turn
  "we do not know yet" into "it failed".
- **The three settlement verdicts are now told apart.** A receipt the service declares finished is
  terminal and reported as `status: "receipt_void"`; an unresolved one is judged by the receipt's own
  age — recent means "still settling, check back", older than `SETTLEMENT_STUCK_AFTER_MS` means
  "this is not coming back". None of them claims the fee was refunded: a settlement can expire after
  the money has already moved, so the receipt id is always handed back for support.

### Fixed

- A stuck receipt no longer dead-ends. The wallet still refuses to buy a new credential while one is
  held — that refusal is what prevents a second charge — but it now names the way out and states
  plainly that starting over costs the fee a second time.

## [0.11.0] — 17 September 2026

### Added

- **VC pass-design images are now surfaced for basic and verified birthcert issuance.** When the
  issuer returns a pass-design image alongside a credential, the wallet extracts it, writes it to
  disk, and — since a remote MCP client has no filesystem access to read a local path back —
  returns it as an inline image in the tool response too, so the pass is actually visible rather
  than just referenced by path.

### Fixed

- **The spending-cap blocker now shows human-readable amounts.** It previously showed the raw
  base-unit number with no symbol or decimal conversion, while the balance/fee blocker in the same
  response already showed the correctly formatted amount — the cap blocker now matches it.

## [0.10.0] — 14 September 2026

### Added

- **`credential_preflight` — a free readiness check to call before asking the user for anything.**
  Reports the live fee and which side pays gas, the balances that matter, whether the spending
  limit permits it, and (for a template credential) the attributes the template requires. Every
  reason it is not ready is listed *together*, so one round of fixes is enough rather than
  discovering a low balance and a too-low spending cap one failed payment at a time. It also
  reports what it could **not** check, so a clean result is not mistaken for a guarantee — notably,
  it cannot tell whether an agent name is still free, because that is decided at issuance.
- **Quote-only mode for the Verified AI Birthcert**, so its price and gas model can be seen without
  starting a session or paying.

### Changed

- **A dry run can no longer issue a credential.** `subscribe_and_issue({ dryRun: true })` now prices
  through an endpoint that cannot issue, and stops before the call that can. Previously, against a
  credential the issuer grants for free, asking what something cost *created it* — a real,
  permanently-registered credential, which also displaced whatever the wallet already held for that
  template. A dry run now signs nothing, issues nothing, and never touches the local credential
  store.
- **A credential that is currently free is no longer reported as unaffordable.** The issuer states
  separately whether a quoted amount will actually be charged; both `credential_preflight` and the
  dry run now read it. When issuance is free, the amount is reported as indicative rather than as a
  charge, and neither the balance nor the spending cap blocks it. Network gas is unaffected and can
  still block, because gas is not the credential fee.
- **Where that answer is unknown it is reported as unknown, never as free** — an older issuer
  deployment does not state it, and treating silence as "free" would under-report a real cost.
- **The default spending cap now permits the credential fee on mainnet**, scoped to credential
  issuance rather than widened generally.
- **Balance reads during a preflight run concurrently**, so the fee balance and the native-gas
  balance arrive together instead of one after the other.

### Fixed

- **The outbound `User-Agent` sent to payment facilitators no longer advertises a non-public
  host.** It is transmitted to third parties on every prepare request; the underlying client
  dependency has been updated to one that reports its public project URL.

## [0.9.2] — 3 September 2026

### Fixed

- **`request_ai_birthcert_verification`'s sponsored-payment path no longer surfaces a facilitator
  insufficient-funds rejection as an opaque, unhandled MCP tool error.** A `461407`
  (`X402_INSUFFICIENT_FUNDS`) rejection from the facilitator's `/prepare` endpoint is now reshaped
  into a clean `{ error }` result naming the asset and amount, instead of falling through every
  error branch and throwing raw.
- **That message now renders amounts in human units, not raw base units.** A raw base-unit count
  next to a token symbol (e.g. "requires 1,000,000 of JMYR") reads as a million *whole* tokens —
  for a 6-decimal asset the actual requirement was 1 JMYR, a 1,000,000x misreading that could lead
  to a drastically oversized top-up. Amounts are now resolved through the same symbol/decimals
  formatter the rest of the wallet already uses.
- **The reported "current balance" is read from the facilitator's structured response field when
  available**, falling back to parsing it out of the free-text error message only for an
  older/unfixed facilitator — the free-text format was never a stable contract between the two
  services.

## [0.9.1] — 28 August 2026

### Fixed

- **`request_ai_birthcert_verification` no longer blocks retrying an expired session.** If the
  owner never completed MyDigital ID verification before a Verified AI Birthcert session's TTL
  elapsed (`status: "expired"`), retrying previously threw an "unrecognized prior session status"
  error and left the flow stuck — even though the settlement receipt was already safely persisted
  locally and unconsumed. Any confirmed terminal session status other than `"issued"` (the only
  status that consumes the receipt) is now treated the same as the existing 404/"gone" handling:
  the receipt is replayed and a fresh verification session is opened, with no new payment made.

## [0.9.0] — 24 August 2026

### Added

- **Paymaster-sponsored gas for `request_ai_birthcert_verification`.** When the resource server
  offers a sponsored payment option (`extra.gasModel: "facilitator"`), the wallet now prefers it by
  default — the ms-zetrix paymaster covers network gas, so a wallet holding the payment token but
  zero ZTX can still complete the flow. Handles the server's asynchronous `202 Accepted` settlement
  response: the wallet retries with the returned payment receipt (never re-sending the original
  payment header) until the settlement confirms or the retry budget is exhausted, without ever
  losing the receipt to a mid-retry crash or transient error.
- **Automatic self-pay fallback.** If sponsorship is refused before any money moved (the
  paymaster pool is exhausted, rate-limited, or the network/asset isn't sponsorable), the wallet
  falls back to self-pay automatically. It never falls back on an indeterminate outcome — a
  payment that may still be settling is never retried as a fresh payment, which would risk paying
  twice.
- **`gasPayer` parameter** on `request_ai_birthcert_verification` (`"sponsored"` | `"self"`) —
  overrides the deployment default for a single call. An unrecognised value is treated as absent
  rather than silently forcing self-pay.
- **`GAS_PREFERENCE`** env var (default `sponsored`) — deployment-wide default gas payer.
- **`MAX_SETTLEMENT_ATTEMPTS`** env var (default `20`) — cap on retry attempts while polling a
  queued sponsored settlement.

### Changed

- Existing self-pay behaviour is unchanged — a resource server that only quotes self-pay (no
  sponsored option) behaves identically to before this release.

## [0.8.1] — 19 August 2026

### Fixed

- **A payment blocked by the spending cap, or rejected for insufficient balance, now names the
  real token and shows a human-readable amount** — e.g. `10000 (0.01 JMYR)` instead of a bare raw
  integer that got mislabeled as ZTX once relayed. Affects `pay_and_fetch`, `subscribe_and_issue`,
  and `request_ai_birthcert_verification`, since all three share the same payment step.
- **A wallet holding a ZTP20 token (e.g. JMYR) but zero ZTX no longer fails with a raw, opaque
  error when trying to pay.** The wallet now checks its own ZTX gas balance before attempting the
  payment and reports a clear "send some ZTX first" message — working around a bug in
  `x402-zetrix-client` where its own gas check runs after an on-chain call that can itself fail
  unhelpfully on a zero-gas account.

### Changed

- The known-but-never-confirmed mainnet SSIVC host is now a named, exported constant
  (`UNVERIFIED_MAINNET_SSIVC_BASE_URL`) instead of only living in a comment — still not wired in by
  default (`SSIVC_BASE_URL` remains the way to enable it on mainnet), but easier to flip on once
  confirmed reachable.

## [0.8.0] — 17 August 2026

### Added

- **`request_ai_birthcert_verification` / `check_ai_birthcert_verification` tools** — a
  **Verified** AI Birthcert flow via myid's SSIVC API, distinct from `subscribe_and_issue`'s
  self-declared **Basic** AI Birthcert. `request_ai_birthcert_verification` starts a session and
  returns a `verificationUrl` for the human owner to complete MyDigital ID verification;
  `check_ai_birthcert_verification` polls that session and, once `status: "issued"`, fetches the
  credential from MBI, verifies its subject against this wallet's `holderDid`, and caches it
  locally (returned as `vc`, and from then on also visible via `wallet_status` and usable by
  `prove_identity`) — a `cacheError` instead of `vc` means the credential was issued but could not
  yet be fetched/verified/cached, which is not the same as issuance failing. Both tools are wired
  whenever `SSIVC_BASE_URL` resolves — always on testnet; on mainnet only once set explicitly,
  since the mainnet host was never actually confirmed reachable. `request_ai_birthcert_verification`'s
  session creation is x402-payment-gated: the tool self-pays myid's 402 challenge, subject to the
  wallet's `MAX_PAYMENT_AMOUNT` cap, the same as `pay_and_fetch`/`subscribe_and_issue`. A session
  that goes terminal without minting a credential (owner never verifies, verification fails, etc.)
  can be retried without paying again, since the payment stays valid until actually consumed —
  concurrent requests are serialized so this can't double-pay, and switching to a different agent
  name while a session is still pending is refused rather than silently losing track of it. New env
  vars: `SSIVC_BASE_URL` (auto-derived on testnet only — `ssivc-api-uat.myegdev.com/api`; unset on
  mainnet unless overridden) and `AI_BIRTHCERT_VERIFIED_TEMPLATE_ID` (same pattern — testnet only,
  since the mainnet template id was never confirmed on-chain).

### Fixed

- **A malformed or unexpectedly-shaped response from MBI's credential-download endpoint no longer
  crashes `check_ai_birthcert_verification` with a raw, undiagnosable error.** Found via live
  testing against a real verification flow: MBI's response envelope turned out to be nested one
  level deeper than expected. Both the crash and the actual envelope shape are now handled
  correctly, confirmed end-to-end against a live credential issuance.
- **A downloaded-but-not-yet-cached credential is no longer lost if it fails validation or the
  process crashes before caching.** MBI's download is one-shot — a second attempt just fails — so
  the raw response is now persisted immediately on arrival and re-validated from that copy on any
  retry, instead of being discarded the moment a check (subject match, expiry) rejects it.
- Fixed several smaller gaps found in the same review: an already-settled payment blob and an empty
  payment-options response now return a clean error instead of an unhandled exception; a 409 with a
  non-JSON body still reports the right error kind; an unrecognized session status is no longer
  assumed safe to retry against; and switching agents no longer risks silently overwriting another
  agent's still-unresolved payment.

## [0.7.0] — 4 August 2026

**Read the breaking change before upgrading if you make x402 payments.** This release lets the wallet
provision itself, so it can start with no configuration at all — which is what makes an OpenClaw plugin
install possible, and also why the payment cap now has to default to zero.

### Changed (breaking)

- **`MAX_PAYMENT_AMOUNT` now defaults to `{"*":"0"}` instead of being unset.** An unconfigured wallet
  refuses every x402 payment rather than allowing any amount. Previously an unset cap disabled the
  ceiling entirely, which was defensible only while every install required hand-written environment
  variables; a wallet that can now start with no configuration must not be able to auto-pay a hostile
  challenge. To keep paying, set the cap explicitly, e.g.
  `MAX_PAYMENT_AMOUNT={"ZTX":"1000000000","*":"0"}`.

- **`create_holder_account` no longer takes a `password` parameter.** The wallet uses the password
  already active for the session, so a model can neither be asked for one nor supply one. A
  `password` still passed by an old caller is **silently ignored** rather than rejected, because the
  tool schema permits extra properties. Consequence: a newly minted account now inherits the session
  password instead of taking a different one.

### Added

- **The wallet provisions itself.** `HSM_PASSWORD` and `ZETRIX_NETWORK` are both optional now.
  With neither set, the wallet defaults to testnet, generates a random HSM password, creates a
  holder account, and stores address, DID and password in its own state directory — so it starts
  with no configuration at all. An explicit env var still wins over every other source, so an
  existing `.mcp.json` behaves exactly as before.
- **`npx agentic-wallet-mcp export-credentials`** prints the address, DID and HSM password for
  backup. A generated password is the only thing that can authorize signing for the account, so
  losing the state directory means losing the account. Interactive terminals only, and deliberately
  not an MCP tool, so an agent can never read it.
- **`--config <path>`** reads settings from a JSON file instead of the environment, for hosts that
  cannot set env vars. It carries no secret: a `hsmPassword` key is a hard error, and so is any
  unknown key, so a typo cannot silently start the wallet on the wrong network.
- **`ZETRIX_WALLET_STATE_DIR`** moves `account.json` and the VC cache out of the home directory.
  The default is unchanged.
- `pay_and_fetch` and `subscribe_and_issue` now report a `not_activated` shortfall when the holder
  address is not yet on chain, instead of reporting it as a low balance — the remedy is to send it
  gas, not to top up a token.

### Fixed

- **A zero ZTX balance no longer reports `query_failed`.** The node omits the `balance` field
  entirely when it is zero, and `wallet_status({ token: "ZTX" })` treated its absence as a failed
  read — so every account holding no ZTX looked like a broken lookup. A successful RPC that omits a
  zero-valued field is now read as `0`. A non-zero `errorCode`, or a response with no `result` at
  all, still fails loudly rather than reporting a fabricated zero.

## [0.6.1] — 2026-07-29

**Upgrade if you use testnet.** The testnet Wallet BE and MBI endpoints have moved to the Zetrix
sandbox hosts. No API, tool or config surface changed — this is an endpoint migration only.

### Changed

- **Testnet default endpoints moved to the Zetrix sandbox hosts.** `ZETRIX_NETWORK=zetrix:testnet`
  now derives `https://wallet-api-sandbox.zetrix.com/server` (was
  `https://wallet-api.myegdev.com/server`) and `https://mbi-vc-sandbox.zetrix.com` (was
  `https://mbi-vc.myegdev.com`). Anyone on testnet relying on the built-in defaults should upgrade
  to follow the platform; mainnet defaults are unchanged, and an explicit `WALLET_BE_URL` /
  `MBI_BASE_URL` still wins over the network default, so anyone pinning those is unaffected.
  Note the Wallet BE base keeps its `/server` path suffix — verified against the new host, which
  returns nginx `404` without it.

## [0.6.0] — 2026-07-28

This release is about the wallet never misstating what a call cost. Four reporting defects were
found during live use, in each case the wallet told the caller something untrue about money.

### Changed — BREAKING

- **`amountPaid` is now `undefined` on a cache hit.** Previously a cache hit replayed the original
  issuance's `txHash`/`paidAsset`/`amountPaid` at the top level, so a **free** call was
  indistinguishable from a fresh charge and anything summing `amountPaid` across calls
  double-counted. Those values now appear under `originalPayment: { txHash, asset, amount }`
  instead, and are omitted entirely when the cached credential was issued free. Any consumer
  reading top-level `amountPaid` to track spend needs updating.

### Added

- **`get_template_schema` tool** — a free read of a credential template's declared attribute
  schema (`{ required, optional }`), taking a `did:zid:...` id or a known template name. No
  payment, no signing, no issuer call. Previously the only way to ask what a template required was
  `subscribe_and_issue` with `dryRun` — a tool whose name reads as "this charges money" — so an
  agent had no obvious reason to reach for it and would discover a newly-required attribute by
  failing an issuance first. A template that cannot be read returns `{ error }` rather than an
  empty schema, so "needs nothing" is never confused with "could not look it up".
- **`staleAttributes` on a cache hit** — `{ missing, dropped }` when a held credential no longer
  matches the template it came from. Validity checks only ever asked whether a credential had
  expired, never whether its fields still fit the template, so an issuer changing a template left
  holders with a credential that looked valid and wasn't. The cached credential is still returned;
  this reports, it does not re-issue or charge.
- **`decimals` on `wallet_status({ token })`** — the raw base-unit balance stays canonical (it is
  the unit x402 quotes `maxAmountRequired` in, so cap checks and comparisons remain integer-only),
  but callers no longer need a second contract call to know whether `"473999900"` means 474 or
  474 million.
- **`paymentAttempted: { asset, amount, paymentId }`** on any failure occurring after the x402
  payment has settled on chain. The issuer's error body carries neither the amount nor a
  transaction reference, so such a debit was previously invisible in the response and discoverable
  only by comparing `balanceOf` before and after. `paymentId` is the handle the issuer's idempotent
  recovery endpoint takes.
- **Indeterminate-settlement recovery.** The issuer distinguishes a definitive facilitator
  rejection from an outcome that is *unknown* — where the payment may well have landed and the
  record is deliberately left recoverable. On the indeterminate code the wallet now polls the
  issuer's status endpoint (bounded) and reports `recovery: { status, txHash?, vcId?, polls }`,
  rather than discarding a credential already paid for. `status: "ISSUED"` means it exists after
  all; note the status endpoint returns only its id, not the credential body.
- **`MbiError.mbiStatus`** — the issuer's own numeric status code, parsed from the error body.
  Previously only the HTTP status and an opaque message string were available, so the two
  post-payment failures could be told apart only by substring-matching or by trusting an HTTP 502
  that any gateway can emit.
- **Explicit HTTP deadline** on the issuer client (90s, overridable), above the issuer's own 60s
  facilitator timeout. Previously the runtime default applied, which happened to be longer but was
  not a deliberate choice — a deadline at or below the issuer's would abort a settlement still
  legitimately in progress.

### Fixed

- **Failed balance lookups no longer report a fabricated zero.** Any failure — non-zero
  `errorCode`, missing field, malformed payload — previously collapsed to `{ balance: '0' }`,
  making an unreachable node indistinguishable from an empty wallet. Worse, because the
  underlying helpers returned *normally*, a caller's `try`/`catch` never fired. Now surfaced as
  `{ error: 'query_failed' }`. Both the ZTP20 and the native ZTX path had the same defect; both
  are fixed.
- `originalPayment` is omitted for a cached credential that was issued free, rather than reported
  as `{ asset: 'none', amount: '0' }` — matching the documented behaviour.

### Documentation

- `query_contract` documented for the first time. It shipped in 0.5.0 but was never added to the
  tool list. The documentation now also states plainly that it is a pass-through with no ABI or
  method list — the contract decides what it understands, and an unknown method returns the same
  shape as a typo.
- The `subscribe_and_issue` description previously claimed `schema` is returned on *every*
  response; the cache path returns before the chain lookup, so it never did. Corrected, and the
  cache path now performs the lookup so the claim holds.

## [0.5.0] — 2026-07-27

### Added

- Wallet BE account-activation checking: `activated`/`activationTxHash` fields,
  `checkActivationStatus`, a bounded `waitForActivation` polling helper, and polling wired into
  both first-run account creation and `create_holder_account`.
- x402 payment readiness — `pay_and_fetch` and `subscribe_and_issue` surface an insufficient-funds
  shortfall as a structured result instead of throwing.
- Per-network JMYR token registry (`resolveTokenAddress`) and token-balance lookup on
  `wallet_status`.
- `query_contract` — general-purpose read-only contract/account query, exposed as an agent tool.
- Template attribute validation and derivation, with the full declared schema surfaced.

### Fixed

- A `resolveHolder` polling failure degrades instead of crashing startup.
- The `hsmPassword` is persisted alongside address/DID on account override, not dropped.

## [0.4.0] — 2026-07-24

### Added

- Local cache of issued credentials, keyed by template, so `subscribe_and_issue` does not pay and
  re-issue for a credential already held.
- Named-template alias resolution (e.g. `"AI Birthcert"`), and an `agentDid` auto-fill gated on the
  template's declared schema.

### Fixed

- `revealAttributes` ordering to match the credential's signed field order, which was breaking BBS+
  presentation verification.
- Free-template synchronous issuance handled in the issuer's phase 1.

## [0.3.0] — 0.3.1

### Added

- Live x401 proof integration: OID4VP submit authentication, DCQL reveal mapping, and an issuer-key
  override for when the resolver is unreachable.
- Integration guide, presentation-submission fix, and the switch to the published
  `x401-zetrix-client` package.

## [0.2.0]

### Added

- Optional `ZETRIX_ADDRESS`/`HOLDER_DID` onboarding, with `HSM_PASSWORD` guaranteed present.
- x402 asset symbol resolved from a ZTP20 contract's `contractInfo`.

## [0.1.0]

Initial release — the five agent-facing tools (`wallet_status`, `prove_identity`, `pay_and_fetch`,
`subscribe_and_issue`, `create_holder_account`) over x401, x402, and issuer-side credential
issuance, with all signing through Wallet BE's HSM.
