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
  interface SubmitResult {
    errorCode?: number
    errorDesc?: string
    result?: { hash?: string }
  }
  interface ZetrixTransaction {
    /** Broadcast an already-signed blob. `signature` is [{ signData, publicKey }]. */
    submit(args: { blob: string; signature: Array<{ signData: string; publicKey: string }> }): Promise<SubmitResult>
  }
  class ZtxChainSDK {
    constructor(options: { host: string; port?: string; secure?: boolean })
    contract: ZetrixContract
    account: ZetrixAccount
    transaction: ZetrixTransaction
  }
  export = ZtxChainSDK
}

/**
 * `zetrix-encryption-nodejs` ships no types. Only `keypair.checkAddress` is declared, because it is
 * the only thing this wallet calls: the SDK's own checksum validator, the same one
 * `zetrix-sdk-nodejs` uses for its `address: true` schema fields.
 *
 * It arrives as a transitive dependency of `zetrix-sdk-nodejs`, but is declared directly in
 * `package.json` because we now import it ourselves — a transitive dep can be dropped or moved by
 * the package above it without warning, and this one gates whether a transfer is signed.
 */
declare module 'zetrix-encryption-nodejs' {
  export const keypair: {
    /** True only when the address parses AND its checksum matches. A shape regex cannot do this. */
    checkAddress(address: string): boolean
  }
}
