// @ts-check
import { ConnectorError } from '../errors.js'

/**
 * Mapping editor/connector results to MCP tool results (pf-agent-platform-nkwn.15).
 *
 * Successful operations return their result as JSON text plus `structuredContent`; preview PNGs
 * become image content, export artifacts a resource link (photofresco://artifact/<id>), artifact
 * chunks an embedded blob. Refusals and failures are tool errors (`isError: true`) the model can
 * read: `code`, the editor's or connector's message and the next step. Nothing here adds
 * authorization; the codes come from the editor (sessions, grants, artifacts) and the connector.
 *
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'image', data: string, mimeType: string }
 *   | { type: 'resource_link', uri: string, name: string, title?: string, mimeType?: string, size?: number, description?: string }
 *   | { type: 'resource', resource: { uri: string, mimeType?: string, blob: string } }} Content
 * @typedef {{ content: Content[], structuredContent?: Record<string, unknown>, isError?: boolean }} ToolResult
 */

export const ARTIFACT_URI_PREFIX = 'photofresco://artifact/'

/**
 * The next step for every refusal and failure code an agent can meet: connector codes
 * (agent/src/errors.js), page-channel codes, session/grant refusals (src/ops/sessions.ts),
 * operation codes (src/ops/execution.ts) and this adapter's own. The editor repository's
 * test/agent-mcp.test.mjs checks the editor-side lists stay covered.
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_HINTS = Object.freeze({
  // connector
  invalid_options: 'The MCP server configuration is invalid; the person who installed it needs to fix its arguments.',
  invalid_request: 'Fix the arguments as the message says and call again.',
  not_connected: 'Call photofresco_connect, tell the user the connection code, and wait for them to click Allow in the PhotoFresco window.',
  busy: 'The server is shutting down or another connect is running; wait a moment and call photofresco_status.',
  browser_not_found: 'No Chrome, Edge or Chromium was found. Ask the user to install one, or to set PHOTOFRESCO_BROWSER in the MCP server configuration.',
  browser_unsupported: 'The browser is too old (Chromium 120 or newer is needed). Ask the user to update it or point PHOTOFRESCO_BROWSER at a newer one.',
  browser_launch_failed: 'The browser did not start. Ask the user to check that it opens normally, then call photofresco_connect again.',
  profile_in_use: 'Another PhotoFresco MCP server or CLI is using the browser profile. Close it, or ask the user to configure --profile ephemeral.',
  browser_closed: 'The PhotoFresco window was closed and the session ended. Call photofresco_connect to open it again (the user must Allow again).',
  editor_unavailable: 'The editor page did not load. Check the network, then call photofresco_connect again.',
  editor_unsupported: 'The editor and this MCP server speak different protocol versions. Ask the user to update the photofresco package.',
  page_closed: 'The PhotoFresco tab was closed and the session ended. Call photofresco_connect to open it again.',
  page_reloaded: 'The editor reloaded and the session ended. Call photofresco_connect; the user must Allow again.',
  origin_changed: 'The PhotoFresco tab left the editor and the session ended. Call photofresco_connect to reconnect.',
  channel_rejected: 'The editor refused the message. Call photofresco_status; reconnect if the session ended.',
  pairing_denied: 'The user declined the connection. Do not retry unless they ask you to.',
  pairing_expired: 'Nobody answered the connection request in time. Call photofresco_connect again when the user is ready.',
  pairing_canceled: 'The connection request was withdrawn. Call photofresco_connect again when the user is ready.',
  pairing_in_progress: 'A connection request is already waiting for the user. Call photofresco_connect again to keep waiting.',
  session_active: 'This server already has a session. Call photofresco_status.',
  session_ended: 'The session ended (the user pressed Stop, closed the window or reloaded). Call photofresco_connect to start a new one.',
  path_not_granted: 'The path is outside the folders the person granted (see photofresco_status roots). Use a granted folder; only the person can grant more in the MCP server configuration.',
  path_escape: 'The path leaves its granted folder through a symbolic link. Use a real path inside the folder.',
  path_invalid: 'The path is not usable; pass an absolute file path inside a granted folder.',
  file_exists: 'The file exists. Choose another name, or pass overwrite: true if the folder allows overwriting and the user wants it replaced.',
  not_a_file: 'The path is a folder or special file; pass a regular file.',
  file_too_large: 'The file is larger than 32 MiB, the import limit.',
  read_failed: 'The file could not be read; check that it exists and is readable.',
  write_failed: 'The file could not be written; nothing was replaced. Check free space and permissions.',
  artifact_incomplete: 'The export changed or arrived out of order; nothing was written. Export again.',
  artifact_hash_mismatch: 'The exported bytes did not match their checksum; nothing was written. Export again.',
  artifact_too_large: 'The export is too large for this transfer. Use photofresco_export_file to write it to a granted folder, or export a smaller format or layer.',
  operation_failed: 'The editor operation failed; read the message, check doc_get_state and adjust.',
  // page channel
  unknown_method: 'The editor does not support this request; update the photofresco package.',
  unauthorized: 'The editor no longer recognizes this session. Call photofresco_connect.',
  // sessions and grants
  consent_required: 'External agents are turned off in the editor\'s Data & privacy settings; only the user can turn them on.',
  invalid_params: 'The arguments do not match the input schema; fix them as the message says.',
  unknown_operation: 'The editor does not know this operation. Check the tool list (photofresco_list_tool_groups).',
  reserved_operation: 'Only the user can do this in the editor; ask them.',
  capability_denied: 'The user has not granted the permission this needs. Call photofresco_request_access with it and explain why; the user decides in the PhotoFresco window.',
  capability_revoked: 'The user revoked a permission while this ran; partial edits stay in History. Ask again with photofresco_request_access if still needed.',
  budget_exhausted: 'The credit budget the user granted is used up or expired. Ask for a new budget with photofresco_request_access.',
  spending_unavailable: 'Paid AI is unavailable (the user is signed out or the service is unreachable). Ask the user to sign in to PhotoFresco.',
  unknown_session: 'The session no longer exists. Call photofresco_connect.',
  session_stopped: 'The user stopped the session. Call photofresco_connect only if they want to continue.',
  stale_connection: 'This connection was replaced. Call photofresco_connect.',
  session_disconnected: 'The session is disconnected. Call photofresco_connect.',
  too_many_sessions: 'The editor has too many agent sessions. Ask the user to stop one.',
  too_many_requests: 'Too many requests are running; wait for them to finish, then call again.',
  no_target_document: 'The session has no target document. Open one with photofresco_import_file or doc_new, or target one with photofresco_attach.',
  unknown_document: 'That document is closed or unknown. Call photofresco_documents.',
  document_closed: 'The target document was closed. Open or target another document.',
  document_not_active: 'The target document is not the active tab. Ask the user to switch to it, or target the active one with photofresco_attach.',
  target_changed: 'The target document changed while this ran. Check doc_get_state, then call again.',
  lease_held: 'Another agent is editing this document. Wait, or ask the user to stop it.',
  lease_paused: 'The user edited the document, so agent edits are paused. Ask them to press Resume in the editor, then check doc_get_state.',
  lease_lost: 'This session lost its edit lease. Check doc_get_state, then call again.',
  human_busy: 'The user is in the middle of a transform or text edit. Wait until they finish, then call again.',
  stale_revision: 'The document changed (revision differs). Re-read doc_get_state and plan from the current state.',
  request_conflict: 'The request ID was reused with different arguments. Call again (a new ID is generated).',
  outcome_unknown: 'The outcome is unknown. Check doc_get_state and the revision before retrying; do not blindly repeat.',
  unknown_pairing: 'The connection request is gone. Call photofresco_connect.',
  too_many_pairings: 'Too many connection requests are waiting in the editor. Ask the user to answer or dismiss them.',
  // operations (previews and artifacts)
  invalid_region: 'The region is invalid; use whole pixels with positive width and height.',
  region_out_of_bounds: 'The region lies outside the canvas; check the document size with doc_get_state.',
  preview_too_large: 'The preview would be too large; use a smaller scale or max_size (the message names the largest usable scale).',
  unknown_layer: 'No layer has that ID; read the layer IDs from doc_get_state.',
  unsupported_layer_kind: 'This layer kind is not supported here; choose another layer.',
  mask_unavailable: 'That layer has no raster mask, or there is no selection.',
  export_failed: 'The export failed; read the message and try another format.',
  export_timeout: 'The export took longer than 120 s; try PNG or a smaller document.',
  artifact_limit: 'Too many exports are held in the editor; release old ones (artifact_release) or wait 10 minutes.',
  artifact_unknown: 'No export with that ID belongs to this session. Export again.',
  artifact_expired: 'The export expired (exports live 10 minutes). Export again.',
  artifact_evicted: 'The export was evicted by newer exports. Export again.',
  artifact_released: 'The export was released. Export again.',
  artifact_document_mismatch: 'The export belongs to a document that is not the active target. Switch back to it or export again.',
  invalid_range: 'The offset is outside the artifact.',
  // workflows (pf-agent-platform-nkwn.13)
  workflow_invalid: 'The workflow is invalid; fix it as the message says and validate it again before running.',
  version_mismatch: 'An operation in the workflow changed since it was saved; update those steps to the current schema and validate again.',
  workflow_refused: 'The workflow cannot run as given (the message says why); change it and validate again.',
  workflow_step_failed: 'A workflow step failed and the run stopped; steps before it stay applied. Read the message and doc_get_state, then roll back or continue.',
  document_changed: 'The document changed while the workflow ran, so it stopped. Check doc_get_state before continuing.',
  workflow_busy: 'Another workflow is running; wait for it to finish or cancel it.',
  unknown_run: 'No retained workflow run has that ID; list the recent runs.',
  rollback_conflict: 'The run was not rolled back because the document changed after it; nothing was undone. Undo step by step with history_undo if needed.',
  rollback_unavailable: 'This run cannot be rolled back (the message says why); nothing was undone.',
  // this adapter
  unknown_tool_group: 'Use a group ID from photofresco_list_tool_groups.',
  internal_error: 'The MCP server hit an unexpected error; call photofresco_status and try again.',
})

/** Statuses of an editor session response that are not success. */
const FAILED = Object.freeze({ failed: true, rejected: true, canceled: true, unknown: true })

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [extra]
 * @returns {ToolResult}
 */
