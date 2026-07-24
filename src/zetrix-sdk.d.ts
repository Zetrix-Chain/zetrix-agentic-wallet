/**
 * Minimal ambient declaration for `zetrix-sdk-nodejs` (ships no types).
 * We only use the read-only `contract.call` query path — the same one
 * `x402-zetrix-client` uses for on-chain balance/contract lookups.
 */
declare module 'zetrix-sdk-nodejs' {
  interface ContractCallArgs {
    contractAddress: string
    input: string
    optType: number
    sourceAddress?: string
  }
  interface ContractCallResult {
    errorCode?: number
    result?: { query_rets?: Array<{ result?: { value?: string } }> }
  }
  interface ZetrixContract {
    call(args: ContractCallArgs): Promise<ContractCallResult>
  }
  class ZtxChainSDK {
    constructor(options: { host: string; port?: string; secure?: boolean })
    contract: ZetrixContract
  }
  export = ZtxChainSDK
}
