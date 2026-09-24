/**
 * THE REVIEWED TEXT OF EVERY AGENT-FACING STRING THIS MCP SHIPS.
 *
 * Every tool's top-level `description` and every `inputSchema` property description in
 * `buildToolList()`, split into sentences. A host LLM reads all of it and spends the user's money
 * according to what it says, so this file is the structural backstop that makes a change to any of
 * it a REVIEWED change rather than an incidental one (R11-M02). It lives beside the suite rather
 * than inside `tool-registration.test.ts` only for size: the assertions, and the semantic guards
 * that explain WHY a sentence would be unsafe, are all in that test.
 *
 * WHEN A SNAPSHOT TEST FAILS AFTER A DELIBERATE EDIT, do not paste the new text in and move on.
 * Re-run the semantic guards' REASONING over every changed sentence first:
 *   - no path may say the fee WAS taken, or was NOT taken, where it cannot know (SPEC.md §6,
 *     REQ-19e/f);
 *   - no branch where money may have moved may carry a retry endorsement;
 *   - no indeterminate state may be described as progressing, queued, or succeeded (SPEC.md
 *     REQ-19b as amended in R11-M03).
 * Only then update the entry here.
 *
 * Generated once from the implementation and reviewed by hand; regenerating it blindly defeats its
 * entire purpose.
 */
