/**
 * The policy attribute vocabulary — what each attribute MEANS, as the service that enforces it says.
 *
 * WHY THIS EXISTS. The chain template declares an attribute's name and type and nothing else, so an
 * agent could not learn that an empty `recipientAllowlist` denies everyone, that `velocityCap`
 * without `velocityWindow` refuses every transfer, or that `allowedMethods` on a native policy makes
 * every native transfer refused. The wallet restated those rules by hand (policy-scope-rules.ts,
 * policy-window-rules.ts), and a hand-kept copy drifts. ms-zetrix now publishes the vocabulary at
 * `GET /policy/vocabulary` (envelope key `object`, `version: "v1"`), so this reads it.
 *
 * THREE STATES, like every other read here. `available` means the service answered and the body is
 * well-formed; `unavailable` means we do not know, and says why. There is no third "empty" answer: a
 * vocabulary that could not be read is never an empty vocabulary, because an empty one would make
 * every attribute look unknown and refuse every draft.
 *
 * STRICT ON PURPOSE. One malformed attribute fails the whole read rather than being skipped. A
 * skipped entry would look like an attribute the service does not know, and preflight would then
 * refuse a draft for using it.
 *
 * REMOTE TEXT IS BOUNDED. The descriptions are written by another service and reach an agent as
 * tool output, so each one is flattened to a single line and cut at a fixed length — "bounded, not
 * scrubbed", the same promise `transfer_token` makes for a Wallet BE message.
 *
 * KNOWN FAILURE MODE. The route sits behind a Cloudflare bot rule that, for some non-browser
 * clients, answers a "Just a moment..." HTML page with HTTP 403 and `cf-mitigated: challenge`
 * instead of the JSON (observed 2026-10-06 from Node's fetch and from Git's OpenSSL curl; the
 * Windows Schannel curl got the JSON). That is `challenged`, reported as such, and the caller falls
 * back to the hand-kept rules. It is not an API error and not an empty vocabulary.
 */

/** The only version this wallet understands. Anything else is reported, not guessed at. */
export const SUPPORTED_VOCABULARY_VERSION = 'v1'

/** Most attributes accepted. The service publishes 16; more than this is a malformed reply. */
export const MAX_VOCABULARY_ATTRIBUTES = 100

/** Longest body read. The real reply is about 7 KB. */
export const MAX_VOCABULARY_BODY_CHARS = 256 * 1024

/** Longest description echoed. Longer ones are cut with a marker, never dropped. */
export const MAX_DESCRIPTION_CHARS = 600

/** An attribute name, as the service writes it. Anything else fails the read. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** An enum value as the service writes it. */
const ENUM_PATTERN = /^[A-Z][A-Z0-9_]{0,39}$/

export interface VocabularyAttribute {
  name: string
  type: string
  /** The scopes this attribute is meaningful for: `native`, `ztp20`. */
  appliesTo: string[]
  /** Bounded, single-line. */
  description: string
  /** `SMALLEST_UNIT`, `COUNT`, `DURATION`, or null. */
  unit: string | null
  /** `CONSTRAINT` (enforces something), `QUALIFIER` (shapes another rule) or `INFORMATIONAL`. */
  role: string | null
  /** The attribute this one only works with. */
  pairsWith: string | null
  /** What happens when `pairsWith` is absent: `LIFETIME` or `UNENFORCEABLE`. */
  withoutPairMeans: string | null
  /** What an empty list means: `DENY_ALL` or `NO_EFFECT`. */
  emptyMeans: string | null
  /** What happens outside `appliesTo`: `UNENFORCEABLE` or `NOT_GOVERNED`. */
  outsideAppliesToMeans: string | null
}

export interface PolicyVocabulary {
  version: string
  attributes: VocabularyAttribute[]
}

export type VocabularyUnavailableCause =
  | 'unreachable'
  | 'unreadable'
  | 'challenged'
  | 'http_error'
  | 'not_json'
  | 'bad_shape'
  | 'unsupported_version'

