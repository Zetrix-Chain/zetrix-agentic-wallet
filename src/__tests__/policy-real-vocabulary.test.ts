/**
 * The checks that would have caught that, run against the REAL templates.
 *
 * Everything here uses `fixtures/real-policy-templates.ts`, copied from chain. The five defects this
 * pins all shipped through a thorough, self-consistent suite that validated against an invented
 * vocabulary — `uint`, `bool`, `RECIPIENT_LIST`, a flat `getPolicy` body — none of which can exist
 * on chain. So the point of this file is not extra assertions; it is that the inputs are real.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import {
  echoSafe,
  finalize,
  MAX_DECLARED,
  MAX_DECLARED_NAME,
  MAX_KEY,
  MAX_LINES,
  MAX_MESSAGE,
  policyPreflight,
  unavailableResult,
} from '../orchestrator/policy-preflight'
import { declaredVocabulary, getPolicyByKey, getTemplateViaRegistry } from '../clients/policy-read-client'
import { isListType, ATTRIBUTE_TYPES } from '../policy-window-rules'
import { NATIVE_V1, ZTP20_V1, VALID_ATTRIBUTE_TYPES, GET_POLICY_ENVELOPE } from './fixtures/real-policy-templates'

const VALID_ADDRESS = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const TYPO_ADDRESS = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'

const deps = (template: unknown) => ({
  readTemplate: async () => ({ found: true, value: template }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (a: string) => keypair.checkAddress(a),
})

/**
 * A cap is denominated in an asset, and the write service refuses one that does not say which. The
 * tests below that assert a cap is READY used to omit this — encoding the false assurance that a
 * real transcript exposed — so they now name a scope explicitly.
 */
const SCOPE = { attributeName: 'assetScope', attributeType: 'STRING', value: 'native' }

const draft = (attributes: Array<{ attributeName: string; attributeType: string; value: string }>) => ({
  policyKey: 'ztp20-v1',
  templateId: 'a'.repeat(64),
  attributes,
  validFromBlock: '0',
  validToBlock: '0',
})

describe('our type list matches the contract, and drift is detectable', () => {
  it('covers exactly the types the contract declares — no more, no fewer', () => {
    // If the contract gains a type and we do not, values of that type silently stop being checked.
    expect(Object.values(ATTRIBUTE_TYPES).sort()).toEqual([...VALID_ATTRIBUTE_TYPES].sort())
  })

  it('every type used by the real templates is one we handle', () => {
    const used = new Set([...NATIVE_V1.attributes, ...ZTP20_V1.attributes].map((a) => a.attributeType))
    for (const t of used) expect(Object.values(ATTRIBUTE_TYPES), t).toContain(t)
  })

  it('does NOT recognise the invented types the suite used to assert on', () => {
    // Guards the regression directly: uint/bool were never real, and a fixture using them is how
    // the type check shipped doing nothing.
    for (const invented of ['uint', 'uint256', 'int', 'number', 'bool', 'boolean']) {
      expect(Object.values(ATTRIBUTE_TYPES) as string[], invented).not.toContain(invented)
    }
  })
})

describe('type validation actually fires on a real template', () => {
  it('blocks a NUMBER attribute whose value is not a number', async () => {
    // Previously: ready:true, blockers:[], with a notChecked line saying NUMBER was unknown.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: 'not-a-number' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/cumulativeMax.*NUMBER/i)
  })

  it('accepts a well-formed NUMBER', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      SCOPE,
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
      { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: '12h' },
    ]))
    expect(r.ready).toBe(true)
  })

  it('checksums an ADDRESS attribute rather than accepting any string', async () => {
    const bad = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: TYPO_ADDRESS },
    ]))
    expect(bad.ready).toBe(false)
    expect(bad.blockers.join(' ')).toMatch(/checksum/i)

    // A token address only says WHICH token; with nothing else the policy answers NO_ENFORCEABLE_CONSTRAINTS
    // (a DENY), so the good draft carries a cap as well — the service's vocabulary calls tokenAddress a QUALIFIER.
    const good = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'assetScope', attributeType: 'STRING', value: 'ztp20' },
      { attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: VALID_ADDRESS },
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' },
    ]))
    expect(good.ready).toBe(true)
  })

  it('says so when no address validator is wired, rather than implying acceptance', async () => {
    const r = await policyPreflight(
      { readTemplate: async () => ({ found: true, value: ZTP20_V1 }) as never },
      draft([{ attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: TYPO_ADDRESS }]),
    )
    expect(r.notChecked.join(' ')).toMatch(/no address validator/i)
  })

  it('says it CANNOT check a type the contract does not declare, rather than interpreting it', async () => {
    // APP-L05. Deleting this branch left 1212/1212 green, and the observable damage is the opposite
    // of silence: an off-vocabulary type fell through to the affirmative claim, turning an honest
    // "cannot check" into a confident "is limited to 1.5".
    const exotic = {
      ...ZTP20_V1,
      attributes: [...ZTP20_V1.attributes, { attributeName: 'decimalCap', attributeType: 'DECIMAL' }],
    }
    const r = await policyPreflight(deps(exotic), draft([
      { attributeName: 'decimalCap', attributeType: 'DECIMAL', value: '1.5' },
    ]))
    expect(r.notChecked.join(' ')).toMatch(/not one the contract declares|type list is stale/i)
    // Must NOT claim a meaning for a value it could not validate.
    expect(r.interpretation.join(' ')).not.toMatch(/is limited to/i)
  })

  it('takes the TEMPLATE type as authoritative over whatever the draft claims', async () => {
    // A draft mislabelling a NUMBER as STRING must not thereby pick its own, weaker validation.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'cumulativeMax', attributeType: 'STRING', value: 'still-not-a-number' },
    ]))
    expect(r.ready).toBe(false)
  })
})

