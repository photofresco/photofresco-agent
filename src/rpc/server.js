// @ts-check
import { readFileSync } from 'node:fs'
import { createConnector } from '../connector.js'
/** @typedef {import('../connector.js').Connector} Connector */
/** @typedef {import('../connector.js').ConnectorOptions} ConnectorOptions */
import { ConnectorError } from '../errors.js'
import { loadProtocolCatalog } from './catalog.js'
import { validate } from './schema.js'

export const PROTOCOL = JSON.parse(readFileSync(new URL('../../protocol/connector.openrpc.json', import.meta.url), 'utf8'))
export const PROTOCOL_VERSION = String(PROTOCOL['x-protocol-version'])
export const RPC_LIMITS = Object.freeze({ maxInputBytes: 48 * 1024 * 1024, maxInFlight: 8, maxArtifactBytes: 6 * 1024 * 1024 })

/** Stable numeric categories, with the original precise code retained in error.data.code. @param {string} code */
export function errorNumber(code) {
  if (code === 'not_connected' || code === 'session_ended') return -32001
  if (/denied|revoked|reserved_operation|path_(not_granted|escape)|consent_required|file_exists/.test(code)) return -32002
  if (code === 'stale_revision') return -32003
  if (/canceled|cancelled|session_stopped/.test(code)) return -32004
  if (/outcome_unknown|unknown_outcome/.test(code)) return -32005
  if (/too_large|too_many|resource_limit|artifact_limit|budget_exhausted/.test(code)) return -32006
  if (/version_mismatch|editor_unsupported/.test(code)) return -32007
  if (/invalid_|unknown_operation/.test(code)) return -32602
  return -32000
}

export class RpcAdapter {
  /** @param {import('../connector.js').Connector} connector */
  constructor(connector) {
    this.connector = connector
    this.catalog = loadProtocolCatalog().operations
  }

  /** @param {string} method @param {any} params */
  async call(method, params = {}) {
    if (method === 'rpc.discover') {
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) throw new ConnectorError('invalid_params', 'rpc.discover takes no parameters')
      return PROTOCOL
    }
    const spec = PROTOCOL.methods.find((/** @type {any} */ item) => item.name === method)
    if (!spec) throw Object.assign(new Error('Method not found'), { rpcCode: -32601 })
    const schema = {
      type: 'object', properties: Object.fromEntries(spec.params.map((/** @type {any} */ p) => [p.name, p.schema])),
      required: spec.params.filter((/** @type {any} */ p) => p.required).map((/** @type {any} */ p) => p.name), additionalProperties: false,
    }
    const invalid = validate(params, schema, PROTOCOL)
    if (invalid) throw new ConnectorError('invalid_params', invalid)
    const c = this.connector
    switch (method) {
      case 'session.connect': {
        const { protocol_version, ...request } = params
        if (protocol_version !== PROTOCOL_VERSION) throw new ConnectorError('version_mismatch', `Supported protocol: ${PROTOCOL_VERSION}`)
        return c.connect(request)
      }
      case 'connector.status': return { ...c.status(), protocol_version: PROTOCOL_VERSION }
      case 'session.status': return c.sessionStatus()
      case 'session.requestAccess': return c.requestAccess(params)
      case 'session.documents': return c.documents()
      case 'session.attach': return c.attach(params)
      case 'session.release': return c.release()
      case 'session.stop':
        if (params.close_window) await c.shutdown()
        else await c.close()
        return null
      case 'ops.list': return c.status().session ? c.operations() : this.catalog
      case 'ops.describe': {
        const list = c.status().session ? await c.operations() : this.catalog
        const op = list.find((/** @type {any} */ item) => item.name === params.op || item.tool_name === params.op)
        if (!op) throw new ConnectorError('unknown_operation', 'Operation is unknown or unavailable to this session')
        return op
      }
      case 'ops.execute': {
        const outcome = await c.execute(params)
        if (!outcome.ok) throw new ConnectorError(outcome.code ?? (outcome.status === 'canceled' ? 'canceled' : 'operation_failed'), outcome.error ?? 'Operation failed', { stage: 'operation', details: { outcome } })
        return outcome
      }
      case 'ops.outcome': return c.outcome(params)
      case 'artifact.fetch': {
        const result = await c.fetchArtifact(params)
        return { artifact_id: result.artifact_id, byte_length: result.byte_length, sha256: result.sha256, data_base64: result.bytes.toString('base64') }
      }
      case 'file.import': return c.importFile(params)
      case 'file.export': return c.exportFile(params)
      default: throw new Error(`Missing handler: ${method}`)
    }
  }

  /** @param {any} request @returns {Promise<any>} */
  async respond(request) {
    const valid = request && typeof request === 'object' && !Array.isArray(request) && request.jsonrpc === '2.0'
      && typeof request.method === 'string'
      && (!Object.hasOwn(request, 'id') || typeof request.id === 'string' || Number.isSafeInteger(request.id) || request.id === null)
      && Object.keys(request).every((key) => ['jsonrpc', 'id', 'method', 'params'].includes(key))
    if (!valid) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request' } }
    const notification = !Object.hasOwn(request, 'id')
    try {
      const result = await this.call(request.method, request.params === undefined ? {} : request.params)
      return notification ? null : { jsonrpc: '2.0', id: request.id, result: result ?? null }
    } catch (error) {
      if (notification) return null
      const e = /** @type {any} */ (error)
      const known = error instanceof ConnectorError
      return { jsonrpc: '2.0', id: request.id, error: {
        code: e.rpcCode ?? (known ? errorNumber(error.code) : -32603),
        message: known || e.rpcCode ? e.message : 'Internal connector error',
        ...(known ? { data: { code: error.code, ...(error.stage ? { stage: error.stage } : {}),
          ...(error.details?.outcome ? { outcome: error.details.outcome } : {}) } } : {}),
      } }
    }
  }
}

