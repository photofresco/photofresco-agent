// @ts-check
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { ConnectorError } from '../errors.js'
import { loadCatalog } from '../mcp/tools.js'
import { AttachClient, attachPaths, resolveDataDir } from './attach.js'
import { spawnDaemon } from './daemon.js'
import { CliError, EXIT, describeFailure } from './exit.js'
import { WORKFLOW_FORMAT, parseInputPairs, readInputsFile, readWorkflowFile } from './workflow.js'

/**
 * `photofresco <command>` (pf-agent-platform-nkwn.16): a thin command line over the local
 * connector. Every command attaches to the background connector process for the data folder
 * (attach.js) and calls the same connector API the MCP server uses; nothing here edits pixels,
 * authorizes anything or reads image files itself. See CLI.md.
 */

const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const CLIENT_INFO = Object.freeze({ name: 'photofresco-cli', version: String(PACKAGE.version) })

export const CLI_LIMITS = Object.freeze({
  /** Longest wait for the user's Allow / Permissions decision (the editor expires requests after 3 minutes). */
  maxWaitSeconds: 180,
  defaultWaitSeconds: 170,
  /** After Ctrl-C ends the session, wait this long for the editor's final response. */
  cancelSettleMs: 10_000,
  statusPollMs: 250,
})

const DEFAULT_GRANT = 'read,edit,export'
const DEFAULT_REASON = 'Open, edit and export image files from the command line'
const CAPABILITIES = Object.freeze(['read', 'edit', 'export', 'external-write', 'spend'])
const EXPORT_FORMATS = Object.freeze({ '.png': 'png', '.psd': 'psd', '.pfd': 'pfd' })
/** Never run through the CLI: the user's own dialogs and the page-wide privacy policy. */
const USER_ONLY = (/** @type {string} */ op) => op.startsWith('session.') || op === 'privacy.set_policy'

/** @typedef {import('node:util').ParseArgsConfig['options']} Options */

const GLOBAL_OPTIONS = /** @type {const} */ ({
  json: { type: 'boolean', default: false },
  'data-dir': { type: 'string' },
  'include-data': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
})

const BROWSER_OPTIONS = /** @type {const} */ ({
  profile: { type: 'string' },
  browser: { type: 'string' },
  'editor-url': { type: 'string' },
  'allow-loopback-editor': { type: 'boolean', default: false },
})

/**
 * @typedef {object} CommandSpec
 * @property {string} args Positional arguments for the usage line.
 * @property {string} summary
 * @property {Options} options
 * @property {string} [help] Option help lines.
 * @property {[number, number]} positionals Minimum and maximum positional count.
 */

/** @type {Readonly<Record<string, CommandSpec>>} */
export const COMMANDS = Object.freeze({
  connect: {
    args: '', positionals: [0, 0],
    summary: 'Open PhotoFresco (starting the connector if needed) and pair once you click Allow',
    options: {
      read: { type: 'string', multiple: true, default: [] },
      write: { type: 'string', multiple: true, default: [] },
      overwrite: { type: 'boolean', default: false },
      grant: { type: 'string', default: DEFAULT_GRANT },
      reason: { type: 'string' },
      client: { type: 'string', default: 'Terminal' },
      document: { type: 'string' },
      wait: { type: 'string' },
      ...BROWSER_OPTIONS,
    },
    help: `  --read <folder>         Folder this session may open files from (repeatable)
  --write <folder>        Folder this session may export into (repeatable)
  --overwrite             Exports may replace existing files in --write folders
  --grant <list>          Permissions to ask for: ${CAPABILITIES.join(', ')} or none (default ${DEFAULT_GRANT})
  --reason <text>         Why, shown in the Permissions dialog
  --client <name>         Name shown in the window as "<name> via CLI" (default Terminal)
  --document <id>         Target: active (default), none or a document ID
  --wait <seconds>        How long to wait for your decision (default ${CLI_LIMITS.defaultWaitSeconds}, at most ${CLI_LIMITS.maxWaitSeconds});
                          exit 75 while still waiting, run connect again to keep waiting
  --profile <folder>      Browser profile, or "ephemeral" (only when the connector starts)
  --browser <path>        Chromium-based browser (same as PHOTOFRESCO_BROWSER)
Development only:
  --editor-url <url> --allow-loopback-editor   Open a local editor instead of photofresco.com`,
  },
  status: { args: '', positionals: [0, 0], summary: 'Connector, session, permissions and granted folders', options: {} },
  'request-access': {
    args: '<capabilities>', positionals: [1, 1],
    summary: 'Ask for more permissions (comma list); the user decides in the window',
    options: { reason: { type: 'string' }, budget: { type: 'string' }, wait: { type: 'string' } },
    help: `  --reason <text>         Why, shown in the Permissions dialog
  --budget <credits>      Credit ceiling, required with spend
  --wait <seconds>        How long to wait for the decision (default ${CLI_LIMITS.defaultWaitSeconds}; exit 75 while waiting)`,
  },
  documents: { args: '', positionals: [0, 0], summary: 'Open documents with IDs and revisions', options: {} },
  attach: { args: '<document-id>', positionals: [1, 1], summary: 'Target another open document', options: {} },
  open: {
    args: '<file>', positionals: [1, 1], summary: 'Open an image (PNG, JPEG, WebP, GIF, BMP, AVIF, PSD, .pfd) from a granted folder in a new tab',
    options: { name: { type: 'string' } },
    help: '  --name <title>          Tab title (default: the file name)',
  },
  run: {
    args: '<workflow.json>', positionals: [0, 1],
    summary: 'Run a workflow file (or a saved action) on the session document',
    options: {
      action: { type: 'string' },
      input: { type: 'string', multiple: true, default: [] },
      inputs: { type: 'string' },
      consent: { type: 'string', multiple: true, default: [] },
      'on-failure': { type: 'string' },
      open: { type: 'string' },
      export: { type: 'string' },
      format: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
      'request-id': { type: 'string' },
    },
    help: `  --action <id>           Run a saved action (action.list) instead of a workflow file
  --input <name=value>    Workflow input; value parsed as JSON when it parses (repeatable)
  --inputs <file.json>    Workflow inputs as a JSON object (--input wins)
  --consent <step-id>     Allow an irreversible barrier step (repeatable)
  --on-failure <mode>     stop (default: keep the partial result) or rollback
  --open <file>           Open this granted image first
  --export <file>         Export the result into a granted folder afterwards
  --format <png|psd|pfd>  Export format (default: from the file extension)
  --overwrite             The export may replace an existing file (needs a folder granted with --overwrite)
  --request-id <id>       Request ID for photofresco outcome after a lost connection`,
  },
  export: {
    args: '<file>', positionals: [1, 1], summary: 'Export the session document into a granted folder (written only after its SHA-256 matched)',
    options: { format: { type: 'string' }, layer: { type: 'string' }, overwrite: { type: 'boolean', default: false } },
    help: `  --format <png|psd|pfd>  Format (default: from the file extension)
  --layer <id>            Export one layer (PNG)
  --overwrite             Replace an existing file (needs a folder granted with --overwrite)`,
  },
  exec: {
    args: '<op> [params-json]', positionals: [1, 2], summary: 'Run one editor operation (name like layer.add or layer_add)',
    options: { 'params-file': { type: 'string' }, 'request-id': { type: 'string' }, revision: { type: 'string' } },
    help: `  --params-file <file>    Parameters from a JSON file instead of the argument
  --request-id <id>       Request ID for photofresco outcome after a lost connection
  --revision <n>          Refuse unless the document is at this revision`,
  },
  outcome: { args: '<request-id>', positionals: [1, 1], summary: 'The retained result of an earlier request', options: {} },
  ops: {
    args: '[prefix]', positionals: [0, 1], summary: 'Operations this session may run (the public catalog before connecting)',
    options: { catalog: { type: 'boolean', default: false } },
    help: '  --catalog               List the public catalog even when connected',
  },
  describe: { args: '<op>', positionals: [1, 1], summary: 'An operation\'s description, permissions and parameters', options: {} },
  disconnect: { args: '', positionals: [0, 0], summary: 'End the session; the window and the connector stay open', options: {} },
  stop: { args: '', positionals: [0, 0], summary: 'End the session, close the window and stop the connector', options: {} },
})

