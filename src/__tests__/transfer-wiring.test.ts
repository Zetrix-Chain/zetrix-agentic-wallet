import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { buildAddressValidator, buildTransferSafetyWiring } from '../index'
import { isSubmitRejection, transferToken } from '../orchestrator/transfer'
import { createTools } from '../mcp-tools'
import { ZTP20_V1 } from './fixtures/real-policy-templates'

/**
 * APP-M04 (round 2 of !110): the orchestrator's guards were thoroughly covered, but nothing pinned
 * what `main()` actually SUPPLIED to them. Two mutants survived the entire 1089-test suite:
 *
 *   isValidAddress: (address) => keypair.checkAddress(address)
 *     -> isValidAddress: (address) => address.length > 0          silently reverts APP-C01
 *
 *   throw Object.assign(new Error(...), { submitRejected: true })
 *     -> throw new Error(...)                                     silently reverts APP-M02
 *
 * Both are invisible to `transfer.test.ts` because every test there supplies its own real
 * collaborators — which is the right thing for an orchestrator test and exactly why it cannot see
 * a production wiring swap.
 *
 * Same defect class and same remedy as `payment-cap-wiring.test.ts`: the
 * pairing is moved out of `main()` into a function, so this file is the only place it exists.
 *
 * The validator is a DEFAULT PARAMETER rather than something `main()` passes. That matters for what
 * this test can promise: because there is no call site expressing it, exercising the default here
 * IS exercising what ships. A test that accepted the validator as an argument would only prove the
 * function delegates, and would leave the swap at the call site exactly as undetectable as before.
 */
