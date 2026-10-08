---
name: zetrix-agentic-wallet
description: >
  Use the Zetrix Agentic Wallet to report the holder identity, answer identity proof
  requests, obtain verifiable credentials, pay for pay-per-use resources, and read
  credential templates or on-chain contract state. Use for wallet status, Zetrix
  address or DID, identity proof, verifiable credentials, or a resource that returns
  HTTP 402.
version: 0.1.0
metadata:
  openclaw:
    skillKey: zetrix-agentic-wallet
    emoji: "🪙"
---

# Zetrix Agentic Wallet

## Runtime contract

The wallet is already installed and configured by the plugin. Do not run `npm`, `npx`, shell
installers, or `openclaw mcp set`, and do not edit OpenClaw configuration.

If the wallet tools are unavailable, say the wallet plugin is not installed, enabled or healthy, and
stop. Do not attempt a host-level workaround.

**Never request, display, log or pass an HSM password or private key.** The wallet manages its own
credentials and no tool accepts one. If a user offers a password, tell them it isn't needed.

## Tool names

Tools appear with the wallet's server prefix, for example `mcp__zetrix-agentic-wallet__wallet_status`.
Your host may present them slightly differently — match on the part after the last `__`
(`wallet_status`, `pay_and_fetch`, …) rather than assuming an exact prefix.

| Tool | Costs money? | Use it for |
|---|---|---|
| `wallet_status` | no | Holder address, DID, network, held credentials, token balance |
| `credential_preflight` | no | **First step for any credential** — fee, gas model, balances, spending limit, required fields |
| `get_template_schema` | no | What attributes a credential template requires |
| `query_contract` | no | Read-only contract or account state |
| `prove_identity` | no | Answering an identity proof request with a held credential |
| `create_verification_qr` | no | Giving a person a link and QR code that open the agent's credential in the MyID app, to verify the agent. It presents the Verified AI Birthcert if held, otherwise the Basic AI Birthcert, otherwise tells you to get one first. It reveals a standard minimal set by default (Verified: agentName, evidenceProvider, ownerVerified; Basic: agentUsername) — other attributes only if the user asks (`revealAttribute`), everything only if the user explicitly asks (`revealAll`); a Basic credential does not mean the owner was verified; on mainnet it answers `created: false` until the `myidVerifyLinkTemplate` setting is set (testnet has a built-in UAT link) |
| `pay_and_fetch` | **yes** | Fetching a resource that returned HTTP 402 |
| `subscribe_and_issue` | **yes** | Buying and receiving a verifiable credential |
| `create_holder_account` | no | Creating an additional holder account (rarely needed) |
| `request_ai_birthcert_verification` | **yes** | Starting a Verified AI Birthcert session (MyDigitalID owner verification) |
| `check_ai_birthcert_verification` | no | Status, **the verification link**, and advancing a payment that is still clearing, for the most recent Verified AI Birthcert session |
| `clear_stuck_payment_receipt` | no | **Last resort, destructive** — discard a payment receipt that is genuinely stuck, forfeiting that payment |
| `get_policy_template_schema` | no | Which spending rules a policy template allows — call it with no arguments to list the templates and get the templateId you need to write one |
| `get_my_policy` | no | The spending policies this wallet owner has deployed on chain |
| `policy_preflight` | no | Checking a draft spending policy — is it valid, and does it MEAN what the user thinks |
| `check_policy_decision` | no | Asking whether a spend is permitted RIGHT NOW — but a permitted answer RESERVES capacity for ~15 min, so never poll it |
| `write_policy` | **YES** | Deploying a spending policy on chain. Run `policy_preflight` first and show the user what it MEANS |
| `update_policy` | **YES** | Changing a deployed spending policy (the full replacement set). Read it with `get_my_policy` first; preflight and show what it MEANS |
| `remove_policy` | no | Removing a deployed spending policy. Free, but it lifts every limit it set, so it needs the user's clear yes |
| `check_policy_write` | no | Finishing a policy write already paid for — the right answer to "did it get created?" |
| `transfer_token` | **yes** | Sending ZTX or a ZTP20 token to an address — **moves real funds, irreversible** |

## Safe first action

Before anything identity-, credential- or payment-sensitive, call `wallet_status` and confirm the
holder DID, the Zetrix address, the **network**, and which credentials are held. Report the network
plainly — mainnet spends real funds, testnet does not.

## Before collecting anything for a credential

