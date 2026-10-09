// @ts-check
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { defaultDataDir, lockProfile } from '../browser.js'
import { ConnectorError } from '../errors.js'

/**
 * The attach path (pf-agent-platform-nkwn.16): how separate `photofresco` invocations reuse one
 * connector, its browser window and its paired session.
 *
 * One background connector process per data folder owns the connector (createConnector, surface
 * `cli`) and serves its API over a local socket: a Unix domain socket in a private folder
 * (`<data>/cli/connector.sock`; a named pipe on Windows). No TCP or WebSocket listener exists.
 * Callers are the same OS user: the folder must be a real directory owned by this user with no
 * group/other permissions (checked by both sides), the socket is 0600, and every connection must
 * first present the attach key (`<data>/cli/attach.key`, 0600, new random 32 bytes per start).
 * The key is defence in depth against a mis-permissioned folder, not a boundary against code
 * already running as the same user (out of scope, as in CONNECTOR.md).
 *
 * Wire format: newline-delimited JSON-RPC 2.0, one message per line. The first request must be
 * `hello { protocol, key, client }`. Methods mirror the connector API (see CLI.md "Attach
 * protocol"); connector failures are JSON-RPC errors whose `data` is ConnectorError#toJSON().
 */

export const ATTACH_PROTOCOL = 1

export const ATTACH_LIMITS = Object.freeze({
  /** Longest request line the connector process accepts (workflow documents, op params). */
  maxRequestBytes: 16 * 1024 * 1024,
  /** Longest response line a client accepts. */
  maxResponseBytes: 64 * 1024 * 1024,
  /** Largest artifact returned inline by fetchArtifact (base64 adds a third). */
  maxArtifactBytes: 32 * 1024 * 1024,
  /** A connection must say hello this soon. */
  helloMs: 5_000,
  /** Unix socket paths are limited to 104 bytes on macOS (108 on Linux). */
  maxSocketPath: 103,
})

/** JSON-RPC error codes of the attach protocol. */
export const RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** A connector or editor failure: `data` is { code, message, stage?, details? }. */
  connector: -32000,
  /** No or wrong attach key; the connection is closed. */
  unauthorized: -32001,
  /** The client speaks another attach protocol version. */
  protocol: -32002,
})

/**
 * Connector API methods served over the socket, with the request each takes. The connector does
 * all validation; these only forward. `subscribe` and `shutdown` are handled by the server.
 * @type {Readonly<Record<string, (connector: import('../connector.js').Connector, params: any) => unknown>>}
 */
export const ATTACH_METHODS = Object.freeze({
  status: (connector) => connector.status(),
  connect: (connector, params) => connector.connect(params ?? {}),
  close: (connector) => connector.close(),
  sessionStatus: (connector) => connector.sessionStatus(),
  documents: (connector) => connector.documents(),
  attach: (connector, params) => connector.attach(params ?? {}),
  release: (connector) => connector.release(),
  operations: (connector) => connector.operations(),
  requestAccess: (connector, params) => connector.requestAccess(params),
  execute: (connector, params) => connector.execute(params),
  outcome: (connector, params) => connector.outcome(params),
  importFile: (connector, params) => connector.importFile(params),
  exportFile: (connector, params) => connector.exportFile(params),
  roots: (connector) => connector.roots(),
  addRoot: (connector, params) => connector.addRoot(params),
  fetchArtifact: async (connector, params) => {
    const max = Math.min(typeof params?.max_bytes === 'number' ? params.max_bytes : ATTACH_LIMITS.maxArtifactBytes, ATTACH_LIMITS.maxArtifactBytes)
    const artifact = await connector.fetchArtifact({ artifact_id: params?.artifact_id, max_bytes: max })
    return { artifact_id: artifact.artifact_id, byte_length: artifact.byte_length, sha256: artifact.sha256, data_base64: artifact.bytes.toString('base64') }
  },
})

/**
 * The data folder: the explicit option, else PHOTOFRESCO_DATA_DIR, else the connector's per-OS default.
 * @param {string | undefined} option @param {NodeJS.ProcessEnv} env @param {string} cwd
 */
export function resolveDataDir(option, env, cwd) {
  const chosen = option ?? env.PHOTOFRESCO_DATA_DIR
  return chosen ? resolve(cwd, chosen) : defaultDataDir(process.platform, env)
}

/**
 * Where the connector process listens and keeps its key and log.
 * @param {string} dataDir
 */
