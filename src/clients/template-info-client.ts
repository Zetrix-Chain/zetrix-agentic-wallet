/**
 * TemplateInfoClient — reads a credential template's declared attributes from chain.
 *
 * MBI settles the x402 payment in `applySettle` *before* validating the attributes it's given
 * against the template's declared schema — both that every mandatory field is present, AND that no
 * unexpected key is included (it rejects unknown keys outright). Either mistake burns real funds on
 * a guaranteed-to-fail issuance. To catch both *before* paying, we read the template definition the
 * issuer registered on-chain: the mandatory subset (to check nothing's missing) and the full
 * declared key set (to check the wallet isn't about to send a key the template doesn't recognize,
 * e.g. its own agentDid auto-fill — see `subscribe.ts`).
 *
 * The template lives under a per-network template-registry account (NOT the issuer/payTo address,
 * and NOT carried in the MBI 402 challenge) and is read via the node's `getAccountMetaData`:
 *
 *   GET https://<nodeHost>/getAccountMetaData?address=<registryAddress>&key=template__<templateId>
 *
 * The response nests JSON twice: `result[key].value` is a JSON string whose `applyFormat` field is
 * itself a JSON string — an array of attribute descriptors `{ key, mandatory, ... }` where
 * `mandatory === 1` marks a required field.
 *
 * Like `token-info-client`, every read is fail-open: any RPC error, missing field, or malformed
 * JSON yields `null` so the caller falls through to the normal flow (MBI stays the backstop). A
 * template that exists but declares no attributes returns `{ required: [], allKeys: [] }`, not `null`.
 */

/** The read-only node GET seam (a `getAccountMetaData`-shaped call). Injectable for tests. */
export type NodeMetaQuery = (url: string) => Promise<{
  error_code?: number
  result?: Record<string, { value?: string }> | null
}>

/** One `applyFormat` attribute descriptor (only the fields we use). */
interface ApplyFormatEntry {
  key?: unknown
  mandatory?: unknown
}

export interface TemplateFields {
  /** Mandatory attribute keys (`mandatory === 1`). */
  required: string[]
  /** Every declared attribute key, mandatory or not. */
  allKeys: string[]
}

/**
 * Return a credential template's declared attribute keys — both the mandatory subset and the full
 * declared set — or `null` on ANY failure (RPC error, missing key, malformed `value`/`applyFormat`
 * JSON). Never throws. A template that exists but declares no attributes returns
 * `{ required: [], allKeys: [] }`.
 */
export async function fetchTemplateFields(
  templateId: string,
  registryAddress: string,
  nodeBaseUrl: string,
  query: NodeMetaQuery,
): Promise<TemplateFields | null> {
  const key = `template__${templateId}`
  const url =
    `${nodeBaseUrl.replace(/\/+$/, '')}/getAccountMetaData` +
    `?address=${encodeURIComponent(registryAddress)}&key=${encodeURIComponent(key)}`

  let res
  try {
    res = await query(url)
  } catch {
    return null
  }
  if (res?.error_code !== 0) return null

  const value = res.result?.[key]?.value
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as { applyFormat?: unknown }
    // A template with no declared attributes is valid — nothing is required, nothing is a valid key.
    if (parsed.applyFormat === undefined || parsed.applyFormat === null) return { required: [], allKeys: [] }
    // applyFormat is a JSON *string* (doubly-encoded); tolerate an already-parsed array too.
    const format =
      typeof parsed.applyFormat === 'string' ? JSON.parse(parsed.applyFormat) : parsed.applyFormat
    if (!Array.isArray(format)) return null
    const entries = (format as ApplyFormatEntry[]).filter(
      (e): e is ApplyFormatEntry & { key: string } => !!e && typeof e.key === 'string' && e.key !== '',
    )
    return {
      required: entries.filter((e) => e.mandatory === 1).map((e) => e.key),
      allKeys: entries.map((e) => e.key),
    }
  } catch {
    return null
  }
}
