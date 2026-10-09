// @ts-check
import { ConnectorError } from './errors.js'

/**
 * The connector's link to one editor tab (pf-agent-platform-nkwn.14).
 *
 * Transport: the connector registers a CDP binding (`Runtime.addBinding`) on its own tab
 * before navigating it to the pinned editor URL. The editor's page channel
 * (src/ops/connectorChannel.ts) finds that binding at boot, removes it from the page's
 * global scope and announces itself with a random channel key that only this connection
 * receives. Messages to the page go through one fixed function, `DELIVER`, called with
 * the message as a structured argument (`Runtime.callFunctionOn`); the connector never
 * evaluates any other page code. Every message carries the channel key, a strictly
 * increasing ID and, for session calls, the per-pairing session key.
 *
 * Pinning: binding calls are accepted only from the tab's main frame, default world,
 * whose origin equals the editor origin. A navigation of the tab to another origin, a
 * reload, a closed tab or a crash drops the channel (pending calls fail with a connector
 * code) and the binding stops reporting until the connector loads the editor again.
 */

export const CONNECTOR_BINDING = '__photofrescoConnector'
/** Page channel protocol this connector speaks (src/ops/connectorChannel.ts CONNECTOR_CHANNEL_PROTOCOL). */
export const CHANNEL_PROTOCOL = 1

/** The only function the connector ever runs in the page. Arguments are data, never code. */
export const DELIVER = `function (envelope) {
  const port = globalThis.photofrescoConnector
  return port && typeof port.receive === 'function' ? port.receive(envelope) : 'no_channel'
}`

export const PAGE_TIMEOUTS = Object.freeze({
  /** Navigation start until the page channel announces itself. */
  readyMs: 45_000,
})

const KEY = /^[0-9a-f]{64}$/

/**
 * @typedef {{ origin: string, frameId: string | undefined, isDefault: boolean }} ContextInfo
 * @typedef {{ type: 'event', event: string, [key: string]: unknown }} PageEvent
 * @typedef {object} EditorPageOptions
 * @property {string} origin Pinned editor origin, e.g. https://photofresco.com
 * @property {(event: PageEvent) => void} [onEvent]
 * @property {(code: string, message: string) => void} [onDown] The channel dropped (not called for detach()).
 * @property {(entry: Record<string, unknown>) => void} [log]
 * @property {number} [readyMs]
 */

export class EditorPage {
  /**
   * @param {import('./cdp.js').CdpConnection} cdp
   * @param {EditorPageOptions} options
   */
  constructor(cdp, options) {
    this.cdp = cdp
    this.options = options
    /** @type {string | null} */
    this.targetId = null
    /** @type {string | null} */
    this.sessionId = null
    /** @type {string | null} */
    this.mainFrameId = null
    /** @type {Map<number, ContextInfo>} */
    this.contexts = new Map()
    /** @type {{ contextId: number, key: string } | null} */
    this.channel = null
    /** @type {NodeJS.Timeout | null} Set while a lost document awaits its navigation. */
    this.lostTimer = null
    /** @type {Map<number, { method: string, resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map()
    this.nextId = 0
    /** @type {Set<{ resolve: () => void, reject: (error: Error) => void }>} */
    this.readyWaiters = new Set()
    this.attached = false
    this.off = cdp.on((event) => this.handle(event))
  }

