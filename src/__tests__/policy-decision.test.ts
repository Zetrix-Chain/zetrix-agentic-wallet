/**
 * check_policy_decision — the tool that must never say yes on its own initiative.
 *
 * The acceptance criteria name STEP_UP as a third verdict. It does not exist: ms-zetrix's
 * `DecisionRespDto` answers ALLOW or DENY and enforces that at both ends of its own factories.
 * So these tests pin the opposite of the AC in one place, deliberately and with the reason
 * recorded — and pin the thing the AC gets right, AC #4, as a PROPERTY rather than a case: no
 * input, no failure, no malformed response produces `permitted`.
 */
import { describe, it, expect, vi } from 'vitest'
import { PolicyDecisionClient, REQUEST_TIMEOUT_MS, type HttpPost } from '../clients/policy-decision-client'
import { buildPolicyDecisionClient, buildToolList } from '../index'
import { policyPreflight } from '../orchestrator/policy-preflight'
import { loadConfig } from '../config'
import { checkPolicyDecision } from '../orchestrator/policy-decision'

const OWNER = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const BASE = 'https://ms-zetrix.example/api'

/** `ResponseWrapper` as ms-zetrix serialises it — `object`/`success`, not `data`/`errorCode`. */
const envelope = (object: unknown) => JSON.stringify({ success: true, object, messages: [] })

const http = (body: string, status = 200): HttpPost =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }))

const client = (body: string, status = 200) => new PolicyDecisionClient(BASE, http(body, status))

const ask = (c?: PolicyDecisionClient, over: Record<string, unknown> = {}) =>
  checkPolicyDecision(
    { client: c, network: 'zetrix:testnet' },
    { ownerAddress: OWNER, asset: 'ZTX', amount: '1000', ...over } as never,
  )

const ALLOW = {
  decision: 'ALLOW',
  resolvedPolicyKey: 'native-v1',
  enforced: ['perTransactionMax', 'cumulativeMax'],
  ignored: [],
  reservationId: 'res-abc',
  remaining: { cumulative: '4000' },
}

describe('a verdict is only ever the PDP’s', () => {
  it('reports permitted when, and only when, the service said ALLOW', async () => {
    const r = await ask(client(envelope(ALLOW)))
    expect(r.outcome).toBe('permitted')
    expect(r.policyKey).toBe('native-v1')
    expect(r.enforced).toEqual(['perTransactionMax', 'cumulativeMax'])
  })

  it('reports refused with the reason and the matched rule (AC #2)', async () => {
    const r = await ask(client(envelope({
      decision: 'DENY',
      reasonCode: 'CUMULATIVE_EXCEEDED',
      resolvedPolicyKey: 'native-v1',
      enforced: ['cumulativeMax'],
      remaining: { cumulative: '0' },
      capacityReturnsAt: '2026-09-29T00:00:00Z',
    })))
    expect(r.outcome).toBe('refused')
    expect(r.reasonCode).toBe('CUMULATIVE_EXCEEDED')
    expect(r.policyKey).toBe('native-v1')
    expect(r.enforced).toEqual(['cumulativeMax'])
    expect(r.summary).toMatch(/cumulative cap/i)
    // No capacity-return claim: the server always sends null for it (guide §9).
    expect(r.summary).not.toMatch(/Capacity returns at/i)
  })

  it('never invents STEP_UP, because the service has no such verdict', async () => {
    // AC #1 and #3 name a third verdict. DecisionRespDto: `decision` is "ALLOW" | "DENY", and
    // deny()/unavailable() throw if handed the wrong reason code. A tool that manufactured
    // STEP_UP would be asserting that a human must approve a spend, on no evidence at all.
    for (const body of [
      envelope(ALLOW),
      envelope({ decision: 'DENY', reasonCode: 'RECIPIENT_DENYLISTED' }),
      envelope({ decision: 'DENY', reasonCode: 'EVALUATION_UNAVAILABLE' }),
    ]) {
      const r = await ask(client(body))
      expect(['permitted', 'refused', 'undetermined']).toContain(r.outcome)
      expect(JSON.stringify(r)).not.toMatch(/STEP_UP|step.?up|approval required/i)
    }
  })
})

