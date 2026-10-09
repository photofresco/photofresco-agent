# What the PhotoFresco connector runs, sends and fetches

Record for pf-agent-platform-nkwn.14, the MCP server (pf-agent-platform-nkwn.15) and the CLI
(pf-agent-platform-nkwn.16) (source for the `.34` public README section). Observed on macOS arm64
with Chrome for Testing 145 against a local editor build on 2026-10-09
(`docs/e2e-runs/pf-agent-platform-nkwn.14-20261009/log.json`,
`docs/e2e-runs/pf-agent-platform-nkwn.15-20261009/log.json`,
`docs/e2e-runs/pf-agent-platform-nkwn.16-20261009/log.json` and the `.34` request log
`docs/e2e-runs/pf-agent-platform-nkwn.34-20261009/demo/user-side.json` in the editor repository).
Anything not observed in those runs is marked "not verified".

## Runs

- **A Node.js process**: whatever adapter loaded the connector (MCP server, CLI, SDK endpoint).
  Constructing the connector starts nothing.
- **One browser process tree, only on `connect()`**: an installed Chromium-based browser
  (`browserPath` option, else `PHOTOFRESCO_BROWSER`, else Google Chrome, Microsoft Edge or
  Chromium from their standard install locations). Nothing is downloaded. Exact arguments:
  `--user-data-dir=<profile> --remote-debugging-pipe --no-first-run --no-default-browser-check --disable-extensions about:blank`.
  Observed: 7 processes (browser plus its renderer/GPU/utility children), all ending when the
  connector shuts down or its process exits (the browser exits when its pipe closes).
- **No other programs**, no shell commands, no installers.

## Browser profile and local files

- **Dedicated profile**: `<data dir>/browser-profile`, where the data dir is
  `~/Library/Application Support/PhotoFresco Connector` (macOS), `%LOCALAPPDATA%\PhotoFresco Connector`
  (Windows) or `$XDG_DATA_HOME/photofresco-connector` / `~/.local/share/photofresco-connector`
  (Linux). It holds what any browser profile holds for photofresco.com (cookies and sign-in if
  you sign in there, cache, local storage including the editor's acquisition first-touch,
  editor autosave). Your normal browser profiles are never opened, read or attached to.
  `profileDir: 'ephemeral'` uses a temporary profile deleted when the browser exits.
- **Lock file**: `<profile>/PhotoFrescoConnector.lock` (process ID and a random nonce) while the
  connector owns the profile.
- **Reads**: only files inside folders granted for reading, only on `importFile`, at most 32 MiB.
- **Writes**: only inside folders granted for writing, only on `exportFile`: missing subfolders,
  a hidden temporary `.<name>.<random>.pf-partial` next to the target during the transfer, then
  the target (atomic rename, or hard link when not overwriting). Existing files are replaced
  only with the folder's overwrite grant and `overwrite: true`. A transfer whose SHA-256 does not
  match leaves no file.
- The connector itself writes no log files (the CLI's connector process does; see below). Its
  optional `log` callback receives events such as `file_written { path, bytes, sha256 }`; it never
  receives keys, file contents or pixels.

## Local ports and channels

- **No listening port.** The DevTools protocol runs over the browser's private pipe (file
  descriptors 3/4 of the browser process). Observed: no TCP listener in any browser process,
  and no `DevToolsActivePort` file. No HTTP/WebSocket server is started.
- The connector attaches only to the tab it opened, registers one binding there
  (`__photofrescoConnector`) and calls one fixed function (`photofrescoConnector.receive`) with
  data arguments. It evaluates no other page code and never attaches to other tabs.
- Messages carry a random channel key and, per approved connection, a session key. Neither
  is put in a URL, a log or an event.

## Fetches and sends

- **The connector process itself makes no network requests.**
- The browser opens `https://photofresco.com/app/?pf_ref=<surface>` (the editor URL is pinned
  per connector; a loopback `http://127.0.0.1` editor is allowed only for development). The
  `pf_ref` value is the non-secret surface name (`mcp`, `cli`, `sdk`, `vscode`) used for
  acquisition attribution. From there the page loads its assets like a normal visit to the editor.
- **The connector's window starts with session recording & diagnostics off** (owner decision,
  2026-10-09). The editor knows the connector opened it (the DevTools binding the connector
  registers on its own tab; no link or website can set it) and starts that page with nothing
  allowed in Data & privacy; the menu button reads "Data: local-only" until you click Allow,
  which adds only External agents. So the page sends PhotoFresco **no session recording, no
  diagnostics, no copies of the files the agent imports and no acquisition events**, and keeps
  `pf_ref` unprocessed in the address bar. Observed in the `.39` runs (local build with
  `?replay=1`, which records the way production does for a normal visit): no `/replay/` or
  `/telemetry` request from pairing to the end of the session, through import, edits and exports.
- **Unless you turn Session recording & diagnostics on in Data & privacy** (`/app/privacy/`) in that window: from then
  on the page sends the session recording (input events, editor commands, document names, typed
  text except password and email fields) **with a copy of each file opened afterwards in the
  window, including files the agent imports through the connector** (at most 16 MiB each, 6 per
  page load), diagnostics (errors, feature events, performance vitals, a device profile) and
  privacy-safe acquisition events (`referral`, `open`, `edit`, `export`, each `{ channel: 'mcp',
  source: 'mcp', surface: 'mcp', actor: 'automated' }`, no file names or pixels); the editor then
  removes `pf_ref` from the address bar. Observed after turning it on: `POST /telemetry`,
  `/telemetry/acquisition` and `/replay/sessions/<id>/chunks`, all to the editor's own origin.
  A normal visit to the editor (not opened by the connector) keeps recording on by default.
