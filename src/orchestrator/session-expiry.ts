/**
 * How long a Verified AI Birthcert verification session has left, computed by the WALLET.
 *
 * Why this exists: the wallet used to return SSIVC's `expiresAt` untouched and leave the
 * arithmetic to the host agent. In a live run the agent converted the expiry to +08:00 (16:11) but
 * treated its own idea of "now" as UTC (about 08:00), and told the user the link was good for "about
 * 8 hours". The real window was about 15 minutes. A language model's sense of the current time and
 * timezone is not something a money-adjacent flow can lean on, so the remaining time is worked out
 * here, from the wallet's own clock, and handed over as a plain sentence.
 *
 * `Date.parse` honours whatever UTC offset SSIVC sent (`+00:00`, `+08:00`, `Z`), so the result does
 * not depend on the timezone of the machine the wallet runs on.
 */

export interface SessionExpiryFields {
  /** Whole seconds left, never negative. 0 means already expired. */
  expiresInSeconds: number
  /**
   * The same thing as a sentence fragment to quote, e.g. "about 14 minutes" or "already expired".
   * The agent should relay this rather than compute time remaining from its own clock.
   */
  expiresIn: string
}

export function humanRemaining(seconds: number): string {
  if (seconds <= 0) return 'already expired'
  if (seconds < 60) return 'less than a minute'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(seconds / 3600)
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(seconds / 86_400)
  return `about ${days} days`
}

/** Returns the expiry fields for `expiresAt`, or null when it is not a parseable timestamp. */
export function sessionExpiryFields(expiresAt: unknown, now: Date): SessionExpiryFields | null {
  if (typeof expiresAt !== 'string') return null
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return null
  const seconds = Math.max(Math.floor((at - now.getTime()) / 1000), 0)
  return { expiresInSeconds: seconds, expiresIn: humanRemaining(seconds) }
}

/**
 * Adds `expiresIn` / `expiresInSeconds` to any result that carries a session (`expiresAt` plus a
 * `verificationUrl`, or `expiresAt` plus a session `status` as check_ returns). Everything else — errors, pending settlements, quotes — passes through
 * untouched, and `expiresAt` itself is never altered.
 */
export function withSessionExpiry<T>(result: T, now: Date): T {
  if (typeof result !== 'object' || result === null) return result
  const r = result as Record<string, unknown>
  if (typeof r.expiresAt !== 'string') return result
  if (typeof r.verificationUrl !== 'string' && typeof r.status !== 'string') return result
  const fields = sessionExpiryFields(r.expiresAt, now)
  return fields ? ({ ...r, ...fields } as T) : result
}
