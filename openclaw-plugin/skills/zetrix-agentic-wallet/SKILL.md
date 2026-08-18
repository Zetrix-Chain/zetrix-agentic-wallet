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
| `get_template_schema` | no | What attributes a credential template requires |
| `query_contract` | no | Read-only contract or account state |
| `prove_identity` | no | Answering an identity proof request with a held credential |
| `pay_and_fetch` | **yes** | Fetching a resource that returned HTTP 402 |
| `subscribe_and_issue` | **yes** | Buying and receiving a verifiable credential |
| `create_holder_account` | no | Creating an additional holder account (rarely needed) |
| `request_ai_birthcert_verification` | **yes** | Starting a Verified AI Birthcert session (MyDigitalID owner verification) |
| `check_ai_birthcert_verification` | no | Checking the status of the most recent Verified AI Birthcert session |

## Safe first action

Before anything identity-, credential- or payment-sensitive, call `wallet_status` and confirm the
holder DID, the Zetrix address, the **network**, and which credentials are held. Report the network
plainly — mainnet spends real funds, testnet does not.

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

The cap starts at zero, so **every payment is refused until the user configures one.** If that is why
a call failed, say so clearly: it is expected behaviour, not a fault.

## When a payment cannot proceed

The wallet distinguishes the reasons, and they need different advice:

- **`not_activated`** — the address does not exist on chain yet. Ask the user to send ZTX to the
  address from a funded wallet. Do not describe this as a low balance.
- **`gas`** — not enough ZTX for fees, even though the payment asset may be sufficient.
- **`resource_payment`** — not enough of the asset being spent.

Report the address, the asset, and the amounts the wallet gives. Never invent a figure.

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
