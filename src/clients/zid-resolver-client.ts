/**
 * ZidResolverClient — HTTP client for the Zetrix ZID (DID) resolver.
 *
 * `GET /1.0/identifiers/{did}` → the standard DID-resolution-result envelope
 * `{ didDocument, didDocumentMetadata, didResolutionMetadata }`. We only need `didDocument`.
 * Base URL is network-dependent (sandbox for testnet, prod for mainnet — see `config.ts`).
 */

export class ZidResolverError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZidResolverError'
  }
}

export interface ZidVerificationMethod {
  id: string
  type: string
  publicKeyMultibase?: string
  publicKeyHex?: string
}

export interface ZidDidDocument {
  id: string
  verificationMethod: ZidVerificationMethod[]
}

export class ZidResolverClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async resolveDid(did: string): Promise<ZidDidDocument> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/1.0/identifiers/${did}`)
    } catch (e) {
      throw new ZidResolverError(`ZID resolver request failed for ${did}: ${(e as Error).message}`)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ZidResolverError(`ZID resolver HTTP ${res.status} for ${did}: ${text}`)
    }
    const body = (await res.json()) as { didDocument?: ZidDidDocument }
    if (!body.didDocument) {
      throw new ZidResolverError(`ZID resolver response for ${did} has no didDocument`)
    }
    return body.didDocument
  }
}