When a user asks for a credential, your **first** action is `credential_preflight`. If it returns `alreadyHeld`, the wallet already holds a
valid copy: tell the user, name it, and **stop** — do not ask for an agent name or any other detail and do not begin an issuance. Buying another
would replace it and cost the fee. Only if the user explicitly says they want a replacement, run it again with `replacing: true`. It is free,
spends nothing and starts nothing. Do this **before you collect** a single application detail — not
after, and not just before paying. Asking someone for a name and optional metadata and only then
telling them it costs money, or that their wallet cannot pay, wastes their time and reads as a
bait-and-switch.

State the whole picture in one message: the fee (`fee.display`), which side pays gas
(`fee.gasModel`), the balances, whether the wallet is ready, and — for a template credential — the
attributes it will need. Then either collect the details, or say exactly what to fix and stop.

**Relay `notChecked` as well.** A ready result is not a guarantee. In particular preflight cannot
tell you whether an agent name is free — myid decides that at issuance, after payment — so never
imply a name has been reserved or verified.

If `ready` is false, `blockers` lists **every** reason at once. Give the user all of them together;
fixing one at a time is exactly the trap this replaces.

## Before spending

All three paid tools (`pay_and_fetch`, `subscribe_and_issue`, `request_ai_birthcert_verification`)
spend from the user's wallet. Every time:

1. Say what is being bought and the amount, in the asset the challenge quotes.
2. Say whether the wallet is on testnet or mainnet.
3. Get the user's agreement.
4. For a credential via `subscribe_and_issue`, call `get_template_schema` **first** — it is free, and
   it tells you which attributes are required. Paying before checking risks paying for an issuance
   that then fails.
5. For `request_ai_birthcert_verification`, get `agentName` from the user directly — never invent it
   — and tell them it must be unique. Payment happens at session creation, before myid checks the
   name; a duplicate name still gets charged and only fails afterwards, at issuance. Calling this
   tool again with the SAME name while a session is still pending does not pay again — it returns
   that same session.
6. Before it pays, `request_ai_birthcert_verification` checks whether this holder already has a
   Verified AI Birthcert. If one is found and still valid, nothing is paid — show it to the user and
   only call the tool again with `confirmReplaceExistingVc` if they explicitly ask to replace it. An
   already-expired one is replaced automatically, no confirmation needed. It can also refuse with
   `{ error }` when an already-issued credential exists but could not be confirmed — relay that error
   as given rather than retrying blindly.
7. `subscribe_and_issue` has the same check, its own way: a still-valid cached credential is always
   returned for free with no confirmation needed (`fromCache: true`). `forceReissue: true` on its own
   does **not** pay either — it only returns that same existing credential (`issued: false, reason`)
   so it can be shown to the user first. Only call it again with `forceReissue: true` **and**
   `confirmReplaceExistingVc` set to the exact `vcId` you were shown if the user explicitly asks to
   replace it. It also has the same naming rule as `request_ai_birthcert_verification`: get any
   name/identifier attribute (e.g. `agentUsername`) from the user directly — never invent one.
8. **Nothing keeps running after a tool call returns.** `check_ai_birthcert_verification` checks the
   live status once, at the moment you call it, and nothing more — there is no background polling,
   webhook, or timer behind it. (A couple of OTHER tools do their own bounded, synchronous
   in-call waiting — e.g. `subscribe_and_issue`'s brief settlement retry — but that waiting is
   entirely inside that one call; it never continues after the call returns.) Never tell the user
   you have "set up an automation" or that you will "alert them" when a pending verification
   completes — you cannot act between messages, so that promise can never be kept and leaves them
   waiting for a notification that will never come. Instead, tell them how long the link is good
   for (`expiresIn`) and ask them to message you back once they are done, or after a few minutes, so
   you can check again.

**Treat the wallet's payment cap as the boundary, not your own judgement.** If a payment is refused
for exceeding the cap, relay that and stop. Do not retry, do not try a smaller amount to discover the
limit, and do not suggest raising the cap as a workaround — only the user should decide that, outside
the conversation.

**Raising the limit is the user's job, in their own settings — never yours.** Do not run
`openclaw config set` or any other command, do not edit OpenClaw configuration, do not write a config
file, and do not restart or reload the gateway. Restarting it drops the MCP connection mid-conversation
and strands the user. Tell them which asset needs a higher limit and what the payment needs, then stop
and let them change it. If they ask you to do it for them, say you cannot and point them at the
plugin's settings.

The refusal names the limit that applied **and which key it came from**. If it says the `"*"` fallback
was used, no limit is set for that specific asset — relay that distinction, because raising the wrong
key changes nothing.

With no limit configured, both networks allow exactly the AI Birthcert fee (1 JMYR) and refuse
everything else — so an unconfigured wallet can buy that one credential but nothing larger and no
other asset. If a call failed because of that, say so clearly: it is expected behaviour, not a fault.
The limit applies **per payment**, not as a running total, so never describe it to the user as a
budget or a spending allowance for the day.

