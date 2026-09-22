/**
 * PolicyReadClient — every on-chain policy read, behind the existing `sdk.contract.call` seam.
 *
 * One file rather than three, because the Registry, the Template contract and an owner's Policy
 * Contract are ONE external surface: same chain, same `optType: 2` transport, same envelope quirks,
 * and each is discovered through another. Splitting them would triplicate the fail-open and
 * envelope discipline across one or two functions each.
 *
 * Two behaviours of the deployed contracts shape this whole file, both verified live 2026-09-18:
 *
 * 1. A proxied Registry query returns ONE query_rets ENTRY PER CONTRACT HOP, with the Registry's
 *    own answer LAST. `contract-query-client.ts` reads `[0]`, which is correct today only because
 *    the Registry passes the inner reply through verbatim. We read the LAST entry, and a test pins
 *    it with a two-entry response whose entries differ, so a Registry that starts wrapping its
 *    inner reply breaks a test instead of silently returning the wrong object.
 *
 * 2. A MISSING `owner` returns `{found:false}` with errorCode 0 — the contract builds its storage
 *    key by concatenation (`'policyAddr_' + params.owner`), so an absent owner simply misses. A
 *    wallet bug that drops the owner is therefore byte-identical to "this user has no policy". We
 *    refuse an empty owner BEFORE issuing the call rather than let two different causes share one
 *    answer; without that guard the three-state result below is a lie.
 *
 * Every read is fail-open: an RPC error, a bad envelope or malformed JSON becomes an error STATE,
 * never a throw. Nothing in this file spends. But the error state is kept distinct from
 * `{found:false}` — "no policy" and "could not look it up" must never collapse into one answer, the
 * same discipline as a failed balance read reporting `{ error: 'query_failed' }` and never `0`.
 */

import type { ContractQuery } from './token-info-client.js'

/**
 * Three states, never two. `found:false` means the chain answered and there is nothing there;
 * `error` means we do not know, and the caller must not treat that as an absence.
 */
export type PolicyRead<T> =
  | { found: true; value: T }
  | { found: false }
  | { error: 'query_failed'; detail: string }

export type RawResult = { ok: true; value: unknown } | { ok: false; detail: string }

/** Issue one read-only contract query and parse its envelope. Never throws. */
export async function queryPolicy(
  contractAddress: string,
  method: string,
  params: Record<string, unknown>,
  query: ContractQuery,
): Promise<RawResult> {
  let response: Awaited<ReturnType<ContractQuery>>
  try {
    response = await query({
      contractAddress,
      input: JSON.stringify({ method, params }),
      optType: 2,
    })
  } catch (e) {
    return { ok: false, detail: `${method}: RPC call failed — ${(e as Error).message}` }
  }

  if (response?.errorCode !== 0) {
    return { ok: false, detail: `${method}: contract call failed with errorCode ${response?.errorCode}` }
  }

  const entries = response.result?.query_rets
  if (!entries || entries.length === 0) {
    return { ok: false, detail: `${method}: no query_rets returned` }
  }

  // LAST, not [0] — one entry per contract hop, the Registry's own answer last. See the header.
  const raw = entries[entries.length - 1]?.result?.value
  if (raw === undefined) {
    return { ok: false, detail: `${method}: no result value in the final query_rets entry` }
  }

  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false, detail: `${method}: result was not JSON — ${raw}` }
  }
}

/**
 * Resolve the owner's Policy Contract address.
 *
 * `{found:false}` means the owner has never deployed a policy, which is entirely normal — the
 * Factory creates the contract lazily on first write. It is NOT an error, and must not be reported
 * as one.
 */
