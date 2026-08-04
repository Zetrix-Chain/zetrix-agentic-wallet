# Zetrix Agentic Wallet — OpenClaw plugin

Installs the Zetrix Agentic Wallet into an OpenClaw gateway, so a subscriber gets the wallet by
installing one package instead of hand-writing an `mcp.servers` entry — which they cannot do at all on
a hosted gateway they do not own.

```bash
openclaw plugins install clawhub:@zetrix/openclaw-agentic-wallet@<version>
openclaw plugins enable zetrix-agentic-wallet
openclaw gateway restart
```

Nothing else is required. No `npx`, no registry access at runtime, no MCP configuration, and **no
password**: the wallet generates and stores its own credentials.

## Build

```bash
npm run build          # in the repo root — produces the wallet bundle
npm run build          # in openclaw-plugin — bundles the plugin and vendors the wallet
npm test               # 40 tests: registration logic, paths, and the package contract
```

## Configuration

Set by the subscriber, through the gateway's plugin config UI or `plugins.entries`:

| Field | Default | Meaning |
|---|---|---|
| `network` | `zetrix:testnet` | Mainnet spends real funds |
| `maxPaymentAmount` | `{"*":"0"}` | Per-asset ceiling in raw units. **Refuses every payment until set** |
| `zetrixAddress` | *(unset)* | Pin an existing holder account instead of creating one |

## Why it works the way it does

Three things were tested against a live gateway (OpenClaw **2026.7.1-2**) and shaped this design. Each
is stated here with what was observed, because the design looks odd without it — and because if any of
them changes upstream, the corresponding workaround should be deleted rather than carried forever.

**The manifest declares no `mcpServers`, and that is deliberate.** It is the documented way for a
plugin to contribute an MCP server, and on this version it silently contributes nothing — the server
is never spawned and no diagnostic is emitted. Native `api.registerTool` tools do register, but never
reach a `claude-cli` harness, so an agent cannot call them. Writing the entry into `mcp.servers` from
the registration hook is the only route that works end to end. *If the manifest route is ever fixed
upstream, `src/index.ts` is what should be deleted.*

**The wallet is vendored into the plugin, as a single CJS bundle.** `openclaw plugins install` is a
directory copy, not an npm install: a declared dependency produced no `node_modules` in the installed
copy, and `files` was ignored. So the wallet must ship inside the plugin.

Vendoring a real `npm install` tree was the first attempt, and it is the more faithful one — the wallet
publishes with `zetrix-sdk-nodejs` external, so that is the configuration it is tested in. It had to be
abandoned: ~8,250 files produced a tarball **OpenClaw cannot install**.

```
failed to extract archive: Error: extract tar timed out after 120000ms
```

A tarball is how ClawHub ships, so an unextractable package is fatal rather than merely slow. One
bundled file is 3.4 MB, packs to a 644 KB / 7-file tarball, and installs instantly.

⚠️ **The bundle must be CJS.** The SDK and its dependencies use dynamic `require`, which esbuild cannot
express in ESM output — an ESM bundle loads and then dies at first use with *"Dynamic require of
`buffer` is not supported"*. In CJS `require` stays native, and both `account.getInfo` and the
protobufjs-heavy `contract.call` were verified working through the bundle against a live node. A test
asserts the format, because this fails at *call* time, not at load.

**The runtime is then copied *out* of the plugin, and so is the ownership marker.** OpenClaw exposes no
uninstall hook a plugin can use — `api.lifecycle` offers only `registerRuntimeLifecycle`, and a
disabled plugin is never loaded, so no cleanup code of ours can ever run. Two consequences:

- Pointing the config entry at the plugin's own directory would leave a **broken** server behind on
  uninstall. Pointing it at `<gatewayStateDir>/zetrix-agentic-wallet/runtime` leaves a **working** one.
- The ownership marker lived inside the plugin at first, and `plugins install --force` wiped it — after
  which the plugin treated its own entry as subscriber-owned and refused to manage it, orphaning the
  entry on every update. It now lives beside the runtime.

## If the MCP entry goes missing

Removing `mcp.servers["zetrix-agentic-wallet"]` by hand **stops the wallet working immediately** — the
tools disappear, because there is no server for the agent to call. The plugin still reports as enabled;
it just provides nothing.

The entry is self-healing, but not on the trigger you would expect. Tested on 2026.7.1-2:

| Action | Entry restored? |
|---|---|
| `openclaw gateway restart` | **No** — waited two minutes, no registration in the logs |
| `openclaw plugins install` / `enable` | Yes |
| `openclaw plugins inspect <id> --runtime` | Yes |
| `openclaw agent …` | Yes |

The registration hook runs when the **CLI** loads the plugin in-process, not on a gateway restart. So if
the entry is ever lost, the fix is any plugin-loading command:

```bash
openclaw plugins inspect zetrix-agentic-wallet --runtime
```

Worth knowing for two reasons: a restart is the natural thing to reach for and it will not help, and a
subscriber who deletes the entry to disable the wallet will find it back after the next plugin
operation. To disable the wallet properly, disable the plugin.

## Uninstalling completely

Because there is no uninstall hook, removal is two steps. The wallet keeps working after step 1, which
is intentional — it is a wallet holding an account, and silently breaking it would be worse.

```bash
openclaw plugins uninstall zetrix-agentic-wallet --force
openclaw mcp unset zetrix-agentic-wallet
```

⚠️ **Before deleting `<gatewayStateDir>/zetrix-agentic-wallet/`, back up the wallet.** It holds the
holder identity and the generated HSM password, and that password is the only thing that can authorize
signing for the account. Run `npx agentic-wallet-mcp export-credentials` in an interactive terminal
first. There is no recovery once it is gone.

Two things to know if `mcp unset` fails: OpenClaw rejects config writes that shrink the file sharply
(`Config write rejected … size-drop`), which a legitimate removal can trigger, and
`plugins uninstall --force` may leave the plugin directory behind — OpenClaw auto-loads anything under
`extensions/`, so the plugin keeps reporting as enabled until that directory is deleted.

## Caveats for review

- **This plugin writes to `mcp.servers`, which is documented as the operator's authoritative override
  surface.** It never overwrites an entry it did not create, but the inversion is real and was a
  deliberate choice made only after the two supported routes were shown not to work.
- **Writing config directly bypasses OpenClaw's own write validation**, including the size-drop guard
  above. Our writes only add keys, so they cannot shrink the file, but the bypass is worth knowing.
- **`plugins.allow` is a whitelist, not additive trust.** If you set it, enumerate every required
  plugin — setting it to a single id excluded the agent harness during testing and left the agent
  unable to run at all.
