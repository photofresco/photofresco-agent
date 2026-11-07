// @ts-check
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Preserves operation outcomes, exact refusal codes and write stage for reconciliation. */
export class RpcError extends Error {
  /** @param {{code: number, message: string, data?: any}} error */
  constructor(error) { super(error.message); this.name = 'RpcError'; this.code = error.code; this.data = error.data }
}

/** Reference transport. Language clients use the same request/response/event contract.
 * It never retries, approves a dialog or adds file grants on the caller's behalf. */
export class StdioClient {
  /** @param {{command?: string, args?: string[], env?: NodeJS.ProcessEnv, onEvent?: (event: any) => void, stderr?: 'inherit' | 'ignore'}} [options] */
  constructor({ command = process.execPath, args = [fileURLToPath(new URL('../bin/photofresco.js', import.meta.url)), 'connect', '--stdio'], env, onEvent = () => {}, stderr = 'inherit' } = {}) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', stderr], env: env ?? process.env, shell: false })
    /** @type {Map<string, {resolve: (value: any) => void, reject: (error: any) => void, timer: NodeJS.Timeout}>} */
    this.pending = new Map()
    this.serial = 0
    this.closed = false
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { this.fail('Connector output exceeded 16 MiB'); this.child.kill(); return }
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line)
          if (message.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC version')
          if (message.method === 'connector.event' && !Object.hasOwn(message, 'id')) { onEvent(message.params); continue }
          const entry = this.pending.get(message.id)
          if (!entry) continue
          if (!message.error && !Object.hasOwn(message, 'result')) throw new Error('Response has no result or error')
          this.pending.delete(message.id); clearTimeout(entry.timer)
          if (message.error) entry.reject(new RpcError(message.error))
          else entry.resolve(message.result)
        } catch { this.fail('Invalid connector response; outcome unknown'); this.child.kill() }
      }
    })
    this.child.on('error', () => this.fail('Connector process could not start'))
    this.child.on('exit', () => { this.closed = true; this.fail('Connector process exited; outcome unknown') })
    this.child.stdin.on('error', () => this.fail('Connector input closed; outcome unknown'))
  }

  /** @param {string} message */
  fail(message) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new RpcError({ code: -32005, message, data: { code: 'outcome_unknown' } }))
    }
    this.pending.clear()
  }

  /** @param {string} method @param {Record<string, unknown>} [params] @param {{timeoutMs?: number}} [options] @returns {Promise<any>} */
  call(method, params = {}, { timeoutMs = 200_000 } = {}) {
    if (this.closed) return Promise.reject(new RpcError({ code: -32001, message: 'Connector process is closed', data: { code: 'not_connected' } }))
    const id = String(++this.serial)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError({ code: -32005, message: 'Request timed out; reconcile with ops.outcome before retrying', data: { code: 'outcome_unknown', request_id: params.request_id } }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async close() {
    if (this.closed) return
    try { await this.call('session.stop', { close_window: true }, { timeoutMs: 5_000 }) } finally {
      this.child.stdin.end()
      await new Promise((resolve) => {
        const timer = setTimeout(() => this.child.kill(), 5_000)
        if (this.closed) { clearTimeout(timer); resolve(undefined); return }
        this.child.once('exit', () => { clearTimeout(timer); resolve(undefined) })
      })
    }
  }
}
