/**
 * Can this wallet afford the policy write it has just been quoted? Read-only, and it answers ONLY
 * from free reads — a balance query per asset and the configured payment cap. Nothing here signs,
 * pays or writes.
 *
 * WHY THIS EXISTS. `write_policy` with `dryRun` returns the price and stops before the payer, so a
 * user could be shown a green preflight and a quote and only then meet "insufficient X" at payment
 * time. Nothing is lost when that happens (it fails before signing), but a quote that cannot say
 * whether it is affordable leaves the one question the user is asking unanswered.
 * `credential_preflight` already answers it for credentials; this is the policy-write equivalent.
 *
 * IT MIRRORS THE PAYER, NOT A SIMPLIFICATION OF IT. Three rules, each copied from the code that
 * enforces them when paying, so "affordable" here means "the payer would not refuse it for these
 * reasons":
 *  - the FEE ASSET balance must cover the quoted amount (`payWithReadinessCheck`);
 *  - native ZTX must be non-zero to pay gas — but ONLY when `needsNativeGasCheck` says the payer
 *    runs that guard (a self-paid ZTP20 payment; not native, not sponsored);
 *  - the quoted amount must be within the payment cap the POLICY payer carries (`describePaymentCap`
 *    over the same map `assertWithinPaymentCap` uses).
 *
 * THREE-STATE, FAIL-CLOSED. A balance that could not be read is `unknown` — never `enough` and
 * never zero. A definite shortfall outranks an unknown, because "short, and something else is
 * also unreadable" is still a no. `affordable` requires every applicable check to have positively
 * passed.
 *
 * WHAT IT DOES NOT SAY. It does not estimate the NETWORK FEE. The wallet's own pre-check refuses a ZTX
 * balance of exactly zero, but the payment library then compares ZTX against an estimated fee this
 * check cannot see — and for a payment made IN ZTX it needs the amount PLUS that fee from one balance
 * (`PaymentEngine.checkBalance`). So a balance just above a ZTX quote, or a small non-zero ZTX balance
 * for a gas-paid token payment, is reported `enough` with `feeNotEstimated` set, and the message says
 * so. It is also a snapshot — balances move between a quote and a payment.
 */
import { describePaymentCap, describePolicyGovernedCap, type PaymentCapDescription } from '../payment-guard.js'
import type { TokenBalanceResult } from '../clients/token-balance-client.js'
import { needsNativeGasCheck } from '../accept-selection.js'
import type { PayRequirement } from '../clients/mbi-client.js'
import { renderAmount, renderCapBlocker } from './preflight.js'

const NATIVE = 'ZTX'
const MAX_DETAIL = 160
/** The longest any one line in `problems` may be. */
const MAX_PROBLEM = 300
const UINT = /^\d+$/

export type AffordabilityVerdict = 'affordable' | 'not_affordable' | 'unknown'
export type CheckStatus = 'enough' | 'short' | 'unknown'

export interface Affordability {
  verdict: AffordabilityVerdict
  /** The fee asset against the quoted amount. */
  fee: { status: CheckStatus; required: string; balance?: string; display?: string }
  /** Native ZTX for gas. `not_needed` when the payer does not run the guard for this payment. */
  gas: { status: CheckStatus | 'not_needed'; balance?: string }
  /**
   * The payment cap the policy payer carries, described against the quoted amount. Absent only on the
   * fallback an orchestrator builds when the check itself failed — it must not invent a cap, which an
   * agent reading the structured field could take as "no cap key matches this asset".
   */
  cap?: PaymentCapDescription
  /**
   * True when the wallet will also pay a network fee this check did not estimate: any payment made in
   * ZTX (amount plus fee from one balance) and any gas-paid token payment. An `affordable` verdict
   * with this set means "holds the amount", not "will certainly clear".
   */
  feeNotEstimated: boolean
  /** One line per cause, each stated separately so one round of fixes is enough. */
  problems: string[]
  /** What this check cannot see, so a green result is not read as a guarantee. */
  notChecked: string[]
}

/** What `checkAffordability` itself returns: the cap is always described. */
export type CheckedAffordability = Affordability & { cap: PaymentCapDescription }

export interface AffordabilityDeps {
  /** Contracted to report failure as `{ error }`; a throw is still contained here. */
  queryBalance: (token: string) => Promise<TokenBalanceResult>
  /** The map `payForPolicyWrite` carries — undefined means no cap is enforced. */
  caps: Record<string, string> | undefined
  /** True when the owner's spending policy governs the asset, so the default cap is not applied. */
  policyGoverns?: (asset: string) => Promise<boolean>
}

/** What the orchestrator hands over: the chosen 402 option, typed loosely on purpose. */
export type AffordabilityQuote = Record<string, unknown>

function clip(text: string, max = MAX_DETAIL): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

async function read(deps: AffordabilityDeps, token: string): Promise<TokenBalanceResult> {
  try {
    return await deps.queryBalance(token)
  } catch {
    return { token, error: 'query_failed' }
  }
}

