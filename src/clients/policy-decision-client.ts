/**
 * PolicyDecisionClient — the one call that asks the PDP whether a spend is permitted RIGHT NOW.
 *
 * Everything in `policy-read-client.ts` reads the policy's RULES off the chain. None of it can
 * answer "would this payment go through", because that needs cumulative spend — off-chain state
 * held by the Policy Decision Point. This file is that question, and it is an HTTP call to
 * ms-zetrix rather than a contract read.
 *
 * Three properties of the upstream contract shape this whole file. All three were read from
 * ms-zetrix `developv2` on 2026-09-28 (`PolicyDecisionController`, `DecisionReqDto`,
 * `DecisionRespDto`) and none of them is inferable from the endpoint's name.
 *
 * 1. THERE IS NO STEP_UP. `decision` is `"ALLOW"` or `"DENY"`, and the invariant is enforced at
 *    both ends of the server's own factories. This wallet's acceptance criteria named a third verdict
 *    that does not exist upstream, and this client does not manufacture one — a verdict the PDP
 *    never returned is a claim about someone's money that nothing supports.
 *
 * 2. "WE COULD NOT TELL" ARRIVES AS A DENY. A stale ledger, an unreachable registry, an owner-lock
 *    timeout or a window past the retention horizon all come back as `decision: "DENY"` with
 *    `reasonCode: "EVALUATION_UNAVAILABLE"`. A caller reading only `decision` therefore gets the
 *    right ACTION (stop) and the wrong REASON, so this client keeps the two apart: the caller is
 *    told which one it is, and never that the policy refused when in truth nothing was evaluated.
 *
 * 3. AN ALLOW RESERVES BUDGET. The response carries a `reservationId` and the ALLOW holds capacity
 *    for fifteen minutes. This call is therefore NOT a free read, and an agent that polls it
 *    consumes headroom it may never spend. Nothing in this file can prevent that; the tool
 *    description has to say so.
 *
 * Fail-closed, not fail-open. Every other client in this wallet reports a failed lookup as an
 * error STATE rather than a throw, and so does this one — but the direction of the default is the
 * opposite of a balance read. An unreachable balance service must not report `0`; an unreachable
 * DECISION service must not report ALLOW. There is no code path here that produces `permitted`
 * from anything other than the PDP saying so in as many words.
 */

/** `ResponseWrapper` as ms-zetrix serialises it — `object`/`success`, NOT Wallet BE's `data`/`errorCode`. */
interface ZetrixEnvelope<T> {
  object?: T
  success?: boolean
  messages?: Array<{ message?: string; code?: string }>
}

/**
 * The asset, in either shape the server accepts. `"ZTX"` or a `ZTX3…` token address as a bare
 * string, or the object form. Normalised server-side, so both are equally valid on the wire.
 */
export type DecisionAsset = string | { scope: string; tokenAddress: string }

/**
 * Request body for `POST /policy/decisions`.
 *
 * `templateId` is deliberately absent. The server REJECTS it with `POLICY_INVALID_REQUEST` rather
 * than ignoring it (design M48), so a field here would only let a caller build a request that
 * cannot succeed.
 */
export interface DecisionRequest {
  ownerAddress: string
  /**
   * Optional. Omitted, every policy governing `asset` is resolved and ALL must
   * allow — one refusal refuses the request. An owner with no policy for that asset is a DENY
   * carrying `NO_POLICY_FOR_ASSET`, because a policy is how an owner grants authority to spend.
   */
  policyKey?: string
  asset: DecisionAsset
  amount: string
  recipientAddress?: string
  /** ztp20 only; the server defaults it to `"transfer"`. */
  method?: string
  /** Required when the resolved policy sets `payToAllowlist`. */
  payTo?: string
  /**
   * The x402 payment nonce, for correlating a decision with a payment.
   *
   * NOT required by anything: `settlementChannel` is reported informational and never enforced —
   * permanently, by design, with no reason code — so omitting this cannot cause a refusal. The
   * agent-facing schema was corrected and this comment was left saying the opposite.
   */
  paymentNonce?: string
  /**
   * CORRELATION ONLY. Repeating it does NOT deduplicate.
   *
   * The integration guide is explicit (§1.5): "You get a fresh decision every time, and it may
   * differ from the last one… do not build retry logic that assumes a repeated key is safe. EVERY
   * CALL WITH AN ALLOW OUTCOME TAKES ANOTHER RESERVATION." A verdict is only true at the moment it
   * was computed, because settled spend and live reservations both move underneath it.
   *
   * This wallet described it as an idempotency key, copied from a stale server-side comment
   * comment. An agent that believed that would retry an ambiguous call and
   * reserve the owner's budget again each time, with nothing erroring and nothing to see.
   */
  requestKey?: string
}

/** One constraint the PDP could not interpret, and therefore did not enforce. */
export interface AttributeFinding {
  attributeName?: string
  reason?: string
  detail?: string
}

export interface RemainingCapacity {
  perTransaction?: string
  cumulative?: string
  velocity?: string
  transactionCount?: string
}

