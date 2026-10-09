// @ts-check
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Ajv } from '@modelcontextprotocol/client/validators/ajv'
import { ERROR_HINTS } from '../src/mcp/results.js'
import { LIFECYCLE_TOOLS, TOOL_GROUPS, describeOperation, loadCatalog } from '../src/mcp/tools.js'
import { COMMANDS, USAGE as CLI_USAGE } from '../src/cli/main.js'
import { SKILL_DIR, exampleCalls, fences, inlineCode, skillFiles, workflowDocument } from './support/skillDoc.js'

/**
 * pf-agent-platform-nkwn.36: the agent skill (skills/photofresco) says only what the shipped MCP
 * server does. Frontmatter follows the Agent Skills specification (agentskills.io/specification);
 * every tool, error code, option, group, permission and example call it mentions exists in this
 * package with that exact name and schema. The live proof (a client following the worked example
 * against a real editor) is scripts/agent-skill-e2e.mjs in the editor repository.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const SERVER_JSON = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'))
const MCP_DOC = readFileSync(join(ROOT, 'MCP.md'), 'utf8')
const MCP_USAGE = readFileSync(join(ROOT, 'src', 'bin', 'photofresco.js'), 'utf8')
const CATALOG = loadCatalog().operations
const OPS = new Map(CATALOG.map((op) => [op.name, op]))

/** @typedef {{ name: string, inputSchema: Record<string, any>, description: string }} Tool */
/** @type {Map<string, Tool>} */
const TOOLS = new Map([
  ...Object.entries(LIFECYCLE_TOOLS).map(([name, tool]) => /** @type {[string, Tool]} */ ([name, { name, inputSchema: tool.inputSchema, description: tool.description }])),
  ...CATALOG.map((op) => /** @type {[string, Tool]} */ ([op.tool_name, { name: op.tool_name, inputSchema: op.input_schema, description: describeOperation(op) }])),
])
/** Top-level input names of every tool. */
const PARAMS = new Set([...TOOLS.values()].flatMap((tool) => Object.keys(tool.inputSchema.properties ?? {})))
/** Result fields the skill names that are not tool inputs (every op result carries them). */
const RESULT_FIELDS = new Set(['document_id'])
const CAPABILITIES = LIFECYCLE_TOOLS.photofresco_request_access.inputSchema.properties.capabilities.items.enum

const MARKDOWN = skillFiles()
const FILES = MARKDOWN.map((doc) => doc.file)
const SKILL = MARKDOWN.find((doc) => doc.file === 'SKILL.md')?.text ?? ''

/**
 * The frontmatter subset this skill uses: `key: value` lines and one level of `metadata` string
 * entries. Anything else fails, so the strict reader cannot silently disagree with a YAML parser.
 * @param {string} text
 */
function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, 'SKILL.md starts with a --- frontmatter block')
  /** @type {Record<string, any>} */
  const fields = {}
  /** @type {Record<string, string> | null} */
  let nested = null
  for (const line of match[1].split('\n')) {
    const child = line.match(/^ {2}([a-z][a-z0-9_-]*): "?([^"]*)"?$/)
    if (child && nested) { nested[child[1]] = child[2]; continue }
    const top = line.match(/^([a-z][a-z0-9-]*):(?: (.*))?$/)
    assert.ok(top, `frontmatter line is not in the supported subset: ${line}`)
    assert.ok(!Object.hasOwn(fields, top[1]), `duplicate frontmatter key ${top[1]}`)
    if (top[2] === undefined) { nested = fields[top[1]] = {}; continue }
    assert.doesNotMatch(top[2], /^["'[{>|&*!%@`]|: | #/, `${top[1]} must be a plain YAML scalar`)
    nested = null
    fields[top[1]] = top[2]
  }
  return { fields, body: text.slice(match[0].length) }
}

