/**
 * Builds the MCP `content` array for a tool call result.
 *
 * A remote MCP client (e.g. OpenClaw's gateway) runs this server on a machine the caller has no
 * filesystem access to — a local file path (`vcPassImagePaths`, from subscribe_and_issue /
 * check_ai_birthcert_verification) is meaningless there. So whenever a result carries
 * `vcPassImagePaths`, each file is read and embedded as its own base64 `image` content block,
 * alongside the usual JSON `text` block, so the pass design actually travels with the response.
 */

export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ImageContentBlock {
  type: 'image'
  data: string
  mimeType: string
}

export type ToolContentBlock = TextContentBlock | ImageContentBlock

function extractVcPassImagePaths(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return []
  const paths = (result as Record<string, unknown>).vcPassImagePaths
  if (!Array.isArray(paths)) return []
  return paths.filter((p): p is string => typeof p === 'string')
}

/**
 * A QR code (create_verification_qr) arrives as base64 PNG on the result. It goes out as an image block and is
 * dropped from the JSON text, where a few kilobytes of base64 would only crowd the model's context.
 */
function splitQrCode(result: unknown): { text: unknown; qrCodePngBase64?: string } {
  if (typeof result !== 'object' || result === null) return { text: result }
  const { qrCodePngBase64, ...rest } = result as Record<string, unknown>
  if (typeof qrCodePngBase64 !== 'string' || qrCodePngBase64 === '') return { text: result }
  return { text: rest, qrCodePngBase64 }
}

export async function buildToolContent(result: unknown, readFile: (path: string) => Promise<Buffer>): Promise<ToolContentBlock[]> {
  const { text, qrCodePngBase64 } = splitQrCode(result)
  const blocks: ToolContentBlock[] = [{ type: 'text', text: JSON.stringify(text) }]
  if (qrCodePngBase64 !== undefined) blocks.push({ type: 'image', data: qrCodePngBase64, mimeType: 'image/png' })

  for (const path of extractVcPassImagePaths(result)) {
    // Best-effort: an unreadable pass image must never hide the rest of the (already-issued,
    // already-paid-for) result — the text block above still carries the path for troubleshooting.
    try {
      const data = await readFile(path)
      blocks.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' })
    } catch {
      /* skip this one image */
    }
  }

  return blocks
}
