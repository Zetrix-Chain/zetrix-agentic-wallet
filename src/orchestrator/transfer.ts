/**
 * transferToken — outbound value transfer, native ZTX or any ZTP20 token.
 *
 * Flow: resolve token → resolve amount → guards → nonce → estimateFee → build blob →
 * HSM-sign (Wallet BE) → submit. The blob construction itself is `BlobBuilder` from
 * x402-zetrix-client, the same tested code path x402 payments use — it handles both
 * `"ZTX"` → PAY_COIN and a contract address → INVOKE_CONTRACT `transfer(to, amount)`.
 *
 * This is the only tool that moves funds to an arbitrary destination. Everything else the wallet
 * pays for is bounded by a price someone else quoted (MBI says 1.0 JMYR, we pay 1.0 JMYR). So these
 * guards are all pre-signature and all fail-closed; nothing is signed until every one has passed:
 *
 *   - `confirm: true` required (never inferred) — the wallet has been observed paying on a
 *     one-word user reply, so intent must be explicit rather than assumed
 *   - amount stated as raw base units or human, and if both, they must agree
 *   - decimals must be readable, else the amount is a guess
 *   - per-call cap, token balance, and native gas balance all checked
 *   - destination must be a Zetrix address, and must not be the source
 *
 * WHERE THE REAL LIMIT LIVES. `docs/policy-engine/DESIGN.md` §7 already routes both ZTP20 and
 * native transfer through Wallet BE for enforcement. The 2026-09-22 scope decision settled the rest:
 * a transfer is governed by the POLICY ENGINE, and Wallet BE is the PEP — it consults the decision
 * service and refuses to sign. That refusal is authoritative; the guards above are a client-side
 * pre-check and cannot substitute for it, because a ceiling enforced by the client is only as honest
 * as the client. (The full decision record, naming PEP and PDP, lands with the policy-scope MR —
 * cite `DECISIONS.md` once it is on develop rather than before.)
 *
 * An earlier revision of this comment said a transfer was "bounded by nothing but these guards".
 * That was true when it was written and is no longer the design.
 *
 * NOT WIRED YET, and the reason this file still leans on the per-call cap: Wallet BE does not
 * enforce policy today, and has no agreed way to REPORT a policy refusal. Until it does, a denial
 * would arrive through `sign` as an ordinary failure and be reported as "signing failed" —
 * indistinguishable from the HSM being down. Telling those apart needs a stable status/code from
 * Wallet BE, matched on a field rather than on message text. See `isPolicyRefusal` below.
 *
 * ALSO NOT COVERED, deliberately: aggregate/session spend limits and an audit log. The per-call cap
 * means N calls spend N × cap — which is precisely the gap the policy engine exists to close, and
 * precisely why it, not this file, is where the real limit belongs. See GAP-1..GAP-4.
 */

import { toBaseUnits, toHumanAmount } from '../amount-units.js'
import type { TokenBalanceResult } from '../clients/token-balance-client.js'

/** Native coin sentinel — BlobBuilder maps this to a PAY_COIN operation. */
export const NATIVE_ASSET = 'ZTX'
/** Native ZETRIX is quoted in ZETA: 1 ZETRIX = 1,000,000 ZETA. */
const NATIVE_DECIMALS = 6
/**
 * A cheap PRE-FILTER, never the gate. It accepts a one-character Base58 typo, non-Base58
 * characters (0/O/I/l) and any length above 20 — every one of which `isValidAddress` rejects.
 * The checksum is what decides; this only avoids a call for obvious non-addresses.
 */
const ZETRIX_ADDRESS_SHAPE = /^ZTX[1-9A-HJ-NP-Za-km-z]{20,60}$/

export interface OperationSpecLike {
  type: string
  data: Record<string, unknown>
}