export const USAGE = `Usage: photofresco <command> [options]

Drive a PhotoFresco window you approve from scripts and agents. The first command, connect,
opens PhotoFresco in its own browser window; you check the connection code and click Allow.
Later commands reuse that window and session until you stop.

Session
  connect                 Open PhotoFresco and pair (you click Allow in the window)
  status                  Connector, session, permissions and granted folders
  request-access <list>   Ask for more permissions
  documents               Open documents
  attach <document-id>    Target another open document
  disconnect              End the session; the window stays open
  stop                    End the session and close the window and the connector

Files and workflows
  open <file>             Open an image from a granted folder in a new tab
  run <workflow.json>     Run a workflow (or --action <id>) on the document
  export <file>           Export the document into a granted folder
  exec <op> [params]      Run one editor operation
  outcome <request-id>    Result of an earlier request (after a lost connection)

Reference
  ops [prefix]            Operations this session may run (the catalog before connecting)
  describe <op>           An operation's description and parameters

MCP
  mcp                     Run the MCP server on stdin/stdout (photofresco mcp --help)

Global options
  --json                  Print one JSON object on stdout (also on failure)
  --include-data          Keep image data (base64) in results; omitted by default
  --data-dir <folder>     Connector data folder (default PHOTOFRESCO_DATA_DIR or the per-OS folder)
  -h, --help              Help (photofresco <command> --help)
  -v, --version           Version

Exit codes: 0 ok, 1 internal, 2 usage, 3 no session/connector, 4 path refused, 5 operation
failed, 6 retrieval failed, 7 write failed, 8 canceled, 75 waiting for the user.
`

/** @param {string} name */
function commandUsage(name) {
  const spec = COMMANDS[name]
  return `Usage: photofresco ${name}${spec.args ? ` ${spec.args}` : ''} [options]\n\n${spec.summary}.\n${spec.help ? `\nOptions:\n${spec.help}\n` : ''}\nGlobal options: --json, --include-data, --data-dir <folder>, -h/--help\n`
}

/**
 * @typedef {object} CliIo
 * @property {{ write: (text: string) => unknown }} [stdout]
 * @property {{ write: (text: string) => unknown }} [stderr]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {AbortSignal} [signal] Ctrl-C: cancels a running operation or workflow by ending the session.
 * @property {(config: import('./daemon.js').DaemonConfig, env: NodeJS.ProcessEnv) => Promise<void>} [startConnector]
 *   Starts the background connector process (default: spawnDaemon).
 */

/**
 * @typedef {object} Context
 * @property {string} command
 * @property {Record<string, any>} values
 * @property {string[]} positionals
 * @property {boolean} json
 * @property {boolean} includeData
 * @property {import('./attach.js').AttachPaths} paths
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {AbortSignal | undefined} signal
 * @property {{ write: (text: string) => unknown }} stdout
 * @property {{ write: (text: string) => unknown }} stderr
 * @property {NonNullable<CliIo['startConnector']>} startConnector
 */

