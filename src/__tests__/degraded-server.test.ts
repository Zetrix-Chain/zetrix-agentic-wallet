import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createDegradedServer, flattenError } from '../degraded-server'

const TOOLS = [
  { name: 'wallet_status', description: 'status', inputSchema: { type: 'object', properties: {} } },
  { name: 'transfer_token', description: 'send', inputSchema: { type: 'object', properties: {} } },
]

async function connect(reason: string) {
  const server = createDegradedServer({ reason, version: '9.9.9', tools: () => TOOLS })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' }, { capabilities: {} })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return { client, close: async () => { await client.close(); await server.close() } }
}

describe('degraded server: the wallet could not start, but the agent still hears why', () => {
  it('lists the normal tools, so the host and the agent see a wallet instead of nothing', async () => {
    const { client, close } = await connect('the saved account is not on this network')
    const listed = await client.listTools()
    expect(listed.tools.map((t) => t.name)).toEqual(['wallet_status', 'transfer_token'])
    await close()
  })

  it('answers every tool with the reason and marks it as an error', async () => {
    const { client, close } = await connect('the saved account is not on this network')

    for (const name of ['wallet_status', 'transfer_token']) {
      const res = await client.callTool({ name, arguments: {} })
      expect(res.isError).toBe(true)
      const block = (res.content as Array<{ type: string; text: string }>)[0]
      const body = JSON.parse(block.text) as Record<string, string>
      expect(body.error).toBe('wallet_failed_to_start')
      expect(body.reason).toBe('the saved account is not on this network')
      expect(body.message).toContain('the saved account is not on this network')
    }
    await close()
  })

  it('tells the agent to report the cause and not to retry, because a retry fails the same way', async () => {
    const { client, close } = await connect('x')
    const res = await client.callTool({ name: 'wallet_status', arguments: {} })
    const body = JSON.parse((res.content as Array<{ text: string }>)[0].text) as Record<string, string>
    expect(body.nextStep).toMatch(/do not retry/i)
    expect(body.nextStep).toMatch(/restart/i)
    await close()
  })

  it('answers a tool it does not know with the same startup error, not a protocol crash', async () => {
    const { client, close } = await connect('x')
    const res = await client.callTool({ name: 'no_such_tool', arguments: {} })
    expect(res.isError).toBe(true)
    await close()
  })
})

describe('flattenError', () => {
  it('joins a cause chain so the real reason is not lost behind a wrapper message', () => {
    const root = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    const wrapped = new Error('Wallet BE request failed', { cause: root })
    expect(flattenError(wrapped)).toBe('Wallet BE request failed <- ECONNREFUSED: ECONNREFUSED')
  })

  it('stops at a bounded depth', () => {
    let e: Error = new Error('end')
    for (let i = 0; i < 20; i++) e = new Error(`level ${i}`, { cause: e })
    expect(flattenError(e).split(' <- ').length).toBeLessThanOrEqual(8)
  })

  it('handles a thrown string', () => {
    expect(flattenError('plain')).toBe('plain')
  })
})
