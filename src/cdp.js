// @ts-check

/**
 * Chrome DevTools Protocol over the browser's private pipe (`--remote-debugging-pipe`):
 * messages are JSON terminated by a NUL byte; the browser reads file descriptor 3 and
 * writes file descriptor 4 of the process that launched it. Nothing listens on a network
 * port, so no other process or web page can reach this connection.
 *
 * Inbound frames larger than `maxMessageBytes` are discarded up to their terminator rather
 * than buffered, so a page that floods the connector binding cannot exhaust memory.
 */

/**
 * @typedef {{ method: string, params: Record<string, any>, sessionId?: string }} CdpEvent
 * @typedef {(event: CdpEvent) => void} CdpListener
 */

export class CdpError extends Error {
  /** @param {string} method @param {{ code?: number, message?: string }} error */
  constructor(method, error) {
    super(`${method}: ${error.message ?? 'protocol error'}`)
    this.name = 'CdpError'
    this.code = error.code
  }
}

export const CDP_LIMITS = Object.freeze({
  /** Largest inbound message kept; artifact chunks are ~5.6 MB of base64. */
  maxMessageBytes: 64 * 1024 * 1024,
})

export class CdpConnection {
  /**
   * @param {NodeJS.WritableStream} writable The browser's fd 3 (it reads commands here).
   * @param {NodeJS.ReadableStream} readable The browser's fd 4 (it writes responses/events here).
   * @param {{ maxMessageBytes?: number, onDiscard?: (bytes: number) => void }} [options]
   */
  constructor(writable, readable, options = {}) {
    this.writable = writable
    this.maxMessageBytes = options.maxMessageBytes ?? CDP_LIMITS.maxMessageBytes
    this.onDiscard = options.onDiscard
    /** @type {Map<number, { method: string, resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map()
    /** @type {Set<CdpListener>} */
    this.listeners = new Set()
    /** @type {Set<(reason: string) => void>} */
    this.closeListeners = new Set()
    this.nextId = 0
    /** @type {Buffer[]} */
    this.parts = []
    this.partBytes = 0
    this.discarding = false
    this.discarded = 0
    /** @type {string | null} */
    this.closedReason = null
    readable.on('data', (chunk) => this.receive(/** @type {Buffer} */ (chunk)))
    readable.on('end', () => this.close('browser pipe closed'))
    readable.on('error', () => this.close('browser pipe failed'))
    writable.on('error', () => this.close('browser pipe failed'))
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId] Flattened target session.
   * @returns {Promise<any>}
   */
  send(method, params = {}, sessionId) {
    if (this.closedReason) return Promise.reject(new CdpError(method, { message: this.closedReason }))
    const id = ++this.nextId
    /** @type {Record<string, unknown>} */
    const message = { id, method, params }
    if (sessionId) message.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.writable.write(`${JSON.stringify(message)}\0`)
    })
  }

  /** @param {CdpListener} listener @returns {() => void} */
  on(listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** @param {(reason: string) => void} listener @returns {() => void} */
  onClose(listener) {
    if (this.closedReason) {
      listener(this.closedReason)
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  get closed() {
    return this.closedReason !== null
  }

  /** @param {string} reason */
  close(reason) {
    if (this.closedReason) return
    this.closedReason = reason
    for (const { method, reject } of this.pending.values()) reject(new CdpError(method, { message: reason }))
    this.pending.clear()
    this.parts = []
    for (const listener of this.closeListeners) listener(reason)
    this.closeListeners.clear()
    this.listeners.clear()
  }

  /** @param {Buffer} chunk */
  receive(chunk) {
    let start = 0
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start)
      const piece = end === -1 ? chunk.subarray(start) : chunk.subarray(start, end)
      if (this.discarding) {
        this.discarded += piece.length
      } else if (this.partBytes + piece.length > this.maxMessageBytes) {
        this.discarding = true
        this.discarded = this.partBytes + piece.length
        this.parts = []
        this.partBytes = 0
      } else if (piece.length) {
        this.parts.push(piece)
        this.partBytes += piece.length
      }
      if (end === -1) return
      if (this.discarding) {
        this.onDiscard?.(this.discarded)
        this.discarding = false
        this.discarded = 0
      } else {
        const frame = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.partBytes)
        this.parts = []
        this.partBytes = 0
        this.dispatch(frame.toString('utf8'))
      }
      start = end + 1
    }
  }

  /** @param {string} text */
  dispatch(text) {
    /** @type {any} */
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message?.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new CdpError(pending.method, message.error))
      else pending.resolve(message.result ?? {})
      return
    }
    if (typeof message?.method !== 'string') return
    const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId }
    for (const listener of [...this.listeners]) listener(event)
  }
}
