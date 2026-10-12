/**
 * Self-paid policy write (phase 2): the wallet builds the contract call itself, signs it through Wallet BE and submits it
 * directly, paying only the network gas in ZTX. No service fee and no call to ms-zetrix.
 *
 * The call is `PolicyRegistry.createOrUpdatePolicy`, made by the owner as a top-level transaction (the contract requires
 * `msg.sender === tx.initiator`). The Registry resolves the owner's Policy Contract, deploying it first for an owner who has none,
 * and forwards the write; the Policy Contract accepts it because the owner is the initiator. The contract does not compare
 * `updatedAtBlock` (a write replaces the policy wholesale), so staleness is checked by the caller against a fresh chain read just
 * before this is sent.
 *
 * Values go to the chain exactly as the contract reads them: a scalar attribute (STRING, NUMBER, ADDRESS) is a string, a list
 * attribute (STRING_LIST, NUMBER_LIST, ADDRESS_LIST) an array of strings. The wallet's tool surface carries a list as a JSON-array
 * string, so it is parsed here, strictly.
 *
 * Nothing in this module decides WHETHER to write: confirmation, the user's choice of gas payer, balance, existence and staleness
 * are all settled by the caller first. What it owns is building the call, and telling apart what happened to it, because the
 * advice differs: nothing was sent (safe to try again), or it may be on chain (never send twice).
 */
import { createHash } from 'node:crypto'
import { toPaymentPolicyError, boundedReason, type PaymentPolicyError } from '../policy-refusal.js'
import type { SelfPayMarker, SelfPayMarkerStore } from '../clients/self-pay-marker-store.js'
import type { TokenBalanceResult } from '../clients/token-balance-client.js'
import type { SelfPayDeps } from './policy-gas-choice.js'

/** The attribute types the Policy Contract understands, and the scalar each list is made of. */
const SCALAR_OF: Record<string, 'STRING' | 'NUMBER' | 'ADDRESS'> = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  ADDRESS: 'ADDRESS',
  STRING_LIST: 'STRING',
  NUMBER_LIST: 'NUMBER',
  ADDRESS_LIST: 'ADDRESS',
}

export type TypedValue = string | string[]

/**
 * How many ledgers past the current one a self-paid transaction may still be included in. It is set on the transaction itself
 * (`ceilLedgerSeq`), so after that ledger the node can never accept it: an outcome that never arrived is then certain, in bounded time.
 * Inclusion normally takes one or two ledgers; this leaves room for a slow node without leaving a send unresolved for long.
 */
export const SELF_PAY_CEIL_LEDGERS = 60

/** The same bounds the receipt store holds a verify record to: a policy with more than this is not one this wallet will send. */
export const MAX_ATTRIBUTES = 64
/** A list attribute is bounded too: it is read back and compared, and a runaway one is a mistake, not a policy. */
export const MAX_LIST_ENTRIES = 500

/** What became of a submitted transaction, read from the node by its hash. */
export type TxLookup =
  | { status: 'success' }
  /** Included and rejected by the contract: the gas is spent and nothing was written. */
  | { status: 'failed'; errorCode: number; errorDesc?: string }
  /** Not found yet, or the lookup itself failed. Says nothing either way. */
  | { status: 'unknown' }

export interface TypedAttribute {
  attributeName: string
  attributeType: string
  value: TypedValue
}

/** Everything one self-paid write needs, assembled by the caller from what it already validated. */
export interface SelfPayCall {
  operation: 'CREATE' | 'UPDATE'
  policyKey: string
  /** As the tool surface carries them: every value a string, a list a JSON-array string. */
  attributes: Array<{ attributeName: string; attributeType?: string; value: string }>
  validFromBlock: string
  validToBlock: string
  templateContractAddress: string
  templateId: string
  /** UPDATE only: the `updatedAtBlock` the caller read, which the chain must still hold when this is sent. */
  expectedUpdatedAtBlock?: string
}

export type BuiltCall = { ok: true; input: string; attributes: TypedAttribute[] } | { ok: false; reason: string }

