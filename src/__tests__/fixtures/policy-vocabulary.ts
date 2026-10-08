/**
 * THE REAL POLICY VOCABULARY, read from the staging public API 2026-10-06.
 *
 * GET https://public-api-sandbox.zetrix.com/api/policy/vocabulary -> HTTP 200, 16 attributes, version v1.
 * Copied from the wire, not written by hand: a fixture that could not come from the service is the
 * defect, not a convenience. If it needs updating, re-read it rather than editing it to suit a test.
 * (The traceId and timestamp are those of the recorded call.)
 */

export const REAL_VOCABULARY_RESPONSE = {
  "object": {
    "version": "v1",
    "attributes": [
      {
        "name": "assetScope",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "Which kind of asset this policy governs: \"native\" for ZTX or \"ztp20\" for a ZTP20 token. Required whenever the policy sets an amount or count cap.",
        "unit": null,
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "perTransactionMax",
        "type": "NUMBER",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The most a single transfer may move, in the asset's smallest unit. A transfer of exactly this amount is allowed.",
        "unit": "SMALLEST_UNIT",
        "role": "CONSTRAINT",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "cumulativeMax",
        "type": "NUMBER",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The most that may be spent in total within cumulativeWindow, in the asset's smallest unit. Without cumulativeWindow it is a lifetime total, counted from when enforcement started for this owner, not a per-period one.",
        "unit": "SMALLEST_UNIT",
        "role": "CONSTRAINT",
        "pairsWith": "cumulativeWindow",
        "withoutPairMeans": "LIFETIME",
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "cumulativeWindow",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The rolling period cumulativeMax is counted over, such as 30d, 7d or 12h, and no longer than the ledger retention window (30d by default). Rolling, not aligned to calendar months or days.",
        "unit": "DURATION",
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "velocityCap",
        "type": "NUMBER",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The most that may be spent within velocityWindow, in the asset's smallest unit: a short-term rate limit, separate from cumulativeMax. Needs velocityWindow; without it every transfer is refused.",
        "unit": "SMALLEST_UNIT",
        "role": "CONSTRAINT",
        "pairsWith": "velocityWindow",
        "withoutPairMeans": "UNENFORCEABLE",
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "velocityWindow",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The rolling period velocityCap is counted over, such as 1h or 24h, and no longer than the ledger retention window (30d by default). Required whenever velocityCap is set.",
        "unit": "DURATION",
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "maxTransactionCount",
        "type": "NUMBER",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The most transfers allowed within countWindow, whatever their amount. A number of transfers, not an amount. Needs countWindow; without it every transfer is refused.",
        "unit": "COUNT",
        "role": "CONSTRAINT",
        "pairsWith": "countWindow",
        "withoutPairMeans": "UNENFORCEABLE",
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "countWindow",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "The rolling period maxTransactionCount is counted over, such as 1d, and no longer than the ledger retention window (30d by default). Required whenever maxTransactionCount is set.",
        "unit": "DURATION",
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "recipientAllowlist",
        "type": "ADDRESS_LIST",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "Transfers may go only to these addresses. An empty list allows no recipient at all; leave it out to allow any recipient.",
        "unit": null,
        "role": "CONSTRAINT",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": "DENY_ALL",
        "outsideAppliesToMeans": null
      },
      {
        "name": "recipientDenylist",
        "type": "ADDRESS_LIST",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "Transfers to these addresses are always refused, even if they are also on recipientAllowlist. An empty list blocks no address, but a transfer that does not name its recipient is still refused.",
        "unit": null,
        "role": "CONSTRAINT",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": "NO_EFFECT",
        "outsideAppliesToMeans": null
      },
      {
        "name": "unknownAttributePolicy",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "What to do when the policy contains an attribute name this service does not recognise: \"deny\" (the default) refuses every transfer, \"ignore\" skips the unrecognised name. It never excuses a recognised attribute with an invalid value.",
        "unit": null,
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "settlementChannel",
        "type": "STRING",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "Recorded for information only: its value is never enforced.",
        "unit": null,
        "role": "INFORMATIONAL",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": null
      },
      {
        "name": "payToAllowlist",
        "type": "ADDRESS_LIST",
        "appliesTo": [
          "native",
          "ztp20"
        ],
        "description": "A payment may go only to these payTo addresses, as reported by the client. Once set, any request that does not report its payTo is refused; an empty list allows no payment at all.",
        "unit": null,
        "role": "CONSTRAINT",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": "DENY_ALL",
        "outsideAppliesToMeans": null
      },
      {
        "name": "tokenAddress",
        "type": "ADDRESS",
        "appliesTo": [
          "ztp20"
        ],
        "description": "The ZTP20 token contract this policy governs. Required when assetScope is \"ztp20\". A policy that declares it governs only that token and never native transfers: named by its key, a native transfer is refused as an asset mismatch; otherwise the policy is left out for native transfers and none of its limits apply to them.",
        "unit": null,
        "role": "QUALIFIER",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": "NOT_GOVERNED"
      },
      {
        "name": "allowedMethods",
        "type": "STRING_LIST",
        "appliesTo": [
          "ztp20"
        ],
        "description": "The ZTP20 token methods the agent may call. Left out, only \"transfer\" is allowed; an empty list allows no method at all. Applies to ZTP20 only: on a policy that also governs native transfers (assetScope \"native\", or no assetScope) every native transfer is refused, unless it also declares tokenAddress, which instead takes the policy off native transfers altogether.",
        "unit": null,
        "role": "CONSTRAINT",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": "DENY_ALL",
        "outsideAppliesToMeans": "UNENFORCEABLE"
      },
      {
        "name": "approvalPolicy",
        "type": "STRING",
        "appliesTo": [
          "ztp20"
        ],
        "description": "Recorded for information only: its value is never enforced in this version and does not restrict token approvals. Applies to ZTP20 only: on a policy that also governs native transfers (assetScope \"native\", or no assetScope) every native transfer is refused, unless it also declares tokenAddress, which instead takes the policy off native transfers altogether.",
        "unit": null,
        "role": "INFORMATIONAL",
        "pairsWith": null,
        "withoutPairMeans": null,
        "emptyMeans": null,
        "outsideAppliesToMeans": "UNENFORCEABLE"
      }
    ]
  },
  "messages": [],
  "success": true,
  "timestamp": "2026-10-06 10:07:31",
  "traceId": "839e620b-c463-4a62-8c68-fd1b69d7234a"
}

export const REAL_VOCABULARY_BODY = JSON.stringify(REAL_VOCABULARY_RESPONSE)