describe('"we could not tell" is never reported as a refusal', () => {
  it('separates EVALUATION_UNAVAILABLE from a real DENY, though both arrive as DENY', async () => {
    // The whole reason this distinction is in the tool and not left to the caller: both are
    // decision:"DENY" on the wire. One means the policy refused you; the other means nothing was
    // evaluated. Telling a user their policy blocked them when the ledger was merely stale is a
    // false statement about their own configuration.
    const r = await ask(client(envelope({
      decision: 'DENY',
      reasonCode: 'EVALUATION_UNAVAILABLE',
    })))
    expect(r.outcome).toBe('undetermined')
    expect(r.reasonCode).toBe('EVALUATION_UNAVAILABLE')
    expect(r.summary).toMatch(/did NOT refuse/i)
    expect(r.notChecked.join(' ')).toMatch(/NOT a refusal/i)
  })

  it('a real DENY is not softened into undetermined', async () => {
    // The inverse, stated as its own test so a future edit cannot make both answers the same.
    const r = await ask(client(envelope({ decision: 'DENY', reasonCode: 'RECIPIENT_DENYLISTED' })))
    expect(r.outcome).toBe('refused')
    expect(r.summary).toMatch(/REFUSES/)
  })

  it('reports an unrecognised reason code verbatim instead of describing it', async () => {
    // A code this wallet has never seen gets no invented meaning — the same discipline as
    // declining to interpret a list whose polarity is unknown (APP-C01).
    const r = await ask(client(envelope({ decision: 'DENY', reasonCode: 'SOME_NEW_CODE' })))
    expect(r.outcome).toBe('refused')
    expect(r.reasonCode).toBe('SOME_NEW_CODE')
    expect(r.summary).toContain('SOME_NEW_CODE')
    expect(r.summary).toMatch(/does not recognise/i)
  })
})

describe('AC #4 — nothing but an ALLOW produces permitted', () => {
  /**
   * Stated as a property over every failure this tool can meet, not as one unreachable-service
   * case. A false ALLOW is the only defect here that spends someone's money, so the assertion is
   * over the whole space rather than over the examples someone thought to list.
   */
  const failures: Array<[string, () => Promise<{ outcome: string }>]> = [
    ['no client configured', () => ask(undefined)],
    ['transport threw', () => ask(new PolicyDecisionClient(BASE, async () => { throw new Error('ECONNREFUSED') }))],
    ['401 unauthorised', () => ask(client('{"error":"unauthorized"}', 401))],
    ['500 from the service', () => ask(client('boom', 500))],
    ['body is not JSON', () => ask(client('<html>gateway</html>'))],
    // The one the first pass missed. Every other error case here fails to PARSE, so the status
    // check was never what stopped them: deleting  survived the whole suite. An
    // error response whose body happens to be a well-formed envelope is the input that tells the
    // status check apart from the parse checks — a 500 or a 401 carrying a stale ALLOW body is
    // exactly the shape that would turn an outage into permission to spend.
    ['503 carrying a well-formed ALLOW envelope', () => ask(client(envelope(ALLOW), 503))],
    ['401 carrying a well-formed ALLOW envelope', () => ask(client(envelope(ALLOW), 401))],
    ['200-shaped ALLOW behind a 500', () => ask(client(envelope(ALLOW), 500))],
    ['envelope says success:false', () => ask(client(JSON.stringify({ success: false, messages: [{ message: 'nope' }] })))],
    // Same shape as the 503-carrying-an-ALLOW case: when the refusal flag and a well-formed
    // decision arrive together, only the flag can stop it being read as a verdict.
    ['success:false carrying a well-formed ALLOW', () => ask(client(JSON.stringify({ success: false, object: ALLOW })))],
    ['envelope carries no object', () => ask(client(JSON.stringify({ success: true })))],
    ['decision field missing', () => ask(client(envelope({ reasonCode: 'CUMULATIVE_EXCEEDED' })))],
    ['decision is an unknown string', () => ask(client(envelope({ decision: 'MAYBE' })))],
    ['decision is lowercase', () => ask(client(envelope({ decision: 'allow' })))],
    ['decision is true', () => ask(client(envelope({ decision: true })))],
    ['response is an empty body', () => ask(client(''))],
    ['ownerAddress missing', () => ask(client(envelope(ALLOW)), { ownerAddress: undefined })],
    ['amount is not a number', () => ask(client(envelope(ALLOW)), { amount: 'lots' })],
    ['amount is a number, not a string', () => ask(client(envelope(ALLOW)), { amount: 1000 })],
    ['asset missing', () => ask(client(envelope(ALLOW)), { asset: undefined })],
  ]

  for (const [label, run] of failures) {
    it(`does not answer permitted: ${label}`, async () => {
      const r = await run()
      expect(r.outcome, label).not.toBe('permitted')
      expect(r.outcome, label).toBe('undetermined')
    })
  }

  it('says plainly that undetermined is neither permission nor refusal', async () => {
    // The sentence an agent reads back to a user. "Could not reach the service" being reported as
    // "your policy blocked this" is the failure this wording exists to prevent.
    const r = await ask(new PolicyDecisionClient(BASE, async () => { throw new Error('ECONNREFUSED') }))
    expect(r.summary).toMatch(/UNKNOWN/)
    expect(r.summary).toMatch(/not a refusal/i)
    expect(r.summary).toMatch(/not permission/i)
    expect(r.summary).toContain('ECONNREFUSED')
  })
})