export const EXPECTED_AGENT_TEXT: Record<string, Record<string, readonly string[]>> = {
  "wallet_status": {
    "description": [
      "Report the holder DID/address/network and the client-supplied held credentials.",
    ],
    "inputSchema.properties.heldCredentials.description": [
      "VCs the client holds.",
      "Omit to report whatever the wallet has cached locally from prior subscribe_and_issue calls instead.",
    ],
    "inputSchema.properties.token.description": [
      "Optional token symbol (e.g. \"ZTX\", \"JMYR\") OR a ZTP20 contract address, to check its balance for the active network alongside the usual status fields.",
      "Returns { balance, decimals, display } — `balance` is in the asset's raw base units and `display` is the same amount in whole tokens with its symbol (e.g. balance \"473999900\", decimals 6, display \"473.9999 JMYR\").",
      "Quote a `display` value to the user, never a bare `balance`.",
      "A failed lookup reports { error: \"query_failed\" } rather than a zero balance; an unrecognised name reports { error: \"unknown_token\" }.",
    ],
    "inputSchema.properties.tokens.description": [
      "Several tokens (symbols and/or ZTP20 contract addresses) in one call, returned as `tokenBalances` in the order asked.",
      "Prefer this over repeated single-token calls when checking affordability: a credential fee and the native ZTX needed for gas are separate balances, and asking one at a time is how \"you hold the token but no gas\" is discovered only after the first shortfall was already fixed.",
      "Each entry carries its own result or error, so one failure does not hide the rest.",
    ],
  },
  "prove_identity": {
    "description": [
      "Answer an x401 PROOF-REQUEST and return the PROOF-RESPONSE header to replay to the resource server.",
    ],
    "inputSchema.properties.proofRequest.description": [
      "The PROOF-REQUEST header value from the 401 challenge.",
    ],
    "inputSchema.properties.vc.description": [
      "The VerifiableCredential to present.",
      "Omit to use the wallet's single locally-cached credential, if there is exactly one — the call fails with a clear error if none or several are cached.",
    ],
    "inputSchema.properties.revealAttribute.description": [
      "Dotted disclosure paths to reveal.",
      "Omit to reveal exactly the claims the challenge (DCQL) requests; a challenge naming no claims reveals all.",
    ],
    "inputSchema.properties.issuerKeys.description": [
      "Optional issuer verification keys to bypass the ZID resolver when it is unreachable (e.g. Cloudflare-gated).",
      "When set, resolution is skipped.",
    ],
    "inputSchema.properties.issuerKeys.properties.bbsPublicKey.description": [
      "Issuer's BBS+ publicKeyMultibase (matches the VC's BbsBlsSignature2020 proof).",
    ],
    "inputSchema.properties.issuerKeys.properties.ed25519PublicKey.description": [
      "Issuer's Ed25519 publicKeyHex (matches the VC's Ed25519Signature2020 proof).",
    ],
  },
  "pay_and_fetch": {
    "description": [
      "Fetch a URL, auto-paying with x402 (self-pay via Wallet BE) if the server returns 402.",
      "The asset charged is whatever the server's 402 challenge demands — the native ZETRIX token or a ZTP20 token (e.g. JMYR) — never assume it's ZETRIX; the result's `asset` field reports what was actually paid.",
    ],
  },
  "get_template_schema": {
    "description": [
      "Read a VC template's declared attribute schema from chain — FREE, no payment, no signing, no MBI issuance.",
      "Call this BEFORE subscribe_and_issue to find out which attributes a template requires, rather than discovering a missing one by attempting an issuance and being rejected.",
      "Accepts a did:zid:... credential-definition id or a known template name (e.g. \"AI Birthcert\").",
      "Returns { templateId, schema: { required, optional } }; attributes the wallet fills in itself (agentDid, alias-derived keys) are omitted since you never supply them.",
      "A template that cannot be read reports { error } rather than an empty schema, so \"needs nothing\" is never confused with \"could not look it up\".",
    ],
    "inputSchema.properties.templateId.description": [
      "The MBI credential-definition id (did:zid:...) or a known template name, e.g. \"AI Birthcert\".",
    ],
  },
  "get_policy_template_schema": {
    "description": [
      "Read a POLICY template's declared attribute vocabulary from chain — FREE, no payment, no signing.",
      "This is the only vocabulary that means anything on chain: the policy contract validates nothing, so an attribute name outside this list deploys cleanly and then enforces nothing at all.",
      "Accepts either { publisher, policyKey } or { templateId }.",
      "A template that cannot be read reports { error } rather than { found: false }, so \"no such template\" is never confused with \"could not look it up\".",
    ],
    "inputSchema.properties.templateId.description": [
      "Template id, as it appears inside a deployed policy.",
    ],
    "inputSchema.properties.publisher.description": [
      "Publisher address.",
      "Use together with policyKey.",
    ],
    "inputSchema.properties.policyKey.description": [
      "Policy key.",
      "Use together with publisher.",
    ],
  },
  "get_my_policy": {
    "description": [
      "Read the spending policies this owner has deployed on chain — FREE, no payment, no signing.",
      "Defaults to this wallet's own address.",
      "Costs 2 + N chain calls and warns above 50 keys.",
      "An owner who has never deployed a policy is reported as a normal absence, NOT an error — the policy contract is created lazily on first write.",
      "A failed lookup keeps its own error state, so \"we could not list your policies\" is never presented as \"you have none\".",
    ],
    "inputSchema.properties.owner.description": [
      "Owner address.",
      "Defaults to this wallet's configured address.",
    ],
  },
  "policy_preflight": {
    "description": [
      "Check a draft policy BEFORE it is deployed — FREE, no payment, no signing.",
      "It answers two questions.",
      "First, is the draft well-formed: every blocker is returned at once in `blockers`, so one round of fixes is enough rather than discovering them one failure at a time.",
      "Second, and more important, does the policy MEAN what the user thinks: `interpretation` states in plain words what it actually does.",
      "ALWAYS show `interpretation` to the user, INCLUDING when ready is true — a policy can be perfectly valid and still mean something other than what was intended (a spending cap with no window is a LIFETIME cap, not a monthly one), and reporting only \"ready\" hides exactly that.",
      "A clean result is NOT a guarantee: `notChecked` lists what could not be verified, including whether the policy will be enforced at all and whether a payment would currently be allowed.",
    ],
    "inputSchema.properties.policyKey.description": [
      "The key this policy would be stored under.",
    ],
    "inputSchema.properties.attributes.description": [
      "The draft rules — one { attributeName, attributeType, value } per rule.",
    ],
    "inputSchema.properties.validFromBlock.description": [
      "Block this policy starts at, written as a string.",
    ],
    "inputSchema.properties.validToBlock.description": [
      "Block it ends at, as a string.",
      "\"0\" means no end.",
    ],
    "inputSchema.properties.templateId.description": [
      "Template id.",
      "Supply this OR publisher + policyKey.",
    ],
    "inputSchema.properties.publisher.description": [
      "Publisher address, used together with policyKey.",
    ],
  },
  "query_contract": {
    "description": [
      "Read-only query against a Zetrix contract or account — call an arbitrary contract method (e.g. \"balanceOf\", \"contractInfo\") and return its raw result.",
      "No signing, no state change.",
    ],
    "inputSchema.properties.contractAddress.description": [
      "Zetrix contract address to query.",
    ],
    "inputSchema.properties.method.description": [
      "Contract method name, e.g. \"balanceOf\", \"contractInfo\".",
    ],
    "inputSchema.properties.params.description": [
      "Method parameters, e.g. { \"address\": \"ZTX...\" } for balanceOf.",
    ],
  },
  "subscribe_and_issue": {
    "description": [
      "Obtain a VC from MBI: build the signed payload, pay x402, and return the issued credential.",
      "If a still-valid credential for this templateId is already cached locally, it is returned directly with no payment (fromCache: true) — pass forceReissue:true to pay and issue fresh regardless.",
      "Payment is asset-agnostic — MBI's 402 challenge may quote the native ZETRIX token or a ZTP20 token (e.g. JMYR); pass dryRun:true first to see the quoted asset/amount for free before committing to pay.",
      "What a call actually cost is reported precisely: paidAsset/amountPaid are set ONLY when this call paid, a cache hit reports the earlier charge under originalPayment instead (never as amountPaid, so summing spend cannot double-count), and any failure after the payment has settled on chain reports paymentAttempted: { asset, amount, paymentId }.",
      "Two such failures exist and mean different things: MBI 4006 is a definitive facilitator rejection, while 4012 (HTTP 502) means the outcome is INDETERMINATE — the payment may well have landed.",
      "On 4012 the wallet automatically polls MBI's recovery endpoint and reports recovery: { status, txHash?, vcId?, polls }, where status is ISSUED (the credential exists after all — fetch it by vcId, since recovery returns no VC body), FAILED, or REQUIRED/SETTLED (still unresolved) / UNKNOWN (recovery itself unreachable).",
      "NEVER retry a payment after either failure: the funds may already be gone, and a retry charges the full amount again — look the paymentId up instead.",
      "Every response except a cache hit also includes { schema: { required, optional } } — the template's full declared attribute schema read from chain — so you see the complete field list, not just what went wrong; a cache hit skips the chain lookup and omits it.",
      "For the AI Birthcert specifically: this issues the BASIC one — self-declared by the agent, agent-paid via x402, owner identity NOT identity-verified.",
      "If the user asked for a \"verified\" AI birthcert (owner identity confirmed via MyDigital ID), use request_ai_birthcert_verification instead — this tool cannot produce that credential.",
    ],
    "inputSchema.properties.templateId.description": [
      "The MBI credential-definition id to issue, e.g. \"did:zid:...\".",
      "Take this from the x401 challenge's credential_requirements.query.credentials[].id — NOT from requirementsId (that's just a label for the requirement set, e.g. \"agent-identity\").",
      "A known template's natural-language name (e.g. \"AI Birthcert\") is also accepted and resolved to the right did:zid:... for the configured network.",
      "This resolves to the BASIC (self-declared, non-verified) template — for the Verified AI Birthcert, use request_ai_birthcert_verification, not this tool.",
    ],
    "inputSchema.properties.attributes.description": [
      "Claim values for the credential (schema varies by template — check what the issuer requires before guessing).",
      "\"agentDid\" does not need to be supplied: it is auto-filled with this wallet's own holder DID (the credential's self-referential subject) unless you explicitly override it.",
    ],
    "inputSchema.properties.dryRun.description": [
      "Price the credential without paying, signing, or issuing anything.",
      "Returns { quote: { asset, maxAmountRequired, payTo, gasModel, paymentRequired?",
      "}, schema: { required, optional } }.",
      "Priced via MBI's /quote endpoint, which cannot issue — so this is safe even on a template that issues for free (such a template mints synchronously on the real path, which is why pricing never goes through it).",
      "Never writes the VC cache, so it cannot displace a credential you already hold.",
      "`quote.paymentRequired` is the authoritative free-vs-paid answer: false means issuance is currently free and `maxAmountRequired` will not be charged.",
      "When the field is ABSENT the MBI predates it and the amount is unconfirmed — report it as a possible charge, never as certainly free.",
      "Still validates required attributes locally first — a missing one blocks before any MBI call.",
    ],
    "inputSchema.properties.forceReissue.description": [
      "Skip the local cache and pay + issue a fresh credential regardless of what is already cached.",
    ],
  },
  "request_ai_birthcert_verification": {
    "description": [
      "Start a Verified AI Birthcert issuance session with myid (MyDigital ID owner verification).",
      "ALWAYS run credential_preflight for \"verified_ai_birthcert\" immediately before calling this, even if you checked earlier in the conversation — preflight is free, this tool spends real funds, and a balance the user topped up a minute ago is not the balance you read before that.",
      "Returns { sessionId, verificationUrl, expiresAt, expiresIn, expiresInSeconds } — show verificationUrl to the human owner and ask them to open it and complete MyDigital ID verification (typically finishes in seconds).",
      "Tell them how long the link is good for by quoting `expiresIn` exactly as given: the wallet works it out from its own clock, so never calculate the time remaining yourself from `expiresAt` — your clock and timezone may differ from the server's.",
      "Once they confirm they are done, call check_ai_birthcert_verification to see whether the credential was issued.",
      "IMPORTANT: agentName must be unique — if this exact name has already been used to request a Verified AI Birthcert, issuance will fail.",
      "Before calling, ask the human owner whether they want to supply any of the optional fields — agentPurpose, evidenceAssuranceLevel, ownerType, ownerVerified — do not silently omit them; they only need to say no.",
      "Calling this again with the SAME agentName while a prior session is still pending returns that same session unchanged — no new session is started and nothing is paid again.",
      "This tool spends real funds: it self-pays an x402 challenge, subject to the same credential-issuance payment cap as subscribe_and_issue — a separate, narrower cap than pay_and_fetch's, which defaults to refusing everything on mainnet.",
      "Set MAX_PAYMENT_AMOUNT to override either.",
      "It can return { error: \"...\" } instead of a session.",
      "Read `message` before deciding what to tell the user or whether retrying is safe — it does NOT always mean nothing was paid.",
      "For insufficient funds or a payment-cap block specifically, nothing is created and nothing was paid, so once the underlying problem is fixed (e.g. the user tops up), calling this tool again is the right next step.",
      "Several OTHER { error } shapes mean the opposite: a payment may already have been sent on a prior or even this call (blob_already_settled, a receipt that could not be saved locally, RECEIPT VOID, OUTCOME UNKNOWN) — for any of those, calling this tool again pays the fee AGAIN, so do NOT retry without explicit agreement from the user, exactly as `message` itself will say.",
      "It can also return { settlementPending: true, paymentReceipt, message } instead — a payment WAS SENT and no session exists yet.",
      "That is NOT a failure and NOT an error, but do NOT pay again and do NOT call this tool again to retry it — call check_ai_birthcert_verification to follow it through instead.",
      "It covers three different situations, told apart by the `issuerRejected` and `paymentInvalid` fields.",
      "With neither set, do NOT assume the payment is known to have succeeded — this shape covers TWO different states that look identical from these fields alone: usually the settlement is genuinely still clearing (the message says \"still being processed\"), but sometimes the outcome could not be determined at all yet (the message says \"has not been confirmed yet\" and does not say \"still being processed\") — an indeterminate state, not a confirmed one, even though neither flag is set.",
      "Either way the receipt is saved and you must not pay again, so report it as \"payment sent, still settling\" without promising the user it definitely succeeded.",
      "When the message contains a \"Tell the user:\" sentence, relay that sentence rather than composing your own reassurance, and if asked what the service said, quote only what the message says it answered.",
      "With issuerRejected: true the credential service was reached and refused the request — the settlement is NOT what failed, but do NOT describe this as the payment having succeeded either: `message` quotes its reason, and you must relay that reason rather than describing it as still settling or as a success.",
      "With paymentInvalid: true the service has specifically ruled the payment or receipt invalid — do NOT say \"the settlement is not what failed\" for this one, since this verdict IS about the payment; relay what it said instead, and do NOT describe it as a success either.",
      "Neither this case nor issuerRejected tells you whether the fee was taken, in either direction — never tell the user they were not charged, and just as much, never tell them they WERE charged either.",
      "That no-claim rule covers issuerRejected and paymentInvalid specifically.",
      "The plain no-flag case above is different again, and NOT simply \"known to have succeeded\" either — see the note on it above: it is two states, only one of which is confirmed, so read `message` there too rather than assuming success from the shape alone.",
      "If the user did NOT ask for a \"verified\" credential specifically, they most likely want the self-declared, non-verified Basic AI Birthcert instead — use subscribe_and_issue for that.",
    ],
    "inputSchema.properties.agentName.description": [
      "A unique, human-readable name for this agent.",
      "Must not already be in use for a Verified AI Birthcert, or issuance will fail.",
    ],
    "inputSchema.properties.agentPurpose.description": [
      "Optional — what this agent does, e.g. \"Negotiate and settle supplier invoices\".",
    ],
    "inputSchema.properties.evidenceAssuranceLevel.description": [
      "Optional — assurance level of the identity evidence, e.g. \"high\".",
    ],
    "inputSchema.properties.ownerType.description": [
      "Optional — the owner's type, e.g. \"Individual\".",
    ],
    "inputSchema.properties.ownerVerified.description": [
      "Optional — whether the owner is already verified, as the string \"true\" or \"false\".",
    ],
    "inputSchema.properties.gasPayer.description": [
      "Who pays network gas.",
      "\"sponsored\" (default) asks the platform paymaster to cover gas, so this wallet needs no ZTX.",
      "\"self\" pays gas from this wallet's own ZTX balance.",
      "Omit to use the configured default.",
    ],
    "inputSchema.properties.dryRun.description": [
      "Ask the price WITHOUT paying.",
      "Returns { quote: { asset, maxAmountRequired, payTo, gasModel } } and spends nothing, creates no session, and starts no verification — so you can tell the user the cost before collecting anything.",
      "`maxAmountRequired` is in the asset's RAW base units; resolve decimals (wallet_status returns `display`) before quoting a figure to a human.",
      "A quote does NOT reserve the name and does NOT check whether it is already taken — myid checks uniqueness only at issuance, so a name already in use still quotes cleanly.",
      "`agentName` is still required because the server rejects a request without one, but the fee does not depend on it.",
    ],
    "inputSchema.properties.discardStuckReceiptAndPayFresh.description": [
      "DESTRUCTIVE, and it SPENDS.",
      "Only for a payment that is genuinely stuck (outcome still unresolved).",
      "While the wallet holds a stuck receipt this tool can only replay it — it will never buy a new credential — so this is the way to start over: it throws that payment away and pays a SECOND fee.",
      "Not needed for a VOID receipt (settlement ruled expired/failed): the wallet discards that one itself, with no flag and no confirmation, so the next call is already an ordinary fresh purchase.",
      "Pass the stuck receipt id EXACTLY as check_ai_birthcert_verification or clear_stuck_payment_receipt reported it — never a guess, never true.",
      "A mismatched id discards nothing and pays nothing.",
      "Before using it, show the user the receipt id, tell them the first payment is forfeit and that this costs the fee again, and get their explicit agreement.",
      "If the receipt turns out to belong to a live session this is refused: that session is already paid for, so call check_ai_birthcert_verification instead.",
      "Normally the result carries the id you confirmed as discardedPaymentReceipt — keep it, support needs it to trace the lost payment.",
      "But if this call ALSO threw away a void receipt of its own (the fresh payment it just made was then ruled void), discardedPaymentReceipt holds THAT receipt instead, and the id the user confirmed is named at the end of the error text (\"ALSO DISCARDED earlier on this same call\") — so on that path quote BOTH ids to support, not just the field.",
      "A receipt only counts as stuck once it is older than SETTLEMENT_STUCK_AFTER_MS (24h by default, e.g. SETTLEMENT_STUCK_AFTER_MS=3600000 for one hour); before that the wallet REFUSES this parameter outright — nothing is discarded and nothing is paid — so do not offer the user this option for a receipt that is not stuck yet.",
      "A bare \"retry\" or \"yes\" from the user is not agreement to pay again.",
    ],
  },
  "credential_preflight": {
    "description": [
      "FREE readiness check — call this FIRST, before collecting ANY application detail from the user, whenever they ask for a credential.",
      "Spends nothing, signs no transaction, creates no session.",
      "Returns { ready, fee, balances, cap, schema?, blockers, notChecked }: the live fee and which side pays gas, the balances that matter, whether the spending limit permits it, and — for a template credential — the attributes it requires.",
      "`blockers` lists EVERY reason it is not ready at once (a low balance and a too-low spending limit are different problems and both appear together), so one round of fixes is enough rather than discovering them one failed payment at a time.",
      "ALWAYS relay `notChecked` too: a clean result is not a guarantee.",
      "In particular it does NOT check whether an agent name is free — myid decides that at issuance, after payment.",
      "Report `fee.display` and each balance's `display` to the user, never the raw base-unit numbers.",
      "`fee.paymentRequired: false` means issuance is currently FREE — `fee.display` is then only what it WOULD cost if payment were switched back on, so do not ask the user to fund it and do not present that amount as a charge.",
      "Gas is separate and can still block a free credential.",
      "When the field is ABSENT the cost is unknown (an older MBI), and it is treated as chargeable — never report absent as free.",
    ],
    "inputSchema.properties.credential.description": [
      "Which credential to price: \"verified_ai_birthcert\" for the MyDigital-ID-verified AI Birthcert, or a template id (did:zid:...) / known template name (e.g. \"AI Birthcert\") for a template-issued one.",
    ],
    "inputSchema.properties.agentName.description": [
      "Optional, and only used for \"verified_ai_birthcert\".",
      "The fee does not depend on it, so omit it when pricing before the user has chosen a name — the wallet substitutes a placeholder purely to satisfy the server.",
      "Never present that placeholder as the name that will be used.",
    ],
  },
  "check_ai_birthcert_verification": {
    "description": [
      "Check the status of the most recently requested Verified AI Birthcert session (see request_ai_birthcert_verification).",
      "FREE — it never pays for anything.",
      "Use this, not request_ai_birthcert_verification, whenever the user asks where their verification link is, what happened to their session, or whether their credential is ready.",
      "While the session is still open the result carries `verificationUrl` (the same link issued at creation) and `expiresAt` and `expiresIn` — give the user the link and `expiresIn` exactly as given, so they know how long it is good for; never work out the time remaining yourself from `expiresAt`, because your clock and timezone may differ from the server's.",
      "Returns { status: \"pending\" } while the owner has not yet completed MyDigital ID verification, or { status: \"issued\", vcId } once myid has minted the credential — myid returns vcId ONLY when status is \"issued\", never otherwise.",
      "On { status: \"issued\" }, the wallet also fetches the credential from MBI, verifies it, and caches it locally, returning it as `vc` — it is then also visible via wallet_status and usable by prove_identity without any further call.",
      "If `cacheError` is present instead of `vc`, the credential WAS issued successfully but could not be fetched/verified/cached yet (e.g. a transient MBI error) — this is NOT the same as issuance failing, so do not retry request_ai_birthcert_verification; call check_ai_birthcert_verification again instead.",
      "Returns { status: \"no_session\" } if request_ai_birthcert_verification has never been called.",
      "If a previous payment is still clearing, this tool ACTIVELY ADVANCES it — so in that one case it can take up to ~90s to return (it is waiting on the settlement, not hung; every other case returns immediately).",
      "It replays the saved receipt (never a new payment) and returns the live session once it settles, so telling the user to check back here genuinely moves things forward.",
      "While it is still clearing you get { status: \"settlement_pending\", paymentReceipt, message }: a payment HAS been made, so never call request_ai_birthcert_verification and never tell the user it failed.",
      "With issuerRejected: true (message leads \"PAYMENT SENT, BUT THE CREDENTIAL SERVICE REFUSED THE REQUEST\") the credential service was reached and refused the request, and message quotes what it said — relay that reason to the user and tell them the verification service is not completing requests right now.",
      "Do NOT describe it as a settlement still processing: the settlement is not what failed.",
      "The receipt is kept and no new payment was made, so it is worth checking again later — an outage on their side can clear.",
      "This says NOTHING about whether the fee was taken, so never tell the user they were not charged.",
      "With paymentInvalid: true (message leads \"PAYMENT SENT, BUT THE CREDENTIAL SERVICE SAYS THIS PAYMENT DID NOT VALIDATE\") the service has specifically ruled the payment or receipt invalid — different from issuerRejected: do NOT say \"the settlement is not what failed\" here, because this verdict IS about the payment.",
      "Relay what the service said, but this one says NOTHING about whether the fee was taken in EITHER direction — never tell the user they were not charged, and just as much, never tell them they WERE charged either.",
      "Do not pay again either way.",
      "stuckFor may appear alongside EITHER issuerRejected or paymentInvalid (the receipt happens to also be old) — it is just context on how long this has been retried, not a reason to change any of the advice above for either case.",
      "Otherwise, outcomeUnknown tells the remaining cases apart, and without it the message splits again.",
      "Without outcomeUnknown the message leads \"PAYMENT SENT\", and that shape is TWO different states you tell apart by the clause that follows.",
      "If it says \"still being processed\" the settlement is confirmed queued and progressing — check again in a few minutes.",
      "If it says \"has not been confirmed yet\" the outcome could not be determined at all yet: do NOT describe that one as progressing and do NOT describe it as succeeded, because it is indeterminate, not confirmed.",
      "Either way the receipt is saved, so do not pay again, and check again later.",
      "When the message contains a \"Tell the user:\" sentence, relay it rather than composing your own reassurance.",
      "With outcomeUnknown: true (message leads \"OUTCOME UNKNOWN\") the settlement outcome could not be determined at all and has been unresolved long enough that it is not coming back (stuckFor says how long).",
      "The fee was most likely ALREADY TAKEN and no credential was issued — say that plainly rather than implying it may still land.",
      "do not just tell the user to wait; give them the paymentReceipt and tell them to quote it to support.",
      "Quote paymentReceipt to support in either case if they ask.",
      "Separately, { status: \"receipt_void\" } is TERMINAL: the payment service has ruled that this receipt is finished (it expired, or the settlement failed), so checking again cannot help and no credential will come from it.",
      "That does NOT mean the fee was refunded — never tell the user they were not charged; give them paymentReceipt for support.",
      "The wallet has already DISCARDED the dead receipt, so nothing is blocking a new purchase: if the user wants the credential, call request_ai_birthcert_verification again and it pays normally.",
      "That is the fee AGAIN, so ask them first rather than calling it on their behalf.",
    ],
  },
  "clear_stuck_payment_receipt": {
    "description": [
      "LAST RESORT.",
      "Discard a stuck Verified AI Birthcert payment receipt that the wallet is holding and refusing to pay past.",
      "DESTRUCTIVE and CANNOT BE UNDONE: the payment it represents becomes unrecoverable — if that settlement ever completes, the funds are forfeit and no credential is issued.",
      "Do NOT use this as a retry.",
      "If the wallet reports { status: \"settlement_pending\" }, a payment has already been made and the settlement may still complete by itself — but that same shape also covers an indeterminate outcome and a service refusal, so do not promise the user it will resolve on its own; call check_ai_birthcert_verification again instead; it actively advances a queued settlement.",
      "Only reach for this tool when the outcome has been stuck with no change for a long time and the user accepts losing the payment.",
      "The wallet enforces that: a receipt younger than SETTLEMENT_STUCK_AFTER_MS (24h by default) is REFUSED on both steps, so do not offer this option for one.",
      "Two steps, deliberately: call it with no arguments first and it clears NOTHING — it returns the receipt id and a warning.",
      "Show that id to the user, get their explicit agreement, then call again with confirmReceiptId set to exactly that id.",
      "A mismatched id clears nothing.",
      "If the settlement completed in between — which is exactly what happens when you follow the advice above and call check_ai_birthcert_verification first — the receipt now belongs to a LIVE, paid-for session and this tool REFUSES to clear on the id alone: it hands back the session id and verification link instead.",
      "Give that link to the user; only if they truly want to abandon a session they already paid for, call again with confirmDiscardLiveSession set to true as well.",
    ],
    "inputSchema.properties.confirmReceiptId.description": [
      "The receipt id to discard, copied exactly from a prior no-argument call.",
      "Omit it to be shown the id and the warning first — never guess or invent this value.",
    ],
    "inputSchema.properties.confirmDiscardLiveSession.description": [
      "Set true ONLY after the tool has refused because the receipt now belongs to a live verification session, and the user has been shown that session's link and has explicitly chosen to throw it away anyway.",
      "Never set it pre-emptively.",
    ],
  },
  "create_holder_account": {
    "description": [
      "Create a new holder HSM account on Wallet BE (onboarding).",
      "ALWAYS check first: if an account already exists for this session, this returns { alreadyExists: true, existing: {...} } WITHOUT creating anything — ask the user whether to keep using the existing account or create a new one, then call again with confirmNew:true only if they choose new.",
      "The wallet manages its own credentials; you neither need nor can supply any.",
      "A freshly created account is saved to this MCP's local account store and reused automatically on the next restart; an explicit ZETRIX_ADDRESS in the MCP config still overrides it.",
    ],
    "inputSchema.properties.confirmNew.description": [
      "Set true to mint a new account even though one already exists for this session — only after the user has confirmed they want a new one.",
    ],
  },
}

/**
 * Sentence split shared by the snapshot and by every sentence-level semantic guard, so a guard can
 * never be reasoning over different units than the reviewed snapshot pins.
 *
 * Does not break on `e.g.` / `i.e.` / an ellipsis (`did:zid:...`): splitting there detaches an
 * endorsement from the words that scope it, which silently weakens every check built on it.
 */
export const splitAgentSentences = (text: string): string[] =>
  text.split(/(?<!\be\.g\.|\bi\.e\.|\.\.\.)(?<=[.!?])\s+/)

/**
 * The tools whose agent-facing text can cause, deny or excuse a real charge. The semantic money
 * guards run over ALL of these tools' strings (top-level AND every property description), not just
 * the top-level description of the two Verified-AI-Birthcert tools — R11-M02: two mutants that
 * endorsed an unasked-for second payment, one planted in a PROPERTY description and one in a
 * sibling tool’s description, were invisible to guards that only ever read two top-level strings.
 */
export const MONEY_TOUCHING_TOOLS: readonly string[] = [
  'request_ai_birthcert_verification',
  'check_ai_birthcert_verification',
  'clear_stuck_payment_receipt',
  'subscribe_and_issue',
  'pay_and_fetch',
  'credential_preflight',
]
