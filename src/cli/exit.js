// @ts-check
import { ConnectorError } from '../errors.js'

/**
 * Exit codes of `photofresco <command>` (pf-agent-platform-nkwn.16). Each failure class has its
 * own code so scripts can tell "nothing ran" from "the edit failed" from "the file was not
 * written". The JSON output repeats the code as `exit_code`.
 */
export const EXIT = Object.freeze({
  ok: 0,
  /** An unexpected internal error. */
  internal: 1,
  /** Bad arguments, an unreadable or unsupported workflow file, or an invalid request. Nothing ran. */
  usage: 2,
  /** No connector process, no paired session, pairing refused or expired, or the browser/editor is unavailable. */
  session: 3,
  /** A file path was refused (not granted, escapes its folder, exists without overwrite, too large, unreadable). Nothing ran. */
  path: 4,
  /** The editor refused or failed the operation or workflow (permission, revision, failed step). Nothing was written. */
  operation: 5,
  /** Reading the export back failed or did not match its SHA-256. Nothing was written. */
  retrieval: 6,
  /** Writing the file failed. The target was not replaced. */
  write: 7,
  /** The operation or workflow was canceled (Ctrl-C, or the user pressed Stop). The document keeps the partial result. */
  canceled: 8,
  /** Still waiting for the user (connection code or Permissions dialog); run photofresco connect again to keep waiting. */
  pending: 75,
  /** Interrupted while not running an edit (Ctrl-C during connect or a read). */
  interrupted: 130,
})

/** Codes that mean the session or its transport is missing; everything else from the connector maps by stage. */
const SESSION_CODES = Object.freeze({
  not_connected: true, busy: true, browser_not_found: true, browser_unsupported: true, browser_launch_failed: true,
  profile_in_use: true, browser_closed: true, page_closed: true, page_reloaded: true, origin_changed: true,
  editor_unavailable: true, editor_unsupported: true, channel_rejected: true, pairing_denied: true, pairing_expired: true,
  pairing_canceled: true, pairing_in_progress: true, session_active: true, session_ended: true, session_stopped: true,
  unauthorized: true, connector_not_running: true, connector_disconnected: true, connector_unsupported: true,
  ipc_unauthorized: true, ipc_failed: true, ipc_insecure: true, already_running: true,
})

const USAGE_CODES = Object.freeze({
  usage: true, invalid_options: true, invalid_request: true, workflow_unreadable: true, workflow_unsupported: true,
  unknown_operation: true, daemon_running: true,
})

const STAGE_EXIT = Object.freeze({ path: EXIT.path, operation: EXIT.operation, retrieval: EXIT.retrieval, write: EXIT.write })

/**
 * The exit code for a failure.
 * @param {{ code: string, stage?: string, status?: string }} failure
 */
export function exitCodeFor(failure) {
  if (failure.code === 'canceled' || failure.status === 'canceled') return EXIT.canceled
  if (failure.code === 'pending') return EXIT.pending
  if (failure.code === 'interrupted') return EXIT.interrupted
  if (failure.stage && Object.hasOwn(STAGE_EXIT, failure.stage)) return STAGE_EXIT[/** @type {keyof typeof STAGE_EXIT} */ (failure.stage)]
  if (Object.hasOwn(SESSION_CODES, failure.code)) return EXIT.session
  if (Object.hasOwn(USAGE_CODES, failure.code)) return EXIT.usage
  if (failure.code === 'internal_error') return EXIT.internal
  // Every other code comes from the editor (grants, revisions, admission, workflows, ops).
  return EXIT.operation
}

/**
 * The next step for the codes a CLI user meets. Editor-side codes not listed fall back to the hint
 * for their exit class.
 * @type {Readonly<Record<string, string>>}
 */