export function errorResult(code, message, extra = {}) {
  const hint = Object.hasOwn(ERROR_HINTS, code) ? ERROR_HINTS[code] : ERROR_HINTS.operation_failed
  return {
    isError: true,
    content: [{ type: 'text', text: `Error ${code}: ${message}\nNext: ${hint}` }],
    structuredContent: { ok: false, code, message, hint, ...extra },
  }
}

/** @param {unknown} error @returns {ToolResult} */
export function thrownResult(error) {
  if (error instanceof ConnectorError) {
    return errorResult(error.code, error.message, { ...(error.stage ? { stage: error.stage } : {}), ...(error.details ? { details: error.details } : {}) })
  }
  return errorResult('internal_error', error instanceof Error ? error.message : String(error))
}

/**
 * @param {Record<string, unknown>} structured
 * @param {Content[]} [extra] Image/resource content first, then the JSON text.
 * @returns {ToolResult}
 */
export function okResult(structured, extra = []) {
  return { content: [...extra, { type: 'text', text: JSON.stringify(structured) }], structuredContent: structured }
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/

/**
 * Pull image and byte payloads out of an operation result into MCP content blocks, leaving a
 * short note in their place in the JSON.
 * @param {string} op Canonical op name.
 * @param {unknown} result
 * @returns {{ result: unknown, content: Content[] }}
 */
export function extractPayloads(op, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result, content: [] }
  const out = /** @type {Record<string, any>} */ ({ ...result })
  /** @type {Content[]} */
  const content = []
  const image = out.image
  if (image && typeof image === 'object' && typeof image.data_base64 === 'string' && typeof image.mime_type === 'string') {
    content.push({ type: 'image', data: image.data_base64, mimeType: image.mime_type })
    out.image = { ...image, data_base64: `(${image.width}×${image.height} ${image.mime_type} returned as image content)` }
  }
  if (typeof out.data_url === 'string') {
    const match = DATA_URL.exec(out.data_url)
    if (match) {
      content.push({ type: 'image', data: out.data_url.slice(match[0].length), mimeType: match[1] })
      out.data_url = `(${out.width}×${out.height} ${match[1]} returned as image content)`
    }
  }
  if (op === 'artifact.read' && typeof out.data_base64 === 'string' && typeof out.artifact_id === 'string') {
    content.push({ type: 'resource', resource: { uri: `${ARTIFACT_URI_PREFIX}${out.artifact_id}#offset=${out.offset}`, mimeType: out.mime_type, blob: out.data_base64 } })
    out.data_base64 = `(${out.length} bytes returned as an embedded resource)`
  }
  if (op === 'export.artifact' && typeof out.artifact_id === 'string') {
    const uri = `${ARTIFACT_URI_PREFIX}${out.artifact_id}`
    out.resource_uri = uri
    content.push({
      type: 'resource_link', uri, name: out.filename ?? out.artifact_id, mimeType: out.mime_type, size: out.byte_length,
      description: `PhotoFresco ${out.format} export (${out.fidelity ?? 'export'}); readable for 10 minutes while this session targets its document`,
    })
  }
  return { result: out, content }
}

/**
 * Map an editor session response (`execute()` result) to an MCP tool result.
 * @param {string} op Canonical op name.
 * @param {Record<string, any>} response
 * @returns {ToolResult}
 */
export function operationResult(op, response) {
  const ids = { request_id: response.request_id, document_id: response.document_id ?? null, revision: response.revision ?? null }
  if (!response.ok || Object.hasOwn(FAILED, response.status)) {
    return errorResult(response.code ?? 'operation_failed', response.error ?? `${op} ${response.status ?? 'failed'}`, {
      op, status: response.status, ...ids, ...(response.execution ? { execution: response.execution } : {}),
    })
  }
  const { result, content } = extractPayloads(op, response.result)
  return okResult({ ok: true, op, ...ids, ...(response.replayed ? { replayed: true } : {}), result }, content)
}
