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