/** `DecisionRespDto`, exactly as the server declares it. Every value on the wire is a string. */
export interface DecisionResponse {
  decision: 'ALLOW' | 'DENY'
  reasonCode?: string
  resolvedPolicyKey?: string
  remaining?: RemainingCapacity
  /** Present on ALLOW and DENY alike — see `ignored`. */
  enforced?: string[]
  /**
   * Constraints the PDP did NOT enforce. Present on an ALLOW too, deliberately: the server's own
   * docblock says "an ALLOW that silently skipped a constraint it could not interpret is the exact
   * failure §10.3 exists to prevent". A caller that drops this field re-introduces that failure.
   */
  ignored?: AttributeFinding[]
  /** Present on ALLOW. The reservation this decision holds — see property 3 in the header. */
  reservationId?: string
  evaluatedAtBlock?: string
  enforcementFromBlock?: string
  enforcementFromTime?: string
  capacityReturnsAt?: string
  capacityReturning?: string
}

/**
 * Why no verdict came back.
 *
 * Every value is a STOP; what differs is whose problem it is and what to do next. Three of these
 * exist only because the wrong advice is harmful: telling a caller to fix a request that was fine
 * invites it to change the amount and ask again, which is the exploration this tool is built to
 * prevent.
 */
export type UnansweredCause =
  /** 401/403 — the wallet has no credential. Nothing about the request is wrong. */
  | 'unauthorized'
  /** 408/429 — reached, asked to come back. The request never ran, so nothing was reserved. */
  | 'busy'
  /** 404 — one fixed path and no query string, so this is the base URL, not the request. */
  | 'misconfigured'
  /** 400/422 — the request itself. Asking again unchanged cannot help. */
  | 'rejected'
  /** 5xx, transport, timeout, anything unrecognised. The call MAY have run. */
  | 'unreachable'
  /** A 2xx we could not read. The call very likely DID run. */
  | 'unreadable'

/**
 * Two states, and neither of them is a verdict this client invented.
 *
 * `answered` means the PDP evaluated and said something. `unreachable` means we do not know — kept
 * separate from a DENY for the same reason `PolicyRead` keeps `{found:false}` apart from `{error}`:
 * "the policy refused you" and "we could not ask" are different facts about someone's money, and
 * collapsing them is how a transport failure gets reported to a user as a policy decision.
 */
export type DecisionRead =
  | { answered: true; value: DecisionResponse }
  /**
   * We could not get a verdict.
   *
   * `cause` does not change the OUTCOME — every value here is a stop — but it changes what the
   * user should do next, and summarising all of them as "could not be reached" told someone with a
   * malformed request to wait for an outage that was not happening.
   *
   * FOUR VALUES, NOT THREE, and the fourth is the one that fires most often. Splitting on
   * `status < 500` alone put 401 in with malformed requests, so the default deployment — which
   * holds no token and is answered 401 on every call — told the agent its REQUEST was wrong and to
   * fix it. That is an operator's configuration problem, and the advice pushed the agent toward
   * changing the amount and asking again, which is the exploration the tool description exists to
   * prevent. 408 and 429 were caught by the same edge: waiting IS the right move there, and the
   * message forbade it.
   */
  | {
      answered: false
      cause: UnansweredCause
      detail: string
    }

/** Injected so tests exercise the parsing rather than the network. Mirrors `fetch`. */
export type HttpPost = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/**
 * How long to wait before giving up on the decision service.
 *
 * A hung request is not a harmless wait here: §1.4 means the call may ALREADY have reserved the
 * owner's budget, so the longer a caller sits on it the longer it cannot tell a slow answer from a
 * reservation it will never use. Bounded so the caller reaches its "we could not tell" answer —
 * which is a stop — rather than hanging.
 */
export const REQUEST_TIMEOUT_MS = 15_000

export class PolicyDecisionClient {
  private readonly baseUrl: string
  private readonly post: HttpPost
  private readonly authHeader?: string
  private readonly timeoutMs: number

  /**
   * @param authHeader the value for `Authorization`, when one is configured.
   *
   * `/policy/**` carries no entry in the server's `PUBLIC_PATHS`, so it inherits
   * `anyRequest().authenticated()` — unlike `/pay/**`, which is gated by payment instead. The
   * agentic wallet holds no BaaS token today, which is why this is optional rather than required:
   * the call is made, the server answers 401, and the caller gets `unauthorized` — naming the
   * missing credential rather than blaming the request. That is the honest outcome, and it is a
   * far better failure than a client that refuses to try.
   */
  constructor(baseUrl: string, post: HttpPost, authHeader?: string, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.post = post
    this.authHeader = authHeader
    this.timeoutMs = timeoutMs
  }

  /**
   * Ask whether one spend is permitted right now. Never throws, and never returns a verdict of its
   * own making: every `answered` result came from the PDP.
   */
  async decide(request: DecisionRequest): Promise<DecisionRead> {
    const url = `${this.baseUrl}/policy/decisions`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.authHeader) headers.Authorization = this.authHeader

