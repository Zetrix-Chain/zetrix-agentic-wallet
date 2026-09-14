/**
 * MbiVpAdapter — implements x401's `VcProofProvider` by driving MBI's `/v1/vp/ext/create` +
 * `/v1/vp/ext/submit` (with `includeVp: true`), keeping the Ed25519 signature in
 * Wallet BE:
 *
 *   1. sign the holder's own address (UTF-8) via Wallet BE               → { signBlob, publicKey } (auth)
 *   2. POST /v1/vp/ext/create { vc, revealAttributes, rangeProof? }      → { blobId, blob(hex) }
 *   3. Ed25519-sign the hex `blob` via Wallet BE (injected `signHexBlob`) → { signBlob, publicKey }
 *   4. POST /v1/vp/ext/submit { blobId, signedBlob, publicKey, includeVp: true } → { id, vp }
 *   5. resolve the VC's *issuer* BBS+/Ed25519 keys (injected `resolveIssuerKeys`) for the
 *      OID4VP submit body — see `resolve-issuer-proof-keys.ts` for why.
 *
 * `/v1/vp/ext/*` accepts lightweight message-signing auth (no login/registration/subscription,
 * unlike the Zetrix BaaS the earlier VC-MCP-based adapter needed) — a self-signed Ed25519
 * signature over the holder's own address, sent as the `signedData`/`publicKey` headers. The
 * same signature (deterministic, not nonce-based) is reused for both HTTP calls in one `createVp`.
 *
 * The `ed25519PublicKey`/`bbsPublicKey` this returns are the VC's *issuer's* keys (resolved via
 * `resolveIssuerKeys`), not the holder's — confirmed against `openid4vp-verifier-be`'s
 * `VpCommonService.verifyCredentials`, which checks each VC's own issuer-signed proof(s) against
 * these two fields (its own DID-resolution fallback isn't implemented server-side). The holder's
 * Ed25519 key from `signHexBlob` above is a completely separate concern — it's what MBI's
 * `/vp/ext/submit` uses to verify *our* signature over the blob it gave us, unrelated to what the
 * OID4VP verifier checks.
 */

import type { VcProofProvider } from 'x401-zetrix-client'
import type { MbiClient } from './mbi-client.js'
import type { IssuerProofKeys } from './resolve-issuer-proof-keys.js'

/** Calls MBI's VP endpoints. Injectable so this is unit-testable without live HTTP. */
export type MbiVpCaller = Pick<MbiClient, 'createVp' | 'submitVp'>

/** Ed25519-signs a hex blob (→ Wallet BE `/sign-blob`). */
export type HexBlobSigner = (blobHex: string) => Promise<{ signBlob: string; publicKey: string }>

/** Ed25519-signs a UTF-8 message (→ Wallet BE `/sign-message`) — used for MBI's `/ext/` auth headers. */
export type MessageSigner = (message: string) => Promise<{ signBlob: string; publicKey: string }>

/** Resolves the VC's issuer's BBS+/Ed25519 verification keys (via the ZID resolver). */
export type IssuerKeyResolver = (vc: unknown) => Promise<IssuerProofKeys>

/** Per-request presentation inputs — supplied by the caller (the client holds the VC). */
export interface VcPresentInput {
  vc: unknown
  /**
   * Dotted disclosure paths (explicit override). When set — including `[]` — it is used
   * verbatim. When omitted, the reveal set is derived from the challenge's DCQL
   * `credentialQuery` (see {@link dcqlToRevealAttributes}); a query naming no claims
   * falls back to `[]` = reveal everything.
   */
  revealAttribute?: string[]
  rangeProof?: unknown
  /**
   * The VC's *issuer* BBS+/Ed25519 verification keys for the OID4VP submit body. When supplied,
   * it overrides {@link IssuerKeyResolver} — use it when the ZID resolver is unreachable
   * (e.g. behind a Cloudflare managed challenge for server-to-server calls) and the keys were
   * fetched out-of-band. When omitted, the injected resolver runs as before.
   */
  issuerKeys?: IssuerProofKeys
}

