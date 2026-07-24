/**
 * createHolderAccount — holder HSM onboarding (lazy-create).
 *
 * `POST /wallet/hsm/account/create` mints a *brand-new* keypair — it does not take an
 * address, so this can't "provision" a pre-chosen `ZETRIX_ADDRESS`. Before minting, this
 * always checks whether an account already exists for this session (`getExistingAccount` —
 * env-configured or auto-created at startup) and, if so, returns that instead of creating —
 * the caller must pass `confirmNew: true` to mint a new one anyway, so the human gets to
 * choose between keeping the existing account or replacing it.
 *
 * A freshly created account — address, DID, AND the password the caller just supplied — is
 * saved via `saveAccount` to this MCP's own local account store (see
 * `clients/account-store.ts`), so both are picked up automatically on the next restart with
 * no manual config edit. We still can't write the *host's* MCP config file ourselves — the
 * stdio spawn doesn't reliably tell us its path, and some clients keep every server's config
 * in one shared file — so an explicit `ZETRIX_ADDRESS`/`HSM_PASSWORD` set via env still
 * overrides the saved account; the returned message tells the caller to update/remove those
 * too if that's how their config is set up.
 *
 * Wallet BE's `publicKeyHex` format for a freshly created account may be either raw
 * 32-byte hex or Zetrix's `b001<raw>...<checksum>` encoded form — `deriveHolderDid`
 * handles both.
 */

export type CreateAccount = (password: string, label?: string, purpose?: string) => Promise<{ zetrixAddress: string; publicKeyHex: string }>

export interface ExistingAccount {
  zetrixAddress: string
  holderDid: string
}

export interface CreateHolderAccountDeps {
  create: CreateAccount
  /** The account already active for this session, if any — env-configured or auto-created at startup. */
  getExistingAccount: () => Promise<ExistingAccount | null>
  /** Persists a freshly minted account (address, DID, AND its password) locally so it's reused automatically on the next restart. */
  saveAccount: (account: ExistingAccount & { hsmPassword: string; label?: string; purpose?: string }) => Promise<void>
}

export interface CreateHolderAccountInput {
  password: string
  label?: string
  purpose?: string
  /** Required to mint a new account when one already exists for this session. */
  confirmNew?: boolean
}

export interface CreateHolderAccountResult {
  created: boolean
  /** True when an account already existed for this session (whether or not a new one was minted). */
  alreadyExists: boolean
  /** The pre-existing account, present only when `alreadyExists && !created`. */
  existing?: ExistingAccount
  zetrixAddress?: string
  holderDid?: string
  publicKeyHex?: string
  message: string
}

/** `did:zid:<raw 32-byte pubkey hex>` — accepts either the raw 64-hex-char key or Zetrix's `b001<raw>4-byte-checksum` (76-hex-char) encoded form. */
export function deriveHolderDid(publicKeyHex: string): string {
  const hex = publicKeyHex.trim()
  if (hex.length === 64) return `did:zid:${hex}`
  if (hex.length === 76 && hex.slice(0, 4).toLowerCase() === 'b001') return `did:zid:${hex.slice(4, 68)}`
  throw new Error(`onboard: unrecognized public key hex format (length ${hex.length})`)
}

export async function createHolderAccount(deps: CreateHolderAccountDeps, input: CreateHolderAccountInput): Promise<CreateHolderAccountResult> {
  const existing = await deps.getExistingAccount()

  if (existing && !input.confirmNew) {
    return {
      created: false,
      alreadyExists: true,
      existing,
      message:
        `An account already exists for this wallet (zetrixAddress=${existing.zetrixAddress}, holderDid=${existing.holderDid}). ` +
        `Ask the user whether to keep using it or create a brand-new one — call create_holder_account again with ` +
        `confirmNew:true to mint a new account.`,
    }
  }

  const { zetrixAddress, publicKeyHex } = await deps.create(input.password, input.label, input.purpose)
  const holderDid = deriveHolderDid(publicKeyHex)
  await deps.saveAccount({ zetrixAddress, holderDid, hsmPassword: input.password, label: input.label, purpose: input.purpose })

  const message =
    `New holder HSM account created — address, DID, and password saved to the wallet's local account store. ` +
    `Both will be used automatically on the next server restart; no manual config edit needed. If your MCP ` +
    `config also sets ZETRIX_ADDRESS/HSM_PASSWORD via environment variables, update or remove those too: an ` +
    `explicit env ZETRIX_ADDRESS/HSM_PASSWORD always takes precedence over the saved account. ` +
    `ZETRIX_ADDRESS=${zetrixAddress} (HOLDER_DID=${holderDid} is optional — it re-derives automatically).`

  return { created: true, alreadyExists: Boolean(existing), zetrixAddress, holderDid, publicKeyHex, message }
}
