// @ts-check
import { readFileSync } from 'node:fs'
// The MCP SDK (@modelcontextprotocol/server), bundled into vendor/ by scripts/agent-vendor.mjs so plugin
// installs run without node_modules (pf-agent-platform-nkwn.37).
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError, Server, serveStdio } from '../../vendor/mcp-server.js'
import { CONNECT_LIMITS, createConnector } from '../connector.js'
import { ConnectorError } from '../errors.js'
import { ARTIFACT_URI_PREFIX, errorResult, okResult, operationResult, thrownResult } from './results.js'
import { DEFAULT_TOOL_GROUPS, LIFECYCLE_TOOLS, TOOL_GROUPS, groupEnabled, groupOf, lifecycleTool, loadCatalog, operationTool } from './tools.js'

/**
 * PhotoFresco MCP server (pf-agent-platform-nkwn.15): a thin stdio adapter over the local
 * connector (createConnector, surface `mcp`). It adds no authorization of its own: pairing,
 * grants, file folders and artifact ownership are enforced by the connector and the editor.
 *
 * - Boots without a browser: initialize and tools/list never start one. The connector launches
 *   its browser only on photofresco_connect.
 * - Before a session it lists the lifecycle tools plus the public op catalog (bundled snapshot),
 *   filtered by the enabled tool groups. Op calls then fail as tool errors with nothing started.
 * - Connected, it lists the session's live operations() (the user's grants) and sends
 *   tools/list_changed whenever the grants change or the session ends.
 * - Never lists session.* operations or anything that answers the user's dialogs, and has no
 *   generic execute tool: one tool per operation.
 *
 * @typedef {import('./tools.js').Operation} Operation
 * @typedef {import('./results.js').ToolResult} ToolResult
 * @typedef {import('../connector.js').Connector} Connector
 */

const PACKAGE = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const SERVER_INFO = Object.freeze({ name: 'photofresco', title: 'PhotoFresco', version: String(PACKAGE.version), websiteUrl: 'https://photofresco.com/' })

export const MCP_LIMITS = Object.freeze({
  /** Largest artifact returned through resources/read (base64 grows it by a third; stdio clients buffer about 10 MB per message). */
  maxResourceBytes: 6 * 1024 * 1024,
  defaultWaitSeconds: 40,
  maxWaitSeconds: 170,
  progressIntervalMs: 5_000,
  maxClientName: CONNECT_LIMITS.maxClientLength,
})

export const INSTRUCTIONS = [
  'PhotoFresco is a Photoshop-class image editor. These tools drive a PhotoFresco window on this computer that the user watches and controls.',
  '1. Call photofresco_connect and tell the user the connection code it returns; they click Allow in the PhotoFresco window.',
  '2. The session starts with no permissions. Ask with photofresco_request_access (read, edit, export; external-write and spend only for cloud or paid AI) and explain why. Editing tools appear as the user grants them (tools/list_changed); photofresco_status shows grants.',
  '3. Open a file with photofresco_import_file (folders the person granted) or create one with doc_new; read doc_get_state first.',
  '4. Edit with the operation tools, check results with render_preview / render_region / render_mask (images), and undo with history_undo.',
  '5. Save with photofresco_export_file (granted folders) or export_artifact (an MCP resource).',
  'Operations run only while the target document is the active tab. If the user edits, agent edits pause until they press Resume. More operations: photofresco_list_tool_groups and photofresco_select_tool_groups.',
].join('\n')

const ORDERED_LIFECYCLE = /** @type {Array<keyof typeof LIFECYCLE_TOOLS>} */ (Object.keys(LIFECYCLE_TOOLS))
const ARTIFACT_MISSING = Object.freeze({ artifact_unknown: true, artifact_expired: true, artifact_evicted: true, artifact_released: true, artifact_document_mismatch: true })

/** @param {number} ms @param {AbortSignal | undefined} signal */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined) }, { once: true })
  })
}

/**
 * The agent name the editor shows ("<client> via MCP"): the MCP client's own title or name.
 * @param {Server} server @param {any} ctx
 */
function clientName(server, ctx) {
  const info = ctx?.mcpReq?.envelope?.['io.modelcontextprotocol/clientInfo'] ?? server.getClientVersion()
  const raw = typeof info?.title === 'string' && info.title.trim() ? info.title : info?.name
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MCP_LIMITS.maxClientName) : ''
  return name || 'MCP client'
}

