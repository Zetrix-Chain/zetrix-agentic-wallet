/**
 * zetrixHexStringToBytes — exact port of `org.zetrix.encryption.utils.hex.HexFormat.hexStringToBytes`
 * (zetrix-encryption 1.0.0, the version MBI depends on).
 *
 * MBI's holder-signature path signs/verifies over `HexFormat.hexStringToBytes(data)`, where `data`
 * is the **raw canonical JSON string** — see `mbi-vc-service`:
 *   - `strategy/ApplyVcRest.java:120` — signs `HexFormat.hexStringToBytes(writeValueAsString(list))`
 *   - `x402/service/HolderSignatureVerifier.java:61` — verifies `HexFormat.hexStringToBytes(data)`
 * The issuance path then `objectMapper.readTree(data)`s the SAME raw-JSON string.
 *
 * This is a LENIENT, non-throwing decoder (NOT utf8, NOT a strict hex parse):
 *   - null/empty → null
 *   - uppercases the input, then walks `floor(len/2)` char-pairs (an odd trailing char is dropped)
 *   - each nibble = `"0123456789ABCDEF".indexOf(char)` → -1 for any non-hex char
 *   - byte = `(hi << 4 | lo)` truncated to 8 bits (so a non-hex pair yields 0xFF)
 *
 * The holder must sign THESE bytes, not `utf8(data)`, or MBI returns `401 X402_SIGNATURE_INVALID`.
 * Verified byte-identical against the real jar for the raw-JSON payload (2026-07-16).
 */
export function zetrixHexStringToBytes(s: string): Buffer {
  const up = s.toUpperCase()
  const len = Math.floor(up.length / 2)
  const out = Buffer.alloc(len)
  const HEX = '0123456789ABCDEF'
  for (let i = 0; i < len; i++) {
    const pos = i * 2
    const hi = HEX.indexOf(up[pos])
    const lo = HEX.indexOf(up[pos + 1])
    out[i] = ((hi << 4) | lo) & 0xff
  }
  return out
}