describe('list attributes are read with the RIGHT POLARITY, or not interpreted at all', () => {
  // APP-C01: the first cut keyed on the TYPE alone, so a denylist got allowlist prose —
  // a user told that listing an address permits it would list the addresses they wanted to allow,
  // thereby blocking exactly those and permitting everyone else. The type says a value is a list;
  // it says nothing about which way the list points.

  it('an empty ALLOW-list denies everything, and is blocked', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: '[]' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/denies EVERYTHING/i)
  })

  it('an empty DENY-list blocks nobody, and is NOT a blocker', async () => {
    // The opposite meaning, and the opposite outcome. Previously this was reported as the
    // maximally restrictive case while in fact restricting nothing.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientDenylist', attributeType: 'ADDRESS_LIST', value: '[]' },
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500' },
    ]))
    expect(r.blockers.join(' ')).not.toMatch(/denies EVERYTHING/i)
    const line = r.interpretation.find((i) => i.includes('recipientDenylist'))!
    expect(line).toMatch(/blocks nobody|restricts nothing/i)
  })

  it('a populated ALLOW-list permits only what is listed', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` },
    ]))
    expect(r.ready).toBe(true)
    const line = r.interpretation.find((i) => i.includes('recipientAllowlist'))!
    expect(line).toMatch(/permits ONLY/i)
    expect(line).not.toMatch(/BLOCKS the entries/i)
  })

  it('a populated DENY-list blocks what is listed and permits the rest', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientDenylist', attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` },
    ]))
    const line = r.interpretation.find((i) => i.includes('recipientDenylist'))!
    expect(line).toMatch(/BLOCKS the entries/i)
    expect(line).toMatch(/still permitted/i)
    // The regression, stated directly: a denylist must never be described as permitting.
    expect(line).not.toMatch(/permits ONLY/i)
  })

  it('allow and deny lists are never given the same description', async () => {
    // A property, so a future refactor that collapses the two branches fails here even if it
    // rewords them.
    const say = async (name: string) => {
      const r = await policyPreflight(deps(ZTP20_V1), draft([
        { attributeName: name, attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` },
      ]))
      return r.interpretation.find((i) => i.includes(name))!.replace(name, 'X')
    }
    expect(await say('recipientAllowlist')).not.toEqual(await say('recipientDenylist'))
  })

  it('says nothing about a list whose polarity it does not know', async () => {
    // Honest silence beats a confident guess. Claiming a list permits what it blocks is the
    // failure this layer exists to prevent.
    const withUnknown = {
      ...ZTP20_V1,
      attributes: [...ZTP20_V1.attributes, { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST' }],
    }
    const r = await policyPreflight(deps(withUnknown), draft([
      { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` },
    ]))
    expect(r.interpretation.join(' ')).not.toMatch(/permits ONLY|BLOCKS the entries/i)
    expect(r.notChecked.join(' ')).toMatch(/does not know whether listing an entry permits it or blocks it/i)
  })

  it('checksums every entry of an ADDRESS_LIST', async () => {
    // APP-M02: the list branch returned before the address checks, so entries were never
    // validated — while the dep comment claimed they were.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: `["${TYPO_ADDRESS}"]` },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/not a valid Zetrix address/i)
  })

  it('rejects a value that is not a list at all, rather than interpreting it', async () => {
    // APP-L08: "transfer" and "[null]" both passed with a confident meaning claim.
    for (const bad of ['transfer', '{}', 'null']) {
      const r = await policyPreflight(deps(ZTP20_V1), draft([
        { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: bad },
      ]))
      expect(r.ready, bad).toBe(false)
      expect(r.blockers.join(' '), bad).toMatch(/is not a list/i)
    }
  })

  it('never throws on a non-string list value', async () => {
    // APP-M03, a REGRESSION this MR introduced: .trim() on unchecked input.
    for (const bad of [undefined, null, 0, {}, []]) {
      const r = await policyPreflight(deps(ZTP20_V1), draft([
        { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: bad },
      ] as never))
      expect(r.ready, JSON.stringify(bad)).toBe(false)
    }
  })

  it('an empty allowedMethods is blocked — it is an ALLOW-list', async () => {
    // Restored: the round-1 delta deleted this and added no polarity assertion in its place
    // (APP-M01). allowedMethods decides which contract methods an agent may invoke.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: '[]' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/denies EVERYTHING/i)
  })

  it('a populated allowedMethods PERMITS what it names', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: '["transfer"]' },
    ]))
    const line = r.interpretation.find((i) => i.includes('allowedMethods'))!
    expect(line).toMatch(/permits ONLY/i)
    expect(line).not.toMatch(/BLOCKS the entries/i)
  })

  it('validates STRING_LIST entries, not just ADDRESS_LIST', async () => {
    // APP-M03 round 2. `[null]` was one of the two inputs named by hand in round 1, and the test
    // that appeared to close it had quietly dropped that input for three that passed.
    // On chain [null].contains('transfer') is false, so this deploys as a method allow-list
    // permitting NOTHING while preflight reported it permitted the entries listed.
    for (const bad of ['[null]', '[1,2]', '[{}]', '[""]']) {
      const r = await policyPreflight(deps(ZTP20_V1), draft([
        { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: bad },
      ]))
      expect(r.ready, bad).toBe(false)
      expect(r.interpretation.join(' '), bad).not.toMatch(/permits ONLY/i)
    }
  })

  it('accepts well-formed entries of every list type', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: '["transfer","approve"]' },
      { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` },
    ]))
    expect(r.ready).toBe(true)
  })

  it('caps how many bad entries it echoes back', async () => {
    // APP-L10: a caller can supply hundreds and the message is read by a human.
    const many = JSON.stringify(Array.from({ length: 200 }, (_, i) => i))
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: many },
    ]))
    expect(r.ready).toBe(false)
    const blocker = r.blockers.find((b) => b.includes('allowedMethods'))!
    expect(blocker.length).toBeLessThan(400)
    expect(blocker).toMatch(/and \d+ more/)
  })

  it('an empty list of UNKNOWN polarity is still flagged, not silently accepted', async () => {
    // APP-L07 round 2: scoping the blocker to known polarities made an unknown empty list silent.
    // One of the two readings denies everything, so an uncertain answer beats no answer.
    const withUnknown = {
      ...ZTP20_V1,
      attributes: [...ZTP20_V1.attributes, { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST' }],
    }
    const r = await policyPreflight(deps(withUnknown), draft([
      { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST', value: '[]' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/empty list/i)
    // Still refuses to claim a direction it does not know.
    expect(r.interpretation.join(' ')).not.toMatch(/permits ONLY|BLOCKS the entries/i)
  })

  it('validates NUMBER_LIST entries — the third list type, and the one with no real template yet', async () => {
    // APP-M01 round 3. The test titled "EVERY list type" exercised only STRING_LIST, so
    // `return isNumericString(entry)` -> `return true` survived the whole suite. One third of the
    // M03 fix shipped untested — the same shape as round 2's defect, one type over.
    //
    // No template declares a NUMBER_LIST today, but it is in the contract's own
    // VALID_ATTRIBUTE_TYPES, so the branch exists and must mean something.
    const withNumbers = {
      ...ZTP20_V1,
      attributes: [...ZTP20_V1.attributes, { attributeName: 'allowedAmounts', attributeType: 'NUMBER_LIST' }],
    }
    for (const bad of ['["not-a-number"]', '[{"a":1}]', '[null]', '[1,2]', '["1.5"]', '["-1"]']) {
      const r = await policyPreflight(deps(withNumbers), draft([
        { attributeName: 'allowedAmounts', attributeType: 'NUMBER_LIST', value: bad },
      ]))
      expect(r.ready, bad).toBe(false)
      expect(r.interpretation.join(' '), bad).not.toMatch(/permits ONLY|BLOCKS the entries/i)
    }

    // The chain stores numbers as strings, so a well-formed one is a digit string.
    const ok = await policyPreflight(deps(withNumbers), draft([
      { attributeName: 'allowedAmounts', attributeType: 'NUMBER_LIST', value: '["1000","2000"]' },
    ]))
    expect(ok.blockers.join(' ')).not.toMatch(/allowedAmounts/)
  })

  it('rejects a whitespace-only entry, as it does an empty one', async () => {
    // APP-L05: [" "].contains('transfer') is false for exactly the reason [null] is.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: '[" "]' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.interpretation.join(' ')).not.toMatch(/permits ONLY/i)
  })

  it('caps the SIZE of each echoed entry, not just how many', async () => {
    // APP-L02: the count cap left the size axis open — three ~2KB object entries produced 6,119
    // characters. The earlier test passed only because its entries were short integers.
    const huge = JSON.stringify([{ a: 'x'.repeat(2000) }, { b: 'y'.repeat(2000) }, { c: 'z'.repeat(2000) }])
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: huge },
    ]))
    expect(r.ready).toBe(false)
    const blocker = r.blockers.find((b) => b.includes('allowedMethods'))!
    expect(blocker.length).toBeLessThan(400)
  })

  it('says when no address validator is wired, rather than implying the entries were checked', async () => {
    // APP-L04: gutting this disclosure survived the suite. It is the difference between "checked
    // and fine" and "not checked at all", on addresses.
    const r = await policyPreflight(
      { readTemplate: async () => ({ found: true, value: ZTP20_V1 }) as never },
      draft([{ attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: `["${VALID_ADDRESS}"]` }]),
    )
    expect(r.notChecked.join(' ')).toMatch(/entries are valid Zetrix addresses/i)
  })

  it('does not render an empty attribute list as a bare full stop', async () => {
    // APP-L06: "Declared attributes are: ."
    const r = await policyPreflight(deps({ found: true, attributes: [] }), draft([
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' },
    ]))
    expect(r.blockers.join(' ')).not.toMatch(/attributes are: \./)
    expect(r.blockers.join(' ')).toMatch(/declares no attributes at all/i)
  })
  it('states the unknown-polarity sentence so it CANNOT be read as an inversion', async () => {
    // APP-L01 round 4. The wording fix was unpinned: reverting to "If it is an allow-list that
    // denies EVERYTHING, and if it is a deny-list it restricts nothing" survived, because the only
    // assertion matched /denies EVERYTHING/ and both wordings contain it. That original parses as
    // ONE conditional whose consequent is "restricts nothing" — the inversion this file exists to
    // prevent, in text a model reads.
    const withUnknown = {
      ...ZTP20_V1,
      attributes: [...ZTP20_V1.attributes, { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST' }],
    }
    const r = await policyPreflight(deps(withUnknown), draft([
      { attributeName: 'mysteryList', attributeType: 'ADDRESS_LIST', value: '[]' },
    ]))
    const blocker = r.blockers.find((b) => b.includes('mysteryList'))!

    // Each branch must carry its OWN verb, so neither can be read as the other's consequent.
    expect(blocker).toMatch(/allow-list it denies EVERYTHING/i)
    expect(blocker).toMatch(/deny-list it restricts nothing/i)
    // The exact shape that made it ambiguous.
    expect(blocker).not.toMatch(/allow-list that denies/i)
  })

  /**
   * ONE assertion over ALL THREE result arrays, for every case below.
   *
   * Round 4 capped the four paths its four new cases exercised and titled the test "caps every echo
   * of caller-supplied text"; round 5 measured fourteen more that were not capped, two of which
   * need no error condition at all. The title was true of the four and false of the module, which
   * is the over-claiming class in its own right. So: the helper asserts over blockers,
   * interpretation AND notChecked together, and every case goes through it.
   */
  const allLines = (r: { blockers: string[]; interpretation: string[]; notChecked: string[] }) => [
    ...r.blockers,
    ...r.interpretation,
    ...r.notChecked,
  ]
  const longestString = (r: { blockers: string[]; interpretation: string[]; notChecked: string[] }) =>
    Math.max(0, ...allLines(r).map((line) => line.length))

  /**
   * Lines that hit `finalize`'s backstop — recognisable because the backstop is the only thing that
   * can leave a trailing ellipsis on a WHOLE message. Every site-level echo is mid-sentence, so a
   * correctly capped message always ends in its own punctuation.
   *
   * This is the assertion the size bound cannot make. Mutating any single `echoSafe` call away
   * SURVIVES a size-only suite, because the backstop absorbs it — measured on three sites before
   * this was added. What is lost is the rest of the sentence: the explanation, the instruction, the
   * suggested fix, all of which live AFTER the echoed value. So the real invariant is not "no line
   * is long", it is "no line was cut off", and that is what pins the sites.
   */
  const truncated = (r: { blockers: string[]; interpretation: string[]; notChecked: string[] }) =>
    allLines(r).filter((line) => line.endsWith('…'))

  it('caps every echo on a result that has NO blockers at all', async () => {
    // APP-M01 round 5, and the case that proves this is not an error-path concern. The largest amount the wallet
    // accepts (77 digits — a 256-bit number is never longer) against the real ztp20-v1 is well-formed: ready:true,
    // zero blockers, and an interpretation line that must still be capped. (A 50,000-digit amount is now refused
    // outright — see policy-amount-unit.test.ts — so it can no longer be the input here.)
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      SCOPE,
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '9'.repeat(77) },
    ]))
    expect(r.ready).toBe(true)
    expect(r.blockers).toEqual([])
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(truncated(r)).toEqual([])
  })

  it('caps the block-range echoes, which no template failure is needed to reach', async () => {
    // APP-M01 round 5. mcp-tools passes the raw MCP input straight through and validFromBlock is
    // echoed verbatim, so these two sites are reachable with a perfectly good template and no
    // attribute problem whatsoever.
    const huge = 'x'.repeat(50_000)
    const r = await policyPreflight(deps(ZTP20_V1), {
      ...draft([{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }]),
      validFromBlock: huge,
      validToBlock: huge,
    })
    expect(r.ready).toBe(false)
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(truncated(r)).toEqual([])
  })

  it('caps every echo across blockers, interpretation AND notChecked', async () => {
    const huge = 'x'.repeat(50_000)
    const cases: Array<[string, { attributeName: string; attributeType: string; value: string }]> = [
      ['undeclared name', { attributeName: huge, attributeType: 'NUMBER', value: '1' }],
      ['not a list', { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: huge }],
      ['bad NUMBER', { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: huge }],
      ['bad ADDRESS', { attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: huge }],
      // A huge STRING_LIST entry that is genuinely BAD. [huge] alone is a valid entry — a 50,000-
      // character method name is well-formed, so that draft is honestly ready:true and the label
      // 'bad list entries' was wrong about its own input. An object entry is the bad one, and it
      // is the path that echoes the entry back.
      ['bad list entries', { attributeName: 'allowedMethods', attributeType: 'STRING_LIST', value: JSON.stringify([{ a: huge }]) }],
    ]
    for (const [label, attribute] of cases) {
      const r = await policyPreflight(deps(ZTP20_V1), draft([attribute]))
      // Restored: the reworked loop dropped round 5's verdict assertion, so these cases stopped
      // checking that a bad value is still refused and only checked that it is short (APP-L02).
      expect(r.ready, label).toBe(false)
      expect(longestString(r), label).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(truncated(r), label).toEqual([])
    }
  })

  it('caps every echo for EVERY attribute the real template declares', async () => {
    // Derived, not hand-listed. Round 5's four cases were chosen by hand and the sites they missed
    // were the ones nobody thought to list, so the input set comes from the template itself: every
    // declared attribute, given a 50,000-character value, with and without a wired validator.
    const huge = 'x'.repeat(50_000)
    for (const a of ZTP20_V1.attributes) {
      for (const [label, d] of [['wired', deps(ZTP20_V1)], ['unwired', { readTemplate: async () => ({ found: true, value: ZTP20_V1 }) as never }]] as const) {
        const r = await policyPreflight(d, draft([
          { attributeName: a.attributeName, attributeType: a.attributeType, value: huge },
        ]))
        expect(longestString(r), `${a.attributeName} (${label})`).toBeLessThanOrEqual(MAX_MESSAGE)
        // The sentence has to survive too — see `truncated`. This is what pins the per-site caps;
        // the size bound alone cannot, because the backstop absorbs a missing one.
        expect(truncated(r), `${a.attributeName} (${label}) was cut off`).toEqual([])
      }
    }
  })

  it('omits declared entirely when the template did not resolve', async () => {
    // APP-L02 round 7. `declared ?? []` survived: an empty array and an absent field read the same
    // to a length check but not to a caller, for whom "this template declares nothing" and "we
    // could not read the template" are the two answers this whole module exists to keep apart.
    const unread = await policyPreflight(
      { readTemplate: async () => ({ error: 'query_failed', detail: 'unreachable' }) as never },
      draft([{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }]),
    )
    expect(unread.declared).toBeUndefined()
    expect('declared' in unread).toBe(false)

    // And present when it did resolve, so this is a real distinction rather than a dropped field.
    const read = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' },
    ]))
    expect(read.declared).toContain('cumulativeMax')
  })

  it('caps the echoes on the path where NO template resolved', async () => {
    // The branches that interpret a list WITHOUT the template are the ones a long name can
    // actually reach: with a template, a 50,000-character name is undeclared and returns at the
    // first blocker, and the allow/deny branches below need listPolarity to be defined, which only
    // four short vocabulary names are. Unknown polarity is different — it fires precisely BECAUSE
    // the name is unrecognised, so that is where an uncapped name gets through.
    const huge = 'x'.repeat(50_000)
    const r = await policyPreflight(
      { readTemplate: async () => ({ error: 'query_failed', detail: 'unreachable' }) as never, network: 'zetrix:testnet' },
      draft([{ attributeName: huge, attributeType: 'ADDRESS_LIST', value: '[]' }]),
    )
    expect(r.ready).toBe(false)
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(truncated(r)).toEqual([])
  })
  it('does not throw on a value nested past the call stack', async () => {
    // APP-L07 round 5, and it is the same line as the worst M01 case. A bare template literal on a
    // deeply nested array calls Array.prototype.toString, which recurses — so `"x" is limited to
    // ${value}` threw RangeError out of policyPreflight, contradicting this module's own rule that
    // "a raw TypeError escaping the tool is not an answer anyone can act on".
    let nested: unknown = []
    for (let i = 0; i < 20_000; i++) nested = [nested]
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: nested as string },
    ]))
    expect(r.ready).toBe(false)
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)

    // A cyclic value throws TypeError from the same call, for a different reason.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const c = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: cyclic as unknown as string },
    ]))
    expect(c.ready).toBe(false)
  })

  it('never cuts a surrogate pair in half', async () => {
    // APP-L04 round 5. slice(0, max) landing between the two halves of an emoji leaves a bare
    // \ud83d, which is not a character anything downstream can render or re-encode — in the one
    // function whose job is making untrusted text safe to pass on.
    for (let pad = 0; pad < 4; pad++) {
      const value = 'a'.repeat(pad) + '🙂'.repeat(200)
      const out = echoSafe(value)
      for (const ch of out) {
        const code = ch.codePointAt(0)!
        expect(code < 0xd800 || code > 0xdfff, `pad ${pad}: lone surrogate in "${out.slice(-6)}"`).toBe(true)
      }
    }
  })

  it('leaves a legitimate message untouched — the cap is headroom, not a squeeze', async () => {
    // A bound nothing legitimate approaches is a bound that hides truncation. This fails if
    // MAX_MESSAGE is shrunk toward the messages this module actually builds.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'recipientAllowlist', attributeType: 'ADDRESS_LIST', value: '[]' },
    ]))
    const longest = longestString(r)
    expect(longest).toBeGreaterThan(150)
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })

  it('caps a message built by a caller, not only by this module', () => {
    // finalize is the backstop, and this is what pins it. Site-level echoSafe covers every
    // interpolation in this file TODAY, so end-to-end the two are redundant — deliberately, that
    // is what a backstop is. `unavailableResult` is the path where the redundancy ends: its
    // `reason` comes from the caller and no site-level cap has ever touched it.
    const r = unavailableResult('k', 'x'.repeat(50_000), 'zetrix:mainnet')
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)

    // All THREE legs, not one. The previous version built a 50,000-character interpretation and
    // notChecked and then asserted on .blockers[0] alone, so dropping capMessage from either of
    // the other two survived the whole suite — two thirds of the guarantee unpinned by a test that
    // had already constructed the inputs that kill it (APP-M02).
    const capped = finalize({
      policyKey: 'k',
      ready: false,
      blockers: ['y'.repeat(50_000)],
      interpretation: ['z'.repeat(50_000)],
      notChecked: ['w'.repeat(50_000)],
    })
    expect(capped.blockers[0].length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(capped.interpretation[0].length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(capped.notChecked[0].length).toBeLessThanOrEqual(MAX_MESSAGE)
  })

  it('bounds policyKey and declared too — the exit covers the OBJECT, not three of its fields', async () => {
    // APP-M01 round 6. policyKey is raw MCP input and declared is chain data; both rode through
    // finalize's spread untouched, so a 50,000-character policyKey produced a ~50KB tool-output
    // block on a ready:true result with no error path anywhere — round 5's finding one field over.
    const huge = 'x'.repeat(50_000)
    const r = await policyPreflight(deps(ZTP20_V1), {
      ...draft([{ attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '5' }]),
      policyKey: huge,
    })
    // REFUSED, not silently shortened. Round 6 capped the echo and left the draft ready:true, so an
    // agent reusing the returned key would have written under a DIFFERENT key (APP-L01).
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/policyKey is 50000 characters long/)
    expect(r.policyKey.length).toBeLessThanOrEqual(MAX_KEY)

    // The whole serialised object, which is what actually reaches the agent.
    expect(JSON.stringify(r).length).toBeLessThan(20_000)

    const wide = { ...ZTP20_V1, attributes: Array.from({ length: 500 }, (_, i) => ({ attributeName: `${huge}${i}`, attributeType: 'STRING' })) }
    const w = await policyPreflight(deps(wide), draft([
      { attributeName: 'nope', attributeType: 'STRING', value: '1' },
    ]))
    for (const name of w.declared ?? []) expect(name.length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(JSON.stringify(w).length).toBeLessThan(20_000)
  })

  it('bounds how MANY lines a result carries, not only how long each one is', async () => {
    // APP-L04 round 6. capMessage bounds per string and says nothing about the count, which is
    // caller-controlled: 5,000 single-character attributes measured 314KB in -> 1.68MB out.
    const attributes = Array.from({ length: 5_000 }, (_, i) => ({
      attributeName: `a${i}`,
      attributeType: 'STRING',
      value: '1',
    }))
    const r = await policyPreflight(deps(ZTP20_V1), draft(attributes))
    expect(r.blockers.length).toBeLessThanOrEqual(MAX_LINES)
    expect(r.interpretation.length).toBeLessThanOrEqual(MAX_LINES)
    expect(r.notChecked.length).toBeLessThanOrEqual(MAX_LINES)
    expect(JSON.stringify(r).length).toBeLessThan(100_000)

    // Fail-closed is not affected: ready is computed from blockers.length BEFORE finalize runs, so
    // dropping lines can never turn a refusal into an acceptance.
    expect(r.ready).toBe(false)
    // And the omission is stated, never silent — a shortened list that looks complete is its own
    // defect.
    expect(r.blockers[r.blockers.length - 1]).toMatch(/and \d+ more, omitted/)
  })

  it('pins the constants ABSOLUTELY, not against themselves', async () => {
    // APP-M03 round 6. Every size assertion compared against the same constant the code uses, so
    // it could not fail at any value: MAX_MESSAGE = 100000 passed 1245/1245 and silently restored
    // the exact flood the round before had fixed. Shrinking killed 15 tests; growing was free.
    expect(MAX_MESSAGE).toBeLessThanOrEqual(1000)
    expect(MAX_LINES).toBeLessThanOrEqual(100)

    // And the bound measured in characters, with no reference to the constant at all.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '9'.repeat(50_000) },
    ]))
    expect(longestString(r)).toBeLessThan(1000)
  })

  it('renders the declared list within the message budget, whatever the names look like', async () => {
    // APP-L01 round 6. listNames bounded by COUNT — 20 names of 40 characters is ~1,024, which
    // exceeds MAX_MESSAGE — so two constants added in the same commit contradicted each other and a
    // legitimate 20-name template lost ~40% of its declared list to the backstop, on a page whose
    // docblock said hitting the backstop meant something had gone wrong. It is a character budget
    // now, and this test fails if it goes back to a count (or to a bare join).
    const longNames = Array.from({ length: 20 }, (_, i) => ({
      attributeName: `${'n'.repeat(38)}${i}`,
      attributeType: 'STRING',
    }))
    const r = await policyPreflight(deps({ ...ZTP20_V1, attributes: longNames }), draft([
      { attributeName: 'undeclared', attributeType: 'STRING', value: '1' },
    ]))
    const blocker = r.blockers.find((b) => b.includes('Declared attributes are'))!
    expect(blocker).toBeDefined()
    // The whole point: the message fits WITHOUT the backstop having to cut it.
    expect(blocker.endsWith('…')).toBe(false)
    expect(blocker).toMatch(/and \d+ more/)
  })

  it('spends its whole echo budget — the ellipsis is inside the cap, not added to it', async () => {
    // APP-L03 round 6. echoSafe's docblock states this off-by-one as a property ("the point is an
    // upper bound a test can state exactly") and nothing pinned it: returning max + 1 survived.
    expect(echoSafe('x'.repeat(500), 10)).toHaveLength(10)
    expect(echoSafe('x'.repeat(500), 61)).toHaveLength(61)
    // A value that fits is returned whole, not padded or cut.
    expect(echoSafe('short', 60)).toBe('short')

    // A value of EXACTLY max is returned whole. Length alone cannot see this: flipping `>` to
    // `>=` still yields max characters, it just spends the last one on an ellipsis nobody needed,
    // so the only assertion that can fail is one on the content (APP-L02 round 7).
    expect(echoSafe('x'.repeat(10), 10)).toBe('x'.repeat(10))
    expect(echoSafe('x'.repeat(11), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('bounds the line COUNT of interpretation and notChecked, not only of blockers', async () => {
    // APP-M01 round 7. capLines was applied to all three arrays and asserted on all three, but the
    // only input was 5,000 undeclared attributes, which yields 50 / 0 / 3 lines — so the two count
    // assertions passed whether or not capLines was there. Measured with capLines removed:
    // 5,000 interpretation lines (400,763 chars) and 5,003 notChecked lines (430,804 chars), both
    // on ready:true results. Round 6's finding on the count axis instead of the length axis.
    //
    // Each input below fills ONE array past MAX_LINES, so each assertion can actually fail.

    // interpretation: declared attributes with a window rule, which interpret rather than block.
    const manyDeclared = {
      ...ZTP20_V1,
      attributes: Array.from({ length: 200 }, (_, i) => ({ attributeName: `cap${i}`, attributeType: 'NUMBER' })),
    }
    const i = await policyPreflight(deps(manyDeclared), draft(
      Array.from({ length: 200 }, (_, k) => ({ attributeName: `cap${k}`, attributeType: 'NUMBER', value: '1000' })),
    ))
    expect(i.interpretation.length).toBeGreaterThan(1)
    expect(i.interpretation.length).toBeLessThanOrEqual(MAX_LINES)
    expect(i.interpretation[i.interpretation.length - 1]).toMatch(/and \d+ more, omitted/)

    // notChecked: ADDRESS values with NO validator wired, one disclosure line each.
    const manyAddresses = {
      ...ZTP20_V1,
      attributes: Array.from({ length: 200 }, (_, k) => ({ attributeName: `addr${k}`, attributeType: 'ADDRESS' })),
    }
    const nc = await policyPreflight(
      { readTemplate: async () => ({ found: true, value: manyAddresses }) as never },
      draft(Array.from({ length: 200 }, (_, k) => ({ attributeName: `addr${k}`, attributeType: 'ADDRESS', value: VALID_ADDRESS }))),
    )
    expect(nc.notChecked.length).toBeLessThanOrEqual(MAX_LINES)
    expect(nc.notChecked[nc.notChecked.length - 1]).toMatch(/and \d+ more, omitted/)
  })

  it('omits declared names rather than altering them, and says how many', async () => {
    // APP-L01 round 7. declared is structured identifier data: a truncated name still LOOKS like a
    // name, so a caller cannot tell it was changed. Kept whole or dropped, and the drop is stated.
    const longName = 'z'.repeat(MAX_DECLARED_NAME + 1)
    const wide = {
      ...ZTP20_V1,
      attributes: [
        { attributeName: longName, attributeType: 'STRING' },
        ...Array.from({ length: 200 }, (_, k) => ({ attributeName: `n${k}`, attributeType: 'STRING' })),
      ],
    }
    const r = await policyPreflight(deps(wide), draft([
      { attributeName: 'undeclared', attributeType: 'STRING', value: '1' },
    ]))
    expect(r.declared!.length).toBeLessThanOrEqual(MAX_DECLARED)
    // Every name that IS returned is a real one, byte for byte — none truncated, none ellipsised.
    for (const name of r.declared!) {
      expect(wide.attributes.map((a) => a.attributeName)).toContain(name)
      expect(name.endsWith('…')).toBe(false)
    }
    expect(r.declared).not.toContain(longName)
    // And the omission is stated, because a shortened list that looks complete is its own defect.
    expect(r.notChecked.join(' ')).toMatch(/declared attribute names are not listed above/)
  })

  it('keeps draft-level blockers when the attribute blockers overflow', async () => {
    // APP-L04 round 7. Draft-level blockers were appended LAST, so capLines dropped exactly them:
    // 100 undeclared attributes plus an inverted block range lost the "would never be in force"
    // blocker — the one that matters most — while the blockers docblock and the README both promise
    // every problem at once.
    const r = await policyPreflight(deps(ZTP20_V1), {
      ...draft(Array.from({ length: 100 }, (_, k) => ({ attributeName: `nope${k}`, attributeType: 'STRING', value: '1' }))),
      validFromBlock: '900',
      validToBlock: '100',
    })
    expect(r.blockers.length).toBeLessThanOrEqual(MAX_LINES)
    expect(r.blockers.join(' ')).toMatch(/would never be in force/)
  })

  it('pins the new caps absolutely too, not against each other', async () => {
    // APP-L02 round 7. MAX_KEY 120 -> 600, MAX_DECLARED 64 -> 300 and the per-name cap 40 -> 200
    // all survived, because every assertion compared against MAX_MESSAGE rather than a bound of
    // their own. Same shape as round 6's M03, one constant set over.
    expect(MAX_KEY).toBeLessThanOrEqual(200)
    expect(MAX_DECLARED).toBeLessThanOrEqual(100)
    expect(MAX_DECLARED_NAME).toBeLessThanOrEqual(60)
  })

  it('caps at exactly the boundary, and counts the omission exactly', async () => {
    // APP-L02 round 7. `<=` -> `<` at exactly MAX_LINES survived, and so did an off-by-one in the
    // "and N more" count. Both are boundary claims, so they need boundary inputs.
    const at = await policyPreflight(deps(ZTP20_V1), draft(
      Array.from({ length: MAX_LINES }, (_, k) => ({ attributeName: `nope${k}`, attributeType: 'STRING', value: '1' })),
    ))
    // Exactly MAX_LINES blockers fit with nothing omitted — one more and the notice appears.
    expect(at.blockers.length).toBe(MAX_LINES)
    expect(at.blockers.join(' ')).not.toMatch(/omitted to keep/)

    const over = await policyPreflight(deps(ZTP20_V1), draft(
      Array.from({ length: MAX_LINES + 10 }, (_, k) => ({ attributeName: `nope${k}`, attributeType: 'STRING', value: '1' })),
    ))
    expect(over.blockers.length).toBe(MAX_LINES)
    // MAX_LINES + 10 produced, MAX_LINES - 1 shown, so exactly 11 are omitted. An off-by-one here
    // is a wrong number in a message whose only job is to be that number.
    expect(over.blockers[over.blockers.length - 1]).toContain(`and ${MAX_LINES + 10 - (MAX_LINES - 1)} more`)
  })

  it('states the declared list in full when it fits, and counts the rest exactly', async () => {
    // APP-L02 round 7: listNames' own "and N more" was off by one without failing anything.
    // Names long enough that the 300-character budget shows some and defers the rest.
    const names = Array.from({ length: 40 }, (_, k) => ({ attributeName: `nm${k}_${'x'.repeat(14)}`, attributeType: 'STRING' }))
    const r = await policyPreflight(deps({ ...ZTP20_V1, attributes: names }), draft([
      { attributeName: 'undeclared', attributeType: 'STRING', value: '1' },
    ]))
    const blocker = r.blockers.find((b) => b.includes('Declared attributes are'))!
    const shown = (blocker.match(/nm\d+/g) ?? []).length
    const claimed = Number(/and (\d+) more/.exec(blocker)![1])
    expect(shown + claimed).toBe(names.length)
  })

  it('caps a window qualifier on a result that is refused for an unrelated reason', async () => {
    // APP-L03 round 7. This case used to sit in the loop above asserting ready:false — which was
    // true, but for NO_ENFORCEABLE_CONSTRAINTS (a lone qualifier enforces nothing), not for the
    // huge value, which is accepted and interpreted. It would have been false for '86400' too, so
    // the assertion said nothing about the input it was named for. The size claim is the real one.
    const huge = 'x'.repeat(50_000)
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      SCOPE,
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '1000' },
      { attributeName: 'cumulativeWindow', attributeType: 'STRING', value: huge },
    ]))
    // A 50,000-character window is not a duration, so the service refuses it and preflight now says so.
    // The point of this test is unchanged: however large the value, what is echoed back is bounded.
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/cumulativeWindow.*refuses/)
    expect(longestString(r)).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(truncated(r)).toEqual([])
  })

  it('still names enough of a bad value to recognise it', async () => {
    // A cap that truncates to nothing is its own failure — the user has to see which value is meant.
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: 'not-a-number-at-all' },
    ]))
    expect(r.blockers.join(' ')).toContain('not-a-number-at-all')
  })
  it('keys on the type, so a list-looking NAME is not treated as a list', () => {
    expect(isListType('ADDRESS_LIST')).toBe(true)
    expect(isListType('recipientAllowlist')).toBe(false)
  })
})

