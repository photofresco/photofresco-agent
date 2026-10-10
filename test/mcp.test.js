// @ts-check
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Ajv, addFormats } from '@modelcontextprotocol/client/validators/ajv'
import { CONNECTOR_ERROR_CODES, CONNECTOR_VERSION, ConnectorError } from '../src/index.js'
import { ERROR_HINTS, errorResult, extractPayloads, operationResult, thrownResult } from '../src/mcp/results.js'
import { SERVER_INFO } from '../src/mcp/server.js'
import { DEFAULT_TOOL_GROUPS, LIFECYCLE_TOOLS, TOOL_GROUPS, annotationsFor, describeOperation, groupOf, loadCatalog, parseToolGroups, titleFor } from '../src/mcp/tools.js'
import { Client, StdioClientTransport } from './support/mcpClient.js'
import { mcpbReleaseUrl } from '../scripts/build-mcpb.mjs'

/**
 * pf-agent-platform-nkwn.15: the MCP server as a clean process, driven by the official MCP
 * TypeScript client over stdio. The editor-side flow (pairing, grants, list_changed, previews,
 * artifacts, refusals) is test/agent-mcp.test.mjs in the editor repository; the real browser run
 * is scripts/agent-mcp-e2e.mjs.
 */

const BIN = new URL('../src/bin/photofresco.js', import.meta.url).pathname
const FAKE_BROWSER = new URL('./fixtures/fake-browser.mjs', import.meta.url).pathname
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const SERVER_JSON = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'))
const CATALOG = loadCatalog()

const work = mkdtempSync(join(tmpdir(), 'pf-mcp-test-'))
after(() => rmSync(work, { recursive: true, force: true }))
let run = 0

/**
 * Spawn `photofresco mcp` with a browser that records its own launch, and connect the official client.
 * @param {{ args?: string[], era?: 'legacy' | 'modern' }} [options]
 */
async function spawnServer(options = {}) {
  const marker = join(work, `browser-launched-${++run}.json`)
  /** @type {Array<{ error: unknown, count: number | undefined }>} */
  const changes = []
  const client = new Client({ name: 'mcp-conformance-test', version: '1.0.0' }, {
    ...(options.era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    listChanged: { tools: { onChanged: (/** @type {unknown} */ error, /** @type {unknown[] | null} */ tools) => changes.push({ error, count: tools?.length }) } },
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp', '--profile', 'ephemeral', ...(options.args ?? [])],
    env: { ...process.env, PHOTOFRESCO_BROWSER: FAKE_BROWSER, FAKE_BROWSER_ARGS: marker },
    stderr: 'pipe',
  })
  await client.connect(transport)
  return { client, marker, changes, close: () => client.close() }
}

/** @param {any} result */
const structured = (result) => /** @type {Record<string, any>} */ (result.structuredContent)

describe('clean process: no browser until photofresco_connect', () => {
  for (const era of /** @type {const} */ (['legacy', 'modern'])) {
    it(`initialize and tools/list over stdio (${era} era) start no browser; op calls fail with nothing started`, async () => {
      const { client, marker, close } = await spawnServer({ era })
      try {
        assert.equal(client.getProtocolEra(), era)
        assert.deepEqual(client.getServerVersion(), { ...SERVER_INFO })
        assert.match(client.getInstructions() ?? '', /photofresco_connect/)
        assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: true })
        const { tools } = await client.listTools()
        const names = tools.map((tool) => tool.name)
        const lifecycle = Object.keys(LIFECYCLE_TOOLS).filter((name) => name !== 'photofresco_import_file' && name !== 'photofresco_export_file')
        const essentials = CATALOG.operations.filter((op) => TOOL_GROUPS.essentials.ops?.includes(op.name)).map((op) => op.tool_name)
        assert.deepEqual(names, [...lifecycle, ...essentials])
        assert.ok(names.length <= 40, `the default list fits clients with a 40-tool limit (${names.length})`)

        const layerAdd = await client.callTool({ name: 'layer_add', arguments: { name: 'Nope' } })
        assert.equal(layerAdd.isError, true)
        assert.equal(structured(layerAdd).code, 'not_connected')
        assert.match(/** @type {any} */ (layerAdd.content)[0].text, /photofresco_connect/)
        for (const name of ['photofresco_documents', 'photofresco_attach', 'photofresco_request_access']) {
          const result = await client.callTool({ name, arguments: name === 'photofresco_attach' ? { document: 'doc_0' } : name === 'photofresco_request_access' ? { capabilities: ['read'] } : {} })
          assert.equal(result.isError, true, name)
          assert.equal(structured(result).code, 'not_connected', name)
        }
        const status = await client.callTool({ name: 'photofresco_status', arguments: {} })
        assert.equal(status.isError, undefined)
        assert.equal(structured(status).state, 'idle')
        assert.equal(structured(status).browser, null)
        assert.deepEqual((await client.listResources()).resources, [])
        await assert.rejects(client.callTool({ name: 'session_stop', arguments: {} }), /Unknown tool: session_stop/)
        assert.equal(existsSync(marker), false, 'no browser was launched')
      } finally {
        await close()
      }
    })
  }

  it('photofresco_connect is what launches the browser (control for the marker)', async () => {
    const { client, marker, close } = await spawnServer()
    try {
      const result = await client.callTool({ name: 'photofresco_connect', arguments: { wait_seconds: 0 } })
      assert.equal(result.isError, undefined, JSON.stringify(result))
      await waitFor(() => existsSync(marker), 'the fake browser to start')
      const args = JSON.parse(readFileSync(marker, 'utf8'))
      assert.ok(args.includes('--remote-debugging-pipe'))
    } finally {
      await close()
    }
  })
})

