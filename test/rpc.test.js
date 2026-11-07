// @ts-check
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { createConnector } from '../src/connector.js'
import { McpAdapter } from '../src/mcp/server.js'
import { RpcAdapter, runRpcStdio, errorNumber } from '../src/rpc/server.js'
import { StdioClient } from '../src/rpc/client.js'

const vectors = JSON.parse(readFileSync(new URL('../protocol/vectors.json', import.meta.url), 'utf8')).vectors
describe('language-neutral JSON-RPC vectors', () => {
  for (const vector of vectors) it(vector.request.id ?? 'notification: no response', async () => {
    const connector = createConnector({ surface: 'sdk' })
    const response = await new RpcAdapter(connector).respond(vector.request)
    if (vector.error) {
      assert.equal(response.error.code, vector.error.code)
      if (vector.error.data_code) assert.equal(response.error.data.code, vector.error.data_code)
    } else assert.deepEqual(response, vector.response)
    assert.equal(connector.status().browser, null)
  })
})

describe('stdio boundary', () => {
  it('keeps Stop available with eight pending connection calls', async () => {
    const connector = createConnector({ surface: 'sdk' })
    /** @type {Array<() => void>} */
    const resume = []
    connector.connect = () => new Promise((resolve) => { resume.push(() => resolve({ stopped: true })) })
    connector.shutdown = async () => { for (const resolve of resume.splice(0)) resolve() }
    const input = new PassThrough(); const output = new PassThrough()
    let text = ''; output.on('data', (chunk) => { text += chunk })
    const run = runRpcStdio({ connector, input, output, signals: false })
    for (let id = 0; id < 8; id++) input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'session.connect', params: { protocol_version: '1.0.0' } }) + '\n')
    await new Promise((resolve) => setImmediate(resolve))
    input.write('{"jsonrpc":"2.0","id":8,"method":"connector.status"}\n')
    input.write('{"jsonrpc":"2.0","id":9,"method":"session.stop","params":{"close_window":true}}\n')
    await new Promise((resolve) => setImmediate(resolve))
    input.end(); await run
    const responses = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(responses.find((r) => r.id === 8).error.code, -32006)
    assert.equal(responses.find((r) => r.id === 9).result, null)
    assert.equal(responses.length, 10)
  })

  it('the public bin boots, discovers, rejects a mismatched version and starts no browser', async () => {
    const client = new StdioClient({ stderr: 'ignore' })
    try {
      assert.equal((await client.call('rpc.discover')).openrpc, '1.3.2')
      assert.equal((await client.call('connector.status')).browser, null)
      await assert.rejects(client.call('session.connect', { protocol_version: 'other' }), (/** @type {any} */ error) => error.code === -32007)
      assert.equal((await client.call('connector.status')).state, 'idle')
    } finally { await client.close() }
  })

  it('recovers after malformed JSON and split frames; notifications get no response', async () => {
    const input = new PassThrough(); const output = new PassThrough()
    let text = ''; output.on('data', (chunk) => { text += chunk })
    const connector = createConnector({ surface: 'sdk' })
    const run = runRpcStdio({ connector, input, output, signals: false })
    input.write('garbage\n{"jsonrpc":"2.0","id":"a","method":"connector.')
    input.write('status"}\n{"jsonrpc":"2.0","method":"connector.status"}\n')
    await new Promise((resolve) => setImmediate(resolve))
    input.end()
    await run
    const lines = text.trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].error.code, -32700)
    assert.equal(lines[1].id, 'a')
    assert.equal(lines[1].result.browser, null)
  })

  it('bounds fetches and refuses undeclared authority/option fields before connector work', async () => {
    const adapter = new RpcAdapter(createConnector({ surface: 'sdk' }))
    for (const request of [
      { method: 'artifact.fetch', params: { artifact_id: 'x', max_bytes: 6291457 } },
      { method: 'artifact.fetch', params: { artifact_id: 'x', max_bytes: -1 } },
      { method: 'session.connect', params: { protocol_version: '1.0.0', roots: ['/'] } },
      { method: 'ops.execute', params: { op: 'doc.get_state', request_id: 'x', guard: 'bypass' } },
      { method: 'connector.status', params: null },
    ]) {
      const response = await adapter.respond({ jsonrpc: '2.0', id: 'bad', ...request })
      assert.equal(response.error.code, -32602)
    }
    assert.equal(adapter.connector.status().state, 'idle')
  })

  it('MCP and RPC refuse file paths and operations before pairing through the shared connector', async () => {
    const connector = createConnector({ surface: 'sdk' })
    const rpc = new RpcAdapter(connector)
    const mcp = new McpAdapter({ connector })
    for (const [method, params, tool, args] of [
      ['file.import', { path: '/ungranted/file.png' }, 'photofresco_import_file', { path: '/ungranted/file.png' }],
      ['file.export', { path: '/ungranted/file.png', format: 'png' }, 'photofresco_export_file', { path: '/ungranted/file.png', format: 'png' }],
      ['ops.execute', { op: 'layer.add', params: {}, request_id: 'a' }, 'layer_add', {}],
    ]) {
      const r = await rpc.respond({ jsonrpc: '2.0', id: 'same', method, params })
      const m = await mcp.callTool(/** @type {any} */ ({}), { name: /** @type {string} */ (tool), arguments: args }, {})
      assert.equal(r.error.data.code, 'not_connected')
      assert.equal(m.structuredContent?.code, r.error.data.code)
    }
    assert.equal(connector.status().browser, null)
  })

  it('keeps exact outcome categories stable', () => {
    for (const [code, expected] of Object.entries({ capability_denied: -32002, path_escape: -32002, invalid_params: -32602,
      stale_revision: -32003, canceled: -32004, outcome_unknown: -32005, artifact_too_large: -32006, artifact_limit: -32006, version_mismatch: -32007 })) {
      assert.equal(errorNumber(code), expected, code)
    }
  })
})
