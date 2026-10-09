// @ts-check
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { CONNECTOR_ERROR_CODES, ConnectorError } from '../src/index.js'
import { ATTACH_PROTOCOL, AttachClient, RPC_ERRORS, attachPaths } from '../src/cli/attach.js'
import { startDaemon } from '../src/cli/daemon.js'
import { CLI_HINTS, EXIT, describeFailure, exitCodeFor } from '../src/cli/exit.js'
import { COMMANDS, USAGE, redactPayloads, runCli } from '../src/cli/main.js'
import { WORKFLOW_FILE_LIMITS, parseInputPairs } from '../src/cli/workflow.js'
import { loadCatalog } from '../src/mcp/tools.js'
import { assertCliResult } from './support/cliSchema.js'

/**
 * pf-agent-platform-nkwn.16: the CLI without an editor — argument parsing, exit codes, the JSON
 * result schema, workflow file checks, the attach path's local-user-only socket, and the real
 * `photofresco` bin spawning, attaching to and stopping its background connector process. The
 * editor-side flow (pairing, workflow runs, exports, refusals, cancellation) is
 * test/agent-cli.test.mjs in the editor repository; the real browser run is scripts/agent-cli-e2e.mjs.
 */

const BIN = new URL('../bin/photofresco.js', import.meta.url).pathname
const base = realpathSync(mkdtempSync(join(tmpdir(), 'pfcli-')))
after(() => rmSync(base, { recursive: true, force: true }))
let counter = 0
const fresh = () => join(base, `d${++counter}`)

/**
 * runCli in-process with --json; parses and schema-checks the single stdout line.
 * @param {string[]} args @param {string} [dataDir]
 */
async function cli(args, dataDir = fresh()) {
  let stdout = ''
  let stderr = ''
  const code = await runCli([...args, '--json', '--data-dir', dataDir], {
    stdout: { write: (text) => { stdout += text } },
    stderr: { write: (text) => { stderr += text } },
    cwd: base,
    startConnector: async () => { throw new Error('no connector process in this test') },
  })
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, 1, stdout)
  const json = /** @type {Record<string, any>} */ (assertCliResult(JSON.parse(lines[0])))
  assert.equal(json.exit_code, code)
  return { code, json, stderr }
}

/**
 * The real bin as a child process.
 * @param {string[]} args @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function bin(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(/** @type {any} */ (error).code ?? 1) : 0, stdout, stderr })
    })
  })
}

