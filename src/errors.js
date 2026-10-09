// @ts-check

/**
 * Connector-side failures. Editor-side refusals keep the page's own codes (for example
 * `capability_denied`, `stale_revision`, `artifact_expired`); these codes describe the
 * connector, the browser it owns, the paired channel and local files.
 *
 * `stage` says where a file workflow stopped so adapters can report them separately
 * (the CLI maps them to distinct exit codes):
 * - `path`: the path was refused before anything ran (not granted, escapes its root,
 *   exists without overwrite consent). Nothing was sent to the editor.
 * - `operation`: the editor operation failed or was refused. Nothing was written.
 * - `retrieval`: reading the artifact back failed or its bytes did not match its SHA-256.
 *   Nothing was written.
 * - `write`: the local write failed. The target file was not replaced.
 *
 * @typedef {'path' | 'operation' | 'retrieval' | 'write'} FileStage
 */

/** @type {Readonly<Record<string, string>>} */
export const CONNECTOR_ERROR_CODES = Object.freeze({
  invalid_options: 'A connector option is invalid',
  invalid_request: 'A request argument is invalid',
  not_connected: 'No paired editor session; call connect() first',
  busy: 'Another connect or shutdown is in progress',
  browser_not_found: 'No supported Chromium-based browser was found',
  browser_unsupported: 'The browser is older than the connector supports',
  browser_launch_failed: 'The browser did not start',
  profile_in_use: 'Another connector process is using the browser profile',
  browser_closed: 'The connector browser closed',
  editor_unavailable: 'The editor page did not load its connector channel',
  editor_unsupported: 'The editor speaks a different connector protocol version',
  page_closed: 'The connector tab closed',
  page_reloaded: 'The editor page reloaded; its sessions ended',
  origin_changed: 'The connector tab left the pinned editor origin',
  channel_rejected: 'The editor channel refused the message',
  pairing_denied: 'The user denied the connection',
  pairing_expired: 'The connection request expired before the user decided',
  pairing_in_progress: 'A connection request is already waiting for the user',
  session_ended: 'The editor session ended',
  path_not_granted: 'The path is outside every granted folder',
  path_escape: 'The path resolves outside its granted folder through a symbolic link',
  path_invalid: 'The path is not usable',
  file_exists: 'The file exists and overwriting was not allowed',
  not_a_file: 'The path is not a regular file',
  file_too_large: 'The file is larger than the connector accepts',
  read_failed: 'The file could not be read',
  write_failed: 'The file could not be written',
  artifact_incomplete: 'The artifact bytes ended early or arrived out of order',
  artifact_hash_mismatch: 'The retrieved bytes do not match the artifact SHA-256',
  artifact_too_large: 'The artifact is larger than the connector accepts',
  operation_failed: 'The editor operation failed',
})

export class ConnectorError extends Error {
  /**
   * @param {string} code A key of CONNECTOR_ERROR_CODES, or an editor-side code passed through.
   * @param {string} message Actionable text; never contains secrets, file contents or pixels.
   * @param {{ stage?: FileStage, details?: Record<string, unknown> }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ConnectorError'
    /** @readonly */
    this.code = code
    /** @readonly @type {FileStage | undefined} */
    this.stage = extra.stage
    /** @readonly @type {Record<string, unknown> | undefined} */
    this.details = extra.details
  }

  /** JSON form for adapters (MCP tool errors, CLI output, JSON-RPC error data). */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.stage ? { stage: this.stage } : {}),
      ...(this.details ? { details: this.details } : {}),
    }
  }
}
