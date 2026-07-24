/**
 * WalletBeClient — HTTP client for the Zetrix Wallet BE HSM API.
 *
 * The holder Ed25519 key lives in the Wallet BE softHSM; all holder signing
 * (x401 holder-binding + x402 payment) routes through here. Open + password-gated
 * (the HSM password is the only auth — no token).
 *
 * Envelope: every endpoint returns HTTP 200 with `{ errorCode, message, data }`.
 * `errorCode: 0` = success; anything else is an application error (surface it).
 */

export class WalletBeError extends Error {
  errorCode?: number
  cause?: unknown
  constructor(message: string, errorCode?: number, cause?: unknown) {
    super(message)
    this.name = 'WalletBeError'
    this.errorCode = errorCode
    this.cause = cause
  }
}

export interface HsmSignResult {
  signBlob: string
  publicKey: string
}

export interface HsmAccount {
  zetrixAddress: string
  publicKeyHex: string
}

interface Envelope<T> {
  errorCode: number
  message?: string
  data?: T & { errorList?: string[] }
}

export class WalletBeClient {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  /** POST /wallet/hsm/sign-blob — sign a hex blob (x401 holder-binding, x402 payment). */
  signBlob(blobHex: string, address: string, password: string): Promise<HsmSignResult> {
    return this.post<HsmSignResult>('/wallet/hsm/sign-blob', { blob: blobHex, address, password })
  }

  /** POST /wallet/hsm/sign-message — sign a UTF-8 message. */
  signMessage(message: string, address: string, password: string): Promise<HsmSignResult> {
    return this.post<HsmSignResult>('/wallet/hsm/sign-message', { message, address, password })
  }

  /** POST /wallet/hsm/account/create — create the holder HSM account (onboarding). */
  createAccount(password: string, label?: string, purpose?: string): Promise<HsmAccount> {
    return this.post<HsmAccount>('/wallet/hsm/account/create', { password, label, purpose })
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      })
    } catch (e) {
      throw new WalletBeError(`Wallet BE ${path} request failed`, undefined, e)
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new WalletBeError(`Wallet BE ${path} HTTP ${res.status}: ${text}`)
    }
    const env = (await res.json()) as Envelope<T>
    if (env.errorCode !== 0) {
      const detail = env.data?.errorList?.length ? ` — ${env.data.errorList.join('; ')}` : ''
      const hint =
        env.errorCode === 1000026 && (path === '/wallet/hsm/sign-blob' || path === '/wallet/hsm/sign-message')
          ? ' — this usually means ZETRIX_ADDRESS isn\'t a provisioned HSM account on this Wallet BE yet (or HSM_PASSWORD is wrong). Run create_holder_account to create one, then update ZETRIX_ADDRESS/HSM_PASSWORD in your MCP config and restart (or omit ZETRIX_ADDRESS entirely and let the MCP create one automatically at startup).'
          : ''
      throw new WalletBeError(
        `Wallet BE ${path} errorCode ${env.errorCode}: ${env.message ?? 'error'}${detail}${hint}`,
        env.errorCode,
      )
    }
    return env.data as T
  }
}
