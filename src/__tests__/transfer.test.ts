import { describe, it, expect, vi } from 'vitest'
import { keypair } from 'zetrix-encryption-nodejs'
import { isPolicyRefusal, isSubmitRejection, transferToken } from '../orchestrator/transfer'

const SOURCE = 'ZTX3dd6a3nbo6FutvgoknP6GEuQZZqG9WjCeJ'
const DEST = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudF'
const JMYR = 'ZTX3WeinXtt28YMyr4vUZ14ddTgEMGeuc1e6b'

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    sourceAddress: SOURCE,
    // The real checksum validator, not a stub: these fixture addresses are genuine, and a stub
    // returning true would let the very typo APP-C01 is about sail through the suite.
    isValidAddress: (a: string) => keypair.checkAddress(a),
    // Registry stand-in: JMYR is registered on this network, nothing else is.
    resolveTokenAddress: (symbol: string) => (symbol.toUpperCase() === 'JMYR' ? JMYR : undefined),
    fetchDecimals: vi.fn().mockResolvedValue(6),
    queryBalance: vi.fn().mockResolvedValue({ token: 'JMYR', balance: '473999900', decimals: 6 }),
    fetchNativeBalance: vi.fn().mockResolvedValue('50000000'),
    fetchNonce: vi.fn().mockResolvedValue('42'),
    buildOperation: vi.fn().mockReturnValue({ type: 'INVOKE_CONTRACT', data: {} }),
    estimateFee: vi.fn().mockResolvedValue({ feeLimit: '300000', gasPrice: '1000' }),
    buildBlob: vi.fn().mockReturnValue({ blob: 'deadbeef' }),
    sign: vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'pk' }),
    submit: vi.fn().mockResolvedValue({ hash: '0xtxhash' }),
    assertWithinCap: vi.fn(),
    ...over,
  }
}

const ok = { token: 'JMYR', to: DEST, amountHuman: '1', confirm: true }

describe('transferToken — token resolution', () => {
  it('resolves a registered symbol from the token list without asking for an address', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(true)
    expect(out.asset).toBe(JMYR)
    expect(out.token).toBe('JMYR')
    expect(deps.buildOperation).toHaveBeenCalledWith(JMYR, DEST, '1000000', SOURCE)
  })

  it('treats ZTX as the native coin, not a contract', async () => {
    const deps = makeDeps({ queryBalance: vi.fn().mockResolvedValue({ token: 'ZTX', balance: '50000000', decimals: 6 }) })
    const out = await transferToken(deps, { ...ok, token: 'ztx' })
    expect(out.asset).toBe('ZTX')
    expect(out.token).toBe('ZTX')
    expect(deps.fetchDecimals).not.toHaveBeenCalled()
    expect(deps.buildOperation).toHaveBeenCalledWith('ZTX', DEST, '1000000', SOURCE)
  })

  it('accepts a raw contract address directly for a token that is not in the list', async () => {
    // A REAL checksummed address. The made-up one this used to carry is now correctly rejected
    // by the checksum gate — which is the gate proving itself on our own fixture (APP-C01).
    const other = 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ5'
    const deps = makeDeps({ queryBalance: vi.fn().mockResolvedValue({ token: other, balance: '9000000', decimals: 6 }) })
    const out = await transferToken(deps, { ...ok, token: other })
    expect(out.sent).toBe(true)
    expect(out.asset).toBe(other)
  })

  // The point of the registry: a known symbol needs no prompt. An unknown one must ASK rather than
  // guess, and must say so in a way the agent can act on without a failed transaction.
  it('asks for the contract address when the symbol is not in the list, without signing anything', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, token: 'WBTC' })
    expect(out.sent).toBe(false)
    expect(out.needsTokenAddress).toBe(true)
    expect(out.reason).toMatch(/WBTC/)
    expect(out.reason).toMatch(/contract address/i)
    expect(deps.sign).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
  })
})

describe('transferToken — amount handling', () => {
  it('converts a human amount using the token decimals read from chain', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, amountHuman: '1.5' })
    expect(out.amount).toBe('1500000')
    expect(out.amountHuman).toBe('1.5')
  })

  it('accepts a raw base-unit amount and reports its human form', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { token: 'JMYR', to: DEST, amount: '1000000', confirm: true })
    expect(out.amount).toBe('1000000')
    expect(out.amountHuman).toBe('1')
  })

  // The 1-vs-1000000 mistake. If the caller states both, they must agree.
  it('refuses when amount and amountHuman disagree, before signing', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, amount: '1', amountHuman: '1' })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/disagree|mismatch/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('accepts amount and amountHuman when they do agree', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, amount: '1000000', amountHuman: '1' })
    expect(out.sent).toBe(true)
  })

  it('refuses when neither amount nor amountHuman is given', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { token: 'JMYR', to: DEST, confirm: true })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/amount/i)
  })

  it('refuses a human amount more precise than the token decimals rather than truncating', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, amountHuman: '1.0000001' })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/decimal/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses to proceed when the token decimals cannot be read — the amount would be a guess', async () => {
    const deps = makeDeps({ fetchDecimals: vi.fn().mockResolvedValue(null) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/decimals/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })
})