export async function getPolicyContract(
  owner: string,
  registryAddress: string,
  query: ContractQuery,
): Promise<PolicyRead<string>> {
  if (typeof owner !== 'string' || owner.trim() === '') {
    return {
      error: 'query_failed',
      detail:
        'owner is required: the Registry answers an absent owner with {found:false}, which cannot ' +
        'be told apart from an owner who genuinely has no policy',
    }
  }

  const raw = await queryPolicy(registryAddress, 'getPolicyContract', { owner }, query)
  if (!raw.ok) return { error: 'query_failed', detail: raw.detail }

  const value = raw.value as { found?: unknown; address?: unknown } | null
  if (!value || value.found !== true) return { found: false }

  if (typeof value.address !== 'string' || value.address === '') {
    // Not a hit. Reporting this as found would hand the caller an empty address it would then
    // query, turning one malformed reply into a second, more confusing failure.
    return { error: 'query_failed', detail: 'getPolicyContract: found:true without a usable address' }
  }
  return { found: true, value: value.address }
}

/** A template as the chain returns it. Extra fields are preserved but not interpreted. */
export interface TemplateRecord {
  attributes?: Array<{ attributeName?: unknown; attributeType?: unknown }>
  /** Present only on `getTemplate`; `getTemplateById` omits it. */
  templateAttributeIds?: string[]
  [key: string]: unknown
}

function toTemplateRead(raw: RawResult): PolicyRead<TemplateRecord> {
  if (!raw.ok) return { error: 'query_failed', detail: raw.detail }
  const value = raw.value as (TemplateRecord & { found?: unknown }) | null
  if (!value || value.found !== true) return { found: false }
  return { found: true, value }
}

/**
 * Read a template by publisher + policyKey THROUGH the Registry.
 *
 * Preferred over the direct call even though both reach the same contract: the Registry already
 * holds the Template address it trusts, so going through it removes any chance of the wallet
 * reading a Template contract the Registry does not recognise. It also returns
 * `templateAttributeIds`, which `getTemplateById` omits and the write path may need.
 *
 * NOTE: a Registry with NO template contract configured ASSERTS rather than answering
 * `{found:false}`. That surfaces here as `query_failed`, which is the correct reading — it is a
 * misconfiguration of the Registry, not an absent template, and telling the user their template
 * does not exist would send them chasing the wrong problem.
 */
export async function getTemplateViaRegistry(
  publisher: string,
  policyKey: string,
  registryAddress: string,
  query: ContractQuery,
): Promise<PolicyRead<TemplateRecord>> {
  return toTemplateRead(await queryPolicy(registryAddress, 'getTemplate', { publisher, policyKey }, query))
}

/**
 * Read a template by id, DIRECTLY on the Template contract. The Registry's whole query surface is
 * getPolicyContract / getPolicy / getTemplate — `getTemplateById` is not proxied, so this one
 * lookup needs the Template address itself. This is the form that appears inside a deployed policy.
 */
export async function getTemplateById(
  templateId: string,
  templateAddress: string,
  query: ContractQuery,
): Promise<PolicyRead<TemplateRecord>> {
  return toTemplateRead(await queryPolicy(templateAddress, 'getTemplateById', { templateId }, query))
}

/**
 * The attribute names a template declares, mapped to their declared types.
 *
 * This is the ONLY vocabulary that means anything on chain. The contract validates nothing, so an
 * attribute name outside this map deploys perfectly cleanly and then enforces nothing at all —
 * which is why preflight lists these names back to the user when it rejects one.
 */
export function declaredVocabulary(template: TemplateRecord): Map<string, string> {
  const vocab = new Map<string, string>()
  for (const entry of template.attributes ?? []) {
    if (typeof entry?.attributeName === 'string' && entry.attributeName !== '') {
      vocab.set(entry.attributeName, typeof entry.attributeType === 'string' ? entry.attributeType : '')
    }
  }
  return vocab
}

/** A deployed policy as the chain returns it. Block fields are STRINGS; `updatedAtBlock` is a NUMBER. */
export interface PolicyRecord {
  attributes?: Array<{ attributeName?: unknown; attributeType?: unknown; value?: unknown }>
  validFromBlock?: unknown
  validToBlock?: unknown
  updatedAtBlock?: unknown
  [key: string]: unknown
}