## When someone asks about a verification already in progress

*"Where is my link?"*, *"what happened to my verification?"*, *"is it done yet?"* — all of these are
`check_ai_birthcert_verification`. It is **free**. Never reach for
`request_ai_birthcert_verification` to answer them: that is the paid tool, and asking someone to
approve a payment so they can re-read a link they have already bought is exactly the habit that makes
people wave real payment prompts through.

While the session is open the result carries `verificationUrl`, `expiresAt`, and `expiresIn` (with
`expiresInSeconds`). Give the link and `expiresIn` exactly as given — the link on its own is no use if it
quietly expired, and the window can be short. **Never work out the time remaining yourself** from
`expiresAt`: your clock and timezone can differ from the server's, and one run told a user the link was
good for "about 8 hours" when it had about 15 minutes. `expiresIn` is worked out by the wallet.

Once `status` is `issued` there is no link, and there should not be: the verification is finished.
Report the credential instead.

If the link **has** expired, say so plainly and offer to start again. Do not present an expired link
as though it still works. Starting again does not necessarily cost a second payment — the wallet
reuses the earlier one where it can — but it is still a paid tool, so ask first and let the wallet
report what actually happened rather than promising it will be free.

**Do not paste a link you are remembering.** If the tool did not just return it, you do not have it.
A link recalled from earlier in the conversation may belong to a session that has since expired or
completed, and the user cannot tell the difference.

## When a payment is still clearing

`check_ai_birthcert_verification` may return `status: "settlement_pending"` with a `paymentReceipt`.
This means a payment **was sent** and the wallet is following it. Never say it failed, and never
call `request_ai_birthcert_verification` to "try again" — that is a second payment for the same
thing. This one call can take up to about 90 seconds, because it is actively advancing the
settlement rather than just reporting on it. It is not hung.

Read `message`, not just the flags. These cases need different answers:

- **No `outcomeUnknown`, message says *"still being processed"*** — the settlement is confirmed
  queued and progressing. Tell the user the payment went out and to check again in a few minutes.
- **No `outcomeUnknown`, message says *"has not been confirmed yet"*** — same flags, different
  state: the outcome could not be determined at all yet. Do **not** call this progressing and do
  **not** call it succeeded. Say the payment was sent, the outcome is not confirmed, the receipt is
  saved, and ask them to message you again in a few minutes so you can check — you cannot check on
  your own between messages. Do not pay again.
- **`outcomeUnknown: true`** (the message starts `OUTCOME UNKNOWN`) — the wallet could not determine
  what happened. Do not simply tell them to wait. Give them the `paymentReceipt` and tell them to
  quote it to support; it is the only record of the payment.
- **`issuerRejected: true` or `paymentInvalid: true`** — the credential service was reached and
  refused. Relay what `message` quotes. Neither says whether the fee was taken, in either
  direction, so never tell the user they were not charged, and never tell them they were.

## Discarding a stuck receipt

`clear_stuck_payment_receipt` throws a payment away. If that settlement ever completes, the money is
gone and no credential is issued. It is not a retry and not a way to unstick a slow settlement —
`check_ai_birthcert_verification` is. Only reach for it when nothing has changed for a long time and
the user has said, in so many words, that they accept losing the payment. The wallet enforces the
"long time": a receipt younger than `SETTLEMENT_STUCK_AFTER_MS` (24 hours by default) is **refused**
on both steps and on `discardStuckReceiptAndPayFresh`, nothing discarded and nothing paid — so never
offer discarding for a payment that is not yet that old. A bare "retry" or "yes" from the user is not
agreement to pay a second fee: one run treated it as consent and the user was charged twice for a
payment that had already settled.

It takes two calls by design. Call it with no arguments first: it clears nothing and returns the
receipt id. Show that id to the user, get their explicit agreement, then call again with
`confirmReceiptId` set to exactly that id. Never invent or guess the id.

If the second call comes back refusing because the receipt now belongs to a **live session**, the
payment worked while you were asking. Do not push past it. Give the user the `verificationUrl` it
returned — that link cannot be reissued — and let them finish. Only if they still want to abandon a
session they have already paid for do you call again adding `confirmDiscardLiveSession: true`.

## Sending tokens

`transfer_token` is the only tool that moves funds to a destination nobody quoted. Everything else
the wallet pays for is bounded by a price someone else set; this is bounded by what you and the user
agree. Treat it accordingly.

