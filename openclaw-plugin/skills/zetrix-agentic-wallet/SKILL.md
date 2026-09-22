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
| `pay_and_fetch` | **yes** | Fetching a resource that returned HTTP 402 |
| `subscribe_and_issue` | **yes** | Buying and receiving a verifiable credential |
| `create_holder_account` | no | Creating an additional holder account (rarely needed) |
| `request_ai_birthcert_verification` | **yes** | Starting a Verified AI Birthcert session (MyDigitalID owner verification) |
| `check_ai_birthcert_verification` | no | Status, **the verification link**, and advancing a payment that is still clearing, for the most recent Verified AI Birthcert session |
| `clear_stuck_payment_receipt` | no | **Last resort, destructive** — discard a payment receipt that is genuinely stuck, forfeiting that payment |
| `get_policy_template_schema` | no | Which spending rules a policy template allows you to write |
| `get_my_policy` | no | The spending policies this wallet owner has deployed on chain |
| `policy_preflight` | no | Checking a draft spending policy — is it valid, and does it MEAN what the user thinks |

## Safe first action

Before anything identity-, credential- or payment-sensitive, call `wallet_status` and confirm the
holder DID, the Zetrix address, the **network**, and which credentials are held. Report the network
plainly — mainnet spends real funds, testnet does not.

## Before collecting anything for a credential

When a user asks for a credential, your **first** action is `credential_preflight`. It is free,
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

While the session is open the result carries `verificationUrl` and `expiresAt`. Give both — the link
on its own is no use if it quietly expired an hour ago. Say when it expires in plain terms.

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
This means the payment **succeeded** and the wallet is following it. Never say it failed, and never
call `request_ai_birthcert_verification` to "try again" — that is a second payment for the same
thing. This one call can take up to about 90 seconds, because it is actively advancing the
settlement rather than just reporting on it. It is not hung.

Two cases, and they need different answers:

- **No `outcomeUnknown`** (the message starts `PAYMENT SENT`) — it is queued and progressing. Tell
  the user it went through and check again in a few minutes.
- **`outcomeUnknown: true`** (the message starts `OUTCOME UNKNOWN`) — the wallet could not determine
  what happened. Do not simply tell them to wait. Give them the `paymentReceipt` and tell them to
  quote it to support; it is the only record of the payment.

## Discarding a stuck receipt

`clear_stuck_payment_receipt` throws a payment away. If that settlement ever completes, the money is
gone and no credential is issued. It is not a retry and not a way to unstick a slow settlement —
`check_ai_birthcert_verification` is. Only reach for it when nothing has changed for a long time and
the user has said, in so many words, that they accept losing the payment.

It takes two calls by design. Call it with no arguments first: it clears nothing and returns the
receipt id. Show that id to the user, get their explicit agreement, then call again with
`confirmReceiptId` set to exactly that id. Never invent or guess the id.

If the second call comes back refusing because the receipt now belongs to a **live session**, the
payment worked while you were asking. Do not push past it. Give the user the `verificationUrl` it
returned — that link cannot be reissued — and let them finish. Only if they still want to abandon a
session they have already paid for do you call again adding `confirmDiscardLiveSession: true`.

## Spending policies

A policy is the user's own spending rulebook for this wallet, stored on chain. Reading one is
always free. This wallet can only READ policies today — it cannot write or deploy one.

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
