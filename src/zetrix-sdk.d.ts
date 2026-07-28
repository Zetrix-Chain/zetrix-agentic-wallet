/**
 * Minimal ambient declaration for `zetrix-sdk-nodejs` (ships no types).
 * We use two read-only paths: `contract.call` (contract queries, the same one
 * `x402-zetrix-client` uses) and `account.getInfo` (native ZTX balance — called
 * directly rather than via PaymentEngine so a failed lookup is distinguishable
 * from a zero balance; see clients/token-balance-client.ts).
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
  interface AccountInfoResult {
    errorCode?: number
    /** `balance` is native ZETA (1 ZETRIX = 1,000,000 ZETA). */
    result?: { balance?: string; nonce?: string }
  }
  interface ZetrixAccount {
    getInfo(address: string): Promise<AccountInfoResult>
  }
  class ZtxChainSDK {
    constructor(options: { host: string; port?: string; secure?: boolean })
    contract: ZetrixContract
    account: ZetrixAccount
  }
  export = ZtxChainSDK
}
