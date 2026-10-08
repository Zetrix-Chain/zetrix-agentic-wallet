/**
 * What a `*Window` attribute value must look like for the write service to accept it, restated so
 * preflight can refuse for free what the service refuses at its own free pre-check.
 *
 * WHY THIS EXISTS. A real transcript (2026-10-01) drafted "100 a week" as `cumulativeWindow: "week"`.
 * Preflight accepted it — it validated no window format at all — and the service refuses it:
 * `PolicyWriteValidator.requireValidWindow` throws POLICY_INVALID_ATTRIBUTE_VALUE. The agent then
 * had to tell the user it had not confirmed "week" means seven days, because nothing in the wallet
 * could say. Same false-assurance class as `policy-scope-rules.ts`, a different door.
 *
 * THE RULE, from ms-zetrix (`PolicyWriteValidator.requireValidWindow`, with
 * `AttributeClassifier.isValidWindow` using the same parser), read 2026-10-01:
 *  - every attribute whose NAME ends in "Window" is checked;
 *  - the value is trimmed, must not be empty, and must not be a bare integer — a unit-less number
 *    parses as MILLISECONDS in Spring's `DurationStyle`, so "259200" would silently mean four
 *    minutes where a legacy block count meant thirty days;
 *  - it is parsed with Spring Boot's `DurationStyle.detectAndParse`: the SIMPLE style
 *    `<integer><unit>` with unit one of ns, us, ms, s, m, h, d (case-insensitive), or ISO-8601
 *    (`P7D`, `PT12H`);
 *  - it must be strictly positive;
 *  - it must not exceed `CrawlProperties.retentionWindow`, default 30d.
 *
 * THE RETENTION LIMIT IS NOT ENFORCED HERE. It is `POLICY_CRAWL_RETENTION_WINDOW`, so it can differ
 * per environment and is not knowable from the wallet. Refusing on the default would block a valid
 * policy on an environment configured for longer. {@link exceedsDefaultRetention} lets preflight say
 * the service may refuse it, which is all that is true.
 *
 * TRIPWIRE, NOT A GUARANTEE — the same honesty `WINDOW_RULES` and the scope rules carry. ms-zetrix is
 * not vendored here and there is no shared CI, so nothing fails automatically if the service
 * changes this. DELIBERATELY NARROWER than Java's ISO parser in one place: only `PnDTnHnMnS` with
 * non-negative integer parts is accepted. A needless refusal of an exotic ISO form costs one retry
 * with `7d`; a false pass costs a paid write the service then refuses.
 */

const MS_PER_UNIT: Readonly<Record<string, bigint>> = {
  ns: 0n, // below a millisecond; positive but rounds to 0 here, so handled by the `nonZero` flag
  us: 0n,
  ms: 1n,
  s: 1_000n,
  m: 60_000n,
  h: 3_600_000n,
  d: 86_400_000n,
}

/** The default `CrawlProperties.retentionWindow` (30d), in milliseconds. */
export const DEFAULT_RETENTION_MS = 30n * 86_400_000n

const SIMPLE = /^\+?(\d+)([a-zA-Z]{0,2})$/
const ISO = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i

/** A hundred years. Nothing the service can retain comes near it; it exists to refuse absurd values.
 * Spring's SIMPLE style parses the number as a `long` and `Duration` arithmetic overflows past it, so a
 * value this large is never one the service accepts. */
export const MAX_WINDOW_MS = 100n * 365n * 86_400_000n

export type WindowCheck =
  /** `subMs` is true for ns/us, which are positive but under a millisecond (`ms` is then reported as 1). */
  | { ok: true; ms: bigint; subMs: boolean }
  | { ok: false; reason: 'not_string' | 'empty' | 'padded' | 'bare_number' | 'unrecognised' | 'not_positive' | 'too_large' }