describe('arguments and exit codes', () => {
  it('prints usage and version; every command has --help', async () => {
    let out = ''
    assert.equal(await runCli([], { stdout: { write: (text) => { out += text } } }), EXIT.ok)
    assert.equal(out, USAGE)
    for (const name of Object.keys(COMMANDS)) assert.match(USAGE, new RegExp(`\\n  ${name}\\b`), `${name} listed in the usage`)
    out = ''
    assert.equal(await runCli(['run', '--help'], { stdout: { write: (text) => { out += text } } }), EXIT.ok)
    assert.match(out, /--input <name=value>/)
    const version = await bin(['--version'])
    assert.equal(version.stdout.trim(), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  })

  it('refuses bad arguments with exit 2 and a schema-valid error, before touching any connector', async () => {
    const cases = [
      ['bogus'],
      ['status', '--nope'],
      ['open'],
      ['open', 'a.png', 'b.png'],
      ['run'],
      ['run', 'w.json', '--action', 'a1'],
      ['run', 'w.json', '--on-failure', 'later'],
      ['run', 'w.json', '--format', 'png'],
      ['connect', '--overwrite'],
      ['connect', '--wait', '999'],
      ['connect', '--grant', 'read,fly'],
      ['export', 'photo.gif'],
      ['export', 'photo.png', '--format', 'jpg'],
      ['exec', 'layer.add', '[1,2]'],
      ['exec', 'layer.add', '{not json'],
      ['exec', 'layer.add', '{}', '--revision', '-1'],
      ['request-access', 'none'],
      ['outcome', 'bad id with spaces'],
      ['describe', 'no.such_op'],
    ]
    for (const args of cases) {
      const { code, json } = await cli(args)
      assert.equal(code, EXIT.usage, `${args.join(' ')} → ${JSON.stringify(json)}`)
      assert.equal(json.ok, false)
      assert.ok(json.error.hint.length > 0)
    }
  })

  it('maps failures to distinct exit codes by stage and class', () => {
    assert.equal(exitCodeFor({ code: 'path_not_granted', stage: 'path' }), EXIT.path)
    assert.equal(exitCodeFor({ code: 'capability_denied', stage: 'operation' }), EXIT.operation)
    assert.equal(exitCodeFor({ code: 'artifact_hash_mismatch', stage: 'retrieval' }), EXIT.retrieval)
    assert.equal(exitCodeFor({ code: 'write_failed', stage: 'write' }), EXIT.write)
    assert.equal(exitCodeFor({ code: 'workflow_step_failed', status: 'failed' }), EXIT.operation)
    assert.equal(exitCodeFor({ code: 'session_stopped', status: 'canceled' }), EXIT.canceled)
    assert.equal(exitCodeFor({ code: 'not_connected' }), EXIT.session)
    assert.equal(exitCodeFor({ code: 'pairing_denied' }), EXIT.session)
    assert.equal(exitCodeFor({ code: 'connector_not_running' }), EXIT.session)
    assert.equal(exitCodeFor({ code: 'pending' }), EXIT.pending)
    assert.equal(exitCodeFor({ code: 'workflow_unsupported' }), EXIT.usage)
    assert.equal(exitCodeFor({ code: 'stale_revision' }), EXIT.operation)
    assert.equal(exitCodeFor({ code: 'internal_error' }), EXIT.internal)
    assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length, 'exit codes are distinct')
    const failure = describeFailure(new ConnectorError('file_exists', 'exists', { stage: 'path' }))
    assert.deepEqual(failure, { info: { code: 'file_exists', message: 'exists', hint: CLI_HINTS.file_exists, stage: 'path' }, exitCode: EXIT.path })
  })

  it('has a next-step hint for every connector error code', () => {
    for (const code of Object.keys(CONNECTOR_ERROR_CODES)) assert.ok(Object.hasOwn(CLI_HINTS, code), `hint for ${code}`)
    for (const hint of Object.values(CLI_HINTS)) assert.doesNotMatch(hint, /photofresco_/, 'CLI hints name CLI commands, not MCP tools')
  })

  it('omits image payloads unless --include-data', () => {
    const redacted = redactPayloads({ result: { image: { data_base64: 'A'.repeat(400), width: 8 }, url: `data:image/png;base64,${'B'.repeat(40)}`, name: 'keep' } })
    assert.equal(redacted.result.image.data_base64, '[omitted: 300 bytes; --include-data keeps it]')
    assert.equal(redacted.result.image.width, 8)
    assert.match(redacted.result.url, /^\[omitted image\/png data URL: 30 bytes/)
    assert.equal(redacted.result.name, 'keep')
  })
})

describe('without a connector process', () => {
  it('status reports not running (exit 0); session commands fail with exit 3 connector_not_running', async () => {
    const dataDir = fresh()
    const status = await cli(['status'], dataDir)
    assert.equal(status.code, EXIT.ok)
    assert.deepEqual({ running: status.json.running, state: status.json.state, data_dir: status.json.data_dir }, { running: false, state: 'stopped', data_dir: dataDir })
    for (const args of [['open', 'a.png'], ['export', 'a.png'], ['exec', 'layer.add'], ['documents'], ['disconnect'], ['attach', 'doc_1'], ['outcome', 'r1'], ['request-access', 'read']]) {
      const { code, json } = await cli(args, dataDir)
      assert.equal(code, EXIT.session, args.join(' '))
      assert.equal(json.error.code, 'connector_not_running')
    }
    const stop = await cli(['stop'], dataDir)
    assert.deepEqual([stop.code, stop.json.stopped], [EXIT.ok, false])
  })

  it('ops and describe read the bundled catalog', async () => {
    const catalog = loadCatalog().operations
    const ops = await cli(['ops'])
    assert.equal(ops.json.source, 'catalog')
    assert.equal(ops.json.count, catalog.filter((op) => !op.name.startsWith('session.') && op.name !== 'privacy.set_policy').length)
    const filtered = await cli(['ops', 'workflow.'])
    assert.ok(filtered.json.operations.length >= 5 && filtered.json.operations.every((/** @type {any} */ op) => op.name.startsWith('workflow.')))
    const described = await cli(['describe', 'workflow_run'])
    assert.equal(described.json.operation.name, 'workflow.run')
    assert.ok(described.json.operation.input_schema.properties.inputs)
  })

  it('checks workflow and inputs files locally before attaching', async () => {
    const dir = fresh()
    mkdirSync(dir)
    const file = (/** @type {string} */ name, /** @type {string} */ content) => { writeFileSync(join(dir, name), content); return join(dir, name) }
    const workflow = { format: 'photofresco.workflow', version: 1, name: 'W', requires: { ops: {} }, steps: [] }
    const cases = [
      [file('v2.json', JSON.stringify({ ...workflow, version: 2 })), 'workflow_unsupported'],
      [file('text.json', 'hello'), 'workflow_unreadable'],
      [file('other.json', '{"steps":[]}'), 'workflow_unreadable'],
      [file('big.json', JSON.stringify({ ...workflow, pad: 'x'.repeat(WORKFLOW_FILE_LIMITS.maxBytes) })), 'workflow_unreadable'],
      [join(dir, 'missing.json'), 'workflow_unreadable'],
      [dir, 'workflow_unreadable'],
    ]
    for (const [path, code] of cases) {
      const result = await cli(['run', path])
      assert.deepEqual([result.code, result.json.error.code], [EXIT.usage, code], path)
    }
    const good = file('good.json', JSON.stringify(workflow))
    const badInputs = await cli(['run', good, '--inputs', file('inputs.json', '[1]')])
    assert.deepEqual([badInputs.code, badInputs.json.error.code], [EXIT.usage, 'usage'])
    // A valid file passes the local checks and then needs the connector.
    const needsConnector = await cli(['run', good, '--input', 'amount=0.5'])
    assert.equal(needsConnector.json.error.code, 'connector_not_running')
  })

  it('parses --input values as JSON when they parse, else as text', () => {
    assert.deepEqual(parseInputPairs(['a=0.5', 'b=true', 'c=hello', 'd="0.5"', 'e=[1,2]', 'f={"x":1}', 'g=', 'h=a=b']), {
      a: 0.5, b: true, c: 'hello', d: '0.5', e: [1, 2], f: { x: 1 }, g: '', h: 'a=b',
    })
    assert.throws(() => parseInputPairs(['=1']), /name=value/)
    assert.throws(() => parseInputPairs(['novalue']), /name=value/)
  })
})

describe('attach path: one connector process, local user only', () => {
  /** @param {string} dataDir */
  const daemonFor = (dataDir) => startDaemon({ dataDir, log: null, connector: { launch: async () => { throw new Error('no browser in this test') } } })

  /**
   * Raw socket exchange: send lines, collect replies until the server closes or `count` arrive.
   * @param {string} socket @param {string[]} lines @param {number} count
   * @returns {Promise<{ replies: any[], closed: boolean }>}
   */
  const exchange = (socket, lines, count) => new Promise((resolve) => {
    const replies = /** @type {any[]} */ ([])
    let buffer = ''
    const conn = createConnection(socket)
    const done = (/** @type {boolean} */ closed) => { conn.destroy(); resolve({ replies, closed }) }
    conn.on('connect', () => { for (const line of lines) conn.write(line) })
    conn.on('data', (chunk) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, end)))
        buffer = buffer.slice(end + 1)
      }
      if (replies.length >= count) done(false)
    })
    conn.on('close', () => done(true))
    conn.on('error', () => done(true))
  })

  it('serves on a private socket: 0700 folder, 0600 socket and key, no TCP listener', async () => {
    const dataDir = fresh()
    const daemon = await daemonFor(dataDir)
    try {
      const paths = attachPaths(dataDir)
      assert.equal(statSync(paths.dir).mode & 0o777, 0o700)
      assert.equal(statSync(paths.socket).mode & 0o777, 0o600)
      assert.ok(statSync(paths.socket).isSocket())
      assert.equal(statSync(paths.key).mode & 0o777, 0o600)
      assert.match(readFileSync(paths.key, 'utf8'), /^[0-9a-f]{64}$/)
      const client = await AttachClient.open(paths, { name: 'test', version: '0' })
      assert.equal(client.hello?.protocol, ATTACH_PROTOCOL)
      assert.equal(client.hello?.pid, process.pid)
      assert.equal((await client.request('status')).surface, 'cli')
      await assert.rejects(client.request('no_such_method'), (/** @type {any} */ error) => error.code === 'invalid_request' && /Unknown method/.test(error.message))
      await assert.rejects(client.request('execute', { op: 'layer.add' }), (/** @type {any} */ error) => error instanceof ConnectorError && error.code === 'not_connected')
      client.close()
    } finally {
      await daemon.stop()
    }
  })

  it('refuses connections without the key, with a wrong key or another protocol, and over-long lines', async () => {
    const dataDir = fresh()
    const daemon = await daemonFor(dataDir)
    try {
      const { socket, key } = attachPaths(dataDir)
      const realKey = readFileSync(key, 'utf8')
      const noHello = await exchange(socket, [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status' })}\n`], 1)
      assert.equal(noHello.replies[0].error.code, RPC_ERRORS.unauthorized)
      assert.equal(noHello.closed || noHello.replies.length === 1, true)
      const wrong = await exchange(socket, [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: 1, key: 'f'.repeat(64) } })}\n`, `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'status' })}\n`], 2)
      assert.equal(wrong.replies[0].error.code, RPC_ERRORS.unauthorized)
      assert.equal(wrong.replies.length, 1, 'nothing answered after a refused hello')
      const protocol = await exchange(socket, [`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: 99, key: realKey } })}\n`], 1)
      assert.equal(protocol.replies[0].error.code, RPC_ERRORS.protocol)
      const garbage = await exchange(socket, ['not json\n'], 1)
      assert.equal(garbage.replies[0].error.code, RPC_ERRORS.parse)
      const long = await exchange(socket, ['x'.repeat(17 * 1024 * 1024)], 1)
      assert.equal(long.closed, true)
      const silent = await exchange(socket, [], 1)
      assert.equal(silent.closed, true, 'a connection that never says hello is closed')
    } finally {
      await daemon.stop()
    }
  })

  it('allows one connector process per data folder and replaces a stale socket', async () => {
    const dataDir = fresh()
    const first = await daemonFor(dataDir)
    await assert.rejects(daemonFor(dataDir), (/** @type {any} */ error) => error.code === 'already_running')
    await first.stop()
    const paths = attachPaths(dataDir)
    assert.throws(() => statSync(paths.socket), 'socket removed on stop')
    assert.throws(() => statSync(paths.key), 'key removed on stop')
    // A crashed process leaves its socket file behind; the next start replaces it.
    writeFileSync(paths.socket, '')
    const second = await daemonFor(dataDir)
    assert.ok(statSync(paths.socket).isSocket())
    await second.stop()
  })

  it('clients refuse a folder others can reach', async () => {
    const dataDir = fresh()
    const daemon = await daemonFor(dataDir)
    const paths = attachPaths(dataDir)
    try {
      chmodSync(paths.dir, 0o755)
      const refused = await cli(['status'], dataDir)
      assert.deepEqual([refused.code, refused.json.error.code], [EXIT.session, 'ipc_insecure'])
    } finally {
      chmodSync(paths.dir, 0o700)
      await daemon.stop()
    }
  })

  it('exits on its own after the idle period with no browser and no client', async () => {
    const daemon = await startDaemon({ dataDir: fresh(), log: null, idleExitMs: 50 })
    await daemon.stopped
  })

  it('the real bin spawns a background connector on connect, reports it in status and stops it', async () => {
    const dataDir = fresh()
    const env = { PHOTOFRESCO_DATA_DIR: dataDir, PHOTOFRESCO_BROWSER: join(base, 'no-such-browser') }
    try {
      const connect = await bin(['connect', '--json', '--wait', '1'], env)
      assert.equal(connect.code, EXIT.session, connect.stdout + connect.stderr)
      const connected = assertCliResult(JSON.parse(connect.stdout))
      assert.equal(/** @type {any} */ (connected).error.code, 'browser_not_found')
      const status = await bin(['status', '--json'], env)
      const running = /** @type {any} */ (assertCliResult(JSON.parse(status.stdout)))
      assert.equal(running.running, true)
      assert.equal(running.state, 'idle')
      assert.notEqual(running.connector_pid, process.pid)
      assert.equal(running.surface, 'cli')
      const stopped = await bin(['stop', '--json'], env)
      assert.equal(/** @type {any} */ (assertCliResult(JSON.parse(stopped.stdout))).stopped, true)
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          process.kill(running.connector_pid, 0)
        } catch {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      assert.throws(() => process.kill(running.connector_pid, 0), 'the connector process exited')
      const after = await bin(['status'], env)
      assert.match(after.stdout, /not running/)
    } finally {
      await bin(['stop'], env)
    }
  })
})
