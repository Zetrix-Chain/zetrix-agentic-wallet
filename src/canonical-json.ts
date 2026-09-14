/**
 * canonicalizeJson — recursively sorts object keys alphabetically and serializes with plain
 * JSON.stringify semantics (unescaped `/`, unescaped unicode, undefined-valued keys omitted),
 * matching PHP's `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE` byte-for-byte given the same
 * key order. Used to build the exact bytes myid's SSIVC API re-derives when verifying a
 * `signedData` detached signature — see verify-ai-birthcert.ts.
 */
export function canonicalizeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(record[k])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}
