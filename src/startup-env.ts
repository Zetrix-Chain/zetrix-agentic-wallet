/**
 * Startup configuration precedence, in one testable place.
 *
 * Four sources, highest first:
 *   1. process env         — an explicit operator/developer choice, always wins
 *   2. --config file       — how an OpenClaw plugin passes non-secret settings (see config-file.ts)
 *   3. local account store — the account this wallet created for itself on an earlier run
 *   4. generated           — a fresh HSM password, so a wallet with no configuration at all can start
 *
 * Env keeps top precedence specifically so adding sources 2-4 cannot change behaviour for an
 * existing `npx` user with an `env` block in their own `.mcp.json`. This logic was inline in
 * main(), which carries an `istanbul ignore next` and so was never covered; the precedence rules
 * are load-bearing enough to test directly.
 */

export interface StoredAccountEnv {
  zetrixAddress: string
  holderDid: string
  hsmPassword: string
}

export interface StartupEnvInput {
  processEnv: NodeJS.ProcessEnv
  storedAccount: StoredAccountEnv | null
  /** Values read from a `--config <path>` file, if one was given. */
  fileEnv?: NodeJS.ProcessEnv
  generatePassword: () => string
}

export interface StartupEnvResult {
  env: NodeJS.ProcessEnv
  /** True when a brand-new password was minted — the caller must persist and report it. */
  passwordGenerated: boolean
}

export function resolveStartupEnv(input: StartupEnvInput): StartupEnvResult {
  const env: NodeJS.ProcessEnv = { ...input.fileEnv, ...input.processEnv }

  const stored = input.storedAccount
  if (!env.ZETRIX_ADDRESS && stored) env.ZETRIX_ADDRESS = stored.zetrixAddress
  if (!env.HOLDER_DID && stored) env.HOLDER_DID = stored.holderDid
  if (!env.HSM_PASSWORD && stored) env.HSM_PASSWORD = stored.hsmPassword

  let passwordGenerated = false
  if (!env.HSM_PASSWORD) {
    env.HSM_PASSWORD = input.generatePassword()
    passwordGenerated = true
  }

  return { env, passwordGenerated }
}
