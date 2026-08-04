# Zetrix Agentic Wallet — user guide

Gives your OpenClaw agent a Zetrix wallet. It can prove who you are, collect verifiable credentials,
and pay for pay-per-use resources — without you creating an account, choosing a password, or editing
any configuration.

**Two things to know before you start:**

- The wallet **creates its own account and password**. You never type either. That also means the
  credentials exist only on this machine — [back them up](#backing-up-your-wallet).
- It **will not pay for anything** until you [set a spending limit](#setting-your-spending-limit).
  That is deliberate, not a fault.

---

## 1. Install

```bash
openclaw plugins install clawhub:zetrix-agentic-wallet
openclaw plugins enable zetrix-agentic-wallet
openclaw gateway restart
```

Check it worked:

```bash
openclaw plugins list          # zetrix-agentic-wallet, enabled
openclaw mcp doctor            # zetrix-agentic-wallet: ok
openclaw mcp probe zetrix-agentic-wallet   # 7 tools
```

Nothing else is needed. No `npx`, no account signup, no password, no MCP configuration.

The first time the wallet runs it creates a Zetrix account on **testnet** and stores it under
`~/.openclaw/zetrix-agentic-wallet/state/`.

## 2. Try it

Open the dashboard and ask in plain language — you do not need to name tools:

```bash
openclaw dashboard
```

> **What is my Zetrix wallet address?**

You should get an address starting `ZTX3…`, a holder DID, and the network (`zetrix:testnet`).

Other things that work straight away, all free:

> Do I hold any verifiable credentials?
> What is my ZTX balance?
> What attributes does credential template X require?

## 3. What it can do

| Ask for | Costs money? |
|---|---|
| Wallet address, DID, network, balance | no |
| Which credentials you hold | no |
| What a credential template requires | no |
| Reading on-chain contract data | no |
| Proving your identity to a service | no |
| **Fetching a resource that charges per use** | **yes** |
| **Obtaining a verifiable credential** | **yes** |

The two paid actions are refused until you set a limit.

---

## Setting your spending limit

The wallet starts at **zero** — every payment is declined. This is on purpose: a wallet that could
spend whatever a website asked for, straight out of the box, is not a safe default.

### Through the dashboard

Open the plugin's settings and set **Maximum payment per call**. That is the whole change.

### From the command line

```bash
openclaw config set plugins.entries.zetrix-agentic-wallet.config.maxPaymentAmount \
  '{"ZTX":"1000000000","*":"0"}' --json
openclaw mcp reload
```

It takes effect immediately — no gateway restart.

### Reading the limit

```json
{ "ZTX": "1000000000", "*": "0" }
```

- **`"ZTX": "1000000000"`** — up to 1,000,000,000 raw units of ZTX per payment. ZTX has 6 decimals, so
  that is **1,000 ZTX**.
- **`"*": "0"`** — everything else is refused.

Amounts are in **raw units**, not whole tokens. Divide by 10⁶ for ZTX to get the human figure. Some
services charge in other tokens (for example JMYR); add an entry per token you want to allow:

```json
{ "ZTX": "1000000000", "JMYR": "5000000", "*": "0" }
```

**Once set, the limit is an allowlist.** A token with no entry and no `"*"` fallback is **denied**, not
allowed through. Keeping `"*": "0"` means "only the tokens I have listed".

### It is a hard limit, not a prompt

The limit is enforced by the wallet itself, before any payment is signed. Your agent cannot talk its way
past it, and neither can a website. If a payment exceeds the limit it is refused, and the agent should
tell you so rather than retrying.

> ⚠️ **Set this through the plugin settings, not by editing `openclaw.json` directly.** The plugin
> manages its own entry in that file and will either overwrite your edit or stop managing the entry
> altogether. Neither is obvious when it happens.

## Adding funds

A brand-new wallet has no funds, so even with a limit set it cannot pay yet.

1. Ask your agent for your wallet address
2. Send testnet ZTX to it from another Zetrix wallet
3. Ask **"what is my ZTX balance?"** to confirm it arrived

Until the address has received anything, the wallet reports it is **not yet activated on chain** — that
means "send it some ZTX", not "something is broken".

## Backing up your wallet

**Do this once, now.** The wallet generated its own password and keeps it on this machine. It is the
only thing that can authorise payments from your account. If you lose this machine without a backup, the
account and anything in it are **gone permanently** — nobody can recover it, including us.

```bash
npx agentic-wallet-mcp export-credentials
```

Run it in your own terminal window. It prints your address, DID and password. Store them somewhere
private, such as a password manager.

It only works in an interactive terminal, and it is deliberately **not** something your agent can do —
so your password never appears in a conversation.

## Moving to mainnet

Testnet tokens are not real. To use real funds:

```bash
openclaw config set plugins.entries.zetrix-agentic-wallet.config.network zetrix:mainnet
openclaw mcp reload
```

Before you do:

- **Back up your wallet** (above) if you have not already
- **Review your spending limit** — the same number now means real money
- Note that mainnet uses a **different account** from your testnet one

## If something is wrong

| What you see | What it means |
|---|---|
| Agent says the wallet tools are unavailable | Plugin not enabled, or gateway needs restarting. Check `openclaw plugins list` |
| *"payment blocked … exceeds configured MAX_PAYMENT_AMOUNT"* | Working as intended — raise the limit if the amount is right |
| *"not activated"* | The address has no funds yet. Send it ZTX |
| Balance lookup fails but the wallet otherwise works | Usually a network problem reaching the Zetrix node |
| Everything fails after connecting to a corporate VPN | Some VPNs block the Zetrix endpoints. Try disconnecting |

Useful commands:

```bash
openclaw mcp doctor                        # is the wallet configured correctly?
openclaw mcp probe zetrix-agentic-wallet   # can it start, and what tools does it offer?
openclaw logs --limit 200                  # what did it actually say?
```

## Removing the wallet

```bash
openclaw plugins uninstall zetrix-agentic-wallet --force
openclaw mcp unset zetrix-agentic-wallet
```

⚠️ **Back up first.** Deleting `~/.openclaw/zetrix-agentic-wallet/` destroys the account permanently.
The wallet keeps working between those two commands — that is intentional, so an uninstall does not
silently strand an account holding funds.
