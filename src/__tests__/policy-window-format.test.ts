/**
 * The window grammar, pinned against what ms-zetrix's `PolicyWriteValidator.requireValidWindow`
 * accepts. A copy of a cross-repo rule is a TRIPWIRE, not a guarantee: these tests make changing it
 * here a deliberate edit to a file that names its source — they do not prove the repos agree.
 */
import { describe, it, expect } from 'vitest'
import {
  checkWindowValue,
  describeDuration,
  MAX_WINDOW_MS,
  exceedsDefaultRetention,
  isWindowAttribute,
  windowHint,
  DEFAULT_RETENTION_MS,
} from '../policy-window-format'

const D = 86_400_000n

describe('checkWindowValue — what the service accepts', () => {
  for (const [text, ms] of [
    ['7d', 7n * D],
    ['12h', 12n * 3_600_000n],
    ['30m', 30n * 60_000n],
    ['45s', 45n * 1_000n],
    ['500ms', 500n],
    ['1d', D],
    ['+7d', 7n * D],
    ['7D', 7n * D],
    ['12H', 12n * 3_600_000n],
    ['P7D', 7n * D],
    ['p7d', 7n * D],
    ['PT12H', 12n * 3_600_000n],
    ['P1DT12H', D + 12n * 3_600_000n],
    ['PT30M', 30n * 60_000n],
    ['PT45S', 45n * 1_000n],
  ] as const) {
    it(`accepts ${JSON.stringify(text)} as ${ms}ms`, () => {
      expect(checkWindowValue(text)).toEqual({ ok: true, ms, subMs: false })
    })
  }

  it('accepts a sub-millisecond unit as a positive duration, never zero', () => {
    expect(checkWindowValue('5ns')).toEqual({ ok: true, ms: 1n, subMs: true })
    expect(checkWindowValue('5us')).toEqual({ ok: true, ms: 1n, subMs: true })
  })
})