export function checkWindowValue(value: unknown): WindowCheck {
  if (typeof value !== 'string') return { ok: false, reason: 'not_string' }
  if (value.trim() === '') return { ok: false, reason: 'empty' }
  // NOT trimmed. The write validator trims before it parses, but Spring's DurationStyle does not, and whether
  // the decision-time evaluator trims is not known from here. A padded value is refused: one retry without the
  // spaces, against a stored value the evaluator might not read.
  if (value !== value.trim()) return { ok: false, reason: 'padded' }
  const text = value
  if (/^[+-]?\d+$/.test(text)) return { ok: false, reason: 'bare_number' }

  const simple = SIMPLE.exec(text)
  if (simple) {
    const unit = simple[2].toLowerCase()
    if (!(unit in MS_PER_UNIT)) return { ok: false, reason: 'unrecognised' }
    const n = BigInt(simple[1])
    if (n === 0n) return { ok: false, reason: 'not_positive' }
    // ns and us are positive but sub-millisecond; report them as 1ms so the caller never sees a
    // zero duration for a value the service accepts.
    const per = MS_PER_UNIT[unit]
    const total = per === 0n ? 1n : n * per
    if (total > MAX_WINDOW_MS) return { ok: false, reason: 'too_large' }
    return { ok: true, ms: total, subMs: per === 0n }
  }

  const iso = ISO.exec(text)
  // "P" or "PT" alone match the pattern with no component, and so does a trailing "T" ("P1DT") — Java
  // rejects all three.
  if (iso && /\d/.test(text) && !/T$/i.test(text)) {
    const [, d, h, m, s] = iso
    const ms =
      BigInt(d ?? 0) * 86_400_000n + BigInt(h ?? 0) * 3_600_000n + BigInt(m ?? 0) * 60_000n + BigInt(s ?? 0) * 1_000n
    if (ms === 0n) return { ok: false, reason: 'not_positive' }
    if (ms > MAX_WINDOW_MS) return { ok: false, reason: 'too_large' }
    return { ok: true, ms, subMs: false }
  }

  return { ok: false, reason: 'unrecognised' }
}

/**
 * A window as a person reads it: `1M` is "1 minute", `P1DT12H` is "1 day 12 hours". Stated beside the value
 * because the grammar is case-insensitive and terse, and `1M` is the sort of thing an agent writes for "1
 * month" — a monthly cap that would reset every minute.
 */
export function describeDuration(ms: bigint, subMs = false): string {
  if (subMs) return 'less than 1 millisecond'
  const units: Array<[string, bigint]> = [
    ['day', 86_400_000n],
    ['hour', 3_600_000n],
    ['minute', 60_000n],
    ['second', 1_000n],
    ['millisecond', 1n],
  ]
  const parts: string[] = []
  let rest = ms
  for (const [name, size] of units) {
    const count = rest / size
    rest %= size
    if (count > 0n) parts.push(`${count} ${name}${count === 1n ? '' : 's'}`)
  }
  return parts.join(' ')
}

/** Does the service's DEFAULT retention (30d) rule this window out? Environment-specific, so a note. */
export function exceedsDefaultRetention(ms: bigint): boolean {
  return ms > DEFAULT_RETENTION_MS
}

/**
 * The corrected form for the common natural-language windows an agent reaches for. Only exact
 * words — anything cleverer would be a guess about what the user meant.
 */
const WORD_HINTS: ReadonlyMap<string, string> = new Map([
  ['hour', '1h'],
  ['hourly', '1h'],
  ['day', '1d'],
  ['daily', '1d'],
  ['week', '7d'],
  ['weekly', '7d'],
  ['month', '30d'],
  ['monthly', '30d'],
])

export function windowHint(value: unknown): string | undefined {
  return typeof value === 'string' ? WORD_HINTS.get(value.trim().toLowerCase()) : undefined
}

/** Is this one of the attributes the service validates as a window? Keyed on the NAME, as it is there. */
export function isWindowAttribute(attributeName: string): boolean {
  return attributeName.endsWith('Window')
}
