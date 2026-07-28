# HSM Wallet Operations — API Docs

HSM (Hardware Security Module)-backed wallet creation and signing, using
Thales Luna Cloud HSM-managed Ed25519 key pairs via Zetrix's HSM service.
Nothing is persisted server-side — every response is a direct pass-through
of the HSM result for that call.

Ref: https://docs.zetrix.com/en/developer-resources/blockchain-as-a-services-baas/zetrix-service/hsm

## Servers

| Network | Base URL |
|---|---|
| `zetrix:testnet` | `https://wallet-api.myegdev.com/server` |
| `zetrix:mainnet` | `https://wallet-api.zetrix.com/server` |

All endpoints below are relative to one of these base URLs (both already include `/server`) —
e.g. `https://wallet-api.myegdev.com/server/wallet/hsm/account/create` on testnet.

## Response Envelope

Every endpoint always returns **HTTP 200**. Success/failure is determined
by `errorCode` in the body:

```json
{
  "errorCode": 0,
  "message": "SUCCESS",
  "data": { }
}
```

| `errorCode` | Meaning |
|---|---|
| `0` | Success |
| `1` (`PARAME_ERROR`) | Request failed Bean Validation — returned **before** any HSM call. `data` is `{ "errorList": ["field：message"] }` |
| `1000026` (`HSM_SERVICE_ERROR`) | The HSM sandbox call failed (transport error, unparseable/empty response, missing expected fields). `data` is `null` |
| `400000` (`SYS_ERROR`) | Unexpected internal error. `data` is `null` |

## Endpoints

### `POST /wallet/hsm/account/create`

Creates an HSM-backed wallet account. Nothing is persisted server-side.

**Request**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `password` | string | yes | 8-128 chars |
| `label` | string | no | — |
| `purpose` | string | no | — |

```json
{
  "password": "<your-password>",
  "label": "my-wallet",
  "purpose": "testing"
}
```

**Response** — `data`:

| Field | Type |
|---|---|
| `zetrixAddress` | string |
| `publicKeyHex` | string |

```json
{
  "errorCode": 0,
  "message": "SUCCESS",
  "data": {
    "zetrixAddress": "ZTX3...",
    "publicKeyHex": "b001..."
  }
}
```

**curl**

```bash
curl -X POST https://wallet-api.myegdev.com/server/wallet/hsm/account/create \
  -H "Content-Type: application/json" \
  -d '{"password":"<your-password>","label":"my-wallet","purpose":"testing"}'
```

---

### `POST /wallet/hsm/sign-blob`

Signs an arbitrary hex-encoded blob using the HSM-held private key for the
given address.

**Request**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `blob` | string (hex) | yes | non-blank |
| `address` | string | yes | non-blank — the `zetrixAddress` from create-account |
| `password` | string | yes | 8-128 chars |

```json
{
  "blob": "0102030405",
  "address": "ZTX3...",
  "password": "<your-password>"
}
```

**Response** — `data`:

| Field | Type |
|---|---|
| `signBlob` | string |
| `publicKey` | string |

```json
{
  "errorCode": 0,
  "message": "SUCCESS",
  "data": {
    "signBlob": "...",
    "publicKey": "ed25519:..."
  }
}
```

**curl**

```bash
curl -X POST https://wallet-api.myegdev.com/server/wallet/hsm/sign-blob \
  -H "Content-Type: application/json" \
  -d '{"blob":"0102030405","address":"ZTX3...","password":"<your-password>"}'
```

---

### `POST /wallet/hsm/sign-message`

Signs a UTF-8 message using the HSM-held private key for the given address.
Same request/response shape as sign-blob, with `message` in place of `blob`.

**Request**

| Field | Type | Required | Constraints |
|---|---|---|---|
| `message` | string (UTF-8) | yes | non-blank |
| `address` | string | yes | non-blank |
| `password` | string | yes | 8-128 chars |

```json
{
  "message": "hello world",
  "address": "ZTX3...",
  "password": "<your-password>"
}
```

**Response** — `data`: same shape as sign-blob (`signBlob`, `publicKey`).

**curl**

```bash
curl -X POST https://wallet-api.myegdev.com/server/wallet/hsm/sign-message \
  -H "Content-Type: application/json" \
  -d '{"message":"hello world","address":"ZTX3...","password":"<your-password>"}'
```

---

### Validation error example (any endpoint)

```json
{
  "errorCode": 1,
  "message": "Invalid parameter",
  "data": {
    "errorList": ["password：Must not be blank"]
  }
}
```

## Security Notes

- `password` is never logged, never persisted, and never echoed back in any response.
- For sign-blob/sign-message, `blob`/`message` content is likewise never logged.
- Validation runs before any network call to the HSM service — an invalid request never reaches the external service.
- These endpoints are auth-gated (Bearer JWT + `X-API-Key`) in front of the outbound HSM call.
