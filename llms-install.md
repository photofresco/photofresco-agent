# Installing the PhotoFresco MCP server (for AI agents such as Cline)

This file tells an agent how to install, connect and stop the PhotoFresco MCP server from this
repository alone. PhotoFresco is a browser-based image editor; this server lets you (the agent) edit
images in a PhotoFresco window on the user's computer that the user watches and controls. Details:
[README.md](README.md), [MCP.md](MCP.md), what it runs and sends: [DISCLOSURE.md](DISCLOSURE.md).

## 1. Check the requirements

- Node.js 22 or newer: run `node --version`. If it is older or missing, ask the user to install
  Node.js 22+ first.
- A Chromium-based browser (Google Chrome, Microsoft Edge or Chromium 120+) installed in its standard
  location. Nothing is downloaded. If the user's browser is elsewhere, add
  `"env": { "PHOTOFRESCO_BROWSER": "/path/to/browser" }` to the server entry below.
- No API key, account or environment variable is needed.

## 2. Ask the user which folders you may use

The server reaches no files unless the user names folders. Ask:

- which folder you may **open** images from (passed as `--read <folder>`), and
- which folder you may **save** exports into (passed as `--write <folder>`).

Use absolute paths. The folders must exist, or the server refuses to start ("Granted folder does not
exist"): create the export folder first, for example `mkdir -p ~/Pictures/PhotoFresco`. Both options
are optional and repeatable; without them you can still edit and preview the image the user opens in
the PhotoFresco window, and the user saves it there.

## 3. Install

The `photofresco` npm package is not published yet (planned for mid-October 2026), so
`npx -y photofresco@0.1.0` does not work until then. Install from this repository instead:

```sh
git clone https://github.com/photofresco/photofresco-agent.git ~/Documents/Cline/MCP/photofresco-agent
```

There is nothing to build and no `npm install`: the server has no runtime dependencies (the MCP SDK is
bundled in `vendor/`). Check that it starts:

```sh
node ~/Documents/Cline/MCP/photofresco-agent/src/bin/photofresco.js mcp --version
```

It prints the version (`0.1.0`). Use the absolute path of the clone (expand `~`) in the next step.

## 4. Configure

Add this entry under `mcpServers` in the MCP settings file (`cline_mcp_settings.json`; in Cline:
MCP Servers → Configure → Configure MCP Servers), replacing the paths:

```json
{
  "mcpServers": {
    "photofresco": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/you/Documents/Cline/MCP/photofresco-agent/src/bin/photofresco.js",
        "mcp",
        "--read", "/Users/you/Pictures",
        "--write", "/Users/you/Pictures/PhotoFresco"
      ],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Leave out the `--read`/`--write` pairs the user did not choose. Once `photofresco@0.1.0` is on npm,
`"command": "npx"` with `"args": ["-y", "photofresco@0.1.0", "mcp", …]` works without a clone.

The server then appears with its tools (about 40: `photofresco_connect`, `photofresco_status`,
`doc_get_state`, `render_preview`, …). Starting it and listing tools opens nothing and makes no
network request.

## 5. Connect (the user must take part)

1. Call `photofresco_connect`. A **visible PhotoFresco browser window** opens on the user's computer
   and shows a **connection code**; the tool result contains the same code. Tell the user the code
   and ask them to check it and click **Allow** in that window. If the result says `"pairing"`, call
   `photofresco_connect` again to keep waiting (the request expires after 3 minutes).
2. The session starts with **no permissions**. Call `photofresco_request_access` with
   `capabilities: ["read", "edit"]` (add `"export"` to save files) and a short `reason`. The user
   chooses in the window's **Permissions** dialog; editing tools appear once granted.
3. Call `doc_get_state` to see the open document. If no image is open, ask the user to open one in
   the window, or use `photofresco_import_file` with a file inside a `--read` folder.

The skill in [skills/photofresco/SKILL.md](skills/photofresco/SKILL.md) describes the editing loop
(orient → edit → preview → undo) and every error code.

## 6. Stop and revoke

- You end the session with `photofresco_disconnect` (`close_window: true` also closes the window).
- The user can press **Pause** or **Stop**, change permissions in the window, or close the window at
  any time; editing in the window pauses you until they press **Resume**.
- To uninstall: remove the `photofresco` entry from the MCP settings, delete the clone, and delete
  the connector's data folder (`~/Library/Application Support/PhotoFresco Connector` on macOS,
  `%LOCALAPPDATA%\PhotoFresco Connector` on Windows, `~/.local/share/photofresco-connector` on Linux).

Support: [GitHub issues](https://github.com/photofresco/photofresco-agent/issues) or
hello@photofresco.com. Website: [photofresco.com](https://photofresco.com/?pf_ref=cline).