/** @param {unknown} args @returns {Record<string, any>} */
function argumentsObject(args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new ConnectorError('invalid_request', 'Tool arguments must be a JSON object')
  return /** @type {Record<string, any>} */ (args)
}

export class McpAdapter {
  /**
   * @param {object} options
   * @param {Connector} options.connector
   * @param {readonly string[]} [options.groups] Enabled tool groups (default: essentials).
   * @param {{ operations: Operation[] }} [options.catalog] Pre-session op catalog (default: the bundled snapshot).
   */
  constructor({ connector, groups = DEFAULT_TOOL_GROUPS, catalog = loadCatalog() }) {
    this.connector = connector
    this.catalog = catalog.operations
    this.catalogByTool = new Map(this.catalog.map((op) => [op.tool_name, op]))
    this.enabled = new Set(groups)
    /** @type {{ key: string, ops: Operation[], byTool: Map<string, Operation> } | null} The session's live operations(). */
    this.live = null
    /** @type {string | null} */
    this.pendingKey = null
    /** @type {Promise<void> | null} */
    this.refreshing = null
    /** @type {Set<Server>} */
    this.servers = new Set()
    this.listed = this.toolSignature()
    this.unsubscribe = connector.subscribe((event) => {
      if (event.type === 'session') this.sessionChanged(event.status)
      else if (event.type === 'session_ended') {
        this.live = null
        this.pendingKey = null
        this.toolsMayHaveChanged()
      }
    })
  }

  // ---- tool list ---------------------------------------------------------------------

  /** Re-read operations() when the session or its grants change. @param {Record<string, any>} status */
  sessionChanged(status) {
    const key = `${status.session_id}|${[...(status.grants ?? [])].sort().join(',')}`
    if (key === this.pendingKey) return
    this.pendingKey = key
    const refresh = this.connector.operations()
      .then((/** @type {Operation[]} */ listed) => {
        // Same deterministic order as the catalog (stable tool lists help client caches).
        const ops = [...listed].sort((a, b) => a.name.localeCompare(b.name))
        if (this.pendingKey === key) this.live = { key, ops, byTool: new Map(ops.map((op) => [op.tool_name, op])) }
      })
      .catch(() => {
        if (this.pendingKey === key) this.pendingKey = null
      })
      .finally(() => {
        if (this.refreshing === refresh) this.refreshing = null
        this.toolsMayHaveChanged()
      })
    this.refreshing = refresh
  }

  /** Operations listable now: the live grants once paired, the public catalog before. */
  operations() {
    return this.connector.status().session ? this.live?.ops ?? [] : this.catalog
  }

  /** @returns {import('./tools.js').ToolDefinition[]} */
  toolDefinitions() {
    const status = this.connector.status()
    const grants = new Set(status.session?.grants ?? [])
    const paired = status.session !== null
    const canImport = status.roots.some((root) => root.read) && (!paired || grants.has('edit'))
    const canExport = status.roots.some((root) => root.write) && (!paired || (grants.has('read') && grants.has('export')))
    const tools = ORDERED_LIFECYCLE
      .filter((name) => (name !== 'photofresco_import_file' || canImport) && (name !== 'photofresco_export_file' || canExport))
      .map(lifecycleTool)
    for (const op of this.operations()) if (groupEnabled(this.enabled, op.name)) tools.push(operationTool(op))
    return tools
  }

  toolSignature() {
    return this.toolDefinitions().map((tool) => tool.name).join('\n')
  }

  /** Send tools/list_changed to every connected client when the listed names changed. */
  toolsMayHaveChanged() {
    const signature = this.toolSignature()
    if (signature === this.listed) return
    this.listed = signature
    for (const server of this.servers) {
      Promise.resolve().then(() => server.sendToolListChanged()).catch(() => {})
    }
  }

  async listTools() {
    await this.refreshing
    return { tools: this.toolDefinitions() }
  }

  // ---- tool calls --------------------------------------------------------------------

