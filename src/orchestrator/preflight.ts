/**
 * credential_preflight — one read-only answer to "can this wallet buy this credential, and what
 * will it cost?", assembled before a single application field is collected.
 *
 * Nothing here signs a transaction or moves funds. Every input is either a free chain read or a
 * phase-1 quote, which servers issue without a payment header.
 *
 * The problem it exists for: cost used to be discovered only by attempting to pay, and the two
 * things that can block a payment — the balance and the spending cap — were separate, sequential
 * failures. A user topped up, retried, and only then met the cap. Preflight reports **every**
 * blocker at once, so one round of fixes is enough.
 *
 * What it deliberately does NOT do is claim more certainty than it has. `notChecked` names the
 * things no amount of preflight can settle — chiefly whether the agent name is still free, which
 * myid only decides at issuance. A preflight that implied otherwise would turn a surprising
 * duplicate charge into one the wallet had promised would not happen.
 */

import { describePaymentCap, describePolicyGovernedCap, type PaymentCapDescription } from '../payment-guard.js'
import type { TokenBalanceResult } from '../clients/token-balance-client.js'

/** The Verified AI Birthcert (myid SSIVC), as opposed to a template-issued credential. */
export const VERIFIED_AI_BIRTHCERT = 'verified_ai_birthcert'

/** Native gas is quoted under this asset code, never a contract address. */
const NATIVE = 'ZTX'

export interface PreflightFee {
  /** Native `ZTX` or a ZTP20 contract address — read it rather than assuming. */
  asset: string
  /** Raw base units, the unit the cap compares in. */
  maxAmountRequired: string
  payTo?: string
  /** Which side pays network gas. Absent when the server quoted no gas model. */
  gasModel?: 'sponsored' | 'self'
  /** The fee in whole tokens with its symbol, when the balance read resolved decimals. */
  display?: string
  /**
   * Whether MBI will actually charge `maxAmountRequired`.
   *
   * `false` means issuance is currently free: the amount above is indicative — what it WOULD cost
   * if payment were switched back on — and neither the balance nor the cap gates it. Gas still
   * does, when this wallet self-pays it: gas is not the fee.
   *
   * ABSENT means unknown (an older MBI deployment without this field) and is treated exactly like
   * chargeable. Reading silence as "free" would under-report a real cost.
   */
  paymentRequired?: boolean
}

/** A valid credential the wallet already holds, as preflight reports it. Names what it is; carries no personal data. */
export interface HeldCredential {
  label: string
  vcId?: string
  validUntil?: string
}

export interface PreflightResult {
  credential: string
  /**
   * Set when the wallet already holds a valid copy of this credential. Without `replacing` that stops preflight (nothing
   * is priced and `ready` is false); with it, preflight carries on and this says what would be replaced.
   */
  alreadyHeld?: HeldCredential & { replacing?: true }
  /** True only when nothing in `blockers` stands in the way. */
  ready: boolean
  fee?: PreflightFee
  /** The fee asset, plus native ZTX whenever this wallet would pay its own gas. */
  balances: TokenBalanceResult[]
  cap?: PaymentCapDescription
  /** A template's declared attributes, when the credential is template-issued. */
  schema?: { required: string[]; optional: string[] }
  /** Everything standing in the way, together — never one at a time. */
  blockers: string[]
  /** What preflight could not verify, so a clean result is not mistaken for a guarantee. */
  notChecked: string[]
}

export interface PreflightInput {
  /** `VERIFIED_AI_BIRTHCERT`, or a templateId / known template name. */
  credential: string
  /**
   * Only used for the Verified path, and only to satisfy the server — the fee does not depend on
   * it. A caller pricing the credential before the user has chosen a name may omit it, and must not
   * present the placeholder as the name that will be used.
   */
  agentName?: string
  /**
   * Set ONLY when the user has said they want a replacement for the credential they already hold. It is an instruction
   * to the agent like `confirm`, never to be passed on its own judgement; without exactly `true`, a held credential
   * stops preflight.
   */
  replacing?: boolean
}

export interface PreflightDeps {
  /** Whether the wallet already holds a valid copy of the credential, answered locally. Optional: absent, nothing is checked. */
  findHeld?: (credential: string) => Promise<HeldCredential | undefined>
  /** `requestAiBirthcertVerification` with `dryRun`, returning `{ quote }` or `{ error }`. */
  quoteVerified: (input: { agentName: string; dryRun: true }) => Promise<Record<string, unknown>>
  /** `subscribeAndIssue` with `dryRun`, returning `{ quote, schema? }` or `{ reason }`. */
  quoteTemplate: (templateId: string) => Promise<Record<string, unknown>>
  queryTokenBalance: (token: string) => Promise<TokenBalanceResult>
  caps: Record<string, string> | undefined
  /** True when the owner's spending policy governs the asset, so the default cap is not applied. */
  policyGoverns?: (asset: string) => Promise<boolean>
}