/**
 * Run one CLI invocation. Never throws; returns the exit code.
 * @param {readonly string[]} argv Arguments after the program name.
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()
  const name = argv[0]
  const json = argv.includes('--json')
  if (name === undefined || name === '-h' || name === '--help' || name === 'help') {
    stdout.write(USAGE)
    return EXIT.ok
  }
  if (name === '-v' || name === '--version') {
    stdout.write(`${PACKAGE.version}\n`)
    return EXIT.ok
  }
  if (!Object.hasOwn(COMMANDS, name)) {
    return fail({ json, stdout, stderr, command: name }, new CliError('usage', `Unknown command "${name}". Run photofresco --help`))
  }
  const spec = COMMANDS[name]
  /** @type {Record<string, any>} */
  let values
  /** @type {string[]} */
  let positionals
  try {
    const parsed = parseArgs({ args: [...argv.slice(1)], allowPositionals: true, strict: true, options: { ...GLOBAL_OPTIONS, ...spec.options } })
    values = parsed.values
    positionals = parsed.positionals
  } catch (error) {
    return fail({ json, stdout, stderr, command: name }, new CliError('usage', `${/** @type {Error} */ (error).message}. Run photofresco ${name} --help`))
  }
  if (values.help) {
    stdout.write(commandUsage(name))
    return EXIT.ok
  }
  if (positionals.length < spec.positionals[0] || positionals.length > spec.positionals[1]) {
    return fail({ json, stdout, stderr, command: name }, new CliError('usage', `photofresco ${name} takes ${spec.args || 'no arguments'}. Run photofresco ${name} --help`))
  }
  /** @type {Context} */
  const ctx = {
    command: name, values, positionals, json: values.json === true, includeData: values['include-data'] === true,
    paths: attachPaths(resolveDataDir(values['data-dir'] === undefined ? undefined : expandHome(values['data-dir']), env, cwd)),
    cwd, env, signal: io.signal, stdout, stderr, startConnector: io.startConnector ?? spawnDaemon,
  }
  try {
    const result = await HANDLERS[name](ctx)
    const body = ctx.includeData ? result : redactPayloads(result)
    if (ctx.json) stdout.write(`${JSON.stringify({ ok: true, command: name, exit_code: EXIT.ok, ...body })}\n`)
    else stdout.write(human(name, body))
    return EXIT.ok
  } catch (error) {
    return fail(ctx, error)
  }
}

/**
 * @param {{ json: boolean, stdout: { write: (text: string) => unknown }, stderr: { write: (text: string) => unknown }, command: string, includeData?: boolean }} ctx
 * @param {unknown} error
 */
function fail(ctx, error) {
  const { info, exitCode, partial } = describeFailure(error)
  const extra = partial ? (ctx.includeData ? partial : redactPayloads(partial)) : {}
  if (ctx.json) {
    ctx.stdout.write(`${JSON.stringify({ ok: false, command: ctx.command, exit_code: exitCode, error: info, ...extra })}\n`)
  } else {
    if (partial) {
      const text = humanPartial(ctx.command, extra)
      if (text) ctx.stderr.write(text)
    }
    ctx.stderr.write(`photofresco ${ctx.command}: ${info.code}: ${info.message}\nNext: ${info.hint}\n`)
  }
  return exitCode
}

// ---- helpers ---------------------------------------------------------------------------

/** @param {string} path */
function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
}

/** @param {Context} ctx @param {string} path */
function absolute(ctx, path) {
  return resolve(ctx.cwd, expandHome(path))
}

/** @param {number} ms */
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

/** @param {Context} ctx */
function attachClient(ctx) {
  return AttachClient.open(ctx.paths, CLIENT_INFO)
}

/** @param {Context} ctx @returns {Promise<AttachClient | null>} */
async function tryAttach(ctx) {
  try {
    return await attachClient(ctx)
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'connector_not_running') return null
    throw error
  }
}

/**
 * Run `body` with a connection to the connector process, closing it afterwards.
 * @template T
 * @param {Context} ctx
 * @param {(client: AttachClient) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withClient(ctx, body) {
  const client = await attachClient(ctx)
  try {
    return await body(client)
  } finally {
    client.close()
  }
}

/**
 * @param {unknown} raw @param {string} flag @param {number} fallback @param {number} max
 */
function seconds(raw, flag, fallback, max) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > max) throw new CliError('usage', `${flag} takes seconds between 0 and ${max}`)
  return value
}

/** @param {string} list */
function capabilityList(list) {
  if (list.trim() === 'none') return []
  const capabilities = list.split(',').map((item) => item.trim()).filter(Boolean)
  const unknown = capabilities.filter((capability) => !CAPABILITIES.includes(capability))
  if (!capabilities.length || unknown.length) throw new CliError('usage', `Permissions are a comma list of ${CAPABILITIES.join(', ')} (or none); got "${list}"`)
  return [...new Set(capabilities)]
}

/**
 * Replace image payloads with a short marker so logs and terminals never carry pixels by default.
 * @param {any} value
 * @param {string} [key]
 * @returns {any}
 */
export function redactPayloads(value, key) {
  if (typeof value === 'string') {
    if (key === 'data_base64') return `[omitted: ${Math.floor((value.length * 3) / 4)} bytes; --include-data keeps it]`
    const dataUrl = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i.exec(value)
    if (dataUrl) return `[omitted ${dataUrl[1]} data URL: ${Math.floor(((value.length - dataUrl[0].length) * 3) / 4)} bytes; --include-data keeps it]`
    return value
  }
  if (Array.isArray(value)) return value.map((item) => redactPayloads(item))
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const copy = {}
    for (const [name, item] of Object.entries(value)) copy[name] = redactPayloads(item, name)
    return copy
  }
  return value
}