export const CLI_HINTS = Object.freeze({
  // CLI and attach path
  usage: 'Check the command with photofresco <command> --help.',
  workflow_unreadable: 'Pass a readable workflow JSON file (workflow.export or the Actions panel produces one), at most 1 MiB.',
  workflow_unsupported: 'This photofresco version runs workflow format "photofresco.workflow" version 1; update photofresco or re-export the workflow.',
  daemon_running: 'The connector is already running with its own browser options; run photofresco stop first to change them.',
  connector_not_running: 'Start the connector with photofresco connect (it opens PhotoFresco and asks you to allow the CLI).',
  connector_disconnected: 'The connector process went away. Check photofresco status; run photofresco connect to start again.',
  connector_unsupported: 'Run photofresco stop, then photofresco connect, so the connector runs the same version as this command.',
  ipc_unauthorized: 'Run photofresco stop, then photofresco connect.',
  ipc_insecure: 'Fix the folder permissions (chmod 700, owned by you) or choose another --data-dir.',
  ipc_failed: 'Check that the data folder is on a local disk, or choose a shorter --data-dir.',
  already_running: 'A connector already runs for this data folder; use it, or run photofresco stop.',
  pending: 'Run photofresco connect again to keep waiting for the decision in the PhotoFresco window.',
  interrupted: 'Nothing was canceled in the editor. Check photofresco status.',
  canceled: 'The document keeps the partial result. Reconnect with photofresco connect, then inspect it (photofresco exec workflow.runs) or roll it back (photofresco exec workflow.rollback).',
  // connector
  invalid_options: 'Fix the option as the message says.',
  invalid_request: 'Fix the arguments as the message says.',
  not_connected: 'Run photofresco connect and click Allow in the PhotoFresco window.',
  busy: 'The connector is shutting down or another connect is running; wait a moment and check photofresco status.',
  browser_not_found: 'Install Chrome, Edge or Chromium, or pass --browser (or set PHOTOFRESCO_BROWSER) to photofresco connect.',
  browser_unsupported: 'Chromium 120 or newer is needed; update the browser or pass --browser to a newer one.',
  browser_launch_failed: 'Check that the browser opens normally, then run photofresco connect again.',
  profile_in_use: 'Another PhotoFresco connector (MCP server or CLI) uses the browser profile; stop it, or connect with --profile ephemeral.',
  browser_closed: 'The PhotoFresco window was closed. Run photofresco connect to open it again.',
  page_closed: 'The PhotoFresco tab was closed. Run photofresco connect to open it again.',
  page_reloaded: 'The editor reloaded and the session ended. Run photofresco connect; Allow again.',
  origin_changed: 'The PhotoFresco tab left the editor and the session ended. Run photofresco connect.',
  editor_unavailable: 'The editor page did not load. Check the network, then run photofresco connect again.',
  editor_unsupported: 'The editor and this photofresco package speak different protocol versions; update photofresco.',
  channel_rejected: 'The editor refused the message. Check photofresco status; reconnect if the session ended.',
  pairing_denied: 'The connection was declined in the PhotoFresco window.',
  pairing_expired: 'Nobody answered in time. Run photofresco connect again.',
  pairing_canceled: 'The connection request was withdrawn. Run photofresco connect again.',
  pairing_in_progress: 'A connection request is already waiting; run photofresco connect to keep waiting.',
  session_active: 'A session is already active; check photofresco status.',
  session_ended: 'The session ended (Stop, window closed or reloaded). Run photofresco connect to start a new one.',
  path_not_granted: 'Use a file inside a folder granted with photofresco connect --read/--write (photofresco status lists them).',
  path_escape: 'The path leaves its granted folder through a symbolic link; use a real path inside the folder.',
  path_invalid: 'Pass a file path inside a granted folder.',
  file_exists: 'Choose another name, or pass --overwrite when the folder was granted with --overwrite.',
  not_a_file: 'Pass a regular file, not a folder.',
  file_too_large: 'The file is larger than the 32 MiB import limit.',
  read_failed: 'Check that the file exists and is readable.',
  write_failed: 'Nothing was replaced. Check free space and permissions.',
  artifact_incomplete: 'The export changed during retrieval; nothing was written. Export again.',
  artifact_hash_mismatch: 'The export bytes did not match; nothing was written. Export again.',
  artifact_too_large: 'The export is larger than the connector writes.',
  operation_failed: 'Check the message; inspect the document with photofresco exec doc.get_state.',
  // editor
  capability_denied: 'The user has not granted the permission this needs; run photofresco request-access with it and approve in the PhotoFresco window.',
  stale_revision: 'The document changed; re-read it (photofresco exec doc.get_state) and retry with the new revision.',
  no_target_document: 'Open a file first (photofresco open <file>) or create one (photofresco exec doc.new).',
  document_not_active: 'Switch back to the session document in the PhotoFresco window, or target the active one with photofresco attach.',
  lease_paused: 'You edited the document, so agent edits are paused; press Resume in the PhotoFresco window.',
  lease_held: 'Another agent is editing this document; wait or stop it.',
  human_busy: 'Finish the interaction in the PhotoFresco window, then retry.',
  unknown_operation: 'List the operations with photofresco ops.',
  workflow_refused: 'The workflow cannot run on this document (see the problems); nothing changed.',
  workflow_invalid: 'Fix the workflow document; nothing changed.',
  version_mismatch: 'The workflow was made for another operation version; re-record or re-export it.',
  workflow_step_failed: 'The document keeps the partial result as a checkpoint; inspect it (photofresco exec workflow.runs) or roll it back (photofresco exec workflow.rollback).',
  workflow_busy: 'Another workflow is running in the window; wait for it to finish.',
  document_changed: 'The document changed while the workflow ran, so it stopped; the partial result stays as a checkpoint.',
})

