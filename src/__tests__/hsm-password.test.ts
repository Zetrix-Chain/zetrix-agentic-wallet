import { describe, it, expect } from 'vitest'
import { generateHsmPassword } from '../hsm-password'

describe('generateHsmPassword', () => {
  it('returns a 32-character URL-safe string', () => {
    const pw = generateHsmPassword()
    expect(pw).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })

  it('returns a different value on every call', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateHsmPassword()))
    expect(seen.size).toBe(50)
  })

  it('is not derived from anything guessable — no timestamp substring', () => {
    const pw = generateHsmPassword()
    expect(pw).not.toContain(String(new Date().getFullYear()))
  })
})