describe('buildTransferSafetyWiring — isValidAddress', () => {
  const VALID = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
  const TYPO = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'

  /** No validator argument — the production default is the thing under test. */
  const wiring = () => buildTransferSafetyWiring(vi.fn())

  it('defaults to a real checksum validator, not a shape or length check', () => {
    // The mutant this kills: `(address) => address.length > 0`. Every string below is non-empty and
    // matches the address shape, so only a genuine checksum tells them apart.
    const { isValidAddress } = wiring()

    expect(isValidAddress(VALID)).toBe(true)
    expect(isValidAddress(TYPO)).toBe(false)
    expect(isValidAddress('ZTX3HhtuEyHEczW6jVNJL1sw8fG9Amv5ZkudF')).toBe(false)
    expect(isValidAddress('ZTXAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
    expect(isValidAddress('ZTX0OIl' + 'A'.repeat(30))).toBe(false)
    expect(isValidAddress(VALID + 'ZZZZZZZZZZZZ')).toBe(false)
  })

  it('agrees with the SDK validator itself, so the two can never drift apart', () => {
    const { isValidAddress } = wiring()
    for (const address of [VALID, TYPO, 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b', 'nonsense', '']) {
      expect(isValidAddress(address), address).toBe(keypair.checkAddress(address))
    }
  })

  it('rejects far more than a length check would accept', () => {
    // Stated as a property rather than a list: if a future default were permissive, this fails
    // without anyone needing to have predicted the exact permissive form.
    const { isValidAddress } = wiring()
    const shapeButInvalid = [TYPO, 'ZTXAAAAAAAAAAAAAAAAAAAAA', 'ZTX' + 'B'.repeat(40)]
    expect(shapeButInvalid.every((a) => a.length > 0)).toBe(true)
    expect(shapeButInvalid.some((a) => isValidAddress(a))).toBe(false)
  })

  it('is injectable for tests without that being how production gets it', () => {
    const fake = vi.fn().mockReturnValue(true)
    expect(buildTransferSafetyWiring(vi.fn(), fake).isValidAddress('anything')).toBe(true)
    expect(fake).toHaveBeenCalledWith('anything')
  })
})

describe('buildTransferSafetyWiring — submit', () => {
  const signed = { blob: 'deadbeef', signBlob: 'sig', publicKey: 'pk' }

  it('flags a non-zero errorCode with submitRejected, on a field', async () => {
    // The mutant this kills: dropping the Object.assign. Without the flag every node rejection is
    // reported as "may already be on chain — do NOT retry", which is a claim about funds broader
    // than what is known, and blocks a retry that is actually safe.
    const submitTransaction = vi.fn().mockResolvedValue({ errorCode: 151, errorDesc: 'INVALID_ARGUMENT' })
    const { submit } = buildTransferSafetyWiring(submitTransaction)

    await expect(submit(signed)).rejects.toThrow(/errorCode 151/)
    const thrown = await submit(signed).catch((e: unknown) => e)
    expect(isSubmitRejection(thrown)).toBe(true)
    expect((thrown as { submitRejected?: unknown }).submitRejected).toBe(true)
    expect((thrown as { errorCode?: unknown }).errorCode).toBe(151)
  })

  it('does NOT flag a missing hash — that one is genuinely indeterminate', async () => {
    // errorCode 0 means the node accepted it. No hash means we cannot say what happened, which is
    // the opposite of a rejection and must keep the unknown-outcome path.
    const { submit } = buildTransferSafetyWiring(vi.fn().mockResolvedValue({ errorCode: 0, result: {} }))
    const thrown = await submit(signed).catch((e: unknown) => e)
    expect(isSubmitRejection(thrown)).toBe(false)
  })

  it('passes the signature through in the shape the SDK expects', async () => {
    const submitTransaction = vi.fn().mockResolvedValue({ errorCode: 0, result: { hash: '0xabc' } })
    const { submit } = buildTransferSafetyWiring(submitTransaction)

    expect(await submit(signed)).toEqual({ hash: '0xabc' })
    expect(submitTransaction).toHaveBeenCalledWith({
      blob: 'deadbeef',
      signature: [{ signData: 'sig', publicKey: 'pk' }],
    })
  })
})

describe('the wired deps behave correctly end to end through the orchestrator', () => {
  // Composition check: the two halves above, driven through the real orchestrator rather than
  // asserted in isolation, so a wiring that type-checks but misbehaves still fails.
  const DEST = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
  const TYPO = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'
  const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

  function depsWith(submitTransaction: ReturnType<typeof vi.fn>) {
    return {
      sourceAddress: 'ZTX3dd6a3nbo6FutvgoknP6GEuQZZqG9WjCeJ',
      ...buildTransferSafetyWiring(submitTransaction),
      resolveTokenAddress: (s: string) => (s.toUpperCase() === 'JMYR' ? JMYR : undefined),
      fetchDecimals: vi.fn().mockResolvedValue(6),
      queryBalance: vi.fn().mockResolvedValue({ token: 'JMYR', balance: '473999900', decimals: 6 }),
      fetchNativeBalance: vi.fn().mockResolvedValue('50000000'),
      fetchNonce: vi.fn().mockResolvedValue('42'),
      buildOperation: vi.fn().mockReturnValue({ type: 'INVOKE_CONTRACT', data: {} }),
      estimateFee: vi.fn().mockResolvedValue({ feeLimit: '300000', gasPrice: '1000' }),
      buildBlob: vi.fn().mockReturnValue({ blob: 'deadbeef' }),
      sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }),
      assertWithinCap: vi.fn(),
    } as never
  }

  it('refuses a typo destination using the production validator', async () => {
    const submitTransaction = vi.fn()
    const out = await transferToken(depsWith(submitTransaction), {
      token: 'JMYR', to: TYPO, amountHuman: '1', confirm: true,
    })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/checksum/i)
    expect(submitTransaction).not.toHaveBeenCalled()
  })

  it('reports a node rejection as a clean failure, not an unknown outcome', async () => {
    const submitTransaction = vi.fn().mockResolvedValue({ errorCode: 151, errorDesc: 'BAD' })
    const out = await transferToken(depsWith(submitTransaction), {
      token: 'JMYR', to: DEST, amountHuman: '1', confirm: true,
    })
    expect(out.sent).toBe(false)
    expect(out.outcomeUnknown).toBeUndefined()
    expect(out.reason).toMatch(/nothing is on chain/i)
  })

  it('sends successfully when the node accepts', async () => {
    const submitTransaction = vi.fn().mockResolvedValue({ errorCode: 0, result: { hash: '0xtx' } })
    const out = await transferToken(depsWith(submitTransaction), {
      token: 'JMYR', to: DEST, amountHuman: '1', confirm: true,
    })
    expect(out.sent).toBe(true)
    expect(out.txHash).toBe('0xtx')
  })
})

