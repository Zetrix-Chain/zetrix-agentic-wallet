/**
 * TokenInfoClient — resolves a payment asset's real token metadata from chain.
 *
 * An x402 `accepts[].asset` is either the literal `"ZTX"` (native coin) or a ZTP20
 * token *contract address*. The contract address alone is not a human-meaningful
 * symbol, and a 402 challenge does not carry a trustworthy symbol/decimals — so we
 * read them from the token contract itself via the ZTP20 `contractInfo` query
 * (`query_rets[0].result.value` → `{"contractInfo":{ symbol, decimals, … }}`), the
 * same read-only `contract.call` path x402-zetrix-client uses for balance lookups.
 */

export interface TokenInfo {
  symbol: string
  decimals: number
}

/** The read-only contract query seam (a `sdk.contract.call`-shaped call). Injectable for tests. */
export type ContractQuery = (args: {
  contractAddress: string
  input: string
  optType: number
}) => Promise<{
  errorCode?: number
  result?: { query_rets?: Array<{ result?: { value?: string } }> }
}>

/**
 * Read a ZTP20 contract's `contractInfo`. Returns `null` (never throws) on any RPC
 * error, missing field, malformed JSON, or a response without a `symbol`.
 */
export async function fetchTokenInfo(contractAddress: string, query: ContractQuery): Promise<TokenInfo | null> {
  let result
  try {
    result = await query({
      contractAddress,
      input: JSON.stringify({ method: 'contractInfo', params: {} }),
      optType: 2,
    })
  } catch {
    return null
  }
  if (result?.errorCode !== 0) return null
  const raw = result.result?.query_rets?.[0]?.result?.value
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { contractInfo?: Record<string, unknown> } & Record<string, unknown>
    // The query dispatcher wraps the handler's return under its key: {"contractInfo": {...}}.
    const info = (parsed.contractInfo ?? parsed) as Record<string, unknown>
    if (typeof info.symbol !== 'string' || info.symbol === '') return null
    const decimals = Number(info.decimals)
    return { symbol: info.symbol, decimals: Number.isFinite(decimals) ? decimals : 0 }
  } catch {
    return null
  }
}

/**
 * Resolve the display symbol for an x402 asset: `"ZTX"` (or empty) passes through
 * untouched; a contract address is looked up via {@link fetchTokenInfo}, falling
 * back to the raw address string when the lookup fails (so we never lose information).
 */
export async function resolveAssetSymbol(asset: string, query: ContractQuery): Promise<string> {
  if (asset === '' || asset === 'ZTX') return asset
  const info = await fetchTokenInfo(asset, query)
  return info?.symbol ?? asset
}