export interface TransferDeps {
  /** The holder address funds leave from. */
  sourceAddress: string
  /**
   * The SDK's checksum validator (`keypair.checkAddress`). Injected rather than imported so this
   * orchestrator stays pure and testable, matching every other dep here.
   *
   * A shape regex cannot do this job: a one-character Base58 typo satisfies any regex, and on the
   * ZTP20 branch the destination is an ordinary string argument to the token contract, which the
   * chain does not validate. A token that does not itself check it credits an unspendable key.
   */
  isValidAddress: (address: string) => boolean
  /** Token registry lookup for the active network — undefined when the symbol isn't registered. */
  resolveTokenAddress: (symbol: string) => string | undefined
  /** ZTP20 `contractInfo.decimals`; null when unreadable. */
  fetchDecimals: (contractAddress: string) => Promise<number | null>
  /** Balance of the asset being sent (raw base units), or an error marker. */
  queryBalance: (token: string) => Promise<TokenBalanceResult>
  /** Native ZTX balance in ZETA — gas has to come from here whatever is being sent. */
  fetchNativeBalance: (address: string) => Promise<string>
  fetchNonce: (address: string) => Promise<string>
  buildOperation: (asset: string, payTo: string, amount: string, clientAddress: string) => OperationSpecLike
  estimateFee: (p: { sourceAddress: string; nonce: string; operation: OperationSpecLike }) => Promise<{ feeLimit: string; gasPrice: string }>
  buildBlob: (p: {
    asset: string
    payTo: string
    amount: string
    clientAddress: string
    nonce: string
    gasPrice: string
    feeLimit: string
  }) => { blob: string }
  sign: (blob: string) => Promise<{ signBlob: string; publicKey: string }>
  submit: (p: { blob: string; signBlob: string; publicKey: string }) => Promise<{ hash: string }>
  /** Per-call ceiling (MAX_PAYMENT_AMOUNT). Throws when exceeded. */
  assertWithinCap: (asset: string, amount: string) => void
}

export interface TransferOpts {
  /** `"ZTX"`, a registered symbol (e.g. `"JMYR"`), or a raw ZTP20 contract address. */
  token: string
  to: string
  /** Raw base units. Give this or `amountHuman`; if both, they must agree. */
  amount?: string
  /** Human-readable amount, converted using the token's on-chain decimals. */
  amountHuman?: string
  /** Must be true to actually send. Never inferred. */
  confirm?: boolean
  /** Resolve and price the transfer, then stop without signing. */
  dryRun?: boolean
}

export interface TransferResult {
  sent: boolean
  reason?: string
  txHash?: string
  /** Nonce the transaction was built with — needed to check whether an unknown outcome landed. */
  nonce?: string
  /** Display symbol, or the contract address when the token isn't a registered symbol. */
  token?: string
  /** What was actually put on the wire: `"ZTX"` or the ZTP20 contract address. */
  asset?: string
  amount?: string
  amountHuman?: string
  decimals?: number
  fee?: { feeLimit: string; gasPrice: string }
  dryRun?: boolean
  /** Set when the only thing missing was `confirm: true` — everything else already validated. */
  needsConfirmation?: boolean
  /** Set when the symbol isn't in the registry: ask the user for the contract address. */
  needsTokenAddress?: boolean
  /**
   * The transaction was submitted but the node's answer never arrived, so it may or may not have
   * landed. Do NOT resubmit — check the nonce/hash first, exactly as with an MBI 4012.
   */
  outcomeUnknown?: boolean

  /**
   * The spending policy refused this transfer. A DECISION, not a failure — retrying will not help,
   * and nothing was signed or submitted. Distinct from a generic signing failure, which is
   * transient and worth retrying. See isPolicyRefusal.
   */
  policyDenied?: boolean
}

/** Resolve `token` to the wire asset, or report that we need to be told the contract address. */
function resolveAsset(
  deps: TransferDeps,
  token: string,
): { asset: string; token: string; native: boolean } | { needsTokenAddress: true; reason: string } {
  const raw = (token ?? '').trim()
  if (raw.toUpperCase() === NATIVE_ASSET) return { asset: NATIVE_ASSET, token: NATIVE_ASSET, native: true }

  const registered = deps.resolveTokenAddress(raw)
  if (registered) return { asset: registered, token: raw.toUpperCase(), native: false }

  // A raw contract address the caller supplied. Checksum it too: a typo here aims the transfer at
  // a contract that does not exist, or worse at one that does and is not the token meant.
  if (ZETRIX_ADDRESS_SHAPE.test(raw)) {
    if (!deps.isValidAddress(raw)) {
      return {
        needsTokenAddress: true,
        reason:
          `"${raw}" looks like a Zetrix address but its checksum does not match, so it is not one. ` +
          `Ask the user for the token's contract address rather than correcting it yourself.`,
      }
    }
    return { asset: raw, token: raw, native: false }
  }

  return {
    needsTokenAddress: true,
    reason:
      `"${raw}" is not a registered token on this network and is not a contract address. ` +
      `Ask the user for the ZTP20 contract address and pass it as \`token\`, or use a registered ` +
      `symbol. Registered symbols need no address.`,
  }
}

