import { describe, it, expect, vi } from 'vitest'
import { waitForActivation } from '../orchestrator/wait-for-activation'

describe('waitForActivation', () => {
  it('returns true as soon as a check reports activated:true', async () => {
    const check = vi.fn().mockResolvedValue({ address: 'ZTX3H', activated: true })
    const sleep = vi.fn().mockResolvedValue(undefined)

    const out = await waitForActivation(check, 'ZTX3H', sleep)

    expect(out).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('polls until activated:true on a later attempt, then stops', async () => {
    const check = vi.fn()
      .mockResolvedValueOnce({ address: 'ZTX3H', activated: false })
      .mockResolvedValueOnce({ address: 'ZTX3H', activated: false })
      .mockResolvedValueOnce({ address: 'ZTX3H', activated: true })
    const sleep = vi.fn().mockResolvedValue(undefined)

    const out = await waitForActivation(check, 'ZTX3H', sleep)

    expect(out).toBe(true)
    expect(check).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('returns false after exhausting all attempts without activation', async () => {
    const check = vi.fn().mockResolvedValue({ address: 'ZTX3H', activated: false })
    const sleep = vi.fn().mockResolvedValue(undefined)

    const out = await waitForActivation(check, 'ZTX3H', sleep)

    expect(out).toBe(false)
    expect(check).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('honors custom attempts/delayMs options', async () => {
    const check = vi.fn().mockResolvedValue({ address: 'ZTX3H', activated: false })
    const sleep = vi.fn().mockResolvedValue(undefined)

    const out = await waitForActivation(check, 'ZTX3H', sleep, { attempts: 2, delayMs: 500 })

    expect(out).toBe(false)
    expect(check).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(500)
  })

  it('propagates a rejection from check rather than treating it as not-yet-activated', async () => {
    const check = vi.fn().mockRejectedValue(new Error('HSM service error'))
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(waitForActivation(check, 'ZTX3H', sleep)).rejects.toThrow('HSM service error')
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('calls check with the given address', async () => {
    const check = vi.fn().mockResolvedValue({ address: 'ZTX3H', activated: true })
    const sleep = vi.fn().mockResolvedValue(undefined)

    await waitForActivation(check, 'ZTX3H', sleep)

    expect(check).toHaveBeenCalledWith('ZTX3H')
  })
})
