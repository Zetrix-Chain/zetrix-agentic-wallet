/**
 * Has the issuer revoked a credential the wallet is about to present? (Gap G8.)
 *
 * This only ever WARNS. A check that fails, times out or finds nothing never stops a presentation: the answer is `unknown` and
 * the caller says so. A credential MBI reports as revoked is reported as revoked and still presented, because the decision
 * not to block was the owner's; the warning tells the agent to say so to the user.
 *
 * The check is one signed call to MBI per credential, so it is cached briefly: an "active" answer for a few minutes, a
 * "revoked" answer for much longer (revocation is final), and an `unknown` never, so a transient failure is retried next time.
 * Concurrent checks of the same credential share one call.
 */

export type CredentialStatus =
  | { state: 'active' }
  | { state: 'revoked'; revokedAt?: string }
  | { state: 'unknown'; reason: string }

/** Never rejects. */
export type CredentialStatusChecker = (vc: unknown) => Promise<CredentialStatus>

export interface CredentialStatusOptions {
  /** The one call to MBI. May reject; the checker turns that into `unknown`. */
  revokeStatus: (vcId: string) => Promise<{ revoked: boolean; revokedAt?: string }>
  /** The longest the answer is waited for before it is `unknown` (default 8 s). */
  timeoutMs?: number
  /** How long an "active" answer is reused (default 5 minutes). */
  activeTtlMs?: number
  /** How long a "revoked" answer is reused (default 24 hours: revocation is final). */
  revokedTtlMs?: number
  /** Monotonic milliseconds, for the cache. Not the wall clock. */
  now?: () => number
}

/** The credential's own id (its `id` field), which is what MBI's revoke status is keyed on. */
export function credentialId(vc: unknown): string | undefined {
  if (vc === null || typeof vc !== 'object') return undefined
  const id = (vc as { id?: unknown }).id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}

function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // The MBI client appends the raw response ("| full body: {...}") for logs; it does not belong in an agent-facing line.
  const message = raw.split(' | full body:')[0].trim()
  // And a long message must not become a long agent-facing line either.
  return message.length > 200 ? `${message.slice(0, 199)}…` : message
}

const TIMED_OUT = Symbol('timed out')

export function createCredentialStatusChecker(options: CredentialStatusOptions): CredentialStatusChecker {
  const timeoutMs = options.timeoutMs ?? 8_000
  const activeTtlMs = options.activeTtlMs ?? 5 * 60_000
  const revokedTtlMs = options.revokedTtlMs ?? 24 * 60 * 60_000
  const now = options.now ?? (() => performance.now())
  const cache = new Map<string, { status: CredentialStatus; until: number }>()
  const inFlight = new Map<string, Promise<CredentialStatus>>()

  const ask = async (id: string): Promise<CredentialStatus> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const pending = options.revokeStatus(id)
      pending.catch(() => undefined) // a late rejection after the timeout must not surface
      const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      })
      const result = await Promise.race([pending, timedOut])
      if (result === TIMED_OUT) return { state: 'unknown', reason: `MBI did not answer within ${Math.round(timeoutMs / 1000)} seconds` }
      if (result.revoked) {
        return { state: 'revoked', ...(result.revokedAt !== undefined ? { revokedAt: result.revokedAt } : {}) }
      }
      return { state: 'active' }
    } catch (e) {
      return { state: 'unknown', reason: reasonOf(e) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return async (vc) => {
    const id = credentialId(vc)
    if (id === undefined) return { state: 'unknown', reason: 'the credential has no id to ask MBI about' }
    const hit = cache.get(id)
    if (hit && now() < hit.until) return hit.status
    const running = inFlight.get(id)
    if (running) return running
    const started = ask(id).then((status) => {
      if (status.state === 'active') cache.set(id, { status, until: now() + activeTtlMs })
      else if (status.state === 'revoked') cache.set(id, { status, until: now() + revokedTtlMs })
      return status
    })
    inFlight.set(id, started)
    try {
      return await started
    } finally {
      inFlight.delete(id)
    }
  }
}

/**
 * A cache hit from subscribe_and_issue hands back a credential issued earlier, possibly long ago, so its status is added to
 * the result before the agent reuses it (or decides to replace it). A freshly issued credential, or a result with no
 * credential, is returned as it was. Warns only, like every use of the checker.
 */
export async function withCachedCredentialStatus<T extends object>(result: T, check: CredentialStatusChecker | undefined): Promise<T> {
  if (!check) return result
  const r = result as { fromCache?: unknown; vc?: unknown }
  if (r.fromCache !== true || r.vc === undefined) return result
  return { ...result, credentialStatus: statusForResult(await check(r.vc), false) }
}

/** What the agent should tell the user. Undefined for an active credential: nothing to say. */
export function describeCredentialStatus(status: CredentialStatus, used = true): string | undefined {
  if (status.state === 'revoked') {
    const since = status.revokedAt ? ` (since ${status.revokedAt})` : ''
    return (
      `This credential has been REVOKED by its issuer${since}. A verifier is likely to refuse it. Tell the user, and do not keep ` +
      'presenting it: ask whether they want a new one.'
    )
  }
  if (status.state === 'unknown') {
    // "Used anyway" is only true where the credential is being presented; a listing (wallet_status) uses nothing.
    return used
      ? `Could not check whether this credential has been revoked (${status.reason}). It was used anyway. If the verifier refuses it, it may have been revoked.`
      : `Could not check whether this credential has been revoked (${status.reason}). That is a warning, not a finding: it does not mean the credential is revoked.`
  }
  return undefined
}

/** The status as a tool result carries it: the state, when it was revoked or why it is unknown, and the sentence to relay. */
export function statusForResult(status: CredentialStatus, used = true): CredentialStatus & { message?: string } {
  const message = describeCredentialStatus(status, used)
  return message === undefined ? status : { ...status, message }
}