/** Local structural guard — this package has no shared guards util. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True iff walking `segments` from `obj` lands on an existing property at every step. */
function pathExists(obj: unknown, segments: string[]): boolean {
  let cur: unknown = obj
  for (const seg of segments) {
    if (!isRecord(cur) || !(seg in cur)) return false
    cur = cur[seg]
  }
  return true
}

/** Depth-first search for the first property named `key`; returns its path from `obj`, or null. */
function findLeafPath(obj: unknown, key: string): string[] | null {
  if (!isRecord(obj)) return null
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) return [k]
    const nested = findLeafPath(v, key)
    if (nested) return [k, ...nested]
  }
  return null
}

/** Every leaf dotted path in `obj`, depth-first, in the object's own key order. */
function flattenLeafPaths(obj: unknown, prefix: string[] = []): string[] {
  if (!isRecord(obj)) return prefix.length ? [prefix.join('.')] : []
  return Object.entries(obj).flatMap(([k, v]) => flattenLeafPaths(v, [...prefix, k]))
}

/**
 * Map an OID4VP DCQL `credentialQuery` to MBI dotted `revealAttributes`.
 *
 * The query is the verifier's `requirements`, echoed through the presentation definition
 * (`credential_query`) by the x401 client. Shape:
 *
 *   { credentials: [ { id?, format?, credentialTypes?, claims?: [ { path: string[] } ] } ] }
 *
 * MBI's `/vp/ext/create` `revealAttributes` are dotted paths **relative to `credentialSubject`,
 * walking into nested objects** (e.g. `agentIdentityCredential.agentName`). DCQL `claims[].path`,
 * however, may be either a full subject-relative path OR just a leaf claim name — the sandbox
 * sample uses leaf names (`["agentName"]`) while the Agent Identity Credential nests them under
 * `agentIdentityCredential`. To bridge both, when the presented `vc`
 * is supplied each DCQL path is resolved against `vc.credentialSubject`:
 *   1. if the path already walks to an existing node, it is used as-is (full-path passthrough);
 *   2. otherwise its leaf name is located by depth-first search and the discovered dotted path
 *      (relative to `credentialSubject`) is emitted (`agentName` → `agentIdentityCredential.agentName`);
 *   3. if neither resolves (or no `vc` given), the segments are joined verbatim.
 * Paths are collected across every credential and de-duplicated in first-seen order.
 *
 * The resolved paths are then reordered to match the field order MBI originally signed in
 * `vc.credentialSubject` (depth-first, the VC's own key order) rather than whatever order the
 * verifier's DCQL challenge happened to list its claims in. BBS+ is index-based: MBI's
 * `/vp/ext/create` builds the disclosed `credentialSubject` in the order `revealAttributes` is
 * given, so a challenge that lists claims out of the VC's signed order (e.g. `controllerName`
 * before `purpose`, when the VC signed `purpose` first) would otherwise produce a revealed object
 * whose field order doesn't match the signed one — observed to make the OID4VP verifier reject
 * the presentation outright. A path the VC doesn't contain (fallback verbatim-join case, or no
 * `vc` supplied at all) sorts after every resolved path, keeping its original relative order.
 *
 * Returns `[]` when the query names no claims — MBI reads that as "reveal all", the prior default.
 */