describe('tool list', () => {
  it('--tools all lists every catalog op once, never session.* and no generic executor', async () => {
    const { client, close } = await spawnServer({ args: ['--tools', 'all', '--read', work, '--write', work] })
    try {
      const { tools } = await client.listTools()
      const names = tools.map((tool) => tool.name)
      assert.equal(new Set(names).size, names.length)
      assert.deepEqual(names, [...Object.keys(LIFECYCLE_TOOLS), ...CATALOG.operations.map((op) => op.tool_name)])
      assert.equal(names.some((name) => /^session_|^privacy_set_policy$|execute|eval|run_op|^call_/.test(name)), false)
      for (const tool of tools) {
        assert.ok(tool.title && tool.title.length <= 64, tool.name)
        assert.ok(tool.description && tool.description.length > 60, tool.name)
        assert.equal(tool.inputSchema.type, 'object', tool.name)
        const hints = /** @type {Record<string, unknown>} */ (tool.annotations)
        for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof hints[key], 'boolean', `${tool.name}.${key}`)
      }
      for (const op of CATALOG.operations) {
        const tool = tools.find((candidate) => candidate.name === op.tool_name)
        assert.deepEqual(tool?.annotations, annotationsFor(op), op.name)
        assert.deepEqual(tool?.inputSchema, op.input_schema, `${op.name}: the exact registry schema`)
      }
    } finally {
      await close()
    }
  })

  it('selecting tool groups sends tools/list_changed; unknown groups are tool errors', async () => {
    const { client, changes, close } = await spawnServer()
    try {
      const before = (await client.listTools()).tools.length
      const groups = structured(await client.callTool({ name: 'photofresco_list_tool_groups', arguments: {} })).groups
      assert.deepEqual(groups.map((/** @type {any} */ group) => group.id), Object.keys(TOOL_GROUPS))
      assert.equal(groups.find((/** @type {any} */ group) => group.id === 'other').available_now, 0)
      const selected = await client.callTool({ name: 'photofresco_select_tool_groups', arguments: { enable: ['layers'] } })
      assert.deepEqual(structured(selected).enabled, ['essentials', 'layers'])
      await waitFor(() => changes.length > 0, 'tools/list_changed')
      const layers = CATALOG.operations.filter((op) => groupOf(op.name) === 'layers' && !TOOL_GROUPS.essentials.ops?.includes(op.name)).length
      assert.equal((await client.listTools()).tools.length, before + layers)
      const unknown = await client.callTool({ name: 'photofresco_select_tool_groups', arguments: { enable: ['sorcery'] } })
      assert.equal(unknown.isError, true)
      assert.equal(structured(unknown).code, 'unknown_tool_group')
    } finally {
      await close()
    }
  })

  it('file tools appear only for folders the person granted', async () => {
    const { client, close } = await spawnServer({ args: ['--read', work] })
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      assert.ok(names.includes('photofresco_import_file'))
      assert.equal(names.includes('photofresco_export_file'), false)
      const status = structured(await client.callTool({ name: 'photofresco_status', arguments: {} }))
      assert.equal(status.roots.length, 1)
      assert.equal(status.roots[0].read, true)
      const imported = await client.callTool({ name: 'photofresco_import_file', arguments: { path: join(work, 'x.png') } })
      assert.equal(structured(imported).code, 'not_connected')
    } finally {
      await close()
    }
  })

  it('every catalog op is in exactly one topical group and the essentials exist', () => {
    const names = new Set(CATALOG.operations.map((op) => op.name))
    for (const name of TOOL_GROUPS.essentials.ops ?? []) assert.ok(names.has(name), name)
    assert.deepEqual(CATALOG.operations.filter((op) => groupOf(op.name) === 'other').map((op) => op.name), [])
    assert.deepEqual(parseToolGroups(undefined), [...DEFAULT_TOOL_GROUPS])
    assert.deepEqual(parseToolGroups('all'), Object.keys(TOOL_GROUPS))
    assert.throws(() => parseToolGroups('essentials,nope'), /Unknown tool group nope/)
  })

  it('titles and descriptions carry inputs, effect, undo behaviour and the permission', () => {
    assert.equal(titleFor('layer.set_fill_opacity'), 'Layer: Set fill opacity')
    assert.equal(titleFor('doc.get_state'), 'Document: Get state')
    assert.equal(titleFor('ai.remove_background'), 'AI: Remove background')
    const byName = Object.fromEntries(CATALOG.operations.map((op) => [op.name, op]))
    const add = describeOperation(byName['adjust.add'])
    assert.match(add, /Inputs: .*adjustment_type \(required\)/)
    assert.match(add, /undoable command/)
    assert.match(add, /Undo: history_undo reverts it/)
    assert.match(add, /Permission: Edit/)
    const close = describeOperation(byName['doc.close'])
    assert.match(close, /history_undo does not reverse it/)
    assert.match(close, /Undo: not reversible/)
    const region = describeOperation(byName['render.region'])
    assert.match(region, /changes nothing/)
    assert.doesNotMatch(region, /Undo:/)
    assert.match(region, /Permission: Read/)
    assert.match(describeOperation(byName['ai.generate']), /Permission: Read \+ Edit \+ Spend \+ Send/)
  })
})