export function attachPaths(dataDir) {
  const dir = join(dataDir, 'cli')
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\photofresco-cli-${createHash('sha256').update(dir.toLowerCase()).digest('hex').slice(0, 24)}`
    : join(dir, 'connector.sock')
  return { dataDir, dir, socket, key: join(dir, 'attach.key'), log: join(dir, 'connector.log'), lock: join(dir, 'PhotoFrescoConnector.lock') }
}

/** @typedef {ReturnType<typeof attachPaths>} AttachPaths */

/**
 * Refuse a folder another user could reach. Windows relies on the per-user profile's ACLs.
 * @param {string} dir
 */
export function checkPrivateDir(dir) {
  if (process.platform === 'win32') return
  const info = lstatSync(dir)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
    throw new ConnectorError('ipc_insecure',
      `${dir} must be a folder owned by you with no group or other permissions (chmod 700); the CLI will not use it`)
  }
}

/**
 * Create the private folder (or tighten one this user owns) and check it.
 * @param {string} dir
 */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  const info = lstatSync(dir)
  if (info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) !== 0) chmodSync(dir, 0o700)
  checkPrivateDir(dir)
}

/**
 * Split a byte stream into lines, refusing an over-long line.
 * @param {import('node:net').Socket} socket
 * @param {number} maxBytes
 * @param {(line: string) => void} onLine
 * @param {() => void} onOverflow
 */
function readLines(socket, maxBytes, onLine, onOverflow) {
  /** @type {Buffer[]} */
  let parts = []
  let size = 0
  socket.on('data', (/** @type {Buffer} */ chunk) => {
    let start = 0
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      parts.push(chunk.subarray(start, end))
      const line = Buffer.concat(parts).toString('utf8')
      parts = []
      size = 0
      start = end + 1
      if (line.trim()) onLine(line)
      if (socket.destroyed) return
    }
    if (start < chunk.length) {
      parts.push(chunk.subarray(start))
      size += chunk.length - start
      if (size > maxBytes) {
        parts = []
        size = 0
        onOverflow()
      }
    }
  })
}

/** @param {import('node:net').Socket} socket @param {unknown} message */
function send(socket, message) {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`)
}

/** @param {unknown} error */
function errorPayload(error) {
  if (error instanceof ConnectorError) return { code: RPC_ERRORS.connector, message: error.message, data: error.toJSON() }
  const message = error instanceof Error ? error.message : String(error)
  return { code: RPC_ERRORS.connector, message, data: { code: 'internal_error', message } }
}

/**
 * @typedef {object} AttachServer
 * @property {AttachPaths} paths
 * @property {() => number} clients Open, authenticated connections.
 * @property {() => Promise<void>} close Stop listening, drop connections, remove the socket and key.
 */

/**
 * Serve a connector on the private socket. Holds the folder's lock while running, so a second
 * connector process for the same data folder fails with `already_running`.
 * @param {object} options
 * @param {import('../connector.js').Connector} options.connector
 * @param {AttachPaths} options.paths
 * @param {() => void} options.onShutdown Called after a client's `shutdown` was answered.
 * @param {() => void} [options.onClients] Called when the number of clients changes.
 * @returns {Promise<AttachServer>}
 */
