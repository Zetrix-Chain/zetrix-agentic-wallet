import { describe, it, expect } from 'vitest'
import { policyPreflight } from '../orchestrator/policy-preflight'
import type { TemplateRecord } from '../clients/policy-read-client'

const TEMPLATE: TemplateRecord = {
  attributes: [
    { attributeName: 'x402', attributeType: 'uint' },
    { attributeName: 'maxTransactionCount', attributeType: 'uint' },
    { attributeName: 'countWindow', attributeType: 'uint' },
    { attributeName: 'cumulativeMax', attributeType: 'uint' },
    { attributeName: 'cumulativeWindow', attributeType: 'uint' },
    { attributeName: 'velocityCap', attributeType: 'uint' },
    { attributeName: 'velocityWindow', attributeType: 'uint' },
    { attributeName: 'assetScope', attributeType: 'string' },
    { attributeName: 'approvalPolicy', attributeType: 'string' },
    { attributeName: 'RECIPIENT_LIST', attributeType: 'string' },
  ],
}

/** Every test drives preflight through a stubbed template read — no chain, no network. */
function depsReturning(result: unknown) {
  return { readTemplate: async () => result as never }
}

const validDraft = {
  policyKey: 'spend-limits',
  templateId: 'a'.repeat(64),
  attributes: [{ attributeName: 'x402', attributeType: 'uint', value: '1000000' }],
  validFromBlock: '0',
  validToBlock: '0',
}

/** Shorthand: a draft carrying exactly these attributes, everything else valid. */
function draftWith(...attributes: { attributeName: string; attributeType: string; value: string }[]) {
  return { ...validDraft, attributes }
}

const ok = () => depsReturning({ found: true, value: TEMPLATE })