describe('annotation mapping (OpMetadata effects → MCP hints)', () => {
  /** @type {Array<[string[], { readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean }]>} */
  const TABLE = [
    [['read'], { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }],
    [['document'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
    [['view'], { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }],
    [['lifecycle'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
    [['local-storage'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
    [['external-write'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
    [['read', 'local-storage'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }],
    [['document', 'external-write'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
    [['document', 'external-write', 'paid'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
    [['local-storage', 'external-write'], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }],
  ]
  for (const [effects, expected] of TABLE) {
    it(`${effects.join(' + ')}`, () => assert.deepEqual(annotationsFor({ effects }), expected))
  }

  it('covers every effect combination in the catalog', () => {
    const seen = new Set(CATALOG.operations.map((op) => op.effects.join(' + ')))
    const tabled = new Set(TABLE.map(([effects]) => effects.join(' + ')))
    assert.deepEqual([...seen].filter((combo) => !tabled.has(combo)), [])
    const hints = (/** @type {string} */ name) => annotationsFor(/** @type {any} */ (CATALOG.operations.find((op) => op.name === name)))
    assert.equal(hints('doc.get_state').readOnlyHint, true)
    assert.equal(hints('layer.add').destructiveHint, false)
    assert.equal(hints('doc.close').destructiveHint, true)
    assert.equal(hints('ai.generate').openWorldHint, true)
    assert.equal(hints('color.set').readOnlyHint, false)
  })
})

describe('listing metadata', () => {
  it('server.json validates against the registry schema and matches package.json', () => {
    const ajv = new Ajv({ strict: false, allErrors: true })
    addFormats(ajv)
    const schema = JSON.parse(readFileSync(new URL('./fixtures/server.schema.json', import.meta.url), 'utf8'))
    const validate = ajv.compile(schema)
    assert.ok(validate(structuredClone(SERVER_JSON)), JSON.stringify(validate.errors))
    assert.equal(SERVER_JSON.$schema, 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json')
    assert.equal(PACKAGE.mcpName, SERVER_JSON.name)
    // GitHub-OIDC namespace of the photofresco org (pf-agent-platform-nkwn.39); no DNS record needed.
    assert.equal(SERVER_JSON.name, 'io.github.photofresco/photofresco')
    assert.ok(SERVER_JSON.description.length <= 100)
    assert.equal(PACKAGE.description, SERVER_JSON.description)
    for (const version of [SERVER_JSON.version, SERVER_JSON.packages[0].version, SERVER_INFO.version, CONNECTOR_VERSION]) assert.equal(version, PACKAGE.version)
    // Until npm publishes the package, the registry entry is the MCP bundle on the GitHub Release
    // (pf-agent-platform-nkwn.35): the registry refuses an npm package it cannot fetch, so npm joins
    // in a later server version. The bundle's manifest supplies the `mcp` argument.
    const [pkg] = SERVER_JSON.packages
    assert.equal(SERVER_JSON.packages.length, 1)
    assert.deepEqual({ registryType: pkg.registryType, identifier: pkg.identifier, transport: pkg.transport }, { registryType: 'mcpb', identifier: mcpbReleaseUrl(PACKAGE.version), transport: { type: 'stdio' } })
    assert.match(pkg.identifier, /mcp/i, 'the registry requires "mcp" in an MCPB URL')
    assert.match(pkg.fileSha256, /^[0-9a-f]{64}$/)
    assert.equal(pkg.registryBaseUrl, undefined)
    assert.equal(pkg.packageArguments, undefined)
    assert.equal(PACKAGE.bin.photofresco, 'src/bin/photofresco.js')
    assert.match(SERVER_JSON.repository.url, /^https:\/\/github\.com\/photofresco\//)
    assert.ok(PACKAGE.files.includes('src') && PACKAGE.files.includes('server.json'))
  })
})

describe('result and error mapping', () => {
  it('every connector error code has its own next step', () => {
    for (const code of Object.keys(CONNECTOR_ERROR_CODES)) {
      assert.ok(Object.hasOwn(ERROR_HINTS, code), code)
      const result = thrownResult(new ConnectorError(code, `message for ${code}`, { stage: 'path' }))
      assert.equal(result.isError, true)
      assert.deepEqual(result.structuredContent, { ok: false, code, message: `message for ${code}`, hint: ERROR_HINTS[code], stage: 'path' })
      assert.equal(/** @type {any} */ (result.content[0]).text, `Error ${code}: message for ${code}\nNext: ${ERROR_HINTS[code]}`)
    }
    assert.equal(thrownResult(new Error('boom')).structuredContent?.code, 'internal_error')
    assert.equal(errorResult('no_such_code', 'x').structuredContent?.hint, ERROR_HINTS.operation_failed)
  })

  it('refused and failed responses are tool errors with the editor code', () => {
    for (const status of ['rejected', 'failed', 'canceled', 'unknown']) {
      const result = operationResult('layer.add', { ok: false, status, code: 'lease_paused', error: 'Paused', request_id: 'r1', document_id: 'doc_1', revision: 4 })
      assert.equal(result.isError, true)
      assert.deepEqual(result.structuredContent, { ok: false, code: 'lease_paused', message: 'Paused', hint: ERROR_HINTS.lease_paused, op: 'layer.add', status, request_id: 'r1', document_id: 'doc_1', revision: 4 })
    }
    const unknown = operationResult('layer.add', { ok: false, status: 'failed', error: 'Exploded', request_id: 'r2' })
    assert.equal(unknown.structuredContent?.code, 'operation_failed')
  })

  it('previews become image content; exports become resource links; chunks become embedded blobs', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const region = extractPayloads('render.region', { region: { x: 0 }, image: { mime_type: 'image/png', width: 8, height: 4, byte_length: 4, data_base64: png } })
    assert.deepEqual(region.content, [{ type: 'image', data: png, mimeType: 'image/png' }])
    assert.equal(/** @type {any} */ (region.result).image.data_base64, '(8×4 image/png returned as image content)')
    const preview = extractPayloads('render.preview', { data_url: `data:image/png;base64,${png}`, width: 8, height: 4 })
    assert.deepEqual(preview.content, [{ type: 'image', data: png, mimeType: 'image/png' }])
    assert.doesNotMatch(JSON.stringify(preview.result), /base64,/)
    const exported = operationResult('export.artifact', { ok: true, status: 'succeeded', request_id: 'e', document_id: 'doc_1', revision: 3, result: { artifact_id: 'art_1', format: 'png', mime_type: 'image/png', filename: 'a.png', byte_length: 99, fidelity: 'flattened' } })
    assert.deepEqual(exported.content[0], {
      type: 'resource_link', uri: 'photofresco://artifact/art_1', name: 'a.png', mimeType: 'image/png', size: 99,
      description: 'PhotoFresco png export (flattened); readable for 10 minutes while this session targets its document',
    })
    assert.equal(/** @type {any} */ (exported.structuredContent).result.resource_uri, 'photofresco://artifact/art_1')
    const chunk = extractPayloads('artifact.read', { artifact_id: 'art_1', mime_type: 'image/png', offset: 0, length: 4, data_base64: png })
    assert.deepEqual(chunk.content, [{ type: 'resource', resource: { uri: 'photofresco://artifact/art_1#offset=0', mimeType: 'image/png', blob: png } }])
    assert.doesNotMatch(JSON.stringify(chunk.result), new RegExp(png))
  })
})

/** @param {() => boolean} check @param {string} what */
async function waitFor(check, what, timeout = 10_000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
