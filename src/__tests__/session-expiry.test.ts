import { describe, it, expect } from 'vitest'
import { humanRemaining, sessionExpiryFields, withSessionExpiry } from '../orchestrator/session-expiry'

/**
 * In a live run the wallet returned SSIVC's expiresAt untouched, the host agent converted it
 * to +08:00 but took its own "now" to be UTC, and told the user the link was good for about 8 hours.
 * The real window was about 15 minutes. The wallet now works the remaining time out itself.
 */

describe('humanRemaining', () => {
  it.each([
    [0, 'already expired'],
    [-30, 'already expired'],
    [1, 'less than a minute'],
    [59, 'less than a minute'],
    [60, 'about 1 minute'],
    [89, 'about 1 minute'],
    [90, 'about 2 minutes'],
    [900, 'about 15 minutes'],
    [3599, 'about 1 hour'],
    [3600, 'about 1 hour'],
    [28_800, 'about 8 hours'],
    [172_799, 'about 2 days'],
    [172_800, 'about 2 days'],
  ])('%i seconds -> %s', (seconds, expected) => {
    expect(humanRemaining(seconds)).toBe(expected)
  })
})

describe('sessionExpiryFields', () => {
  // The incident: SSIVC's expiry was 16:11:24 local (+08:00), i.e. 08:11:24 UTC; the session had been
  // created at 15:56:24 local, i.e. 07:56:24 UTC. Fifteen minutes. Not eight hours.
  it('gets the live incident right: 15 minutes left, not 8 hours', () => {
    const f = sessionExpiryFields('2026-09-24T16:11:24+08:00', new Date('2026-09-24T07:56:24Z'))
    expect(f).toEqual({ expiresInSeconds: 900, expiresIn: 'about 15 minutes' })
  })

  it('gives the same answer for the same instant whatever offset SSIVC labels it with', () => {
    const now = new Date('2026-09-24T07:56:24Z')
    const asUtc = sessionExpiryFields('2026-09-24T08:11:24+00:00', now)
    const asZ = sessionExpiryFields('2026-09-24T08:11:24Z', now)
    const asKl = sessionExpiryFields('2026-09-24T16:11:24+08:00', now)
    const asLa = sessionExpiryFields('2026-09-24T01:11:24-07:00', now)
    expect(asUtc).toEqual(asKl)
    expect(asZ).toEqual(asKl)
    expect(asLa).toEqual(asKl)
  })

  it('reports an expired session as 0 seconds, never a negative number', () => {
    expect(sessionExpiryFields('2026-09-24T16:11:24+08:00', new Date('2026-09-24T09:00:00Z'))).toEqual({
      expiresInSeconds: 0,
      expiresIn: 'already expired',
    })
  })

  it.each([undefined, null, 42, '', 'not a date', '24/09/2026 16:11'])('returns null for %j', (bad) => {
    expect(sessionExpiryFields(bad, new Date())).toBeNull()
  })
})

describe('withSessionExpiry', () => {
  const now = new Date('2026-09-24T07:56:24Z')

  it('adds the fields to a created session and leaves expiresAt exactly as SSIVC sent it', () => {
    const session = { sessionId: 's', verificationUrl: 'https://zvg.test/v', expiresAt: '2026-09-24T16:11:24+08:00' }
    expect(withSessionExpiry(session, now)).toEqual({ ...session, expiresInSeconds: 900, expiresIn: 'about 15 minutes' })
  })

  it("adds them to check_'s pending status (expiresAt + a session status, no verificationUrl)", () => {
    const status = { sessionId: 's', status: 'pending', expiresAt: '2026-09-24T08:11:24+00:00' }
    expect(withSessionExpiry(status, now)).toMatchObject({ expiresInSeconds: 900, expiresIn: 'about 15 minutes' })
  })

  it('does not mutate its input', () => {
    const session = { sessionId: 's', verificationUrl: 'u', expiresAt: '2026-09-24T16:11:24+08:00' }
    withSessionExpiry(session, now)
    expect(session).toEqual({ sessionId: 's', verificationUrl: 'u', expiresAt: '2026-09-24T16:11:24+08:00' })
  })

  it.each([
    ['an error result', { error: 'insufficient funds' }],
    ['a pending settlement', { settlementPending: true, paymentReceipt: 'r', message: 'PAYMENT SENT' }],
    ['a quote', { quote: { asset: 'JMYR' } }],
    ['no_session', { status: 'no_session', message: 'none' }],
    ['a session with an unparseable expiry', { sessionId: 's', verificationUrl: 'u', expiresAt: 'soon' }],
  ])('passes %s through untouched', (_label, result) => {
    expect(withSessionExpiry(result, now)).toBe(result)
  })

  it('passes non-objects through', () => {
    expect(withSessionExpiry(null, now)).toBeNull()
    expect(withSessionExpiry('x', now)).toBe('x')
  })
})
