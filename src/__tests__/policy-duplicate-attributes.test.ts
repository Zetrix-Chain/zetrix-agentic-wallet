/**
 * A repeated attribute name is refused (review finding APP-M01).
 *
 * Every scope and token rule reads the FIRST attribute with a given name. A repeat could therefore
 * carry a value those rules never see: `assetScope: "native"` followed by `assetScope: "JMYR"` was read
 * as ready — the exact false assurance the scope rules exist to stop, by another door. Which value the
 * write service takes is not knowable from the wallet, so a repeat is refused rather than guessed at.
 */
import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { policyPreflight, MAX_MESSAGE, type PolicyPreflightDeps } from '../orchestrator/policy-preflight'
import { NATIVE_V1, ZTP20_V1 } from './fixtures/real-policy-templates'
import { buildPolicyWriteDeps } from '../index'

const VALID_TOKEN = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'

type Attr = { attributeName: string; attributeType: string; value: string }
const a = (attributeName: string, value: string, attributeType = 'STRING'): Attr => ({ attributeName, attributeType, value })

const draft = (attributes: Attr[], policyKey = 'native-v1') => ({
  policyKey,
  templateId: 'a'.repeat(64),
  attributes,
  validFromBlock: '0',
  validToBlock: '0',
})

const readTemplate = vi.fn()
const deps = (template: unknown = NATIVE_V1): PolicyPreflightDeps => {
  readTemplate.mockReset()
  readTemplate.mockResolvedValue({ found: true, value: template })
  return { readTemplate, network: 'zetrix:testnet', isValidAddress: (x: string) => keypair.checkAddress(x) }
}
const joined = (r: { blockers: string[] }) => r.blockers.join(' | ')

describe('the failure the reviewer traced', () => {
  it('refuses assetScope "native" followed by assetScope "JMYR"', async () => {
    const r = await policyPreflight(
      deps(),
      draft([a('assetScope', 'native'), a('assetScope', 'JMYR'), a('perTransactionMax', '1000000', 'NUMBER')]),
    )
    expect(r.ready).toBe(false)
    expect(joined(r)).toMatch(/"assetScope" \(2 times\)/)
    expect(joined(r)).toMatch(/appear more than once/)
  })

  it('refuses the same pair in the other order too — the outcome no longer depends on order', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'JMYR'), a('assetScope', 'native')]))
    expect(r.ready).toBe(false)
    expect(joined(r)).toMatch(/"assetScope" \(2 times\)/)
  })

  it('refuses a valid tokenAddress followed by an empty one', async () => {
    const r = await policyPreflight(
      deps(ZTP20_V1),
      draft([a('assetScope', 'ztp20'), a('tokenAddress', VALID_TOKEN, 'ADDRESS'), a('tokenAddress', '', 'ADDRESS')], 'ztp20-v1'),
    )
    expect(r.ready).toBe(false)
    expect(joined(r)).toMatch(/"tokenAddress" \(2 times\)/)
  })

  it('refuses a repeated amount cap, which the unit and scope rules would otherwise read once', async () => {
    const r = await policyPreflight(
      deps(),
      draft([a('assetScope', 'native'), a('perTransactionMax', '1000000', 'NUMBER'), a('perTransactionMax', '1', 'NUMBER')]),
    )
    expect(r.ready).toBe(false)
    expect(joined(r)).toMatch(/"perTransactionMax" \(2 times\)/)
  })

  it('counts a name repeated three times as three', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'native'), a('assetScope', 'native'), a('assetScope', 'native')]))
    expect(joined(r)).toMatch(/"assetScope" \(3 times\)/)
  })
})

describe('what is NOT a repeat', () => {
  it('accepts every name once', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'native'), a('perTransactionMax', '1000000', 'NUMBER')]))
    expect(joined(r)).not.toMatch(/more than once/)
    expect(r.ready).toBe(true)
  })

  it('treats names as exact — a different case is a different name', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'native'), a('assetscope', 'native')]))
    expect(joined(r)).not.toMatch(/more than once/)
  })

  it('does not treat the same VALUE under different names as a repeat', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'native'), a('perTransactionMax', '1000000', 'NUMBER'), a('cumulativeMax', '1000000', 'NUMBER'), a('cumulativeWindow', '7d')]))
    expect(joined(r)).not.toMatch(/more than once/)
  })
})

describe('how it refuses', () => {
  it('is a structural refusal: the template is never read for a draft that cannot be judged', async () => {
    const d = deps()
    const r = await policyPreflight(d, draft([a('assetScope', 'native'), a('assetScope', 'JMYR')]))
    expect(r.ready).toBe(false)
    expect(readTemplate).not.toHaveBeenCalled()
  })

  it('says why, and does not claim to know which value the service would take', async () => {
    const r = await policyPreflight(deps(), draft([a('assetScope', 'native'), a('assetScope', 'JMYR')]))
    expect(joined(r)).toMatch(/not something this wallet can tell/)
    expect(joined(r)).toMatch(/rather than guessed at/)
  })

  it('names at most five repeated attributes, then counts the rest', async () => {
    const many = Array.from({ length: 12 }, (_, i) => [a(`name${i}`, '1'), a(`name${i}`, '2')]).flat()
    const r = await policyPreflight(deps(), draft(many))
    const blocker = joined(r)
    expect((blocker.match(/\(2 times\)/g) ?? []).length).toBe(5)
    expect(blocker).toMatch(/and 7 more/)
    expect(blocker.length).toBeLessThanOrEqual(MAX_MESSAGE)
  })

  it('bounds what it echoes of a hostile attribute name', async () => {
    const hostile = 'N'.repeat(50_000)
    const r = await policyPreflight(deps(), draft([a(hostile, '1'), a(hostile, '2')]))
    for (const line of r.blockers) {
      expect(line.length).toBeLessThanOrEqual(MAX_MESSAGE)
      expect(line.endsWith('…'), line.slice(0, 60)).toBe(false)
    }
  })

  it('still reports a malformed entry as malformed rather than as a repeat', async () => {
    const r = await policyPreflight(deps(), { ...draft([a('assetScope', 'native')]), attributes: [{ attributeName: 7 }, { attributeName: 7 }] as never })
    expect(joined(r)).toMatch(/must be an object with a string attributeName/)
    expect(joined(r)).not.toMatch(/more than once/)
  })
})

describe('write_policy runs the same check before it pays', () => {
  it('its pre-payment preflight refuses a repeated name, so the draft cannot reach a payment', async () => {
    const built = buildPolicyWriteDeps({
      policyWriteUrl: 'https://ms.test/api',
      network: 'zetrix:testnet',
      stateDir: '/tmp/x',
      ownerAddress: VALID_TOKEN,
      hsmPassword: 'p',
      pay: async () => 'header',
      gasPreference: 'sponsored',
      sleep: async () => undefined,
      policyTemplateAddress: 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5',
      chainQuery: async () => ({ errorCode: 0, result: { query_rets: [{ result: { value: '{}' } }] } }),
      // The later branches add required deps here; a cast keeps this test about the duplicate rule.
      queryBalance: async (token: string) => ({ token, error: 'query_failed' }),
      caps: undefined,
    } as never).policyWriteDeps!
    const r = await built.preflight(draft([a('assetScope', 'native'), a('assetScope', 'JMYR')]) as never)
    expect(r.ready).toBe(false)
    expect(r.blockers.join(' ')).toMatch(/more than once/)
  })
})