export async function startAttachServer({ connector, paths, onShutdown, onClients }) {
  if (process.platform !== 'win32' && Buffer.byteLength(paths.socket) > ATTACH_LIMITS.maxSocketPath) {
    throw new ConnectorError('invalid_options', `The socket path ${paths.socket} is longer than the OS allows; set PHOTOFRESCO_DATA_DIR (or --data-dir) to a shorter folder`)
  }
  ensurePrivateDir(paths.dir)
  /** @type {() => void} */
  let unlock
  try {
    unlock = lockProfile(paths.dir)
  } catch (error) {
    if (error instanceof ConnectorError && error.code === 'profile_in_use') {
      throw new ConnectorError('already_running', `A PhotoFresco connector is already running for ${paths.dataDir}`)
    }
    throw error
  }
  const key = randomBytes(32).toString('hex')
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  let authenticated = 0
  try {
    if (process.platform !== 'win32') rmSync(paths.socket, { force: true })
    const staged = `${paths.key}.${process.pid}.tmp`
    writeFileSync(staged, key, { mode: 0o600, flag: 'wx' })
    renameSync(staged, paths.key)
  } catch (error) {
    unlock()
    throw error
  }

  const server = createServer((socket) => {
    sockets.add(socket)
    let authed = false
    /** @type {Set<() => void>} */
    const unsubscribes = new Set()
    const helloTimer = setTimeout(() => socket.destroy(), ATTACH_LIMITS.helloMs)
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(helloTimer)
      sockets.delete(socket)
      for (const off of unsubscribes) off()
      if (authed) {
        authenticated--
        onClients?.()
      }
    })
    readLines(socket, ATTACH_LIMITS.maxRequestBytes, (line) => {
      /** @type {any} */
      let message
      try {
        message = JSON.parse(line)
      } catch {
        send(socket, { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'Invalid JSON' } })
        if (!authed) socket.destroy()
        return
      }
      const id = message?.id ?? null
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || (typeof id !== 'number' && typeof id !== 'string')) {
        send(socket, { jsonrpc: '2.0', id, error: { code: RPC_ERRORS.invalidRequest, message: 'Expected a JSON-RPC 2.0 request with an id' } })
        if (!authed) socket.destroy()
        return
      }
      if (!authed) {
        const params = message.params ?? {}
        const offered = Buffer.from(typeof params.key === 'string' ? params.key : '', 'utf8')
        const expected = Buffer.from(key, 'utf8')
        if (message.method !== 'hello' || offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
          send(socket, { jsonrpc: '2.0', id, error: { code: RPC_ERRORS.unauthorized, message: 'Say hello with the attach key first' } })
          socket.end()
          return
        }
        if (params.protocol !== ATTACH_PROTOCOL) {
          send(socket, { jsonrpc: '2.0', id, error: { code: RPC_ERRORS.protocol, message: `This connector speaks attach protocol ${ATTACH_PROTOCOL}`, data: { supported: [ATTACH_PROTOCOL] } } })
          socket.end()
          return
        }
        authed = true
        clearTimeout(helloTimer)
        authenticated++
        onClients?.()
        const status = connector.status()
        send(socket, { jsonrpc: '2.0', id, result: { protocol: ATTACH_PROTOCOL, connector: status.connector, channel_protocol: status.protocol, pid: process.pid } })
        return
      }
      if (message.method === 'subscribe') {
        if (!unsubscribes.size) unsubscribes.add(connector.subscribe((event) => send(socket, { jsonrpc: '2.0', method: 'event', params: event })))
        send(socket, { jsonrpc: '2.0', id, result: { subscribed: true } })
        return
      }
      if (message.method === 'shutdown') {
        void connector.shutdown().then(
          () => send(socket, { jsonrpc: '2.0', id, result: { stopped: true } }),
          (error) => send(socket, { jsonrpc: '2.0', id, error: errorPayload(error) }),
        ).finally(() => setImmediate(onShutdown))
        return
      }
      const method = Object.hasOwn(ATTACH_METHODS, message.method) ? ATTACH_METHODS[message.method] : null
      if (!method) {
        send(socket, { jsonrpc: '2.0', id, error: { code: RPC_ERRORS.methodNotFound, message: `Unknown method ${message.method}` } })
        return
      }
      Promise.resolve()
        .then(() => method(connector, message.params))
        .then(
          (result) => send(socket, { jsonrpc: '2.0', id, result: result ?? null }),
          (error) => send(socket, { jsonrpc: '2.0', id, error: errorPayload(error) }),
        )
    }, () => {
      send(socket, { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.invalidRequest, message: `Request larger than ${ATTACH_LIMITS.maxRequestBytes} bytes` } })
      socket.destroy()
    })
  })

  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(paths.socket, () => {
        server.off('error', rejectListen)
        resolveListen(undefined)
      })
    })
    if (process.platform !== 'win32') chmodSync(paths.socket, 0o600)
  } catch (error) {
    rmSync(paths.key, { force: true })
    unlock()
    throw new ConnectorError('ipc_failed', `Could not listen on ${paths.socket}: ${/** @type {Error} */ (error).message}`)
  }

  /** @type {Promise<void> | null} */
  let closing = null
  return {
    paths,
    clients: () => authenticated,
    close() {
      closing ??= new Promise((resolveClose) => {
        server.close(() => resolveClose(undefined))
        for (const socket of sockets) socket.destroy()
      }).then(() => {
        if (process.platform !== 'win32') rmSync(paths.socket, { force: true })
        try {
          if (readFileSync(paths.key, 'utf8') === key) rmSync(paths.key, { force: true })
        } catch {
          // Already gone.
        }
        unlock()
      })
      return closing
    },
  }
}

