/**
 * create_verification_qr — hand a human a link and a QR code that opens the agent's identity in MyID.
 *
 *   1. POST /v1/vp/ext/create   { vc, revealAttributes }                 → { blobId, blob }
 *   2. Wallet BE /sign-blob     blob                                      → { signBlob, publicKey }
 *   3. POST /v1/vp/ext/submit   { blobId, signedBlob, publicKey, vpExpiry } → { id }   (the reference id)
 *   4. link = MYID_VERIFY_LINK_TEMPLATE with {referenceId} filled in; QR = that same link
 *
 * MBI keeps the VP, encrypted, for `vpExpiry` minutes. The MyID backend later verifies it with its own
 * verifier client (GET /v1/vp/verify/{referenceId}). The link carries only the reference id, but that id is a
 * handle to the stored presentation: whoever holds it, and holds a verifier client for the template, can read
 * what the presentation reveals until it expires. So the caller must name what to reveal, and the result says
 * what was revealed.
 *
 * The link comes from MyID (a universal link on a domain they control, so a phone without the app is sent
 * to the store; see verify-link-template.ts for what it must look like). The wallet never invents one: with no
 * template configured it refuses before it creates anything on MBI, because a VP nobody can open is just
 * stored personal data.
 */

import type { MbiClient } from '../clients/mbi-client.js'
import { orderRevealPaths, revealablePaths, unresolvedRevealPaths, type HexBlobSigner, type MessageSigner } from '../clients/mbi-vp-adapter.js'
import { checkVerifyLinkTemplate, LINK_PLACEHOLDER } from '../verify-link-template.js'

/** MBI's own default, sent explicitly so the expiry we report is the one MBI applies. */
export const DEFAULT_EXPIRY_MINUTES = 5
/**
 * MBI enforces no upper bound. A presentation carries the revealed attributes and sits readable by any
 * verifier of the template until it expires, so the wallet bounds it rather than trusting the caller.
 */
export const MAX_EXPIRY_MINUTES = 60
/** Far more than any check needs; a longer list is a sign something is wrong. */
export const MAX_REVEAL_PATHS = 50

export interface VerificationLinkInput {
  /** The VC to present. */
  vc: unknown
  /**
   * Dotted disclosure paths — what the presentation reveals. Required unless `revealAll` is true: the reference
   * id is a handle to the stored presentation, so the choice of what it exposes is never left to a default.
   */
  revealAttribute?: string[]
  /** Reveal every attribute. Cannot be combined with `revealAttribute`. */
  revealAll?: boolean
  /** How long the presentation stays openable, in whole minutes. Default 5, maximum 60. */
  expiryMinutes?: number
}

export interface VerificationLinkDeps {
  mbi: Pick<MbiClient, 'createVp' | 'submitVp'>
  signHexBlob: HexBlobSigner
  signMessage: MessageSigner
  /** MyID's link with a `{referenceId}` placeholder. Undefined when none is configured for this network. */
  linkTemplate?: string
  /** Renders `text` as a PNG QR code. */
  renderQr: (text: string) => Promise<Buffer>
  now?: () => number
}

export type VerificationLinkResult =
  | {
      created: true
      link: string
      referenceId: string
      expiresAt: string
      expiresInMinutes: number
      /** What the presentation reveals: the attribute paths sent to MBI, in order, or `'all'`. */
      revealed: string[] | 'all'
      /** Which credential was presented. Set by the create_verification_qr tool, which chooses it. */
      credentialUsed?: string
      /** True when the caller named nothing and the wallet's standard minimal set was revealed. Set by the tool. */
      revealedByDefault?: boolean
      /** Absent when rendering failed; the link above is still good. */
      qrCodePngBase64?: string
      qrError?: string
      message: string
    }
  | { created: false; reason: string }

/** Fill the reference id into MyID's link template. Throws when the template is not one we will build a link from. */
export function buildVerificationLink(template: string | undefined, referenceId: string): string {
  const problem = checkVerifyLinkTemplate(template)
  if (problem) throw new Error(problem)
  // encodeURIComponent so an id can never add or change a query parameter, or the path, of MyID's link.
  return (template as string).split(LINK_PLACEHOLDER).join(encodeURIComponent(referenceId))
}

/**
 * Why the caller's choice of what to reveal cannot be used, or what to send MBI (`reveal`, `[]` = everything)
 * and what to tell the caller was revealed.
 */