/**
 * A name that is obviously provisional. The server rejects a body without one, but the fee is
 * name-independent, so pricing before the user has chosen is legitimate — provided nothing ever
 * shows this string to them or reuses it at issuance.
 */
function placeholderAgentName(): string {
  return `preflight-quote-only-${Date.now()}`
}

export async function credentialPreflight(deps: PreflightDeps, input: PreflightInput): Promise<PreflightResult> {
  const blockers: string[] = []
  const notChecked: string[] = []
  const isVerified = input.credential === VERIFIED_AI_BIRTHCERT

  // FIRST, and free: if the wallet already holds this credential, nothing below matters. The paid call has its own guard
  // against replacing a valid credential, but by then the agent has already walked the user through choosing a name.
  let alreadyHeld: PreflightResult['alreadyHeld']
  if (deps.findHeld) {
    try {
      const found = await deps.findHeld(input.credential)
      if (found) {
        const replacing = input.replacing === true
        alreadyHeld = { ...found, ...(replacing ? { replacing: true as const } : {}) }
        if (!replacing) {
          const until = found.validUntil ? ` (valid until ${found.validUntil.slice(0, 10)})` : ''
          return {
            credential: input.credential,
            ready: false,
            alreadyHeld,
            balances: [],
            blockers: [
              `This wallet already holds a valid ${found.label}${until}${found.vcId ? `, ${found.vcId}` : ''}. Tell the user, and do not start another: ` +
                `a new one would REPLACE it (the wallet keeps one per template) and costs the fee. Only if the user explicitly says they want a ` +
                `replacement, run this check again with replacing: true.`,
            ],
            notChecked: [],
          }
        }
      } else {
        notChecked.push(
          'Preflight only looks at credentials this wallet has already saved. A credential that was paid for and issued but not yet collected with ' +
            'check_ai_birthcert_verification would not show here.',
        )
      }
    } catch (e) {
      // Never "nothing is held": the lookup failing says nothing about what the wallet holds.
      notChecked.push(
        `Whether this wallet already holds one could not be checked (${e instanceof Error ? e.message : String(e)}), so do not assume it does not.`,
      )
    }
  }

  const quoted = isVerified
    ? await deps.quoteVerified({ agentName: input.agentName?.trim() || placeholderAgentName(), dryRun: true })
    : await deps.quoteTemplate(input.credential)

  const quote = quoted.quote as
    | { asset?: string; maxAmountRequired?: string; payTo?: string; gasModel?: string; paymentRequired?: boolean }
    | undefined
  const schema = quoted.schema as PreflightResult['schema'] | undefined

  if (!quote) {
    // A quote is free, so failing to get one is a real blocker rather than a reason to guess a price.
    const why = String(quoted.error ?? quoted.reason ?? 'the price could not be read')
    return {
      credential: input.credential,
      ready: false,
      balances: [],
      ...(alreadyHeld ? { alreadyHeld } : {}),
      ...(schema ? { schema } : {}),
      blockers: [`Could not price this credential: ${why}`],
      notChecked: [...notChecked, ...uncheckable(isVerified)],
    }
  }

  const asset = String(quote.asset ?? '')
  const requiredRaw = String(quote.maxAmountRequired ?? '0')
  const gasModel = quote.gasModel === 'sponsored' || quote.gasModel === 'self' ? quote.gasModel : undefined

  // Native gas is only this wallet's problem when it self-pays. Asking for it under sponsorship
  // would report a blocker the paymaster is about to cover — which is what sponsorship is for.
  const selfPaysGas = gasModel !== 'sponsored'
  const wanted = asset === NATIVE || !selfPaysGas ? [asset] : [asset, NATIVE]

  // Independent reads — run concurrently so the user gets every blocker in one round trip,
  // not the fee balance now and the gas balance only after that resolves.
  //
  // `queryTokenBalance` is contracted to report failure as `{ error }` rather than throwing, which
  // is what makes Promise.all safe here: with a throwing implementation it would surface whichever
  // read rejected first instead of the fee asset's error specifically, and reject the whole
  // preflight rather than reporting a partial answer. If that contract ever loosens, this needs
  // allSettled.
  const balances: TokenBalanceResult[] = await Promise.all(wanted.map((token) => deps.queryTokenBalance(token)))

  // MBI reports free-vs-paid separately from the amount: in free mode `accepts[]` still
  // carries a full price nobody will be charged. Gating on that price sends the user to fund a
  // credential this same call already knows is free — which happened live in practice, a real
  // top-up that was never spent. Strictly `=== false`: an absent flag is an older MBI without this field,
  // i.e. unknown, and unknown must keep behaving as chargeable rather than be read as free.
  const isFree = quote.paymentRequired === false

  const feeBalance = balances[0]
  if ('error' in feeBalance) {
    // Worth reporting even when free: the same read backs the gas check and the `display` amount,
    // and a silent failure there would make a clean result look better verified than it is.
    blockers.push(`Could not read the ${asset} balance (${feeBalance.error}) — retry before paying.`)
  } else if (!isFree && BigInt(feeBalance.balance) < BigInt(requiredRaw)) {
    blockers.push(`Not enough ${feeBalance.token}: the fee is ${renderAmount(requiredRaw, feeBalance)}, the balance is ${feeBalance.display}.`)
  }

  if (selfPaysGas && asset !== NATIVE) {
    const gas = balances[1]
    if (gas && 'error' in gas) {
      blockers.push(`Could not read the ZTX balance (${gas.error}) — ZTX pays network gas and is separate from the fee.`)
    } else if (gas && BigInt(gas.balance) === 0n) {
      blockers.push(`No ZTX for network gas. ZTX is separate from the ${feeBalance.token ?? asset} fee and is needed for every transaction.`)
    }
  }

  // The cap limits what may be SPENT, so it cannot stand in the way of spending nothing. Still
  // described in the result (headroom is worth seeing) — it just raises no blocker when free.
  const cap =
    deps.policyGoverns && (await deps.policyGoverns(asset))
      ? describePolicyGovernedCap(asset)
      : describePaymentCap(asset, requiredRaw, deps.caps)
  if (!cap.wouldPass && !isFree) blockers.push(renderCapBlocker(cap, requiredRaw, feeBalance))

  return {
    credential: input.credential,
    ready: blockers.length === 0,
    fee: {
      asset,
      maxAmountRequired: requiredRaw,
      ...(quote.payTo ? { payTo: String(quote.payTo) } : {}),
      ...(gasModel ? { gasModel } : {}),
      ...('error' in feeBalance ? {} : { display: renderAmount(requiredRaw, feeBalance) }),
      ...(quote.paymentRequired === undefined ? {} : { paymentRequired: quote.paymentRequired }),
    },
    balances,
    cap,
    ...(alreadyHeld ? { alreadyHeld } : {}),
    ...(schema ? { schema } : {}),
    blockers,
    notChecked: [...notChecked, ...uncheckable(isVerified, isFree)],
  }
}