/**
 * Is this signing failure a POLICY DENIAL rather than the signer being unavailable?
 *
 * Wallet BE is the policy enforcement point (see the file header), so a denial arrives here as a
 * failed `sign`. Those two causes need different advice — a denial is a decision and retrying is
 * pointless, an outage is transient and retrying is exactly right — so they must not collapse into
 * one message.
 *
 * DELIBERATELY CONSERVATIVE, and currently expected to return false in production. Wallet BE has
 * not yet agreed how it reports a refusal, so there is no stable code to match on. Matching the
 * prose below is a placeholder and NOT a contract: a rewording on their side would silently turn
 * every denial back into "signing failed". Replace this with their real status/code the moment it
 * exists, and match on the field, never on the sentence — a mistake made before, and unpicked.
 *
 * Failing to recognise a denial is the safe direction: the transfer is still refused and nothing is
 * signed. Only the explanation is worse.
 */
export function isPolicyRefusal(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status
  if (status === 403) return true
  const code = (e as { policyCode?: unknown } | null)?.policyCode
  if (typeof code === 'string' && code !== '') return true
  return false
}

/**
 * Did the node ANSWER and refuse, as opposed to never answering at all?
 *
 * A rejection is deterministic and nothing reached the chain; a lost response is indeterminate and
 * the transaction may be on chain. They need opposite advice, so they must not share one result
 * shape. Matched on a FIELD set by the submit wrapper, never on the message.
 */
export function isSubmitRejection(e: unknown): boolean {
  return (e as { submitRejected?: unknown } | null)?.submitRejected === true
}

