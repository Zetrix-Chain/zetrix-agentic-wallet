import { describe, it, expect, vi } from 'vitest'
import { proveIdentity } from '../orchestrator/prove'
import type { X401Wallet } from 'x401-zetrix-client'

describe('proveIdentity', () => {
  it('delegates to X401Wallet.respondToChallenge and shapes the tool result', async () => {
    const wallet = {
      respondToChallenge: vi.fn().mockResolvedValue({
        headerValue: 'PROOF-RESPONSE-HDR',
        verified: true,
        presentationId: 'req-1',
        payloadJson: '{}',
        signature: 's',
        timestamp: 't',
        status: 'VERIFIED',
      }),
    } as unknown as X401Wallet

    const out = await proveIdentity(wallet, 'REQ-HEADER', 'did:zid:holder')

    expect(wallet.respondToChallenge).toHaveBeenCalledWith('REQ-HEADER', 'did:zid:holder')
    expect(out).toEqual({ proofResponseHeader: 'PROOF-RESPONSE-HDR', verified: true, presentationId: 'req-1' })
  })
})
