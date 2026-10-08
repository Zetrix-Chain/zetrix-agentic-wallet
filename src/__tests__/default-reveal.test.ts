import { describe, it, expect } from 'vitest'
import { BASIC_DEFAULT_REVEAL, VERIFIED_DEFAULT_REVEAL, defaultRevealFor } from '../default-reveal'

describe('the standard set create_verification_qr reveals', () => {
  it('is agentName, evidenceProvider and ownerVerified for the Verified AI Birthcert', () => {
    expect(VERIFIED_DEFAULT_REVEAL).toEqual([
      'verifiedAiBirthcert.agentName',
      'verifiedAiBirthcert.evidenceProvider',
      'verifiedAiBirthcert.ownerVerified',
    ])
    expect(defaultRevealFor('verified')).toEqual(VERIFIED_DEFAULT_REVEAL)
  })

  it('is the agent username alone for the Basic AI Birthcert', () => {
    expect(BASIC_DEFAULT_REVEAL).toEqual(['aiBirthcert.agentUsername'])
    expect(defaultRevealFor('basic')).toEqual(BASIC_DEFAULT_REVEAL)
  })

  // The point of a default is that it is safe to apply without asking: nothing about the owner as a person.
  it.each(['ownerName', 'ownerId', 'dob', 'ownerReference', 'ownerAddress', 'evidenceReference'])('never includes %s', (field) => {
    for (const path of [...VERIFIED_DEFAULT_REVEAL, ...BASIC_DEFAULT_REVEAL]) {
      expect(path.endsWith('.' + field)).toBe(false)
    }
  })

  it('hands out a copy, so a caller cannot change the standard set', () => {
    const copy = defaultRevealFor('verified')
    copy.push('verifiedAiBirthcert.dob')
    expect(defaultRevealFor('verified')).toEqual(VERIFIED_DEFAULT_REVEAL)
  })
})
