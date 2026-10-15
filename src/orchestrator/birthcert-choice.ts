/**
 * The note every AI Birthcert preflight result carries.
 *
 * "Get me AI Birth VC" does not say Basic or Verified, and nothing in the wallet reads the request: the agent chooses by
 * the tool and the credential it names first. It chose differently in different chats, and never asked the user. The
 * first tool it calls is credential_preflight, so that is where it is told what to do, in the result it is looking at.
 *
 * Guidance only. It changes nothing about what is priced or whether the wallet is ready.
 *
 * It makes no claim about what a refused name costs: the wallet deliberately does not (agentNameInUseMessage), because
 * SSIVC's own uniqueness check may run before the fee is deducted.
 */

export type AiBirthcertKind = 'basic' | 'verified'

export function aiBirthcertChoice(kind: AiBirthcertKind, opts: { unavailable?: boolean } = {}): string {
  const note =
    'AI Birthcert comes in two kinds. BASIC: self-declared by the agent, with no check of the owner\'s identity; it is quick, shows only the agent\'s username, and does not mean the owner was verified. ' +
    'VERIFIED: the owner\'s identity is confirmed through MyDigital ID; the fee is paid up front, the owner completes a check in the MyDigital ID app (not the MyID wallet, which is only for a verification QR), and the agent name must be unique ' +
    '(the name is only checked after payment, so a name that turns out to be taken is refused late, and whether the fee was spent cannot be confirmed). ' +
    'Each kind has its own price, read from the check for that kind: never assume Basic is free. ' +
    `This result is for the ${kind === 'basic' ? 'BASIC' : 'VERIFIED'} one. ` +
    'If the user has not said which kind they want (they did not say "verified" or "basic", and did not mention MyDigital ID or owner verification), do not start either: ' +
    'run this check for both kinds (it is free) to see what the wallet already holds, tell the user the difference in plain words, offer only the kind or kinds they do not already hold, and ask which they prefer. ' +
    'If they want both, issue them one after the other, Basic first, and finish and show the first before starting the second; ' +
    'each has its own price and needs its own yes, so "both" is not a yes to either payment. ' +
    'Holding one kind never blocks the other, and replacing one that is held is its own explicit choice.'
  return opts.unavailable ? note + ' The Verified kind is not available on this wallet or network: say so, and offer the Basic one only.' : note
}
