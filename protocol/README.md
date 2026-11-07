# Local connector protocol — pf-agent-platform-nkwn.47

Built and locally verified 2026-10-20; **not published**. These files contain no hosted
job API. Start a driver with the existing npm bin:

```sh
photofresco connect --stdio --read ./inputs --write ./outputs
```

The process starts no browser until `session.connect`. It opens only its own visible
editor window. The user checks the pairing code and approves the connection and
permissions there. `session.requestAccess` asks; it cannot grant. Folder permissions
come only from startup `--read`, `--write`, `--overwrite`; no RPC method adds roots.
The adapter delegates to the exact connector used by MCP and the CLI.

## Wire contract

`connector.openrpc.json` is OpenRPC 1.3.2, with local protocol version `1.0.0`.
`rpc.discover` returns this document without connecting. Send one UTF-8 JSON-RPC 2.0
object followed by LF per frame. Named params only; batch arrays are rejected.
stdout contains only protocol frames; diagnostics belong on stderr. There is no
attach socket. Every view/grant/stop rule remains enforced by the editor.

```json
{"jsonrpc":"2.0","id":"1","method":"session.connect","params":{"protocol_version":"1.0.0","client":"My SDK","document":"none","access":{"capabilities":["read","edit","export"]}}}
{"jsonrpc":"2.0","id":"2","method":"ops.execute","params":{"op":"doc.new","params":{"width":8,"height":8},"request_id":"new-1"}}
```

Consume `connector.event` notifications while waiting: state, pairing (code + expiry),
session (including grants) and session_ended. Responses can arrive out of order. RPC
`id` matches the transport response; `request_id` is the editor's durable execution ID.
Pass `expected_revision` for an edit based on an observed state. Reuse a request ID
only for the exact same operation, params and revision. After a timeout, reconcile
using `ops.outcome` and document state while the driver survives. A lost driver has
no attach/recovery channel: ask the user to inspect any remaining document; a new
pairing cannot recover old session receipts. Never blindly retry a mutation.

Successful executions return the editor outcome. Refused/failed/canceled/unknown
executions return a JSON-RPC error whose `data.outcome` preserves the full receipt.
`ops.outcome` returns retained receipts as results, including failure receipts.
`data.code` keeps the exact editor/connector code, and `data.stage` keeps the file
workflow stage. Numeric categories are stable:

| Number | Meaning |
|---|---|
| -32001 | Not connected |
| -32002 | Permission, reserved operation or filesystem path denied |
| -32602 | Method/operation argument validation |
| -32003 | Stale revision |
| -32004 | Canceled |
| -32005 | Unknown outcome: reconcile |
| -32006 | Resource limit |
| -32007 | Protocol version mismatch |
| -32000 | Other connector/operation failure |

Standard JSON-RPC parse/request/method/internal errors remain -32700/-32600/-32601/-32603.
Input frames are limited to 48 MiB and 8 concurrent requests; Stop remains available
at capacity. `artifact.fetch` requires an explicit `max_bytes` (1–6 MiB), verifies the
connector's SHA-256 and returns base64. Larger exports use `file.export` into a startup
granted folder or bounded `artifact.read` op chunks. Preview ops return PNG bytes in
their existing result shapes. EOF/SIGINT/SIGTERM stops the session and its browser.

## One operation source

`op-catalog.json` is a generated, versioned **manifest**, not another inventory.
It contains the canonical operation digest/count and hashes of the exact namespace
shards MCP already ships. `src/rpc/catalog.js` resolves/verifies them. This keeps every
public file below the directory export's 256 KiB limit. `src/ops/catalog.ts` derives
the records from `OpsRegistry.toolDefinitions()` and `describe()` metadata, excludes
user-only operations, and is shared by both snapshot tests. No name reversal by
underscore replacement is allowed; canonical names come from each record.

Before pairing, discovery exposes the public catalog, just as MCP does. Afterwards it
exposes only the session's live granted operations. Discovery grants no authority.

After changing editor ops, from the editor repository root:

```sh
UPDATE_AGENT_CATALOG=1 npx vitest run test/agent-mcp-catalog.test.mjs
UPDATE_AGENT_PROTOCOL=1 npx vitest run test/agent-protocol-catalog.test.mjs
node agent/sdkgen/generate.mjs
node agent/sdkgen/generate.mjs --check
```