describe('agent skill (pf-agent-platform-nkwn.36)', () => {
  it('frontmatter follows the Agent Skills specification', () => {
    assert.ok(FILES.includes('SKILL.md'))
    const { fields, body } = frontmatter(SKILL)
    const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
    for (const key of Object.keys(fields)) assert.ok(allowed.has(key), `unknown frontmatter field ${key}`)
    assert.equal(fields.name, 'photofresco')
    assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/)
    assert.ok(fields.name.length <= 64)
    assert.equal(fields.name, basename(SKILL_DIR), 'name matches the folder')
    assert.ok(fields.description.length >= 1 && fields.description.length <= 1024, `description is ${fields.description.length} characters`)
    assert.match(fields.description, /Use when/, 'description says when to use the skill')
    assert.ok(fields.compatibility.length >= 1 && fields.compatibility.length <= 500)
    for (const value of Object.values(fields.metadata)) assert.equal(typeof value, 'string')
    assert.equal(fields.metadata.version, PACKAGE.version, 'skill version follows the package')
    assert.match(fields.compatibility, new RegExp(`Node\\.js ${PACKAGE.engines.node.replace('>=', '')} or newer`))
    assert.ok(body.split('\n').length < 500, 'SKILL.md body stays under 500 lines')
  })

  it('the package ships the skill folder', () => {
    assert.ok(PACKAGE.files.includes('skills'), 'package.json files includes skills')
    for (const file of FILES) assert.match(file, /\.md$/, `${file}: the skill holds only markdown`)
  })

  it('install instructions are the exact ones in MCP.md, pinned to this version', () => {
    const claude = SKILL.match(/^claude mcp add .*$/m)?.[0]
    assert.ok(claude && MCP_DOC.includes(claude), 'the Claude Code command is the one in MCP.md')
    const skillJson = fences(SKILL).filter((block) => block.lang === 'json')
    const docJson = fences(MCP_DOC).filter((block) => block.lang === 'json')
    assert.equal(skillJson.length, 1)
    assert.deepEqual(JSON.parse(skillJson[0].body), JSON.parse(docJson[0].body), 'the mcpServers config is the one in MCP.md')
    for (const [, version] of SKILL.matchAll(/photofresco@([0-9][^\s"]*)/g)) assert.equal(version, PACKAGE.version)
    const args = JSON.parse(skillJson[0].body).mcpServers.photofresco.args
    assert.deepEqual(args.slice(0, 3), ['-y', `${PACKAGE.name}@${PACKAGE.version}`, 'mcp'])
    const mcpPart = SKILL.slice(0, SKILL.indexOf('\n## 9. '))
    for (const [option] of mcpPart.matchAll(/--[a-z][a-z-]+/g)) {
      assert.ok(new RegExp(`^ {2}${option}[ ,]`, 'm').test(MCP_USAGE), `${option} is a photofresco mcp option`)
    }
  })

  it('the command-line section uses only real CLI commands and options', () => {
    const cliPart = SKILL.slice(SKILL.indexOf('\n## 9. '))
    assert.ok(cliPart.length > 100, 'SKILL.md has the CLI section')
    const help = [CLI_USAGE, ...Object.values(COMMANDS).map((command) => command.help ?? '')].join('\n')
    for (const [option] of cliPart.matchAll(/--[a-z][a-z-]+/g)) assert.ok(new RegExp(`^ {2}(?:-[a-z], )?${option}[ ,]`, 'm').test(help), `${option} is a CLI option`)
    const global = new Set([...CLI_USAGE.matchAll(/^ {2}(?:-[a-z], )?--([a-z-]+)/gm)].map((match) => match[1]))
    const lines = fences(cliPart).filter((block) => block.lang === 'sh').flatMap((block) => block.body.trim().split('\n'))
    assert.ok(lines.length >= 4)
    for (const line of lines) {
      const [program, command, ...rest] = line.split(' ')
      assert.equal(program, 'photofresco')
      assert.ok(Object.hasOwn(COMMANDS, command), `${command} is a CLI command`)
      for (const word of rest.filter((part) => part.startsWith('--'))) {
        const name = word.slice(2)
        assert.ok(Object.hasOwn(COMMANDS[command].options ?? {}, name) || global.has(name), `${line}: --${name} is an option of ${command}`)
      }
    }
    // Prose names commands as `name <args>`; result fields are the only other lowercase words.
    const fields = new Set(['code', 'message', 'hint', 'error'])
    for (const code of inlineCode(cliPart)) {
      const word = code.split(' ')[0]
      if (!/^[a-z]+(-[a-z]+)*$/.test(word) || word === 'photofresco' || word === 'node' || fields.has(word)) continue
      assert.ok(Object.hasOwn(COMMANDS, word), `\`${code}\` names a CLI command`)
    }
    // The exit codes the skill lists are the CLI's own, in order.
    const codes = (/** @type {string} */ text) => [...text.slice(text.indexOf('Exit codes:')).split('.')[0].matchAll(/(\d+) [a-z]/g)].map((match) => match[1])
    assert.deepEqual(codes(cliPart), codes(CLI_USAGE))
  })

  it('every backticked name is a real tool, input, error code, group or permission', () => {
    const groups = new Set(Object.keys(TOOL_GROUPS))
    for (const { file, text } of MARKDOWN) {
      for (const code of inlineCode(text)) {
        if (/^photofresco_[a-z_]+$/.test(code)) assert.ok(Object.hasOwn(LIFECYCLE_TOOLS, code), `${file}: ${code} is a lifecycle tool`)
        else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(code)) {
          assert.ok(TOOLS.has(code) || Object.hasOwn(ERROR_HINTS, code) || PARAMS.has(code) || RESULT_FIELDS.has(code),
            `${file}: ${code} is not a tool, input, error code or result field`)
        }
      }
    }
    // Section 4 names every group the server has, and nothing else.
    const named = new Set(inlineCode(SKILL).filter((code) => groups.has(code)))
    assert.deepEqual([...named].sort(), [...groups].sort())
    // The permission table lists exactly the server's capability names.
    const table = [...SKILL.matchAll(/^\| `([a-z-]+)` \((Read|Edit|Export|Send|Spend)\) \|/gm)].map((match) => match[1])
    assert.deepEqual(table, CAPABILITIES)
    // Adjustment types the editing loop suggests are values of adjust_add's enum.
    const suggestion = SKILL.replace(/\n\s*/g, ' ').match(/Pick the adjustment type[^.]*\./)?.[0] ?? ''
    const types = inlineCode(suggestion).filter((code) => code !== 'adjust_add' && code !== 'adjustment_type')
    assert.ok(types.length >= 4, suggestion)
    for (const type of types) assert.ok(OPS.get('adjust.add')?.input_schema.properties.adjustment_type.enum.includes(type), `${type} is an adjustment type`)
  })

  it('every example call names a listed tool with arguments its input schema accepts', () => {
    const ajv = new Ajv({ strict: false, allErrors: true })
    const calls = MARKDOWN.flatMap(({ file, text }) => exampleCalls(text).map((call) => ({ ...call, file })))
    assert.ok(calls.length >= 16, 'the worked example and workflow calls are checked')
    for (const { tool, args, file, line } of calls) {
      const definition = TOOLS.get(tool)
      assert.ok(definition, `${file}: ${tool} is a tool`)
      const validate = ajv.compile(definition.inputSchema)
      assert.ok(validate(args), `${file}: ${line}\n${JSON.stringify(validate.errors)}`)
    }
    // The worked example is the canonical workflow: open, inspect, adjustment + mask, preview, undo, export, stop.
    const order = exampleCalls(SKILL).map((call) => call.tool)
    for (const tool of ['photofresco_connect', 'photofresco_import_file', 'doc_get_state', 'adjust_add', 'mask_add', 'render_preview', 'history_undo', 'photofresco_export_file', 'photofresco_disconnect']) {
      assert.ok(order.includes(tool), `the worked example calls ${tool}`)
    }
    assert.equal(order[0], 'photofresco_connect')
    assert.equal(order.at(-1), 'photofresco_disconnect')
  })

  it('the essentials group fits the tool count the skill states', () => {
    assert.match(SKILL, /\(about 40 tools\)/)
    assert.ok(Object.keys(LIFECYCLE_TOOLS).length + (TOOL_GROUPS.essentials.ops?.length ?? 0) <= 40)
  })

  it('the workflow example matches the current operation contracts', () => {
    /** @type {{ format: string, version: number, requires: { ops: Record<string, { effects: string[], capabilities: string[], params: string[] }> }, steps: Array<{ id: string, op: string, params: Record<string, unknown> }> }} */
    const workflow = workflowDocument()
    assert.equal(workflow.format, 'photofresco.workflow')
    assert.equal(workflow.version, 1)
    for (const step of workflow.steps) assert.ok(Object.hasOwn(workflow.requires.ops, step.op), `${step.op} is in requires.ops`)
    for (const [name, required] of Object.entries(workflow.requires.ops)) {
      const op = OPS.get(name)
      assert.ok(op, `${name} is an operation`)
      assert.deepEqual(required.effects, op.effects, `${name} effects`)
      assert.deepEqual(required.capabilities, op.capabilities, `${name} capabilities`)
      for (const param of required.params) assert.ok(Object.hasOwn(op.input_schema.properties, param), `${name} accepts ${param}`)
      const used = [...new Set(workflow.steps.filter((step) => step.op === name).flatMap((step) => Object.keys(step.params)))].sort()
      assert.deepEqual(required.params, used, `${name} params are the ones the steps pass`)
    }
    // The effect phrases the skill teaches are the server's own tool-description wording.
    const text = MARKDOWN.find((doc) => doc.file === join('references', 'workflows.md'))?.text ?? ''
    const phrases = [...text.replace(/\n\s*/g, ' ').matchAll(/"([^"]+)" = `([a-z-]+)`/g)]
    assert.equal(phrases.length, 7)
    const effectText = Object.fromEntries(CATALOG.flatMap((op) => op.effects.map((effect) => [effect, describeOperation({ ...op, effects: [effect] })])))
    for (const [, phrase, effect] of phrases) assert.ok(effectText[effect]?.includes(`Effect: ${phrase}`), `"${phrase}" is how tool descriptions state ${effect}`)
  })

  it('the troubleshooting reference lists every error code with the server\'s own hint', () => {
    const doc = MARKDOWN.find((entry) => entry.file === join('references', 'troubleshooting.md'))
    assert.ok(doc)
    const rows = [...doc.text.matchAll(/^\| `([a-z_]+)` \| (.+) \|$/gm)].map((match) => [match[1], match[2].replaceAll('\\|', '|')])
    assert.deepEqual(rows.map(([code]) => code).sort(), Object.keys(ERROR_HINTS).sort())
    for (const [code, hint] of rows) assert.equal(hint, ERROR_HINTS[code], `${code} hint`)
    for (const [, code] of SKILL.matchAll(/^\| `([a-z_]+)` \| /gm)) assert.ok(Object.hasOwn(ERROR_HINTS, code), `${code} is an error code`)
  })

  it('links resolve: files inside the skill, the public repository for everything else', () => {
    for (const { file, text } of MARKDOWN) {
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^https?:/.test(target)) {
          assert.ok(target.startsWith(SERVER_JSON.repository.url) || target.startsWith('https://photofresco.com/'), `${file}: ${target} points at the package repository or photofresco.com`)
        } else {
          assert.ok(existsSync(join(SKILL_DIR, dirname(file), target)), `${file}: ${target} exists inside the skill`)
        }
      }
    }
  })
})