export async function checkAffordability(
  deps: AffordabilityDeps,
  accept: AffordabilityQuote,
): Promise<CheckedAffordability> {
  const asset = clip(String(accept.asset ?? ''), 100)
  const required = String(accept.maxAmountRequired ?? '')
  const problems: string[] = []
  const notChecked = [
    'A snapshot: balances and the cap can change between this quote and the payment.',
    'The network fee. This check only catches a ZTX balance of zero: the payer then compares ZTX against an ' +
      'estimated fee it cannot see, and a payment made in ZTX needs the amount plus that fee from one balance.',
    'Whether the wallet address is activated on chain. A never-activated address reads a balance of 0 and ' +
      'shows here as an ordinary shortfall, while the payer reports it as not activated.',
  ]

  const cap =
    deps.policyGoverns && (await deps.policyGoverns(asset))
      ? describePolicyGovernedCap(asset)
      : describePaymentCap(asset, required, deps.caps)

  // Nothing to price against. An unparseable amount is a fault in the QUOTE, not a finding about
  // the wallet, so it is unknown rather than a shortfall.
  if (asset === '' || !UINT.test(required)) {
    problems.push('The quote did not carry a usable asset and amount, so nothing could be compared.')
    return {
      verdict: 'unknown',
      fee: { status: 'unknown', required: clip(required, 40) },
      gas: { status: 'unknown' },
      cap,
      feeNotEstimated: false,
      problems,
      notChecked,
    }
  }

  const wantGas = asset !== NATIVE && needsNativeGasCheck(accept as unknown as PayRequirement)
  const [feeBalance, gasBalance] = await Promise.all([
    read(deps, asset),
    wantGas ? read(deps, NATIVE) : Promise.resolve(undefined),
  ])

  let fee: Affordability['fee']
  if ('error' in feeBalance) {
    fee = { status: 'unknown', required }
    problems.push(`Could not read the ${asset} balance (${clip(String(feeBalance.error), 60)}) — the fee cannot be checked.`)
  } else if (BigInt(feeBalance.balance) < BigInt(required)) {
    fee = { status: 'short', required, balance: feeBalance.balance, display: feeBalance.display }
    problems.push(
      `Not enough ${clip(feeBalance.token, 40)}: the quote is ${renderAmount(required, feeBalance)}, ` +
        `the balance is ${clip(feeBalance.display, 60)}.` +
        (asset === NATIVE ? ' The payer needs the amount plus the network fee from this one balance.' : ''),
    )
  } else if (asset === NATIVE && BigInt(feeBalance.balance) === BigInt(required)) {
    // For ZTX the payer needs amount PLUS fee from one balance (PaymentEngine.checkBalance), and the
    // fee is never zero — so a balance equal to the quote has nothing left for it.
    fee = { status: 'short', required, balance: feeBalance.balance, display: feeBalance.display }
    problems.push(
      `Not enough ZTX: the quote is ${renderAmount(required, feeBalance)} and the balance is exactly that, ` +
        `leaving nothing for the network fee, which the payer needs on top of the amount.`,
    )
  } else {
    fee = { status: 'enough', required, balance: feeBalance.balance, display: feeBalance.display }
  }

  let gas: Affordability['gas']
  if (!gasBalance) {
    gas = { status: 'not_needed' }
  } else if ('error' in gasBalance) {
    gas = { status: 'unknown' }
    problems.push(`Could not read the ZTX balance (${clip(String(gasBalance.error), 60)}) — ZTX pays network gas and is separate from the fee.`)
  } else if (BigInt(gasBalance.balance) === 0n) {
    gas = { status: 'short', balance: gasBalance.balance }
    problems.push('No ZTX for network gas. ZTX is separate from the fee asset and is needed to pay it.')
  } else {
    gas = { status: 'enough', balance: gasBalance.balance }
  }

  let capShort = false
  if (!cap.wouldPass) {
    capShort = true
    // The credential preflight's own wording, which also says when the cap that applied came from the
    // "*" fallback because no entry is keyed by this asset — a bare "the cap for ZTX is 0" would send
    // the user looking for a ZTX entry that was never there.
    problems.push(renderCapBlocker(cap, required, feeBalance))
  }

  const short = fee.status === 'short' || gas.status === 'short' || capShort
  const unknown = fee.status === 'unknown' || gas.status === 'unknown'
  return {
    verdict: short ? 'not_affordable' : unknown ? 'unknown' : 'affordable',
    fee,
    gas,
    cap,
    feeNotEstimated: asset === NATIVE || wantGas,
    // Bounded HERE, once, rather than at each site that builds a line: the quoted amount comes from the
    // service and can be tens of thousands of digits, and the fee line, the cap line and the structured
    // field an agent reads would each echo it. A per-site clip is what the review of the cap line missed.
    problems: problems.map((p) => clip(p, MAX_PROBLEM)),
    notChecked,
  }
}
