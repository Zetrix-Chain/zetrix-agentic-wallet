/**
 * Test helper. Since a confirmation must carry a quoteId the wallet gave, a test that wants to reach the payment
 * it is about registers its echoed quote in the quote book first, for exactly the request it then makes, as the wallet's
 * own price stop would have. A confirmation that is meant to be refused (true, "true", a partial object, a quote that
 * already has a quoteId) is passed through untouched, so those tests still exercise the refusal.
 */
import { canonicalizeJson } from '../../canonical-json'
import { defaultQuoteBook, type QuoteBinding, type QuoteBook } from '../../price-confirmation'

/** \`confirm\` with a quoteId registered for \`binding\`, when it is a complete quote without one; otherwise unchanged. */
export function withQuoteId(confirm: unknown, binding: QuoteBinding, book?: QuoteBook): unknown {
  let value = confirm
  let asString = false
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
      asString = true
    } catch {
      return confirm
    }
  }
  if (typeof value !== 'object' || value === null) return confirm
  const v = value as Record<string, unknown>
  if (typeof v.quoteId === 'string') return confirm
  if (typeof v.asset !== 'string' || v.asset === '') return confirm
  if (typeof v.maxAmountRequired !== 'string' || v.maxAmountRequired === '') return confirm
  if (v.gasModel !== 'sponsored' && v.gasModel !== 'self') return confirm
  const { quoteId } = (book ?? defaultQuoteBook).issue(binding, {
    asset: v.asset,
    maxAmountRequired: v.maxAmountRequired,
    payTo: typeof v.payTo === 'string' ? v.payTo : '',
    gasModel: v.gasModel,
  })
  const out = { ...v, quoteId }
  return asString ? JSON.stringify(out) : out
}

/** The binding request_ai_birthcert_verification gives its quote (mirrors verificationBinding). */
export function verificationBindingFor(input: Record<string, unknown>): QuoteBinding {
  const details: Record<string, string> = {}
  for (const k of ['agentPurpose', 'evidenceAssuranceLevel', 'ownerType', 'ownerVerified']) {
    if (typeof input[k] === 'string' && input[k]) details[k] = input[k] as string
  }
  return { tool: 'request_ai_birthcert_verification', subject: String(input.agentName ?? '').trim(), details: canonicalizeJson(details) }
}

/** The binding subscribe_and_issue gives its quote (mirrors subscribeBinding). */
export function subscribeBindingFor(opts: Record<string, unknown>): QuoteBinding {
  return { tool: 'subscribe_and_issue', subject: String(opts.templateId), details: canonicalizeJson(opts.attributes ?? {}) }
}

/** \`input\` with its confirmation registered, when it has one to register. */
export function confirmedInput(input: Record<string, unknown>, binding: QuoteBinding, book?: QuoteBook): Record<string, unknown> {
  return input.confirm === undefined ? input : { ...input, confirm: withQuoteId(input.confirm, binding, book) }
}
