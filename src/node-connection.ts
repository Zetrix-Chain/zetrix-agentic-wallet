/**
 * How the wallet reaches the Zetrix node.
 *
 * zetrix-sdk-nodejs uses plain http unless `secure: true` is passed, and builds its URL from the scheme and `host` only (a
 * separate `port` is ignored). The mainnet node refuses a POSTed contract call over http ("request must be in json format"), so
 * every SDK the wallet builds has to be told, and so does the one inside the payment library (see {@link secureNodeForPaymentEngine}).
 */

import ZtxChainSDK from 'zetrix-sdk-nodejs'

export interface NodeConnection {
  nodeHost: string
  nodePort: string
  nodeSecure: boolean
}

/** The wallet's own SDK for the node: https unless the configuration says otherwise. */
export function createNodeSdk(c: NodeConnection) {
  return new ZtxChainSDK({ host: c.nodeHost, port: c.nodePort, secure: c.nodeSecure })
}

/** The seam `x402-zetrix-client`'s `PaymentEngine` builds its SDK through (used for its nonce, fee and balance lookups). */
interface SdkFactory {
  _createSdk?: (node: { host: string; port: string }) => unknown
}

/**
 * x402-zetrix-client's `PaymentEngine` builds its own SDK with no way to pass `secure`, so on mainnet its nonce, fee and balance
 * lookups reach the node over http and fail (a ZTP20 balance reads as "0"). It builds that SDK through `_createSdk`, which is the
 * seam its own tests replace; replacing it here makes it build the same https SDK as the rest of the wallet.
 *
 * Returns false when the library has no such seam (a changed version), so the caller can say so instead of failing quietly.
 */
export function secureNodeForPaymentEngine(engine: SdkFactory, secure: boolean): boolean {
  if (typeof engine._createSdk !== 'function') return false
  engine._createSdk = (node) => new ZtxChainSDK({ host: node.host, port: node.port, secure })
  return true
}
