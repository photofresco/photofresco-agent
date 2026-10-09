// @ts-check
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { CONNECTOR_VERSION, createConnector } from '../src/index.js'

/**
 * The shared API before and around a browser: constructing it starts nothing (MCP
 * initialize/tools/list must work headless), the editor URL is pinned, and every
 * session or file call refuses without a paired session before touching anything.
 * Pairing, grants and file transfers against the real editor channel are covered by
 * the editor repository's test/agent-connector.test.mjs and its browser proof.
 */
const base = mkdtempSync(join(tmpdir(), 'pf-connector-api-'))
after(() => rmSync(base, { recursive: true, force: true }))

describe('connector construction', () => {
  it('starts no browser, process or profile until connect()', () => {
    let launches = 0
    const dataDir = join(base, 'data')
    const connector = createConnector({ surface: 'mcp', dataDir, launch: async () => { launches++; throw new Error('not expected') } })
    const status = connector.status()
    assert.equal(launches, 0)
    assert.equal(existsSync(dataDir), false, 'no profile folder is created')
    assert.deepEqual(status, {
      protocol: 1,
      connector: { name: 'PhotoFresco connector', version: CONNECTOR_VERSION },
      surface: 'mcp',
      state: 'idle',
      editor: { url: 'https://photofresco.com/app/', origin: 'https://photofresco.com' },
      browser: null,
      pairing: null,
      session: null,
      last_end: null,
      roots: [],
    })
  })

  it('keeps its version in step with package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(CONNECTOR_VERSION, pkg.version)
  })

  it('pins an https editor origin and opens it with only the non-secret surface token', () => {
    const connector = createConnector({ surface: 'cli', editorUrl: 'https://staging.photofresco.com/app/?pf_ref=evil' })
    assert.equal(connector.origin, 'https://staging.photofresco.com')
    assert.equal(connector.launchUrl, 'https://staging.photofresco.com/app/?pf_ref=cli')
    assert.equal(connector.status().editor.url, 'https://staging.photofresco.com/app/')
  })

  it('refuses plain http except a loopback development editor, credentials and fragments', () => {
    for (const editorUrl of ['http://photofresco.com/app/', 'http://127.0.0.1:5173/app/', 'https://user:pw@photofresco.com/app/', 'https://photofresco.com/app/#k=1', 'javascript:alert(1)', 'not a url']) {
      assert.throws(() => createConnector({ surface: 'mcp', editorUrl }), { code: 'invalid_options' }, editorUrl)
    }
    assert.equal(createConnector({ surface: 'mcp', editorUrl: 'http://127.0.0.1:5173/app/', allowLoopbackEditor: true }).origin, 'http://127.0.0.1:5173')
    assert.throws(() => createConnector({ surface: 'mcp', allowLoopbackEditor: true, editorUrl: 'http://10.0.0.5/app/' }), { code: 'invalid_options' })
  })

  it('validates surface, client name and roots', () => {
    assert.throws(() => createConnector(/** @type {any} */ ({ surface: 'chatgpt' })), { code: 'invalid_options' })
    assert.throws(() => createConnector({ surface: 'mcp', client: '' }), { code: 'invalid_options' })
    assert.throws(() => createConnector({ surface: 'mcp', client: 'x'.repeat(49) }), { code: 'invalid_options' })
    assert.throws(() => createConnector({ surface: 'mcp', roots: [{ path: join(base, 'missing'), read: true }] }), { code: 'invalid_options' })
    const connector = createConnector({ surface: 'sdk', roots: [{ path: base, read: true }] })
    assert.equal(connector.roots().length, 1)
  })
})

describe('without a paired session', () => {
  it('refuses session and file calls before reading or writing anything', async () => {
    const connector = createConnector({ surface: 'mcp', roots: [{ path: base, read: true, write: true }] })
    for (const call of [
      () => connector.sessionStatus(),
      () => connector.documents(),
      () => connector.operations(),
      () => connector.execute({ op: 'doc.get_state' }),
      () => connector.requestAccess({ capabilities: ['read'] }),
      () => connector.outcome({ request_id: 'r1' }),
      () => connector.importFile({ path: join(base, 'nothing.png') }),
      () => connector.exportFile({ path: join(base, 'out.png'), format: 'png' }),
      () => connector.fetchArtifact({ artifact_id: 'art_1' }),
    ]) {
      await assert.rejects(call(), { code: 'not_connected' })
    }
    assert.equal(existsSync(join(base, 'out.png')), false)
    assert.equal(await connector.close(), null)
    await connector.shutdown()
    assert.equal(connector.status().state, 'idle')
  })

  it('reports a missing browser without launching anything', async () => {
    let launches = 0
    const connector = createConnector({ surface: 'mcp', browserPath: join(base, 'no-such-browser'), launch: async () => { launches++; throw new Error('not expected') } })
    await assert.rejects(connector.connect(), { code: 'browser_not_found' })
    assert.equal(launches, 0)
    assert.equal(connector.status().state, 'idle')
  })

  it('returns to idle when the browser fails to start', async () => {
    const connector = createConnector({
      surface: 'mcp', browserPath: process.execPath, profileDir: join(base, 'profile'),
      launch: async () => { throw Object.assign(new Error('boom'), { code: 'browser_launch_failed' }) },
    })
    /** @type {string[]} */
    const states = []
    connector.subscribe((event) => { if (event.type === 'state') states.push(event.state) })
    await assert.rejects(connector.connect(), { code: 'browser_launch_failed' })
    assert.deepEqual(states, ['starting', 'idle'])
  })

  it('validates connect arguments before launching', async () => {
    let launches = 0
    const connector = createConnector({ surface: 'mcp', browserPath: process.execPath, launch: async () => { launches++; throw new Error('not expected') } })
    await assert.rejects(connector.connect({ client: 'x'.repeat(49) }), { code: 'invalid_request' })
    await assert.rejects(connector.connect({ timeout_ms: 10 }), { code: 'invalid_request' })
    assert.equal(launches, 0)
  })
})