describe('policyPreflight', () => {
  it('passes a well-formed draft and still reports what it could not check', async () => {
    const result = await policyPreflight(ok(), validDraft)
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.notChecked.join(' ')).toMatch(/enforced/i)
  })

  it('names an unknown attribute AND lists the valid vocabulary', async () => {
    // The x4O2 typo (letter O) — deploys cleanly on chain and then enforces nothing.
    const result = await policyPreflight(ok(), draftWith({ attributeName: 'x4O2', attributeType: 'uint', value: '1' }))
    expect(result.ready).toBe(false)
    const blocker = result.blockers.find((b) => b.includes('x4O2'))
    expect(blocker).toBeDefined()
    expect(blocker).toContain('x402')
    expect(blocker).toContain('maxTransactionCount')
  })

  it('never reports ready when the template read failed', async () => {
    const result = await policyPreflight(
      depsReturning({ error: 'query_failed', detail: 'socket hang up' }),
      validDraft,
    )
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toContain('socket hang up')
  })

  it('distinguishes a missing template from a failed lookup', async () => {
    const missing = await policyPreflight(depsReturning({ found: false }), validDraft)
    expect(missing.blockers.join(' ')).toMatch(/no template|not found/i)
    expect(missing.blockers.join(' ')).not.toContain('query_failed')
  })

  it('blocks an empty attributes array, which the chain would accept', async () => {
    const result = await policyPreflight(ok(), { ...validDraft, attributes: [] })
    expect(result.blockers.join(' ')).toMatch(/restricts nothing|no attributes/i)
  })

  it('blocks a non-numeric or inverted block range', async () => {
    const bad = await policyPreflight(ok(), { ...validDraft, validFromBlock: 'soon' })
    expect(bad.blockers.join(' ')).toContain('validFromBlock')

    const inverted = await policyPreflight(ok(), {
      ...validDraft,
      validFromBlock: '900',
      validToBlock: '100',
    })
    expect(inverted.blockers.join(' ')).toMatch(/after|before/i)
  })

  it('treats validToBlock "0" as open-ended, so it is exempt from the ordering check', async () => {
    // "0" means no end, so from > to is not an inversion here (APP-L04). Untested before.
    const openEnded = await policyPreflight(ok(), { ...validDraft, validFromBlock: '900', validToBlock: '0' })
    expect(openEnded.blockers.join(' ')).not.toMatch(/after|before/i)
    expect(openEnded.ready).toBe(true)

    // A real end block still inverts.
    const inverted = await policyPreflight(ok(), { ...validDraft, validFromBlock: '900', validToBlock: '100' })
    expect(inverted.blockers.join(' ')).toMatch(/after|before/i)
  })
  it('blocks a value that contradicts its declared type', async () => {
    const result = await policyPreflight(ok(), draftWith({ attributeName: 'x402', attributeType: 'uint', value: 'lots' }))
    expect(result.blockers.join(' ')).toContain('x402')
  })

  it('reports every blocker at once, not one at a time', async () => {
    const result = await policyPreflight(ok(), {
      ...validDraft,
      attributes: [{ attributeName: 'nope', attributeType: 'uint', value: 'x' }],
      validFromBlock: 'soon',
    })
    expect(result.blockers.length).toBeGreaterThanOrEqual(2)
  })

  // --- AC #3: what a policy can silently NOT mean -------------------------------------------
  // Every draft below passes every blocker above. That is the whole point.

  it('is never silent on a clean result — a green tick must still say what the policy means', async () => {
    const result = await policyPreflight(ok(), validDraft)
    expect(result.ready).toBe(true)
    expect(result.interpretation.length).toBeGreaterThan(0)
    expect(result.interpretation.join(' ')).toContain('x402')
  })

  it('says a cumulativeMax with no window means LIFETIME, and does not block it', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith({ attributeName: 'cumulativeMax', attributeType: 'uint', value: '500' }),
    )
    // Valid and enforced — just not what "RM500 a month" meant.
    expect(result.ready).toBe(true)
    const line = result.interpretation.find((i) => i.includes('cumulativeMax'))
    expect(line).toMatch(/lifetime/i)
    expect(line).toContain('cumulativeWindow')
  })

  it('BLOCKS a velocityCap with no window — the opposite rule, deliberately', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith({ attributeName: 'velocityCap', attributeType: 'uint', value: '5' }),
    )
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toContain('VALUE_INVALID')
  })

  it('says a maxTransactionCount with no window was NOT ASKED FOR, not "lifetime count"', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith({ attributeName: 'maxTransactionCount', attributeType: 'uint', value: '10' }),
    )
    expect(result.ready).toBe(true)
    const line = result.interpretation.find((i) => i.includes('maxTransactionCount'))
    expect(line).toMatch(/not asked for/i)
    // The trap this line exists to prevent.
    expect(line).not.toMatch(/lifetime count/i)
  })

  it('gives the three window rules three DIFFERENT outcomes', async () => {
    // A refactor that collapses them into one "missing window" rule fails here.
    const cumulative = await policyPreflight(ok(), draftWith({ attributeName: 'cumulativeMax', attributeType: 'uint', value: '500' }))
    const velocity = await policyPreflight(ok(), draftWith({ attributeName: 'velocityCap', attributeType: 'uint', value: '5' }))
    const count = await policyPreflight(ok(), draftWith({ attributeName: 'maxTransactionCount', attributeType: 'uint', value: '10' }))
    expect([cumulative.ready, velocity.ready, count.ready]).toEqual([true, false, true])
    expect(cumulative.interpretation.join(' ')).not.toEqual(count.interpretation.join(' '))
  })

  it('does not warn when the cap IS paired with its window', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith(
        { attributeName: 'cumulativeMax', attributeType: 'uint', value: '500' },
        { attributeName: 'cumulativeWindow', attributeType: 'uint', value: '43200' },
      ),
    )
    expect(result.ready).toBe(true)
    const line = result.interpretation.find((i) => i.includes('cumulativeMax'))
    // It may still mention lifetime — to say the cap is NOT one. What must be absent is the
    // warning itself, the wording a user would act on.
    expect(line).not.toMatch(/silently means/i)
    expect(line).toContain('cumulativeWindow')
    expect(line).toMatch(/each|per/i)
  })

  it('blocks an empty _LIST, saying it denies EVERYTHING rather than merely that it is empty', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith({ attributeName: 'RECIPIENT_LIST', attributeType: 'string', value: '[]' }),
    )
    expect(result.ready).toBe(false)
    const blocker = result.blockers.find((b) => b.includes('RECIPIENT_LIST'))
    expect(blocker).toMatch(/everything/i)
    expect(blocker).not.toMatch(/^.*is empty\.?$/i)
  })

  it('accepts a populated _LIST', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith({ attributeName: 'RECIPIENT_LIST', attributeType: 'string', value: '["ZTX3abc"]' }),
    )
    expect(result.ready).toBe(true)
  })

  it('blocks a policy of only qualifiers — NO_ENFORCEABLE_CONSTRAINTS is a fail-closed DENY', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith(
        { attributeName: 'assetScope', attributeType: 'string', value: 'JMYR' },
        { attributeName: 'cumulativeWindow', attributeType: 'uint', value: '43200' },
      ),
    )
    expect(result.ready).toBe(false)
    expect(result.blockers.join(' ')).toContain('NO_ENFORCEABLE_CONSTRAINTS')
  })

  it('describes approvalPolicy as informational and never as a control, without blocking it', async () => {
    const result = await policyPreflight(
      ok(),
      draftWith(
        { attributeName: 'x402', attributeType: 'uint', value: '1000000' },
        { attributeName: 'approvalPolicy', attributeType: 'string', value: 'manual' },
      ),
    )
    // Writing one is legitimate — believing it restricts anything is not.
    expect(result.ready).toBe(true)
    const line = result.interpretation.find((i) => i.includes('approvalPolicy'))
    expect(line).toMatch(/informational|not enforced|restricts nothing/i)
  })

  it('never claims what a rule MEANS when the template could not be read', async () => {
    // Caught live against testnet: with the template absent, preflight still reported
    // '"x4O2" is limited to 1' — a confident meaning claim about the very typo that enforces
    // nothing. Unverified is not the same as understood, and this layer exists to stop exactly
    // that kind of false assurance.
    for (const template of [{ found: false }, { error: 'query_failed', detail: 'socket hang up' }]) {
      const result = await policyPreflight(
        depsReturning(template),
        draftWith({ attributeName: 'x4O2', attributeType: 'uint', value: '1' }),
      )
      expect(result.ready).toBe(false)
      expect(result.interpretation.join(' ')).not.toMatch(/is limited to/i)
      // It should say WHY it cannot say, rather than going silent.
      expect(result.interpretation.join(' ')).toMatch(/could not be read|cannot be confirmed/i)
    }
  })

  it('still applies the window rules without a template, since they do not come from one', async () => {
    // The pairing rules are hardcoded from Windows.java, not read from the template, so a failed
    // template read does not make them unknowable.
    const result = await policyPreflight(
      depsReturning({ found: false }),
      draftWith({ attributeName: 'velocityCap', attributeType: 'uint', value: '5' }),
    )
    expect(result.blockers.join(' ')).toContain('VALUE_INVALID')
  })
  // --- APP-M05: malformed input must produce blockers, never an exception ---------------

  it('returns blockers for a malformed draft instead of throwing', async () => {
    // The MCP SDK does NOT enforce inputSchema at runtime, so an agent can reach this with
    // anything at all. A raw TypeError escaping the tool is not a usable answer.
    for (const bad of [{}, { policyKey: 'k' }, { policyKey: 'k', attributes: 'nope' }]) {
      const result = await policyPreflight(ok(), bad as never)
      expect(result.ready).toBe(false)
      expect(result.blockers.join(' ')).toMatch(/attributes/i)
      // Still a well-formed result, so the caller can read it like any other.
      expect(Array.isArray(result.notChecked)).toBe(true)
      expect(Array.isArray(result.interpretation)).toBe(true)
    }
  })

  it('names a missing policyKey rather than reporting it as undefined', async () => {
    const result = await policyPreflight(ok(), { attributes: [] } as never)
    expect(result.blockers.join(' ')).toMatch(/policyKey/i)
  })

  it('never throws on a malformed attribute entry', async () => {
    const result = await policyPreflight(ok(), { ...validDraft, attributes: [null, 42] } as never)
    expect(result.ready).toBe(false)
    expect(result.blockers.length).toBeGreaterThan(0)
  })

  // --- APP-M01: the mainnet notChecked item -------------------------------------------

  it('states on mainnet that none of this is deployed', async () => {
    const result = await policyPreflight({ ...ok(), network: 'zetrix:mainnet' }, validDraft)
    expect(result.notChecked.join(' ')).toMatch(/mainnet|not deployed/i)
  })

  it('does not claim mainnet trouble when running on testnet', async () => {
    const result = await policyPreflight({ ...ok(), network: 'zetrix:testnet' }, validDraft)
    expect(result.notChecked.join(' ')).not.toMatch(/mainnet/i)
  })

  // --- APP-L02: the unverified note must lead, not trail ------------------------------

  it('puts the "nothing here is verified" note FIRST, since it governs what follows', async () => {
    const result = await policyPreflight(
      depsReturning({ found: false }),
      draftWith({ attributeName: 'cumulativeMax', attributeType: 'uint', value: '500' }),
    )
    expect(result.interpretation.length).toBeGreaterThan(1)
    expect(result.interpretation[0]).toMatch(/could not be read|cannot be confirmed/i)
  })
  it('states on every result that no ALLOW verdict was computed', async () => {
    // The spend-authorisation work owns the verdict. A clean preflight is not permission to spend.
    for (const draft of [validDraft, draftWith()]) {
      const result = await policyPreflight(ok(), draft)
      expect(result.notChecked.join(' ')).toMatch(/ALLOW/)
    }
  })
})
