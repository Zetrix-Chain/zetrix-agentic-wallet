/**
 * queryContract — general-purpose read-only contract/account query, exposed to the agent
 * via the query_contract MCP tool. Wraps the same sdk.contract.call path token-info-client.ts
 * already uses for one hardcoded method (contractInfo), generalized to an arbitrary method
 * and params. Read-only: no signing, no state mutation, no submission.
 */

import type { ContractQuery } from './token-info-client.js'

export interface ContractQueryInput {
  contractAddress: string
  method: string
  params?: Record<string, unknown>
}

export type ContractQueryResult = { ok: true; result: unknown } | { ok: false; error: string }

export async function queryContract(input: ContractQueryInput, query: ContractQuery): Promise<ContractQueryResult> {
  let response: Awaited<ReturnType<ContractQuery>>
  try {
    response = await query({
      contractAddress: input.contractAddress,
      input: JSON.stringify({ method: input.method, params: input.params ?? {} }),
      optType: 2,
    })
  } catch (e) {
    return { ok: false, error: `query_contract: RPC call failed — ${(e as Error).message}` }
  }

  if (response.errorCode !== 0) {
    return { ok: false, error: `query_contract: contract call failed with errorCode ${response.errorCode}` }
  }

  const raw = response.result?.query_rets?.[0]?.result?.value
  if (raw === undefined) {
    return { ok: false, error: 'query_contract: no result value returned' }
  }

  try {
    return { ok: true, result: JSON.parse(raw) }
  } catch {
    return { ok: true, result: raw }
  }
}