/** Above this many policy keys, listing is slow enough to be worth warning about (2 + N calls). */
const KEY_COUNT_WARNING_THRESHOLD = 50

/**
 * List an owner's policy keys. Called on the OWNER'S Policy Contract — the Registry does not proxy
 * `listPolicyKeys`, which is what forces the two-step flow in {@link readOwnerPolicies}.
 */
export async function listPolicyKeys(policyAddress: string, query: ContractQuery): Promise<PolicyRead<string[]>> {
  const raw = await queryPolicy(policyAddress, 'listPolicyKeys', {}, query)
  if (!raw.ok) return { error: 'query_failed', detail: raw.detail }
  if (!Array.isArray(raw.value)) {
    return { error: 'query_failed', detail: 'listPolicyKeys: expected an array of key strings' }
  }
  return { found: true, value: raw.value.filter((k): k is string => typeof k === 'string') }
}

/**
 * Read one policy by key, on the owner's Policy Contract. No `owner` param — the contract IS the
 * owner's, so there is nothing to disambiguate.
 */
export async function getPolicyByKey(
  policyAddress: string,
  policyKey: string,
  query: ContractQuery,
): Promise<PolicyRead<PolicyRecord>> {
  const raw = await queryPolicy(policyAddress, 'getPolicy', { policyKey }, query)
  if (!raw.ok) return { error: 'query_failed', detail: raw.detail }
  const value = raw.value as (PolicyRecord & { found?: unknown }) | null
  if (!value || value.found !== true) return { found: false }
  return { found: true, value }
}

export interface OwnerPolicies {
  contract: PolicyRead<string>
  /** `null` when the contract was never resolved, so nothing was ever listed. */
  keys: PolicyRead<string[]> | null
  policies: Array<{ policyKey: string; result: PolicyRead<PolicyRecord> }>
  /** Set when the key count is large enough that the 2 + N read cost is worth stating. */
  warning?: string
}

/**
 * The full 2 + N read: resolve the owner's Policy Contract, list its keys, then read each policy.
 *
 * The two-step is forced — the Registry proxies neither `listPolicyKeys` nor `getNonce`, so the
 * contract address has to be discovered first and then called directly.
 *
 * An owner with no Policy Contract is a normal `{found:false}`, NOT an error: the Factory deploys
 * the contract lazily on first write, so "has never deployed a policy" is the expected state for
 * everyone who has not used this feature yet.
 *
 * A failure at any step keeps its own state rather than degrading into an empty list. "We could not
 * list your policies" must never be presented to a user as "you have none" — that is the same
 * collapse the three-state result exists to prevent, one level up.
 */
export async function readOwnerPolicies(
  owner: string,
  registryAddress: string,
  query: ContractQuery,
): Promise<OwnerPolicies> {
  const contract = await getPolicyContract(owner, registryAddress, query)
  if (!('found' in contract) || contract.found !== true) {
    return { contract, keys: null, policies: [] }
  }

  const keys = await listPolicyKeys(contract.value, query)
  if (!('found' in keys) || keys.found !== true) {
    return { contract, keys, policies: [] }
  }

  // Sequential, not parallel: N is small by design, and a burst of reads against one node buys
  // nothing here while making a rate-limited failure harder to read.
  const policies: OwnerPolicies['policies'] = []
  for (const policyKey of keys.value) {
    policies.push({ policyKey, result: await getPolicyByKey(contract.value, policyKey, query) })
  }

  const warning =
    keys.value.length > KEY_COUNT_WARNING_THRESHOLD
      ? `This owner has ${keys.value.length} policy keys; reading them all costs ${keys.value.length + 2} chain calls.`
      : undefined

  return { contract, keys, policies, ...(warning ? { warning } : {}) }
}
