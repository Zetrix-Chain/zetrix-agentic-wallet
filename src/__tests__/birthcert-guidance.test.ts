import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildToolList } from '../index'
import { aiBirthcertChoice } from '../orchestrator/birthcert-choice'

// The reviewed snapshot pins the exact words of every tool text; these pin what the words MEAN, so a
// regenerated snapshot cannot quietly drop a rule.

function tool(name: string) {
  const t = buildToolList().find((x) => x.name === name)
  if (!t) throw new Error('no such tool: ' + name)
  return t as { description: string; inputSchema: { properties: Record<string, { description?: string }> } }
}

const readDoc = (...parts: string[]) => readFileSync(join(__dirname, '..', '..', ...parts), 'utf8').replace(/\r\n/g, '\n')
const SKILL = readDoc('openclaw-plugin', 'skills', 'zetrix-agentic-wallet', 'SKILL.md')
const GUIDE = readDoc('openclaw-plugin', 'USER_GUIDE.md')
const README = readDoc('README.md')

/** SKILL.md's "Before spending" step 5: the one about request_ai_birthcert_verification and the agent name. */
const STEP5 = (() => {
  const start = SKILL.indexOf('5. For `request_ai_birthcert_verification`')
  if (start < 0) return ''
  const next = SKILL.indexOf('\n6. ', start)
  return SKILL.slice(start, next < 0 ? undefined : next)
})()

/** The "Which AI Birthcert" section ONLY: up to the next section heading, not to the end of the file. */
const SECTION = (() => {
  const start = SKILL.indexOf('## Which AI Birthcert')
  if (start < 0) return ''
  const next = SKILL.indexOf('\n## ', start + 5)
  return SKILL.slice(start, next < 0 ? undefined : next)
})()

const allToolText = () => buildToolList().map((t) => JSON.stringify(t)).join('\n')

