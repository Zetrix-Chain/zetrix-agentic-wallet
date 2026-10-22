/**
 * Which saved wallet account belongs to the network the wallet was started for.
 *
 * The wallet used to keep a single `account.json` with no network on it. Switching the network
 * setting then reloaded the OTHER network's account, Wallet BE answered 1000026 ("not a provisioned
 * account"), and the process exited before it registered a single tool. Each network now has its own
 * file, `account.<network>.json`, and the file records the network it belongs to.
 *
 * An existing `account.json` carries no network, so it is placed by asking the Wallet BEs. It is only
 * ever COPIED to a network file, never moved or deleted: it holds the account's signing password,
 * which cannot be recovered.
 *
 * Two rules matter, and both exist because an account file may hold the only copy of a signing password:
 *
 *  1. This module never asks for a new account when it cannot be sure the old one belongs somewhere else.
 *     Wallet BE answers 1000026 both for an unprovisioned account and for an HSM hiccup, so only that exact
 *     code, from BOTH networks' point of view, lets a new account be created. Anything unclear stops the
 *     start with a message instead.
 *  2. It never replaces a file it has not read. A file it cannot read is a stop, not "no account"; a file
 *     that already holds a different account is a stop, not a place to write; and every new file is created
 *     exclusively, so two processes starting at once cannot overwrite each other.
 */

import { join } from 'node:path'
import {
  createAccountFileExclusive,
  createFsAccountStore,
  readAccountFile,
  type AccountRead,
  type AccountStore,
  type StoredAccount,
} from './clients/account-store.js'
import { WalletBeError } from './clients/wallet-be-client.js'

/** The file an account saved before accounts were kept per network lives in. */
export const LEGACY_ACCOUNT_FILE = 'account.json'

const KNOWN_NETWORKS = ['zetrix:testnet', 'zetrix:mainnet'] as const

/** Wallet BE's answer for an account it has no HSM key for. Matched on the number, never on the message. */
const NOT_PROVISIONED_ERROR_CODE = 1000026

/** How long to wait for a Wallet BE to answer an ownership check before calling it "unknown". */
const PROBE_TIMEOUT_MS = 15_000

export function networkSlug(network: string): string {
  return network.replace(/^zetrix:/, '').replace(/[^A-Za-z0-9_-]/g, '-')
}

export function accountFileName(network: string): string {
  return `account.${networkSlug(network)}.json`
}

/** The network a saved account is most likely to belong to if it is not this one. */
export function otherNetwork(network: string): string | undefined {
  if (network === 'zetrix:testnet') return 'zetrix:mainnet'
  if (network === 'zetrix:mainnet') return 'zetrix:testnet'
  return undefined
}

export interface AccountFiles {
  read(fileName: string): Promise<AccountRead>
  /** Writes the file. If it already holds a different account, the old content is kept beside it. */
  write(fileName: string, account: StoredAccount): Promise<void>
  /** Creates the file only if it does not exist. False when it already did. */
  createExclusive(fileName: string, account: StoredAccount): Promise<boolean>
}

export function createAccountFiles(stateDir: string): AccountFiles {
  const path = (fileName: string) => join(stateDir, fileName)
  return {
    read: (fileName) => readAccountFile(path(fileName)),
    write: (fileName, account) => createFsAccountStore(path(fileName)).set(account),
    createExclusive: (fileName, account) => createAccountFileExclusive(path(fileName), account),
  }
}

/** The account store the running wallet uses: this network's file only. */
export function createNetworkAccountStore(files: AccountFiles, network: string): AccountStore {
  const fileName = accountFileName(network)
  return {
    get: async () => {
      const read = await files.read(fileName)
      return read.kind === 'ok' ? read.account : null
    },
    set: (account) => files.write(fileName, { ...account, network }),
  }
}

export interface ExportableAccount {
  account: StoredAccount
  fileName: string
  /** True when it came from an old `account.json`, which records no network. */
  legacy: boolean
}

