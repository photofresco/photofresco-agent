// @ts-check
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { CdpConnection } from '../src/cdp.js'

/** A pipe pair standing in for the browser's fd 3 / fd 4. */
function pipes(options = {}) {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  /** @type {string[]} */
  const written = []
  toBrowser.on('data', (chunk) => written.push(chunk.toString()))
  const cdp = new CdpConnection(toBrowser, fromBrowser, options)
  return { cdp, fromBrowser, written }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('CDP over the browser pipe', () => {
  it('frames commands with NUL and routes responses split across chunks', async () => {
    const { cdp, fromBrowser, written } = pipes()
    const version = cdp.send('Browser.getVersion')
    const navigate = cdp.send('Page.navigate', { url: 'https://photofresco.com/app/' }, 'S1')
    await tick()
    assert.deepEqual(written.join('').split('\0').filter(Boolean).map((text) => JSON.parse(text)), [
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Page.navigate', params: { url: 'https://photofresco.com/app/' }, sessionId: 'S1' },
    ])
    const frames = `${JSON.stringify({ id: 2, result: { frameId: 'F' } })}\0${JSON.stringify({ id: 1, result: { product: 'Chrome/145.0.1.2' } })}\0`
    fromBrowser.write(frames.slice(0, 7))
    fromBrowser.write(frames.slice(7, 40))
    fromBrowser.write(frames.slice(40))
    assert.deepEqual(await navigate, { frameId: 'F' })
    assert.deepEqual(await version, { product: 'Chrome/145.0.1.2' })
  })

  it('delivers events with their session and rejects protocol errors', async () => {
    const { cdp, fromBrowser } = pipes()
    /** @type {any[]} */
    const events = []
    cdp.on((event) => events.push(event))
    const failing = cdp.send('Runtime.callFunctionOn', {}, 'S1')
    fromBrowser.write(`${JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: 'b', payload: '{}', executionContextId: 3 }, sessionId: 'S1' })}\0`)
    fromBrowser.write(`${JSON.stringify({ id: 1, error: { code: -32000, message: 'Cannot find context' } })}\0`)
    await assert.rejects(failing, { name: 'CdpError', message: 'Runtime.callFunctionOn: Cannot find context' })
    assert.deepEqual(events, [{ method: 'Runtime.bindingCalled', params: { name: 'b', payload: '{}', executionContextId: 3 }, sessionId: 'S1' }])
  })

  it('discards an oversized frame without losing the next one', async () => {
    /** @type {number[]} */
    const discarded = []
    const { cdp, fromBrowser } = pipes({ maxMessageBytes: 64, onDiscard: (/** @type {number} */ bytes) => discarded.push(bytes) })
    const pending = cdp.send('Browser.getVersion')
    const flood = JSON.stringify({ method: 'Runtime.bindingCalled', params: { payload: 'x'.repeat(500) } })
    fromBrowser.write(flood.slice(0, 100))
    fromBrowser.write(`${flood.slice(100)}\0${JSON.stringify({ id: 1, result: { ok: true } })}\0`)
    assert.deepEqual(await pending, { ok: true })
    assert.deepEqual(discarded, [flood.length])
  })

  it('rejects pending and later commands once the browser pipe closes', async () => {
    const { cdp, fromBrowser } = pipes()
    /** @type {string[]} */
    const closed = []
    cdp.onClose((reason) => closed.push(reason))
    const pending = cdp.send('Browser.getVersion')
    fromBrowser.end()
    await assert.rejects(pending, /browser pipe closed/)
    await assert.rejects(cdp.send('Browser.getVersion'), /browser pipe closed/)
    assert.deepEqual(closed, ['browser pipe closed'])
    assert.equal(cdp.closed, true)
  })
})
