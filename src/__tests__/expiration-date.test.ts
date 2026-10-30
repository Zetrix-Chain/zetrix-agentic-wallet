import { describe, it, expect } from 'vitest'
import { expirationProblem } from '../orchestrator/expiration-date'

const NOW = new Date('2026-10-28T05:00:00Z')

describe('expirationProblem', () => {
  it('accepts nothing, an empty string, and a real future date', () => {
    expect(expirationProblem(undefined, NOW)).toBeUndefined()
    expect(expirationProblem('', NOW)).toBeUndefined()
    expect(expirationProblem('2027-10-27', NOW)).toBeUndefined()
    expect(expirationProblem(' 2027-10-27 ', NOW)).toBeUndefined()
  })

  it.each(['2026-02-30', '2026-13-01', '27-10-2027', '2027/10/27', 'tomorrow', '2027-10-27T00:00:00Z'])('refuses %s as not a real YYYY-MM-DD', (value) => {
    expect(expirationProblem(value, NOW)).toMatch(/YYYY-MM-DD/)
  })

  it('reads the date as midnight UTC: the boundary instant is refused, a second before it is accepted', () => {
    expect(expirationProblem('2026-10-29', new Date('2026-10-29T00:00:00Z'))).toMatch(/future/)
    expect(expirationProblem('2026-10-29', new Date('2026-10-28T23:59:59Z'))).toBeUndefined()
  })

  it('refuses a date that is not in the future', () => {
    expect(expirationProblem('2026-10-28', NOW)).toMatch(/future/)
    expect(expirationProblem('2025-01-01', NOW)).toMatch(/future/)
  })
})
