# PhotoFresco command line (pf-agent-platform-nkwn.16)

`photofresco <command>` drives a PhotoFresco window you approve from scripts and agents: open an
image from a folder you granted, run a saved workflow on it, export the result, inspect status and
stop. It is a thin layer over the local connector ([CONNECTOR.md](CONNECTOR.md)), the same one the
MCP server (`photofresco mcp`, [MCP.md](MCP.md)) uses: the editor in the window does all the
editing, and the connector enforces pairing, permissions and folder grants. What it runs, sends and
fetches: [DISCLOSURE.md](DISCLOSURE.md).

Status: implemented and verified (unit and process tests, the real editor session layer, and a
headless real-browser run). **Not published**: the npm package is a later release step (`.39`,
owner approval pending), so run it from a checkout until then (nothing to install):

```sh
alias photofresco="node $PWD/agent/bin/photofresco.js"
```

A Chromium-based browser (Chrome, Edge or Chromium 120+) must be installed, or pass `--browser`
(or set `PHOTOFRESCO_BROWSER`) to a Chrome for Testing binary.

## Example

```sh
photofresco connect --read ~/Pictures --write ~/Pictures/PhotoFresco
photofresco run warm.json --open ~/Pictures/beach.png --input amount=0.6 \
  --export ~/Pictures/PhotoFresco/beach-warm.png
photofresco stop
```

1. `connect` opens PhotoFresco in its own browser window and prints a **connection code**. Check
   that the window shows the same code and click **Allow**, then choose the permissions in the
   Permissions dialog (the CLI asks for Read, Edit and Export by default). `connect` returns once
   you decided; it exits 75 if you have not decided within `--wait` seconds (run it again to keep
   waiting).
2. Later commands reuse that window and session. `run` opens the image (a new tab), runs the
   workflow through the editor's workflow engine (`workflow.run`, the Actions panel's engine) and
   writes the export only after its SHA-256 matched.
3. `stop` ends the session, closes the window and stops the connector. `disconnect` ends only the
   session; the window stays open for you.

Verified output of the same flow (`docs/e2e-runs/pf-agent-platform-nkwn.16-20261009/human-run.txt`):

```text
$ photofresco run invert.json --input opacity=0.5 --export out/sunset-half.png
Workflow "Invert" succeeded: 2/2 steps, 2 edits (run run_…, document doc_…)
Exported …/out/sunset-half.png (png, 2008 bytes, sha256 2129b3c3741e784c…)
```

A workflow file is the portable document `workflow.export` or the Actions panel produces
(`photofresco.workflow` version 1, see docs/agent-interface.md "Workflows"). `--action <id>` runs
an action saved in the editor instead.

## Commands

| Command | What it does |
|---|---|
| `connect` | Start the connector if needed, open PhotoFresco and pair (you click Allow) |
| `status` | Connector, window, session, permissions and granted folders (`running: false` when stopped) |
| `request-access <list>` | Ask for more permissions (`read,edit,export,external-write,spend`) |
| `documents` | Open documents with IDs and revisions |
| `attach <document-id>` | Target another open document |
| `open <file>` | Open an image (PNG, JPEG, WebP, GIF, BMP, AVIF, PSD/PSB, `.pfd`, ≤ 32 MiB) from a granted folder in a new tab |
| `run <workflow.json>` | Run a workflow (or `--action <id>`) on the session document; `--open`, `--export` around it |
| `export <file>` | Export the document (PNG, PSD or `.pfd`, from the extension or `--format`) into a granted folder |
| `exec <op> [params-json]` | Run one editor operation (`layer.add` or its tool name `layer_add`) |
| `outcome <request-id>` | The retained result of an earlier request, after a lost connection |
| `ops [prefix]` | Operations this session may run; the public catalog before connecting (`--catalog` forces it) |
| `describe <op>` | An operation's description, permissions, effects and parameter schema |
| `disconnect` | End the session; window and connector stay |
| `stop` | End the session, close the window and stop the connector |
| `mcp` | The MCP server ([MCP.md](MCP.md)) |

