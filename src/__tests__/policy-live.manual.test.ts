/**
 * MANUAL live check against the real Zetrix testnet Policy Registry. NOT part of `npm test`.
 *
 *   npx vitest run src/__tests__/policy-live.manual.test.ts --config vitest.manual.config.ts
 *
 * It talks to the chain, so it is excluded from the normal suite: a node outage or a VPN would
 * otherwise turn an unrelated commit red. It needs the testnet node reachable — it does NOT need
 * Wallet BE, which is what the full MCP server requires at boot.
 */
import { describe, it, expect } from 'vitest'
import ZtxChainSDK from 'zetrix-sdk-nodejs'
import type { ContractQuery } from '../clients/token-info-client'
import { getPolicyContract, getTemplateById, readOwnerPolicies } from '../clients/policy-read-client'
import { policyPreflight } from '../orchestrator/policy-preflight'
import { derivePolicyRegistryAddress, derivePolicyTemplateAddress } from '../config'

const NETWORK = 'zetrix:testnet'
const REGISTRY = derivePolicyRegistryAddress(NETWORK)!
const TEMPLATE = derivePolicyTemplateAddress(NETWORK)!
const OWNER = process.env.ZETRIX_ADDRESS ?? 'ZTX3YzAyKBxjbSaMPeaPKEBpV93wjzN4SjTaN'

const sdk = new ZtxChainSDK({ host: 'test-node.zetrix.com', port: '' })
const chainQuery: ContractQuery = (a) => sdk.contract.call(a)

describe('live testnet policy reads', () => {
  it('resolves an owner policy contract, or reports a clean absence', async () => {
    const result = await getPolicyContract(OWNER, REGISTRY, chainQuery)
    console.log('getPolicyContract →', JSON.stringify(result))
    // Whatever the chain says, the answer must be one of the three states — never ambiguous.
    expect('found' in result || 'error' in result).toBe(true)
  }, 30000)

  it('walks the full 2 + N listing', async () => {
    const result = await readOwnerPolicies(OWNER, REGISTRY, chainQuery)
    console.log('readOwnerPolicies →', JSON.stringify(result, null, 2))
    expect(result).toHaveProperty('contract')
  }, 60000)

  it('reads a template by id', async () => {
    const result = await getTemplateById('a'.repeat(64), TEMPLATE, chainQuery)
    console.log('getTemplateById →', JSON.stringify(result))
    expect('found' in result || 'error' in result).toBe(true)
  }, 30000)

  it('never returns ready:true when the template cannot be read', async () => {
    // The safety property that matters most: a chain problem must never look like a pass.
    const result = await policyPreflight(
      { readTemplate: async (d) => getTemplateById(d.templateId!, TEMPLATE, chainQuery) },
      {
        policyKey: 'live-check',
        templateId: 'a'.repeat(64),
        attributes: [{ attributeName: 'x4O2', attributeType: 'uint', value: '1' }],
        validFromBlock: '0',
        validToBlock: '0',
      },
    )
    console.log('policyPreflight →', JSON.stringify(result, null, 2))
    expect(result.ready).toBe(false)
  }, 30000)
})
