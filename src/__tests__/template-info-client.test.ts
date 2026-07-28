import { describe, it, expect, vi } from 'vitest'
import { fetchTemplateFields } from '../clients/template-info-client.js'

const TEMPLATE_ID = 'did:zid:c042e49e55ffe1b0ee835e6a8b3d1aec720fb1cb01dca17c4b3e5c2194949a6c'
const REGISTRY = 'ZTX3JszqPgRUx743SAp7q7zURfjvkWuH2FMEz'
const NODE = 'https://test-node.zetrix.com'
const KEY = `template__${TEMPLATE_ID}`

// The real applyFormat shape (agentDid/agentName/purpose mandatory; controllerName/Did optional).
const APPLY_FORMAT = JSON.stringify([
  { key: 'agentDid', type: 3, format: 'String', attribute: 'Agent DID', mandatory: 1 },
  { key: 'agentName', type: 3, format: 'String', attribute: 'Agent Name', mandatory: 1 },
  { key: 'controllerName', type: 3, format: 'String', attribute: 'Controller Name', mandatory: 0 },
  { key: 'controllerDid', type: 3, format: 'String', attribute: 'Controller DID', mandatory: 0 },
  { key: 'purpose', type: 3, format: 'String', attribute: 'Agent Purpose', mandatory: 1 },
])

/** A getAccountMetaData success envelope carrying `value` as the template's JSON string. */
function ok(value: string) {
  return { error_code: 0, result: { [KEY]: { key: KEY, value } } }
}

function templateValue(applyFormat: string | undefined) {
  const obj: Record<string, unknown> = { issuerAddress: 'ZTXissuer', templateId: TEMPLATE_ID }
  if (applyFormat !== undefined) obj.applyFormat = applyFormat
  return JSON.stringify(obj)
}

describe('fetchTemplateFields', () => {
  it('returns both the mandatory:1 subset and the full declared key set, and builds the correct getAccountMetaData URL', async () => {
    const query = vi.fn().mockResolvedValue(ok(templateValue(APPLY_FORMAT)))

    const out = await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)

    expect(out).toEqual({
      required: ['agentDid', 'agentName', 'purpose'],
      allKeys: ['agentDid', 'agentName', 'controllerName', 'controllerDid', 'purpose'],
    })
    expect(query).toHaveBeenCalledWith(
      `${NODE}/getAccountMetaData?address=${encodeURIComponent(REGISTRY)}&key=${encodeURIComponent(KEY)}`,
    )
  })

  it('returns null on a non-zero error_code', async () => {
    const query = vi.fn().mockResolvedValue({ error_code: 4, result: null })
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })

  it('returns null when the template key is absent (result null)', async () => {
    const query = vi.fn().mockResolvedValue({ error_code: 0, result: null })
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })

  it('returns null when the template entry has no value', async () => {
    const query = vi.fn().mockResolvedValue({ error_code: 0, result: { [KEY]: { key: KEY } } })
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })

  it('returns null when value is not valid JSON', async () => {
    const query = vi.fn().mockResolvedValue(ok('not-json'))
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })

  it('returns null when applyFormat is not valid JSON', async () => {
    const query = vi.fn().mockResolvedValue(ok(templateValue('not-json-array')))
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })

  it('returns { required: [], allKeys: [] } when the template declares no applyFormat', async () => {
    const query = vi.fn().mockResolvedValue(ok(templateValue(undefined)))
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toEqual({ required: [], allKeys: [] })
  })

  it('drops entries with non-string or empty keys from both required and allKeys', async () => {
    const query = vi.fn().mockResolvedValue(
      ok(
        templateValue(
          JSON.stringify([
            { key: 'agentDid', mandatory: 1 },
            { key: 'ownerName', mandatory: 0 },
            { key: '', mandatory: 1 },
            { key: 42, mandatory: 1 },
            { mandatory: 1 },
          ]),
        ),
      ),
    )
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toEqual({
      required: ['agentDid'],
      allKeys: ['agentDid', 'ownerName'],
    })
  })

  it('returns null (not a throw) when the query itself rejects', async () => {
    const query = vi.fn().mockRejectedValue(new Error('node down'))
    expect(await fetchTemplateFields(TEMPLATE_ID, REGISTRY, NODE, query)).toBeNull()
  })
})
