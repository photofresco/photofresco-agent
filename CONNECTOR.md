# PhotoFresco local connector (pf-agent-platform-nkwn.14)

One in-process API (`createConnector`) shared by the MCP server (`.15`, `photofresco mcp`, see
[MCP.md](MCP.md)), the CLI (`.16`, `photofresco <command>`, see [CLI.md](CLI.md)) and the JSON-RPC
stdio endpoint (`.47`). Pairing, origin/protocol pinning, revocation and file grants are enforced
here; adapters add no authorization logic. What it runs, sends and fetches:
[DISCLOSURE.md](DISCLOSURE.md).

Separate processes reach one running connector through the CLI's **attach path**: a background
connector process serves this API over a local-user-only Unix socket (0700 folder, 0600 socket,
per-start attach key; no TCP listener) as newline-delimited JSON-RPC 2.0 whose methods mirror the
API below. Protocol and security model: CLI.md "How invocations share one session"; `.47` SDKs can
attach to it or spawn their own process.

## API

```js
import { createConnector } from 'photofresco' // package name pending .33
const connector = createConnector({
  surface: 'mcp',                 // mcp | cli | sdk | vscode (shown to the user, acquisition token)
  client: 'Claude Code',          // agent name shown as "Claude Code via MCP"
  roots: [{ path: '/Users/me/Pictures', read: true }, { path: '/Users/me/Exports', write: true, overwrite: false }],
  // editorUrl, allowLoopbackEditor, browserPath, dataDir, profileDir ('ephemeral'), cwd, env, log, launch
})
connector.status()                // sync, no browser: { protocol, connector, surface, state, editor, browser, pairing, session, last_end, roots }
connector.subscribe((event) => {}) // state | pairing { code, expires_at } | session { status } | session_ended { code, message }
await connector.connect({ access: { capabilities: ['read', 'edit', 'export'], reason: '…' }, document: 'active', timeout_ms })
await connector.operations()      // granted ops only
await connector.execute({ op: 'image.desaturate', params: {}, request_id, expected_revision }) // SessionResponse; refusals are responses
await connector.importFile({ path: 'photo.png' })                   // doc.open (Edit grant)
await connector.exportFile({ path: 'out/photo.psd', format: 'psd', overwrite: false }) // Read + Export grants
await connector.fetchArtifact({ artifact_id, max_bytes })            // verified bytes for MCP resources
// also: sessionStatus, documents, attach({ document }), release, requestAccess, outcome({ request_id }), roots, addRoot (trusted config only), close, shutdown
```

- `state`: `idle` (no browser) → `starting` → `ready` (editor open, no session) → `pairing` →
  `connected`. `connect()` resolves after the user's Allow; concurrent calls share one attempt;
  when connected it returns the current status. The `pairing` event carries the code to show the
  user. The editor withdraws an unanswered request after 3 minutes (`timeout_ms` ≤ that).
- `close()` ends the session from the agent side (same as Stop) and leaves the window open;
  `shutdown()` also closes the browser.
- Never expose `addRoot`, `editorUrl`, `browserPath` or `launch` to the model.

## Errors

`ConnectorError { code, message, stage?, details? }` (`toJSON()` for adapters). Editor-side
refusals keep the editor's codes (`capability_denied`, `stale_revision`, `artifact_expired`, …).
Connector codes: `invalid_options`, `invalid_request`, `not_connected`, `busy`,
`browser_not_found`, `browser_unsupported`, `browser_launch_failed`, `profile_in_use`,
`browser_closed`, `page_closed`, `page_reloaded`, `origin_changed`, `editor_unavailable`,
`editor_unsupported`, `channel_rejected`, `pairing_denied`, `pairing_expired`,
`pairing_canceled`, `pairing_in_progress`, `session_active`, `session_ended`,
`path_not_granted`, `path_escape`, `path_invalid`, `file_exists`, `not_a_file`, `file_too_large`,
`read_failed`, `write_failed`, `artifact_incomplete`, `artifact_hash_mismatch`,
`artifact_too_large`, `operation_failed`. File workflows set `stage`: `path` (refused before
anything ran), `operation`, `retrieval`, `write` — the CLI maps these to separate exit codes
(4–7, CLI.md). The attach path adds `connector_not_running`, `connector_disconnected`,
`connector_unsupported`, `ipc_unauthorized`, `ipc_insecure`, `ipc_failed` and `already_running`.