const ABORTED = Symbol('aborted')

/**
 * Await an editor request; on Ctrl-C end the session (the editor stops the work and keeps the
 * partial result), wait briefly for its final response and fail as canceled.
 * @template T
 * @param {Context} ctx
 * @param {AttachClient} client
 * @param {Promise<T>} request
 * @param {(response: any) => Record<string, unknown>} [partial]
 * @returns {Promise<T>}
 */
async function cancelable(ctx, client, request, partial = () => ({})) {
  const signal = ctx.signal
  if (!signal) return request
  /** @type {() => void} */
  let onAbort = () => {}
  const aborted = new Promise((resolveAbort) => {
    onAbort = () => resolveAbort(ABORTED)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const first = await Promise.race([request, aborted])
    if (first !== ABORTED) return /** @type {T} */ (first)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  ctx.stderr.write('Canceling: ending the session so the editor stops; the document keeps what was done.\n')
  await client.request('close').catch(() => {})
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const settled = await Promise.race([
    request.then((response) => ({ response }), (error) => ({ error })),
    new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(null), CLI_LIMITS.cancelSettleMs) }),
  ])
  clearTimeout(timer)
  const response = settled && 'response' in settled ? settled.response : null
  throw new CliError('canceled', 'Canceled: the session was ended so the editor stopped the work; the document keeps the partial result', {
    status: 'canceled', partial: { session_ended: true, ...partial(response) },
  })
}

/**
 * Map a failed editor response to an operation-stage error.
 * @param {Record<string, any>} response
 * @param {string} op
 * @param {Record<string, unknown>} [partial]
 */
function responseError(response, op, partial = {}) {
  return new CliError(response.code ?? (response.status === 'canceled' ? 'canceled' : 'operation_failed'), response.error ?? `${op} ${response.status ?? 'failed'}`, {
    stage: 'operation', status: response.status,
    partial: { op, request_id: response.request_id, status: response.status, document_id: response.document_id ?? null, revision: response.revision ?? null, ...(response.execution ? { execution: response.execution } : {}), ...partial },
  })
}

/**
 * Wait until the session has no pending permission request (the user decided) or the deadline.
 * @param {AttachClient} client @param {number} deadline
 * @returns {Promise<Record<string, any> | null>} Session status, or null while still pending.
 */
async function waitForDecision(client, deadline) {
  for (;;) {
    const session = await client.request('sessionStatus')
    if (!session.request) return session
    if (Date.now() >= deadline) return null
    await delay(CLI_LIMITS.statusPollMs)
  }
}

/** Operations: the session's live list when connected (unless the catalog is asked for), else the bundled catalog. @param {Context} ctx @param {boolean} preferCatalog */
async function operationList(ctx, preferCatalog) {
  if (!preferCatalog) {
    const client = await tryAttach(ctx)
    if (client) {
      try {
        if (client && (await client.request('status')).session) {
          return { source: 'session', operations: /** @type {import('../mcp/tools.js').Operation[]} */ (await client.request('operations')) }
        }
      } finally {
        client.close()
      }
    }
  }
  return { source: 'catalog', operations: loadCatalog().operations }
}

/** @param {import('../mcp/tools.js').Operation[]} operations @param {string} name */
function findOperation(operations, name) {
  return operations.find((op) => op.name === name || op.tool_name === name)
}

/**
 * Canonical op name for `exec`: `layer.add` as given; a tool name (`layer_add`) looked up in the
 * session's operations, then in the public catalog (an ungranted op is still sent, so the editor
 * refuses it with `capability_denied` and nothing runs).
 * @param {AttachClient} client @param {string} name
 */
async function resolveOperation(client, name) {
  const found = name.includes('.') ? null : findOperation(await client.request('operations'), name) ?? findOperation(loadCatalog().operations, name)
  const op = name.includes('.') ? name : found?.name
  if (!op) throw new CliError('unknown_operation', `No operation "${name}"; see photofresco ops`)
  if (USER_ONLY(op)) throw new CliError('unknown_operation', `${op} is answered by the user in the PhotoFresco window, never by an agent; nothing ran`)
  return op
}

/** @param {string} path @param {string | undefined} format */
function exportFormat(path, format) {
  const chosen = format ?? EXPORT_FORMATS[/** @type {keyof typeof EXPORT_FORMATS} */ (extname(path).toLowerCase())]
  if (chosen !== 'png' && chosen !== 'psd' && chosen !== 'pfd') {
    throw new CliError('usage', format === undefined
      ? `Cannot tell the export format from "${path}"; pass --format png, psd or pfd`
      : `--format takes png, psd or pfd, not "${format}"`)
  }
  return chosen
}

/** @param {unknown} raw @param {string} flag */
function requestId(raw, flag) {
  if (raw === undefined) return `cli-${randomUUID()}`
  if (typeof raw !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw)) throw new CliError('usage', `${flag} takes 1–128 characters of A-Z a-z 0-9 . _ : -`)
  return raw
}

/** The run ID an editor workflow error names ("… (run run_x_y)" / "Run run_x_y keeps …"). @param {unknown} message */
function runIdIn(message) {
  return typeof message === 'string' ? (/\brun_[a-z0-9]+_[a-z0-9]+\b/.exec(message)?.[0] ?? null) : null
}

// ---- commands --------------------------------------------------------------------------

