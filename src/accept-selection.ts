/**
 * Choosing among the payment options in an x402 phase-1 `accepts[]`.
 *
 * Historically every caller took `accepts[0]`; SSIVC may now quote a self-pay option
 * alongside a paymaster-sponsored one. Sponsorship is ZTP-20 only — a sponsored quote
 * priced in native ZTX is unusable and is discarded rather than attempted.
 */

import type { PayRequirement } from './clients/mbi-client.js'

/** Which side pays network gas. Sponsored is the default — see the plan's Global Constraints. */
export type GasPreference = 'sponsored' | 'self'

/** `extra` is `[]` on legacy SSIVC quotes and absent on MBI's — both mean self-pay. */
function extraOf(accept: PayRequirement): Record<string, unknown> {
  const extra = (accept as { extra?: unknown }).extra
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {}
  return extra as Record<string, unknown>
}

function assetOf(accept: PayRequirement): string {
  return String((accept as { asset?: unknown }).asset ?? '')
}

/** Does this quote ask the facilitator to sponsor gas, whether or not it is actionable? */
function declaresFacilitator(accept: PayRequirement): boolean {
  return extraOf(accept).gasModel === 'facilitator'
}

/** A sponsored quote we can actually act on: a prepareEndpoint, and a ZTP20 asset. */
export function isSponsored(accept: PayRequirement): boolean {
  if (!declaresFacilitator(accept)) return false
  const prepareEndpoint = extraOf(accept).prepareEndpoint
  if (typeof prepareEndpoint !== 'string' || prepareEndpoint === '') return false
  const asset = assetOf(accept)
  return asset !== '' && asset !== 'ZTX'
}

/**
 * A quote declaring `gasModel: 'facilitator'` that we cannot act on — no prepareEndpoint, or
 * priced in native ZTX, which is never sponsorable. It must be DROPPED, not silently retried
 * as self-pay: the server's `extra` overrides the wallet's gasModel default
 * (`src/index.ts:291-293`), so attempting it would still enter the facilitator branch and throw.
 */
function isUnusable(accept: PayRequirement): boolean {
  return declaresFacilitator(accept) && !isSponsored(accept)
}

/**
 * Rank the payment options: preferred first, then any usable fallback.
 * The caller attempts them in order (see Task 5's definitive-failure fallback).
 */
export function orderAccepts(accepts: PayRequirement[], prefer: GasPreference): PayRequirement[] {
  const usable = accepts.filter(a => !isUnusable(a))
  const sponsored = usable.filter(isSponsored)
  const selfPay = usable.filter(a => !isSponsored(a))
  return prefer === 'sponsored' ? [...sponsored, ...selfPay] : [...selfPay, ...sponsored]
}

/**
 * The BASE url the SDK expects, from the `prepareEndpoint` url SSIVC advertises.
 *
 * SSIVC advertises `extra.prepareEndpoint` as a full URL ending in `/prepare`. But
 * `PaymentEngine.pay` forwards that value as the SDK's base url, and
 * `FacilitatorPrepareClient.prepare` appends `/prepare` to it, producing
 * `/api/facilitator/prepare/prepare` — which the public proxy rejects with
 * `403 {"error":"Endpoint not allowed: /prepare/prepare"}`. Verified live 2026-08-24.
 *
 * Strip a trailing `/prepare` (and any trailing slash) — the SDK appends its own.
 */
export function prepareBaseUrl(prepareEndpoint: string): string {
  return prepareEndpoint.replace(/\/+$/, '').replace(/\/prepare$/, '')
}

/**
 * Whether the pre-flight native-ZTX gas check applies to this payment.
 *
 * It applies only to a self-paid ZTP20 payment: native ZTX payments are covered by the
 * amount check itself, and a sponsored payment has its gas paid by the paymaster pool —
 * running the guard there would reject exactly the wallet sponsorship exists to serve.
 */
export function needsNativeGasCheck(accept: PayRequirement): boolean {
  const asset = String((accept as { asset?: unknown }).asset ?? '')
  if (asset === '' || asset === 'ZTX') return false
  return !isSponsored(accept)
}