describe('an AI Birthcert request that does not say Basic or Verified', () => {
  it('credential_preflight tells the agent not to pick, to check both kinds, to explain and to ask', () => {
    const d = tool('credential_preflight').description
    expect(d).toMatch(/does not say which kind/i)
    expect(d).toMatch(/do not pick one/i)
    expect(d).toMatch(/both kinds/i)
    expect(d).toMatch(/ask which they prefer/i)
  })

  // Review R1-L1: "stop" on an already-held result is about THAT credential; the other kind is still to be offered.
  it('credential_preflight says "stop" applies to the held credential only, while the choice note still applies', () => {
    const d = tool('credential_preflight').description
    expect(d).toMatch(/stop on that credential only|stop applies to that credential only/i)
  })

  it('the credential parameter says "AI Birthcert" is the Basic one and verified_ai_birthcert the Verified one', () => {
    const p = tool('credential_preflight').inputSchema.properties.credential.description as string
    expect(p).toMatch(/BASIC/)
    expect(p).toMatch(/verified_ai_birthcert/)
  })

  // Review R1-L8: any name containing "birthcert" is priced as the Basic template.
  it('the credential parameter says to use exactly verified_ai_birthcert for the Verified one', () => {
    const p = tool('credential_preflight').inputSchema.properties.credential.description as string
    expect(p).toMatch(/exactly .?verified_ai_birthcert/i)
  })

  it('the plugin skill has a section on which AI Birthcert, with the options, the held check and the order', () => {
    expect(SECTION).not.toBe('')
    expect(SECTION).toMatch(/does not say which kind/i)
    expect(SECTION).toMatch(/already holds/i)
    expect(SECTION).toMatch(/one after the other, Basic first/i)
    expect(SECTION).toMatch(/replacement is its own explicit choice/i)
    expect(SECTION).toMatch(/Each has its own price and needs its own yes/i)
  })

  // Review R1-M3: one rule about what to offer, the same in every text.
  it('offers the kind the user does NOT hold, in the note, the skill and the user guide', () => {
    expect(aiBirthcertChoice('verified')).toMatch(/offer only the kind or kinds they do not already hold/i)
    expect(SECTION).toMatch(/If they hold Verified, offer Basic as an extra/i)
    expect(SECTION).not.toMatch(/offer Basic only if they ask/i)
    expect(GUIDE).toMatch(/offers only the kind you do not already have/i)
  })

  // Review R1-M4: Verified is off by default on mainnet, but a wallet can have it configured there.
  it('says Verified is unavailable where it is NOT CONFIGURED (mainnet by default), not that it is always unavailable on mainnet', () => {
    expect(SECTION).toMatch(/not configured/i)
    expect(SECTION).not.toMatch(/not available through this plugin/i)
    expect(GUIDE).not.toMatch(/Verified kind is not available through this plugin/i)
    expect(GUIDE).toMatch(/not configured/i)
  })

  // Review R2-M1: an older sentence told the agent the user "most likely wants" Basic and to use subscribe_and_issue, which
  // is the defect itself (and can charge the Basic fee without ever offering Verified).
  it('no tool text says the user most likely wants the Basic one, or tells the agent to go straight to subscribe_and_issue for it', () => {
    expect(allToolText()).not.toMatch(/most likely want/i)
    // Pointing the agent at subscribe_and_issue is fine once the user has said Basic; the old wording made it the default.
    expect(allToolText()).not.toMatch(/did NOT ask for a .{0,3}verified.{0,3} credential specifically/i)
  })

  it('request_ai_birthcert_verification says: if the request does not say which kind, do not start it; check both and ask', () => {
    const d = tool('request_ai_birthcert_verification').description
    expect(d).toMatch(/does not say which kind/i)
    expect(d).toMatch(/do not start this/i)
    expect(d).toMatch(/both kinds/i)
    expect(d).toMatch(/choice/)
  })

  it('subscribe_and_issue also says to ask first when the request does not say which kind', () => {
    const d = tool('subscribe_and_issue').description
    expect(d).toMatch(/did not say which kind, ask first/i)
  })

  it('prove_identity says what to do when several credentials are held', () => {
    const t = tool('prove_identity')
    const text = t.description + ' ' + (t.inputSchema.properties.vc.description ?? '')
    expect(text).toMatch(/several|more than one|multiple/i)
    expect(text).toMatch(/Verified/)
    expect(text).toMatch(/say which/i)
  })

  // Review R2-L6: "not configured" must not read as "you can configure it" in a plugin that has no setting for it.
  it('the user guide says the plugin has no setting for it', () => {
    expect(GUIDE).toMatch(/this plugin has no setting for it/i)
  })

  // Review R2-L5
  it('the README sentence about the choice note starts a new sentence', () => {
    expect(README).toMatch(/nothing is held"\. When a user asks for an AI Birthcert/)
  })

  // Review R2-L7: mainnet has no default SSIVC URL (the URL in code is an unverified constant that is not used).
  it('the README does not call the mainnet SSIVC URL auto-derived', () => {
    const row = README.split('\n').find((l) => l.startsWith('| `SSIVC_BASE_URL`')) ?? ''
    expect(row).toMatch(/no default on mainnet/i)
    expect(row).not.toMatch(/Auto-derived per network/i)
  })

  it('the skill says the same about presenting when both are held', () => {
    expect(SKILL).toMatch(/prefer the Verified/i)
  })
})

// Review R1-M2: SSIVC's uniqueness check may run before the fee is deducted, and the wallet makes no claim either way.
describe('what the texts say about the fee when a name is taken', () => {
  // Also catches "a taken name costs the fee" / "a refused name is charged", not only the one phrasing that was there.
  const CLAIM = /still costs the fee|still gets charged|a duplicate name still|fee is lost|(?:taken|duplicate|refused)[^.\n]{0,60}(?:costs? the fee|is charged|are charged|loses? the fee|forfeit)/i

  it('the skill never says a refused name costs the fee', () => {
    expect(SKILL).not.toMatch(CLAIM)
  })

  // Review R2-L2: the phrase is in two places in the skill, so each is checked on its own.
  it('the skill says it cannot be confirmed in the options section AND in the before-spending step', () => {
    expect(SECTION).toMatch(/cannot be confirmed/i)
    expect(STEP5).not.toBe('')
    expect(STEP5).toMatch(/cannot be confirmed/i)
  })

  it('the README and the user guide never say it either', () => {
    expect(README).not.toMatch(CLAIM)
    expect(GUIDE).not.toMatch(CLAIM)
  })

  it('no tool text says it either', () => {
    expect(allToolText()).not.toMatch(CLAIM)
  })

  it('the choice note does not', () => {
    expect(aiBirthcertChoice('verified')).not.toMatch(CLAIM)
    expect(aiBirthcertChoice('basic')).not.toMatch(CLAIM)
  })
})

describe('the user answers with a short phrase when asked for a name', () => {
  // Review R1-M1: the answer is the name, but nothing is paid with a name, or tidied, the user has not agreed to.
  const rules = (text: string) => {
    expect(text).toMatch(/that IS the name/i)
    expect(text).toMatch(/do not ask for it again/i)
    expect(text).toMatch(/optional and never needed/i)
    expect(text).toMatch(/WAIT for their answer/)
    expect(text).toMatch(/only after a yes/i)
    // Review R2-L1: the clause that stops a payment going ahead on a name the user has not agreed to.
    expect(text).toMatch(/Never go ahead on a name, or on a payment, that the user has not agreed to/)
    expect(text).toMatch(/only an example/i)
  }

  it('subscribe_and_issue: the attributes text', () => {
    rules(tool('subscribe_and_issue').inputSchema.properties.attributes.description as string)
  })

  it('request_ai_birthcert_verification: the agentName text', () => {
    rules(tool('request_ai_birthcert_verification').inputSchema.properties.agentName.description as string)
  })

  it('still never invents a name', () => {
    expect(tool('subscribe_and_issue').inputSchema.properties.attributes.description).toMatch(/NEVER invent/)
    expect(tool('request_ai_birthcert_verification').inputSchema.properties.agentName.description).toMatch(/NEVER invent/)
  })

  it('the plugin skill carries the same rule', () => {
    expect(SKILL).toMatch(/that IS the name/i)
    expect(SKILL).toMatch(/do not ask for it again/i)
    expect(SKILL).toMatch(/optional and never needed/i)
    expect(SKILL).toMatch(/WAIT for their answer/)
    expect(SKILL).toMatch(/only after a yes/i)
    expect(SKILL).toMatch(/Never go ahead on a name, or on a payment, that the user has not agreed to/)
  })

  // Review R1-M1: this wording could be read as "ask, then carry on without waiting", with a payment next.
  it('no text tells the agent to "go ahead" on a name, a tidied name or a payment before the user has answered', () => {
    expect(allToolText()).not.toMatch(/then go ahead/i)
    expect(SKILL).not.toMatch(/then go ahead/i)
  })

  // Review R2-L4: a slug-style example (qa-agent-01) made a name with spaces and capitals look wrong to the model.
  it('no tool text or skill holds up a slug-style example name', () => {
    expect(allToolText()).not.toMatch(/qa-agent-\d+|my-agent-\d+|agent-name-\d+/i)
    expect(SKILL).not.toMatch(/qa-agent-\d+|my-agent-\d+|agent-name-\d+/i)
  })

  // Review R1-L3: the name-in-use refusal legitimately asks for a different name.
  it('the "do not ask again" rule has the refused-name exception, so it does not forbid the retry the error asks for', () => {
    const text = tool('request_ai_birthcert_verification').inputSchema.properties.agentName.description as string
    expect(text).toMatch(/unless it was refused/i)
  })
})

// Links 2 and 3 replayed the first payment, but the agent told the user it had paid three times:
// the description said the tool spends "per call" and nothing said a new link after an expired one is free.
describe('a new link after an expired one is not another fee', () => {
  it('request_ai_birthcert_verification says a new link after an expired one reuses the earlier payment', () => {
    const d = tool('request_ai_birthcert_verification').description
    expect(d).toMatch(/new link after an expired one/i)
    expect(d).toMatch(/reuses the payment already made/i)
    expect(d).toMatch(/only used up once the credential is issued/i)
  })

  it('request_ai_birthcert_verification tells the agent to count a fee only when paidThisCall is true', () => {
    const d = tool('request_ai_birthcert_verification').description
    expect(d).toMatch(/paidThisCall/)
    expect(d).toMatch(/count a fee only when paidThisCall is true/i)
  })

  it('no request_ai_birthcert_verification text says every call pays', () => {
    expect(tool('request_ai_birthcert_verification').description).not.toMatch(/per call/i)
  })

  it('the skill and the README say the same', () => {
    expect(SKILL).toMatch(/new link after an expired one/i)
    expect(SKILL).toMatch(/paidThisCall/)
    expect(README).toMatch(/paidThisCall/)
  })
})

describe('credential_preflight on an earlier payment not used yet', () => {
  it('names unusedPayment and says not to ask the user to agree to a fee for the next link', () => {
    const d = tool('credential_preflight').description
    expect(d).toMatch(/unusedPayment/)
    expect(d).toMatch(/do not ask the user to agree to a fee/i)
  })
})

describe('subscribe_and_issue on a credential already held', () => {
  it('says a cache hit is issued: false with alreadyHeld, and is not to be reported as just issued', () => {
    const d = tool('subscribe_and_issue').description
    expect(d).toMatch(/issued: false, alreadyHeld: true/)
    expect(d).toMatch(/never tell the user it was just issued/i)
    expect(d).toMatch(/differsFromRequest/)
  })
})

// the paid issuance tools ask before they pay, and say what to do next as a field.
describe('confirm before paying, and nextStep', () => {
  it.each(['request_ai_birthcert_verification', 'subscribe_and_issue'])('%s has a confirm input that is the user\'s explicit yes', (name) => {
    const confirm = tool(name).inputSchema.properties.confirm
    expect(confirm, 'confirm input').toBeDefined()
    expect(confirm.description).toMatch(/explicit yes/i)
    expect(confirm.description).toMatch(/never on your own judgement/i)
  })

  it.each(['request_ai_birthcert_verification', 'subscribe_and_issue'])('%s says an unconfirmed paid call stops at the price and pays nothing', (name) => {
    const d = tool(name).description
    expect(d).toMatch(/needsConfirmation/)
    expect(d).toMatch(/without a confirmed price/i)
    expect(d).toMatch(/askUser/)
  })

  it('request_ai_birthcert_verification says a call that pays nothing needs no confirm', () => {
    expect(tool('request_ai_birthcert_verification').description).toMatch(/needs no confirm/i)
  })

  it.each(['request_ai_birthcert_verification', 'subscribe_and_issue', 'credential_preflight'])('%s names nextStep', (name) => {
    expect(tool(name).description).toMatch(/nextStep/)
  })

  it('the skill says both paid tools need confirm: true after the user\'s yes', () => {
    expect(SKILL).toMatch(/confirm: true/)
    expect(SKILL).toMatch(/needsConfirmation/)
    expect(SKILL).toMatch(/nextStep/)
  })
})

describe('no text contradicts the new contracts', () => {
  // M1: a plain cache hit is issued: false, alreadyHeld: true now.
  it('no subscribe_and_issue text says a cache hit is issued: true', () => {
    const t = tool('subscribe_and_issue')
    const all = [t.description, ...Object.values(t.inputSchema.properties).map((p) => p.description ?? '')].join(' ')
    expect(all).not.toMatch(/issued: true/)
  })

  // L1: a loose Verified name is priced as the Verified one now.
  it('credential_preflight does not say every "birthcert" name is priced as the Basic one', () => {
    const text = tool('credential_preflight').inputSchema.properties.credential.description as string
    expect(text).not.toMatch(/any name containing "birthcert" is priced as the Basic one/i)
    expect(text).toMatch(/a name that says verified/i)
  })

  // M2: the Doc1 failure was quoting a fee for a link that reuses an earlier payment.
  it('the skill makes the fee exception for unusedPayment, and the README lists the field', () => {
    expect(SKILL).toMatch(/unusedPayment/)
    expect(SKILL).toMatch(/do not quote the fee as a charge/i)
    expect(README).toMatch(/unusedPayment\?/)
  })
})

describe('balances are quoted as display, with the null-decimals exception', () => {
  it('SKILL.md says display is not whole tokens when decimals is null', () => {
    expect(SKILL).toMatch(/If `decimals` is `null`, `display` is not whole tokens/)
    expect(SKILL).toMatch(/could not be converted to whole tokens/)
  })

  it('the README tells the reader to quote display, and says what null decimals means, in both places it describes balances', () => {
    expect(README).toMatch(/tokenBalance: { token, balance, decimals, display }/)
    expect(README).toMatch(/Quote `display`, the same amount in whole tokens/)
    expect(README.match(/could not be converted/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('neither document brings back the instruction to divide by 10^decimals', () => {
    for (const doc of [SKILL, README]) {
      expect(doc).not.toMatch(/Divide by `10^decimals`/i)
      expect(doc).not.toMatch(/divide `balance` by `10^decimals`/i)
    }
  })
})

describe('confirm is the quote echoed back, and an expired credential still stops at the price', () => {
  it.each(['request_ai_birthcert_verification', 'subscribe_and_issue'])('%s: confirm is the quote object, unchanged, and true is not accepted', (name) => {
    const t = tool(name)
    const all = [t.description, t.inputSchema.properties.confirm.description ?? ''].join(' ')
    expect(all).toMatch(/quote object/i)
    expect(all).toMatch(/unchanged/i)
    expect(all).toMatch(/confirm: true is not accepted|including true/i)
    expect(t.description).toMatch(/token, amount, payee or gas model/i)
    expect(t.description).not.toMatch(/call again with confirm: true/i)
  })

  it('request_ai_birthcert_verification says a refused sponsored option is offered as a new price, never switched silently', () => {
    expect(tool('request_ai_birthcert_verification').description).toMatch(/self-pay price/i)
  })

  it('no text says replacing an expired Verified credential needs no confirmation at all', () => {
    expect(tool('request_ai_birthcert_verification').description).not.toMatch(/proceeds automatically/i)
    expect(SKILL).not.toMatch(/replaced automatically, no confirmation needed/i)
    expect(README).not.toMatch(/replaced automatically, no confirmation needed/i)
    expect(tool('request_ai_birthcert_verification').description).toMatch(/still stops at the price/i)
  })

  it('credential_preflight lists confirm_kind_then_collect_details', () => {
    expect(tool('credential_preflight').description).toMatch(/confirm_kind_then_collect_details/)
  })

  it('the skill says to echo the quote, not confirm: true, for the two issuance tools', () => {
    expect(SKILL).toMatch(/confirm` set to that exact `quote`/i)
  })
})

// the published schema is the only type contract the host and model see. Declared boolean,
// a model following it could only send true, which is refused, so paid issuance could never complete.
describe('confirm is declared as the quote object in the schema', () => {
  it.each(['request_ai_birthcert_verification', 'subscribe_and_issue'])('%s declares confirm as an object with the quote fields', (name) => {
    const confirm = tool(name).inputSchema.properties.confirm as unknown as {
      type: string
      properties: Record<string, { type: string; enum?: string[] }>
      required: string[]
    }
    expect(confirm.type).toBe('object')
    expect(Object.keys(confirm.properties).sort()).toEqual(['asset', 'assetSymbol', 'gasModel', 'maxAmountRequired', 'payTo'])
    expect(confirm.properties.gasModel.enum).toEqual(['sponsored', 'self'])
    expect(confirm.required.sort()).toEqual(['asset', 'gasModel', 'maxAmountRequired'])
  })

  it('every next step a result can carry is named for the agent', () => {
    for (const step of ['show_credential', 'follow_message', 'ask_user_to_confirm_payment', 'show_link_and_wait', 'wait_then_check']) {
      expect(SKILL, step).toContain(step)
    }
    expect(SKILL).not.toMatch(/relay_and_stop/)
  })
})

describe('docs match the behaviour', () => {
  it('the README does not say a refused sponsored option falls back to self-pay on its own', () => {
    expect(README).not.toMatch(/automatically falls back to paying gas itself/i)
    expect(README).toMatch(/self-pay price/i)
  })
})