describe('what a permitted answer does not settle', () => {
  it('surfaces constraints the service could not enforce, ON a permitted answer', async () => {
    // The server's own reason for returning `ignored` on an ALLOW: "an ALLOW that silently
    // skipped a constraint it could not interpret is the exact failure §10.3 exists to prevent".
    // A tool that dropped the field on success would reintroduce it here instead.
    const r = await ask(client(envelope({
      ...ALLOW,
      ignored: [{ attributeName: 'settlementChannel', reason: 'NO_EVALUATOR' }],
    })))
    expect(r.outcome).toBe('permitted')
    expect(r.ignored).toHaveLength(1)
    expect(r.summary).toMatch(/could\s+not be enforced/i)
    expect(r.summary).toMatch(/narrower evidence/i)
  })

  it('warns that an ALLOW reserved capacity, so polling costs headroom', async () => {
    const r = await ask(client(envelope(ALLOW)))
    expect(r.reservationId).toBe('res-abc')
    expect(r.summary).toMatch(/RESERVED for about 15 minutes/i)
    expect(r.summary).toMatch(/do not call this repeatedly/i)
  })

  it('carries notChecked on every outcome, including a permitted one', async () => {
    for (const body of [
      envelope(ALLOW),
      envelope({ decision: 'DENY', reasonCode: 'RECIPIENT_DENYLISTED' }),
      envelope({ decision: 'DENY', reasonCode: 'EVALUATION_UNAVAILABLE' }),
    ]) {
      const r = await ask(client(body))
      expect(r.notChecked.length).toBeGreaterThan(0)
      expect(r.notChecked.join(' ')).toMatch(/still true when the payment is actually made/i)
    }
  })

  it('warns on a network where the registry is not deployed', async () => {
    const r = await checkPolicyDecision(
      { client: undefined, network: 'zetrix:mainnet' },
      { ownerAddress: OWNER, asset: 'ZTX', amount: '1' },
    )
    expect(r.outcome).toBe('undetermined')
    expect(r.notChecked.join(' ')).toMatch(/not deployed/i)
  })
})

describe('the request this tool will and will not send', () => {
  it('refuses templateId locally rather than spending a call on a guaranteed 400', async () => {
    // The server rejects templateId with POLICY_INVALID_REQUEST deliberately rather than ignoring
    // it (design M48), and a 400 is not a verdict. A local refusal can say why; a 400 cannot.
    const post = http(envelope(ALLOW))
    const r = await checkPolicyDecision(
      { client: new PolicyDecisionClient(BASE, post), network: 'zetrix:testnet' },
      { ownerAddress: OWNER, asset: 'ZTX', amount: '1', templateId: 'a'.repeat(64) } as never,
    )
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/templateId is not accepted/i)
    expect(post).not.toHaveBeenCalled()
  })

  it('sends the body and path the service declares, and omits policyKey when not given', async () => {
    const post = http(envelope(ALLOW))
    await checkPolicyDecision(
      { client: new PolicyDecisionClient(BASE, post), network: 'zetrix:testnet' },
      { ownerAddress: OWNER, asset: { scope: 'ztp20', tokenAddress: 'ZTX3Tok' }, amount: '25', recipientAddress: 'ZTX3Rcpt' },
    )
    const [url, init] = (post as unknown as { mock: { calls: [string, { body: string; headers: Record<string, string> }][] } }).mock.calls[0]
    expect(url).toBe(`${BASE}/policy/decisions`)
    const sent = JSON.parse(init.body)
    expect(sent).toEqual({
      ownerAddress: OWNER,
      asset: { scope: 'ztp20', tokenAddress: 'ZTX3Tok' },
      amount: '25',
      recipientAddress: 'ZTX3Rcpt',
    })
    // Omitted, not sent as null — the server resolves every policy for the asset when it is absent.
    expect('policyKey' in sent).toBe(false)
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends Authorization only when one is configured', async () => {
    const post = http(envelope(ALLOW))
    await new PolicyDecisionClient(BASE, post, 'Bearer tok').decide({ ownerAddress: OWNER, asset: 'ZTX', amount: '1' })
    const [, init] = (post as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer tok')
  })

  it('caps untrusted upstream text before it reaches the agent', async () => {
    // Upstream error bodies land in agent-facing output, and many review rounds went on
    // exactly this: an unbounded echo of someone else's text is a context-flood vector.
    const r = await ask(client('x'.repeat(50_000), 502))
    expect(r.outcome).toBe('undetermined')
    expect(r.summary.length).toBeLessThan(600)
  })
})

