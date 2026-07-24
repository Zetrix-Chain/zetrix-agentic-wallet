/**
 * Named-template alias registry — resolves a caller-friendly name (e.g. "AI Birthcert") to the
 * real per-network did:zid:... credential-definition id, so subscribe_and_issue's caller doesn't
 * need to already know or discover the raw id for well-known templates.
 *
 * A templateId that already looks like a raw did:zid:... is never run through this resolver
 * (see resolveTemplateAlias below) — resolution is purely additive.
 */

export interface TemplateAliasEntry {
  /** Normalized (lowercased, non-alphanumeric stripped) substring to look for in the caller's input. */
  match: string
  testnet: string
  mainnet: string
}

const TEMPLATE_ALIASES: TemplateAliasEntry[] = [
  {
    match: 'birthcert',
    testnet: 'did:zid:d6b783559acf6ba0f7ef6e1365bdaf0774d622d8d22728ca6323677f49ee94f8',
    mainnet: 'did:zid:032cb99be3577beccfc6252783c49c83673af38f8456d73462043654d7764e83',
  },
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Resolve a caller-supplied templateId to a known did:zid:... for the active network. Returns
 * undefined when `input` is already a raw did:zid:... id, or matches no known alias — in both
 * cases the caller's original value should be used as-is (subscribe.ts's own did:zid:... guard
 * reports a clear error for anything that's neither a valid id nor a known alias).
 */
export function resolveTemplateAlias(input: string, network: string): string | undefined {
  if (/^did:zid:/.test(input)) return undefined
  const normalized = normalize(input)
  const entry = TEMPLATE_ALIASES.find((e) => normalized.includes(e.match))
  if (!entry) return undefined
  return network.includes('testnet') ? entry.testnet : entry.mainnet
}
