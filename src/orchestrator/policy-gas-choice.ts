/**
 * Who pays the gas for a policy write or update, and the choice put to the user.
 *
 *  - `sponsored` (today's path): the user pays the service's fee in JMYR over x402 and the facilitator pays the gas. No ZTX needed.
 *  - `self`: the wallet builds the contract call itself, signs it through Wallet BE and submits it directly. There is no service
 *    fee at all; it costs only the ZTX the transaction burns as gas.
 *
 * The wallet NEVER picks for the user and has no default for it. When self-pay is offered and the caller names no `gasPayer`, the
 * tool stops with `needs_choice`, laying out both options and whether the wallet can afford each, so the agent can ask. Self-pay
 * is offered only when the wallet can actually carry it out (`WritePolicyDeps.selfPay` present); without it nothing changes.
 *
 * Read-only: nothing here signs, pays or writes.
 */
import { ZTX_DECIMALS, type TokenBalanceResult } from '../clients/token-balance-client.js'
import type { SelfPayCall, SelfPayExecResult, TxLookup } from './policy-self-pay.js'

export type GasPayer = 'self' | 'sponsored'

export type GasPayerParse = { ok: true; gasPayer?: GasPayer } | { ok: false }

/**
 * Absent, null or blank means "not chosen". Anything else must be exactly `self` or `sponsored`: a typo is refused rather than read
 * as one of them, because the two spend different assets.
 */
export function parseGasPayer(value: unknown): GasPayerParse {
  if (value === undefined || value === null || value === '') return { ok: true }
  if (value === 'self' || value === 'sponsored') return { ok: true, gasPayer: value }
  return { ok: false }
}

/** What the wallet needs to offer, and later carry out, a self-paid write. */
export interface SelfPayDeps {
  /**
   * The ZTX this write would burn as gas, in raw units (micro-ZTX), estimated by the node for the exact transaction. A free read.
   * `{ error }` (with the reason) when it cannot be estimated: never a guess.
   */
  estimateGas: (call: SelfPayCall) => Promise<{ gasRaw: string } | { error: string }>
  /** The owner's native ZTX balance. Contracted to report failure as `{ error }`; a throw is contained here. */
  queryNativeBalance: () => Promise<TokenBalanceResult>
  /**
   * Builds, signs and submits the write. Only ever called after the user has chosen self-pay AND confirmed. `maxFeeRaw` is the
   * ceiling the wallet checked the balance against: a fresh estimate above it is refused with nothing signed, and the transaction
   * is signed with it as its fee limit, so the margin the balance check allowed for is the margin the chain gets.
   */
  execute: (call: SelfPayCall, limit: { maxFeeRaw: string }) => Promise<SelfPayExecResult>
  /** What became of a submitted transaction. Optional: without it a transaction that never shows is only "not confirmed". */
  lookupTransaction?: (txHash: string) => Promise<TxLookup>
}

export type SelfPayStatus = 'enough' | 'short' | 'unknown'

export interface SelfPayAssessment {
  status: SelfPayStatus
  /** The estimate and what the wallet asks to hold (estimate plus a reserve), raw and as a person reads them. */
  gas: { asset: 'ZTX'; estimatedRaw?: string; estimatedHuman?: string; requiredRaw?: string; requiredHuman?: string }
  balance?: { raw: string; human: string }
  /** One line per cause. */
  problems: string[]
  /** What this check cannot see. */
  notChecked: string[]
}

const UINT = /^\d+$/
/** An estimate is not a promise: the wallet asks for the estimate plus a fifth. */
const RESERVE_DIVISOR = 5n
const MAX_REASON = 200

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function human(raw: bigint): string {
  const d = 10n ** BigInt(ZTX_DECIMALS)
  const whole = raw / d
  const frac = (raw % d).toString().padStart(ZTX_DECIMALS, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} ZTX`
}

export async function assessSelfPay(deps: SelfPayDeps, call: SelfPayCall): Promise<SelfPayAssessment> {
  const notChecked = [
    'A snapshot: the balance and the network fee can change before the write.',
    "Whether Wallet BE will sign it: it decides that when it is asked to, and in current versions it does not check a contract call that moves no asset against the spending policy.",
    'Whether the transaction will succeed once it is included: the gas is spent even if it fails on chain.',
  ]
  const problems: string[] = []

  // Whatever the dependencies hand back is read as untrusted: a null, a wrong shape or a throw is "unknown", never a crash.
  let estimate: unknown
  try {
    estimate = await deps.estimateGas(call)
  } catch {
    estimate = { error: 'the estimate failed' }
  }
  let balance: unknown
  try {
    balance = await deps.queryNativeBalance()
  } catch {
    balance = { error: 'query_failed' }
  }

  const gas: SelfPayAssessment['gas'] = { asset: 'ZTX' }
  let required: bigint | undefined
  const est = estimate as { gasRaw?: unknown; error?: unknown } | null | undefined
  if (est && typeof est === 'object' && typeof est.gasRaw === 'string' && UINT.test(est.gasRaw) && BigInt(est.gasRaw) > 0n) {
    const value = BigInt(est.gasRaw)
    required = value + (value + RESERVE_DIVISOR - 1n) / RESERVE_DIVISOR
    gas.estimatedRaw = value.toString()
    gas.estimatedHuman = human(value)
    gas.requiredRaw = required.toString()
    gas.requiredHuman = human(required)
  } else {
    // The reason is the node's or the builder's own (a missing attributeType, a contract rejection), and is worth more than "could not".
    const reason = est && typeof est === 'object' && typeof est.error === 'string' && est.error !== '' ? clip(est.error, MAX_REASON) : undefined
    problems.push(
      `The ZTX gas for this write could not be estimated${reason ? ` (${reason})` : ''}, so whether the wallet can afford it is not known.`,
    )
  }

  let held: bigint | undefined
  let balanceOut: SelfPayAssessment['balance']
  const bal = balance as { token?: unknown; balance?: unknown; decimals?: unknown } | null | undefined
  if (
    bal &&
    typeof bal === 'object' &&
    !('error' in bal) &&
    bal.token === 'ZTX' &&
    bal.decimals === ZTX_DECIMALS &&
    typeof bal.balance === 'string' &&
    UINT.test(bal.balance)
  ) {
    held = BigInt(bal.balance)
    balanceOut = { raw: held.toString(), human: human(held) }
  } else {
    problems.push('The ZTX balance could not be read, so whether the wallet can afford the gas is not known.')
  }

  let status: SelfPayStatus = 'unknown'
  if (required !== undefined && held !== undefined) {
    if (held < required) {
      status = 'short'
      problems.push(`Not enough ZTX for gas: this write needs about ${human(required)} (the estimate plus a reserve) and the wallet holds ${human(held)}.`)
    } else {
      status = 'enough'
    }
  } else if (held === 0n) {
    // No estimate, but nothing at all to pay with: a definite no.
    status = 'short'
    problems.push('The wallet holds no ZTX, so it cannot pay gas.')
  }
  return { status, gas, ...(balanceOut ? { balance: balanceOut } : {}), problems, notChecked }
}