describe('round 1 — what the ms-zetrix integration guide says, which this wallet had not read', () => {
  it('describes requestKey as correlation only, never as idempotency', () => {
    // APP-M01. The field was documented as an idempotency key, copied from a stale server-side
    // comment. Guide §1.5: "Repeating it does not deduplicate… do not build retry logic that
    // assumes a repeated key is safe. Every call with an ALLOW outcome takes another reservation."
    // An agent that believed the old text would retry and reserve the owner's budget each time.
    const tool = buildToolList().find((t) => t.name === 'check_policy_decision')!
    const text = tool.inputSchema.properties.requestKey!.description
    expect(text).toMatch(/NOT an idempotency/i)
    expect(text).toMatch(/does not deduplicate/i)
    expect(text).toMatch(/reserves the budget again/i)
    expect(text).not.toMatch(/^Idempotency key/i)
  })

  it('puts the do-not-explore rules in the tool description, where the guide says they belong', () => {
    // APP-M02. Guide §7: "If you expose this as an MCP tool, the model will call it speculatively
    // unless told not to — put the 'do not explore' rule in the tool description itself, not only
    // in your code." Each clause below is a separate rule from that section, so losing any one of
    // them fails rather than being absorbed by the others.
    const description = buildToolList().find((t) => t.name === 'check_policy_decision')!.description
    expect(description, 'no probing for an amount that fits').toMatch(/DO NOT EXPLORE/i)
    expect(description, 'the worked example from the guide').toMatch(/can I send 5\? no\? can I send 3\?/i)
    expect(description, 'compute locally from one answer').toMatch(/call ONCE and read "remaining"/i)
    expect(description, 'a refusal costs nothing, an allow does').toMatch(/refusal reserves nothing/i)
    expect(description, 'call before BUILDING, not before signing').toMatch(/BEFORE building the transaction/i)
    expect(description, 'the timeout rule, which is the one with money attached').toMatch(
      /NEVER retry automatically after a timeout/i,
    )
    expect(description).toMatch(/reserves it a second time/i)
  })

  it('warns that a timeout may already have reserved the budget', async () => {
    // APP-M02, and the part of it that is not documentation. Guide §7: "A network timeout may mean
    // the decision SUCCEEDED and reserved, and your retry will reserve again." Round 1 reported a
    // transport failure as a plain "could not be reached", which invites exactly that retry.
    const r = await ask(new PolicyDecisionClient(BASE, async () => { throw new Error('ETIMEDOUT') }))
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/DO NOT automatically retry/i)
    expect(r.summary).toMatch(/the call may have succeeded and already reserved/i)
    expect(r.summary).toMatch(/reserve it a second time/i)
  })

  it('tells a rejected request apart from an outage — same stop, different next step', async () => {
    // APP-L01. Every non-answered case read as "could not be reached", which told someone with a
    // malformed request to wait out an outage that was not happening.
    const rejected = await ask(client(JSON.stringify({ detail: 'bad asset' }), 400))
    expect(rejected.outcome).toBe('undetermined')
    expect(rejected.summary).toMatch(/REFUSED this request/i)
    expect(rejected.summary).toMatch(/fix it rather than waiting or retrying/i)
    // And a rejection must NOT carry the retry warning, which is about a call that may have run.
    expect(rejected.summary).not.toMatch(/reserved this owner's budget/i)

    const outage = await ask(client('gateway down', 503))
    expect(outage.summary).toMatch(/could not be reached/i)
    expect(outage.summary).toMatch(/DO NOT automatically retry/i)
  })

  it('never claims a capacity-return time, because the server never sends one', async () => {
    // Guide §9: capacityReturnsAt and capacityReturning are ALWAYS null — deferred deliberately,
    // because "a wrong 'you can spend again at' is worse than none". Round 1 built a sentence
    // around a field that can never arrive; had it arrived, the claim would have been unverified.
    const r = await ask(client(envelope({
      decision: 'DENY',
      reasonCode: 'CUMULATIVE_EXCEEDED',
      capacityReturnsAt: '2026-09-29T00:00:00Z',
    })))
    expect(r.outcome).toBe('refused')
    expect(r.summary).not.toMatch(/Capacity returns at/i)
  })

  it('says where a "remaining" figure is measured from', async () => {
    // Guide §1.6: limits are prospective and the enforcement floor is written once, on the owner's
    // very first decision. "A lifetime cumulative cap counts from that block, not from account
    // creation" — so a user who checks their own chain history will think the number is wrong
    // unless told where it starts.
    const r = await ask(client(envelope({ ...ALLOW, enforcementFromBlock: '4248521' })))
    expect(r.outcome).toBe('permitted')
    expect(r.notChecked.join(' ')).toMatch(/counted from block 4248521/)
    expect(r.notChecked.join(' ')).toMatch(/NOT from the account's whole history/i)
  })

  it('refuses an asset shape the server answers 400 for, rather than spending a call to learn it', async () => {
    // APP-L04, and guide §1.5: a native scope carrying a tokenAddress is rejected rather than
    // cleaned up, "because quietly discarding the address would answer a different question than
    // the one you asked". A local refusal can say that; a 400 cannot.
    const post = http(envelope(ALLOW))
    const r = await checkPolicyDecision(
      { client: new PolicyDecisionClient(BASE, post), network: 'zetrix:testnet' },
      { ownerAddress: OWNER, asset: { scope: 'native', tokenAddress: 'ZTX3Tok' }, amount: '1' },
    )
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/Did you mean scope "ztp20"/i)
    expect(post).not.toHaveBeenCalled()
  })

  const badAssets: Array<[string, unknown]> = [
    ['a number', 5],
    ['a bare object', {}],
    ['an unknown scope', { scope: 'erc20', tokenAddress: 'ZTX3Tok' }],
    ['ztp20 with no tokenAddress', { scope: 'ztp20' }],
    ['ztp20 with a blank tokenAddress', { scope: 'ztp20', tokenAddress: '   ' }],
    ['a whitespace-only string', '   '],
    ['an array', ['ZTX']],
  ]
  for (const [label, asset] of badAssets) {
    it(`refuses an asset that is ${label}, without calling the service`, async () => {
      const post = http(envelope(ALLOW))
      const r = await checkPolicyDecision(
        { client: new PolicyDecisionClient(BASE, post), network: 'zetrix:testnet' },
        { ownerAddress: OWNER, asset: asset as never, amount: '1' },
      )
      expect(r.outcome, label).toBe('undetermined')
      expect(post, label).not.toHaveBeenCalled()
    })
  }

  const badAmounts = ['12abc', 'abc12', '1.5', '-1', '1e5', ' 12', '12 ', '', '0x10']
  for (const amount of badAmounts) {
    it(`refuses the amount ${JSON.stringify(amount)}, which the regex anchors are there to catch`, async () => {
      // The anchors on /^\d+$/ were droppable without failing anything, so each side is exercised.
      const post = http(envelope(ALLOW))
      const r = await checkPolicyDecision(
        { client: new PolicyDecisionClient(BASE, post), network: 'zetrix:testnet' },
        { ownerAddress: OWNER, asset: 'ZTX', amount },
      )
      expect(r.outcome, amount).toBe('undetermined')
      expect(post, amount).not.toHaveBeenCalled()
    })
  }

  it('bounds the request, so a hung call cannot sit on a reservation indefinitely', async () => {
    // APP-L05. A hung request is not a harmless wait: the call may already have reserved.
    //
    // The signal is captured and asserted OUTSIDE the transport. Asserting inside it looks
    // equivalent and is not: `decide` wraps the call in try/catch, so a failed expectation is
    // caught as a transport error and the test passes anyway. Removing the signal survived.
    let seen: unknown = 'never called'
    const post = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      seen = init.signal
      return { ok: true, status: 200, text: async () => envelope(ALLOW) }
    })
    const read = await new PolicyDecisionClient(BASE, post as never).decide({
      ownerAddress: OWNER,
      asset: 'ZTX',
      amount: '1',
    })
    expect(read.answered).toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
    expect(seen).toBeInstanceOf(AbortSignal)
  })

  it('pins the default timeout absolutely, not against itself', () => {
    // The hung-service test below passes its own 10ms, so it never exercises the DEFAULT — and
    // raising the constant to a day survived the whole suite. Same class as APP-M03: a
    // bound compared only against itself cannot fail at any value.
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(1_000)
  })

  it('gives up on a hung service rather than waiting on it forever', async () => {
    // The bound is real, not just present: a transport that never settles must still produce an
    // answer, and that answer must be the stop.
    const client = new PolicyDecisionClient(
      BASE,
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')))
        }),
      undefined,
      10,
    )
    const r = await checkPolicyDecision({ client, network: 'zetrix:testnet' }, {
      ownerAddress: OWNER,
      asset: 'ZTX',
      amount: '1',
    })
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/DO NOT automatically retry/i)
  })

  it('tells the agent that every decision is EVALUATION_UNAVAILABLE while the crawl is off', () => {
    // APP-L03, guide §10: the crawl is off in every environment pending a later change, so there is no
    // spend ledger to evaluate against and every decision answers EVALUATION_UNAVAILABLE. Worth
    // saying, because an agent otherwise reports a working system as broken.
    const description = buildToolList().find((t) => t.name === 'check_policy_decision')!.description
    // The ticket id is stripped from shipped text; the FACT it carried is what an agent needs.
    expect(description).toMatch(/crawl is switched off/i)
    expect(description).toMatch(/EVALUATION_UNAVAILABLE/)
    expect(description).toMatch(/correct behaviour rather than an outage/i)
  })
})

