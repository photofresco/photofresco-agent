#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'

/**
 * The `photofresco` command: `photofresco mcp` runs the MCP server (.15, MCP.md); every other
 * command is the CLI (.16, CLI.md) over the same local connector.
 */

const MCP_USAGE = `Usage: photofresco mcp [options]

Run the PhotoFresco MCP server on stdin/stdout. Nothing starts until the agent calls
photofresco_connect, which opens PhotoFresco in its own browser window and asks you to allow
the agent there.

Options:
  --read <folder>      Let the agent open image files from this folder (repeatable)
  --write <folder>     Let the agent save exports into this folder (repeatable)
  --overwrite          Exports may replace existing files in --write folders
  --tools <groups>     Tool groups to list: essentials (default), all, or a comma list of
                       %GROUPS%
  --profile <folder>   Browser profile folder, or "ephemeral" for a throwaway one
                       (default: the connector's data folder, see DISCLOSURE.md)
  --browser <path>     Chromium-based browser to use (same as PHOTOFRESCO_BROWSER)
  -h, --help           Show this help
  -v, --version        Show the version

Development only:
  --editor-url <url>          Editor to open instead of https://photofresco.com/app/
  --allow-loopback-editor     Permit an http://127.0.0.1 or localhost --editor-url
`

/** `~/Pictures` → `/Users/me/Pictures` (MCP client configs pass arguments without a shell). @param {string} path */
const expandHome = (path) => (path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path)

/** @param {string[]} args Arguments after `mcp`. */
async function runMcp(args) {
  const { runStdioServer } = await import('../mcp/server.js')
  const { TOOL_GROUPS, parseToolGroups } = await import('../mcp/tools.js')
  const usage = MCP_USAGE.replace('%GROUPS%', Object.keys(TOOL_GROUPS).join(', '))
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      read: { type: 'string', multiple: true, default: [] },
      write: { type: 'string', multiple: true, default: [] },
      overwrite: { type: 'boolean', default: false },
      tools: { type: 'string' },
      profile: { type: 'string' },
      browser: { type: 'string' },
      'editor-url': { type: 'string' },
      'allow-loopback-editor': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
  if (values.version) {
    process.stdout.write(`${JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version}\n`)
    return
  }
  if (values.help) {
    process.stdout.write(usage)
    return
  }
  if (positionals.length) throw new Error(`Unknown argument: ${positionals.join(' ')}\n\n${usage}`)
  const read = values.read.map(expandHome)
  const write = values.write.map(expandHome)
  const roots = [
    ...read.map((path) => ({ path, read: true, write: write.includes(path), overwrite: write.includes(path) && values.overwrite })),
    ...write.filter((path) => !read.includes(path)).map((path) => ({ path, write: true, overwrite: values.overwrite })),
  ]
  runStdioServer({
    roots,
    groups: parseToolGroups(values.tools),
    connector: {
      ...(values.profile !== undefined ? { profileDir: values.profile === 'ephemeral' ? 'ephemeral' : expandHome(values.profile) } : {}),
      ...(values.browser !== undefined ? { browserPath: expandHome(values.browser) } : {}),
      ...(values['editor-url'] !== undefined ? { editorUrl: values['editor-url'] } : {}),
      allowLoopbackEditor: values['allow-loopback-editor'],
    },
  })
}

/** @param {string[]} args Arguments after the program name. */
async function runCommandLine(args) {
  const { runCli } = await import('../cli/main.js')
  const controller = new AbortController()
  let interrupts = 0
  process.on('SIGINT', () => {
    // First Ctrl-C cancels the running edit (the CLI ends the session); a second one exits now.
    if (++interrupts > 1) process.exit(130)
    controller.abort()
  })
  process.exitCode = await runCli(args, { signal: controller.signal })
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === 'mcp') return runMcp(args.slice(1))
  if (args[0] === '__daemon') {
    const { runDaemonProcess } = await import('../cli/daemon.js')
    return runDaemonProcess()
  }
  return runCommandLine(args)
}

main().catch((error) => {
  process.stderr.write(`photofresco: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