**Never set `confirm: true` on the user's behalf, and never infer it.** Call once without it (or
with `dryRun: true`), show the user the resolved amount, the destination and the fee, and only
re-call with `confirm: true` after they have said yes to those exact figures. A one-word reply to a
question you asked is not agreement to an amount you never showed them.

**State the amount the way the user did, and let the wallet convert.** Pass `amountHuman` ("1.5")
and the wallet applies the token's on-chain decimals. If you pass both `amountHuman` and `amount`
they must agree — that disagreement is the cheapest way to catch a 1-vs-1000000 error before it
becomes an irreversible one.

**An unregistered symbol returns `needsTokenAddress: true` and signs nothing.** Ask the user for the
contract address. Never guess one.

**If a result comes back with `outcomeUnknown: true`, do NOT retry.** The transaction may already be
on chain. Report the nonce and tell the user to check it before anything else is attempted.

**`policyDenied: true` is a decision, not a failure — do NOT retry.** The user's spending policy refused
the transfer and nothing was signed. Show them the reason (it names which limit) and point them to
`get_my_policy`. **`policyCheckUnavailable: true` is different:** the policy check itself could not be
completed, nothing was signed or sent, and trying again shortly is safe. Never describe one as the other.

## Spending policies

A policy is the user's own spending rulebook for this wallet, stored on chain. Reading one is
always free. Writing one costs a fee and goes through write_policy; reading and checking are free.

**`check_policy_decision` has three outcomes, and `undetermined` is the one to get right.** It is
NOT a refusal and NOT permission — it means nothing was evaluated, so never tell the user their
policy blocked them on the strength of it, and never spend. There is no step-up verdict: the
decision service answers only allow or deny. A permitted answer reserves capacity for about
fifteen minutes, so do not call it in a loop — and do not probe amounts to find one that fits,
because every permitted answer along the way reserves again and the owner's next real payment can
be refused by their own agent. Read `remaining` from ONE answer and work it out locally. Never
retry automatically after a timeout either: the call may have succeeded and reserved already.
Read `ignored` back even on a permitted answer —
it lists constraints the policy carries that the service could not enforce.
**To write a policy, start by listing the templates — do not ask the user for an address.** Call
get_policy_template_schema with no arguments: it returns the templates on offer, each with its
declared attributes and a templateId the chain has confirmed. Use that id in write_policy and leave
templateContractAddress out. A user has no way to know a publisher, a policy key or a template
contract address, and a wallet with no deployed policy has no other source for a templateId. Only if
the result says no default publisher is configured should you ask for one. To tell the user
what a write will cost BEFORE paying, call write_policy with dryRun: it runs the free checks and
returns the quote, paying nothing and writing no policy. The result also says whether the wallet can afford
it (`affordability`): tell the user about any shortfall — fee asset, gas or the payment cap — and
treat "unknown" as not yet confirmed, never as a yes. A quote is not a promise the payment will be
allowed — balances move and the cap is enforced again when paying. assetScope is exactly "native" or
"ztp20", never a token symbol; a token policy also needs its tokenAddress — the contract address,
which wallet_status({ token }) returns as tokenAddress, so do not ask the user for the address of a
token the wallet knows. Amounts are RAW BASE units: policy_preflight's interpretation says what each
means in whole tokens (1 of a 6-decimal token is 0.000001 of it), so show it. A non-zero amount
under one whole token is refused until you say what is meant: when the user states an amount in
tokens ("1 JMYR"), pass amountUnit "whole" and give the amount as they said it ("1") — the wallet
converts it and shows the raw value before anything is paid. Use "base" only when the user really
means that tiny a raw value. To give an amount in tokens instead, use valueHuman on that attribute ("100" for 100 JMYR): the
wallet converts it with the token's own decimals and shows both forms. It is only for perTransactionMax, cumulativeMax and
velocityCap (and any attribute the service lists as an amount) — never put convertedAmounts in it, and write a fractional amount as text such as "0.5" — maxTransactionCount is a count and a window is a duration, and neither is ever scaled. Send write_policy the SAME attributes and the SAME amountUnit you
preflighted with — never the convertedAmounts, which are for showing the user and would be converted
a second time (the wallet refuses a "whole" draft in which every amount already looks raw, and its message
gives the raw value to send with "base" if you really mean a cap that large). The guard
cannot catch a raw value that is already one whole token or more, and it does nothing when the
token's decimals cannot be read, so always show interpretation and notChecked. A window is a duration
such as 7d, 12h or 30m — never "week" and never a bare number.