describe('round 1 — the wiring, which the first pass never mutated', () => {
  it('builds no client when no decision URL is configured, and one when there is', () => {
    // APP-L06. The first pass mutated the two new files and reported "0 survived", which was true
    // of those files and not of the change: the builder, the config reads and the auth header had
    // no tests at all. Deleting the builder's guard, or its whole body, survived.
    expect(buildPolicyDecisionClient({}).policyDecisionClient).toBeUndefined()
    expect(buildPolicyDecisionClient({ policyDecisionAuth: 'Bearer x' }).policyDecisionClient).toBeUndefined()
    expect(
      buildPolicyDecisionClient({ policyDecisionUrl: 'https://ms.test/api' }).policyDecisionClient,
    ).toBeInstanceOf(PolicyDecisionClient)
  })

  it('reads POLICY_DECISION_URL and POLICY_DECISION_AUTH, and strips a trailing slash', () => {
    const env = {
      HSM_PASSWORD: 'x',
      WALLET_BE_URL: 'https://be.test',
      ZETRIX_NODE_HOST: 'n.test',
      POLICY_DECISION_URL: 'https://ms.test/api/',
      POLICY_DECISION_AUTH: 'Bearer tok',
    }
    const config = loadConfig(env)
    expect(config.policyDecisionUrl).toBe('https://ms.test/api')
    expect(config.policyDecisionAuth).toBe('Bearer tok')
    // Absent by default: there is no host this wallet can reach, and guessing one would turn
    // "nobody has wired this up" into a connection error.
    expect(loadConfig({ HSM_PASSWORD: 'x', WALLET_BE_URL: 'https://be.test', ZETRIX_NODE_HOST: 'n.test' }).policyDecisionUrl).toBeUndefined()
  })

  it('sends the configured Authorization header through the builder, not only the constructor', async () => {
    const calls: Array<Record<string, string>> = []
    const built = buildPolicyDecisionClient({
      policyDecisionUrl: 'https://ms.test/api',
      policyDecisionAuth: 'Bearer wired',
    }).policyDecisionClient!
    // Reach the private transport by swapping global fetch for one call.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers)
      return { ok: true, status: 200, text: async () => envelope(ALLOW) }
    }) as never
    try {
      await built.decide({ ownerAddress: OWNER, asset: 'ZTX', amount: '1' })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls[0].Authorization).toBe('Bearer wired')
  })

  it('does not tell the agent about a STEP_UP that does not exist', async () => {
    // The sentence lives in policy_preflight's RUNTIME output — baseNotChecked — not in its
    // schema. The first version of this test serialised the tool definition, which could never
    // contain it, so reverting the fix survived. Asserted on a real result now, and on the schema
    // too, because either would be a lie.
    const result = await policyPreflight(
      { readTemplate: async () => ({ found: false }) as never, network: 'zetrix:testnet' },
      { policyKey: 'k', attributes: [], validFromBlock: '0', validToBlock: '0' },
    )
    expect(result.notChecked.join(' ')).toMatch(/ALLOW or DENY/)
    expect(JSON.stringify(result)).not.toMatch(/STEP_UP/)
    expect(JSON.stringify(buildToolList())).not.toMatch(/STEP_UP/)
  })

  it('requires the three inputs a decision cannot be asked without', () => {
    const tool = buildToolList().find((t) => t.name === 'check_policy_decision')!
    expect(tool.inputSchema.required).toEqual(['ownerAddress', 'asset', 'amount'])
  })
})