`photofresco <command> --help` lists each command's options. The main ones:

| Option | Command | Meaning |
|---|---|---|
| `--read <folder>`, `--write <folder>` | connect | Folders this session may open from / export into (repeatable; grants add up while the connector runs) |
| `--overwrite` | connect, run, export | On connect: exports may replace files in `--write` folders. On run/export: replace this file |
| `--grant <list>` | connect | Permissions to ask for (default `read,edit,export`; `none` asks for nothing) |
| `--client <name>` | connect | Shown in the window as "<name> via CLI" (default `Terminal`) |
| `--wait <seconds>` | connect, request-access | How long to wait for your decision (default 170, at most 180) |
| `--profile <folder>`, `--browser <path>` | connect | Browser profile (`ephemeral` for a throwaway one) and browser; only when the connector starts |
| `--input name=value`, `--inputs <file>` | run | Workflow inputs; values parse as JSON when they can (`0.6`, `true`, `"text"`), else as text |
| `--consent <step-id>` | run | Allow an irreversible barrier step (export, upload, paid AI, tab lifecycle) |
| `--on-failure stop\|rollback` | run | Keep the partial result (default) or roll the run's edits back |
| `--request-id <id>` | run, exec | Your ID for `outcome` |
| `--json` | all | One JSON object on stdout, also on failure ([result.schema.json](src/cli/result.schema.json)) |
| `--include-data` | all | Keep image data (base64, data URLs) in results; omitted by default |
| `--data-dir <folder>` | all | Connector data folder (default `PHOTOFRESCO_DATA_DIR`, else the per-OS folder in DISCLOSURE.md) |

Development only: `connect --editor-url http://127.0.0.1:<port>/app/ --allow-loopback-editor`.

## Exit codes and JSON

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Usage: bad arguments, unreadable or unsupported workflow file, unknown operation. Nothing ran |
| 3 | No connector or session, pairing denied/expired, browser or editor unavailable |
| 4 | A path was refused (not granted, escapes its folder, exists, too large, unreadable). Nothing ran |
| 5 | The editor refused or failed the operation or workflow (permission, revision, failed step). Nothing was written |
| 6 | Reading the export back failed or did not match its SHA-256. Nothing was written |
| 7 | Writing the file failed. The target was not replaced |
| 8 | Canceled (Ctrl-C, or Stop in the window). The document keeps the partial result |
| 75 | Still waiting for you in the window; run `connect` again |

