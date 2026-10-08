/**
 * The three things a real transcript showed preflight leaving to guesswork.
 *
 * "token use jmyr, limit per transaction 1 jmyr, cumulativeMax 100, window per week" on ztp20-v1:
 *  1. the agent asked the user for JMYR's contract address, which the wallet already holds;
 *  2. it could not tell whether `1` meant 1 JMYR or 1 base unit (it is 0.000001 JMYR);
 *  3. preflight accepted `cumulativeWindow: "week"`, which the write service refuses.
 *
 * Inputs are the REAL ztp20-v1 template, and the draft below is the transcript's draft.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight, MAX_MESSAGE, type PolicyPreflightDeps } from '../orchestrator/policy-preflight'
import { ZTP20_V1, NATIVE_V1 } from './fixtures/real-policy-templates'

const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'
const OTHER_TOKEN = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const TYPO = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'
const KNOWN = { JMYR }

type Attr = { attributeName: string; attributeType: string; value: string }
const a = (attributeName: string, value: string, attributeType = 'STRING'): Attr => ({ attributeName, attributeType, value })
const NUM = (name: string, value: string): Attr => a(name, value, 'NUMBER')

const draft = (attributes: Attr[], policyKey = 'ztp20-v1') => ({
  policyKey,
  templateId: 'a'.repeat(64),
  attributes,
  validFromBlock: '0',
  validToBlock: '0',
})

const deps = (over: Partial<PolicyPreflightDeps> = {}, template: unknown = ZTP20_V1): PolicyPreflightDeps => ({
  readTemplate: async () => ({ found: true, value: template }) as never,
  network: 'zetrix:testnet',
  isValidAddress: (x: string) => keypair.checkAddress(x),
  knownTokens: KNOWN,
  describeUnit: async () => ({ symbol: 'JMYR', decimals: 6 }),
  ...over,
})

const text = (r: { blockers: string[]; interpretation: string[]; notChecked: string[] }) => ({
  blockers: r.blockers.join(' | '),
  interpretation: r.interpretation.join(' | '),
  notChecked: r.notChecked.join(' | '),
})

describe('the transcript draft, verbatim', () => {
  const transcript = draft([
    a('assetScope', 'ztp20'),
    a('tokenAddress', 'JMYR', 'ADDRESS'),
    NUM('perTransactionMax', '1'),
    NUM('cumulativeMax', '100'),
    a('cumulativeWindow', 'week'),
    a('unknownAttributePolicy', 'deny'),
    a('allowedMethods', '["transfer"]', 'STRING_LIST'),
  ])

  it('is refused, and says what to write instead of leaving the agent to ask', async () => {
    const r = await policyPreflight(deps(), transcript)
    const t = text(r)
    expect(r.ready).toBe(false)
    // The address the wallet already holds, named in the blocker.
    expect(t.blockers).toContain(JMYR)
    expect(t.blockers).toMatch(/token symbol, not an address/)
    // The window, with the corrected form.
    expect(t.blockers).toMatch(/cumulativeWindow.*"week".*refuses/)
    expect(t.blockers).toContain('write 7d')
  })

  it('does not ALSO tell the agent to leave a registered symbol alone', async () => {
    // The generic checksum blocker says "ask the user, do not correct it yourself". For a registered
    // symbol that is the opposite of right, and two blockers giving opposite advice is worse than one.
    const r = await policyPreflight(deps(), transcript)
    expect(text(r).blockers).not.toMatch(/checksum|do not correct|rather than correcting/i)
  })

  it('is ready once corrected, and then states what the amounts mean', async () => {
    const fixed = draft([
      a('assetScope', 'ztp20'),
      a('tokenAddress', JMYR, 'ADDRESS'),
      NUM('perTransactionMax', '1000000'),
      NUM('cumulativeMax', '100000000'),
      a('cumulativeWindow', '7d'),
      a('unknownAttributePolicy', 'deny'),
      a('allowedMethods', '["transfer"]', 'STRING_LIST'),
    ])
    const r = await policyPreflight(deps(), fixed)
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    const t = text(r)
    expect(t.interpretation).toMatch(/"perTransactionMax" is 1000000 in BASE units: 1000000 = 1 JMYR/)
    expect(t.interpretation).toMatch(/"cumulativeMax" is 100000000 in BASE units: 100000000 = 100 JMYR/)
  })
})

describe('naming the token address the wallet already holds', () => {
  const noToken = [a('assetScope', 'ztp20'), NUM('perTransactionMax', '1000000')]

  it('lists the registered tokens when a ztp20 draft has no tokenAddress', async () => {
    const r = await policyPreflight(deps(), draft(noToken))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/no "tokenAddress" says which token/)
    expect(text(r).blockers).toContain(`JMYR is ${JMYR}`)
    expect(text(r).blockers).toMatch(/if it is none of these, ask the user for the contract address/i)
  })

  it('says nothing about known tokens when none are registered, rather than inventing a list', async () => {
    const r = await policyPreflight(deps({ knownTokens: {} }), draft(noToken))
    expect(text(r).blockers).toMatch(/no "tokenAddress" says which token/)
    expect(text(r).blockers).not.toMatch(/Tokens this wallet knows/)
  })

  it('says nothing about known tokens when the dep is not wired', async () => {
    const r = await policyPreflight(deps({ knownTokens: undefined }), draft(noToken))
    expect(text(r).blockers).not.toMatch(/Tokens this wallet knows/)
  })

  it('refuses a registered symbol written as the address, case-insensitively', async () => {
    for (const symbol of ['JMYR', 'jmyr', 'Jmyr', ' JMYR ']) {
      const r = await policyPreflight(deps(), draft([a('assetScope', 'ztp20'), a('tokenAddress', symbol, 'ADDRESS')]))
      expect(r.ready, symbol).toBe(false)
      expect(text(r).blockers, symbol).toContain(`JMYR on this network is ${JMYR}`)
    }
  })

  it('still allows any valid contract address that is not registered', async () => {
    const r = await policyPreflight(
      deps(),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '1000000')]),
    )
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
  })

  it('still gives the checksum advice for a mistyped ADDRESS that is not a symbol', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'ztp20'), a('tokenAddress', TYPO, 'ADDRESS')]))
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/checksum/)
    expect(text(r).blockers).not.toMatch(/token symbol, not an address/)
  })

  it('does not treat an unregistered word as a symbol', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'ztp20'), a('tokenAddress', 'XYZ', 'ADDRESS')]))
    expect(text(r).blockers).toMatch(/checksum/)
    expect(text(r).blockers).not.toMatch(/token symbol, not an address/)
  })

  it('only counts a token that is registered ITSELF, not one a lookup table merely inherits', async () => {
    // Symbols are upper-cased before lookup and Object.prototype has no upper-case keys, so the usual
    // suspects ("constructor", "toString") cannot exercise this. A table that genuinely inherits an
    // upper-case key can: with `in`, EVIL reads as a registered symbol; with an own-property check it
    // does not.
    const inherited = Object.create({ EVIL: 'ZTX3EvilContractAddress00000000000000' }) as Record<string, string>
    const r = await policyPreflight(
      deps({ knownTokens: inherited }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', 'EVIL', 'ADDRESS')]),
    )
    expect(text(r).blockers).not.toMatch(/token symbol, not an address/)
    expect(text(r).blockers).not.toContain('ZTX3EvilContractAddress')
  })

  it('bounds the token list it offers when NO tokenAddress was given', async () => {
    // A different echo site from the symbol rule: here the registered tokens are listed in the
    // blocker for a missing address, so a hostile registry entry reaches it with no draft value involved.
    const r = await policyPreflight(
      deps({ knownTokens: { ['J'.repeat(50_000)]: 'ZTX3' + 'A'.repeat(50_000) } }),
      draft([a('assetScope', 'ztp20'), NUM('perTransactionMax', '1000000')]),
    )
    expect(text(r).blockers).toMatch(/Tokens this wallet knows/)
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })

  it('bounds what it echoes of a hostile symbol-shaped value', async () => {
    const r = await policyPreflight(
      deps({ knownTokens: { ['J'.repeat(50_000)]: 'ZTX3' + 'A'.repeat(50_000) } }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', 'J'.repeat(50_000), 'ADDRESS')]),
    )
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      // The bound alone is satisfied by the result-wide backstop whether or not THIS site caps
      // anything. A line cut off mid-sentence means the echo was left unbounded and the text after
      // it was lost.
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })
})

describe('stating what an amount means in whole tokens', () => {
  const caps = (value: string, scope: Attr = a('assetScope', 'native')) =>
    draft([scope, NUM('perTransactionMax', value)], 'native-v1')

  it('states the conversion for native ZTX without reading the chain', async () => {
    const describeUnit = vi.fn()
    const r = await policyPreflight(deps({ describeUnit }, NATIVE_V1), caps('1'))
    expect(text(r).interpretation).toMatch(/"perTransactionMax" is 1 in BASE units: 1 = 0\.000001 ZTX\. If you meant 1 ZTX, the value is 1000000\./)
    expect(describeUnit).not.toHaveBeenCalled()
  })

  it('shows a whole-unit value as a whole number of tokens', async () => {
    const r = await policyPreflight(deps({}, NATIVE_V1), caps('1000000'))
    expect(text(r).interpretation).toMatch(/1000000 = 1 ZTX/)
  })

  it('shows fractional amounts without trailing zeros', async () => {
    const r = await policyPreflight(deps({}, NATIVE_V1), caps('1500000'))
    expect(text(r).interpretation).toMatch(/1500000 = 1\.5 ZTX/)
  })

  it('reads a token\'s decimals through the dep, with the address it was given', async () => {
    const describeUnit = vi.fn(async () => ({ symbol: 'JMYR', decimals: 6 }))
    await policyPreflight(
      deps({ describeUnit }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', JMYR, 'ADDRESS'), NUM('perTransactionMax', '5')]),
    )
    expect(describeUnit).toHaveBeenCalledWith(JMYR)
  })

  it('scales by the token\'s own decimals, not by 6', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: async () => ({ symbol: 'TKN', decimals: 2 }) }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '150')]),
    )
    expect(text(r).interpretation).toMatch(/150 = 1\.5 TKN/)
    expect(text(r).interpretation).toMatch(/the value is 100\./)
  })

  it('says base units are whole tokens for a token with no decimals', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: async () => ({ symbol: 'TKN', decimals: 0 }) }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '150')]),
    )
    expect(text(r).interpretation).toMatch(/"perTransactionMax" is 150 TKN — this token has no decimals/)
  })

  it('covers every amount cap, one line each', async () => {
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft(
        [a('assetScope', 'native'), NUM('perTransactionMax', '1'), NUM('cumulativeMax', '2'), NUM('velocityCap', '3'), a('cumulativeWindow', '7d'), a('velocityWindow', '1h')],
        'native-v1',
      ),
    )
    const lines = r.interpretation.filter((l) => l.includes('BASE units'))
    expect(lines.map((l) => l.match(/"(\w+)"/)?.[1]).sort()).toEqual(['cumulativeMax', 'perTransactionMax', 'velocityCap'])
  })

  it('does not state a unit for a COUNT', async () => {
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft([a('assetScope', 'native'), NUM('maxTransactionCount', '5'), a('countWindow', '1d')], 'native-v1'),
    )
    expect(text(r).interpretation).not.toMatch(/BASE units/)
  })

  it('says it could not, rather than assuming a scale, when decimals cannot be read', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: async () => null }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '5')]),
    )
    expect(text(r).interpretation).not.toMatch(/BASE units: /)
    expect(text(r).notChecked).toMatch(/could not be worked out.*decimals could not be read.*do not assume a scale/i)
  })

  it('treats a THROWING reader as unreadable', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: async () => { throw new Error('node down') } }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '5')]),
    )
    expect(text(r).notChecked).toMatch(/could not be worked out/)
  })

  it('says it could not when no reader is wired at all', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: undefined }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '5')]),
    )
    expect(text(r).notChecked).toMatch(/could not be worked out/)
  })

  it('says nothing about units when the scope is unusable — the scope rules already refused it', async () => {
    const describeUnit = vi.fn()
    for (const scope of [a('assetScope', 'JMYR'), a('assetScope', '')]) {
      const r = await policyPreflight(deps({ describeUnit }, NATIVE_V1), draft([scope, NUM('perTransactionMax', '1')], 'native-v1'))
      expect(text(r).interpretation, scope.value).not.toMatch(/BASE units/)
    }
    const none = await policyPreflight(deps({ describeUnit }, NATIVE_V1), draft([NUM('perTransactionMax', '1')], 'native-v1'))
    expect(text(none).interpretation).not.toMatch(/BASE units/)
    expect(describeUnit).not.toHaveBeenCalled()
  })

  it('does not read the chain for a ztp20 draft with a malformed token address', async () => {
    const describeUnit = vi.fn()
    await policyPreflight(
      deps({ describeUnit }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', TYPO, 'ADDRESS'), NUM('perTransactionMax', '1')]),
    )
    expect(describeUnit).not.toHaveBeenCalled()
  })

  it('skips a value that is not a plain whole number, and an enormous one', async () => {
    for (const value of ['1.5', '-1', 'abc', '', '9'.repeat(78)]) {
      const r = await policyPreflight(deps({}, NATIVE_V1), caps(value))
      expect(text(r).interpretation, value).not.toMatch(/BASE units/)
    }
  })

  it('bounds what it echoes of a hostile symbol', async () => {
    const r = await policyPreflight(
      deps({ describeUnit: async () => ({ symbol: 'S'.repeat(50_000), decimals: 6 }) }),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', OTHER_TOKEN, 'ADDRESS'), NUM('perTransactionMax', '5')]),
    )
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      // The bound alone is satisfied by the result-wide backstop whether or not THIS site caps
      // anything. A line cut off mid-sentence means the echo was left unbounded and the text after
      // it was lost.
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })
})

describe('window format', () => {
  const withWindow = (value: string) =>
    draft([a('assetScope', 'native'), NUM('cumulativeMax', '1000000'), a('cumulativeWindow', value)], 'native-v1')
  const run = (value: string) => policyPreflight(deps({}, NATIVE_V1), withWindow(value))

  it('refuses a natural-language window, with the form to write', async () => {
    const r = await run('week')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"cumulativeWindow" is "week", which the write service refuses/)
    expect(text(r).blockers).toContain('write 7d')
  })

  it('refuses a bare number, and says why', async () => {
    // The shape the repo\'s own tests used for a window before this ticket: 43200.
    const r = await run('43200')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/bare number is refused because it would be read as milliseconds/)
  })

  it('refuses zero', async () => {
    const r = await run('0d')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/greater than zero/)
  })

  it('offers no corrected form for a value it cannot map exactly', async () => {
    const r = await run('fortnight')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).not.toMatch(/write \d/)
  })

  for (const ok of ['7d', '12h', '30m', '45s', 'P7D', 'PT12H', '30d']) {
    it(`accepts ${ok}`, async () => {
      const r = await run(ok)
      expect(r.blockers, ok).toEqual([])
      expect(r.ready, ok).toBe(true)
    })
  }

  it('checks every window attribute, not only the cumulative one', async () => {
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft(
        [a('assetScope', 'native'), NUM('velocityCap', '5'), a('velocityWindow', 'hourly'), NUM('maxTransactionCount', '5'), a('countWindow', '60')],
        'native-v1',
      ),
    )
    expect(text(r).blockers).toMatch(/"velocityWindow" is "hourly"/)
    expect(text(r).blockers).toMatch(/"countWindow" is "60"/)
  })

  it('says a window over 30d may be refused, without refusing it itself', async () => {
    const r = await run('31d')
    expect(r.blockers).toEqual([])
    expect(r.ready).toBe(true)
    expect(text(r).notChecked).toMatch(/"cumulativeWindow" is longer than 30d.*default retention/)
  })

  it('does not add the retention note to a window inside it', async () => {
    const r = await run('30d')
    expect(text(r).notChecked).not.toMatch(/longer than 30d/)
  })

  it('does not touch attributes whose name does not end in Window', async () => {
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft([a('assetScope', 'native'), NUM('perTransactionMax', '1000000'), a('x-windowNote', 'week')], 'native-v1'),
    )
    expect(text(r).blockers).not.toMatch(/write service refuses/)
  })

  it('keeps the window blocker when a flood of attribute faults would otherwise push it out', async () => {
    // Draft-level on purpose: attribute faults are as many as the caller sends.
    const junk = Array.from({ length: 150 }, (_, i) => a(`junk${i}`, '1'))
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft([a('assetScope', 'native'), NUM('cumulativeMax', '5'), a('cumulativeWindow', 'week'), ...junk], 'native-v1'),
    )
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"cumulativeWindow" is "week"/)
  })

  it('bounds what it echoes of a hostile window value', async () => {
    const r = await run('x'.repeat(50_000))
    expect(r.ready).toBe(false)
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      // The bound alone is satisfied by the result-wide backstop whether or not THIS site caps
      // anything. A line cut off mid-sentence means the echo was left unbounded and the text after
      // it was lost.
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })
})

// ── review findings ──────────────────────────────────────────────────────────────────

describe('a valid window says what period it is', () => {
  const withWindow = (value: string) =>
    draft([a('assetScope', 'native'), NUM('cumulativeMax', '1000000'), a('cumulativeWindow', value)], 'native-v1')
  const run = (value: string) => policyPreflight(deps({}, NATIVE_V1), withWindow(value))

  it('states 1M as ONE MINUTE — a monthly cap written that way would reset every minute', async () => {
    const r = await run('1M')
    expect(r.ready).toBe(true)
    expect(text(r).interpretation).toMatch(/"cumulativeWindow" is "1M", which is 1 minute\./)
  })

  it('states the period for the common forms', async () => {
    expect(text(await run('7d')).interpretation).toMatch(/is "7d", which is 7 days\./)
    expect(text(await run('12h')).interpretation).toMatch(/is "12h", which is 12 hours\./)
    expect(text(await run('P1DT12H')).interpretation).toMatch(/which is 1 day 12 hours\./)
  })

  it('says a nanosecond window is under a millisecond — effectively no window at all', async () => {
    const r = await run('5ns')
    expect(text(r).interpretation).toMatch(/which is less than 1 millisecond\./)
  })

  it('states the period for EVERY window attribute', async () => {
    const r = await policyPreflight(
      deps({}, NATIVE_V1),
      draft(
        [a('assetScope', 'native'), NUM('velocityCap', '1000000'), a('velocityWindow', '1h'), NUM('maxTransactionCount', '5'), a('countWindow', '1d')],
        'native-v1',
      ),
    )
    expect(text(r).interpretation).toMatch(/"velocityWindow" is "1h", which is 1 hour\./)
    expect(text(r).interpretation).toMatch(/"countWindow" is "1d", which is 1 day\./)
  })

  it('adds no period line for a window it refuses', async () => {
    const r = await run('week')
    expect(text(r).interpretation).not.toMatch(/"cumulativeWindow" is "week", which is/)
  })

  it('bounds the echoed value', async () => {
    const r = await run('9'.repeat(30) + 'ms')
    for (const line of [...r.blockers, ...r.interpretation, ...r.notChecked]) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
    }
  })
})

describe('window values the service would refuse for form', () => {
  const run = (value: string) =>
    policyPreflight(deps({}, NATIVE_V1), draft([a('assetScope', 'native'), NUM('cumulativeMax', '1000000'), a('cumulativeWindow', value)], 'native-v1'))

  it('refuses a padded value and says to remove the spaces', async () => {
    for (const padded of [' 7d', '7d ', ' 7d ']) {
      const r = await run(padded)
      expect(r.ready, JSON.stringify(padded)).toBe(false)
      expect(text(r).blockers).toMatch(/spaces around it — write it with none/)
    }
  })

  it('refuses a trailing T', async () => {
    const r = await run('P1DT')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/which the write service refuses/)
  })

  it('refuses a value too large to hold, and says so', async () => {
    const r = await run('99999999999999999999d')
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/longer than anything the service could retain/)
  })
})

describe('the symbol suppression is for tokenAddress ONLY', () => {
  // A template that declares some OTHER scalar ADDRESS attribute. Rule 4 only covers tokenAddress, so the
  // generic checksum advice must still reach every other address — even when its value is a registered symbol.
  const TEMPLATE_WITH_PAYOUT = {
    found: true,
    attributes: [
      { attributeName: 'assetScope', attributeType: 'STRING' },
      { attributeName: 'perTransactionMax', attributeType: 'NUMBER' },
      { attributeName: 'payoutAddress', attributeType: 'ADDRESS' },
    ],
  }

  it('still gives the checksum advice for a registered symbol in a different ADDRESS attribute', async () => {
    const r = await policyPreflight(
      deps({}, TEMPLATE_WITH_PAYOUT),
      draft([a('assetScope', 'native'), NUM('perTransactionMax', '1000000'), a('payoutAddress', 'JMYR', 'ADDRESS')], 'native-v1'),
    )
    expect(r.ready).toBe(false)
    expect(text(r).blockers).toMatch(/"payoutAddress" is declared ADDRESS but "JMYR" is not a valid Zetrix address/)
  })

  it('does not run the symbol rule on that attribute either, so the two never contradict each other', async () => {
    const r = await policyPreflight(
      deps({}, TEMPLATE_WITH_PAYOUT),
      draft([a('assetScope', 'native'), NUM('perTransactionMax', '1000000'), a('payoutAddress', 'JMYR', 'ADDRESS')], 'native-v1'),
    )
    expect(text(r).blockers).not.toMatch(/token symbol, not an address/)
  })

  it('still suppresses it for tokenAddress, where the symbol rule says what to write instead', async () => {
    const sym = await policyPreflight(deps(), draft([a('assetScope', 'ztp20'), a('tokenAddress', 'JMYR', 'ADDRESS')], 'ztp20-v1'))
    expect(text(sym).blockers).toMatch(/token symbol, not an address/)
    expect(text(sym).blockers).not.toMatch(/checksum/)
  })
})