export async function transferToken(deps: TransferDeps, opts: TransferOpts): Promise<TransferResult> {
  const resolved = resolveAsset(deps, opts.token)
  if ('needsTokenAddress' in resolved) {
    return { sent: false, needsTokenAddress: true, reason: resolved.reason }
  }
  const { asset, token, native } = resolved

  const destination = (opts.to ?? '').trim()
  if (!ZETRIX_ADDRESS_SHAPE.test(destination) || !deps.isValidAddress(destination)) {
    // The checksum is the point. A one-character Base58 typo passes any shape check, and on the
    // ZTP20 branch `to` is an ordinary string argument the chain does not validate — a token
    // contract that does not itself check it credits an unspendable key, unrecoverably.
    return {
      sent: false, token, asset,
      reason:
        `destination "${opts.to}" is not a valid Zetrix address — its checksum does not match, ` +
        `which usually means a mistyped or truncated character. Nothing was signed. Ask the user ` +
        `to confirm the address rather than correcting it yourself.`,
    }
  }
  const to = destination
  if (to === deps.sourceAddress) {
    return { sent: false, token, asset, reason: 'destination is the same address as the sender — this would burn a fee and move nothing' }
  }

  // Decimals must be known before any amount can be trusted. Native is fixed; a ZTP20 whose
  // contractInfo can't be read is fatal here (unlike a balance read, where a raw number is still
  // useful) because converting a human amount without decimals would guess by 6 orders of magnitude.
  let decimals: number
  if (native) {
    decimals = NATIVE_DECIMALS
  } else {
    const read = await deps.fetchDecimals(asset)
    if (read === null) {
      return { sent: false, token, asset, reason: `could not read decimals for ${asset} — refusing to convert an amount without them` }
    }
    // Belt and braces alongside the reader's own check: toHumanAmount("1500000", -1) returns a
    // confidently wrong "1.5" rather than failing, so a bad value must never get this far.
    if (!Number.isInteger(read) || read < 0) {
      return { sent: false, token, asset, reason: `decimals for ${asset} read back as ${read}, which is not a usable value — refusing to convert` }
    }
    decimals = read
  }

  // Resolve the amount to base units, cross-checking the two forms against each other.
  let amount: string
  let amountHuman: string
  try {
    if (opts.amount !== undefined && opts.amountHuman !== undefined) {
      const fromHuman = toBaseUnits(opts.amountHuman, decimals)
      if (fromHuman !== opts.amount.trim()) {
        return {
          sent: false, token, asset, decimals,
          reason:
            `amount and amountHuman disagree: amountHuman "${opts.amountHuman}" is ${fromHuman} base units, ` +
            `but amount says ${opts.amount}. Send one or the other, or make them match.`,
        }
      }
      amount = fromHuman
      amountHuman = toHumanAmount(amount, decimals)
    } else if (opts.amountHuman !== undefined) {
      amount = toBaseUnits(opts.amountHuman, decimals)
      amountHuman = toHumanAmount(amount, decimals)
    } else if (opts.amount !== undefined) {
      // toBaseUnits is where positivity and digit-only-ness are enforced, and this branch skips it,
      // so it has to check here. "0" signed and submitted burns a fee and moves nothing.
      amount = opts.amount.trim()
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
        return {
          sent: false, token, asset, decimals,
          reason: `amount "${opts.amount}" must be a positive whole number of base units`,
        }
      }
      amountHuman = toHumanAmount(amount, decimals)
    } else {
      return { sent: false, token, asset, decimals, reason: 'no amount given — pass amount (raw base units) or amountHuman' }
    }
  } catch (e) {
    return { sent: false, token, asset, decimals, reason: (e as Error).message }
  }

  const base = { token, asset, amount, amountHuman, decimals }

  try {
    deps.assertWithinCap(asset, amount)
  } catch (e) {
    return { sent: false, ...base, reason: (e as Error).message }
  }

  // Balance of what's being sent. A failed lookup is fatal — proceeding would mean signing on the
  // assumption that funds exist (see token-balance-client on why a zero is never fabricated).
  const balance = await deps.queryBalance(native ? NATIVE_ASSET : asset)
  if ('error' in balance) {
    return { sent: false, ...base, reason: `could not read the ${token} balance (${balance.error}) — refusing to send without confirming funds` }
  }
  if (BigInt(balance.balance) < BigInt(amount)) {
    return {
      sent: false, ...base,
      reason: `insufficient ${token}: need ${amountHuman} (${amount}), hold ${toHumanAmount(balance.balance, decimals)} (${balance.balance})`,
    }
  }

  const nonce = await deps.fetchNonce(deps.sourceAddress)
  const operation = deps.buildOperation(asset, to, amount, deps.sourceAddress)
  const fee = await deps.estimateFee({ sourceAddress: deps.sourceAddress, nonce, operation })

  // Gas always comes out of native ZTX, whatever is being transferred. For a native send the
  // amount competes with the fee for the same balance.
  const nativeBalance = await deps.fetchNativeBalance(deps.sourceAddress)
  const needNative = native ? BigInt(fee.feeLimit) + BigInt(amount) : BigInt(fee.feeLimit)
  if (BigInt(nativeBalance) < needNative) {
    return {
      sent: false, ...base, fee, nonce,
      reason:
        `insufficient native ZTX for the transaction fee: need ${needNative} ZETA` +
        `${native ? ' (fee + amount)' : ''}, hold ${nativeBalance} ZETA`,
    }
  }

  if (opts.dryRun) return { sent: false, ...base, fee, nonce, dryRun: true }

  // Last gate. Everything above is validated, so the caller can show the user a precise
  // confirmation prompt and re-call with confirm: true.
  if (opts.confirm !== true) {
    return {
      sent: false, ...base, fee, needsConfirmation: true,
      reason: `not sent: pass confirm: true to send ${amountHuman} ${token} to ${to}. Show the user the amount and destination first.`,
    }
  }

  const { blob } = deps.buildBlob({ asset, payTo: to, amount, clientAddress: deps.sourceAddress, nonce, gasPrice: fee.gasPrice, feeLimit: fee.feeLimit })

  // Signing happens locally-ish (Wallet BE HSM) and moves nothing, so a failure here is clean.
  // It is ALSO where a policy denial will arrive once Wallet BE enforces one — see isPolicyRefusal.
  let signed
  try {
    signed = await deps.sign(blob)
  } catch (e) {
    // Two very different causes, and they must not share one message: the signer being unavailable
    // is transient and worth retrying, a policy denial is a decision and retrying is pointless.
    if (isPolicyRefusal(e)) {
      return {
        sent: false, ...base, fee, nonce, policyDenied: true,
        reason:
          `refused by your spending policy, nothing was submitted: ${(e as Error).message}. ` +
          `This is a decision, not a failure — retrying will not help. Review the policy with get_my_policy.`,
      }
    }
    return { sent: false, ...base, fee, nonce, reason: `signing failed, nothing was submitted: ${(e as Error).message}` }
  }

  // Past this point the transaction may be on chain even if we never hear back.
  try {
    const { hash } = await deps.submit({ blob, signBlob: signed.signBlob, publicKey: signed.publicKey })
    return { sent: true, ...base, fee, nonce, txHash: hash }
  } catch (e) {
    if (isSubmitRejection(e)) {
      // The node ANSWERED and refused, so nothing is on chain. Reporting this as possibly-on-chain
      // would be a claim about funds broader than what is known, and would block a safe retry while
      // sending the user to hunt a nonce for a transaction that never existed.
      return {
        sent: false, ...base, fee, nonce,
        reason:
          `the node rejected this transaction, so nothing was submitted and nothing is on chain: ` +
          `${(e as Error).message}. Fix the cause and try again.`,
      }
    }
    return {
      sent: false, ...base, fee, nonce, outcomeUnknown: true,
      reason:
        `submission outcome unknown: ${(e as Error).message}. The transaction may already be on chain — ` +
        `do NOT retry. Check for a transaction from ${deps.sourceAddress} at nonce ${nonce} first.`,
    }
  }
}