export function dcqlToRevealAttributes(credentialQuery: unknown, vc?: unknown): string[] {
  if (!isRecord(credentialQuery) || !Array.isArray(credentialQuery.credentials)) return []
  const subject = isRecord(vc) && isRecord(vc.credentialSubject) ? vc.credentialSubject : undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const cred of credentialQuery.credentials) {
    if (!isRecord(cred) || !Array.isArray(cred.claims)) continue
    for (const claim of cred.claims) {
      if (!isRecord(claim) || !Array.isArray(claim.path) || claim.path.length === 0) continue
      if (!claim.path.every((seg): seg is string => typeof seg === 'string')) continue
      const segments = claim.path as string[]
      let dotted = segments.join('.')
      if (subject && !pathExists(subject, segments)) {
        const found = findLeafPath(subject, segments[segments.length - 1])
        if (found) dotted = found.join('.')
      }
      if (!seen.has(dotted)) {
        seen.add(dotted)
        out.push(dotted)
      }
    }
  }
  if (!subject) return out
  const canonicalIndex = new Map(flattenLeafPaths(subject).map((path, i) => [path, i]))
  return out
    .map((path, i) => ({ path, key: canonicalIndex.get(path) ?? Number.MAX_SAFE_INTEGER, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((entry) => entry.path)
}

export class MbiVpAdapter implements VcProofProvider {
  constructor(
    private readonly mbi: MbiVpCaller,
    private readonly signHexBlob: HexBlobSigner,
    private readonly signMessage: MessageSigner,
    private readonly holderAddress: string,
    private readonly resolveIssuerKeys: IssuerKeyResolver,
    private readonly present: VcPresentInput,
  ) {}

  async createVp(input: {
    credentialQuery: unknown
    nonce: string
    holderDid: string
  }): Promise<{ vp: unknown; ed25519PublicKey: string; bbsPublicKey: string; presentationSubmission: Record<string, unknown> }> {
    // Reveal set: an explicit caller-supplied `revealAttribute` wins (including `[]`);
    // otherwise derive minimal disclosure from the verifier's DCQL query, resolving each claim
    // path against the presented VC so nested claims map to the right dotted path
    // (`agentName` → `agentIdentityCredential.agentName`). A claim-less query yields `[]`,
    // which MBI treats as "reveal all" — the prior default.
    const revealAttributes = this.present.revealAttribute ?? dcqlToRevealAttributes(input.credentialQuery, this.present.vc)

    // Auth for /vp/ext/*: sign the holder's own address once, reuse for both calls below.
    const { signBlob: signedData, publicKey: authPublicKey } = await this.signMessage(this.holderAddress)
    const auth = { signedData, publicKey: authPublicKey }

    // 1. Derive the unsigned VP blob (BBS+ selective disclosure server-side, from the issuer's key).
    const createBody: Record<string, unknown> = {
      vc: this.present.vc,
      revealAttributes,
    }
    if (this.present.rangeProof !== undefined) createBody.rangeProof = this.present.rangeProof
    const created = await this.mbi.createVp(createBody as { vc: unknown; revealAttributes: string[]; rangeProof?: unknown }, auth)

    const blobId = created.blobId
    const blob = created.blob
    if (!blobId || !blob) {
      throw new Error('MbiVpAdapter: /vp/ext/create did not return { blobId, blob }')
    }

    // 2. Holder Ed25519 signature over the hex blob — via Wallet BE (custody preserved). This key
    //    proves OUR signature to MBI; it is unrelated to the issuer keys resolved below.
    const { signBlob, publicKey } = await this.signHexBlob(blob)

    // 3. Submit + get the finished VP back in the same call (no separate read-back).
    const submitted = await this.mbi.submitVp({ blobId, signedBlob: signBlob, publicKey, includeVp: true }, auth)
    if (!submitted.vp) {
      throw new Error('MbiVpAdapter: /vp/ext/submit did not return vp (includeVp not honored?)')
    }

    // 4. Issuer's BBS+/Ed25519 keys for the OID4VP submit body (see file docstring). A
    //    caller-supplied `issuerKeys` overrides the resolver — used when the ZID resolver is
    //    unreachable (Cloudflare-gated) and the keys were fetched out-of-band.
    const issuerKeys = this.present.issuerKeys ?? (await this.resolveIssuerKeys(this.present.vc))

    // 5. DIF Presentation-Exchange submission the OID4VP verifier requires on submit
    // (`SubmitPresentationReqDto.presentation_submission` is `@NotNull`).
    // `createVp`'s input carries no presentation/definition id to correlate against,
    // but the verifier's own DcqlValidationService treats `descriptor_map` as only an optional
    // matching hint — it falls back to matching by the VC's own `id`, or by position, when empty
    // — so a minimal placeholder is sufficient. Session correlation itself is carried by the
    // top-level `presentation_id` field the SDK sends alongside this, not by these sub-fields.
    const presentationSubmission = { id: 'presentation', definition_id: 'presentation', descriptor_map: [] }

    return {
      vp: submitted.vp,
      ed25519PublicKey: issuerKeys.ed25519PublicKey,
      bbsPublicKey: issuerKeys.bbsPublicKey,
      presentationSubmission,
    }
  }
}
