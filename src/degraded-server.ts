/**
 * What the wallet runs instead of exiting when it cannot start.
 *
 * A wallet that exits during startup registers no tools at all. The host then reports "Connection
 * closed", and the agent can only say that its wallet tools are "not available", with nothing about why.
 * This server keeps the process alive with the normal tool list, and every call answers with the reason
 * the wallet could not start. Nothing in it can reach Wallet BE, the chain or any saved account, so it
 * can never act for the user.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export interface DegradedServerOptions {
  /** Why the wallet could not start, in words the user can act on. */
  reason: string
  version: string
  tools: () => unknown[]
}

/**
 * A thrown error as one line: the message, then each cause with its code. A wrapped SDK error keeps its
 * real cause on `.cause` and the MCP transport would otherwise show only the top message.
 */
export function flattenError(err: unknown): string {
  const chain: string[] = []
  let e: unknown = err
  while (e instanceof Error && chain.length < 8) {
    const code = (e as { code?: string }).code
    chain.push(code ? `${code}: ${e.message}` : e.message)
    e = (e as { cause?: unknown }).cause
  }
  return chain.length ? chain.join(' <- ') : String(err)
}

export function createDegradedServer(opts: DegradedServerOptions): Server {
  const server = new Server({ name: 'agentic-wallet-mcp', version: opts.version }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools() as never }))
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'wallet_failed_to_start',
          reason: opts.reason,
          message: `The wallet did not start, so nothing was done and no funds were touched. Reason: ${opts.reason}`,
          nextStep:
            'Tell the user the wallet needs fixing on its host and give them the reason above. Do not retry this tool: ' +
            'it will fail the same way until the wallet is restarted after the cause is fixed.',
        }),
      },
    ],
  }))
  return server
}