describe('round 2 — whose problem is it, and what should be done about it', () => {
  /**
   * Every case here ends `undetermined`. What is under test is the SENTENCE, because that is the
   * whole point of splitting the causes: the outcome is always stop, and the advice is not.
   *
   * Round 1 split on `status < 500` alone, which put 401 in with malformed requests — and 401 is
   * what the default deployment gets on every single call, since the wallet holds no token. The
   * agent was told its request was wrong and to fix it, which is an invitation to change the
   * amount and ask again: the exploration the tool description spends a paragraph forbidding.
   */
  const causeCases: Array<[number, RegExp[], RegExp[]]> = [
    // status, must say, must NOT say
    [401, [/not authorised/i, /has no credential/i, /Do not change the amount/i], [/problem with the request itself/i, /already reserved/i]],
    [403, [/not authorised/i, /has no credential/i], [/problem with the request itself/i]],
    [400, [/REFUSED this request/i, /fix it rather than waiting/i], [/not authorised/i, /already reserved/i]],
    // 404 and 408/429 moved to their own causes in round 3 and are asserted in full there.
    [404, [/not found at the configured address/i], [/REFUSED this request/i]],
    [422, [/REFUSED this request/i], [/not authorised/i]],
    // Transient: waiting IS the answer, so these must not be told to "fix" anything.
    [408, [/busy or rate-limiting/i], [/could not be reached/i, /fix it rather than waiting/i]],
    [429, [/busy or rate-limiting/i], [/could not be reached/i, /fix it rather than waiting/i]],
    [500, [/could not be reached/i, /DO NOT automatically retry/i], [/fix it rather than waiting/i]],
    [503, [/could not be reached/i], [/fix it rather than waiting/i]],
    // Unrecognised falls to the conservative end rather than accusing the caller.
    [418, [/could not be reached/i], [/fix it rather than waiting/i, /not authorised/i]],
  ]

  for (const [status, must, mustNot] of causeCases) {
    it(`gives the right next step for ${status}`, async () => {
      const r = await ask(client(JSON.stringify({ detail: 'x' }), status))
      expect(r.outcome, String(status)).toBe('undetermined')
      for (const re of must) expect(r.summary, `${status} should match ${re}`).toMatch(re)
      for (const re of mustNot) expect(r.summary, `${status} should NOT match ${re}`).not.toMatch(re)
    })
  }

  it('warns about a possible reservation only where the call may have run', async () => {
    // The warning is a claim about the owner's budget. A refused or unauthorised request reserved
    // nothing, so carrying it there would be asserting something nothing supports — while a
    // garbled 200 may well have been computed and reserved, which is where it belongs most.
    // EVERY unreadable path, not just the one that fails JSON.parse. A 200 the wallet could not
    // read may still have been a decision the server computed and reserved against, so each of
    // these must carry the warning — reclassifying any one of them as "rejected" would drop it,
    // and pinning only the parse failure let exactly that mutation survive.
    const unreadable: Array<[string, string]> = [
      ['truncated JSON', '{"object":{"decision":'],
      ['not JSON at all', '<html>ok</html>'],
      ['envelope with no object', JSON.stringify({ success: true })],
      ['unknown decision value', envelope({ decision: 'MAYBE' })],
      ['lowercase allow', envelope({ decision: 'allow' })],
    ]
    for (const [label, body] of unreadable) {
      const r = await ask(client(body, 200))
      expect(r.outcome, label).toBe('undetermined')
      expect(r.summary, label).toMatch(/could not read/i)
      expect(r.summary, label).toMatch(/already reserved/i)
      expect(r.summary, label).not.toMatch(/REFUSED this request/i)
    }

    // The third unreadable path: the body itself cannot be read. Reachable in real life on a
    // dropped connection mid-response, and it is the one case where the server may have done the
    // whole job — computed the decision and taken the reservation — before we lost the body.
    const bodyThrew = await checkPolicyDecision(
      {
        client: new PolicyDecisionClient(BASE, async () => ({
          ok: true,
          status: 200,
          text: async () => { throw new Error('ECONNRESET mid-body') },
        })),
        network: 'zetrix:testnet',
      },
      { ownerAddress: OWNER, asset: 'ZTX', amount: '1' },
    )
    expect(bodyThrew.outcome).toBe('undetermined')
    expect(bodyThrew.summary).toMatch(/could not read/i)
    expect(bodyThrew.summary).toMatch(/already reserved/i)
    expect(bodyThrew.summary).not.toMatch(/REFUSED this request/i)

    const garbled = await ask(client('{"object":{"decision":', 200))
    expect(garbled.outcome).toBe('undetermined')
    expect(garbled.summary).toMatch(/could not read/i)
    expect(garbled.summary).toMatch(/DO NOT automatically retry/i)
    expect(garbled.summary).toMatch(/already reserved/i)

    for (const status of [400, 401]) {
      const r = await ask(client('{"detail":"x"}', status))
      expect(r.summary, String(status)).not.toMatch(/already reserved/i)
    }
  })

  it('treats a refusing envelope as a rejection, not an outage', async () => {
    // Pins the `success:false` mapping, which a mutation to `unreachable` would otherwise survive.
    const r = await ask(client(JSON.stringify({ success: false, messages: [{ message: 'nope' }] })))
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/REFUSED this request/i)
    expect(r.summary).not.toMatch(/could not be reached/i)
  })

  it('does not read an envelope that omits success as a success', async () => {
    // A 2xx carrying `object.decision: "ALLOW"` and no `success` produced `permitted`. Whether
    // ms-zetrix always sends the field is UNVERIFIED from this repo, and for a tool whose whole
    // purpose is never to invent a permission, an envelope we do not recognise is one we cannot
    // act on.
    const r = await ask(client(JSON.stringify({ object: ALLOW })))
    expect(r.outcome).toBe('undetermined')
    expect(r.outcome).not.toBe('permitted')

    // And the well-formed one still works, so this is a guard rather than a break.
    const ok = await ask(client(envelope(ALLOW)))
    expect(ok.outcome).toBe('permitted')
  })

  it('says where a "remaining" figure starts on a REFUSAL too, not only on a permitted answer', async () => {
    // The tool tells the agent to compute from `remaining` locally, and a cap-breach DENY is
    // exactly where it will — so that is exactly where the number looks wrong without the note.
    const r = await ask(client(envelope({
      decision: 'DENY',
      reasonCode: 'CUMULATIVE_EXCEEDED',
      remaining: { cumulative: '0' },
      enforcementFromBlock: '4248521',
    })))
    expect(r.outcome).toBe('refused')
    expect(r.notChecked.join(' ')).toMatch(/counted from block 4248521/)
  })

  it('ships no internal ticket or review references in agent-facing text', async () => {
    // `develop` strips these from shipped files ahead of the public mirror; round 1 re-added
    // about eleven, one of them in a string an agent reads aloud.
    const shipped = JSON.stringify(buildToolList())
    expect(shipped).not.toMatch(/BT-\d+/)
    expect(shipped).not.toMatch(/APP-[A-Z]?\d+/)
    // The FACT survives the identifier: an agent still needs to know why every answer is
    // undetermined today.
    const description = buildToolList().find((t) => t.name === 'check_policy_decision')!.description
    expect(description).toMatch(/crawl is switched off/i)
    expect(description).toMatch(/EVALUATION_UNAVAILABLE/)

    const r = await ask(client(envelope(ALLOW)))
    expect(JSON.stringify(r)).not.toMatch(/BT-\d+|APP-[A-Z]?\d+/)
  })
})

