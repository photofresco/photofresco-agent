// @ts-check
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { CliError } from './exit.js'

/**
 * Workflow documents and inputs for `photofresco run` (pf-agent-platform-nkwn.16). The editor's
 * workflow engine (.13) validates and runs them; the CLI only reads the file (bounded), refuses a
 * file that is not a workflow document before sending anything, and pins the format version it
 * was built for.
 */

/** The workflow document format this CLI sends (docs/agent-interface.md "Workflows"). */
export const WORKFLOW_FORMAT = Object.freeze({ format: 'photofresco.workflow', version: 1 })

export const WORKFLOW_FILE_LIMITS = Object.freeze({
  /** Largest workflow or inputs file read (a 500-step workflow is far smaller). */
  maxBytes: 1024 * 1024,
})

/**
 * Read a bounded local JSON file the person named on the command line.
 * @param {string} path Absolute path.
 * @param {string} what For messages ("workflow", "inputs").
 */
function readJsonFile(path, what) {
  /** @type {number | undefined} */
  let fd
  try {
    fd = openSync(path, 'r')
    const info = fstatSync(fd)
    if (!info.isFile()) throw new CliError('workflow_unreadable', `The ${what} file ${path} is not a regular file`)
    if (info.size > WORKFLOW_FILE_LIMITS.maxBytes) throw new CliError('workflow_unreadable', `The ${what} file ${path} is ${info.size} bytes; at most ${WORKFLOW_FILE_LIMITS.maxBytes} are read`)
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    const text = bytes.subarray(0, offset).toString('utf8')
    try {
      return { value: JSON.parse(text), sha256: createHash('sha256').update(bytes.subarray(0, offset)).digest('hex') }
    } catch {
      throw new CliError('workflow_unreadable', `The ${what} file ${path} is not JSON; nothing was sent`)
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError('workflow_unreadable', `Could not read the ${what} file ${path}: ${/** @type {Error} */ (error).message}`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Read and check a workflow document. Refuses anything that is not a `photofresco.workflow`
 * document of the pinned version before it reaches the editor.
 * @param {string} path Absolute path.
 * @returns {{ workflow: Record<string, any>, sha256: string }}
 */
export function readWorkflowFile(path) {
  const { value, sha256 } = readJsonFile(path, 'workflow')
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== WORKFLOW_FORMAT.format) {
    throw new CliError('workflow_unreadable', `${path} is not a PhotoFresco workflow (expected "format": "${WORKFLOW_FORMAT.format}"); nothing was sent`)
  }
  if (value.version !== WORKFLOW_FORMAT.version) {
    throw new CliError('workflow_unsupported', `${path} is workflow version ${JSON.stringify(value.version)}; this photofresco runs version ${WORKFLOW_FORMAT.version}. Nothing was sent`)
  }
  return { workflow: value, sha256 }
}

/**
 * Read an inputs file: a JSON object of input values by name.
 * @param {string} path Absolute path.
 * @returns {Record<string, unknown>}
 */
export function readInputsFile(path) {
  const { value } = readJsonFile(path, 'inputs')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('usage', `The inputs file ${path} must hold a JSON object of input values by name`)
  return value
}

/**
 * `--input name=value`: the value is JSON when it parses (numbers, booleans, arrays, objects,
 * quoted strings), otherwise the literal text.
 * @param {readonly string[]} pairs
 * @returns {Record<string, unknown>}
 */
export function parseInputPairs(pairs) {
  /** @type {Record<string, unknown>} */
  const inputs = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at <= 0) throw new CliError('usage', `--input takes name=value, got "${pair}"`)
    const name = pair.slice(0, at)
    const raw = pair.slice(at + 1)
    /** @type {unknown} */
    let value = raw
    try {
      value = JSON.parse(raw)
    } catch {
      // Plain text.
    }
    inputs[name] = value
  }
  return inputs
}
