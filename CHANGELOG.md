# Changelog

All notable changes to `agentic-wallet-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Entries for 0.5.0 and earlier were reconstructed from commit history when this file was
> introduced in 0.6.0, so they summarise each release rather than being exhaustive.

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
