import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * QA saw the agent tell a user "you'd pay the fee up front" for a Verified AI Birthcert while the issuing service was
 * running without payment. The wallet's own text stated the fee as fact. Whether a fee applies comes from the readiness
 * check, so every place that says "paid up front" has to say it as a condition.
 */

const readDoc = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n')

const SOURCES: Array<[string, string]> = [
  ['SKILL.md', readDoc('openclaw-plugin', 'skills', 'zetrix-agentic-wallet', 'SKILL.md')],
  ['USER_GUIDE.md', readDoc('openclaw-plugin', 'USER_GUIDE.md')],
  ['README.md', readDoc('README.md')],
  ['birthcert-choice.ts', readDoc('src', 'orchestrator', 'birthcert-choice.ts')],
  ['index.ts (tool descriptions)', readDoc('src', 'index.ts')],
  ['preflight.ts', readDoc('src', 'orchestrator', 'preflight.ts')],
]

/** What must stand in front of "paid up front" for it to be a condition and not a fact. */
const CONDITION = /(Whether (a fee|there is a fee)|When (the check says|it does|there is one|a fee applies)|if a fee applies|when a fee applies)/i

describe('the Verified fee is never stated as fact', () => {
  it('every "paid up front" is introduced by a condition, in every place the wallet says it', () => {
    for (const [name, text] of SOURCES) {
      for (const match of text.matchAll(/paid up front/gi)) {
        const before = text.slice(Math.max(0, (match.index ?? 0) - 260), match.index)
        expect(CONDITION.test(before), `${name}: "…${before.slice(-90)} paid up front"`).toBe(true)
      }
    }
  })

  it('no sentence says the Verified fee "is paid up front" with nothing before it', () => {
    for (const [name, text] of SOURCES) {
      expect(text, name).not.toMatch(/(^|[.;:] )(The|the) fee is paid up front/)
    }
  })

  it('the three places an agent or user reads about the Verified kind say nothing is paid when the check says so', () => {
    for (const [name, text] of SOURCES.filter(([n]) => ['SKILL.md', 'USER_GUIDE.md', 'birthcert-choice.ts'].includes(n))) {
      expect(text, name).toMatch(/nothing is paid/)
    }
  })

  it('the kind-choice note tells the agent not to assume either kind is free or paid', () => {
    expect(SOURCES.find(([n]) => n === 'birthcert-choice.ts')?.[1]).toMatch(/never assume either kind is free or paid/)
  })
})
