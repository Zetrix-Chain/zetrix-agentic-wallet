import { describe, it, expect, vi } from 'vitest'
import { renderQrPng } from '../qr-png'
import {
  buildVerificationLink,
  createVerificationLink,
  DEFAULT_EXPIRY_MINUTES,
  MAX_EXPIRY_MINUTES,
  MAX_REVEAL_PATHS,
  type VerificationLinkDeps,
} from '../orchestrator/verification-qr'

const TEMPLATE = 'https://link.myid.test/agentic-verify?referenceId={referenceId}'
const NOW = Date.parse('2026-10-06T10:00:00.000Z')
const REVEAL = ['agentName']
const vc = { id: 'did:zid:vc-1', credentialSubject: { id: 'did:zid:holder', agentName: 'agent-007' } }

function makeDeps(over: Partial<VerificationLinkDeps> = {}) {
  const mbi = {
    createVp: vi.fn().mockResolvedValue({ blobId: 'blob-1', blob: 'beef' }),
    submitVp: vi.fn().mockResolvedValue({ id: 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77' }),
  }
  const signHexBlob = vi.fn().mockResolvedValue({ signBlob: 'signed-blob', publicKey: 'b001pk' })
  const signMessage = vi.fn().mockResolvedValue({ signBlob: 'sig', publicKey: 'b001pk' })
  const renderQr = vi.fn().mockResolvedValue(Buffer.from('png-bytes'))
  const deps: VerificationLinkDeps = {
    mbi,
    signHexBlob,
    signMessage,
    linkTemplate: TEMPLATE,
    renderQr,
    now: () => NOW,
    ...over,
  }
  return { deps, mbi, signHexBlob, signMessage, renderQr }
}

describe('buildVerificationLink', () => {
  it('puts the reference id into the template', () => {
    expect(buildVerificationLink(TEMPLATE, 'v2-abc')).toBe('https://link.myid.test/agentic-verify?referenceId=v2-abc')
  })

  it('URL-encodes the reference id so it cannot add or alter query parameters', () => {
    const link = buildVerificationLink(TEMPLATE, 'v2-a&b=c d#x')
    expect(link).toBe('https://link.myid.test/agentic-verify?referenceId=v2-a%26b%3Dc%20d%23x')
    expect(new URL(link).searchParams.get('referenceId')).toBe('v2-a&b=c d#x')
  })

  it('replaces every placeholder', () => {
    expect(buildVerificationLink('https://h.test/{referenceId}?r={referenceId}', 'v2-1')).toBe('https://h.test/v2-1?r=v2-1')
  })

  it('encodes a slash in the reference id so it cannot change the path', () => {
    expect(buildVerificationLink(TEMPLATE, 'v2-a/b')).toBe('https://link.myid.test/agentic-verify?referenceId=v2-a%2Fb')
  })

  it('accepts the placeholder in the path as well as in the query', () => {
    expect(buildVerificationLink('https://link.myid.test/v/{referenceId}', 'v2-1')).toBe('https://link.myid.test/v/v2-1')
  })

  // The template is operator-set, so these are misconfiguration rather than attack — but a link that opens
  // a script, or sends the reference id out through DNS or in cleartext, should never be handed to a person.
  it.each([
    ['http (cleartext)', 'http://link.myid.test/agentic-verify?referenceId={referenceId}'],
    ['a javascript: URL', 'javascript:alert({referenceId})'],
    ['a data: URL', 'data:text/html,{referenceId}'],
    ['an intent: URL', 'intent://verify?referenceId={referenceId}#Intent;scheme=myid;end'],
    ['a custom scheme', 'myid://agentic-verify?referenceId={referenceId}'],
    ['the placeholder in the host', 'https://{referenceId}.link.myid.test/agentic-verify'],
    ['the placeholder in the host even though the query has one too', 'https://{referenceId}.link.myid.test/v?referenceId={referenceId}'],
    ['the placeholder in the user info even though the query has one too', 'https://{referenceId}@link.myid.test/v?referenceId={referenceId}'],
    ['the placeholder in the user info', 'https://{referenceId}@link.myid.test/agentic-verify'],
    ['user info', 'https://user:pw@link.myid.test/agentic-verify?referenceId={referenceId}'],
    ['the placeholder only in the fragment', 'https://link.myid.test/agentic-verify#{referenceId}'],
    ['no host', 'https:///agentic-verify?referenceId={referenceId}'],
    // The URL parser ends the host at a backslash, and strips tabs and newlines, so a string check sees the
    // placeholder in the path while the link that is built opens at <id>.evil.com.
    ['a backslash that moves the host', 'https://\\{referenceId}.evil.com/p'],
    ['a backslash after the host', 'https://link.myid.test\\v?referenceId={referenceId}'],
    ['a tab in the host', 'https://link\t{referenceId}.evil.com/p'],
    ['a newline', 'https://link.myid.test/v?referenceId={referenceId}\n'],
    ['a space', 'https://link.myid.test/v ?referenceId={referenceId}'],
    // The two forms that actually got past the first version of this check
    ['a tab where the host should start', 'https://\t/{referenceId}.evil.com/p'],
    ['two backslashes where the host should start', 'https://\\\\/{referenceId}.evil.com/p'],
    // Non-ASCII: a combining mark next to the placeholder makes the host normalise to something without the marker
    ['a combining mark after the placeholder in the host', 'https://{referenceId}\u0301.evil.com/v?r={referenceId}'],
    ['a non-ASCII character anywhere', 'https://link.myid.test/v\u00e9?referenceId={referenceId}'],
    ['the marker text already in the path', 'https://link.myid.test/refidmarker#{referenceId}'],
    ['empty user info', 'https://@link.myid.test/v?referenceId={referenceId}'],
    ['an upper-case scheme the plugin schema would refuse', 'HTTPS://link.myid.test/v?referenceId={referenceId}'],
    ['the placeholder in the port', 'https://link.myid.test:{referenceId}/v?referenceId={referenceId}'],
  ])('throws when the template has %s', (_label, template) => {
    expect(() => buildVerificationLink(template, 'v2-1')).toThrow(/MYID_VERIFY_LINK_TEMPLATE/)
  })

  it.each([
    ['is empty', ''],
    ['has no placeholder', 'https://link.myid.test/agentic-verify'],
    ['is not an absolute URL', '/agentic-verify?referenceId={referenceId}'],
  ])('throws when the template %s', (_label, template) => {
    expect(() => buildVerificationLink(template, 'v2-1')).toThrow(/MYID_VERIFY_LINK_TEMPLATE/)
  })
})

describe('createVerificationLink', () => {
  it('creates a VP, submits it, and returns the link, the reference id, the expiry and a QR of that same link', async () => {
    const { deps, renderQr } = makeDeps()

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    const link = 'https://link.myid.test/agentic-verify?referenceId=v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77'
    expect(result).toMatchObject({
      created: true,
      link,
      referenceId: 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77',
      expiresAt: new Date(NOW + DEFAULT_EXPIRY_MINUTES * 60_000).toISOString(),
      expiresInMinutes: DEFAULT_EXPIRY_MINUTES,
      qrCodePngBase64: Buffer.from('png-bytes').toString('base64'),
    })
    // The QR must encode exactly the link the user is told to open, not a re-derived one.
    expect(renderQr).toHaveBeenCalledTimes(1)
    expect(renderQr).toHaveBeenCalledWith(link)
  })

  it('creates the VP with the VC and reveal list, signs the blob, and submits with the expiry and no includeVp', async () => {
    const { deps, mbi, signHexBlob, signMessage } = makeDeps()

    await createVerificationLink({ vc, revealAttribute: ['agentName'], expiryMinutes: 15 }, deps)

    expect(mbi.createVp).toHaveBeenCalledWith(
      { vc, revealAttributes: ['agentName'] },
      signMessage,
    )
    expect(signHexBlob).toHaveBeenCalledWith('beef')
    expect(mbi.submitVp).toHaveBeenCalledWith(
      { blobId: 'blob-1', signedBlob: 'signed-blob', publicKey: 'b001pk', vpExpiry: 15 },
      signMessage,
    )
    const submitBody = mbi.submitVp.mock.calls[0][0]
    expect('includeVp' in submitBody).toBe(false)
  })

  it('sends the default expiry explicitly', async () => {
    const { deps, mbi } = makeDeps()

    await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(DEFAULT_EXPIRY_MINUTES).toBe(5)
    expect(mbi.submitVp.mock.calls[0][0].vpExpiry).toBe(5)
  })

  describe('the reveal list that reaches MBI', () => {
    const agentVc = {
      id: 'did:zid:vc-2',
      credentialSubject: { id: 'did:zid:holder', agentIdentityCredential: { purpose: 'p', controllerName: 'c', agentName: 'a' } },
    }

    it('is in the credential\'s own order, without repeats', async () => {
      const { deps, mbi } = makeDeps()

      await createVerificationLink(
        { vc: agentVc, revealAttribute: ['agentIdentityCredential.agentName', 'agentIdentityCredential.purpose', 'agentIdentityCredential.agentName'] },
        deps,
      )

      expect(mbi.createVp.mock.calls[0][0].revealAttributes).toEqual(['agentIdentityCredential.purpose', 'agentIdentityCredential.agentName'])
    })

    it.each([
      ['a path the credential does not have', ['agentIdentityCredential.agentNmae']],
      ['a parent path that would disclose a whole subtree', ['agentIdentityCredential']],
    ])('refuses %s, before calling MBI, and says which', async (_label, revealAttribute) => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc: agentVc, revealAttribute }, deps)

      expect(result).toMatchObject({ created: false })
      expect((result as { reason: string }).reason).toContain(revealAttribute[0])
      expect(mbi.createVp).not.toHaveBeenCalled()
    })

    it('refuses a list longer than the cap', async () => {
      const { deps, mbi } = makeDeps()

      // every path exists in the credential, so only the cap can be what refuses
      const names = Array.from({ length: MAX_REVEAL_PATHS + 1 }, (_, i) => 'p' + i)
      const wide = { id: 'did:zid:vc-3', credentialSubject: Object.fromEntries(names.map((n) => [n, 'x'])) }

      const result = await createVerificationLink({ vc: wide, revealAttribute: names }, deps)

      expect(result).toMatchObject({ created: false })
      expect((result as { reason: string }).reason).toContain(`${MAX_REVEAL_PATHS + 1} paths`)
      expect((result as { reason: string }).reason).not.toMatch(/not a single attribute/)
      expect(mbi.createVp).not.toHaveBeenCalled()

      // and exactly the cap is accepted
      const ok = await createVerificationLink({ vc: wide, revealAttribute: names.slice(0, MAX_REVEAL_PATHS) }, deps)
      expect(ok).toMatchObject({ created: true })
    })
  })

  describe('naming an attribute the credential does not have', () => {
    // The agent does not choose which credential is presented, so it can name attributes of the wrong one.
    // The refusal lists the attribute names (never the values) so it can try again.
    it('lists the attributes the credential does have', async () => {
      const { deps } = makeDeps()
      const held = { id: 'did:zid:vc-4', credentialSubject: { id: 'did:zid:holder', aiBirthcert: { agentUsername: 'secret-value-1' } } }

      const result = await createVerificationLink({ vc: held, revealAttribute: ['verifiedAiBirthcert.agentName'] }, deps)

      const reason = (result as { reason: string }).reason
      expect(result).toMatchObject({ created: false })
      expect(reason).toContain('"verifiedAiBirthcert.agentName"')
      expect(reason).toContain('Attributes this credential has: aiBirthcert.agentUsername')
      expect(reason).not.toContain('secret-value-1')
    })

    it('shortens a very long list', async () => {
      const { deps } = makeDeps()
      const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['a' + i, 'v']))

      const result = await createVerificationLink({ vc: { credentialSubject: many }, revealAttribute: ['nope'] }, deps)

      expect((result as { reason: string }).reason).toMatch(/and 10 more/)
    })
  })

  describe('a credential the named paths cannot be checked against', () => {
    // A parent path discloses everything under it. If the wallet cannot see the credential's attributes it cannot
    // tell a parent from a leaf, so it must refuse rather than send the path on and report it as one attribute.
    it.each([
      ['has no credentialSubject', { id: 'no-subject' }],
      ['has a credentialSubject that is an array', { credentialSubject: [{ id: 'did:zid:h', agentIdentityCredential: { agentName: 'a' } }] }],
      ['is a JSON string', '{"credentialSubject":{"agentIdentityCredential":{"agentName":"a"}}}'],
      ['has a dotted attribute name', { credentialSubject: { 'a.b': 1, a: { b: { c: 1 } } } }],
    ])('refuses named paths when the credential %s, before calling MBI', async (_label, badVc) => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc: badVc, revealAttribute: ['agentIdentityCredential'] }, deps)

      expect(result).toMatchObject({ created: false })
      expect((result as { reason: string }).reason).toMatch(/cannot check/i)
      expect((result as { reason: string }).reason).toMatch(/revealAll/)
      expect(mbi.createVp).not.toHaveBeenCalled()
    })

    it('still allows revealAll for such a credential, since nothing is being narrowed', async () => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc: { id: 'no-subject' }, revealAll: true }, deps)

      expect(result).toMatchObject({ created: true })
      expect(mbi.createVp).toHaveBeenCalledTimes(1)
    })
  })

  describe('what the result says was revealed', () => {
    it('lists the named attributes, in the order sent, and names them in the message', async () => {
      const { deps } = makeDeps()

      const result = (await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)) as { revealed: unknown; message: string }

      expect(result.revealed).toEqual(['agentName'])
      expect(result.message).toContain('reveals: "agentName"')
    })

    it("says 'all' and names the whole credential when revealAll was chosen", async () => {
      const { deps } = makeDeps()

      const result = (await createVerificationLink({ vc, revealAll: true }, deps)) as { revealed: unknown; message: string }

      expect(result.revealed).toBe('all')
      expect(result.message).toMatch(/reveals the whole credential/)
    })
  })

  describe('what is revealed', () => {
    // A reference id is a handle to the stored presentation: anyone with a verifier client for the template can
    // read whatever it reveals until it expires. So the caller has to choose what that is.
    it.each([
      ['names no attribute', {}],
      ['names an empty list', { revealAttribute: [] }],
    ])('refuses, before calling MBI, when the caller %s and does not ask for everything', async (_label, extra) => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc, ...extra }, deps)

      expect(result).toMatchObject({ created: false })
      expect((result as { reason: string }).reason).toMatch(/revealAttribute/)
      expect((result as { reason: string }).reason).toMatch(/revealAll/)
      expect(mbi.createVp).not.toHaveBeenCalled()
    })

    it('reveals everything (an empty list to MBI) only when revealAll is true', async () => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc, revealAll: true }, deps)

      expect(result).toMatchObject({ created: true })
      expect(mbi.createVp.mock.calls[0][0].revealAttributes).toEqual([])
    })

    it('refuses revealAll together with named attributes, which say opposite things', async () => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc, revealAll: true, revealAttribute: REVEAL }, deps)

      expect(result).toMatchObject({ created: false })
      expect(mbi.createVp).not.toHaveBeenCalled()
    })

    it.each([
      ['a bare string', 'agentName'],
      ['a list holding a number', ['agentName', 7]],
      ['a list holding an empty string', ['agentName', '']],
      ['an object', { agentName: true }],
    ])('refuses revealAttribute that is %s, before calling MBI', async (_label, revealAttribute) => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc, revealAttribute: revealAttribute as never }, deps)

      expect(result).toMatchObject({ created: false })
      expect((result as { reason: string }).reason).toMatch(/revealAttribute/)
      expect(mbi.createVp).not.toHaveBeenCalled()
    })

    it.each([['yes'], [1], [{}]])('refuses a revealAll that is not a boolean (%j)', async (revealAll) => {
      const { deps, mbi } = makeDeps()

      const result = await createVerificationLink({ vc, revealAll: revealAll as never }, deps)

      expect(result).toMatchObject({ created: false })
      expect(mbi.createVp).not.toHaveBeenCalled()
    })
  })

  it('does not call MBI at all when no link template is configured', async () => {
    const { deps, mbi } = makeDeps({ linkTemplate: undefined })

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect((result as { reason: string }).reason).toMatch(/MYID_VERIFY_LINK_TEMPLATE/)
    expect(mbi.createVp).not.toHaveBeenCalled()
    expect(mbi.submitVp).not.toHaveBeenCalled()
  })

  it('does not call MBI when the configured template cannot hold a reference id', async () => {
    const { deps, mbi } = makeDeps({ linkTemplate: 'https://link.myid.test/agentic-verify' })

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect(mbi.createVp).not.toHaveBeenCalled()
  })

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['above the maximum', MAX_EXPIRY_MINUTES + 1],
  ])('rejects an expiry that is %s before calling MBI', async (_label, expiryMinutes) => {
    const { deps, mbi } = makeDeps()

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL, expiryMinutes }, deps)

    expect(result).toMatchObject({ created: false })
    expect((result as { reason: string }).reason).toMatch(/expiry/i)
    expect(mbi.createVp).not.toHaveBeenCalled()
  })

  it('accepts the maximum expiry', async () => {
    const { deps, mbi } = makeDeps()

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL, expiryMinutes: MAX_EXPIRY_MINUTES }, deps)

    expect(result).toMatchObject({ created: true, expiresInMinutes: MAX_EXPIRY_MINUTES })
    expect(mbi.submitVp.mock.calls[0][0].vpExpiry).toBe(MAX_EXPIRY_MINUTES)
  })

  it('returns no link when MBI refuses to create the VP', async () => {
    const { deps, mbi, renderQr } = makeDeps()
    mbi.createVp.mockRejectedValue(new Error('MBI vp/ext/create failed - HTTP 403: Authenticated DID does not match'))

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect((result as { reason: string }).reason).toContain('Authenticated DID does not match')
    expect(mbi.submitVp).not.toHaveBeenCalled()
    expect(renderQr).not.toHaveBeenCalled()
    expect('link' in result).toBe(false)
  })

  it('returns no link when the blob cannot be signed', async () => {
    const { deps, signHexBlob, mbi } = makeDeps()
    signHexBlob.mockRejectedValue(new Error('wallet backend unavailable'))

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect((result as { reason: string }).reason).toContain('wallet backend unavailable')
    expect(mbi.submitVp).not.toHaveBeenCalled()
  })

  it('returns no link when MBI refuses to submit the VP', async () => {
    const { deps, mbi } = makeDeps()
    mbi.submitVp.mockRejectedValue(new Error('MBI vp/ext/submit failed - HTTP 500'))

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect((result as { reason: string }).reason).toContain('HTTP 500')
    expect('link' in result).toBe(false)
  })

  it.each([
    ['no id', {}],
    ['an empty id', { id: '' }],
  ])('returns no link when the submit answer carries %s', async (_label, answer) => {
    const { deps, mbi } = makeDeps()
    mbi.submitVp.mockResolvedValue(answer)

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect('link' in result).toBe(false)
  })

  it('returns no link when create answers without a blob', async () => {
    const { deps, mbi } = makeDeps()
    mbi.createVp.mockResolvedValue({ blobId: 'blob-1' })

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: false })
    expect(mbi.submitVp).not.toHaveBeenCalled()
  })

  it('still returns the usable link, without a QR, when rendering the QR fails', async () => {
    const { deps, renderQr } = makeDeps()
    renderQr.mockRejectedValue(new Error('qr failed'))

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({
      created: true,
      link: 'https://link.myid.test/agentic-verify?referenceId=v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77',
    })
    expect('qrCodePngBase64' in result).toBe(false)
    expect((result as { qrError: string }).qrError).toContain('qr failed')
  })

  it('measures the expiry from before the submit, so the reported time is never later than MBI\'s own', async () => {
    const { deps, mbi } = makeDeps()
    const now = vi.fn().mockReturnValueOnce(NOW).mockReturnValue(NOW + 90_000)
    mbi.submitVp.mockImplementation(async () => {
      expect(now).toHaveBeenCalledTimes(1) // already read before MBI was asked
      return { id: 'v2-3f2b9c1e-7a44-4d0e-9b61-0c5d2a8e1f77' }
    })

    const result = (await createVerificationLink({ vc, revealAttribute: REVEAL }, { ...deps, now })) as { expiresAt: string; message: string }

    expect(result.expiresAt).toBe(new Date(NOW + DEFAULT_EXPIRY_MINUTES * 60_000).toISOString())
    expect(result.message).toMatch(/about/)
  })

  it('keeps the usable link and reports qrError when the link is too long for a QR code', async () => {
    const { deps } = makeDeps({
      linkTemplate: `https://link.myid.test/${'a'.repeat(3000)}?referenceId={referenceId}`,
      renderQr: renderQrPng,
    })

    const result = await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)

    expect(result).toMatchObject({ created: true })
    expect((result as { link: string }).link).toContain('referenceId=v2-3f2b9c1e')
    expect('qrCodePngBase64' in result).toBe(false)
    expect((result as { qrError: string }).qrError).toMatch(/too long/i)
  })

  it('tells the agent what to say, including the expiry and that MyID must be installed', async () => {
    const { deps } = makeDeps()

    const result = (await createVerificationLink({ vc, revealAttribute: REVEAL }, deps)) as { message: string }

    expect(result.message).toMatch(/MyID/)
    expect(result.message).toContain(new Date(NOW + DEFAULT_EXPIRY_MINUTES * 60_000).toISOString())
  })
})