With `--json` every command prints `{ "ok", "command", "exit_code", … }`; failures add
`error { code, message, hint, stage? }` plus whatever already happened (for `run`: the opened
file, the run record with each step's status, the run ID). Human output goes to stdout, errors and
the connection code to stderr. Results never contain keys, and image payloads are replaced by
`[omitted: N bytes …]` unless `--include-data`, so the JSON is a reproducible log of what ran
(workflow SHA-256, inputs, steps, document revision, exported file SHA-256).

## Cancellation and lost connections

- **Ctrl-C** during `run`, `exec`, `open` or `export` ends the session (the connector's `close`,
  same as Stop): the editor stops before the next workflow step, keeps what was done as an
  inspectable checkpoint and the CLI exits 8. Reconnect (`connect`, a new Allow), then inspect
  (`exec workflow.runs`) or roll back (`exec workflow.rollback '{"run_id":"…"}'`). The session
  protocol has no per-request cancel yet, which is why the whole session ends. A second Ctrl-C
  exits immediately. Ctrl-C while `connect` waits only stops waiting (exit 130); the request stays
  in the window until you answer it or it expires.
- **A lost connection** (the CLI killed, the terminal closed) cancels nothing: the editor finishes
  the request. `outcome <request-id>` returns its result; the document stays open in the window.
- **Stop** in the window, closing it or reloading ends the session; running requests fail as
  canceled or `session_ended` (exit 8 or 3).

## How invocations share one session (attach protocol)

`connect` starts a background **connector process** (`photofresco __daemon`, detached, no
console) for the data folder when none runs. It owns the connector (surface `cli`), its browser
window and the paired session. Every command connects to it, makes its calls and disconnects. It
exits on `stop`, when you close its browser window, on SIGINT/SIGTERM/SIGHUP, or after one minute
with no browser and no client (for example after a failed browser start).

Security model (same as `.14`; adapters add no authorization of their own):

- **No network listener.** A Unix domain socket `<data dir>/cli/connector.sock` (a named pipe
  `\\.\pipe\photofresco-cli-<hash>` on Windows, not verified). No TCP, WebSocket or HTTP server.
- **Local user only.** `<data dir>/cli` must be a real directory owned by you with mode 0700; both
  sides check it and refuse otherwise (`ipc_insecure`). The socket is 0600.
- **Attach key.** Each start writes 32 random bytes (hex) to `<data dir>/cli/attach.key` (0600);
  a connection must present it in its first message, compared in constant time. Defence in depth
  against a mis-permissioned folder, not a boundary against code running as you (out of scope,
  as in CONNECTOR.md).
- **Explicit pairing.** Attaching to the process grants nothing in the editor: the session exists
  only after your Allow, and the editor enforces the permissions you granted on every operation.
  Folder grants come from `connect --read/--write` and accumulate while the process runs.
  An agent that can run any shell command as you is not contained by folder grants.
- One connector process per data folder (a lock file; `already_running`); a stale socket left by a
  crash is replaced. Use `--data-dir` (or `PHOTOFRESCO_DATA_DIR`) for parallel instances.

Wire format (attach protocol 1, for `.47` SDKs and other local clients): newline-delimited
JSON-RPC 2.0 over that socket, one message per line, requests ≤ 16 MiB.

1. First request: `hello { protocol: 1, key, client: { name, version } }` → `{ protocol,
   connector: { name, version }, channel_protocol, pid }`. A wrong or missing key is error
   `-32001` and the connection closes; another protocol version is `-32002` with
   `data.supported`.
2. Methods mirror the connector API (CONNECTOR.md), params and results unchanged: `status`,
   `connect`, `close`, `sessionStatus`, `documents`, `attach`, `release`, `operations`,
   `requestAccess`, `execute`, `outcome`, `importFile`, `exportFile`, `roots`, `addRoot`,
   `fetchArtifact` (returns `data_base64`, at most 32 MiB). `subscribe` starts `event`
   notifications carrying connector events (`state`, `pairing`, `session`, `session_ended`).
   `shutdown` ends the session, closes the browser and stops the process.
3. Errors: connector and editor failures are `-32000` with `data` = `{ code, message, stage?,
   details? }` (the connector's error codes); `-32601` unknown method, `-32700` invalid JSON.

Implementation: `src/cli/attach.js` (socket, key, framing, client), `src/cli/daemon.js`
(connector process), `src/cli/main.js` (commands), `src/cli/exit.js` (exit codes, hints),
`src/cli/workflow.js` (workflow files).

## Tests

- `npm test` in `agent/` includes `test/cli.test.js`: argument parsing, exit codes, the JSON
  schema, workflow file checks, socket permissions, attach key/protocol refusals, one process per
  folder, idle exit, and the real bin spawning, reporting and stopping its connector process.
- Editor repository: `test/agent-cli.test.mjs` (every command over the real session layer: pairing,
  workflow run with inputs, export, path and permission refusals, failed step checkpoint, Ctrl-C,
  lost connection, user Stop, pending pairing, stop) and `scripts/agent-cli-e2e.mjs` (the real bin
  against a real editor in a headless browser; see the evidence folder above).

## Not included

- Publication (npm, Homebrew tap, GitHub Release binaries): `.39`/`.43`, owner approval.
- A terminal recording (GIF) for the README and Terminal Trove: after publication.
- Per-request cancel without ending the session; Windows/Linux runs (implemented, not verified).

## Uninstall

`photofresco stop`, remove the package, then follow DISCLOSURE.md "Uninstall".