/** @type {Readonly<Record<number, string>>} */
const CLASS_HINTS = Object.freeze({
  [EXIT.internal]: 'Unexpected error; check photofresco status and retry.',
  [EXIT.usage]: CLI_HINTS.usage,
  [EXIT.session]: CLI_HINTS.not_connected,
  [EXIT.path]: CLI_HINTS.path_not_granted,
  [EXIT.operation]: CLI_HINTS.operation_failed,
  [EXIT.retrieval]: CLI_HINTS.artifact_incomplete,
  [EXIT.write]: CLI_HINTS.write_failed,
  [EXIT.canceled]: CLI_HINTS.canceled,
  [EXIT.pending]: CLI_HINTS.pending,
  [EXIT.interrupted]: CLI_HINTS.interrupted,
})

/** @param {string} code @param {number} exitCode */
export function hintFor(code, exitCode) {
  return Object.hasOwn(CLI_HINTS, code) ? CLI_HINTS[code] : CLASS_HINTS[exitCode] ?? CLASS_HINTS[EXIT.internal]
}

/**
 * A CLI failure: the error object printed under `error` in JSON output and its exit code.
 * @typedef {{ code: string, message: string, hint: string, stage?: string, status?: string, details?: Record<string, unknown> }} CliErrorInfo
 */

export class CliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ stage?: string, status?: string, details?: Record<string, unknown>, partial?: Record<string, unknown> }} [extra]
   *   `partial`: fields of the command's result that exist despite the failure (a run record, the opened file).
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.stage = extra.stage
    this.status = extra.status
    this.details = extra.details
    this.partial = extra.partial
  }
}

/**
 * Normalize anything thrown into the printed error and exit code.
 * @param {unknown} error
 * @returns {{ info: CliErrorInfo, exitCode: number, partial?: Record<string, unknown> }}
 */
export function describeFailure(error) {
  if (error instanceof CliError || error instanceof ConnectorError) {
    const status = error instanceof CliError ? error.status : undefined
    const exitCode = exitCodeFor({ code: error.code, ...(error.stage ? { stage: error.stage } : {}), ...(status ? { status } : {}) })
    return {
      info: {
        code: error.code, message: error.message, hint: hintFor(error.code, exitCode),
        ...(error.stage ? { stage: error.stage } : {}),
        ...(status ? { status } : {}),
        ...(error.details ? { details: error.details } : {}),
      },
      exitCode,
      ...(error instanceof CliError && error.partial ? { partial: error.partial } : {}),
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { info: { code: 'internal_error', message, hint: hintFor('internal_error', EXIT.internal) }, exitCode: EXIT.internal }
}
