/**
 * `--config <path>` — a non-env configuration source.
 *
 * An OpenClaw plugin manifest cannot set environment variables (no `env` field, no
 * templating), so a plugin-hosted wallet needs some other way to receive the subscriber's
 * network and payment cap. The plugin's registration hook writes this file; the launcher
 * passes its path here.
 *
 * Two rules make this file safe to read, write and review:
 *  - It carries NO secret. `hsmPassword` is a hard error rather than a silently ignored
 *    key, so "is there a credential in this file?" is answerable from the schema alone.
 *  - An unknown key is a hard error too. A typo like `netwrok` would otherwise be silently
 *    dropped and the wallet would start on the wrong network.
 *
 * Values map to env-var names and are merged BELOW the real process env, so an explicit
 * env var always wins (see startup-env.ts).
 */

const KEY_TO_ENV: Record<string, string> = {
  network: 'ZETRIX_NETWORK',
  zetrixAddress: 'ZETRIX_ADDRESS',
  holderDid: 'HOLDER_DID',
  maxPaymentAmount: 'MAX_PAYMENT_AMOUNT',
  stateDir: 'ZETRIX_WALLET_STATE_DIR',
  walletBeUrl: 'WALLET_BE_URL',
  mbiBaseUrl: 'MBI_BASE_URL',
}

const FORBIDDEN_KEYS = ['hsmPassword', 'password', 'HSM_PASSWORD']

function configPathFrom(argv: string[]): string | null {
  const inline = argv.find((a) => a.startsWith('--config='))
  if (inline) {
    const path = inline.slice('--config='.length)
    if (!path) throw new Error('agentic-wallet-mcp: --config requires a file path')
    return path
  }
  const i = argv.indexOf('--config')
  if (i === -1) return null
  const path = argv[i + 1]
  if (!path || path.startsWith('--')) throw new Error('agentic-wallet-mcp: --config requires a file path')
  return path
}

export function loadConfigFileEnv(argv: string[], readFile: (path: string) => string): NodeJS.ProcessEnv {
  const path = configPathFrom(argv)
  if (path === null) return {}

  let raw: string
  try {
    raw = readFile(path)
  } catch (e) {
    throw new Error(`agentic-wallet-mcp: cannot read config file ${path}: ${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`agentic-wallet-mcp: config file ${path} is not valid JSON: ${(e as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`agentic-wallet-mcp: config file ${path} must contain a JSON object`)
  }

  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(
        `agentic-wallet-mcp: config file ${path} must not contain a secret ("${key}") — the wallet generates ` +
          `and stores its own HSM password, so no credential belongs in this file.`,
      )
    }
    const envKey = KEY_TO_ENV[key]
    if (!envKey) {
      throw new Error(
        `agentic-wallet-mcp: unknown config key "${key}" in ${path} — allowed: ${Object.keys(KEY_TO_ENV).join(', ')}`,
      )
    }
    env[envKey] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return env
}
