# PhotoFresco MCP server (pf-agent-platform-nkwn.15)

`photofresco mcp` is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server. It
lets an AI agent edit images in a PhotoFresco window on your computer: you see every change, you
allow the connection, you choose what the agent may do, and you can stop it at any time. It is a
thin adapter over the local connector ([CONNECTOR.md](CONNECTOR.md)); what it runs, sends and
fetches is in [DISCLOSURE.md](DISCLOSURE.md).

Status: implemented and verified with the official MCP TypeScript client over stdio (both protocol
eras) and against a real editor in a real browser. **Not published**: the npm package and the MCP
Registry entry are a later release step, so the `npx photofresco` lines below work only after that
release. Until then, run it from a checkout (see "From a checkout").

## Configure your agent

Choose the folders the agent may open files from (`--read`) and save exports into (`--write`).
Without them the agent can still edit and preview, but cannot touch your files.

> **npm release pending.** The `photofresco` npm package is published in mid-October 2026; until
> then the `npx` lines below do not work. Install the plugin, or run from a clone with
> `node /path/to/photofresco-agent/src/bin/photofresco.js` in place of the `npx -y photofresco`
> part.

**Claude Desktop** — `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "photofresco": {
      "command": "npx",
      "args": ["-y", "photofresco@0.1.0", "mcp", "--read", "/Users/you/Pictures", "--write", "/Users/you/Pictures/PhotoFresco"]
    }
  }
}
```

**Claude Code**:

```sh
claude mcp add photofresco -- npx -y photofresco@0.1.0 mcp --read ~/Pictures --write ~/Pictures/PhotoFresco
```

**Cursor** — `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project): the same
`mcpServers` JSON as Claude Desktop.

**VS Code** — `.vscode/mcp.json` (one workspace) or **MCP: Open User Configuration** (all): the
same arguments under `"servers"` with `"type": "stdio"`:

```json
{
  "servers": {
    "photofresco": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "photofresco@0.1.0", "mcp", "--read", "/Users/you/Pictures", "--write", "/Users/you/Pictures/PhotoFresco"]
    }
  }
}
```

**From a checkout** (before publication; nothing to install, the MCP SDK is bundled in `vendor/`):
use `"command": "node"` with `"args": ["/path/to/agent/src/bin/photofresco.js", "mcp", "--read", …]`.

These configurations follow each client's documented `command`/`args` stdio format. The server
itself was exercised with the official MCP client; it has not yet been run inside Claude Desktop,
Claude Code, Cursor or VS Code (recorded as a release check).

### Options

| Option | Meaning |
|---|---|
| `--read <folder>` | The agent may open image files from this folder (repeatable) |
| `--write <folder>` | The agent may save exports into this folder and new subfolders (repeatable) |
| `--overwrite` | Exports may replace existing files in `--write` folders (the agent must also ask for it) |
| `--tools <groups>` | Which operations are listed as tools: `essentials` (default, at most 40 tools with both folder options), `all`, or a comma list (below) |
| `--profile <folder>` | Browser profile folder, or `ephemeral` for a throwaway one |
| `--browser <path>` | Chromium-based browser to use (same as `PHOTOFRESCO_BROWSER`) |

A Chromium-based browser (Chrome, Edge or Chromium 120+) must be installed; see CONNECTOR.md
"Packaging decision".

## How a session goes

1. The agent calls `photofresco_connect`. PhotoFresco opens in its own window with a **connection
   code**; the agent tells you the same code. Check it and click **Allow**.
2. The session starts with **no permissions**. The agent asks (Read, Edit, Export; Send and Spend
   only for cloud and paid AI) and you choose in the **Permissions** dialog. Editing tools appear
   for the agent as you grant them.
3. The agent edits with one tool per editor operation; every document edit is in History.
   Editing yourself pauses the agent until you press **Resume**. **Stop** ends the session.

Initialization and the tool list never start a browser: nothing opens until the agent calls
`photofresco_connect`.

## Tools

- **Session**: `photofresco_connect`, `photofresco_status`, `photofresco_request_access`,
  `photofresco_documents`, `photofresco_attach`, `photofresco_disconnect`.
- **Files** (listed only for configured folders): `photofresco_import_file` (PNG, JPEG, WebP, GIF,
  BMP, AVIF, PSD/PSB, `.pfd`, at most 32 MiB) and `photofresco_export_file` (PNG, PSD or `.pfd`,
  written only after the bytes' SHA-256 matched).
- **Tool groups**: `photofresco_list_tool_groups`, `photofresco_select_tool_groups`.
- **Operations**: one tool per editor operation, named like `layer_add`, `adjust_add`,
  `render_region`, `history_undo`, with the editor's exact input schema. Each has a title, a
  description of its inputs, effect, undo behaviour and required permission, and MCP annotations
  derived from the operation's metadata (read-only, destructive, open-world). There is no generic
  "execute" tool, and the user-only controls (pairing, permissions, pause/resume/stop, privacy
  policy) are never tools.

Before a session the list shows the public catalog of operations; once connected it shows only
what your grants allow, and changes (`notifications/tools/list_changed`) when you grant, revoke or
stop. Listing a tool is documentation, not permission: the editor checks every call.

| Group | Operations |
|---|---|
| `essentials` (default) | Orient, preview, layers, adjustments, masks, selections, resize/crop, fill, undo, export (30 operations) |
| `document` | Documents, history, previews, image/canvas/crop, exports and artifacts |
| `layers` | Layers, masks, layer styles, smart objects, frames, channels |
| `selection` | Selections, quick mask, paths |
| `adjustments` | Adjustment layers, filters, liquify, warps |
| `painting` | Brushes, retouching, fills, gradients, colors, presets, edit commands |
| `text` | Type, shapes, notes, counts, ruler, slices |
| `automation` | Actions, workflows, autosave |
| `workspace` | Panels, view, dialogs, account usage, diagnostics |
| `cloud` | My Documents, feedback, paid AI (needs Send and Spend) |

### Results

- Previews (`render_preview`, `render_region`, `render_mask`) return the PNG as MCP **image
  content** plus the coordinate metadata as JSON.
- `export_artifact` returns a **resource link** `photofresco://artifact/<id>`; `resources/read`
  returns the bytes (verified against their SHA-256, at most 6 MiB; larger exports go through
  `photofresco_export_file`). Exports live 10 minutes in the editor.
- Refusals and failures are tool errors with the editor's code, its message and the next step, for
  example `capability_denied` → ask with `photofresco_request_access`, `lease_paused` → ask the user
  to press Resume.

## Agent skill

The package also carries an [Agent Skill](https://agentskills.io/specification),
`skills/photofresco/` (pf-agent-platform-nkwn.36): instructions that teach skills-capable agents
(Claude Code, Codex, Cursor and others) when to use PhotoFresco, how to connect and ask for
permissions, the orient → edit → preview → undo loop, workflows, exports, every error code and the
`photofresco` command line. It
does not install or configure the MCP server; set that up as above. Install it with the
[`skills` CLI](https://github.com/vercel-labs/skills) into the current project (`-g` for your user):

```sh
npx skills add /path/to/photofresco-checkout/agent -a claude-code -a codex -a cursor
```

Once the public repository is published (planned as `photofresco/photofresco-agent`), the source
becomes `npx skills add photofresco/photofresco-agent`. Remove it with `npx skills remove photofresco`.

## Uninstall

Remove the MCP entry from your client configuration, then follow DISCLOSURE.md "Uninstall".
