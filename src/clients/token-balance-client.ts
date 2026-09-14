/**
 * TokenBalanceClient — the balance lookup backing `wallet_status({ token })`.
 *
 * Deliberately does NOT use `PaymentEngine.fetchZTP20Balance`/`fetchAccountInfo`: both
 * collapse every failure (non-zero errorCode, missing field, malformed JSON) into
 * `{ balance: '0' }`, so an unreachable node or a wrong contract address is indistinguishable
 * from genuinely holding nothing — and because they return normally, a caller's try/catch
 * never fires. Here a failed lookup throws, so `queryTokenBalance` can report `query_failed`
 * instead of a fabricated zero.
 *
 * Balances stay in the asset's raw base units (the unit x402 quotes `maxAmountRequired` in, so
 * cap checks and quote comparisons remain integer-only). `decimals` is reported alongside
 * rather than applied, so the caller can render `473999900` as `473.9999` without this module
 * doing float math on a financial value.
 */

import { fetchTokenInfo, formatHumanAmount, type ContractQuery } from './token-info-client.js'

/** Native ZETRIX is quoted in ZETA: 1 ZETRIX = 1,000,000 ZETA. */
export const ZTX_DECIMALS = 6

export type TokenBalanceResult =
  | {
      token: string
      balance: string
      decimals: number | null
      /**
       * The balance in whole tokens with its symbol, e.g. `473.9999 JMYR`. `balance` stays raw so
       * cap checks and quote comparisons remain integer-only; this exists so neither the agent nor
       * the user has to divide by 10^decimals before deciding whether they can afford something —
       * a raw count beside a ticker reads as whole tokens and is off by orders of magnitude.
       * Falls back to raw units (still labelled) when `decimals` is unreadable, rather than guessing.
       */
      display: string
    }
  | { token: string; error: 'unknown_token' | 'query_failed' }

export interface TokenBalanceDeps {
  /** The holder address whose balance is being read. */
  address: string
  /** Native ZTX balance in ZETA. Must reject (not resolve '0') when the lookup fails. */
  fetchNativeBalance: (address: string) => Promise<string>
  /** Resolve a token symbol to its ZTP20 contract address on the active network; null when unregistered. */
  resolveTokenAddress: (symbol: string) => string | null
  /** Read-only contract query seam (a `sdk.contract.call`-shaped call). */
  query: ContractQuery
}

/** The shape of a `sdk.account.getInfo` response, as much of it as this module reads. */
export interface AccountInfoResponse {
  errorCode?: number
  result?: { balance?: unknown; nonce?: unknown } | null
}

/**
 * Extract the native ZTX balance from a `getInfo` response.
 *
 * **The node omits `balance` entirely when it is zero.** Verified against test-node.zetrix.com on
 * 4 August 2026 — a funded account returns `balance: 1333492010`, while an activated account holding
 * nothing, a contract account, and a never-activated account all return no `balance` key at all
 * (confirmed on both `/getAccount` and `/getAccountBase`, and through the SDK).
 *
 * This used to require `typeof balance === 'string'` and throw otherwise, which made a zero balance
 * indistinguishable from an unreadable one — `wallet_status({ token: 'ZTX' })` reported
 * `query_failed` for every account with no ZTX. A successful RPC that omits a zero-valued field is a
 * successful read, so absence now means `'0'`.
 *
 * The strictness that remains is deliberate and is the point of this module: a non-zero `errorCode`,
 * or a response with no `result` at all, still throws rather than reporting a fabricated zero. That
 * is what keeps an unreachable node from looking like an empty wallet.
 *
 * The SDK hands us a string even though the raw node emits a JSON number, so numbers are accepted
 * too rather than trusting that conversion to hold forever.
 */
export function parseNativeBalance(res: AccountInfoResponse | null | undefined): string {
  if (res?.errorCode !== 0) throw new Error(`getInfo failed with errorCode ${res?.errorCode}`)
  if (res.result === undefined || res.result === null) throw new Error('getInfo returned no result')

  const balance = res.result.balance
  if (typeof balance === 'string') return balance
  if (typeof balance === 'number' && Number.isFinite(balance)) return String(balance)
  if (balance === undefined || balance === null) return '0'
  throw new Error(`getInfo returned an unusable balance of type ${typeof balance}`)
}

/**
 * Read a ZTP20 `balanceOf` and return the raw base-unit balance. Throws on any RPC error,
 * missing field, or malformed payload — never substitutes a zero.
 */
