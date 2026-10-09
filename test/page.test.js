// @ts-check
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CONNECTOR_BINDING, DELIVER, EditorPage } from '../src/page.js'

/**
 * The connector's tab link against a scripted browser: which binding calls it trusts
 * (pinned origin, main frame, default world), what it sends (only DELIVER with data
 * arguments), and how navigation, reload, closing and crashes end the channel.
 */
const ORIGIN = 'https://photofresco.com'
const KEY = 'a'.repeat(64)

class ScriptedBrowser {
  constructor() {
    /** @type {Set<(event: any) => void>} */
    this.listeners = new Set()
    /** @type {Array<{ method: string, params: any, sessionId?: string }>} */
    this.sent = []
    this.nextContext = 0
    /** @type {(envelope: any, contextId: number) => unknown} */
    this.receive = () => 'accepted'
    /** Origin the next navigation lands on (an attacker redirect when different). */
    this.landOrigin = ORIGIN
    this.announce = true
  }

  /** @param {(event: any) => void} listener */
  on(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @param {string} method @param {Record<string, any>} [params] @param {string} [sessionId] */
  async send(method, params = {}, sessionId) {
    this.sent.push({ method, params, sessionId })
    switch (method) {
      case 'Target.attachToTarget': return { sessionId: 'S1' }
      case 'Page.getFrameTree': return { frameTree: { frame: { id: 'MAIN' } } }
      case 'Page.navigate':
        setImmediate(() => this.load(this.landOrigin))
        return { frameId: 'MAIN' }
      case 'Runtime.callFunctionOn':
        return { result: { value: this.receive(params.arguments[0].value, params.executionContextId) } }
      default: return {}
    }
  }

  /** @param {string} method @param {Record<string, any>} params @param {string} [sessionId] */
  emit(method, params, sessionId = 'S1') {
    for (const listener of [...this.listeners]) listener({ method, params, sessionId })
  }

  /** A new document in the main frame (plus an iframe context of the same origin). @param {string} origin */
  load(origin) {
    this.emit('Runtime.executionContextsCleared', {})
    this.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: `${origin}/app/` } })
    this.main = ++this.nextContext
    this.emit('Runtime.executionContextCreated', { context: { id: this.main, origin, auxData: { isDefault: true, frameId: 'MAIN' } } })
    this.frame = ++this.nextContext
    this.emit('Runtime.executionContextCreated', { context: { id: this.frame, origin, auxData: { isDefault: true, frameId: 'CHILD' } } })
    this.isolated = ++this.nextContext
    this.emit('Runtime.executionContextCreated', { context: { id: this.isolated, origin, auxData: { isDefault: false, frameId: 'MAIN' } } })
    if (this.announce) this.binding(this.main, { v: 1, type: 'ready', key: KEY, protocol: 1, session_protocol: 1 })
  }

  /** @param {number | undefined} contextId @param {unknown} message */
  binding(contextId, message) {
    this.emit('Runtime.bindingCalled', { name: CONNECTOR_BINDING, payload: JSON.stringify(message), executionContextId: contextId })
  }
}