**A policy write that is `settling` or `submitted` has ALREADY BEEN PAID FOR.** No policy exists
yet, and that is the normal window rather than a failure. Never call `write_policy` again for it —
pass its `paymentReceipt` to `check_policy_write`, which never pays. `submitted` carries a
`txHash` and still is not a written policy: the block has not confirmed it, so do not tell the user
their policy exists. Only `written` means that. The one state where paying again is right is
"receipt_void", and it sets `payFresh` to say so.

**To change a policy, read it first, then use `update_policy`.** `get_my_policy` gives each policy's current attributes and
`forUpdate.expectedUpdatedAtBlock`. Pass that value as `expectedUpdatedAtBlock`: if the policy has changed since you read it, the
update is refused for free (`modified`) and nothing is paid — read it again and start from what it holds now. `attributes` is the
FULL replacement set, not a patch, so start from the current attributes and change only what the user asked. Do not pass a
templateId (the policy keeps its own), and the validity window is kept unless the user names a new one. An update pays a fee, so the
same rules as `write_policy` apply: preflight it, show the interpretation and the price, and pass `confirm: true` only after the user
has said yes. `settling` and `submitted` mean a payment has been made — pass the `paymentReceipt` to `check_policy_write`, never call
`update_policy` again for it, and do not say the policy is updated until the state is `written`.

**`remove_policy` removes every limit the policy set.** Once it is gone Wallet BE signs spends of that asset without any limit, so show
the user what the policy currently limits (the unconfirmed call returns it as `currentAttributes`) and what removing it means, and call
again with `confirm: true` only if they clearly agree. `removed` is the only state that means it is gone; `submitted` is not, so check
with `get_my_policy` (a policy that is no longer listed is gone). Calling it again is free and never submits a second removal.

**Always run `policy_preflight` on a draft before anyone deploys it, and always show the user its
`interpretation` — including when `ready` is true.** The chain validates nothing: a policy can be
completely valid, deploy cleanly, and still mean something other than what the user asked for.
Reporting only "ready" hides exactly the mistakes this check exists to catch. The most common:

- A spending cap written **without a time window is a LIFETIME cap**, not a monthly one. "RM500 a
  month" written that way silently means "RM500 ever".
- An **empty allow-list denies everything**, because nothing is on it.
- A **misspelled rule name is not enforced at all** — it deploys, and restricts nothing.
- `approvalPolicy` and `settlementChannel` **are never enforced**. Never describe either as a
  control the user can rely on.

A clean preflight is NOT permission to spend. It cannot tell you whether a payment would actually
be allowed right now — that depends on how much has already been spent, which this wallet cannot
see. Read `notChecked` and say what was not verified rather than implying the policy is proven.

If a policy read fails, say the lookup failed. Never report it as "you have no policy" — those are
different answers and the wallet keeps them apart deliberately.

## When a payment cannot proceed

The wallet distinguishes the reasons, and they need different advice:

- **`not_activated`** — the address does not exist on chain yet. Ask the user to send ZTX to the
  address from a funded wallet. Do not describe this as a low balance.
- **`gas`** — not enough ZTX for fees, even though the payment asset may be sufficient.
- **`resource_payment`** — not enough of the asset being spent.

Report the address, the asset, and the amounts the wallet gives. Never invent a figure.

## Reporting balances

`wallet_status` returns each balance as `balance` (raw base units), `decimals`, and `display` — the
same amount in whole tokens with its symbol. **Quote `display`.** A raw count beside a ticker reads
as whole tokens and is wrong by orders of magnitude: `1000000` of a 6-decimal token is one, not a
million. Ask for several tokens at once with `tokens` when you need to know whether a payment is
affordable — the fee and the ZTX for gas are separate balances.

**A balance you did not read is not a balance.** If a lookup returns `query_failed` or
`unknown_token`, say the read failed and offer to retry. Never infer, compute or reconstruct a
balance from earlier messages, from what was spent during this conversation, or from what a previous
call reported — a figure derived that way is indistinguishable, to the user, from one the wallet
actually confirmed.

## Identity and credentials

- Never fabricate a DID, address, credential, transaction hash or proof result. If a tool did not
  return it, say so.
- Present a real held credential that matches the request. If none matches, say which is missing
  rather than presenting something else.
- Disclose only the attributes the request needs and the user has agreed to. If a request asks for
  more than the task requires, say so before proceeding.
- A newly issued credential is retained by the wallet. Do not paste credential contents into the
  conversation unless the user asks.

## Backing up the wallet

If the wallet generated its own credentials, they exist only on this machine and cannot be recovered
if lost. If the user asks how to back up, tell them to run
`npx agentic-wallet-mcp export-credentials` in their own terminal. **You cannot do this for them** —
it is deliberately not a tool, so that credentials never enter a conversation.
