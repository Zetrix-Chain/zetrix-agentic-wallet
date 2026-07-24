import { describe, it, expect } from 'vitest'
import { buildToolList } from '../index'

describe('buildToolList', () => {
  it('exposes exactly the 5 agent tools with the correct required inputs', () => {
    const tools = buildToolList()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_holder_account', 'pay_and_fetch', 'prove_identity', 'subscribe_and_issue', 'wallet_status',
    ])

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.prove_identity.inputSchema.required).toEqual(['proofRequest'])
    expect(byName.pay_and_fetch.inputSchema.required).toEqual(['url'])
    expect(byName.subscribe_and_issue.inputSchema.required).toEqual(['templateId', 'attributes'])
    // templateId must point callers at the x401 challenge's credential id, not its requirementsId label.
    expect(byName.subscribe_and_issue.inputSchema.properties.templateId.description).toMatch(/credential_requirements/)
    expect(byName.wallet_status.inputSchema.type).toBe('object')
    expect(byName.create_holder_account.inputSchema.required).toEqual(['password'])
  })
})