describe('round 3 — the envelope guard was doing two jobs and doing both wrong', () => {
  /**
   * `success !== true` collapsed "the service said no" into "we could not read this", and then
   * reached for `.messages.map` on an envelope that might not exist. One guard, two defects: a
   * throw out of a method whose contract is that it never throws, and "fix your request" told to a
   * caller whose response might have carried a real ALLOW.
   */
  const shapes: Array<[string, string]> = [
    ['a bare null body', 'null'],
    ['a JSON string', '"ok"'],
    ['a JSON number', '42'],
    ['a bare array', '[]'],
    ['an empty object', '{}'],
    ['success omitted, object present', JSON.stringify({ object: ALLOW })],
    ['success as a string', JSON.stringify({ success: 'true', object: ALLOW })],
    ['success as a number', JSON.stringify({ success: 1, object: ALLOW })],
    ['success null', JSON.stringify({ success: null, object: ALLOW })],
    ['success:false with messages as a string', JSON.stringify({ success: false, messages: 'nope' })],
    ['success:false with messages as an object', JSON.stringify({ success: false, messages: { a: 1 } })],
    ['success:false with a null in messages', JSON.stringify({ success: false, messages: [null] })],
    ['success:false with no messages at all', JSON.stringify({ success: false })],
  ]

  for (const [label, body] of shapes) {
    it(`answers rather than throwing: ${label}`, async () => {
      // The contract is "never throws". A malformed body must become a classified answer, not a
      // raw MCP error, and certainly not a permitted one.
      const r = await ask(client(body, 200))
      expect(r.outcome, label).toBe('undetermined')
      expect(r.summary, label).toBeTruthy()
    })
  }

  it('calls an explicit refusal a refusal, and anything else unreadable', async () => {
    // The distinction the collapsed guard destroyed. Only `success: false` is the service saying
    // no; everything else is a body we could not read — and an unreadable 2xx may sit on a
    // decision the server already computed and reserved against, which is the opposite
    // instruction from "fix your request".
    const refused = await ask(client(JSON.stringify({ success: false, messages: [{ message: 'bad asset' }] })))
    expect(refused.summary).toMatch(/REFUSED this request/i)
    expect(refused.summary).toContain('bad asset')
    expect(refused.summary).not.toMatch(/already reserved/i)

    for (const [label, body] of shapes.filter(([l]) => !l.startsWith('success:false'))) {
      const r = await ask(client(body, 200))
      expect(r.summary, label).not.toMatch(/REFUSED this request/i)
      expect(r.summary, label).toMatch(/could not read/i)
      expect(r.summary, label).toMatch(/already reserved/i)
    }
  })

  it('still refuses to call a missing success flag a permission', async () => {
    // The round-2 guard existed for this, and it still holds — the fix narrows what counts as a
    // REFUSAL without widening what counts as a PASS.
    const r = await ask(client(JSON.stringify({ object: ALLOW })))
    expect(r.outcome).not.toBe('permitted')
    expect(await ask(client(envelope(ALLOW))).then((x) => x.outcome)).toBe('permitted')
  })
})

