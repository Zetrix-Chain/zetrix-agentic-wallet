/**
 * waitForActivation — bounded polling for on-chain account activation, used after a
 * create-account response reports activated:false. Wallet BE runs its own internal
 * background retry (2 attempts, 3s apart per the API doc); polling here spans slightly
 * longer than that window so the retry has a chance to land before giving up.
 */

export interface ActivationStatus {
  address: string
  activated: boolean
}

export type CheckActivationStatus = (address: string) => Promise<ActivationStatus>

export interface WaitForActivationOpts {
  attempts?: number
  delayMs?: number
}

export async function waitForActivation(
  check: CheckActivationStatus,
  address: string,
  sleep: (ms: number) => Promise<void>,
  opts: WaitForActivationOpts = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 3
  const delayMs = opts.delayMs ?? 3000
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs)
    const { activated } = await check(address)
    if (activated) return true
  }
  return false
}
