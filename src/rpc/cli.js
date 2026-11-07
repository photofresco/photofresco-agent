// @ts-check
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { runRpcStdio } from './server.js'

/** @param {string[]} args */
export async function runRpcCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    stdio: { type: 'boolean' }, read: { type: 'string', multiple: true, default: [] },
    write: { type: 'string', multiple: true, default: [] }, overwrite: { type: 'boolean', default: false },
    profile: { type: 'string' }, browser: { type: 'string' }, client: { type: 'string' },
    'editor-url': { type: 'string' }, 'allow-loopback-editor': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    process.stdout.write('Usage: photofresco connect --stdio [--read FOLDER] [--write FOLDER] [--overwrite]\n'
      + '  [--profile FOLDER|ephemeral] [--browser PATH] [--client NAME]\n'
      + 'Development: --editor-url URL --allow-loopback-editor\n'
      + 'JSON-RPC 2.0 over LF-delimited stdio. Nothing starts until session.connect. See protocol/README.md.\n')
    return
  }
  if (!values.stdio || positionals.length) throw new Error('Use photofresco connect --stdio; no positional arguments')
  const expand = (/** @type {string} */ path) => path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
  const read = values.read.map(expand)
  const write = values.write.map(expand)
  await runRpcStdio({ options: {
    client: values.client ?? 'SDK client',
    roots: [...new Set([...read, ...write])].map((path) => ({ path, read: read.includes(path), write: write.includes(path), overwrite: write.includes(path) && values.overwrite })),
    ...(values.profile ? { profileDir: expand(values.profile) } : {}),
    ...(values.browser ? { browserPath: expand(values.browser) } : {}),
    ...(values['editor-url'] ? { editorUrl: values['editor-url'] } : {}),
    allowLoopbackEditor: values['allow-loopback-editor'],
  } })
}