describe('round 3 — busy and misconfigured are not outages', () => {
  it('tells a rate-limited caller to wait and ask again UNCHANGED', async () => {
    // I claimed last round that 408/429 got "waiting is the answer". They did not: they went
    // through the same branch as a timeout, which says "could not be reached" — it was reached —
    // and warns about a reservation that cannot exist, because the request never ran.
    for (const status of [408, 429]) {
      const r = await ask(client(JSON.stringify({ detail: 'slow down' }), status))
      expect(r.outcome, String(status)).toBe('undetermined')
      expect(r.summary, String(status)).toMatch(/busy or rate-limiting/i)
      expect(r.summary, String(status)).toMatch(/nothing was reserved/i)
      expect(r.summary, String(status)).toMatch(/ask again UNCHANGED/i)
      // The two claims that would be false here.
      expect(r.summary, String(status)).not.toMatch(/could not be reached/i)
      expect(r.summary, String(status)).not.toMatch(/already reserved/i)
      expect(r.summary, String(status)).not.toMatch(/fix it rather than waiting/i)
    }
  })

  it('treats a 404 as a wrong address, not a wrong request', async () => {
    // This client sends one fixed path and no query string, so nothing a caller supplies can
    // produce a 404. Telling them to fix their request sends them hunting in the wrong place.
    const r = await ask(client('not found', 404))
    expect(r.outcome).toBe('undetermined')
    expect(r.summary).toMatch(/not found at the configured address/i)
    expect(r.summary).toMatch(/setup problem/i)
    expect(r.summary).not.toMatch(/problem with the request itself/i)
  })

  it('keeps 400 and 422 as the caller’s to fix', async () => {
    for (const status of [400, 422]) {
      const r = await ask(client(JSON.stringify({ detail: 'bad amount' }), status))
      expect(r.summary, String(status)).toMatch(/REFUSED this request/i)
      expect(r.summary, String(status)).toMatch(/fix it rather than waiting/i)
    }
  })
})
