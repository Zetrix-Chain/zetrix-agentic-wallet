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

import { fetchTokenInfo, type ContractQuery } from './token-info-client.js'

/** Native ZETRIX is quoted in ZETA: 1 ZETRIX = 1,000,000 ZETA. */
export const ZTX_DECIMALS = 6

export type TokenBalanceResult =
  | { token: string; balance: string; decimals: number | null }
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
  return balance
}

/**
 * Resolve one token symbol to `{ balance, decimals }` for the configured holder. A failed
 * balance read reports `query_failed`; an unregistered symbol reports `unknown_token`. A failed
 * *decimals* read is not fatal — the balance is still returned, with `decimals: null`, since a
 * raw balance is more useful than no answer.
 */
export async function queryTokenBalance(deps: TokenBalanceDeps, token: string): Promise<TokenBalanceResult> {
  const symbol = token.toUpperCase()

  if (symbol === 'ZTX') {
    try {
      return { token: symbol, balance: await deps.fetchNativeBalance(deps.address), decimals: ZTX_DECIMALS }
    } catch {
      return { token: symbol, error: 'query_failed' }
    }
  }

  const contractAddress = deps.resolveTokenAddress(symbol)
  if (!contractAddress) return { token: symbol, error: 'unknown_token' }

  let balance: string
  try {
    balance = await fetchZTP20BalanceStrict(contractAddress, deps.address, deps.query)
  } catch {
    return { token: symbol, error: 'query_failed' }
  }

  const info = await fetchTokenInfo(contractAddress, deps.query)
  return { token: symbol, balance, decimals: info?.decimals ?? null }
}