/** A list written as a JSON-array string, read strictly: an array whose every entry is a string. Blank or `[]` is the empty list. */
function parseList(text: string): string[] | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed === '[]') return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) && parsed.every((e) => typeof e === 'string') ? (parsed as string[]) : undefined
  } catch {
    return undefined
  }
}

export function typeAttributes(
  attributes: SelfPayCall['attributes'],
): { ok: true; attributes: TypedAttribute[] } | { ok: false; reason: string } {
  const out: TypedAttribute[] = []
  const seen = new Set<string>()
  if (!Array.isArray(attributes) || attributes.length > MAX_ATTRIBUTES) {
    return { ok: false, reason: `a policy carries at most ${MAX_ATTRIBUTES} attributes` }
  }
  for (const a of attributes) {
    if (typeof a?.attributeName !== 'string' || a.attributeName === '') return { ok: false, reason: 'an attribute has no name' }
    if (seen.has(a.attributeName)) return { ok: false, reason: `the attribute "${a.attributeName}" is given twice` }
    seen.add(a.attributeName)
    const type = a.attributeType
    if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(SCALAR_OF, type)) {
      return {
        ok: false,
        reason:
          `the attribute "${a.attributeName}" has no attributeType the policy contract knows (${Object.keys(SCALAR_OF).join(', ')}); ` +
          `the chain checks every value against its declared type, so it is not guessed`,
      }
    }
    if (typeof a.value !== 'string') return { ok: false, reason: `the attribute "${a.attributeName}" has no text value` }
    if (type.endsWith('_LIST')) {
      const list = parseList(a.value)
      if (!list) return { ok: false, reason: `the attribute "${a.attributeName}" is a list and must be a JSON array of strings` }
      if (list.length > MAX_LIST_ENTRIES) {
        return { ok: false, reason: `the attribute "${a.attributeName}" has ${list.length} entries; a list carries at most ${MAX_LIST_ENTRIES}` }
      }
      out.push({ attributeName: a.attributeName, attributeType: type, value: list })
    } else {
      out.push({ attributeName: a.attributeName, attributeType: type, value: a.value })
    }
  }
  return { ok: true, attributes: out }
}

/** The contract input, byte for byte what the Registry's `createOrUpdatePolicy` reads. */
export function buildPolicyCall(call: SelfPayCall): BuiltCall {
  const typed = typeAttributes(call.attributes)
  if (!typed.ok) return typed
  return {
    ok: true,
    attributes: typed.attributes,
    input: JSON.stringify({
      method: 'createOrUpdatePolicy',
      params: {
        policyKey: call.policyKey,
        attributes: typed.attributes,
        validFromBlock: call.validFromBlock,
        validToBlock: call.validToBlock,
        templateContractAddress: call.templateContractAddress,
        templateId: call.templateId,
      },
    }),
  }
}

/** A value as the chain stores it, made comparable: a scalar as itself, a list as its JSON. */
export function comparable(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value) && value.every((e) => typeof e === 'string')) return JSON.stringify(value)
  return undefined
}