function resolveReveal(input: VerificationLinkInput): { reveal: string[]; revealed: string[] | 'all' } | { reason: string } {
  const { revealAttribute, revealAll } = input
  if (revealAll !== undefined && typeof revealAll !== 'boolean') {
    return { reason: 'revealAll must be true or false.' }
  }
  if (
    revealAttribute !== undefined &&
    (!Array.isArray(revealAttribute) || revealAttribute.some((p) => typeof p !== 'string' || p.trim() === ''))
  ) {
    return { reason: 'revealAttribute must be a list of dotted attribute paths, each a non-empty string.' }
  }
  const named = revealAttribute ?? []
  if (named.length > MAX_REVEAL_PATHS) {
    return { reason: `revealAttribute lists ${named.length} paths; the most it takes is ${MAX_REVEAL_PATHS}.` }
  }
  if (revealAll === true && named.length > 0) {
    return { reason: 'revealAll and revealAttribute contradict each other — name the attributes, or reveal all, not both.' }
  }
  if (revealAll === true) return { reveal: [], revealed: 'all' }
  if (named.length === 0) {
    return {
      reason:
        'Say what to reveal: pass revealAttribute with only the attributes the check needs, or revealAll: true to ' +
        'reveal every attribute. The reference id gives access to whatever is revealed until the link expires, so ' +
        'it is never chosen for you.',
    }
  }
  const unresolved = unresolvedRevealPaths(named, input.vc)
  if (unresolved === null) {
    // Not "all fine": a parent path discloses everything under it, and without the credential's attributes in view
    // a parent cannot be told from a single attribute. Better to refuse than to report it as one attribute.
    return {
      reason:
        'cannot check the named paths against this credential (it has no plain credentialSubject object, or an ' +
        'attribute name contains a dot), so a path that would disclose a whole subtree could not be told from a single ' +
        'attribute. Pass the credential as an object, or use revealAll.',
    }
  }
  if (unresolved.length > 0) {
    return {
      reason:
        `revealAttribute names ${unresolved.map((p) => JSON.stringify(p)).join(', ')}, which is not a single attribute of this credential. ` +
        'Each path must be the full dotted path of one attribute (relative to credentialSubject); a parent path would ' +
        'disclose everything under it, so list its attributes instead, or use revealAll. ' +
        describeAttributes(input.vc),
    }
  }
  // MBI builds the disclosed subject in the order it is given, and an order that differs from how the VC was
  // signed makes the verifier reject the presentation — so send them in the credential's own order.
  const ordered = orderRevealPaths(named, input.vc)
  return { reveal: ordered, revealed: ordered }
}

const MAX_LISTED_ATTRIBUTES = 20

/** "Attributes this credential has: a, b, …" — names only, so the caller can correct a path without seeing values. */
export function describeAttributes(vc: unknown): string {
  const names = revealablePaths(vc)
  if (names.length === 0) return ''
  const shown = names.slice(0, MAX_LISTED_ATTRIBUTES).join(', ')
  const more = names.length > MAX_LISTED_ATTRIBUTES ? ` and ${names.length - MAX_LISTED_ATTRIBUTES} more` : ''
  return `Attributes this credential has: ${shown}${more}.`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function createVerificationLink(
  input: VerificationLinkInput,
  deps: VerificationLinkDeps,
): Promise<VerificationLinkResult> {
  const expiryMinutes = input.expiryMinutes ?? DEFAULT_EXPIRY_MINUTES
  if (!Number.isInteger(expiryMinutes) || expiryMinutes < 1 || expiryMinutes > MAX_EXPIRY_MINUTES) {
    return {
      created: false,
      reason: `expiryMinutes must be a whole number of minutes from 1 to ${MAX_EXPIRY_MINUTES}, got ${String(input.expiryMinutes)}.`,
    }
  }

  const revealed = resolveReveal(input)
  if ('reason' in revealed) return { created: false, reason: revealed.reason }

  // Check the template with a throwaway id BEFORE touching MBI: a misconfigured link must not leave a
  // stored presentation behind.
  try {
    buildVerificationLink(deps.linkTemplate, 'check')
  } catch (e) {
    return { created: false, reason: messageOf(e) }
  }

  let startedAt: number

  let referenceId: string
  try {
    const created = await deps.mbi.createVp(
      { vc: input.vc, revealAttributes: revealed.reveal },
      deps.signMessage,
    )
    if (!created?.blobId || !created?.blob) {
      return { created: false, reason: 'MBI /v1/vp/ext/create did not return { blobId, blob }.' }
    }
    const { signBlob, publicKey } = await deps.signHexBlob(created.blob)
    // MBI starts its clock when it receives the submit, so the expiry is measured from before we ask. Measured
    // after the answer, the reported time would be later than the one MBI actually applies.
    startedAt = (deps.now ?? Date.now)()
    const submitted = await deps.mbi.submitVp(
      { blobId: created.blobId, signedBlob: signBlob, publicKey, vpExpiry: expiryMinutes },
      deps.signMessage,
    )
    if (!submitted?.id) {
      return { created: false, reason: 'MBI /v1/vp/ext/submit did not return a reference id.' }
    }
    referenceId = submitted.id
  } catch (e) {
    return { created: false, reason: messageOf(e) }
  }

  const link = buildVerificationLink(deps.linkTemplate, referenceId)
  const expiresAt = new Date(startedAt + expiryMinutes * 60_000).toISOString()

  let qrCodePngBase64: string | undefined
  let qrError: string | undefined
  try {
    qrCodePngBase64 = (await deps.renderQr(link)).toString('base64')
  } catch (e) {
    // The presentation already exists and the link works on its own — do not throw it away over a picture.
    qrError = messageOf(e)
  }

  return {
    created: true,
    link,
    referenceId,
    expiresAt,
    expiresInMinutes: expiryMinutes,
    revealed: revealed.revealed,
    ...(qrCodePngBase64 !== undefined ? { qrCodePngBase64 } : {}),
    ...(qrError !== undefined ? { qrError } : {}),
    message:
      `Show the user the QR code and the link, and tell them to open it in the MyID app ` +
      `(they need MyID installed first). It stops working at about ${expiresAt}, ` +
      `${expiryMinutes} minute${expiryMinutes === 1 ? '' : 's'} after it was created — if it lapses, create a new one. ` +
      `This ${revealed.revealed === 'all' ? 'reveals the whole credential' : `reveals: ${revealed.revealed.map((p) => JSON.stringify(p)).join(', ')}`}. ` +
      `Show it only to the user: whoever holds the link can open what it reveals until then.`,
  }
}