describe('checkWindowValue — what the service refuses', () => {
  it('refuses a bare integer, because it would be read as milliseconds', () => {
    // The legacy block-count shape. "259200" would parse as four minutes where thirty days was meant.
    expect(checkWindowValue('259200')).toEqual({ ok: false, reason: 'bare_number' })
    expect(checkWindowValue('43200')).toEqual({ ok: false, reason: 'bare_number' })
    expect(checkWindowValue('+7')).toEqual({ ok: false, reason: 'bare_number' })
    expect(checkWindowValue('-7')).toEqual({ ok: false, reason: 'bare_number' })
  })

  it('refuses a natural-language window', () => {
    for (const word of ['week', 'weekly', 'a week', 'per week', 'month', 'daily']) {
      expect(checkWindowValue(word), word).toEqual({ ok: false, reason: 'unrecognised' })
    }
  })

  it('refuses zero as not positive, in both styles', () => {
    expect(checkWindowValue('0d')).toEqual({ ok: false, reason: 'not_positive' })
    expect(checkWindowValue('0s')).toEqual({ ok: false, reason: 'not_positive' })
    expect(checkWindowValue('P0D')).toEqual({ ok: false, reason: 'not_positive' })
    expect(checkWindowValue('PT0S')).toEqual({ ok: false, reason: 'not_positive' })
  })

  it('refuses negative and unrecognised-unit values', () => {
    expect(checkWindowValue('-7d')).toEqual({ ok: false, reason: 'unrecognised' })
    expect(checkWindowValue('7w')).toEqual({ ok: false, reason: 'unrecognised' })
    expect(checkWindowValue('7y')).toEqual({ ok: false, reason: 'unrecognised' })
    expect(checkWindowValue('7days')).toEqual({ ok: false, reason: 'unrecognised' })
    expect(checkWindowValue('1.5d')).toEqual({ ok: false, reason: 'unrecognised' })
    expect(checkWindowValue('7 d')).toEqual({ ok: false, reason: 'unrecognised' })
  })

  it('refuses an ISO form with no component, or with parts Java does not accept', () => {
    for (const bad of ['P', 'PT', 'P1DT', 'PT1HT', 'P1W', 'P1Y', 'P1M', 'PT1.5H', 'P-1D']) {
      expect(checkWindowValue(bad).ok, bad).toBe(false)
    }
  })

  it('refuses empty and blank values', () => {
    expect(checkWindowValue('')).toEqual({ ok: false, reason: 'empty' })
    expect(checkWindowValue('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('refuses anything that is not a string', () => {
    for (const v of [7, null, undefined, {}, [], true, ['7d']]) {
      expect(checkWindowValue(v), JSON.stringify(v)).toEqual({ ok: false, reason: 'not_string' })
    }
  })

  it('does not throw or hang on a huge or hostile value', () => {
    expect(checkWindowValue('x'.repeat(50_000)).ok).toBe(false)
    // Beyond anything the service could hold: Spring parses the number as a long and Duration overflows.
    expect(checkWindowValue('9'.repeat(50_000) + 'd')).toEqual({ ok: false, reason: 'too_large' })
    expect(checkWindowValue('P' + '9'.repeat(5_000) + 'D')).toEqual({ ok: false, reason: 'too_large' })
  })
})

describe('retention — a note, never a refusal', () => {
  it('pins the default retention at 30 days, absolutely', () => {
    expect(DEFAULT_RETENTION_MS).toBe(30n * D)
  })

  it('treats exactly 30d as inside and one millisecond over as outside', () => {
    expect(exceedsDefaultRetention(30n * D)).toBe(false)
    expect(exceedsDefaultRetention(30n * D + 1n)).toBe(true)
    expect(exceedsDefaultRetention(7n * D)).toBe(false)
  })
})

describe('which attributes are windows', () => {
  it('is keyed on the NAME ending in "Window", as the service does it', () => {
    for (const n of ['cumulativeWindow', 'velocityWindow', 'countWindow', 'someFutureWindow']) {
      expect(isWindowAttribute(n), n).toBe(true)
    }
    for (const n of ['cumulativeMax', 'windowSize', 'Windows', 'assetScope', '']) {
      expect(isWindowAttribute(n), n).toBe(false)
    }
  })
})

describe('windowHint — only exact words, never a guess', () => {
  it('maps the common words to the form to write', () => {
    expect(windowHint('week')).toBe('7d')
    expect(windowHint('Weekly')).toBe('7d')
    expect(windowHint(' day ')).toBe('1d')
    expect(windowHint('hour')).toBe('1h')
    expect(windowHint('month')).toBe('30d')
  })

  it('offers nothing for anything it does not recognise exactly', () => {
    expect(windowHint('fortnight')).toBeUndefined()
    expect(windowHint('every 3 days')).toBeUndefined()
    expect(windowHint(7)).toBeUndefined()
    expect(windowHint(undefined)).toBeUndefined()
  })
})

// ── review findings ──────────────────────────────────────────────────────────────────

describe('a padded value is refused, not trimmed', () => {
  // The write validator trims before it parses; Spring's DurationStyle does not, and whether the decision-time
  // evaluator trims is unknown. A needless refusal costs one retry; a stored value the evaluator cannot read
  // costs a cap that is silently never applied.
  for (const padded of [' 7d', '7d ', ' 7d ', '\t7d', '7d\n', '\u00a07d']) {
    it('refuses ' + JSON.stringify(padded), () => {
      expect(checkWindowValue(padded)).toEqual({ ok: false, reason: 'padded' })
    })
  }

  it('still calls a blank value EMPTY, not padded', () => {
    expect(checkWindowValue('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('accepts the same value with no padding', () => {
    expect(checkWindowValue('7d').ok).toBe(true)
  })
})

describe('a window larger than anything the service could hold is refused', () => {
  it('pins the ceiling at 100 years, absolutely', () => {
    expect(MAX_WINDOW_MS).toBe(100n * 365n * D)
  })

  it('accepts exactly the ceiling and refuses one unit over', () => {
    expect(checkWindowValue('36500d').ok).toBe(true)
    expect(checkWindowValue('36501d')).toEqual({ ok: false, reason: 'too_large' })
    expect(checkWindowValue('P36500D').ok).toBe(true)
    expect(checkWindowValue('P36501D')).toEqual({ ok: false, reason: 'too_large' })
  })

  it('refuses a value that does not fit a long, instead of calling it fine', () => {
    expect(checkWindowValue('99999999999999999999d')).toEqual({ ok: false, reason: 'too_large' })
  })

  it('applies to every unit, not just days', () => {
    expect(checkWindowValue('9999999999999999h')).toEqual({ ok: false, reason: 'too_large' })
    expect(checkWindowValue('99999999999999999999s')).toEqual({ ok: false, reason: 'too_large' })
  })
})

describe('describeDuration says what the window actually is', () => {
  it('reads 1M as one MINUTE — the trap the reviewer named', () => {
    const parsed = checkWindowValue('1M')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(describeDuration(parsed.ms, parsed.subMs)).toBe('1 minute')
  })

  it('spells out each unit with the right plural', () => {
    expect(describeDuration(1n)).toBe('1 millisecond')
    expect(describeDuration(2n)).toBe('2 milliseconds')
    expect(describeDuration(1_000n)).toBe('1 second')
    expect(describeDuration(60_000n)).toBe('1 minute')
    expect(describeDuration(3_600_000n)).toBe('1 hour')
    expect(describeDuration(D)).toBe('1 day')
    expect(describeDuration(7n * D)).toBe('7 days')
  })

  it('combines units, largest first', () => {
    expect(describeDuration(D + 12n * 3_600_000n)).toBe('1 day 12 hours')
    expect(describeDuration(90_061_001n)).toBe('1 day 1 hour 1 minute 1 second 1 millisecond')
  })

  it('says "less than 1 millisecond" for a sub-millisecond unit, which would otherwise read as 1 millisecond', () => {
    const parsed = checkWindowValue('5ns')
    expect(parsed.ok && parsed.subMs).toBe(true)
    expect(describeDuration(1n, true)).toBe('less than 1 millisecond')
  })
})