- In the observed runs (local build) the tab requested only the editor's own origin. Production
  third-party requests were not verified.
- The connector's browser reports `navigator.webdriver = true` (a consequence of the DevTools
  pipe), so the editor shows no third-party ads there and counts any acquisition events as
  `automated`.
- The browser's own background traffic (component updates, safe browsing and similar) follows
  the installed browser's defaults; not measured.
- **To the agent** (through the adapter): only what the user's grants allow — session status,
  document state, previews (pixels), operation results and exported artifacts. Previews and
  other results returned to an agent go to that agent's model provider under its policy.
- Paid AI runs only with the Spend grant and the budget the user sets (pf-agent-platform-nkwn.11).

## The MCP server (`photofresco mcp`)

- **Runs** as a Node.js process your MCP client starts and talks to over stdin/stdout. With
  `npx photofresco …`, npm downloads the package from the npm registry first (npm's fetch, before
  the server runs); as a Claude Code, Codex, Cursor or Gemini CLI plugin, the client copies this
  repository and runs `node <plugin folder>/bin/photofresco.js mcp`, downloading nothing at start.
  Runtime dependencies: none to install. The official MCP SDK (`@modelcontextprotocol/server` and
  `@modelcontextprotocol/core` 2.2.0, `zod` 4.6.5) is bundled readable in `vendor/` (versions,
  tarball SHA-256 and licenses in `vendor/README.md`); the server uses only its stdio transport. It
  starts no browser until the agent calls `photofresco_connect`.
- **No network, no listening port** of its own. Observed: no socket in the server process during a
  session (`lsof -i`).
- **Files**: reads its own package files; reads and writes your files only through the folders you
  pass with `--read`/`--write` (the connector rules above). No log files; it writes to stderr only
  for startup errors.
- **To the editor**: the MCP client's own name from its `initialize` message, shown to you as
  "<name> via MCP", and the surface token `mcp`.
- **To the agent**: the tool list (before a session, the public operation catalog bundled in the
  package), connection state and code, session status (target document, revision, grants, the
  pending request, budget), the folders you granted (paths), the browser's product name, operation
  results, previews as images, exports as resources (at most 6 MiB each) and the paths and SHA-256
  of files it wrote. All of it goes to the agent's model provider under that provider's policy.
- **Ends** when the client closes stdin: the server ends the session, closes its browser and exits.
  Observed: the browser process was gone after the client closed.

## The CLI (`photofresco <command>`)

- **Runs** two kinds of Node.js process: each command you type (it exits when done), and one
  background **connector process** per data folder, started by `photofresco connect` (`photofresco
  __daemon`, detached from the terminal). The connector process owns the browser described above.
  It ends on `photofresco stop`, when you close its browser window, on SIGINT/SIGTERM/SIGHUP, or
  after a minute with no browser and no command attached. Runtime dependencies: none beyond Node.js
  (it reads the bundled op catalog for `ops`/`describe` before a session).
- **Local channel, no network listener**: `<data dir>/cli/connector.sock`, a Unix domain socket
  (mode 0600) in a folder that must be owned by you with mode 0700; a named pipe on Windows (not
  verified). Every connection must present `<data dir>/cli/attach.key` (32 random bytes, 0600,
  new each start, deleted on stop). Observed: no network socket in the connector process during a
  session (`lsof -i`), socket 0600 in a 0700 folder.
- **Files**: `<data dir>/cli/` holds the socket, the key, a lock file (`PhotoFrescoConnector.lock`,
  process ID and nonce) and `connector.log`: the connector's secret-free events as JSON lines
  (paths of granted folders and of files read or written, byte counts, SHA-256 of exports, session
  and browser start/stop), overwritten at each start and capped at 4 MiB. Observed: no key, file
  content or pixel data in it. It reads workflow and inputs files you name on the command line (at
  most 1 MiB, JSON only; anything else is refused before it is sent) and your images only through
  the folders you pass to `connect --read/--write` (the connector rules above).
- **To the editor**: the name from `--client` (default `Terminal`), shown to you as "<name> via
  CLI", the surface token `cli` (`pf_ref=cli`; the window starts with recording off, so no
  acquisition events are sent unless you turn recording on there, then `referral`, `open`, `edit`
  and `export`, each `{ channel: 'cli', source: 'cli', surface: 'cli', actor: 'automated' }`, no
  file names or pixels) and the workflow documents and inputs you run.
- **To the terminal**: results on stdout (with `--json`, one object per command), the connection
  code and errors on stderr. Image data in results is omitted unless `--include-data`. Whatever
  runs the CLI (for example an agent) receives that output.
- **Ends**: `photofresco stop` closes the browser and the connector process. Observed: browser and
  connector processes gone and the socket removed after `stop`.

## User control

- Each connection needs the user's **Allow** in the editor window (the window shows the same
  connection code the agent reports); the session starts with no permissions; the Permissions
  dialog grants them. Stop, closing the window, reloading or leaving the editor origin ends the
  session; a new connection needs a new Allow.
- Closing the connector (or its process exiting) closes its browser window.

## Uninstall

Run `photofresco stop` if the CLI is running, remove the package (for example `npm uninstall -g
<package>`) and delete the data dir above. Nothing else is installed: no services, no login items,
no browser extensions.
