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
  /**
   * Decimals as the contract reported them, or `0` when the field was absent or unreadable.
   * *Check {@link TokenInfo.decimalsReadable} before doing arithmetic with this.*
   */
  decimals: number
  /**
   * FALSE when `decimals` is the 0 fallback rather than a value the contract actually reported.
   *
   * A display path can live with the fallback — it renders a number either way. A path that
   * CONVERTS an amount cannot: unreadable-as-0 is indistinguishable from a genuine 0-decimal token,
   * and "send 10 JMYR" then means 10 base units, or 0.00001 JMYR, while the caller is told 10 was
   * sent. transfer_token refuses on `false` rather than convert against a guess.
   */
  decimalsReadable: boolean
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
    // A non-integer or negative decimals is as unusable as a missing one — `toHumanAmount` with
    // -1 happily returns a wrong answer rather than failing, so it is rejected here, at the read.
    const readable = Number.isInteger(decimals) && decimals >= 0
    return { symbol: info.symbol, decimals: readable ? decimals : 0, decimalsReadable: readable }
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

/** Native ZETRIX is quoted in ZETA: 1 ZTX = 1,000,000 ZETA — mirrors token-balance-client.ts's
 * ZTX_DECIMALS. Duplicated rather than imported: that module already imports from this one, and
 * importing back would create a cycle. */
const ZTX_DECIMALS = 6

/**
 * Resolve an x402 asset's display symbol AND decimals, for rendering a human-readable amount in
 * an error/status message. Unlike {@link resolveAssetSymbol}, always returns a `decimals` value —
 * falls back to 0 (no conversion — the caller shows the raw integer) for an empty asset or a
 * failed contract lookup, so a payment amount is never lost even when it can't be humanized.
 */
export async function resolveAssetInfo(asset: string, query: ContractQuery): Promise<TokenInfo> {
  // Native decimals are a constant, not a contract read, so they are genuinely known.
  if (asset === 'ZTX') return { symbol: 'ZTX', decimals: ZTX_DECIMALS, decimalsReadable: true }
  // These two ARE the 0 fallback this display path tolerates — flagged so that a caller which
  // CONVERTS an amount cannot mistake them for a genuine 0-decimal token.
  if (asset === '') return { symbol: '', decimals: 0, decimalsReadable: false }
  const info = await fetchTokenInfo(asset, query)
  return info ?? { symbol: asset, decimals: 0, decimalsReadable: false }
}

/**
 * Render a raw base-unit integer string as a human decimal amount, using BigInt arithmetic
 * throughout so a financial value never goes through floating point (same discipline as
 * token-balance-client.ts's docblock describes). `decimals <= 0` (unknown, or genuinely
 * integer-only) returns `raw` unchanged rather than guessing a conversion.
 */
export function formatHumanAmount(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw) || decimals <= 0) return raw
  const base = 10n ** BigInt(decimals)
  const value = BigInt(raw)
  const wholePart = value / base
  const fracPart = value % base
  if (fracPart === 0n) return wholePart.toString()
  const fracStr = fracPart.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${wholePart}.${fracStr}`
}