    const timeout = AbortSignal.timeout(this.timeoutMs)

    let res: Awaited<ReturnType<HttpPost>>
    try {
      res = await this.post(url, { method: 'POST', headers, body: JSON.stringify(request), signal: timeout })
    } catch (e) {
      // A timeout is NOT "nothing happened". §1.4: the call may already have reserved the owner's
      // budget, and there is no endpoint to release it — so the caller must be told not to retry.
      // That warning is built in the orchestrator, which owns the user-facing wording; this only
      // has to keep the cause distinguishable.
      return { answered: false, cause: 'unreachable', detail: `request failed — ${(e as Error).message}` }
    }

    let body: string
    try {
      body = await res.text()
    } catch (e) {
      return { answered: false, cause: 'unreadable', detail: `could not read the response — ${(e as Error).message}` }
    }

    if (!res.ok) {
      // A 400 is not a verdict. The server is explicit that a malformed request — an unrecognised
      // asset, an unparseable amount, a request naming templateId — is a 400 and never a decision,
      // "because a verdict implies a policy was consulted, and none was".
      //
      // But "4xx means the caller is wrong" is too coarse, and wrong on the status this wallet
      // sees most: see the DecisionRead docblock.
      return { answered: false, cause: causeFor(res.status), detail: `HTTP ${res.status}${body ? `: ${truncate(body)}` : ''}` }
    }

    let envelope: ZetrixEnvelope<DecisionResponse>
    try {
      envelope = JSON.parse(body) as ZetrixEnvelope<DecisionResponse>
    } catch {
      return { answered: false, cause: 'unreadable', detail: `the response was not JSON: ${truncate(body)}` }
    }

    // `!== true`, not `=== false`. An envelope that omits the field entirely was treated as a
    // success, so a 2xx carrying `object.decision: "ALLOW"` and no `success` produced a permitted
    // answer. Whether ms-zetrix always sends it is UNVERIFIED from this repo, and for a tool whose
    // whole purpose is never to invent a permission, the stricter reading is the only safe default:
    // an envelope we do not recognise is one we cannot act on.
    // An EXPLICIT refusal, and nothing else, means the request was rejected.
    if (envelope?.success === false) {
      // `messages` is upstream-shaped and may not be an array at all, so it is checked before it
      // is walked. Reaching straight for `.map` throws a TypeError out of a method whose whole
      // contract is that it never throws, turning a malformed body into a raw MCP error instead
      // of a classified answer.
      const messages = Array.isArray(envelope.messages) ? envelope.messages : []
      const said = messages.map((m) => m?.message).filter(Boolean).join('; ')
      return {
        answered: false,
        cause: 'rejected',
        detail: `the service refused the request${said ? `: ${truncate(said)}` : ''}`,
      }
    }

    // Anything else about the envelope — null, no `success` at all, a non-boolean — is a body we
    // could not read, NOT a refusal. Collapsing the two told the agent to fix its request on a
    // response that might have carried a real ALLOW, and that response may sit on a decision the
    // server already computed and reserved against.
    if (typeof envelope?.success !== 'boolean') {
      return {
        answered: false,
        cause: 'unreadable',
        detail: `the response envelope carried no usable success flag: ${truncate(body)}`,
      }
    }

    const value = envelope?.object
    // The one shape check that matters. An envelope with no decision, or a decision spelled
    // anything other than the two values the server can produce, is NOT something to pass on as a
    // verdict — a caller checking `=== 'DENY'` would read an unknown string as permission.
    if (!value || (value.decision !== 'ALLOW' && value.decision !== 'DENY')) {
      return { answered: false, cause: 'unreadable', detail: `the response carried no usable decision: ${truncate(body)}` }
    }

    return { answered: true, value }
  }
}

/**
 * Which kind of "we could not tell" a status code means.
 *
 * Only three groups matter, because only three different things can be DONE about them: the
 * operator has to supply a credential, the caller has to change the request, or somebody waits.
 * Anything unrecognised falls to waiting — the conservative end, since telling a caller to change
 * a request that may have been fine is how an agent starts exploring.
 */
function causeFor(status: number): UnansweredCause {
  // Not the caller's request at all. The wallet holds no BaaS token in the default deployment, so
  // this is the answer to essentially every live call today.
  if (status === 401 || status === 403) return 'unauthorized'
  // Reached, and told to come back. Distinct from an outage because the instruction differs —
  // wait, then retry unchanged — and distinct from a timeout because the request never RAN, so
  // nothing was reserved and warning about a reservation would be false.
  if (status === 408 || status === 429) return 'busy'
  // Almost certainly a wrong base URL rather than a wrong request: this client sends one fixed
  // path and no query string, so there is nothing in a caller's input that can produce a 404.
  if (status === 404) return 'misconfigured'
  // The genuinely malformed ones, where asking again unchanged cannot help.
  if (status === 400 || status === 422) return 'rejected'
  return 'unreachable'
}

/** Upstream text is untrusted and ends up in agent-facing output. */
function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