async function open(options = {}) {
  const browser = new ScriptedBrowser()
  Object.assign(browser, options)
  /** @type {Array<[string, string]>} */
  const downs = []
  /** @type {any[]} */
  const events = []
  /** @type {any[]} */
  const logs = []
  const page = new EditorPage(/** @type {any} */ (browser), {
    origin: ORIGIN, readyMs: 300, onDown: (code, message) => downs.push([code, message]), onEvent: (event) => events.push(event), log: (entry) => logs.push(entry),
  })
  await page.attach('T1')
  return { browser, page, downs, events, logs }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('connector tab channel', () => {
  it('opens only on the pinned origin and sends nothing but DELIVER with data', async () => {
    const { browser, page } = await open()
    await page.load(`${ORIGIN}/app/?pf_ref=mcp`)
    assert.equal(page.ready, true)
    assert.deepEqual(browser.sent.map(({ method }) => method), ['Target.attachToTarget', 'Runtime.enable', 'Page.enable', 'Page.getFrameTree', 'Runtime.addBinding', 'Page.navigate'])
    browser.receive = (envelope, contextId) => {
      assert.equal(contextId, browser.main)
      setImmediate(() => browser.binding(browser.main, { v: 1, type: 'response', id: envelope.id, ok: true, result: { echo: envelope.params } }))
      return 'accepted'
    }
    assert.deepEqual(await page.call('status', { a: 1 }, 'session-key'), { echo: { a: 1 } })
    assert.deepEqual(await page.call('documents'), {})
    const deliveries = browser.sent.filter(({ method }) => method === 'Runtime.callFunctionOn')
    assert.deepEqual(deliveries.map(({ params }) => params.functionDeclaration), [DELIVER, DELIVER])
    assert.deepEqual(deliveries.map(({ params }) => params.arguments[0].value), [
      { v: 1, key: KEY, id: 1, method: 'status', session_key: 'session-key', params: { a: 1 } },
      { v: 1, key: KEY, id: 2, method: 'documents' },
    ])
    assert.equal(browser.sent.some(({ method }) => method === 'Runtime.evaluate'), false)
    await assert.rejects(page.load('https://evil.example/app/'), { code: 'invalid_request' })
  })

  it('ignores binding calls from frames, isolated worlds and other origins', async () => {
    const { browser, page, logs } = await open({ announce: false })
    const loading = page.load(`${ORIGIN}/app/`)
    await tick()
    await tick()
    browser.binding(browser.frame, { v: 1, type: 'ready', key: 'b'.repeat(64), protocol: 1 })
    browser.binding(browser.isolated, { v: 1, type: 'ready', key: 'c'.repeat(64), protocol: 1 })
    browser.binding(browser.main, { v: 1, type: 'ready', key: 'not-hex', protocol: 1 })
    await assert.rejects(loading, { code: 'editor_unavailable' })
    assert.equal(page.ready, false)
    assert.equal(logs.filter((entry) => entry.event === 'binding_ignored').length, 2)
  })

  it('never opens a channel for an editor that lands on another origin', async () => {
    const { page, downs } = await open({ landOrigin: 'https://evil.example' })
    await assert.rejects(page.load(`${ORIGIN}/app/`), { code: 'origin_changed' })
    assert.equal(page.ready, false)
    assert.deepEqual(downs, [])
  })

  it('refuses an editor speaking another channel protocol', async () => {
    const { browser, page } = await open({ announce: false })
    const loading = page.load(`${ORIGIN}/app/`)
    await tick()
    await tick()
    browser.binding(browser.main, { v: 2, type: 'ready', key: KEY, protocol: 2 })
    await assert.rejects(loading, { code: 'editor_unsupported' })
  })

  it('drops the channel and pending calls when the tab leaves the origin, then ignores the foreign page', async () => {
    const { browser, page, downs } = await open()
    await page.load(`${ORIGIN}/app/`)
    browser.receive = () => 'accepted'
    const pending = page.call('execute', { op: 'layer.add' }, 'k')
    await tick()
    browser.landOrigin = 'https://evil.example'
    browser.load('https://evil.example')
    await assert.rejects(pending, { code: 'origin_changed' })
    assert.deepEqual(downs.map(([code]) => code), ['origin_changed'])
    assert.ok(browser.sent.some(({ method, params }) => method === 'Runtime.removeBinding' && params.name === CONNECTOR_BINDING))
    // The foreign page announces itself through the still-installed binding: ignored.
    browser.binding(browser.main, { v: 1, type: 'ready', key: KEY, protocol: 1 })
    assert.equal(page.ready, false)
    await assert.rejects(page.call('status'), { code: 'not_connected' })
  })

  it('ends the channel on reload, tab close and crash', async () => {
    const reload = await open()
    await reload.page.load(`${ORIGIN}/app/`)
    reload.browser.receive = () => 'accepted'
    const inFlight = reload.page.call('execute', {}, 'k')
    await tick()
    reload.browser.emit('Runtime.executionContextDestroyed', { executionContextId: reload.browser.main })
    await assert.rejects(inFlight, { code: 'page_reloaded' })
    assert.deepEqual(reload.downs.map(([code]) => code), ['page_reloaded'])

    const closed = await open()
    await closed.page.load(`${ORIGIN}/app/`)
    closed.browser.emit('Target.detachedFromTarget', { sessionId: 'S1' }, undefined)
    assert.equal(closed.page.attached, false)
    assert.deepEqual(closed.downs.map(([code]) => code), ['page_closed'])

    const crashed = await open()
    await crashed.page.load(`${ORIGIN}/app/`)
    crashed.browser.emit('Inspector.targetCrashed', {})
    assert.deepEqual(crashed.downs.map(([code]) => code), ['page_closed'])
  })

  it('reports a refused delivery without waiting for an answer', async () => {
    const { browser, page } = await open()
    await page.load(`${ORIGIN}/app/`)
    browser.receive = () => ({ rejected: 'unauthorized' })
    await assert.rejects(page.call('status'), { code: 'channel_rejected', details: { reason: 'unauthorized' } })
  })

  it('forwards page events and ignores responses for unknown requests', async () => {
    const { browser, page, events } = await open()
    await page.load(`${ORIGIN}/app/`)
    browser.binding(browser.main, { v: 1, type: 'response', id: 99, ok: true, result: {} })
    browser.binding(browser.main, { v: 1, type: 'event', event: 'session_ended', reason: 'Stopped by the user' })
    assert.deepEqual(events, [{ v: 1, type: 'event', event: 'session_ended', reason: 'Stopped by the user' }])
  })
})