export function comparableTyped(value: TypedValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SelfPayChainDeps {
  /** The Policy Registry the call is made to. */
  registryAddress: string
  ownerAddress: string
  fetchNonce: (address: string) => Promise<string>
  /** The node's simulation of this exact call: a contract rejection arrives here as a thrown error, before anything is signed. */
  estimateFee: (p: {
    sourceAddress: string
    nonce: string
    operation: { type: string; data: Record<string, unknown> }
  }) => Promise<{ feeLimit: string; gasPrice: string }>
  buildBlob: (p: {
    sourceAddress: string
    nonce: string
    gasPrice: string
    feeLimit: string
    /** The last ledger the transaction can be included in. */
    ceilLedgerSeq?: string
    operations: Array<{ type: string; data: Record<string, unknown> }>
  }) => { blob: string }
  sign: (blob: string) => Promise<{ signBlob: string; publicKey: string }>
  /** Throws an error flagged `submitRejected` when the node answered and refused; any other throw means the answer never arrived. */
  submit: (p: { blob: string; signBlob: string; publicKey: string }) => Promise<{ hash: string }>
  queryNativeBalance: () => Promise<TokenBalanceResult>
  /** Looks one transaction up by its hash. Optional. */
  getTransaction?: (txHash: string) => Promise<TxLookup>
  /** The current ledger number as digits, or `undefined` when it cannot be read. A send is refused when it is not known (no expiry can be set). */
  currentLedger: () => Promise<string | undefined>
  /** The note kept for every send until its outcome is settled. */
  markers: SelfPayMarkerStore
  now?: () => Date
}

export type SelfPayExecResult =
  /** The node accepted the transaction. It is NOT yet a written policy: that is read back from the chain. */
  | { kind: 'submitted'; txHash: string; nonce: string; feeLimit: string; ceilLedgerSeq: string }
  /** (the fee limit it was signed with is the ceiling the balance was checked against) */
  /** Nothing was sent: the call could not be built, or the node refused to simulate or accept it. Safe to try again once fixed. */
  | { kind: 'rejected'; reason: string }
  /** Wallet BE refused to sign (spending policy) or could not complete its check. Nothing was signed or sent. */
  | { kind: 'refused'; refusal: PaymentPolicyError }
  /** Signing failed for another reason. Nothing was sent. */
  | { kind: 'sign_failed'; reason: string }
  /** The transaction was sent and the node's answer never arrived: it may be on chain. Never send again. */
  | { kind: 'unknown'; reason: string; nonce: string; txHash: string; ceilLedgerSeq: string }

function isSubmitRejection(e: unknown): boolean {
  return (e as { submitRejected?: unknown } | null)?.submitRejected === true
}

const POSITIVE_INT = /^[1-9]\d*$/

function operationFor(chain: SelfPayChainDeps, input: string) {
  // `gasAmount` is omitted on purpose: the node's HTTP proxy rejects a blob that sets it to '0' (see x402-zetrix-client BlobBuilder).
  return { type: 'contractInvokeByGas', data: { contractAddress: chain.registryAddress, input } }
}

export function createSelfPay(chain: SelfPayChainDeps): SelfPayDeps {
  return {
    async estimateGas(call) {
      const built = buildPolicyCall(call)
      if (!built.ok) return { error: built.reason }
      try {
        const nonce = await chain.fetchNonce(chain.ownerAddress)
        const fee = await chain.estimateFee({ sourceAddress: chain.ownerAddress, nonce, operation: operationFor(chain, built.input) })
        // The fee LIMIT: the most this transaction can burn, which is the safe side of an estimate.
        return { gasRaw: fee.feeLimit }
      } catch (e) {
        return { error: boundedReason(e) }
      }
    },
    queryNativeBalance: chain.queryNativeBalance,
    ...(chain.getTransaction ? { lookupTransaction: chain.getTransaction } : {}),
    pendingSend: (policyKey) => chain.markers.get(chain.ownerAddress, policyKey),
    clearSend: (policyKey, txHash) => chain.markers.remove(chain.ownerAddress, policyKey, txHash),
    currentLedger: chain.currentLedger,
    async execute(call, limit): Promise<SelfPayExecResult> {
      const built = buildPolicyCall(call)
      if (!built.ok) return { kind: 'rejected', reason: built.reason }
      const operation = operationFor(chain, built.input)
      // The ceiling is what the balance was checked against. Without a usable one nothing is signed: there would be no bound on the fee.
      if (typeof limit?.maxFeeRaw !== 'string' || !POSITIVE_INT.test(limit.maxFeeRaw)) {
        return { kind: 'rejected', reason: 'no usable fee ceiling was given, so the fee is not bounded' }
      }
      const ceiling = BigInt(limit.maxFeeRaw)

      let nonce: string
      let fee: { feeLimit: string; gasPrice: string }
      try {
        nonce = await chain.fetchNonce(chain.ownerAddress)
        // The node simulates the call here, so a contract rejection (a template mismatch, a bad value) costs nothing.
        fee = await chain.estimateFee({ sourceAddress: chain.ownerAddress, nonce, operation })
      } catch (e) {
        return { kind: 'rejected', reason: `the node would not accept this write: ${boundedReason(e)}` }
      }
      // The fee signed must be the fee that was checked. A fresh estimate that is malformed, or above the ceiling the balance
      // was checked against, is refused with nothing signed.
      if (typeof fee?.feeLimit !== 'string' || !POSITIVE_INT.test(fee.feeLimit) || typeof fee?.gasPrice !== 'string' || !POSITIVE_INT.test(fee.gasPrice)) {
        return { kind: 'rejected', reason: 'the node returned a fee that is not a positive whole number' }
      }
      if (BigInt(fee.feeLimit) > ceiling) {
        return {
          kind: 'rejected',
          reason: `the node now estimates a fee of ${fee.feeLimit}, above the ${limit.maxFeeRaw} this wallet checked its balance against`,
        }
      }

      // The transaction gets an expiry: after this ledger the node never accepts it, so a send whose answer never arrives is settled in
      // bounded time. Without a ledger number there is no expiry, and without one nothing is signed.
      let ceil: string
      try {
        const ledger = await chain.currentLedger()
        if (typeof ledger !== 'string' || !/^\d{1,18}$/.test(ledger)) throw new Error('the ledger number is not available')
        ceil = (BigInt(ledger) + BigInt(SELF_PAY_CEIL_LEDGERS)).toString()
      } catch (e) {
        return { kind: 'rejected', reason: `the ledger number could not be read, so the transaction could not be given an expiry: ${boundedReason(e)}` }
      }

      let blob: string
      try {
        // Signed with the CEILING, not the simulated figure: the balance was checked against it, so the margin allowed for is real.
        blob = chain.buildBlob({ sourceAddress: chain.ownerAddress, nonce, gasPrice: fee.gasPrice, feeLimit: ceiling.toString(), ceilLedgerSeq: ceil, operations: [operation] }).blob
      } catch (e) {
        return { kind: 'rejected', reason: `the transaction could not be built: ${boundedReason(e)}` }
      }

      let signed: { signBlob: string; publicKey: string }
      try {
        signed = await chain.sign(blob)
      } catch (e) {
        const refusal = toPaymentPolicyError(e)
        if (refusal) return { kind: 'refused', refusal }
        return { kind: 'sign_failed', reason: boundedReason(e) }
      }

      // The note is written BEFORE the submit: once the transaction may be on chain, a later call must be able to know that. If it cannot be
      // written, nothing is sent.
      const txHash = createHash('sha256').update(Buffer.from(blob, 'hex')).digest('hex')
      const marker: SelfPayMarker = {
        policyKey: call.policyKey,
        ownerAddress: chain.ownerAddress,
        operation: call.operation,
        nonce,
        txHash,
        ceilLedgerSeq: ceil,
        submittedAt: (chain.now?.() ?? new Date()).toISOString(),
      }
      try {
        await chain.markers.set(marker)
      } catch (e) {
        // The write can fail after the file is already in place (a directory fsync error): nothing is sent, so that note must not stay.
        try {
          await chain.markers.remove(chain.ownerAddress, call.policyKey, txHash)
        } catch {
          // Left behind, it only holds the key until it expires.
        }
        return { kind: 'rejected', reason: `the send could not be recorded, so nothing was sent: ${boundedReason(e)}` }
      }

      // Past this line the transaction may be on chain even if no answer comes back.
      try {
        const { hash } = await chain.submit({ blob, signBlob: signed.signBlob, publicKey: signed.publicKey })
        return { kind: 'submitted', txHash: hash, nonce, feeLimit: ceiling.toString(), ceilLedgerSeq: ceil }
      } catch (e) {
        if (isSubmitRejection(e)) {
          // The node answered and refused: nothing is on chain, so there is nothing to remember.
          try {
            await chain.markers.remove(chain.ownerAddress, call.policyKey, txHash)
          } catch {
            // A note that stays only costs a lookup on the next call.
          }
          return { kind: 'rejected', reason: `the node rejected the transaction: ${boundedReason(e)}` }
        }
        return { kind: 'unknown', reason: boundedReason(e), nonce, txHash, ceilLedgerSeq: ceil }
      }
    },
  }
}
