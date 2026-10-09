// @ts-check
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { defaultDataDir, findBrowser, launchBrowser } from './browser.js'
import { ConnectorError } from './errors.js'
import { FILE_LIMITS, FileGrants, StagedFile } from './files.js'
import { CHANNEL_PROTOCOL, EditorPage } from './page.js'

/**
 * The PhotoFresco local connector (pf-agent-platform-nkwn.14): one in-process API shared by
 * the MCP server (.15), the CLI (.16) and the JSON-RPC stdio endpoint (.47). Pairing, the
 * pinned editor origin and protocol, revocation and file grants are enforced here, so
 * adapters add no authorization logic of their own. See CONNECTOR.md and DISCLOSURE.md.
 *
 * Constructing a connector starts nothing: no browser, no process, no file access. The
 * browser starts only on connect(), which opens the editor in the connector's own visible
 * browser window and waits for the user to allow the connection there.
 */

export const CONNECTOR_NAME = 'PhotoFresco connector'
export const CONNECTOR_VERSION = '0.1.0'
export const DEFAULT_EDITOR_URL = 'https://photofresco.com/app/'
/** Adapter surfaces; each is shown to the user and used as the editor's acquisition entry token. */
export const SURFACES = Object.freeze(['mcp', 'cli', 'sdk', 'vscode'])

export const CONNECT_LIMITS = Object.freeze({
  maxClientLength: 48,
  /** Longest the connector itself waits for the user (the editor also expires requests after 3 minutes). */
  maxPairingWaitMs: 3 * 60_000,
})

const LOOPBACK_HOSTS = Object.freeze({ '127.0.0.1': true, localhost: true, '[::1]': true })
const FORMATS = Object.freeze({ png: true, psd: true, pfd: true })
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * @typedef {'idle' | 'starting' | 'ready' | 'pairing' | 'connected'} ConnectorState
 * idle: no browser. starting: launching it or loading the editor. ready: editor open, no
 * session. pairing: waiting for the user's decision. connected: a session is paired.
 *
 * @typedef {'mcp' | 'cli' | 'sdk' | 'vscode'} Surface
 *
 * @typedef {object} ConnectorOptions
 * @property {Surface} surface Which adapter this is (shown to the user, acquisition entry).
 * @property {string} [client] Agent name shown to the user, e.g. "Claude Code" (default "Agent").
 * @property {string} [editorUrl] Editor to open (default https://photofresco.com/app/). Its origin is pinned.
 * @property {boolean} [allowLoopbackEditor] Permit an http://127.0.0.1|localhost editor (development only).
 * @property {string} [browserPath] Browser executable; else PHOTOFRESCO_BROWSER; else an installed Chrome/Edge/Chromium.
 * @property {string} [dataDir] Connector data folder (default per OS; see defaultDataDir()).
 * @property {string} [profileDir] Browser profile folder (default <dataDir>/browser-profile), or 'ephemeral'.
 * @property {import('./files.js').RootGrant[]} [roots] Folders the person grants for import/export.
 * @property {string} [cwd] Base for relative file paths (default process.cwd()).
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(entry: Record<string, unknown>) => void} [log] Structured, secret-free diagnostics.
 * @property {(options: import('./browser.js').LaunchOptions) => Promise<import('./browser.js').BrowserProcess>} [launch]
 *   Browser launcher (default launchBrowser). A seam for trusted in-process callers and tests.
 *
 * @typedef {object} ConnectRequest
 * @property {string} [client] Overrides the connector's agent name for this session.
 * @property {string} [document] 'active' (default), 'none' or an editor document ID.
 * @property {{ capabilities: string[], budget_credits?: number, reason?: string }} [access]
 *   What to ask the user for once connected (read, edit, export, external-write, spend). Grants nothing by itself.
 * @property {number} [timeout_ms] Stop waiting for the user after this long (≤ 3 minutes).
 *
 * @typedef {{ type: 'state', state: ConnectorState }
 *   | { type: 'pairing', code: string, expires_at: number }
 *   | { type: 'session', status: Record<string, any> }
 *   | { type: 'session_ended', code: string, message: string }} ConnectorEvent
 */

