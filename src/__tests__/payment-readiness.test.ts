import { describe, it, expect } from 'vitest'
import { InsufficientBalanceError } from 'x402-zetrix-client'
import { toPaymentReadinessError, payWithReadinessCheck, PaymentReadinessError } from '../payment-readiness'

describe('toPaymentReadinessError', () => {
  it('maps a ZTX gas shortfall against a ZTP20 resource payment to reason "gas"', () => {
    const err = new InsufficientBalanceError('Insufficient ZTX for gas: required 100, available 10', '100', '10', 'ZTX')
    const out = toPaymentReadinessError(err, 'ZTX3token00000000000000000000000000')
    expect(out).toBeInstanceOf(PaymentReadinessError)
    expect(out?.shortfall).toEqual({ asset: 'ZTX', required: '100', available: '10', reason: 'gas' })
  })

  it('maps a ZTP20 token shortfall to reason "resource_payment"', () => {
    const err = new InsufficientBalanceError(
      'Insufficient ZTX3token00000000000000000000000000: required 5000000, available 1200000',
      '5000000', '1200000', 'ZTX3token00000000000000000000000000',
    )
    const out = toPaymentReadinessError(err, 'ZTX3token00000000000000000000000000')
    expect(out?.shortfall).toEqual({
      asset: 'ZTX3token00000000000000000000000000', required: '5000000', available: '1200000', reason: 'resource_payment',
    })
  })

  it('maps a ZTX shortfall for a native ZTX payment (amount+fee combined check) to reason "resource_payment"', () => {
    const err = new InsufficientBalanceError('Insufficient ZTX: required 100, available 10', '100', '10', 'ZTX')
    const out = toPaymentReadinessError(err, 'ZTX')
    expect(out?.shortfall.reason).toBe('resource_payment')
  })

  it('returns null for a non-InsufficientBalanceError', () => {
    expect(toPaymentReadinessError(new Error('network down'), 'ZTX')).toBeNull()
  })

  it('reports not_activated when the holder account is not yet on chain', () => {
    const err = new InsufficientBalanceError('Insufficient ZTX for gas: required 100, available 0', '100', '0', 'ZTX')
    const out = toPaymentReadinessError(err, 'ZTX3token00000000000000000000000000', false)
    expect(out?.shortfall.reason).toBe('not_activated')
    expect(out?.message).toMatch(/not been activated/i)
  })

  it('still reports gas when the account is known to be activated', () => {
    const err = new InsufficientBalanceError('Insufficient ZTX for gas: required 100, available 10', '100', '10', 'ZTX')
    expect(toPaymentReadinessError(err, 'ZTX3token00000000000000000000000000', true)?.shortfall.reason).toBe('gas')
  })

  it('treats an omitted activation flag as "not checked", preserving the old behaviour', () => {
    const err = new InsufficientBalanceError('Insufficient ZTX for gas: required 100, available 10', '100', '10', 'ZTX')
    expect(toPaymentReadinessError(err, 'ZTX3token00000000000000000000000000')?.shortfall.reason).toBe('gas')
  })
})

describe('payWithReadinessCheck', () => {
  it('returns the raw pay result unchanged on success', async () => {
    const rawPay = async () => 'X-PAYMENT-B64'
    expect(await payWithReadinessCheck('ZTX', rawPay)).toBe('X-PAYMENT-B64')
  })

  it('rethrows an InsufficientBalanceError as a PaymentReadinessError', async () => {
    const rawPay = async (): Promise<string> => {
      throw new InsufficientBalanceError('Insufficient JMYR: required 5000000, available 1200000', '5000000', '1200000', 'ZTX3token00000000000000000000000000')
    }
    await expect(payWithReadinessCheck('ZTX3token00000000000000000000000000', rawPay)).rejects.toBeInstanceOf(PaymentReadinessError)
  })

  it('rethrows any other error unchanged', async () => {
    const rawPay = async (): Promise<string> => {
      throw new Error('network down')
    }
    await expect(payWithReadinessCheck('ZTX', rawPay)).rejects.toThrow('network down')
  })
})