/** Owns only its connector window; concurrent dispatch keeps Stop usable during pairing/edits.
 * @param {{ connector?: Connector, options?: Omit<ConnectorOptions, 'surface'>,
 * input?: import('node:stream').Readable, output?: NodeJS.WritableStream, signals?: boolean }} [options] */
export async function runRpcStdio({ connector = createConnector({ surface: 'sdk' }), options, input = process.stdin, output = process.stdout, signals = true } = {}) {
  if (options) connector = createConnector({ ...options, surface: 'sdk' })
  const adapter = new RpcAdapter(connector)
  const send = (/** @type {any} */ body) => { if (body) output.write(JSON.stringify(body) + '\n') }
  const unsubscribe = connector.subscribe((event) => send({ jsonrpc: '2.0', method: 'connector.event', params: event }))
  /** @type {Set<Promise<void>>} */
  const pending = new Set()
  /** @type {Set<string | number | null>} */
  const ids = new Set()
  const stop = () => { void connector.shutdown(); input.destroy?.() }
  if (signals) { process.once('SIGINT', stop); process.once('SIGTERM', stop) }
  /** @type {Buffer[]} */
  let parts = []
  let size = 0
  let dropping = false
  const accept = (/** @type {Buffer} */ frame) => {
    if (!frame.length) return
    let request
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
    const id = request?.id
    if ((pending.size >= RPC_LIMITS.maxInFlight && request?.method !== 'session.stop') || (id !== undefined && ids.has(id))) {
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32006, message: 'In-flight request limit or duplicate ID', data: { code: 'too_many_requests' } } })
      return
    }
    if (id !== undefined) ids.add(id)
    const task = adapter.respond(request).then(send).finally(() => { pending.delete(task); ids.delete(id) })
    pending.add(task)
  }
  try {
    for await (const raw of input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
      let offset = 0
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset)
        const end = newline < 0 ? chunk.length : newline
        const piece = chunk.subarray(offset, end)
        size += piece.length
        if (!dropping && size > RPC_LIMITS.maxInputBytes) {
          dropping = true; parts = []
          send({ jsonrpc: '2.0', id: null, error: { code: -32006, message: 'Input frame too large', data: { code: 'resource_limit' } } })
        }
        if (!dropping) parts.push(piece)
        if (newline >= 0) {
          if (!dropping) accept(Buffer.concat(parts, size))
          parts = []; size = 0; dropping = false
        }
        offset = end + 1
      }
    }
    if (size && !dropping) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Incomplete frame: LF required' } })
  } finally {
    await connector.shutdown()
    await Promise.allSettled(pending)
    unsubscribe()
    if (signals) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
  }
}