describe('the real response shapes', () => {
  const rets = (value: string) => ({ errorCode: 0, result: { query_rets: [{ result: { value } }] } })

  it('templateAttributeIds survives as a NAME -> ID map', async () => {
    const query = vi.fn().mockResolvedValue(rets(JSON.stringify(ZTP20_V1)))
    const read = await getTemplateViaRegistry('ZTX3Pub', 'ztp20-v1', 'ZTX3Reg', query)
    const ids = (read as { value: { templateAttributeIds?: Record<string, string> } }).value.templateAttributeIds!
    expect(Array.isArray(ids)).toBe(false)
    expect(ids.cumulativeMax).toBe('2c9559df1ccb76c340bbe8bb6ebe17ddbe745c3664616e9709d835bc5634a8f4')
    // Every declared attribute has an id — the write path needs the pairing, not just the values.
    for (const a of ZTP20_V1.attributes) expect(ids[a.attributeName], a.attributeName).toBeTruthy()
  })

  it('getPolicy is unwrapped, so callers read attributes rather than an envelope', async () => {
    const query = vi.fn().mockResolvedValue(rets(JSON.stringify(GET_POLICY_ENVELOPE)))
    const read = await getPolicyByKey('ZTX3Policy', 'ztp20-v1', query)
    expect(read).toMatchObject({ found: true })
    const v = (read as { value: { policy: { attributes?: unknown[]; validFromBlock?: unknown }; policyAttributeIds?: unknown } }).value
    // The regression: this was the envelope, so `.attributes` was undefined.
    expect(v.policy.attributes).toHaveLength(2)
    expect(v.policy.validFromBlock).toBe('0')
    expect(v.policyAttributeIds).toBeDefined()
  })

  it('treats found:true with no policy body as a failed read, not a hit', async () => {
    const query = vi.fn().mockResolvedValue(rets('{"found":true}'))
    expect(await getPolicyByKey('ZTX3Policy', 'k', query)).toMatchObject({ error: 'query_failed' })
  })

  it('reads the real vocabulary off both templates', () => {
    expect([...declaredVocabulary(NATIVE_V1 as never).keys()]).toHaveLength(11)
    expect([...declaredVocabulary(ZTP20_V1 as never).keys()]).toHaveLength(13)
    expect(declaredVocabulary(ZTP20_V1 as never).get('tokenAddress')).toBe('ADDRESS')
  })
})

describe('the window rules hold against the real templates', () => {
  it('both templates declare all three cap/window pairs', () => {
    for (const t of [NATIVE_V1, ZTP20_V1]) {
      const names = t.attributes.map((a) => a.attributeName)
      for (const [cap, window] of [
        ['cumulativeMax', 'cumulativeWindow'],
        ['velocityCap', 'velocityWindow'],
        ['maxTransactionCount', 'countWindow'],
      ]) {
        expect(names, cap).toContain(cap)
        expect(names, window).toContain(window)
      }
    }
  })

  it('still blocks velocityCap without its window, on a real template', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      { attributeName: 'velocityCap', attributeType: 'NUMBER', value: '5' },
    ]))
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toContain('VALUE_INVALID')
  })

  it('still calls a windowless cumulativeMax a lifetime cap, on a real template', async () => {
    const r = await policyPreflight(deps(ZTP20_V1), draft([
      SCOPE,
      { attributeName: 'cumulativeMax', attributeType: 'NUMBER', value: '500000000' },
    ]))
    expect(r.ready).toBe(true)
    expect(r.interpretation.join(' ')).toMatch(/lifetime/i)
  })
})