/**
 * @typedef {object} HelloResult
 * @property {number} protocol
 * @property {{ name: string, version: string }} connector
 * @property {number} channel_protocol
 * @property {number} pid Connector process ID.
 */

/** A client connection to a running connector process. */
export class AttachClient {
  /**
   * @param {import('node:net').Socket} socket
   */
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, method: string }>} */
    this.pending = new Map()
    /** @type {Set<(event: any) => void>} */
    this.listeners = new Set()
    /** @type {HelloResult | null} */
    this.hello = null
    this.closed = false
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      for (const [, call] of this.pending) {
        call.reject(new ConnectorError('connector_disconnected', `The connector process closed the connection during ${call.method}; check photofresco status`))
      }
      this.pending.clear()
    })
    readLines(socket, ATTACH_LIMITS.maxResponseBytes, (line) => this.receive(line), () => socket.destroy())
  }

  /**
   * Connect to the connector process for a data folder and authenticate.
   * Fails with `connector_not_running` when none listens there.
   * @param {AttachPaths} paths
   * @param {{ name: string, version: string }} client
   * @returns {Promise<AttachClient>}
   */
  static async open(paths, client) {
    /** @type {string} */
    let key
    try {
      checkPrivateDir(paths.dir)
      key = readFileSync(paths.key, 'utf8').trim()
    } catch (error) {
      if (error instanceof ConnectorError) throw error
      throw notRunning(paths)
    }
    const socket = await new Promise((resolveSocket, rejectSocket) => {
      const candidate = createConnection(paths.socket)
      candidate.once('connect', () => {
        candidate.off('error', rejectSocket)
        resolveSocket(candidate)
      })
      candidate.once('error', (error) => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code
        rejectSocket(code === 'ENOENT' || code === 'ECONNREFUSED' ? notRunning(paths) : new ConnectorError('ipc_failed', `Could not reach the connector at ${paths.socket}: ${error.message}`))
      })
    })
    const attached = new AttachClient(socket)
    try {
      attached.hello = await attached.request('hello', { protocol: ATTACH_PROTOCOL, key, client })
    } catch (error) {
      attached.close()
      if (error instanceof ConnectorError && error.code === 'connector_disconnected') throw notRunning(paths)
      throw error
    }
    return attached
  }

  /** @param {string} line */
  receive(line) {
    /** @type {any} */
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.method === 'event' && message.id === undefined) {
      for (const listener of [...this.listeners]) listener(message.params)
      return
    }
    const call = this.pending.get(message?.id)
    if (!call) return
    this.pending.delete(message.id)
    if (message.error) {
      const error = message.error
      if (error.code === RPC_ERRORS.connector && error.data && typeof error.data.code === 'string') {
        call.reject(new ConnectorError(error.data.code, String(error.data.message ?? error.message), {
          ...(error.data.stage ? { stage: error.data.stage } : {}),
          ...(error.data.details ? { details: error.data.details } : {}),
        }))
      } else if (error.code === RPC_ERRORS.unauthorized) {
        call.reject(new ConnectorError('ipc_unauthorized', 'The connector refused the attach key; run photofresco stop, then photofresco connect'))
      } else if (error.code === RPC_ERRORS.protocol) {
        call.reject(new ConnectorError('connector_unsupported', 'The running connector process is a different photofresco version; run photofresco stop, then photofresco connect'))
      } else {
        call.reject(new ConnectorError('invalid_request', String(error.message ?? 'The connector refused the request')))
      }
      return
    }
    call.resolve(message.result)
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<any>}
   */
  request(method, params) {
    if (this.closed) return Promise.reject(new ConnectorError('connector_disconnected', `The connector connection is closed (${method})`))
    const id = ++this.nextId
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall, method })
      send(this.socket, { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  /** Receive connector events (state, pairing, session, session_ended). @param {(event: any) => void} listener */
  async subscribe(listener) {
    this.listeners.add(listener)
    await this.request('subscribe')
    return () => { this.listeners.delete(listener) }
  }

  close() {
    this.closed = true
    this.socket.end()
    this.socket.destroy()
  }
}

/** @param {AttachPaths} paths */
function notRunning(paths) {
  return new ConnectorError('connector_not_running', `No PhotoFresco connector is running for ${paths.dataDir}; start one with photofresco connect`)
}