The registry drift test also registers an extra operation and proves its digest no
longer matches the snapshot. Generated language receipts include both schema hashes.

## Language SDK handoff (.48–.54)

Run `node sdkgen/generate.mjs` from the exported adapter root. Seven folders under
`sdks/` contain request models for every protocol method and public op, a typed client
over a Transport interface, and a generation receipt. Nested objects, schema unions
and polymorphic results remain native JSON; admission and authorization belong to the
editor. These are compiling **client skeletons**, not published language packages.
The Node reference `src/rpc/client.js` supplies the complete subprocess transport.
Language packaging must provide its native transport/JSON binding and run the same
scenarios; put any shared generation changes into `sdkgen/generate.mjs`, never edit
generated files. No hosted transport/method stubs are generated.

The plugin/MCP/CLI source target stays `photofresco/photofresco-agent`. Its npm
package includes the runtime `protocol/` schemas, but no generator or language SDKs.
To keep the plugin inside Claude's directory rules, the seven clients and generator
export separately to `photofresco/photofresco-sdks` (integration decision 2026-10-20).
The SDK tree has root language folders (`python/`, `rust/`, `ruby/`, `php/`, `dotnet/`,
`java/`, `go/`), shared `protocol/`, generator and the hash-checked catalog shards.

```sh
node scripts/agent-export.mjs /tmp/photofresco-agent
node scripts/agent-export.mjs /tmp/photofresco-sdks --repo sdks
node scripts/agent-export.mjs /tmp/photofresco-php --sdk php
```

All three commands run from the private editor checkout. They prepare local source
only: no repo creation, push, publication or workflow run. Each has an independent
allowlist and secret/size/path guards. The plugin limit counts only exported files;
local SDK build output is never plugin content. Tests check the exported SDK tree's
generator and language-specific drift commands as well as the plugin's launchers.

Go's module is `github.com/photofresco/photofresco-sdks/go`, with `go/vX.Y.Z` tags;
no deployed vanity endpoint is needed. PHP's `photofresco/photofresco-php` mirror
still places Composer at the repo root and refuses differing target files. Refresh
the PHP mirror from the same canonical `agent/sdks/php/` source as the SDK export.
The owner prerequisite `.33` must record creation/approval of the SDK repo and PHP
mirror before release, along with registry trust updated to the SDK repo. The
separately packaged `vscode/` build workspace remains outside both exports.

## Verification and recovery

`vectors.json` contains language-neutral request/error vectors. `conformance.json`
defines the real editor sequence and substitution/assertion rules, and `conformance.mjs`
runs it through any Node transport with `call(method, params)`. The 8×8 PNG is original,
MIT-licensed source data with a checksum in `fixtures/LICENSE.txt`.

Verified 2026-10-20: 32 scenarios via the real stdio process and editor; code-checked
pairing and Read/Edit/Export via actual dialog clicks; list/describe, import, stale
revision, invalid args, adjustment + selection mask, previews, replay-safe ID, undo/
redo, bounded artifact fetch + SHA-256, exact preview/export pixels, ungranted paid
op, reserved user op, ungranted read/write paths, outcome reconciliation and Stop.
Evidence is summarized in the bead and parity ledger. Reproduce from the editor repo:

```sh
node scripts/agent-rpc-e2e.mjs http://127.0.0.1:<port>/app/ /tmp/photofresco-rpc-proof
node --test agent/test/rpc.test.js agent/test/sdkgen.test.js
npm run typecheck --prefix agent
```

The test driver alone starts headless and clicks approvals; production never does.
Use a fresh connector profile and a Vite-only loopback editor. The proof budget is
180 seconds. A reserved-op test must have schema-valid params to reach authorization:
missing `session_id` is correctly refused as `invalid_params` first.

Independent schema validation uses the established `jsonschema` tool's N-1 release
4.25.1 (published 2025-08-18), installed only in a temporary uv environment, not npm:

```sh
uv run --no-project --with jsonschema==4.25.1 python sdkgen/validate.py
```

All 267 catalog input schemas, the manifest and OpenRPC validated on 2026-10-20.
Each language's focused compiler command is `sh sdkgen/check.sh <language>`.
Python/Rust/Go checked locally; PHP/Java/.NET in pinned local containers; Ruby code
and RBS checked in a local container. The manual-only `sdk-check.yml` contains the
same seven container checks and has not been run on GitHub. Publication and hosted
API work remain outside this bead.
