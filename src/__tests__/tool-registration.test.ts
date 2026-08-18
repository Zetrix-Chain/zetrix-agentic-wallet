import { describe, it, expect } from 'vitest'
import { buildToolList } from '../index'

describe('buildToolList', () => {
  it('exposes exactly the 9 agent tools with the correct required inputs', () => {
    const tools = buildToolList()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_ai_birthcert_verification', 'create_holder_account', 'get_template_schema', 'pay_and_fetch',
      'prove_identity', 'query_contract', 'request_ai_birthcert_verification', 'subscribe_and_issue', 'wallet_status',
    ])

    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName.prove_identity.inputSchema.required).toEqual(['proofRequest'])
    expect(byName.pay_and_fetch.inputSchema.required).toEqual(['url'])
    expect(byName.subscribe_and_issue.inputSchema.required).toEqual(['templateId', 'attributes'])
    expect(byName.subscribe_and_issue.inputSchema.properties.templateId.description).toMatch(/credential_requirements/)
    expect(byName.wallet_status.inputSchema.type).toBe('object')
    expect(byName.create_holder_account.inputSchema.required).toBeUndefined()
    expect(byName.query_contract.inputSchema.required).toEqual(['contractAddress', 'method'])
    expect(byName.get_template_schema.inputSchema.required).toEqual(['templateId'])
    expect(byName.request_ai_birthcert_verification.inputSchema.required).toEqual(['agentName'])
    expect(byName.check_ai_birthcert_verification.inputSchema.type).toBe('object')
  })

  it('does not expose a password parameter on create_holder_account', () => {
    const tool = buildToolList().find((t) => t.name === 'create_holder_account')
    expect(tool?.inputSchema.properties.password).toBeUndefined()
  })

  it('does not tell the agent anything about a password', () => {
    const tool = buildToolList().find((t) => t.name === 'create_holder_account')
    expect(tool?.description).not.toMatch(/password/i)
  })

  it('advertises get_template_schema as free of payment', () => {
    const tool = buildToolList().find((t) => t.name === 'get_template_schema')
    expect(tool?.description).toMatch(/free|no payment/i)
  })

  // agentName is the ONLY thing the caller supplies — id/ownerReference are auto-filled and must
  // never be exposed as inputs, and the description must warn about uniqueness without leaking
  // the internal id-mirroring mechanism.
  it('request_ai_birthcert_verification exposes agentName as the only required input, with a uniqueness warning', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.inputSchema.properties.id).toBeUndefined()
    expect(tool?.inputSchema.properties.ownerReference).toBeUndefined()
    expect(tool?.inputSchema.properties.agentName).toBeDefined()
    expect(tool?.description).toMatch(/unique/i)
    expect(tool?.description).not.toMatch(/\bid\b.*mirror|copy of agentName/i)
  })

  it('check_ai_birthcert_verification takes no required input', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.inputSchema.required).toBeUndefined()
  })

  it('subscribe_and_issue is disambiguated from the Verified AI Birthcert flow', () => {
    const tool = buildToolList().find((t) => t.name === 'subscribe_and_issue')
    expect(tool?.description).toMatch(/self-declared/i)
    expect(tool?.description).toMatch(/NOT.*identity-verified|not.*identity-verified/)
    expect(tool?.description).toMatch(/request_ai_birthcert_verification/)
  })

  it('request_ai_birthcert_verification points back at subscribe_and_issue for the non-verified case', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/subscribe_and_issue/)
    expect(tool?.description).toMatch(/self-declared|non-verified|not verified/i)
  })
})