  /**
   * @param {Server} server
   * @param {{ name: string, arguments?: unknown, _meta?: Record<string, any> }} params
   * @param {any} ctx
   * @returns {Promise<ToolResult>}
   */
  async callTool(server, params, ctx) {
    const name = params.name
    try {
      const args = argumentsObject(params.arguments)
      if (Object.hasOwn(LIFECYCLE_TOOLS, name)) return await this.lifecycle(/** @type {keyof typeof LIFECYCLE_TOOLS} */ (name), args, server, params, ctx)
      const session = this.connector.status().session
      if (session) await this.refreshing
      const live = session ? this.live?.byTool.get(name) : undefined
      if (live) return operationResult(live.name, await this.connector.execute({ op: live.name, params: args }))
      const op = this.catalogByTool.get(name)
      if (!op) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`)
      if (!session) {
        return errorResult('not_connected', `${op.name} needs a PhotoFresco session; nothing ran. Connect first with photofresco_connect.`, { op: op.name })
      }
      const granted = new Set(session.grants ?? [])
      const missing = op.capabilities.filter((capability) => !granted.has(capability))
      if (!missing.length) return errorResult('unknown_operation', `${op.name} is not available in the connected editor; nothing ran.`, { op: op.name })
      return errorResult('capability_denied', `${op.name} needs the ${missing.join(' + ')} permission, which the user has not granted this session; nothing ran.`, { op: op.name, needs: op.capabilities, missing })
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      return thrownResult(error)
    }
  }

  /**
   * @param {keyof typeof LIFECYCLE_TOOLS} name
   * @param {Record<string, any>} args
   * @param {Server} server
   * @param {{ _meta?: Record<string, any> }} params
   * @param {any} ctx
   * @returns {Promise<ToolResult>}
   */
  async lifecycle(name, args, server, params, ctx) {
    switch (name) {
      case 'photofresco_connect': return this.connect(args, server, params, ctx)
      case 'photofresco_status': return okResult(await this.status())
      case 'photofresco_request_access': {
        const status = await this.connector.requestAccess({
          capabilities: args.capabilities,
          ...(args.budget_credits !== undefined ? { budget_credits: args.budget_credits } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        })
        return okResult({
          ok: true, asked: args.capabilities, session: status,
          next: 'The user decides in the PhotoFresco window (Review…). Tools appear as permissions are granted (tools/list_changed); photofresco_status shows grants and the pending request.',
        })
      }
      case 'photofresco_documents': return okResult({ ok: true, documents: await this.connector.documents() })
      case 'photofresco_attach': return okResult({ ok: true, session: await this.connector.attach({ document: args.document }) })
      case 'photofresco_disconnect': {
        const had = this.connector.status().session !== null
        if (args.close_window === true) await this.connector.shutdown()
        else await this.connector.close()
        return okResult({ ok: true, disconnected: had, window_closed: args.close_window === true, state: this.connector.status().state })
      }
      case 'photofresco_import_file': {
        const imported = await this.connector.importFile({ path: args.path, ...(args.name !== undefined ? { name: args.name } : {}) })
        const mapped = operationResult('doc.open', imported.response)
        return okResult({ ...mapped.structuredContent, file: { path: imported.path, bytes: imported.bytes } })
      }
      case 'photofresco_export_file': {
        const written = await this.connector.exportFile({
          path: args.path, format: args.format,
          ...(args.layer_id !== undefined ? { layer_id: args.layer_id } : {}),
          ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
        })
        return okResult({ ok: true, file: written })
      }
      case 'photofresco_list_tool_groups': return okResult({ ok: true, groups: this.groups() })
      case 'photofresco_select_tool_groups': return this.selectGroups(args)
    }
  }

  /**
   * Open the editor and ask the user to allow this agent; wait a bounded time for the decision.
   * @param {Record<string, any>} args @param {Server} server @param {{ _meta?: Record<string, any> }} params @param {any} ctx
   */
  async connect(args, server, params, ctx) {
    if (this.connector.status().session) return okResult({ ok: true, state: 'connected', session: await this.connector.sessionStatus() })
    const wait = args.wait_seconds ?? MCP_LIMITS.defaultWaitSeconds
    if (typeof wait !== 'number' || !(wait >= 0 && wait <= MCP_LIMITS.maxWaitSeconds)) {
      throw new ConnectorError('invalid_request', `wait_seconds must be between 0 and ${MCP_LIMITS.maxWaitSeconds}`)
    }
    const attempt = this.connector.connect({
      client: clientName(server, ctx),
      ...(args.access !== undefined ? { access: args.access } : {}),
      ...(args.document !== undefined ? { document: args.document } : {}),
    })
    /** @type {Promise<{ status?: Record<string, any>, error?: unknown }>} */
    const settled = attempt.then((status) => ({ status }), (error) => ({ error }))
    const token = params._meta?.progressToken
    let ticks = 0
    const progress = token === undefined ? undefined : setInterval(() => {
      const pairing = this.connector.status().pairing
      ctx.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress: ++ticks, message: pairing ? `Waiting for the user to click Allow in the PhotoFresco window (code ${pairing.code})` : 'Opening PhotoFresco' },
      }).catch(() => {})
    }, MCP_LIMITS.progressIntervalMs)
    try {
      const outcome = await Promise.race([settled, delay(wait * 1000, ctx?.mcpReq?.signal).then(() => null)])
      if (outcome?.error !== undefined) return thrownResult(outcome.error)
      if (outcome?.status) {
        await this.refreshing
        return okResult({
          ok: true, state: 'connected', session: outcome.status,
          next: outcome.status.grants?.length
            ? 'Connected. Read doc_get_state, then edit.'
            : 'Connected with no permissions yet. The user grants them in the Permissions dialog; ask with photofresco_request_access if you did not pass access. Tools appear as grants arrive (tools/list_changed).',
        })
      }
      const status = this.connector.status()
      if (status.pairing) {
        return okResult({
          ok: true, state: 'pairing', code: status.pairing.code, expires_at: new Date(status.pairing.expires_at).toISOString(),
          next: `Tell the user: "Approve the connection in the PhotoFresco window showing code ${status.pairing.code}." Then call photofresco_connect again to wait for their decision.`,
        })
      }
      return okResult({ ok: true, state: status.state, next: 'PhotoFresco is still opening; call photofresco_connect again.' })
    } finally {
      clearInterval(progress)
    }
  }

  async status() {
    const status = this.connector.status()
    /** @type {Record<string, any> | null} */
    let session = status.session
    if (session) session = await this.connector.sessionStatus().catch(() => this.connector.status().session)
    return {
      ok: true,
      state: this.connector.status().state,
      server: { name: SERVER_INFO.name, version: SERVER_INFO.version },
      editor: status.editor.url,
      browser: status.browser ? { product: status.browser.product } : null,
      pairing: status.pairing ? { code: status.pairing.code, expires_at: new Date(status.pairing.expires_at).toISOString() } : null,
      session,
      last_end: status.last_end,
      roots: status.roots,
      tools: { groups: [...this.enabled], listed: this.toolDefinitions().length },
    }
  }

  groups() {
    const ops = this.operations()
    return Object.entries(TOOL_GROUPS).map(([id, spec]) => ({
      id, title: spec.title, description: spec.description, enabled: this.enabled.has(id),
      available_now: ops.filter((op) => (id === 'essentials' ? spec.ops?.includes(op.name) : groupOf(op.name) === id)).length,
    }))
  }

  /** @param {Record<string, any>} args */
  selectGroups(args) {
    /** @param {unknown} list @returns {string[]} */
    const ids = (list) => {
      if (list === undefined) return []
      if (!Array.isArray(list)) throw new ConnectorError('invalid_request', 'enable and disable take arrays of group IDs')
      if (list.includes('all')) return Object.keys(TOOL_GROUPS)
      const unknown = list.filter((id) => typeof id !== 'string' || !Object.hasOwn(TOOL_GROUPS, id))
      if (unknown.length) throw new ConnectorError('unknown_tool_group', `Unknown tool group ${unknown.join(', ')}; known: ${Object.keys(TOOL_GROUPS).join(', ')}`)
      return list
    }
    const enable = ids(args.enable)
    const disable = ids(args.disable)
    for (const id of disable) this.enabled.delete(id)
    for (const id of enable) this.enabled.add(id)
    this.toolsMayHaveChanged()
    return okResult({ ok: true, enabled: [...this.enabled], listed: this.toolDefinitions().length })
  }

  // ---- resources (export artifacts) --------------------------------------------------

  /** Whether the session may read artifacts now (Read + Export granted). */
  async artifactsReadable() {
    if (!this.connector.status().session) return false
    await this.refreshing
    return this.live?.byTool.has('artifact_list') === true
  }

  /** @returns {Promise<Array<Record<string, any>>>} */
  async artifacts() {
    const response = await this.connector.execute({ op: 'artifact.list', params: {} })
    return response.ok ? response.result.artifacts : []
  }

  async listResources() {
    if (!(await this.artifactsReadable())) return { resources: [] }
    return {
      resources: (await this.artifacts()).map((artifact) => ({
        uri: `${ARTIFACT_URI_PREFIX}${artifact.artifact_id}`, name: artifact.filename, mimeType: artifact.mime_type, size: artifact.byte_length,
        description: `PhotoFresco ${artifact.format} export of ${artifact.document_id} at revision ${artifact.revision}`,
      })),
    }
  }

  /** @param {string} uri */
  async readResource(uri) {
    if (!uri.startsWith(ARTIFACT_URI_PREFIX)) throw new ResourceNotFoundError(uri)
    const id = decodeURIComponent(uri.slice(ARTIFACT_URI_PREFIX.length).split('#')[0])
    if (!this.connector.status().session) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'not_connected: no PhotoFresco session; call photofresco_connect', { code: 'not_connected' })
    if (!(await this.artifactsReadable())) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'capability_denied: reading exports needs the Read and Export permissions; ask with photofresco_request_access', { code: 'capability_denied' })
    }
    const artifact = (await this.artifacts()).find((entry) => entry.artifact_id === id)
    if (!artifact) throw new ResourceNotFoundError(uri, `No retained export ${id} for this session (exports live 10 minutes); export again`)
    if (artifact.byte_length > MCP_LIMITS.maxResourceBytes) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `artifact_too_large: the export is ${artifact.byte_length} bytes; resources carry at most ${MCP_LIMITS.maxResourceBytes}. Use photofresco_export_file`, { code: 'artifact_too_large' })
    }
    try {
      const fetched = await this.connector.fetchArtifact({ artifact_id: id, max_bytes: MCP_LIMITS.maxResourceBytes })
      return { contents: [{ uri: `${ARTIFACT_URI_PREFIX}${id}`, mimeType: artifact.mime_type, blob: fetched.bytes.toString('base64') }] }
    } catch (error) {
      if (error instanceof ConnectorError && Object.hasOwn(ARTIFACT_MISSING, error.code)) throw new ResourceNotFoundError(uri, `${error.code}: ${error.message}`)
      if (error instanceof ConnectorError) throw new ProtocolError(ProtocolErrorCode.InternalError, `${error.code}: ${error.message}`, error.toJSON())
      throw error
    }
  }

  // ---- MCP wiring --------------------------------------------------------------------

  /** A protocol server bound to this adapter (one per client connection). */
  createServer() {
    const server = new Server(SERVER_INFO, {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions: INSTRUCTIONS,
    })
    server.setRequestHandler('tools/list', () => this.listTools())
    server.setRequestHandler('tools/call', async (request, ctx) => server.projectCallToolResult(/** @type {any} */ (await this.callTool(server, request.params, ctx)), undefined))
    server.setRequestHandler('resources/list', () => this.listResources())
    server.setRequestHandler('resources/templates/list', () => ({
      resourceTemplates: [{
        uriTemplate: `${ARTIFACT_URI_PREFIX}{artifact_id}`, name: 'artifact', title: 'PhotoFresco export',
        description: 'Bytes of an export created with export_artifact (PNG, PSD or .pfd), verified against its SHA-256; needs Read + Export, readable for 10 minutes while the session targets its document',
      }],
    }))
    server.setRequestHandler('resources/read', (request) => this.readResource(request.params.uri))
    this.servers.add(server)
    server.onclose = () => { this.servers.delete(server) }
    return server
  }

  /** End the session and close the browser this server opened. */
  async close() {
    this.unsubscribe()
    await this.connector.shutdown()
  }
}

/**
 * @typedef {object} McpServerOptions
 * @property {import('../files.js').RootGrant[]} [roots] Folders the person grants for import/export.
 * @property {readonly string[]} [groups] Enabled tool groups.
 * @property {Partial<import('../connector.js').ConnectorOptions>} [connector] Further connector options (editorUrl, browserPath, profileDir, launch …).
 */

/** @param {McpServerOptions} [options] */
export function createMcpAdapter(options = {}) {
  const connector = createConnector({ client: 'MCP client', ...options.connector, surface: 'mcp', roots: options.roots ?? [] })
  return new McpAdapter({ connector, ...(options.groups ? { groups: options.groups } : {}) })
}

/**
 * Serve MCP over this process's stdin/stdout until the client closes stdin, then end the
 * session and close the browser.
 * @param {McpServerOptions} [options]
 */
export function runStdioServer(options = {}) {
  const adapter = createMcpAdapter(options)
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void adapter.close().finally(() => process.exit(0))
  }
  serveStdio(() => {
    const server = adapter.createServer()
    const onclose = server.onclose
    server.onclose = () => { onclose?.(); close() }
    return server
  }, { onerror: (error) => process.stderr.write(`photofresco mcp: ${error.message}\n`) })
  process.stdin.on('end', close)
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  return adapter
}