  /** Attach to the connector's tab (never any other target). @param {string} targetId */
  async attach(targetId) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    this.targetId = targetId
    this.sessionId = sessionId
    this.attached = true
    await this.cdp.send('Runtime.enable', {}, sessionId)
    await this.cdp.send('Page.enable', {}, sessionId)
    const tree = await this.cdp.send('Page.getFrameTree', {}, sessionId)
    this.mainFrameId = tree.frameTree.frame.id
  }

  /**
   * (Re)load the editor in this tab and wait for its channel.
   * @param {string} url Pinned-origin editor URL (may carry the non-secret `pf_ref` surface token).
   */
  async load(url) {
    if (!this.sessionId) throw new ConnectorError('page_closed', 'The connector tab is not attached')
    if (new URL(url).origin !== this.options.origin) throw new ConnectorError('invalid_request', 'The editor URL must use the pinned origin')
    this.drop('page_reloaded', 'The editor page is loading again')
    await this.cdp.send('Runtime.addBinding', { name: CONNECTOR_BINDING }, this.sessionId)
    const ready = this.waitReady(this.options.readyMs ?? PAGE_TIMEOUTS.readyMs)
    const navigation = await this.cdp.send('Page.navigate', { url }, this.sessionId).catch((error) => ({ errorText: error.message }))
    if (navigation.errorText) {
      this.rejectReady(new ConnectorError('editor_unavailable', `The editor at ${this.options.origin} did not load (${navigation.errorText})`))
    }
    await ready
  }

  get ready() {
    return this.channel !== null
  }

  /**
   * Send one typed request to the page channel and await its response.
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionKey]
   * @returns {Promise<any>}
   */
  async call(method, params, sessionKey) {
    const channel = this.channel
    if (!channel || !this.sessionId) throw new ConnectorError('not_connected', 'The editor page channel is not open; call connect()')
    const id = ++this.nextId
    /** @type {Record<string, unknown>} */
    const envelope = { v: CHANNEL_PROTOCOL, key: channel.key, id, method }
    if (sessionKey) envelope.session_key = sessionKey
    if (params !== undefined) envelope.params = params
    const response = new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }))
    // A rejection before the ack arrives must not surface as unhandled.
    response.catch(() => {})
    /** @type {any} */
    let delivered
    try {
      delivered = await this.cdp.send('Runtime.callFunctionOn', {
        functionDeclaration: DELIVER,
        executionContextId: channel.contextId,
        arguments: [{ value: envelope }],
        returnByValue: true,
        silent: true,
      }, this.sessionId)
    } catch (error) {
      this.settle(id, new ConnectorError(this.channel === channel ? 'page_reloaded' : 'not_connected',
        `The message could not be delivered to the editor (${/** @type {Error} */ (error).message})`))
      return response
    }
    const ack = delivered.exceptionDetails ? 'exception' : delivered.result?.value
    if (ack !== 'accepted') {
      const code = typeof ack === 'object' && ack && typeof ack.rejected === 'string' ? ack.rejected : String(ack)
      this.settle(id, new ConnectorError('channel_rejected', `The editor channel refused ${method} (${code})`, { details: { reason: code } }))
    }
    return response
  }

  /** Stop listening (the connector is shutting down or replacing this page). */
  detach() {
    this.drop('not_connected', 'The connector closed')
    this.off()
    this.attached = false
  }

  // ---- internals -------------------------------------------------------------------

  /** @param {number} timeoutMs @returns {Promise<void>} */
  waitReady(timeoutMs) {
    return new Promise((resolve, reject) => {
      /** @type {NodeJS.Timeout | undefined} */
      let timer
      const waiter = {
        resolve: () => { clearTimeout(timer); this.readyWaiters.delete(waiter); resolve() },
        reject: (/** @type {Error} */ error) => { clearTimeout(timer); this.readyWaiters.delete(waiter); reject(error) },
      }
      timer = setTimeout(() => waiter.reject(new ConnectorError('editor_unavailable',
        `The editor at ${this.options.origin} did not open its connector channel within ${Math.round(timeoutMs / 1000)} s. Check the editor URL and that this PhotoFresco build supports the local connector.`)), timeoutMs)
      this.readyWaiters.add(waiter)
    })
  }

  /** @param {Error} error */
  rejectReady(error) {
    for (const waiter of [...this.readyWaiters]) waiter.reject(error)
  }

  /** @param {number} id @param {Error | null} error @param {unknown} [value] */
  settle(id, error, value) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (error) pending.reject(error)
    else pending.resolve(value)
  }

  /**
   * The page's document went away: stop delivering now; the main-frame navigation that
   * follows says whether it reloaded or left the origin (or a timer decides: reload).
   */
  lose() {
    this.channel = null
    clearTimeout(this.lostTimer ?? undefined)
    this.lostTimer = setTimeout(() => this.drop('page_reloaded', 'The editor page reloaded; its agent session ended'), 1000)
  }

  /**
   * Drop the channel: pending calls fail with `code`; the connector learns why.
   * @param {string} code @param {string} message
   */
  drop(code, message) {
    const had = this.channel !== null || this.lostTimer !== null || this.pending.size > 0
    this.channel = null
    clearTimeout(this.lostTimer ?? undefined)
    this.lostTimer = null
    for (const [id] of [...this.pending]) this.settle(id, new ConnectorError(code, message))
    if (had && code !== 'not_connected') this.options.onDown?.(code, message)
  }

  /** @param {number} contextId */
  pinned(contextId) {
    const context = this.contexts.get(contextId)
    return !!context && context.isDefault && context.frameId === this.mainFrameId && context.origin === this.options.origin
  }

  /** @param {import('./cdp.js').CdpEvent} event */
  handle(event) {
    const { method, params } = event
    if (method === 'Target.detachedFromTarget' && params.sessionId === this.sessionId) {
      this.sessionId = null
      this.attached = false
      this.drop('page_closed', 'The connector tab was closed')
      this.rejectReady(new ConnectorError('page_closed', 'The connector tab was closed'))
      return
    }
    if (method === 'Target.targetDestroyed' && params.targetId === this.targetId) {
      this.drop('page_closed', 'The connector tab was closed')
      this.rejectReady(new ConnectorError('page_closed', 'The connector tab was closed'))
      return
    }
    if (!this.sessionId || event.sessionId !== this.sessionId) return
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const context = params.context
        this.contexts.set(context.id, { origin: context.origin, frameId: context.auxData?.frameId, isDefault: !!context.auxData?.isDefault })
        return
      }
      case 'Runtime.executionContextDestroyed':
        this.contexts.delete(params.executionContextId)
        if (this.channel?.contextId === params.executionContextId) this.lose()
        return
      case 'Runtime.executionContextsCleared':
        this.contexts.clear()
        if (this.channel) this.lose()
        return
      case 'Inspector.targetCrashed':
        this.drop('page_closed', 'The editor tab crashed')
        this.rejectReady(new ConnectorError('page_closed', 'The editor tab crashed'))
        return
      case 'Page.frameNavigated': {
        const frame = params.frame
        if (frame.parentId || frame.id !== this.mainFrameId) return
        let origin = ''
        try {
          origin = new URL(frame.url).origin
        } catch {
          origin = ''
        }
        if (origin === this.options.origin || frame.url === 'about:blank') {
          if (this.lostTimer) this.drop('page_reloaded', 'The editor page reloaded; its agent session ended')
          return
        }
        this.options.log?.({ event: 'origin_changed', origin: origin || 'opaque' })
        this.drop('origin_changed', `The connector tab navigated away from ${this.options.origin}; its agent session ended`)
        this.rejectReady(new ConnectorError('origin_changed', `The connector tab navigated away from ${this.options.origin}`))
        this.cdp.send('Runtime.removeBinding', { name: CONNECTOR_BINDING }, this.sessionId).catch(() => {})
        return
      }
      case 'Runtime.bindingCalled':
        this.binding(params)
        return
      default:
    }
  }

  /** @param {Record<string, any>} params Runtime.bindingCalled { name, payload, executionContextId } */
  binding(params) {
    if (params.name !== CONNECTOR_BINDING) return
    if (!this.pinned(params.executionContextId)) {
      const origin = this.contexts.get(params.executionContextId)?.origin ?? 'unknown'
      this.options.log?.({ event: 'binding_ignored', origin })
      return
    }
    /** @type {any} */
    let message
    try {
      message = JSON.parse(params.payload)
    } catch {
      return
    }
    if (!message || typeof message !== 'object' || message.v !== CHANNEL_PROTOCOL) {
      if (message?.type === 'ready') {
        this.rejectReady(new ConnectorError('editor_unsupported',
          `The editor speaks connector channel protocol ${String(message?.v)}; this connector speaks ${CHANNEL_PROTOCOL}. Update the connector.`))
      }
      return
    }
    if (message.type === 'ready') {
      if (typeof message.key !== 'string' || !KEY.test(message.key)) return
      // A second announcement from the same document is not a new channel.
      if (this.channel?.contextId === params.executionContextId) return
      if (this.channel) this.drop('page_reloaded', 'The editor page reloaded; its agent session ended')
      this.channel = { contextId: params.executionContextId, key: message.key }
      this.options.log?.({ event: 'channel_ready', origin: this.options.origin })
      for (const waiter of [...this.readyWaiters]) waiter.resolve()
      return
    }
    if (this.channel?.contextId !== params.executionContextId) return
    if (message.type === 'response' && Number.isSafeInteger(message.id)) {
      if (message.ok) this.settle(message.id, null, message.result)
      else {
        const error = message.error ?? {}
        this.settle(message.id, new ConnectorError(typeof error.code === 'string' ? error.code : 'operation_failed', typeof error.message === 'string' ? error.message : 'The editor refused the request'))
      }
      return
    }
    if (message.type === 'event' && typeof message.event === 'string') this.options.onEvent?.(message)
  }
}