/** @type {Readonly<Record<string, (ctx: Context) => Promise<Record<string, any>>>>} */
const HANDLERS = Object.freeze({
  async connect(ctx) {
    const v = ctx.values
    const capabilities = capabilityList(v.grant)
    const wait = seconds(v.wait, '--wait', CLI_LIMITS.defaultWaitSeconds, CLI_LIMITS.maxWaitSeconds)
    const read = /** @type {string[]} */ (v.read).map((path) => absolute(ctx, path))
    const write = /** @type {string[]} */ (v.write).map((path) => absolute(ctx, path))
    if (v.overwrite && !write.length) throw new CliError('usage', '--overwrite applies to --write folders; pass at least one --write')
    const roots = [
      ...read.map((path) => ({ path, read: true, write: write.includes(path), overwrite: write.includes(path) && v.overwrite === true })),
      ...write.filter((path) => !read.includes(path)).map((path) => ({ path, write: true, overwrite: v.overwrite === true })),
    ]
    /** @type {import('./daemon.js').DaemonConfig} */
    const config = {
      dataDir: ctx.paths.dataDir,
      ...(v.profile !== undefined ? { profileDir: v.profile === 'ephemeral' ? 'ephemeral' : absolute(ctx, v.profile) } : {}),
      ...(v.browser !== undefined ? { browserPath: absolute(ctx, v.browser) } : {}),
      ...(v['editor-url'] !== undefined ? { editorUrl: v['editor-url'] } : {}),
      ...(v['allow-loopback-editor'] ? { allowLoopbackEditor: true } : {}),
    }
    let client = await tryAttach(ctx)
    let started = false
    if (!client) {
      await ctx.startConnector(config, ctx.env)
      started = true
      client = await attachClient(ctx)
    }
    try {
      let status = await client.request('status')
      if (!started) checkBrowserOptions(config, status)
      for (const root of roots) await client.request('addRoot', root)
      /** @type {string | null} */
      let shown = null
      const showCode = (/** @type {string} */ code) => {
        if (code === shown) return
        shown = code
        ctx.stderr.write(`Connection code: ${code}\nCheck that the PhotoFresco window shows the same code, then click Allow.\n`)
      }
      await client.subscribe((event) => { if (event?.type === 'pairing') showCode(event.code) })
      status = await client.request('status')
      if (status.pairing) showCode(status.pairing.code)
      if (!status.session) {
        const access = capabilities.length ? { capabilities, reason: v.reason ?? DEFAULT_REASON } : undefined
        const attempt = client.request('connect', {
          client: v.client,
          ...(access ? { access } : {}),
          ...(v.document !== undefined ? { document: v.document } : {}),
        })
        // A pending `connect` is shared by later invocations; this one may stop waiting early.
        attempt.catch(() => {})
        const outcome = await cancelableWait(ctx, attempt, client, wait)
        if (outcome === 'pending') {
          const now = await client.request('status')
          throw new CliError('pending', `Waiting for you to click Allow in the PhotoFresco window (code ${now.pairing?.code ?? shown ?? 'not shown yet'})`, {
            partial: { state: now.state, code: now.pairing?.code ?? shown, expires_at: now.pairing?.expires_at ?? null, roots: now.roots },
          })
        }
      }
      let session = await client.request('sessionStatus')
      if (session.request) {
        ctx.stderr.write('Connected. Choose the permissions in the PhotoFresco window (Permissions dialog).\n')
        const decided = await interruptible(ctx, waitForDecision(client, Date.now() + wait * 1000))
        if (!decided) {
          throw new CliError('pending', 'Connected; waiting for your choice in the Permissions dialog', {
            partial: { state: 'connected', session, roots: (await client.request('status')).roots },
          })
        }
        session = decided
      }
      const final = await client.request('status')
      return { state: final.state, ...(shown ? { code: shown } : {}), session, roots: final.roots, editor: final.editor, connector_pid: client.hello?.pid ?? null }
    } finally {
      client.close()
    }
  },

  async status(ctx) {
    const client = await tryAttach(ctx)
    if (!client) return { running: false, state: 'stopped', data_dir: ctx.paths.dataDir }
    try {
      const status = await client.request('status')
      return { running: true, connector_pid: client.hello?.pid ?? null, data_dir: ctx.paths.dataDir, ...status }
    } finally {
      client.close()
    }
  },

  async 'request-access'(ctx) {
    const capabilities = capabilityList(ctx.positionals[0])
    if (!capabilities.length) throw new CliError('usage', 'request-access needs at least one permission')
    const wait = seconds(ctx.values.wait, '--wait', CLI_LIMITS.defaultWaitSeconds, CLI_LIMITS.maxWaitSeconds)
    /** @type {number | undefined} */
    let budget
    if (ctx.values.budget !== undefined) {
      budget = Number(ctx.values.budget)
      if (!Number.isInteger(budget) || budget < 1) throw new CliError('usage', '--budget takes a whole number of credits')
    }
    return withClient(ctx, async (client) => {
      await client.request('requestAccess', { capabilities, ...(budget !== undefined ? { budget_credits: budget } : {}), ...(ctx.values.reason !== undefined ? { reason: ctx.values.reason } : {}) })
      ctx.stderr.write('Choose the permissions in the PhotoFresco window (Permissions dialog).\n')
      const decided = await interruptible(ctx, waitForDecision(client, Date.now() + wait * 1000))
      if (!decided) throw new CliError('pending', 'Waiting for your choice in the Permissions dialog', { partial: { session: await client.request('sessionStatus') } })
      return { session: decided }
    })
  },

  async documents(ctx) {
    return withClient(ctx, async (client) => ({ documents: await client.request('documents') }))
  },

  async attach(ctx) {
    return withClient(ctx, async (client) => ({ session: await client.request('attach', { document: ctx.positionals[0] }) }))
  },

  async open(ctx) {
    const path = absolute(ctx, ctx.positionals[0])
    return withClient(ctx, async (client) => {
      const imported = await cancelable(ctx, client, client.request('importFile', { path, ...(ctx.values.name !== undefined ? { name: ctx.values.name } : {}) }))
      return openedResult(imported)
    })
  },

  async run(ctx) {
    const v = ctx.values
    const file = ctx.positionals[0]
    if ((file === undefined) === (v.action === undefined)) throw new CliError('usage', 'run takes a workflow file or --action <id> (one of them)')
    if (v['on-failure'] !== undefined && v['on-failure'] !== 'stop' && v['on-failure'] !== 'rollback') throw new CliError('usage', '--on-failure takes stop or rollback')
    if (v.format !== undefined && v.export === undefined) throw new CliError('usage', '--format applies to --export')
    if (v.overwrite && v.export === undefined) throw new CliError('usage', '--overwrite applies to --export')
    const exportPath = v.export !== undefined ? absolute(ctx, v.export) : undefined
    const format = exportPath ? exportFormat(exportPath, v.format) : undefined
    const id = requestId(v['request-id'], '--request-id')
    // Everything local is checked before anything reaches the editor.
    const loaded = file !== undefined ? { path: absolute(ctx, file), ...readWorkflowFile(absolute(ctx, file)) } : null
    const inputs = { ...(v.inputs !== undefined ? readInputsFile(absolute(ctx, v.inputs)) : {}), ...parseInputPairs(v.input) }
    const workflow = loaded
      ? { source: 'file', path: loaded.path, sha256: loaded.sha256, name: loaded.workflow.name ?? null, format: WORKFLOW_FORMAT.format, version: loaded.workflow.version, steps: Array.isArray(loaded.workflow.steps) ? loaded.workflow.steps.length : null }
      : { source: 'action', action_id: v.action }
    return withClient(ctx, async (client) => {
      /** @type {Record<string, any>} */
      const partial = { workflow, inputs }
      if (v.open !== undefined) {
        try {
          partial.opened = openedResult(await cancelable(ctx, client, client.request('importFile', { path: absolute(ctx, v.open) })))
        } catch (error) {
          throw withPartial(error, partial)
        }
      }
      const params = {
        ...(loaded ? { workflow: loaded.workflow } : { action_id: v.action }),
        ...(Object.keys(inputs).length ? { inputs } : {}),
        ...(v.consent.length ? { consent: v.consent } : {}),
        ...(v['on-failure'] !== undefined ? { on_failure: v['on-failure'] } : {}),
      }
      const response = await cancelable(ctx, client, client.request('execute', { op: 'workflow.run', params, request_id: id }),
        (settled) => ({ ...partial, request_id: id, ...(settled ? { response: settled } : {}) }))
      if (!response.ok) {
        const runId = runIdIn(response.error)
        /** @type {Record<string, unknown> | null} */
        let run = null
        if (runId) {
          const inspected = await client.request('execute', { op: 'workflow.runs', params: { run_id: runId } }).catch(() => null)
          if (inspected?.ok) run = inspected.result
        }
        throw responseError(response, 'workflow.run', { ...partial, run_id: runId, ...(run ? { run } : {}) })
      }
      partial.run = response.result
      partial.request_id = response.request_id
      partial.document_id = response.document_id ?? null
      partial.revision = response.revision ?? null
      if (exportPath) {
        try {
          partial.exported = await cancelable(ctx, client, client.request('exportFile', { path: exportPath, format, overwrite: v.overwrite === true }))
        } catch (error) {
          throw withPartial(error, partial)
        }
      }
      return partial
    })
  },

  async export(ctx) {
    const path = absolute(ctx, ctx.positionals[0])
    const format = exportFormat(path, ctx.values.format)
    return withClient(ctx, async (client) => ({
      file: await cancelable(ctx, client, client.request('exportFile', {
        path, format, overwrite: ctx.values.overwrite === true, ...(ctx.values.layer !== undefined ? { layer_id: ctx.values.layer } : {}),
      })),
    }))
  },

  async exec(ctx) {
    const v = ctx.values
    if (v['params-file'] !== undefined && ctx.positionals[1] !== undefined) throw new CliError('usage', 'Pass parameters as an argument or with --params-file, not both')
    /** @type {Record<string, unknown>} */
    let params = {}
    if (v['params-file'] !== undefined) params = readInputsFile(absolute(ctx, v['params-file']))
    else if (ctx.positionals[1] !== undefined) {
      try {
        params = JSON.parse(ctx.positionals[1])
      } catch {
        throw new CliError('usage', 'Parameters must be a JSON object, e.g. \'{"name":"Sky"}\'')
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new CliError('usage', 'Parameters must be a JSON object')
    }
    /** @type {number | undefined} */
    let revision
    if (v.revision !== undefined) {
      revision = Number(v.revision)
      if (!Number.isInteger(revision) || revision < 0) throw new CliError('usage', '--revision takes a whole number')
    }
    const id = requestId(v['request-id'], '--request-id')
    return withClient(ctx, async (client) => {
      const op = await resolveOperation(client, ctx.positionals[0])
      const response = await cancelable(ctx, client, client.request('execute', { op, params, request_id: id, ...(revision !== undefined ? { expected_revision: revision } : {}) }),
        (settled) => ({ op, request_id: id, ...(settled ? { response: settled } : {}) }))
      if (!response.ok) throw responseError(response, op)
      return { op, request_id: response.request_id, status: response.status, document_id: response.document_id ?? null, revision: response.revision ?? null, ...(response.replayed ? { replayed: true } : {}), result: response.result ?? null }
    })
  },

  async outcome(ctx) {
    const id = requestId(ctx.positionals[0], 'request-id')
    return withClient(ctx, async (client) => ({ request_id: id, response: await client.request('outcome', { request_id: id }) }))
  },

  async ops(ctx) {
    const { source, operations } = await operationList(ctx, ctx.values.catalog === true)
    const prefix = ctx.positionals[0]
    const listed = operations
      .filter((op) => !USER_ONLY(op.name) && (prefix === undefined || op.name.startsWith(prefix) || op.tool_name.startsWith(prefix)))
      .map((op) => ({ name: op.name, tool_name: op.tool_name, capabilities: op.capabilities, effects: op.effects, completion: op.completion, description: op.description }))
    return { source, count: listed.length, operations: listed }
  },

  async describe(ctx) {
    const { source, operations } = await operationList(ctx, false)
    const op = findOperation(operations, ctx.positionals[0])
    if (!op || USER_ONLY(op.name)) {
      throw new CliError('unknown_operation', source === 'session'
        ? `No operation "${ctx.positionals[0]}" is available to this session (it may need a permission the user has not granted); see photofresco ops --catalog`
        : `No operation "${ctx.positionals[0]}" in the catalog; see photofresco ops`)
    }
    return { source, operation: op }
  },

  async disconnect(ctx) {
    return withClient(ctx, async (client) => {
      const had = (await client.request('status')).session !== null
      await client.request('close')
      return { disconnected: had, state: (await client.request('status')).state }
    })
  },

  async stop(ctx) {
    const client = await tryAttach(ctx)
    if (!client) return { stopped: false, running: false, data_dir: ctx.paths.dataDir }
    const pid = client.hello?.pid ?? null
    try {
      await client.request('shutdown')
    } catch (error) {
      // The process may close the connection as it exits.
      if (!(error instanceof ConnectorError && error.code === 'connector_disconnected')) throw error
    } finally {
      client.close()
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const again = await tryAttach(ctx)
      if (!again) return { stopped: true, running: false, connector_pid: pid, data_dir: ctx.paths.dataDir }
      again.close()
      await delay(125)
    }
    throw new CliError('internal_error', 'The connector process did not stop')
  },
})

/**
 * Browser options apply only when the connector process starts; refuse ones that differ from the
 * running process instead of silently ignoring them.
 * @param {import('./daemon.js').DaemonConfig} config @param {Record<string, any>} status
 */
function checkBrowserOptions(config, status) {
  if (config.editorUrl !== undefined && new URL(config.editorUrl).href !== status.editor.url) {
    throw new CliError('daemon_running', `The connector already runs with editor ${status.editor.url}`)
  }
  if (config.browserPath !== undefined && status.browser && status.browser.executable !== config.browserPath) {
    throw new CliError('daemon_running', `The connector already runs with browser ${status.browser.executable}`)
  }
  if (config.profileDir !== undefined && status.browser && status.browser.profile !== config.profileDir) {
    throw new CliError('daemon_running', `The connector already runs with profile ${status.browser.profile}`)
  }
}

/**
 * Wait for the pairing to finish: up to `wait` seconds once the code is shown (starting the
 * browser and editor is bounded by the connector itself). Ctrl-C stops waiting.
 * @param {Context} ctx @param {Promise<any>} attempt @param {AttachClient} client @param {number} wait
 * @returns {Promise<'connected' | 'pending'>}
 */
async function cancelableWait(ctx, attempt, client, wait) {
  let pendingSince = 0
  const settled = attempt.then(() => /** @type {const} */ ('connected'))
  settled.catch(() => {})
  for (;;) {
    const tick = await interruptible(ctx, Promise.race([settled, delay(CLI_LIMITS.statusPollMs).then(() => null)]))
    if (tick) return tick
    const status = await client.request('status')
    if (status.state === 'pairing') {
      pendingSince ||= Date.now()
      if (Date.now() - pendingSince >= wait * 1000) return 'pending'
    }
  }
}

/**
 * Ctrl-C while waiting (no edit running): stop waiting.
 * @template T @param {Context} ctx @param {Promise<T>} promise @returns {Promise<T>}
 */
async function interruptible(ctx, promise) {
  const signal = ctx.signal
  if (!signal) return promise
  if (signal.aborted) throw new CliError('interrupted', 'Interrupted')
  /** @type {() => void} */
  let onAbort = () => {}
  const aborted = new Promise((_, rejectAbort) => {
    onAbort = () => rejectAbort(new CliError('interrupted', 'Interrupted while waiting; the request stays open in the PhotoFresco window until it is answered or expires'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, /** @type {Promise<never>} */ (aborted)])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** @param {any} imported importFile result */
function openedResult(imported) {
  return {
    file: { path: imported.path, bytes: imported.bytes },
    request_id: imported.response.request_id,
    document_id: imported.response.document_id ?? null,
    revision: imported.response.revision ?? null,
    result: imported.response.result ?? null,
  }
}

/**
 * Attach what a multi-step command already did to its failure.
 * @param {unknown} error @param {Record<string, unknown>} partial
 */
function withPartial(error, partial) {
  if (error instanceof CliError) {
    return new CliError(error.code, error.message, { stage: error.stage, status: error.status, details: error.details, partial: { ...partial, ...error.partial } })
  }
  if (error instanceof ConnectorError) {
    return new CliError(error.code, error.message, { ...(error.stage ? { stage: error.stage } : {}), ...(error.details ? { details: error.details } : {}), partial })
  }
  return error
}

// ---- human output ----------------------------------------------------------------------

/** @param {any} session */
function sessionLine(session) {
  if (!session) return 'Session: none'
  const grants = session.grants?.length ? session.grants.join(', ') : 'none yet'
  return `Session: ${session.client ?? 'agent'} · ${session.session_id ?? ''} · permissions: ${grants}${session.request ? ` · waiting for: ${session.request.capabilities.join(', ')}` : ''}${session.document_id ? ` · document ${session.document_id}` : ''}`
}

/** @param {any[]} roots */
function rootLines(roots) {
  if (!roots?.length) return 'Folders: none granted (connect --read/--write)'
  return `Folders:\n${roots.map((root) => `  ${[root.read && 'read', root.write && 'write', root.overwrite && 'overwrite'].filter(Boolean).join('+')}  ${root.path}`).join('\n')}`
}

/** @param {any} file */
function fileLine(file) {
  return `${file.path} (${file.format ?? ''}${file.format ? ', ' : ''}${file.bytes} bytes${file.sha256 ? `, sha256 ${file.sha256.slice(0, 16)}…` : ''}${file.replaced ? ', replaced' : ''})`
}

/** @param {any} run */
function runLine(run) {
  if (!run) return ''
  const done = Array.isArray(run.steps) ? run.steps.filter((/** @type {any} */ step) => step.status === 'succeeded').length : 0
  const total = Array.isArray(run.steps) ? run.steps.length : 0
  return `Workflow "${run.name}" ${run.state}: ${done}/${total} steps, ${run.commands ?? 0} edits (run ${run.run_id}${run.document_id ? `, document ${run.document_id}` : ''})`
}

/** @param {string} description */
function firstSentence(description) {
  const text = description.replace(/\s+/g, ' ').trim()
  const end = text.search(/\.(\s|$)/)
  const sentence = end > 0 ? text.slice(0, end + 1) : text
  return sentence.length > 110 ? `${sentence.slice(0, 109)}…` : sentence
}

/** @param {string} command @param {Record<string, any>} body */
function human(command, body) {
  /** @type {string[]} */
  const lines = []
  switch (command) {
    case 'connect':
      lines.push(`Connected (${body.editor?.origin ?? ''}).`, sessionLine(body.session), rootLines(body.roots))
      break
    case 'status':
      if (!body.running) {
        lines.push(`Connector: not running (data folder ${body.data_dir}). Start it with photofresco connect.`)
        break
      }
      lines.push(`Connector: running (process ${body.connector_pid}) · state ${body.state} · editor ${body.editor?.url}`)
      if (body.browser) lines.push(`Browser: ${body.browser.product} (process ${body.browser.pid})`)
      if (body.pairing) lines.push(`Waiting for Allow: code ${body.pairing.code}`)
      lines.push(sessionLine(body.session))
      if (!body.session && body.last_end) lines.push(`Last session ended: ${body.last_end.message} (${body.last_end.code})`)
      lines.push(rootLines(body.roots))
      break
    case 'request-access':
    case 'attach':
      lines.push(sessionLine(body.session))
      break
    case 'documents':
      if (!body.documents?.length) lines.push('No open documents.')
      for (const doc of body.documents ?? []) lines.push(`${doc.document_id}  ${doc.name ?? ''}  revision ${doc.revision}${doc.active ? '  (active)' : ''}`)
      break
    case 'open':
      lines.push(`Opened ${body.file.path} (${body.file.bytes} bytes) as document ${body.document_id} (revision ${body.revision}).`)
      break
    case 'run':
      if (body.opened) lines.push(`Opened ${body.opened.file.path} as document ${body.opened.document_id}.`)
      lines.push(runLine(body.run))
      if (body.exported) lines.push(`Exported ${fileLine(body.exported)}`)
      break
    case 'export':
      lines.push(`Wrote ${fileLine(body.file)}`)
      break
    case 'exec':
      lines.push(`${body.op} ${body.status} (document ${body.document_id ?? 'none'}, revision ${body.revision ?? '-'})`)
      if (body.result !== null && body.result !== undefined) lines.push(JSON.stringify(body.result, null, 2))
      break
    case 'outcome':
      lines.push(JSON.stringify(body.response, null, 2))
      break
    case 'ops':
      lines.push(`${body.count} operations (${body.source === 'session' ? 'granted to this session' : 'public catalog; connect to see what this session may run'}):`)
      for (const op of body.operations) lines.push(`  ${op.name.padEnd(30)} ${op.capabilities.join('+').padEnd(12)} ${firstSentence(op.description)}`)
      break
    case 'describe': {
      const op = body.operation
      lines.push(`${op.name} (tool ${op.tool_name})`, '', op.description.trim(), '',
        `Permissions: ${op.capabilities.join(' + ')} · effects: ${op.effects.join(', ')} · completes: ${op.completion}`,
        'Parameters:', JSON.stringify(op.input_schema, null, 2))
      break
    }
    case 'disconnect':
      lines.push(body.disconnected ? 'Session ended; the window stays open.' : 'No session was active.')
      break
    case 'stop':
      lines.push(body.stopped ? 'Connector stopped and its window closed.' : 'No connector was running.')
      break
  }
  return `${lines.filter((line) => line !== '').join('\n')}\n`
}

/** What a failed multi-step command already did (human output). @param {string} command @param {Record<string, any>} partial */
function humanPartial(command, partial) {
  /** @type {string[]} */
  const lines = []
  if (command === 'connect' && partial.code) lines.push(`Code ${partial.code} is still waiting in the PhotoFresco window.`)
  if (partial.opened) lines.push(`Opened ${partial.opened.file.path} as document ${partial.opened.document_id}.`)
  if (partial.run) lines.push(runLine(partial.run))
  else if (partial.run_id) lines.push(`Run ${partial.run_id} keeps its partial result in the document.`)
  if (partial.run?.failure) lines.push(`Stopped at step ${partial.run.failure.step_id} (${partial.run.failure.op}): ${partial.run.failure.error}`)
  return lines.length ? `${lines.join('\n')}\n` : ''
}