// NOT "shared": policy_preflight reads ToolDeps.isValidAddress and transfer_token reads
// TransferDeps.isValidAddress, two separate objects with identical bodies. The whole point of
// round 4's APP-M02 was that calling them one gate is false.
describe('buildAddressValidator — policy_preflight\'s checksum gate', () => {
  /**
   * APP-M04. policy_preflight's ADDRESS gate was wired at the mcp-tools call site as
   * `deps.transferDeps?.isValidAddress`. Replacing that with `undefined` or `() => true` disabled
   * the entire gate and left 1204/1204 green, because every test supplied its own validator.
   *
   * Same remedy as the transfer wiring above: the validator is a DEFAULT inside this function, so
   * there is no call-site expression to mutate, and this test exercises what ships.
   */
  const VALID = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
  const TYPO = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'

  it('defaults to a real checksum validator, not a permissive stub', () => {
    const { isValidAddress } = buildAddressValidator()
    expect(isValidAddress(VALID)).toBe(true)
    expect(isValidAddress(TYPO)).toBe(false)
    expect(isValidAddress('ZTXAAAAAAAAAAAAAAAAAAAAA')).toBe(false)
  })

  it('agrees with the SDK validator, so the two cannot drift', () => {
    const { isValidAddress } = buildAddressValidator()
    for (const a of [VALID, TYPO, '', 'nonsense']) expect(isValidAddress(a), a).toBe(keypair.checkAddress(a))
  })

  it('reaches policy_preflight, so an ADDRESS attribute is actually gated', async () => {
    // The composition check: production wiring driven through the real handler. A stubbed or
    // absent validator at the call site fails here rather than passing silently.
    const tools = createTools({
      config: {
        holderDid: 'did:zid:t', zetrixAddress: 'ZTX3x', network: 'zetrix:testnet',
        policyRegistryAddress: 'ZTX3Reg', policyTemplateAddress: 'ZTX3Tpl',
      },
      ...buildAddressValidator(),
      chainQuery: vi.fn().mockResolvedValue({
        errorCode: 0,
        result: { query_rets: [{ result: { value: JSON.stringify(ZTP20_V1) } }] },
      }),
    } as never) as never as Record<string, (i?: unknown) => Promise<Record<string, unknown>>>

    const bad = await tools.policy_preflight({
      policyKey: 'ztp20-v1', templateId: 'a'.repeat(64),
      attributes: [{ attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: TYPO }],
      validFromBlock: '0', validToBlock: '0',
    })
    expect(bad.ready).toBe(false)
    expect((bad.blockers as string[]).join(' ')).toMatch(/checksum/i)

    const good = await tools.policy_preflight({
      policyKey: 'ztp20-v1', templateId: 'a'.repeat(64),
      // tokenAddress alone is a qualifier and would answer NO_ENFORCEABLE_CONSTRAINTS, so a cap rides with it.
      attributes: [
        { attributeName: 'assetScope', attributeType: 'STRING', value: 'ztp20' },
        { attributeName: 'tokenAddress', attributeType: 'ADDRESS', value: VALID },
        { attributeName: 'perTransactionMax', attributeType: 'NUMBER', value: '1000000' },
      ],
      validFromBlock: '0', validToBlock: '0',
    })
    expect(good.ready).toBe(true)
  })
})
