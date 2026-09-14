import { describe, it, expect } from 'vitest'
import { exportCredentials, type ExportDeps } from '../export-credentials'

const account = { zetrixAddress: 'ZTX3Holder', holderDid: 'did:zid:abc', hsmPassword: 'the-secret' }

function harness(overrides: Partial<ExportDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const deps: ExportDeps = {
    getAccount: () => Promise.resolve(account),
    isTty: true,
    write: (s: string) => out.push(s),
    writeErr: (s: string) => err.push(s),
    ...overrides,
  }
  return { deps, out, err }
}

describe('exportCredentials', () => {
  it('prints the address, DID and password on a TTY', async () => {
    const { deps, out } = harness()
    const { exitCode } = await exportCredentials(deps)
    expect(exitCode).toBe(0)
    const printed = out.join('')
    expect(printed).toContain('ZTX3Holder')
    expect(printed).toContain('did:zid:abc')
    expect(printed).toContain('the-secret')
  })

  it('refuses to print when stdout is not a TTY, so it cannot be piped into a log', async () => {
    const { deps, out, err } = harness({ isTty: false })
    const { exitCode } = await exportCredentials(deps)
    expect(exitCode).toBe(1)
    expect(out.join('')).not.toContain('the-secret')
    expect(err.join('')).toMatch(/interactive terminal/i)
  })

  it('explains what to do when no account exists yet', async () => {
    const { deps, err } = harness({ getAccount: () => Promise.resolve(null) })
    const { exitCode } = await exportCredentials(deps)
    expect(exitCode).toBe(1)
    expect(err.join('')).toMatch(/no account/i)
  })

  it('warns that the password is unrecoverable', async () => {
    const { deps, out } = harness()
    await exportCredentials(deps)
    expect(out.join('')).toMatch(/cannot be recovered|unrecoverable/i)
  })

  it('checks the TTY before reading the account, so a non-TTY run never loads the secret', async () => {
    let read = false
    const { deps } = harness({
      isTty: false,
      getAccount: () => {
        read = true
        return Promise.resolve(account)
      },
    })
    await exportCredentials(deps)
    expect(read).toBe(false)
  })
})