export async function fetchZTP20BalanceStrict(
  contractAddress: string,
  address: string,
  query: ContractQuery,
): Promise<string> {
  const result = await query({
    contractAddress,
    input: JSON.stringify({ method: 'balanceOf', params: { address } }),
    optType: 2,
  })
  if (result?.errorCode !== 0) {
    throw new Error(`balanceOf failed with errorCode ${result?.errorCode}`)
  }
  const raw = result.result?.query_rets?.[0]?.result?.value
  if (raw === undefined || raw === null || raw === '') {
    throw new Error('balanceOf returned no value')
  }
  // The query dispatcher wraps the handler's return under its key: {"balance": "..."}.
  const parsed = JSON.parse(raw) as { balance?: unknown }
  const balance = parsed?.balance
  if (typeof balance !== 'string') {
    throw new Error('balanceOf returned no balance field')
  }
  // Raw base units are always a non-negative integer. Any contract matching
  // looksLikeContractAddress() is queried here, not only registry-known tokens (R10a) — an
  // unverified contract returning a non-numeric string must fail the read, not pass it through
  // as a "successful" balance that BigInt() later throws on unguarded (preflight.ts).
  if (!/^\d+$/.test(balance)) {
    throw new Error(`balanceOf returned a non-numeric balance: ${JSON.stringify(balance)}`)
  }
  return balance
}

/**
 * Resolve one token symbol to `{ balance, decimals }` for the configured holder. A failed
 * balance read reports `query_failed`; an unregistered symbol reports `unknown_token`. A failed
 * *decimals* read is not fatal — the balance is still returned, with `decimals: null`, since a
 * raw balance is more useful than no answer.
 */
/**
 * A Zetrix contract address, as the x402 challenge's `asset` field carries it (and as
 * MAX_PAYMENT_AMOUNT must be keyed). Deliberately shape-only — this is a routing decision between
 * "look this up in the registry" and "this IS the contract", not validation. A malformed address
 * still fails at the chain read and reports `query_failed`, which is the honest answer.
 */
function looksLikeContractAddress(token: string): boolean {
  return /^ZTX[0-9A-Za-z]{30,}$/.test(token)
}

export async function queryTokenBalance(deps: TokenBalanceDeps, token: string): Promise<TokenBalanceResult> {
  const symbol = token.toUpperCase()

  if (symbol === 'ZTX') {
    try {
      const balance = await deps.fetchNativeBalance(deps.address)
      return { token: symbol, balance, decimals: ZTX_DECIMALS, display: renderDisplay(balance, ZTX_DECIMALS, symbol) }
    } catch {
      return { token: symbol, error: 'query_failed' }
    }
  }

  // Registry first so a known symbol keeps resolving per-network; otherwise accept the raw contract
  // address. The cap is keyed by address and this lookup took a symbol, so the same token had to be
  // named two opposite ways on two adjacent surfaces — passing the address returned `unknown_token`,
  // which reads as "no such token" rather than "wrong spelling".
  const registered = deps.resolveTokenAddress(symbol)
  const byAddress = registered === null && looksLikeContractAddress(token)
  const contractAddress = registered ?? (byAddress ? token : null)
  if (!contractAddress) return { token: symbol, error: 'unknown_token' }

  // Never echo an upper-cased address: `symbol` is `token.toUpperCase()`, which is fine for a ticker
  // but corrupts a case-sensitive address. Report the address as given until the chain tells us its
  // real symbol below.
  const asked = byAddress ? token : symbol

  let balance: string
  try {
    balance = await fetchZTP20BalanceStrict(contractAddress, deps.address, deps.query)
  } catch {
    return { token: asked, error: 'query_failed' }
  }

  const info = await fetchTokenInfo(contractAddress, deps.query)
  // Asked by address, answer by name — the caller learns which token that contract actually is.
  const label = byAddress ? info?.symbol ?? asked : symbol
  const decimals = info?.decimals ?? null
  return { token: label, balance, decimals, display: renderDisplay(balance, decimals, label) }
}

/** `473999900` + 6 decimals -> `473.9999 JMYR`. Unreadable decimals keep the raw count, still labelled. */
function renderDisplay(raw: string, decimals: number | null, label: string): string {
  return `${decimals === null ? raw : formatHumanAmount(raw, decimals)} ${label}`
}