export type VocabularyRead =
  | { available: true; vocabulary: PolicyVocabulary }
  | { available: false; cause: VocabularyUnavailableCause; detail: string }

/** The slice of `fetch` this needs, so a test can supply a fake without a network. */
export type HttpGet = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal; redirect: 'error' },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

/** One line, no control characters, cut at a code point. Total: it never throws. */
export function boundText(value: string, max: number): string {
  // Invisible formatting characters (zero-width, bidi overrides such as U+202E) are REMOVED, not turned into spaces:
  // they can reorder or hide text without showing, so none belongs in a description an agent reads.
  const flat = value.replace(/\p{Cf}+/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()
  const points = Array.from(flat)
  return points.length <= max ? flat : `${points.slice(0, max - 1).join('')}…`
}

function nullableEnum(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value === 'string' && ENUM_PATTERN.test(value)) return value
  return undefined
}

function parseAttribute(raw: unknown): VocabularyAttribute | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || !NAME_PATTERN.test(r.name)) return null
  if (typeof r.type !== 'string' || !ENUM_PATTERN.test(r.type)) return null
  if (typeof r.description !== 'string') return null
  if (!Array.isArray(r.appliesTo) || r.appliesTo.length === 0 || r.appliesTo.length > 10) return null
  if (!r.appliesTo.every((s) => typeof s === 'string' && /^[a-z0-9]{1,20}$/.test(s))) return null

  const unit = nullableEnum(r.unit)
  const role = nullableEnum(r.role)
  const withoutPairMeans = nullableEnum(r.withoutPairMeans)
  const emptyMeans = nullableEnum(r.emptyMeans)
  const outsideAppliesToMeans = nullableEnum(r.outsideAppliesToMeans)
  if (
    unit === undefined ||
    role === undefined ||
    withoutPairMeans === undefined ||
    emptyMeans === undefined ||
    outsideAppliesToMeans === undefined
  ) {
    return null
  }
  let pairsWith: string | null = null
  if (r.pairsWith !== null) {
    if (typeof r.pairsWith !== 'string' || !NAME_PATTERN.test(r.pairsWith)) return null
    pairsWith = r.pairsWith
  }

  return {
    name: r.name,
    type: r.type,
    appliesTo: r.appliesTo as string[],
    description: boundText(r.description, MAX_DESCRIPTION_CHARS),
    unit,
    role,
    pairsWith,
    withoutPairMeans,
    emptyMeans,
    outsideAppliesToMeans,
  }
}

/** Parse a response body. Pure, so the shapes can be tested without a network. */
export function parseVocabularyBody(body: string): VocabularyRead {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return {
      available: false,
      cause: 'not_json',
      detail: `the reply was not JSON (it began "${boundText(body.slice(0, 40), 40)}")`,
    }
  }
  if (typeof json !== 'object' || json === null) {
    return { available: false, cause: 'bad_shape', detail: 'the reply was not an object' }
  }
  const envelope = json as { object?: unknown; success?: unknown }
  if (envelope.success === false) {
    return { available: false, cause: 'bad_shape', detail: 'the service reported success: false' }
  }
  const object = envelope.object as { version?: unknown; attributes?: unknown } | null | undefined
  if (typeof object !== 'object' || object === null) {
    return { available: false, cause: 'bad_shape', detail: 'the reply carried no "object"' }
  }
  if (object.version !== SUPPORTED_VOCABULARY_VERSION) {
    return {
      available: false,
      cause: 'unsupported_version',
      detail: `vocabulary version ${typeof object.version === 'string' ? `"${boundText(object.version, 20)}"` : 'missing'}, this wallet reads "${SUPPORTED_VOCABULARY_VERSION}"`,
    }
  }
  if (
    !Array.isArray(object.attributes) ||
    object.attributes.length === 0 ||
    object.attributes.length > MAX_VOCABULARY_ATTRIBUTES
  ) {
    return { available: false, cause: 'bad_shape', detail: 'the attribute list was missing, empty or too long' }
  }
  const attributes: VocabularyAttribute[] = []
  const seen = new Set<string>()
  for (const raw of object.attributes) {
    const parsed = parseAttribute(raw)
    if (!parsed) {
      return { available: false, cause: 'bad_shape', detail: 'an attribute entry was malformed' }
    }
    if (seen.has(parsed.name)) {
      return { available: false, cause: 'bad_shape', detail: 'an attribute name appeared twice' }
    }
    seen.add(parsed.name)
    attributes.push(parsed)
  }
  return { available: true, vocabulary: { version: SUPPORTED_VOCABULARY_VERSION, attributes } }
}

