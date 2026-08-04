/**
 * `agentic-wallet-mcp export-credentials` — one deliberate way to back up this wallet.
 *
 * The wallet generates its own HSM password and never shows it (see hsm-password.ts). That
 * password is the ONLY thing that can authorize signing for the account: Wallet BE holds the
 * key but will not use it without the password. If the state directory is lost, funds are
 * stranded and any VC bound to the holder DID is orphaned.
 *
 * This is deliberately a CLI and NOT an MCP tool. An MCP tool returning the password would
 * put it into model context and the conversation transcript, which is exactly the exposure
 * the self-service design removes. Refusing to run without a TTY closes the obvious
 * workaround of piping it into a file an agent can then read — and the TTY check runs BEFORE
 * the account is read, so a non-interactive invocation never even loads the secret.
 */

export interface ExportDeps {
  getAccount: () => Promise<{ zetrixAddress: string; holderDid: string; hsmPassword: string } | null>
  isTty: boolean
  write: (s: string) => void
  writeErr: (s: string) => void
}

export async function exportCredentials(deps: ExportDeps): Promise<{ exitCode: number }> {
  if (!deps.isTty) {
    deps.writeErr(
      'agentic-wallet-mcp: export-credentials only runs in an interactive terminal, so the password ' +
        'cannot be piped into a file or a log. Run it directly in your shell.\n',
    )
    return { exitCode: 1 }
  }

  const account = await deps.getAccount()
  if (!account) {
    deps.writeErr(
      'agentic-wallet-mcp: no account has been created yet — start the wallet once to provision one, ' +
        'then run this again.\n',
    )
    return { exitCode: 1 }
  }

  deps.write(
    `\nZetrix Agentic Wallet — credentials for backup\n\n` +
      `  Address:      ${account.zetrixAddress}\n` +
      `  Holder DID:   ${account.holderDid}\n` +
      `  HSM password: ${account.hsmPassword}\n\n` +
      `Store these somewhere safe and private, such as a password manager.\n` +
      `The HSM password is the only thing that can authorize signing for this wallet. If you lose it\n` +
      `and lose this machine's wallet state, the account cannot be recovered and any funds in it are\n` +
      `permanently inaccessible.\n\n`,
  )
  return { exitCode: 0 }
}
