import { describe, it, expect } from 'vitest'
import { buildToolList } from '../index'

describe('buildToolList', () => {
  it('exposes exactly the 14 agent tools with the correct required inputs', () => {
    const tools = buildToolList()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_ai_birthcert_verification', 'clear_stuck_payment_receipt', 'create_holder_account', 'credential_preflight',
      'get_my_policy', 'get_policy_template_schema', 'get_template_schema', 'pay_and_fetch', 'policy_preflight',
      'prove_identity', 'query_contract', 'request_ai_birthcert_verification', 'subscribe_and_issue',
      'wallet_status',
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

  // The tool can now come back with settlementPending instead of a session. The agent has
  // to be told that this means the payment SUCCEEDED and is still settling — in the 18 Sep 2026 QA
  // run it read a live settlement as "the payment failed" and told the user so.
  // Check_ can now replay a stuck receipt, which CREATES a session. It still never pays,
  // but "starts nothing" became false — and an agent that believes it is inert will not reach for it
  // when it is the tool that actually unblocks the user.
  // Support must be able to unblock a stuck user without shell access on the gateway.
  // In the QA run the agent paid without re-checking a balance the user had just topped up.
  // credential_preflight is free; the tool it guards is not.
  it('request_ai_birthcert_verification tells the agent to run credential_preflight first', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/credential_preflight/)
  })

  it('registers clear_stuck_payment_receipt with confirmReceiptId as the only input', () => {
    const tool = buildToolList().find((t) => t.name === 'clear_stuck_payment_receipt')
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.properties.confirmReceiptId).toBeDefined()
    expect(tool?.inputSchema.required ?? []).not.toContain('confirmReceiptId')
  })

  it('clear_stuck_payment_receipt is described as destructive and confirmation-gated', () => {
    const tool = buildToolList().find((t) => t.name === 'clear_stuck_payment_receipt')
    expect(tool?.description).toMatch(/cannot be undone|unrecoverable|forfeit/i)
    expect(tool?.description).toMatch(/confirm/i)
    // The agent must not reach for this as a generic retry — it destroys a real payment.
    expect(tool?.description).toMatch(/last resort|only.*stuck|do not use/i)
  })

  it('check_ai_birthcert_verification is described as free but no longer as starting nothing', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.description).toMatch(/free|never pays|spends nothing/i)
    expect(tool?.description).not.toMatch(/starts nothing/i)
    expect(tool?.description).toMatch(/settlement_pending/)
  })

  // APP-L03: advancing a queued settlement can block for the whole wait budget. A tool the agent
  // believes is an instant read, that occasionally takes 90s, reads as a hang.
  it('check_ai_birthcert_verification warns that advancing a settlement can take up to ~90s', () => {
    const tool = buildToolList().find((t) => t.name === 'check_ai_birthcert_verification')
    expect(tool?.description).toMatch(/90s|90 seconds/i)
  })

  it('request_ai_birthcert_verification documents the settlementPending result as a success, not a failure', () => {
    const tool = buildToolList().find((t) => t.name === 'request_ai_birthcert_verification')
    expect(tool?.description).toMatch(/settlementPending/)
    expect(tool?.description).toMatch(/check_ai_birthcert_verification/)
    expect(tool?.description).toMatch(/do not pay again|never pay again/i)
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

  it('advertises an optional gasPayer enum on request_ai_birthcert_verification', () => {
    const tool = buildToolList().find(t => t.name === 'request_ai_birthcert_verification')
    const prop = (tool?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.gasPayer
    expect(prop?.enum).toEqual(['sponsored', 'self'])
    const required = (tool?.inputSchema as { required?: string[] }).required ?? []
    expect(required).not.toContain('gasPayer')
  })

  it('advertises every policy tool as free of payment and signing', () => {
    for (const name of ['get_my_policy', 'get_policy_template_schema', 'policy_preflight']) {
      const tool = buildToolList().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.description, name).toMatch(/free|no payment/i)
    }
  })

  it('tells the agent that a clean policy_preflight is not a guarantee of enforcement', () => {
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.description).toMatch(/not a guarantee|notChecked/i)
  })

  it('promises the plain-words interpretation, so an agent knows to show it on a PASS', () => {
    // An agent that reports only ready:true hides exactly what that layer exists to surface.
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.description).toMatch(/interpretation|what it means|plain words/i)
  })

  it('requires a draft policy for policy_preflight', () => {
    const tool = buildToolList().find((t) => t.name === 'policy_preflight')
    expect(tool?.inputSchema.required).toEqual(['policyKey', 'attributes', 'validFromBlock', 'validToBlock'])
  })

  it('asks for nothing mandatory on the two read tools, so a bare call works', () => {
    const byName = Object.fromEntries(buildToolList().map((t) => [t.name, t]))
    expect(byName.get_my_policy.inputSchema.required).toBeUndefined()
    expect(byName.get_policy_template_schema.inputSchema.required).toBeUndefined()
  })
})
