// @ts-check
import { readFileSync } from 'node:fs'
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'

/**
 * Validates `photofresco <command> --json` output against agent/src/cli/result.schema.json
 * (pf-agent-platform-nkwn.16). Shared by agent/test/cli.test.js and the editor repository's
 * test/agent-cli.test.mjs (which resolves Ajv through this file).
 */

export const CLI_RESULT_SCHEMA = JSON.parse(readFileSync(new URL('../../src/cli/result.schema.json', import.meta.url), 'utf8'))

const validate = new Ajv({ allErrors: true, strict: false }).compile(CLI_RESULT_SCHEMA)

/**
 * Throw when a parsed CLI result does not match the schema.
 * @param {unknown} result
 */
export function assertCliResult(result) {
  if (!validate(result)) {
    throw new Error(`CLI output does not match result.schema.json: ${JSON.stringify(validate.errors)}\n${JSON.stringify(result).slice(0, 2000)}`)
  }
  return result
}