/** Render a raw amount using the decimals the balance read already resolved. */
export function renderAmount(raw: string, balance: TokenBalanceResult): string {
  if ('error' in balance || balance.decimals === null) return raw
  const d = BigInt(10) ** BigInt(balance.decimals)
  const whole = BigInt(raw) / d
  const frac = (BigInt(raw) % d).toString().padStart(balance.decimals, '0').replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} ${balance.token}`
}

/**
 * `feeBalance` came from a query FOR `cap.asset` (`requiredRaw`'s asset), so its `decimals`/`token`
 * apply equally to `cap.capRaw` — same asset, just a different raw amount. Rendering both through
 * it (like the balance blocker above) is what keeps this message consistent with the rest of
 * preflight's output — reported live: a caller relaying "the fee is 1 JMYR, wallet holds 0 JMYR"
 * alongside "issuance requires 1,000,000" (this function, unrendered) had no way to tell that
 * second number was already the same unit, not a distinct raw count needing its own conversion.
 */
export function renderCapBlocker(cap: PaymentCapDescription, requiredRaw: string, feeBalance: TokenBalanceResult): string {
  const requiredHuman = renderAmount(requiredRaw, feeBalance)
  if (cap.capRaw === null) {
    return `No spending limit applies to ${cap.asset}, and limits are configured — so this payment would be refused. Set a limit keyed by "${cap.asset}".`
  }
  const capHuman = renderAmount(cap.capRaw, feeBalance)
  const misKeyed = cap.matchedKey !== cap.asset
  return misKeyed
    ? `The spending limit that applies is ${capHuman} (from the "*" fallback — no limit is set for ${cap.asset}), and this needs ${requiredHuman}.`
    : `The spending limit for ${cap.asset} is ${capHuman}, and this needs ${requiredHuman}.`
}

/**
 * Stated on every result, success included. A preflight that reported only problems would let a
 * clean answer read as a guarantee.
 */
function uncheckable(isVerified: boolean, isFree = false): string[] {
  const items = [
    'Whether the wallet address is activated on chain — a never-funded address fails differently from a low balance.',
  ]
  if (isVerified) {
    items.unshift(
      'Whether the agent name is still free. myid checks uniqueness at issuance, not now, so a name in use still prices normally and is only refused after payment.',
    )
  }
  // `paymentRequired` is a service-wide MBI setting, not a property of this
  // template, and suppressing the balance and cap blockers on it is what lets preflight return
  // `ready: true` for a wallet holding nothing. If payment is switched back on between this quote
  // and the apply, that answer was wrong and the user finds out at issuance. The suppression is
  // still right — the whole point of this design is to stop treating a nominal price as a
  // charge — but this is exactly the kind of caveat `notChecked` exists to carry.
  if (isFree) {
    items.unshift(
      'Whether issuance is still free at apply time — `paymentRequired` is a service-wide MBI setting and can change between this quote and issuance.',
    )
  }
  return items
}