describe('transferToken — guards', () => {
  it('refuses without confirm:true, reporting what it would have sent', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { token: 'JMYR', to: DEST, amountHuman: '1' })
    expect(out.sent).toBe(false)
    expect(out.needsConfirmation).toBe(true)
    expect(out.amount).toBe('1000000')
    expect(out.amountHuman).toBe('1')
    expect(deps.sign).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('dryRun reports the resolved transfer and fee without signing or submitting', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, dryRun: true })
    expect(out.sent).toBe(false)
    expect(out.dryRun).toBe(true)
    expect(out.fee).toEqual({ feeLimit: '300000', gasPrice: '1000' })
    expect(out.amount).toBe('1000000')
    expect(deps.sign).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('enforces the payment cap on the resolved base-unit amount', async () => {
    const assertWithinCap = vi.fn(() => {
      throw new Error('payment cap exceeded for JMYR')
    })
    const deps = makeDeps({ assertWithinCap })
    const out = await transferToken(deps, ok)
    expect(assertWithinCap).toHaveBeenCalledWith(JMYR, '1000000')
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/cap exceeded/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses when the token balance is short of the amount', async () => {
    const deps = makeDeps({ queryBalance: vi.fn().mockResolvedValue({ token: 'JMYR', balance: '500000', decimals: 6 }) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/insufficient/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses when the balance lookup failed rather than assuming there are funds', async () => {
    const deps = makeDeps({ queryBalance: vi.fn().mockResolvedValue({ token: 'JMYR', error: 'query_failed' }) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/balance/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses when native ZTX cannot cover the fee', async () => {
    const deps = makeDeps({ fetchNativeBalance: vi.fn().mockResolvedValue('1000') })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/fee|gas/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses a destination that is not a Zetrix address', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, to: 'not-an-address' })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/address/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it('refuses sending to self — almost always a mistake, and it burns a fee for nothing', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, to: SOURCE })
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/same address|itself|self/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })
})

describe('transferToken — submission', () => {
  it('runs nonce → fee → blob → HSM sign → submit and returns the tx hash', async () => {
    const deps = makeDeps()
    const out = await transferToken(deps, ok)
    expect(deps.fetchNonce).toHaveBeenCalledWith(SOURCE)
    expect(deps.buildBlob).toHaveBeenCalledWith(
      expect.objectContaining({ asset: JMYR, payTo: DEST, amount: '1000000', clientAddress: SOURCE, nonce: '42', feeLimit: '300000', gasPrice: '1000' }),
    )
    expect(deps.sign).toHaveBeenCalledWith('deadbeef')
    expect(deps.submit).toHaveBeenCalledWith({ blob: 'deadbeef', signBlob: 'sig', publicKey: 'pk' })
    expect(out).toMatchObject({ sent: true, txHash: '0xtxhash', nonce: '42', asset: JMYR, amount: '1000000', amountHuman: '1' })
  })

  // Same lesson as the MBI 4012 work: a submit whose outcome is unknown must not be retried
  // blindly, and the caller needs the nonce to check whether it landed.
  it('reports the nonce and an explicit do-not-retry when submission fails', async () => {
    const deps = makeDeps({ submit: vi.fn().mockRejectedValue(new Error('node timeout')) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.outcomeUnknown).toBe(true)
    expect(out.nonce).toBe('42')
    expect(out.reason).toMatch(/node timeout/)
    expect(out.reason).toMatch(/not.*retry/i)
  })

  it('does not treat a signing failure as an unknown outcome — nothing was submitted', async () => {
    const deps = makeDeps({ sign: vi.fn().mockRejectedValue(new Error('HSM rejected')) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.outcomeUnknown).toBeUndefined()
    expect(deps.submit).not.toHaveBeenCalled()
  })
})

describe('transferToken — a policy refusal is not a signing failure', () => {
  // Wallet BE is the policy enforcement point (2026-09-22 decision), so a denial arrives as a
  // failed sign. A decision and an outage need opposite advice — retry is pointless for one and
  // exactly right for the other — so they must not collapse into one message.

  it('reports a 403 from the signer as a policy denial, not a signing failure', async () => {
    const denial = Object.assign(new Error('policy denied: cumulative limit reached'), { status: 403 })
    const deps = makeDeps({ sign: vi.fn().mockRejectedValue(denial) })
    const out = await transferToken(deps, ok)

    expect(out.sent).toBe(false)
    expect(out.policyDenied).toBe(true)
    expect(out.reason).toMatch(/spending policy/i)
    // The agent must be told not to retry, and where to look.
    expect(out.reason).toMatch(/retrying will not help/i)
    expect(out.reason).toMatch(/get_my_policy/)
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('matches the FIELD and never the sentence (APP-M03)', () => {
    // The one mutant that survived the last review: replacing `status === 403` with a
    // `message.includes('policy')` check left the whole suite green, because every fixture
    // message happened to contain the word. The docstring calls prose-matching the thing this
    // must never do — the same mistake BT-2853 had to unpick — so it is pinned here.
    //
    // Wallet BE has not agreed a refusal contract yet, so these SHOULD all be false today. When
    // the real code lands, match on its field and these stay false.
    expect(isPolicyRefusal(new Error('policy denied: cumulative limit reached'))).toBe(false)
    expect(isPolicyRefusal(new Error('refused by spending policy'))).toBe(false)
    expect(isPolicyRefusal(new Error('POLICY_DENIED'))).toBe(false)
    expect(isPolicyRefusal(new Error('403 Forbidden'))).toBe(false)
    expect(isPolicyRefusal(null)).toBe(false)
    expect(isPolicyRefusal(undefined)).toBe(false)

    // Only a structured field counts.
    expect(isPolicyRefusal(Object.assign(new Error('anything at all'), { status: 403 }))).toBe(true)
    expect(isPolicyRefusal(Object.assign(new Error('anything at all'), { policyCode: 'X' }))).toBe(true)
    // A near-miss field must not count either.
    expect(isPolicyRefusal(Object.assign(new Error('x'), { status: 500 }))).toBe(false)
    expect(isPolicyRefusal(Object.assign(new Error('x'), { policyCode: '' }))).toBe(false)
  })

  it('recognises a structured policyCode as a denial too', async () => {
    const denial = Object.assign(new Error('refused'), { policyCode: 'CUMULATIVE_EXCEEDED' })
    const out = await transferToken(makeDeps({ sign: vi.fn().mockRejectedValue(denial) }), ok)
    expect(out.policyDenied).toBe(true)
  })

  it('still reports an ordinary signing failure as one, and does NOT call it a denial', async () => {
    // The safe direction: an unrecognised failure stays a signing failure. Mislabelling an outage
    // as a policy decision would tell the user to go edit a policy that is not the problem.
    const out = await transferToken(makeDeps({ sign: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }), ok)
    expect(out.sent).toBe(false)
    expect(out.policyDenied).toBeUndefined()
    expect(out.reason).toMatch(/signing failed/i)
  })

  it('never reports an unknown outcome for either, since nothing was submitted', async () => {
    for (const err of [Object.assign(new Error('denied'), { status: 403 }), new Error('ECONNREFUSED')]) {
      const out = await transferToken(makeDeps({ sign: vi.fn().mockRejectedValue(err) }), ok)
      expect(out.outcomeUnknown).toBeUndefined()
      expect(out.reason).toMatch(/nothing was submitted/i)
    }
  })
})

describe('APP-C01 — the destination checksum is the gate, not the shape', () => {
  // A shape regex accepts a one-character Base58 typo. On the ZTP20 branch `to` is an ordinary
  // string argument to the token contract and the chain applies no address validation to it, so a
  // token that does not check it itself credits an unspendable key. Unrecoverable.
  const VALID = DEST
  const TYPO_LAST = 'ZTX3HhtuFyHEczW6jVNJL1sw8fG9Amv5ZkudE'
  const TYPO_MID = 'ZTX3HhtuEyHEczW6jVNJL1sw8fG9Amv5ZkudF'

  it('the fixture addresses are genuinely checksummed, so these tests mean something', () => {
    expect(keypair.checkAddress(VALID)).toBe(true)
    expect(keypair.checkAddress(TYPO_LAST)).toBe(false)
    expect(keypair.checkAddress(TYPO_MID)).toBe(false)
  })

  it.each([
    ['last character changed', TYPO_LAST],
    ['middle character changed', TYPO_MID],
    ['right shape, pure junk', 'ZTXAAAAAAAAAAAAAAAAAAAAA'],
    ['non-Base58 characters (0 O I l)', 'ZTX0OIl' + 'A'.repeat(30)],
    ['valid address with trailing garbage', VALID + 'ZZZZZZZZZZZZ'],
  ])('refuses a destination whose checksum fails: %s', async (_label, bad) => {
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, to: bad })

    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/checksum/i)
    // Nothing may be signed or submitted — the whole point is that this never reaches the chain.
    expect(deps.sign).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.buildBlob).not.toHaveBeenCalled()
  })

  it('tells the agent to ask the user rather than correcting the address itself', async () => {
    // An agent that "fixes" a checksum by guessing a character sends funds somewhere else entirely.
    const out = await transferToken(makeDeps(), { ...ok, to: TYPO_LAST })
    expect(out.reason).toMatch(/ask the user/i)
    expect(out.reason).not.toMatch(/did you mean/i)
  })

  it('still accepts a genuinely valid destination', async () => {
    const out = await transferToken(makeDeps(), ok)
    expect(out.sent).toBe(true)
  })

  it('checksums a raw token contract address too, not just the destination', async () => {
    // A typo'd contract address aims the transfer at the wrong contract, or none.
    const deps = makeDeps()
    const out = await transferToken(deps, { ...ok, token: 'ZTX3WfTbuZwsLQDWe4f7mzrfULiNdDU84BLJ4' })
    expect(out.sent).toBe(false)
    expect(out.needsTokenAddress).toBe(true)
    expect(deps.sign).not.toHaveBeenCalled()
  })
})

describe('APP-M01 — an unreadable decimals value never converts an amount', () => {
  it('refuses when decimals could not be read', async () => {
    const deps = makeDeps({ fetchDecimals: vi.fn().mockResolvedValue(null) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(out.reason).toMatch(/decimals/i)
    expect(deps.sign).not.toHaveBeenCalled()
  })

  it.each([[-1], [1.5], [Number.NaN]])('refuses a nonsensical decimals value: %s', async (bad) => {
    // toHumanAmount("1500000", -1) returns a confidently wrong "1.5" rather than throwing, so a bad
    // value must never reach the conversion at all.
    const deps = makeDeps({ fetchDecimals: vi.fn().mockResolvedValue(bad) })
    const out = await transferToken(deps, ok)
    expect(out.sent).toBe(false)
    expect(deps.sign).not.toHaveBeenCalled()
  })
})

describe('APP-M02 — a rejected broadcast is not an unknown outcome', () => {
  it('reports a node rejection as a clean failure, with nothing on chain', async () => {
    // The node ANSWERED and refused. Calling that "may already be on chain" is a claim about funds
    // broader than what is known, and blocks a retry that is actually safe.
    const rejected = Object.assign(new Error('submit rejected with errorCode 151'), { submitRejected: true })
    const out = await transferToken(makeDeps({ submit: vi.fn().mockRejectedValue(rejected) }), ok)

    expect(out.sent).toBe(false)
    expect(out.outcomeUnknown).toBeUndefined()
    expect(out.reason).toMatch(/nothing is on chain/i)
    expect(out.reason).not.toMatch(/do NOT retry/i)
  })

  it('still reports a genuinely lost response as an unknown outcome', async () => {
    const out = await transferToken(makeDeps({ submit: vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) }), ok)
    expect(out.outcomeUnknown).toBe(true)
    expect(out.reason).toMatch(/do NOT retry/i)
  })

  it('matches the rejection on a FIELD, never on the message', async () => {
    // A rejection whose message says "rejected" but carries no flag is indeterminate as far as we
    // know, and must be treated as such. Prose is not a contract.
    const out = await transferToken(makeDeps({ submit: vi.fn().mockRejectedValue(new Error('submit rejected with errorCode 151')) }), ok)
    expect(out.outcomeUnknown).toBe(true)
    expect(isSubmitRejection(new Error('submit rejected'))).toBe(false)
    expect(isSubmitRejection(Object.assign(new Error('x'), { submitRejected: true }))).toBe(true)
  })
})

describe('APP-L01 — a zero amount is refused before anything is signed', () => {
  it.each([['0'], ['00'], ['-1'], ['1.5'], ['abc'], ['']])('refuses raw amount %s', async (bad) => {
    const deps = makeDeps()
    const out = await transferToken(deps, { token: 'JMYR', to: DEST, amount: bad, confirm: true })
    expect(out.sent).toBe(false)
    expect(deps.sign).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('still accepts a positive raw amount', async () => {
    const out = await transferToken(makeDeps(), { token: 'JMYR', to: DEST, amount: '1000000', confirm: true })
    expect(out.sent).toBe(true)
  })
})