/** @param {string} raw @param {boolean} allowLoopback */
function pinEditorUrl(raw, allowLoopback) {
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ConnectorError('invalid_options', `editorUrl is not a URL: ${raw}`)
  }
  if (url.username || url.password || url.hash) throw new ConnectorError('invalid_options', 'editorUrl must not contain credentials or a fragment')
  const loopback = Object.hasOwn(LOOPBACK_HOSTS, url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && allowLoopback)) {
    throw new ConnectorError('invalid_options', 'editorUrl must use https (plain http only for a loopback development server with allowLoopbackEditor)')
  }
  url.searchParams.delete('pf_ref')
  return url
}

function pairingCode() {
  return `${String(randomInt(0, 10_000)).padStart(4, '0')}-${String(randomInt(0, 10_000)).padStart(4, '0')}`
}

/**
 * @typedef {object} ArtifactInfo
 * @property {string} artifact_id
 * @property {number} byte_length
 * @property {string} sha256
 */

export class Connector {
  /** @param {ConnectorOptions} options */
  constructor(options) {
    if (!options || typeof options !== 'object') throw new ConnectorError('invalid_options', 'createConnector needs options { surface, ... }')
    if (!SURFACES.includes(options.surface)) throw new ConnectorError('invalid_options', `surface must be one of ${SURFACES.join(', ')}`)
    const client = options.client ?? 'Agent'
    if (typeof client !== 'string' || !client.trim() || client.length > CONNECT_LIMITS.maxClientLength) {
      throw new ConnectorError('invalid_options', `client must be a 1–${CONNECT_LIMITS.maxClientLength} character agent name`)
    }
    this.surface = options.surface
    this.client = client.trim()
    this.editorUrl = pinEditorUrl(options.editorUrl ?? DEFAULT_EDITOR_URL, options.allowLoopbackEditor === true)
    this.origin = this.editorUrl.origin
    const launchUrl = new URL(this.editorUrl)
    // Non-secret acquisition surface token (docs/acquisition-measurement.md); the editor strips it.
    launchUrl.searchParams.set('pf_ref', this.surface)
    this.launchUrl = launchUrl.href
    this.env = options.env ?? process.env
    this.browserPath = options.browserPath
    const dataDir = options.dataDir ?? defaultDataDir(process.platform, this.env)
    this.profileDir = options.profileDir ?? join(dataDir, 'browser-profile')
    this.files = new FileGrants(options.roots ?? [], { cwd: options.cwd })
    this.log = options.log ?? (() => {})
    this.launch = options.launch ?? launchBrowser
    /** @type {ConnectorState} */
    this.state = 'idle'
    /** @type {import('./browser.js').BrowserProcess | null} */
    this.browser = null
    /** @type {EditorPage | null} */
    this.page = null
    /** Whether the browser's initial tab was taken; later tabs are always created by the connector. */
    this.initialTabUsed = false
    /** @type {{ key: string, status: Record<string, any> } | null} */
    this.session = null
    /** @type {{ code: string, expires_at: number } | null} */
    this.pairing = null
    /** @type {{ code: string, message: string } | null} */
    this.lastEnd = null
    /** @type {Promise<Record<string, any>> | null} */
    this.connecting = null
    /** @type {Promise<void> | null} */
    this.stopping = null
    /** @type {Set<(event: ConnectorEvent) => void>} */
    this.listeners = new Set()
  }

  // ---- lifecycle -------------------------------------------------------------------

  /** Connector state without touching the browser (safe before connect). */
  status() {
    return {
      protocol: CHANNEL_PROTOCOL,
      connector: { name: CONNECTOR_NAME, version: CONNECTOR_VERSION },
      surface: this.surface,
      state: this.state,
      editor: { url: this.editorUrl.href, origin: this.origin },
      browser: this.browser ? { pid: this.browser.pid, product: this.browser.product, executable: this.browser.executable, profile: this.browser.profileDir } : null,
      pairing: this.pairing ? { ...this.pairing } : null,
      session: this.session ? structuredClone(this.session.status) : null,
      last_end: this.lastEnd ? { ...this.lastEnd } : null,
      roots: this.files.list(),
    }
  }

