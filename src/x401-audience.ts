/**
 * The audience a presentation is made for: the origin of the verifier THIS WALLET PRESENTS TO.
 *
 * The verifier checks that a presentation names it as its audience, so a presentation made for one verifier is not accepted by another. The
 * audience is taken from the wallet's own configuration, the same verifier address the x401 client resolves and submits to, and NOT from
 * the challenge: the `request_uri` in a PROOF-REQUEST is whatever the resource server wrote. A hostile (or merely differently-hosted)
 * resource server could otherwise make the wallet sign an audience that no verifier it uses will accept, after which the challenge is spent.
 *
 * It is an origin: `scheme://host[:port]`, lower case, the default port dropped, no path. That is the form the verifier compares with the
 * origin of its own response address, so a bare host or a full URL would never match.
 */
import { defineConfig } from 'x401-zetrix-client'
import type { ZetrixNetwork } from 'x401-zetrix-client'

/** `scheme://host[:port]` of an http(s) URL, lower case, default port dropped; undefined when it is not one. */
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    // URL.host already lower-cases the host and drops a default port for its own scheme.
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
}

/**
 * The origin of the verifier the x401 client will present to: an explicit `OID4VP_BASE_URL` when one is set, otherwise the one the client
 * derives from the network. Resolved by the client's own `defineConfig`, so the two can never disagree. Undefined when neither gives a usable
 * address, in which case the presentation is simply not bound to an audience.
 */
export function verifierOrigin(config: { oid4vpBaseUrl?: string; network: string }): string | undefined {
  try {
    const resolved = defineConfig({ oid4vpBaseUrl: config.oid4vpBaseUrl, network: config.network as ZetrixNetwork })
    return originOf(resolved.oid4vpBaseUrl)
  } catch {
    return undefined
  }
}