/** For `export-credentials`: the configured network's account, else an old `account.json`. */
export async function readAccountForExport(files: AccountFiles, network: string): Promise<ExportableAccount | null> {
  const own = await files.read(accountFileName(network))
  if (own.kind === 'ok') return { account: own.account, fileName: accountFileName(network), legacy: false }
  const legacy = await files.read(LEGACY_ACCOUNT_FILE)
  return legacy.kind === 'ok' ? { account: legacy.account, fileName: LEGACY_ACCOUNT_FILE, legacy: true } : null
}

export type Ownership = 'owns' | 'not_provisioned' | 'unknown'

/**
 * Whether a Wallet BE has an HSM key for this account, by asking it to sign the account's own address.
 * Only error 1000026 means "no". Every other failure, and a Wallet BE that does not answer in time, is
 * "unknown", so an outage is never read as "not mine" and a stalled Wallet BE cannot stall the start.
 */
export async function probeOwnership(
  signMessage: (message: string, address: string, password: string) => Promise<unknown>,
  account: StoredAccount,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<Ownership> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'unknown'>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs)
  })
  const ask = signMessage(account.zetrixAddress, account.zetrixAddress, account.hsmPassword).then(
    (): Ownership => 'owns',
    (err: unknown): Ownership =>
      err instanceof WalletBeError && err.errorCode === NOT_PROVISIONED_ERROR_CODE ? 'not_provisioned' : 'unknown',
  )
  try {
    return await Promise.race([ask, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class AccountOwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountOwnershipError'
  }
}

export interface ResolveAccountDeps {
  files: AccountFiles
  /** Ask the Wallet BE of `network` whether it knows this account. */
  probe: (network: string, account: StoredAccount) => Promise<Ownership>
  log?: (message: string) => void
}

export type AccountResolution =
  | { kind: 'saved'; account: StoredAccount; fileName: string; source: 'network' | 'adopted' }
  | { kind: 'none' }

/** The account a file holds, nothing if it is absent, and a stop if it is there but cannot be read. */
async function readOrStop(files: AccountFiles, fileName: string): Promise<StoredAccount | null> {
  const read = await files.read(fileName)
  if (read.kind === 'ok') return read.account
  if (read.kind === 'absent') return null
  throw new AccountOwnershipError(
    `The saved wallet account file ${fileName} could not be read (${read.reason}). It may still hold the only copy of an ` +
      `account's signing password, so nothing was changed and no new account was created. Fix the file, or move it aside ` +
      `yourself (keep a copy), and restart.`,
  )
}

export async function resolveNetworkAccount(deps: ResolveAccountDeps, network: string): Promise<AccountResolution> {
  const { files, probe } = deps
  const log = deps.log ?? (() => {})
  const fileName = accountFileName(network)

  const saved = await readOrStop(files, fileName)
  if (saved) {
    if (saved.network && saved.network !== network) {
      throw new AccountOwnershipError(
        `${fileName} says its account (${saved.zetrixAddress}) belongs to ${saved.network}, not ${network}. Nothing was changed. ` +
          `Move the file to ${accountFileName(saved.network)} if that is right, and restart.`,
      )
    }
    return { kind: 'saved', account: saved, fileName, source: 'network' }
  }

  const legacy = await readOrStop(files, LEGACY_ACCOUNT_FILE)
  if (!legacy) return { kind: 'none' }

  // An old account that a network file already holds has been placed; it is not this network's.
  for (const known of KNOWN_NETWORKS) {
    const placed = await readOrStop(files, accountFileName(known))
    if (placed && placed.zetrixAddress === legacy.zetrixAddress) return { kind: 'none' }
  }

  const here = await probe(network, legacy)
  if (here === 'owns') {
    const placed: StoredAccount = { ...legacy, network }
    if (!(await files.createExclusive(fileName, placed))) {
      // Another process placed an account here between the read and the write. Use what it left.
      const raced = await readOrStop(files, fileName)
      if (raced) return { kind: 'saved', account: raced, fileName, source: 'network' }
      throw new AccountOwnershipError(`${fileName} appeared while it was being created and then disappeared. Nothing was changed; restart.`)
    }
    log(`agentic-wallet-mcp: the saved account ${legacy.zetrixAddress} belongs to ${network}; it is now kept in ${fileName} (${LEGACY_ACCOUNT_FILE} is left as it was).\n`)
    return { kind: 'saved', account: placed, fileName, source: 'adopted' }
  }

  const other = otherNetwork(network)
  const there = here === 'not_provisioned' && other ? await probe(other, legacy) : undefined
  if (here === 'not_provisioned' && other && there === 'owns') {
    const otherFile = accountFileName(other)
    // Never write where a different account already is: that file may hold the only copy of its password.
    const occupant = await readOrStop(files, otherFile)
    if (occupant) throw occupiedError(legacy.zetrixAddress, occupant.zetrixAddress, other, otherFile)
    if (!(await files.createExclusive(otherFile, { ...legacy, network: other }))) {
      const racer = await readOrStop(files, otherFile)
      throw occupiedError(legacy.zetrixAddress, racer?.zetrixAddress ?? '(unreadable)', other, otherFile)
    }
    log(`agentic-wallet-mcp: the saved account ${legacy.zetrixAddress} belongs to ${other}, not ${network}; it is now kept in ${otherFile} (${LEGACY_ACCOUNT_FILE} is left as it was). A new account will be created for ${network}.\n`)
    return { kind: 'none' }
  }

  throw new AccountOwnershipError(describeUnplaced(legacy.zetrixAddress, network, other, here, there))
}

function occupiedError(legacyAddress: string, occupantAddress: string, network: string, file: string): AccountOwnershipError {
  return new AccountOwnershipError(
    `The saved account ${legacyAddress} (in ${LEGACY_ACCOUNT_FILE}) belongs to ${network}, but ${file} already holds a different ` +
      `account (${occupantAddress}). Nothing was written, because either file may hold the only copy of its account's signing ` +
      `password. Decide which account to keep on ${network}: move ${file} aside (keep a copy) to use the one in ${LEGACY_ACCOUNT_FILE}, ` +
      `or move ${LEGACY_ACCOUNT_FILE} aside to keep ${occupantAddress}, then restart.`,
  )
}

function describeUnplaced(
  address: string,
  network: string,
  other: string | undefined,
  here: Ownership,
  there: Ownership | undefined,
): string {
  const why =
    here === 'unknown'
      ? `the ${network} Wallet BE could not be checked just now`
      : other
        ? there === 'unknown'
          ? `it is not on the ${network} Wallet BE and the ${other} Wallet BE could not be checked just now`
          : `neither the ${network} nor the ${other} Wallet BE has it`
        : `the ${network} Wallet BE does not have it and there is no other network to try`
  const retry = here === 'unknown' || there === 'unknown' ? 'Check the connection and restart. ' : ''
  return (
    `The saved wallet account ${address} (in ${LEGACY_ACCOUNT_FILE}) could not be matched to a network: ${why}. ` +
    `Nothing was changed and no new account was created, because the saved one may still be the real wallet. ${retry}` +
    `If the account no longer exists on either network (a sandbox reset, say), move ${LEGACY_ACCOUNT_FILE} aside (keep a copy) and ` +
    `restart to start with a new account. If you know which network it belongs to, copy it to ` +
    `${accountFileName('zetrix:testnet')} or ${accountFileName('zetrix:mainnet')} yourself, keeping ${LEGACY_ACCOUNT_FILE}.`
  )
}

/**
 * The error to throw when starting with a known account fails. Wallet BE's own text for 1000026 says only that the
 * address "isn't a provisioned HSM account"; it does not say which network it asked, and a switched network is the
 * likeliest cause. Every other failure is passed through unchanged.
 */
export function explainHolderFailure(
  err: unknown,
  context: { address: string | undefined; network: string; walletBeUrl: string },
): Error {
  if (!(err instanceof WalletBeError) || err.errorCode !== NOT_PROVISIONED_ERROR_CODE) {
    return err instanceof Error ? err : new Error(String(err))
  }
  return new Error(
    `The wallet account ${context.address ?? '(unknown)'} is not provisioned on the ${context.network} Wallet BE (${context.walletBeUrl}). ` +
      `If ZETRIX_NETWORK was changed, this account belongs to the other network: change it back, or remove ZETRIX_ADDRESS so the wallet ` +
      `uses the account saved for ${context.network}. Wallet BE said: ${err.message}`,
    { cause: err },
  )
}
