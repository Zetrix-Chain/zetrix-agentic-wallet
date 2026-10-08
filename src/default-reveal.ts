/**
 * What create_verification_qr reveals when the caller does not say.
 *
 * The wallet, not the model, chooses which credential is presented, so the model cannot know the attribute names
 * to ask for — and left to guess it could reach for personal fields or reveal everything. So each supported
 * credential has a fixed minimal set: enough to show who the agent is and that it was checked, and nothing about
 * the owner as a person. Anything beyond it has to be asked for by name, or with revealAll.
 */

/** The credentials create_verification_qr presents for human verification. */
export type VerifiableCredentialKind = 'verified' | 'basic'

/** Verified AI Birthcert: the agent's name, who vouched for the owner, and that the owner was verified. */
export const VERIFIED_DEFAULT_REVEAL: readonly string[] = [
  'verifiedAiBirthcert.agentName',
  'verifiedAiBirthcert.evidenceProvider',
  'verifiedAiBirthcert.ownerVerified',
]

/** Basic AI Birthcert: the registered agent username, the only attribute that means anything (its id is derived from it). */
export const BASIC_DEFAULT_REVEAL: readonly string[] = ['aiBirthcert.agentUsername']

/** A copy of the standard set for `kind`, so a caller cannot change it. */
export function defaultRevealFor(kind: VerifiableCredentialKind): string[] {
  return [...(kind === 'verified' ? VERIFIED_DEFAULT_REVEAL : BASIC_DEFAULT_REVEAL)]
}