  /** @param {(event: ConnectorEvent) => void} listener @returns {() => void} */
  subscribe(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Open the editor in the connector's browser (launching it if needed) and ask the user to
   * allow this agent. Resolves with the session status once allowed; the session has no
   * capabilities until the user grants them (`access` shows them what to grant).
   * @param {ConnectRequest} [request]
   * @returns {Promise<Record<string, any>>}
   */
  connect(request = {}) {
    if (this.stopping) return Promise.reject(new ConnectorError('busy', 'The connector is shutting down'))
    if (this.connecting) return this.connecting
    this.connecting = this.pair(request).finally(() => { this.connecting = null })
    return this.connecting
  }

  /**
   * End the session from the agent side (the user's Stop has the same effect). The editor
   * window stays open for the user.
   */
  async close() {
    if (!this.session) return null
    const session = this.session
    try {
      return await this.page?.call('close', undefined, session.key) ?? null
    } catch {
      return null
    } finally {
      if (this.session === session) this.endSession('session_ended', 'Closed by the agent')
    }
  }

  /** Close the session and the connector's browser. Idempotent. */
  shutdown() {
    this.stopping ??= (async () => {
      if (this.pairing) await this.page?.call('cancel_pairing').catch(() => {})
      await this.close()
      const browser = this.browser
      if (browser) await browser.close()
    })().finally(() => { this.stopping = null })
    return this.stopping
  }

  // ---- session ---------------------------------------------------------------------

  /** Fresh session status from the editor. */
  async sessionStatus() {
    return this.call('status')
  }

  /** Open documents with IDs, revisions and controllers. */
  documents() {
    return this.call('documents')
  }

  /** @param {{ document?: string }} [request] Target a document by ID, or the active tab. */
  attach(request = {}) {
    return this.call('attach', request.document === undefined ? {} : { document: request.document })
  }

  /** Release the document mutation lease. */
  release() {
    return this.call('release')
  }

  /** Operations this session may run now (filtered by the user's grants). */
  operations() {
    return this.call('operations')
  }

  /** @param {{ capabilities: string[], budget_credits?: number, reason?: string }} request Ask the user for capabilities. */
  requestAccess(request) {
    return this.call('request_access', request)
  }

  /**
   * Run one typed operation. Returns the editor's response (`ok`, `status`, `code`,
   * `result`, `document_id`, `revision`); refusals are responses, not exceptions.
   * @param {{ op: string, params?: Record<string, unknown>, request_id?: string, expected_revision?: number }} request
   */
  async execute(request) {
    if (!request || typeof request !== 'object' || typeof request.op !== 'string') throw new ConnectorError('invalid_request', 'execute takes { op, params?, request_id?, expected_revision? }')
    const requestId = request.request_id ?? `req-${randomUUID()}`
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new ConnectorError('invalid_request', 'request_id must be 1–128 characters of A-Z a-z 0-9 . _ : -')
    return this.call('execute', {
      request_id: requestId,
      op: request.op,
      ...(request.params !== undefined ? { params: request.params } : {}),
      ...(request.expected_revision !== undefined ? { expected_revision: request.expected_revision } : {}),
    })
  }

  /** @param {{ request_id: string }} request Retained outcome of an earlier request (reconcile after a lost response). */
  outcome(request) {
    return this.call('outcome', { request_id: request?.request_id })
  }

  // ---- files -----------------------------------------------------------------------

  /** Folders granted for import/export. */
  roots() {
    return this.files.list()
  }

  /**
   * Grant a folder. Only for the person's own configuration (adapter flags, MCP client
   * roots); never expose this to the model.
   * @param {import('./files.js').RootGrant} grant
   */
  addRoot(grant) {
    const root = this.files.add(grant)
    this.log({ event: 'root_granted', path: root.path, read: root.read, write: root.write, overwrite: root.overwrite })
    return root
  }

  /**
   * Open a granted local file in a new editor tab (doc.open; needs the Edit grant).
   * @param {{ path: string, name?: string, mime_type?: string, request_id?: string }} request
   */
  async importFile(request) {
    this.requireSession()
    const file = this.files.read(request?.path)
    this.log({ event: 'file_read', path: file.path, bytes: file.bytes.length })
    const response = await this.execute({
      op: 'doc.open',
      params: {
        name: request.name ?? basename(file.path),
        ...(request.mime_type !== undefined ? { mime_type: request.mime_type } : {}),
        data_base64: file.bytes.toString('base64'),
      },
      ...(request.request_id !== undefined ? { request_id: request.request_id } : {}),
    })
    if (!response.ok) {
      throw new ConnectorError(response.code ?? 'operation_failed', response.error ?? 'doc.open failed', { stage: 'operation', details: { request_id: response.request_id, status: response.status } })
    }
    return { path: file.path, bytes: file.bytes.length, response }
  }

  /**
   * Export the session document and write it to a granted path: export.artifact, a complete
   * artifact.read retrieval, SHA-256 verification, then one atomic publish. Needs the Read
   * and Export grants; overwriting needs the root's overwrite grant and `overwrite: true`.
   * @param {{ path: string, format: 'png' | 'psd' | 'pfd', layer_id?: string, overwrite?: boolean, request_id?: string }} request
   */
  async exportFile(request) {
    this.requireSession()
    if (!request || !Object.hasOwn(FORMATS, request.format)) throw new ConnectorError('invalid_request', 'format must be png, psd or pfd', { stage: 'path' })
    const target = this.files.prepareWrite(request.path, { overwrite: request.overwrite === true })
    const created = await this.execute({
      op: 'export.artifact',
      params: { format: request.format, ...(request.layer_id !== undefined ? { layer_id: request.layer_id } : {}) },
      ...(request.request_id !== undefined ? { request_id: request.request_id } : {}),
    })
    if (!created.ok) {
      throw new ConnectorError(created.code ?? 'operation_failed', created.error ?? 'export.artifact failed', { stage: 'operation', details: { request_id: created.request_id, status: created.status } })
    }
    const artifact = created.result
    if (!(artifact.byte_length <= FILE_LIMITS.maxWriteBytes)) {
      throw new ConnectorError('artifact_too_large', `The artifact is ${artifact.byte_length} bytes; at most ${FILE_LIMITS.maxWriteBytes} are written`, { stage: 'retrieval' })
    }
    const staged = new StagedFile(target)
    try {
      for await (const chunk of this.artifactChunks(artifact)) staged.write(chunk)
      const written = staged.commit({ sha256: artifact.sha256, bytes: artifact.byte_length })
      this.log({ event: 'file_written', path: written.path, bytes: written.bytes, sha256: written.sha256, replaced: written.replaced })
      return {
        ...written, format: artifact.format, filename: artifact.filename, fidelity: artifact.fidelity, loss: artifact.loss,
        artifact_id: artifact.artifact_id, document_id: artifact.document_id, revision: artifact.revision, width: artifact.width, height: artifact.height,
      }
    } finally {
      staged.abort()
      this.execute({ op: 'artifact.release', params: { artifact_id: artifact.artifact_id } }).catch(() => {})
    }
  }

  /**
   * Retrieve an artifact into memory, verified against its SHA-256 (for adapters that return
   * bytes, e.g. MCP resources).
   * @param {{ artifact_id: string, max_bytes?: number }} request
   * @returns {Promise<{ artifact_id: string, bytes: Buffer, byte_length: number, sha256: string }>}
   */
  async fetchArtifact(request) {
    this.requireSession()
    const max = request?.max_bytes ?? FILE_LIMITS.maxWriteBytes
    const first = await this.readChunk(request?.artifact_id, 0)
    if (first.byte_length > max) throw new ConnectorError('artifact_too_large', `The artifact is ${first.byte_length} bytes; at most ${max} were requested`, { stage: 'retrieval' })
    const hash = createHash('sha256')
    const parts = []
    for await (const chunk of this.artifactChunks({ artifact_id: first.artifact_id, byte_length: first.byte_length, sha256: first.sha256 }, first)) {
      hash.update(chunk)
      parts.push(chunk)
    }
    const digest = hash.digest('hex')
    if (digest !== first.sha256) {
      throw new ConnectorError('artifact_hash_mismatch', `The retrieved bytes hash to ${digest}, not the artifact's ${first.sha256}`, { stage: 'retrieval' })
    }
    return { artifact_id: first.artifact_id, bytes: Buffer.concat(parts, first.byte_length), byte_length: first.byte_length, sha256: digest }
  }

  // ---- internals -------------------------------------------------------------------

  /**
   * @param {ArtifactInfo} artifact Expected identity, length and digest.
   * @param {any} [first] An already-read first chunk.
   * @returns {AsyncGenerator<Buffer>}
   */
  async *artifactChunks(artifact, first) {
    let offset = 0
    let chunk = first
    for (;;) {
      chunk ??= await this.readChunk(artifact.artifact_id, offset)
      if (chunk.artifact_id !== artifact.artifact_id || chunk.offset !== offset || chunk.byte_length !== artifact.byte_length || chunk.sha256 !== artifact.sha256) {
        throw new ConnectorError('artifact_incomplete', 'The artifact changed or arrived out of order during retrieval; nothing was written', { stage: 'retrieval' })
      }
      const bytes = Buffer.from(String(chunk.data_base64), 'base64')
      if (bytes.length !== chunk.length || bytes.length === 0) {
        throw new ConnectorError('artifact_incomplete', 'An artifact chunk did not match its declared length; nothing was written', { stage: 'retrieval' })
      }
      yield bytes
      offset += bytes.length
      const eof = chunk.eof === true
      chunk = undefined
      if (eof !== (offset === artifact.byte_length) || offset > artifact.byte_length) {
        throw new ConnectorError('artifact_incomplete', `The artifact ended at ${offset} of ${artifact.byte_length} bytes; nothing was written`, { stage: 'retrieval' })
      }
      if (eof) return
    }
  }

  /** @param {unknown} artifactId @param {number} offset */
  async readChunk(artifactId, offset) {
    if (typeof artifactId !== 'string') throw new ConnectorError('invalid_request', 'artifact_id must be a string', { stage: 'retrieval' })
    const response = await this.execute({ op: 'artifact.read', params: { artifact_id: artifactId, offset } }).catch((error) => {
      throw error instanceof ConnectorError ? new ConnectorError(error.code, error.message, { stage: 'retrieval' }) : error
    })
    if (!response.ok) throw new ConnectorError(response.code ?? 'operation_failed', response.error ?? 'artifact.read failed', { stage: 'retrieval' })
    return response.result
  }

  requireSession() {
    if (!this.session || !this.page) {
      throw new ConnectorError('not_connected', this.lastEnd ? `No paired session (${this.lastEnd.message}); call connect()` : 'No paired session; call connect()')
    }
    return this.session
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  async call(method, params) {
    const session = this.requireSession()
    try {
      const result = await /** @type {EditorPage} */ (this.page).call(method, params, session.key)
      if (method === 'status' && this.session === session) this.session.status = result
      return result
    } catch (error) {
      if (error instanceof ConnectorError && (error.code === 'session_ended' || error.code === 'unauthorized') && this.session === session) {
        this.endSession('session_ended', error.message)
      }
      throw error
    }
  }

  /** @param {ConnectRequest} request */
  async pair(request) {
    if (!request || typeof request !== 'object') throw new ConnectorError('invalid_request', 'connect takes { client?, document?, access?, timeout_ms? }')
    const client = request.client ?? this.client
    if (typeof client !== 'string' || !client.trim() || client.length > CONNECT_LIMITS.maxClientLength) {
      throw new ConnectorError('invalid_request', `client must be a 1–${CONNECT_LIMITS.maxClientLength} character agent name`)
    }
    const wait = request.timeout_ms ?? CONNECT_LIMITS.maxPairingWaitMs
    if (typeof wait !== 'number' || !(wait >= 1000 && wait <= CONNECT_LIMITS.maxPairingWaitMs)) {
      throw new ConnectorError('invalid_request', `timeout_ms must be between 1000 and ${CONNECT_LIMITS.maxPairingWaitMs}`)
    }
    if (this.session) {
      try {
        return await this.sessionStatus()
      } catch (error) {
        if (this.session) throw error
      }
    }
    await this.openEditor()
    const page = /** @type {EditorPage} */ (this.page)
    const code = pairingCode()
    this.pairing = { code, expires_at: Date.now() + wait }
    this.setState('pairing')
    this.emit({ type: 'pairing', code, expires_at: this.pairing.expires_at })
    this.log({ event: 'pairing_requested', surface: this.surface })
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    try {
      const pairing = page.call('pair', {
        client: client.trim(), surface: this.surface, connector: `${CONNECTOR_NAME} ${CONNECTOR_VERSION}`, code,
        ...(request.document !== undefined ? { document: request.document } : {}),
        ...(request.access !== undefined ? { access: request.access } : {}),
      })
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          page.call('cancel_pairing').catch(() => {})
          reject(new ConnectorError('pairing_expired', `The user did not answer the connection request within ${Math.round(wait / 1000)} s`))
        }, wait)
      })
      const result = await Promise.race([pairing, timeout])
      this.session = { key: result.session_key, status: result.status }
      this.lastEnd = null
      this.pairing = null
      this.setState('connected')
      this.log({ event: 'session_connected', session_id: result.status.session_id })
      this.emit({ type: 'session', status: structuredClone(result.status) })
      return structuredClone(result.status)
    } catch (error) {
      this.pairing = null
      if (this.state === 'pairing') this.setState(this.browser ? 'ready' : 'idle')
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Launch the browser and/or (re)load the editor tab until its channel is open. */
  async openEditor() {
    if (!this.browser || !this.browser.running()) {
      const { path } = findBrowser({ browserPath: this.browserPath, env: this.env })
      this.setState('starting')
      try {
        const browser = await this.launch({ executable: path, profileDir: this.profileDir, log: this.log })
        this.browser = browser
        this.initialTabUsed = false
        browser.exited.then(() => this.browserExited(browser))
      } catch (error) {
        this.setState('idle')
        throw error
      }
    }
    const browser = this.browser
    if (!this.page?.attached) {
      this.setState('starting')
      this.page?.detach()
      const page = new EditorPage(browser.cdp, {
        origin: this.origin,
        log: this.log,
        onEvent: (event) => this.pageEvent(page, event),
        onDown: (code, message) => this.pageDown(page, code, message),
      })
      this.page = page
      await page.attach(await this.tab(browser))
    }
    if (!this.page.ready) {
      this.setState('starting')
      try {
        await this.page.load(this.launchUrl)
      } catch (error) {
        this.setState(this.browser ? 'ready' : 'idle')
        throw error
      }
    }
    this.setState('ready')
  }

  /**
   * The connector's own tab: the browser's initial blank tab after launch, otherwise a new
   * window. Never a tab the user opened.
   * @param {import('./browser.js').BrowserProcess} browser
   */
  async tab(browser) {
    if (!this.initialTabUsed) {
      this.initialTabUsed = true
      const { targetInfos } = await browser.cdp.send('Target.getTargets')
      const initial = targetInfos.find((/** @type {any} */ info) => info.type === 'page' && info.url === 'about:blank' && !info.attached)
      if (initial) return initial.targetId
    }
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true })
    return targetId
  }

  /** @param {EditorPage} page @param {import('./page.js').PageEvent} event */
  pageEvent(page, event) {
    if (page !== this.page || !this.session) return
    if (event.event === 'session' && event.status && typeof event.status === 'object') {
      this.session.status = /** @type {Record<string, any>} */ (event.status)
      this.emit({ type: 'session', status: structuredClone(this.session.status) })
    } else if (event.event === 'session_ended') {
      this.endSession('session_ended', typeof event.reason === 'string' ? event.reason : 'The session ended in the editor')
    }
  }

  /** @param {EditorPage} page @param {string} code @param {string} message */
  pageDown(page, code, message) {
    if (page !== this.page) return
    if (code === 'page_closed') this.page = null
    if (this.session) this.endSession(code, message)
    else if (this.state !== 'idle' && this.state !== 'starting') this.setState(this.browser ? 'ready' : 'idle')
  }

  /** @param {import('./browser.js').BrowserProcess} browser */
  browserExited(browser) {
    if (this.browser !== browser) return
    this.browser = null
    const page = this.page
    this.page = null
    page?.drop('browser_closed', 'The connector browser closed')
    page?.detach()
    if (this.session) this.endSession('browser_closed', 'The connector browser closed')
    this.log({ event: 'browser_exited', pid: browser.pid })
    this.setState('idle')
  }

  /** @param {string} code @param {string} message */
  endSession(code, message) {
    this.session = null
    this.lastEnd = { code, message }
    this.log({ event: 'session_ended', code })
    this.emit({ type: 'session_ended', code, message })
    this.setState(this.browser ? 'ready' : 'idle')
  }

  /** @param {ConnectorState} state */
  setState(state) {
    if (this.state === state) return
    this.state = state
    this.emit({ type: 'state', state })
  }

  /** @param {ConnectorEvent} event */
  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A failing listener never breaks the connector.
      }
    }
  }
}

/**
 * Create a connector. Starts nothing until connect().
 * @param {ConnectorOptions} options
 */
export function createConnector(options) {
  return new Connector(options)
}
