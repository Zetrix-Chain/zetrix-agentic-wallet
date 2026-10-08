/**
 * The unit guard and `amountUnit`.
 *
 * A real policy went on chain with `perTransactionMax: 1` and `cumulativeMax: 100` for a 6-decimal
 * token (JMYR) — 0.000001 and 0.0001 of it, a million times tighter than the "1 JMYR" and "100 JMYR"
 * the user meant. Amounts are RAW base units, nothing made that visible before the payment, and the
 * write could not be taken back.
 *
 * Inputs are the REAL native-v1 / ztp20-v1 templates.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight, MAX_MESSAGE, type PolicyPreflightDeps } from '../orchestrator/policy-preflight'
import { NATIVE_V1, ZTP20_V1 } from './fixtures/real-policy-templates'
import { buildToolList } from '../index'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

type Attr = { attributeName: string; attributeType: string; value: string }
const a = (attributeName: string, value: string, attributeType = 'STRING'): Attr => ({ attributeName, attributeType, value })
const NUM = (name: string, value: string): Attr => a(name, value, 'NUMBER')

const draft = (attributes: Attr[], amountUnit?: unknown, policyKey = 'native-v1') => ({
  policyKey,
  templateId: 'a'.repeat(64),
  attributes,
  validFromBlock: '0',
  validToBlock: '0',
  ...(amountUnit === undefined ? {} : { amountUnit }),
})

const deps = (over: Partial<PolicyPreflightDeps> = {}, template: unknown = NATIVE_V1): PolicyPreflightDeps => ({
  readTemplate: async () => ({ found: true, value: template }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (x: string) => keypair.checkAddress(x),
  knownTokens: { JMYR },
  describeUnit: async () => ({ symbol: 'JMYR', decimals: 6 }),
  ...over,
})

const NATIVE = a('assetScope', 'native')
const TOKEN = [a('assetScope', 'ztp20'), a('tokenAddress', JMYR, 'ADDRESS')]
const text = (r: { blockers: string[]; interpretation: string[]; notChecked: string[] }) => ({
  blockers: r.blockers.join(' | '),
  interpretation: r.interpretation.join(' | '),
  notChecked: r.notChecked.join(' | '),
})
const native = (value: string, unit?: unknown, cap = 'perTransactionMax') =>
  policyPreflight(deps(), draft([NATIVE, NUM(cap, value)], unit))
const token = (values: Attr[], unit?: unknown, over: Partial<PolicyPreflightDeps> = {}) =>
  policyPreflight(deps(over, ZTP20_V1), draft([...TOKEN, ...values], unit, 'ztp20-v1'))

describe('the transcript: 1 and 100 JMYR written as 1 and 100', () => {
  it('is refused without amountUnit, naming what the values actually are and what to write', async () => {
    const r = await token([NUM('perTransactionMax', '1'), NUM('cumulativeMax', '100'), a('cumulativeWindow', '7d')])
    const t = text(r)
    expect(r.ready).toBe(false)
    expect(t.blockers).toMatch(/"perTransactionMax" is 1, which is only 0\.000001 JMYR/)
    expect(t.blockers).toMatch(/"cumulativeMax" is 100, which is only 0\.0001 JMYR/)
    expect(t.blockers).toContain('write 1000000')
    expect(t.blockers).toContain('write 100000000')
    expect(t.blockers).toContain('amountUnit "whole"')
    expect(t.blockers).toContain('amountUnit "base"')
  })

  it('is ready and converted with amountUnit "whole"', async () => {
    const r = await token([NUM('perTransactionMax', '1'), NUM('cumulativeMax', '100'), a('cumulativeWindow', '7d')], 'whole')
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000', cumulativeMax: '100000000' })
    expect(text(r).interpretation).toMatch(/"perTransactionMax": 1 JMYR is written as 1000000/)
    expect(text(r).interpretation).toMatch(/"cumulativeMax": 100 JMYR is written as 100000000/)
  })
})

describe('the unit guard (amountUnit omitted)', () => {
  it('refuses a non-zero cap under one whole token, naming it in whole tokens', async () => {
    const r = await native('1')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"perTransactionMax" is 1, which is only 0\.000001 ZTX/)
    expect(text(r).blockers).toMatch(/less than one whole token/)
  })

  it('draws the line exactly at one whole token', async () => {
    expect((await native('999999')).ready).toBe(false)
    expect((await native('1000000')).ready).toBe(true)
    expect((await native('1000001')).ready).toBe(true)
  })

  it('does not refuse zero, which is a deliberate deny-all', async () => {
    expect(text(await native('0')).blockers).not.toMatch(/whole token/)
  })

  for (const cap of ['perTransactionMax', 'cumulativeMax', 'velocityCap']) {
    it(`covers ${cap}`, async () => {
      const attrs = [NATIVE, NUM(cap, '5')]
      if (cap === 'cumulativeMax') attrs.push(a('cumulativeWindow', '7d'))
      if (cap === 'velocityCap') attrs.push(a('velocityWindow', '1h'))
      const r = await policyPreflight(deps(), draft(attrs))
      expect(text(r).blockers).toContain(`"${cap}" is 5, which is only 0.000005 ZTX`)
    })
  }

  it('does not touch a COUNT, which is not in base units', async () => {
    const r = await policyPreflight(deps(), draft([NATIVE, NUM('maxTransactionCount', '5'), a('countWindow', '1d')]))
    expect(text(r).blockers).not.toMatch(/whole token/)
  })

  it('states every small cap, one blocker each', async () => {
    const r = await native('1')
    const two = await policyPreflight(deps(), draft([NATIVE, NUM('perTransactionMax', '1'), NUM('cumulativeMax', '2'), a('cumulativeWindow', '7d')]))
    expect(r.blockers.filter((b) => /whole token/.test(b))).toHaveLength(1)
    expect(two.blockers.filter((b) => /whole token/.test(b))).toHaveLength(2)
  })

  it('uses the TOKEN\'s decimals, not 6', async () => {
    const two = { describeUnit: async () => ({ symbol: 'TKN', decimals: 2 }) }
    expect((await token([NUM('perTransactionMax', '99')], undefined, two)).ready).toBe(false)
    expect((await token([NUM('perTransactionMax', '100')], undefined, two)).ready).toBe(true)
  })

  it('has no guard for a token with no decimals — one unit IS one whole token', async () => {
    const r = await token([NUM('perTransactionMax', '1')], undefined, { describeUnit: async () => ({ symbol: 'TKN', decimals: 0 }) })
    expect(r.blockers).toEqual([])
  })

  it('cannot judge when the decimals are unreadable, says so, and does not guess', async () => {
    const r = await token([NUM('perTransactionMax', '1')], undefined, { describeUnit: async () => null })
    expect(text(r).blockers).not.toMatch(/whole token/)
    expect(text(r).notChecked).toMatch(/could not be worked out/)
  })

  it('has no guard without a usable scope — the scope rules already refuse that draft', async () => {
    const r = await policyPreflight(deps(), draft([NUM('perTransactionMax', '1')]))
    expect(text(r).blockers).not.toMatch(/whole token/)
  })

  it('ignores values that are not plain whole numbers — the type check owns those', async () => {
    for (const v of ['abc', '1.5', '-1', '']) {
      expect(text(await native(v)).blockers, v).not.toMatch(/whole token/)
    }
  })

  it('reads the chain for decimals only when there is an amount to read them for', async () => {
    const describeUnit = vi.fn(async () => ({ symbol: 'JMYR', decimals: 6 }))
    await policyPreflight(deps({ describeUnit }, ZTP20_V1), draft([...TOKEN, NUM('maxTransactionCount', '5'), a('countWindow', '1d')], undefined, 'ztp20-v1'))
    expect(describeUnit).not.toHaveBeenCalled()
  })
})

describe('amountUnit "base" is the explicit acknowledgement', () => {
  it('lets a tiny raw value through, and still states what it means', async () => {
    const r = await native('1', 'base')
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(text(r).interpretation).toMatch(/"perTransactionMax" is 1 in BASE units: 1 = 0\.000001 ZTX/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('changes no value', async () => {
    const r = await native('1', 'base')
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('is NOT satisfied by silence, null or anything else', async () => {
    expect((await native('1')).ready).toBe(false)
    expect((await native('1', null as never)).ready).toBe(false)
  })
})

describe('amountUnit "whole" converts by the token\'s decimals', () => {
  const cases: Array<[string, string]> = [
    ['1', '1000000'],
    ['0.5', '500000'],
    ['100', '100000000'],
    ['1.000001', '1000001'],
    ['0.000001', '1'],
    ['1.5', '1500000'],
    ['0', '0'],
    ['007', '7000000'],
  ]
  for (const [whole, raw] of cases) {
    it(`${whole} becomes ${raw}`, async () => {
      const r = await native(whole, 'whole')
      expect(r.blockers, whole).toEqual([])
      expect(r.convertedAmounts).toEqual({ perTransactionMax: raw })
    })
  }

  it('allows a small whole-token amount the guard would refuse as raw, because it was asked for in whole units', async () => {
    const r = await native('0.000001', 'whole')
    expect(r.ready).toBe(true)
    expect(text(r).blockers).not.toMatch(/whole token/)
  })

  it('converts all three amount caps and leaves everything else alone', async () => {
    const r = await policyPreflight(
      deps(),
      draft(
        [NATIVE, NUM('perTransactionMax', '1'), NUM('cumulativeMax', '2'), NUM('velocityCap', '3'), NUM('maxTransactionCount', '5'),
          a('cumulativeWindow', '7d'), a('velocityWindow', '1h'), a('countWindow', '1d')],
        'whole',
      ),
    )
    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000', cumulativeMax: '2000000', velocityCap: '3000000' })
    // A count is not an amount, so it is not scaled.
    expect(Object.keys(r.convertedAmounts!)).not.toContain('maxTransactionCount')
  })

  it('scales by the token\'s own decimals', async () => {
    const r = await token([NUM('perTransactionMax', '1.5')], 'whole', { describeUnit: async () => ({ symbol: 'TKN', decimals: 2 }) })
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '150' })
  })

  it('needs no scaling for a token with no decimals, and refuses a fraction of one', async () => {
    const zero = { describeUnit: async () => ({ symbol: 'TKN', decimals: 0 }) }
    expect((await token([NUM('perTransactionMax', '5')], 'whole', zero)).convertedAmounts).toEqual({ perTransactionMax: '5' })
    const frac = await token([NUM('perTransactionMax', '5.5')], 'whole', zero)
    expect(text(frac).blockers).toMatch(/more decimal places than TKN supports \(0\)/)
  })

  it('refuses more decimal places than the token has, and rounds nothing', async () => {
    const r = await native('1.0000001', 'whole')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/more decimal places than ZTX supports \(6\)\. Nothing was rounded/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  for (const bad of ['1e3', '-1', ' 1', '1 ', '1,5', '', '.5', '1.', 'abc', '+1', '0x10', '1.5.2', '9'.repeat(41)]) {
    it(`refuses ${JSON.stringify(bad.length > 20 ? bad.slice(0, 8) + '…' : bad)} as not a plain amount`, async () => {
      const r = await native(bad, 'whole')
      expect(r.ready).toBe(false)
      expect(text(r).blockers).toMatch(/not a plain amount/)
      expect(r.convertedAmounts).toBeUndefined()
    })
  }

  it('refuses the whole draft when one amount is invalid, even though another converted cleanly', async () => {
    const r = await policyPreflight(deps(), draft([NATIVE, NUM('perTransactionMax', '1'), NUM('cumulativeMax', 'lots'), a('cumulativeWindow', '7d')], 'whole'))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"cumulativeMax" is "lots"/)
  })

  it('refuses to convert when the token\'s decimals could not be read', async () => {
    const r = await token([NUM('perTransactionMax', '1')], 'whole', { describeUnit: async () => null })
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/needs the token's decimals, which could not be read, so nothing was converted/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('treats a THROWING decimals reader as unreadable, not as a crash', async () => {
    const r = await token([NUM('perTransactionMax', '1')], 'whole', { describeUnit: async () => { throw new Error('down') } })
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/could not be read/)
  })

  it('refuses to convert without a usable asset, and says what to set', async () => {
    const r = await policyPreflight(deps(), draft([NUM('perTransactionMax', '1')], 'whole'))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/needs to know which asset the amounts are in/)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('is a no-op when there is no amount to convert', async () => {
    const r = await policyPreflight(deps(), draft([NATIVE, NUM('maxTransactionCount', '5'), a('countWindow', '1d')], 'whole'))
    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('judges the CONVERTED value like any other number, so "1.5" is not rejected as a NUMBER', async () => {
    const r = await native('1.5', 'whole')
    expect(text(r).blockers).not.toMatch(/declared NUMBER/)
    expect(r.ready).toBe(true)
  })

  it('states the unit of the converted value too, so the raw figure and its meaning sit together', async () => {
    const r = await native('1.5', 'whole')
    expect(text(r).interpretation).toMatch(/1\.5 ZTX is written as 1500000/)
    expect(text(r).interpretation).toMatch(/"perTransactionMax" is 1500000 in BASE units: 1500000 = 1\.5 ZTX/)
  })

  it('handles a 40-digit amount without losing precision', async () => {
    const big = '9'.repeat(40)
    // One small cap alongside, so not EVERY amount looks already-raw (that draft is refused — see below).
    const r = await policyPreflight(
      deps(),
      draft([NATIVE, NUM('perTransactionMax', '1'), NUM('cumulativeMax', big), a('cumulativeWindow', '7d')], 'whole'),
    )
    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000', cumulativeMax: big + '000000' })
  })
})

describe('amountUnit itself is validated', () => {
  for (const bad of ['human', 'WHOLE', 'Base', 1, true, {}, [], 'whole ']) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      const r = await native('1000000', bad)
      expect(r.ready).toBe(false)
      expect(text(r).blockers).toMatch(/is not one of "whole" or "base"/)
    })
  }

  it('treats null as omitted — it is how a loosely typed channel says so', async () => {
    const r = await native('1000000', null as never)
    expect(r.ready).toBe(true)
  })

  it('bounds what it echoes of a hostile value', async () => {
    const r = await native('1000000', 'x'.repeat(50_000))
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })
})

describe('bounds', () => {
  it('bounds what it echoes of a hostile amount value', async () => {
    const r = await native('9'.repeat(50_000), 'whole')
    expect(r.ready).toBe(false)
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })

  it('bounds what it echoes of a hostile token symbol', async () => {
    const r = await token([NUM('perTransactionMax', '1')], undefined, { describeUnit: async () => ({ symbol: 'S'.repeat(50_000), decimals: 6 }) })
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })

  it('keeps the unit blocker when a flood of attribute faults would otherwise push it out', async () => {
    // Draft-level on purpose, like the scope and window rules.
    const junk = Array.from({ length: 150 }, (_, i) => a(`junk${i}`, '1'))
    const r = await policyPreflight(deps(), draft([NATIVE, NUM('perTransactionMax', '1'), ...junk]))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"perTransactionMax" is 1, which is only 0\.000001 ZTX/)
  })
})

describe('the tool schemas', () => {
  // The enum is what stops an agent inventing a third unit ("human", "ztx") the wallet would then have
  // to guess about; both tools must say the same thing or one accepts what the other refuses.
  it('declare amountUnit as exactly "whole" or "base" on BOTH tools, and never as required', () => {
    for (const name of ['policy_preflight', 'write_policy']) {
      const tool = buildToolList().find((t) => t.name === name)!
      const schema = tool.inputSchema as unknown as { properties: Record<string, { enum?: string[]; type?: string }>; required: string[] }
      expect(schema.properties.amountUnit, name).toBeDefined()
      expect(schema.properties.amountUnit.type, name).toBe('string')
      expect(schema.properties.amountUnit.enum, name).toEqual(['whole', 'base'])
      expect(schema.required, name).not.toContain('amountUnit')
    }
  })
})

// ── mutation survivors U27 / U28 ────────────────────────────────────────────────────────────────

describe('the conversion line', () => {
  it('bounds a hostile token symbol in the line that states a converted amount', async () => {
    // The bound tests elsewhere only run the guard path. A converted amount has its OWN line, with its own
    // echo of the symbol, and the result-wide backstop would satisfy a length check whether or not that site
    // capped anything — so what is checked is that no line was cut off mid-sentence.
    const r = await token([NUM('perTransactionMax', '1')], 'whole', { describeUnit: async () => ({ symbol: 'S'.repeat(50_000), decimals: 6 }) })
    const line = r.interpretation.find((l) => /is written as/.test(l))
    expect(line, 'a conversion line').toBeDefined()
    expect(line!.length).toBeLessThanOrEqual(MAX_MESSAGE)
    for (const l of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(l.endsWith('…'), l.slice(0, 60)).toBe(false)
    }
  })

  it('says the converted value is the raw base-unit value the service stores', async () => {
    const r = await native('1', 'whole')
    expect(text(r).interpretation).toMatch(/is written as 1000000 — the raw base-unit value the service stores\./)
  })
})

// ── review findings ──────────────────────────────────────────────────────────────────

describe('APP-M01 — token decimals are typed strictly and bounded', () => {
  const unit = (decimals: unknown) => ({ describeUnit: async () => ({ symbol: 'TKN', decimals: decimals as number }) })

  // Whatever supplies decimals, a bad value must read as "unreadable" — never as a scale. These scale a value that is WRITTEN.
  for (const bad of [77, 37, 1e9, 1e300, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '6', null, undefined, '', false, [], {}]) {
    it('treats decimals of ' + String(typeof bad === 'object' ? JSON.stringify(bad) : bad) + ' as unreadable, for conversion', async () => {
      const r = await token([NUM('perTransactionMax', '1')], 'whole', unit(bad))
      expect(r.ready).toBe(false)
      expect(r.convertedAmounts).toBeUndefined()
      expect(text(r).blockers).toMatch(/needs the token's decimals, which could not be read, so nothing was converted/)
    })
  }

  it('and does not THROW or stall on absurd decimals, which used to raise RangeError out of preflight', async () => {
    const started = Date.now()
    const r = await token([NUM('perTransactionMax', '1')], 'whole', unit(1e300))
    expect(r.ready).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('does not apply the unit guard on unreadable decimals either, and says it could not tell', async () => {
    const r = await token([NUM('perTransactionMax', '1')], undefined, unit(1e9))
    expect(text(r).blockers).not.toMatch(/whole token/)
    expect(text(r).notChecked).toMatch(/could not be worked out/)
  })

  it('accepts exactly the largest allowed decimals and refuses one more', async () => {
    const at = await token([NUM('perTransactionMax', '1')], 'whole', unit(36))
    expect(at.convertedAmounts).toEqual({ perTransactionMax: '1' + '0'.repeat(36) })
    const over = await token([NUM('perTransactionMax', '1')], 'whole', unit(37))
    expect(over.convertedAmounts).toBeUndefined()
  })

  it('refuses a symbol that is not a string', async () => {
    const r = await token([NUM('perTransactionMax', '1')], 'whole', { describeUnit: async () => ({ symbol: 7 as unknown as string, decimals: 6 }) })
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('keeps even the largest possible conversion at 76 digits, inside a 256-bit number', async () => {
    // This pins the WALLET's own arithmetic: a whole part of at most 40 digits at the most decimals it believes (36) is
    // 76 digits. The comment above cites the service's parser as accepting up to 200 digits; that is read from its
    // source and not verified at runtime — the wallet's own 77-digit ceiling does not depend on it.
    const r = await token(
      [NUM('perTransactionMax', '1'), NUM('cumulativeMax', '9'.repeat(40)), a('cumulativeWindow', '7d')],
      'whole',
      unit(36),
    )
    const biggest = r.convertedAmounts!.cumulativeMax
    expect(biggest.length).toBe(76)
    expect(biggest.length).toBeLessThanOrEqual(200)
  })
})

describe('APP-M02 — an already-converted value is not converted a second time', () => {
  // The reviewer's scenario: an agent copies convertedAmounts.perTransactionMax = "1000000" into write_policy and keeps
  // amountUnit "whole". 1,000,000 JMYR is at or above one token, so no small-value guard fires — and the cap would be
  // written a MILLION times looser than meant.
  it('refuses "whole" when every amount is already 10^decimals tokens or more', async () => {
    const r = await native('1000000', 'whole')
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
    expect(text(r).blockers).toMatch(/every amount here is 1000000 or more whole ZTX/)
    // BOTH readings, each with its own route — the remedy for a copied raw value (resend it unchanged) is the WRONG one
    // for a genuinely large cap (send it times 10^decimals), and the reverse.
    expect(text(r).blockers).toMatch(/If they are already raw .* resend them UNCHANGED with amountUnit "base"/)
    expect(text(r).blockers).toMatch(/If you really mean that many whole tokens, resend with amountUnit "base" and each value times 1000000/)
    expect(text(r).blockers).toMatch(/"perTransactionMax" 1000000 becomes 1000000000000/)
    expect(text(r).blockers).toMatch(/times looser or tighter/)
    expect(text(r).blockers).toMatch(/nothing was converted/)
  })

  it('draws the line exactly at 10^decimals: one below converts, the boundary is refused', async () => {
    expect((await native('999999', 'whole')).convertedAmounts).toEqual({ perTransactionMax: '999999000000' })
    expect((await native('1000000', 'whole')).ready).toBe(false)
    expect((await native('1000001', 'whole')).ready).toBe(false)
  })

  it('looks at the whole-token part, so a fractional value over the line is refused too', async () => {
    expect((await native('1000000.5', 'whole')).ready).toBe(false)
  })

  it('scales the line to the token: 100 is the line at 2 decimals', async () => {
    const two = { describeUnit: async () => ({ symbol: 'TKN', decimals: 2 }) }
    expect((await token([NUM('perTransactionMax', '99')], 'whole', two)).convertedAmounts).toEqual({ perTransactionMax: '9900' })
    expect((await token([NUM('perTransactionMax', '100')], 'whole', two)).ready).toBe(false)
  })

  it('refuses only when EVERY amount looks raw — one ordinary amount means the draft is plausibly whole-token', async () => {
    const r = await policyPreflight(
      deps(),
      draft([NATIVE, NUM('perTransactionMax', '1'), NUM('cumulativeMax', '2000000'), a('cumulativeWindow', '7d')], 'whole'),
    )
    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '1000000', cumulativeMax: '2000000000000' })
  })

  it('does not crash, or call it a double conversion, when an already-raw amount sits beside an INVALID one', async () => {
    // The check only applies when every amount parses; one that does not has its own blocker. Asking it to compare
    // an unparseable value would throw out of preflight.
    const r = await policyPreflight(
      deps(),
      draft([NATIVE, NUM('perTransactionMax', '1000000'), NUM('cumulativeMax', 'lots'), a('cumulativeWindow', '7d')], 'whole'),
    )
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"cumulativeMax" is "lots", which is not a plain amount/)
    expect(text(r).blockers).not.toMatch(/looser or tighter/)
  })

  it('refuses when every one of several amounts looks raw', async () => {
    const r = await policyPreflight(
      deps(),
      draft([NATIVE, NUM('perTransactionMax', '1000000'), NUM('cumulativeMax', '100000000'), a('cumulativeWindow', '7d')], 'whole'),
    )
    expect(r.ready).toBe(false)
    expect(r.convertedAmounts).toBeUndefined()
  })

  it('has no such ambiguity for a token with no decimals, where one unit IS one token', async () => {
    const zero = { describeUnit: async () => ({ symbol: 'TKN', decimals: 0 }) }
    const r = await token([NUM('perTransactionMax', '5000000')], 'whole', zero)
    expect(r.blockers).toEqual([])
    expect(r.convertedAmounts).toEqual({ perTransactionMax: '5000000' })
  })

  it('leaves the plain "not a number" refusal to say its own thing, not the double-conversion one', async () => {
    const r = await native('lots', 'whole')
    expect(text(r).blockers).toMatch(/not a plain amount/)
    expect(text(r).blockers).not.toMatch(/looser or tighter/)
  })

  it('does not apply to amountUnit "base", where a large raw value is exactly what is meant', async () => {
    const r = await native('1000000', 'base')
    expect(r.ready).toBe(true)
    expect(r.convertedAmounts).toBeUndefined()
  })
})

describe('the duplicate-name refusal still runs BEFORE the amount pass', () => {
  // convertedAmounts is keyed by name, so with two entries of the same name the last would win and the write would send
  // it for both. That is safe ONLY because a repeated name is refused first. If that check moved after this pass, or were
  // weakened, this would become unsafe — so the ordering is pinned here.
  it('refuses a repeated amount attribute with amountUnit "whole", and converts nothing', async () => {
    const r = await policyPreflight(deps(), draft([NATIVE, NUM('perTransactionMax', '1'), NUM('perTransactionMax', '2')], 'whole'))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"perTransactionMax" \(2 times\)/)
    expect(r.convertedAmounts).toBeUndefined()
    expect(text(r).interpretation).not.toMatch(/is written as/)
  })

  it('refuses a repeated assetScope or tokenAddress before the unit is resolved', async () => {
    const describeUnit = vi.fn(async () => ({ symbol: 'JMYR', decimals: 6 }))
    const r = await token([a('tokenAddress', JMYR, 'ADDRESS'), NUM('perTransactionMax', '1')], 'whole', { describeUnit })
    expect(r.ready).toBe(false)
    expect(describeUnit).not.toHaveBeenCalled()
  })
})

// ── review round 2 (APP-M03): a genuinely large cap is refused, but the refusal names the RIGHT route ──────────

describe('APP-M03 — the double-conversion refusal gives both readings and the exact value for each', () => {
  // "1000000" under amountUnit "whole" is ambiguous: a value copied back from convertedAmounts (meant 1 token), or a
  // genuine cap of a million tokens. The two need OPPOSITE routes, and following the wrong one is the original incident
  // (1,000,000 raw = 1 JMYR, a million times tighter than meant) or its reverse. A refusal that named only "use base"
  // would have walked a user with a real million-token budget straight into it.
  it('works the large reading through with the exact raw value to send', async () => {
    const r = await native('1000000', 'whole')
    expect(text(r).blockers).toMatch(/each value times 1000000 — "perTransactionMax" 1000000 becomes 1000000000000/)
  })

  it('computes it for the FIRST amount, whichever it is', async () => {
    const r = await policyPreflight(
      deps(),
      draft([NATIVE, NUM('perTransactionMax', '2000000'), NUM('cumulativeMax', '3000000'), a('cumulativeWindow', '7d')], 'whole'),
    )
    expect(text(r).blockers).toMatch(/"perTransactionMax" 2000000 becomes 2000000000000/)
  })

  it('handles a fractional large amount without rounding or throwing', async () => {
    const r = await native('1000000.5', 'whole')
    expect(text(r).blockers).toMatch(/"perTransactionMax" 1000000\.5 becomes 1000000500000/)
  })

  it('uses the token\'s own scale: 100 tokens of a 2-decimal token is 10000', async () => {
    const two = { describeUnit: async () => ({ symbol: 'TKN', decimals: 2 }) }
    const r = await token([NUM('perTransactionMax', '100')], 'whole', two)
    expect(text(r).blockers).toMatch(/each value times 100 — "perTransactionMax" 100 becomes 10000/)
  })

  it('is one blocker, bounded, and not cut off mid-sentence even with a hostile symbol', async () => {
    const r = await token([NUM('perTransactionMax', '1000000')], 'whole', { describeUnit: async () => ({ symbol: 'S'.repeat(50_000), decimals: 6 }) })
    const lines = r.blockers.filter((b) => /every amount here is/.test(b))
    expect(lines).toHaveLength(1)
    for (const l of r.blockers) {
      expect(l.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(l.endsWith('…'), l.slice(0, 60)).toBe(false)
    }
  })

  describe('and each route it names actually works', () => {
    it('the large route: the value times 10^decimals with amountUnit "base" is accepted and means what the user meant', async () => {
      const r = await native('1000000000000', 'base')
      expect(r.blockers).toEqual([])
      expect(r.ready).toBe(true)
      expect(r.convertedAmounts).toBeUndefined()
      // The interpretation says it is a million whole tokens, so the user can see the intent was honoured.
      expect(text(r).interpretation).toMatch(/1000000000000 = 1000000 ZTX/)
    })

    it('the copied-raw route: the same value unchanged with "base" is 1 token, and says so', async () => {
      const r = await native('1000000', 'base')
      expect(r.ready).toBe(true)
      expect(text(r).interpretation).toMatch(/1000000 = 1 ZTX/)
    })

    it('the two routes are different values, which is why guessing is dangerous', async () => {
      const copied = await native('1000000', 'base')
      const large = await native('1000000000000', 'base')
      expect(text(copied).interpretation).not.toBe(text(large).interpretation)
    })
  })
})

describe('raw amounts are bounded in length too (APP-L02)', () => {
  // Nothing larger than a 256-bit number exists, which is at most 77 digits. A longer value is a mistake, and without a
  // bound it also produced no interpretation line at all.
  it('accepts exactly 77 digits and says what it means', async () => {
    const r = await native('9'.repeat(77), 'base')
    expect(r.ready).toBe(true)
    expect(text(r).interpretation).toMatch(/in BASE units/)
  })

  it('refuses 78 digits, in every mode that carries a raw value', async () => {
    for (const unit of [undefined, 'base'] as const) {
      const r = await native('9'.repeat(78), unit)
      expect(r.ready, String(unit)).toBe(false)
      expect(text(r).blockers, String(unit)).toMatch(/has 78 digits — more than any amount that fits in 256 bits \(77 at most\)/)
    }
  })

  it('refuses an absurdly long value, and every line it produces stays bounded', async () => {
    const r = await native('9'.repeat(50_000), 'base')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/has 50000 digits/)
    for (const l of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(l.length).toBeLessThanOrEqual(MAX_MESSAGE)
    }
  })

  it('describes a value of 41 to 77 digits, which used to get no interpretation line', async () => {
    const r = await native('9'.repeat(60), 'base')
    expect(text(r).interpretation).toMatch(/in BASE units/)
  })
})
