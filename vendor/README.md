# Vendored MCP SDK

These files let `src/bin/photofresco.js mcp` run straight from a clone of this repository, which is how the
Claude Code, Cursor, Gemini CLI and Codex plugins start it, and from the npm package, which therefore has no
runtime dependencies. `src/mcp/server.js` is their only importer; there is no second copy of the SDK.

They are generated, not edited: `scripts/agent-vendor.mjs` in the PhotoFresco repository bundles the
`@modelcontextprotocol/server` that `package.json` pins as a devDependency, with its dependencies, using
rolldown. The output is readable ES modules: no minification or renaming, JSDoc comments dropped, long
generated import/export lists wrapped one name per line, each file under 200 KiB. One module is replaced:
the SDK's `_shims`, whose Node build loads the Ajv JSON Schema validator. The SDK uses that validator only
to check elicitation answers; this server sends no elicitation requests, so the replacement validator
refuses use instead of bundling Ajv.

| Package | Version | License | Source | Tarball SHA-256 |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/server` | 2.2.0 | MIT | [tarball](https://registry.npmjs.org/@modelcontextprotocol/server/-/server-2.2.0.tgz) | `8399d8477a8f27902ceb18bda1ea4364b104bae6412e863c71bf08978084174a` |
| `@modelcontextprotocol/core` | 2.2.0 | MIT | [tarball](https://registry.npmjs.org/@modelcontextprotocol/core/-/core-2.2.0.tgz) | `eb411b54b46d3b5b204289420c1904aab0e34074cfa4954a55569f958abc8dc8` |
| `zod` | 4.6.5 | MIT | [tarball](https://registry.npmjs.org/zod/-/zod-4.6.5.tgz) | `a78c0c533de30dc1c4afc259ac43ac06e390cb0da8d2e32eae355301b50b36fc` |

Each tarball is the one `package-lock.json` pins; the build checks it against the lockfile's SHA-512
integrity before recording the SHA-256 above. The packages' own license files are in `licenses/`.

## Refresh

After changing the pinned `@modelcontextprotocol/server` version in `package.json` and running
`npm install`, rebuild from the PhotoFresco repository root:

```sh
npm ci --prefix agent && node scripts/agent-vendor.mjs
```

`node scripts/agent-vendor.mjs --check` fails when these files differ from a fresh build.