## Security model

- **Transport**: a connector-owned browser process with a dedicated profile and the DevTools
  protocol on `--remote-debugging-pipe`: no TCP/WebSocket listener, so no Host/Origin, DNS
  rebinding or local-network surface, and other local processes or web pages cannot reach it.
  Works under the editor's production HTTPS/COOP/COEP; TLS and isolation are untouched.
- **Page channel** (`src/ops/connectorChannel.ts` in the editor): installed only when the
  connector's binding exists; the editor takes the binding off the global scope at boot and
  exposes a frozen `photofrescoConnector.receive`. Every message needs the page's random
  channel key (sent only through the binding) and a strictly increasing ID: forged and replayed
  envelopes are refused synchronously and never answered. Session calls also need the
  per-pairing session key, which ends with Stop, close, consent revocation or reload.
- **Pinning**: binding calls count only from the tab's main frame, default world, at the pinned
  editor origin; navigation away ends the session and unsubscribes the binding; protocol
  version mismatches are refused (`editor_unsupported`). Other tabs have no binding.
- **Authorization**: the user allows each connection (pairing dialog with a matching code, which
  also records the page's External agents consent) and grants capabilities in the Permissions
  dialog; the editor enforces them on every operation (`.11`). The connector cannot answer
  either dialog and no adapter may expose `session.*` operations.
- **Files**: canonical (`realpath`) folder grants; traversal and symbolic-link escapes refused;
  no writes through links; overwrite needs the root grant and the request flag; reads open the
  checked file without following links; writes publish atomically only after the full artifact
  was read and its SHA-256 matched.
- **Threats out of scope**: code already running as the same OS user (it can read the profile or
  control any browser), and script running inside the editor origin (it can already drive the UI).

## Packaging decision

- Runtime: Node.js ≥ 22. The connector modules import no dependencies; the MCP server
  (`src/mcp`) uses the official MCP TypeScript SDK (`@modelcontextprotocol/server` 2.2.0, which
  brings `@modelcontextprotocol/core` and `zod`), bundled readable in `vendor/` so the package and
  the plugin installs need no `npm install` (pf-agent-platform-nkwn.37; `vendor/README.md`). Browser: an installed Chromium-based browser
  ≥ 120 (Google Chrome, Microsoft Edge, Chromium), or any Chromium/Chrome for Testing binary in
  `PHOTOFRESCO_BROWSER`. The connector downloads nothing; machines without one need a browser
  install first (for example `npx @puppeteer/browsers install chrome@stable`, then point
  `PHOTOFRESCO_BROWSER` at it).
- OS: macOS arm64 verified (Chrome for Testing 145). Windows and Linux discovery paths are
  implemented but not verified. The pipe transport is the same one Playwright uses on all three.
- Clean uninstall: remove the npm package and the data dir listed in DISCLOSURE.md.
- One connector per profile at a time (`profile_in_use`); use `profileDir: 'ephemeral'` for parallel
  instances.

## Tests

`npm test` (node:test: path grants, staged writes, CDP framing, tab pinning, launch with a fake
browser, API guards, `test/mcp.test.js`: the MCP server as a clean stdio process driven by the
official MCP client, and `test/cli.test.js`: the CLI and its attach socket); `npm run typecheck`.
The editor repository adds `test/agent-connector.test.mjs` (real page channel + connector),
`test/agent-mcp.test.mjs` (MCP over the real session layer), `test/agent-mcp-catalog.test.mjs`
(the bundled op catalog), `test/agent-cli.test.mjs` (CLI over the real session layer),
`scripts/agent-connector-browser-tests.mjs`, `scripts/agent-mcp-e2e.mjs` and
`scripts/agent-cli-e2e.mjs` (real browser).