export const VOCABULARY_TIMEOUT_MS = 5_000

/** One read, never throwing. */
export async function readPolicyVocabulary(
  baseUrl: string,
  get: HttpGet,
  timeoutMs = VOCABULARY_TIMEOUT_MS,
): Promise<VocabularyRead> {
  const url = `${baseUrl.replace(/\/+$/, '')}/policy/vocabulary`
  let res: Awaited<ReturnType<HttpGet>>
  try {
    res = await get(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: the base URL comes from trusted config, and a redirect (to another host, or from https
      // to http) would send the read somewhere nobody configured.
      redirect: 'error',
    })
  } catch (e) {
    return { available: false, cause: 'unreachable', detail: `request failed — ${boundText(String((e as Error)?.message ?? e), 200)}` }
  }

  // A declared size over the limit is refused BEFORE the body is read, so the only bound is not the timeout.
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_VOCABULARY_BODY_CHARS) {
    return { available: false, cause: 'bad_shape', detail: 'the reply declared a size larger than any real vocabulary' }
  }

  let body: string
  try {
    body = await res.text()
  } catch (e) {
    return { available: false, cause: 'unreadable', detail: `could not read the reply — ${boundText(String((e as Error)?.message ?? e), 200)}` }
  }

  if (res.headers.get('cf-mitigated') === 'challenge' || (res.status === 403 && /Just a moment/i.test(body.slice(0, 4096)))) {
    return {
      available: false,
      cause: 'challenged',
      detail: `HTTP ${res.status}: Cloudflare answered with a bot challenge instead of the vocabulary`,
    }
  }
  if (!res.ok) {
    return { available: false, cause: 'http_error', detail: `HTTP ${res.status}` }
  }
  if (body.length > MAX_VOCABULARY_BODY_CHARS) {
    return { available: false, cause: 'bad_shape', detail: 'the reply was larger than any real vocabulary' }
  }
  return parseVocabularyBody(body)
}

export interface VocabularyReaderOptions {
  baseUrl: string
  get: HttpGet
  timeoutMs?: number
  /** How long a good answer is reused. */
  ttlMs?: number
  /** How long a failed answer is reused, so a down endpoint does not cost a timeout per call. */
  failureTtlMs?: number
  now?: () => number
}

/**
 * A cached reader. A good answer is kept for ten minutes and a failure for one, and concurrent
 * callers share one request. Nothing is kept across restarts.
 */
export function createVocabularyReader(options: VocabularyReaderOptions): () => Promise<VocabularyRead> {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? 10 * 60_000
  const failureTtl = options.failureTtlMs ?? 60_000
  let cached: { read: VocabularyRead; at: number } | undefined
  let inFlight: Promise<VocabularyRead> | undefined

  return async () => {
    if (cached && now() - cached.at < (cached.read.available ? ttl : failureTtl)) return cached.read
    if (!inFlight) {
      inFlight = readPolicyVocabulary(options.baseUrl, options.get, options.timeoutMs)
        .then((read) => {
          cached = { read, at: now() }
          return read
        })
        .finally(() => {
          inFlight = undefined
        })
    }
    return inFlight
  }
}

/** The one-line reason shown to an agent when the vocabulary could not be read. */
export function describeUnavailable(read: Extract<VocabularyRead, { available: false }>): string {
  return (
    `The live attribute vocabulary could not be read (${read.detail}), so the wallet's built-in rules ` +
    `were used instead. Attribute meanings are not shown.`
  )
}
